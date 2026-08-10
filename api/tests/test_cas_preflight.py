"""Synthetic all-provider fixtures for the Q1 fail-closed CAS contract."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

import api._cdsl_nsdl_parser as depository_parser
from api._cas_parser import normalize_casparser_result
from api._cas_preflight import (
    CASPreflightError,
    bucket_count,
    safe_failure_body,
    safe_parser_telemetry,
    validate_and_canonicalize_cas,
)
from api._cdsl_nsdl_parser import parse_cdsl_nsdl


PROVIDERS = ["cams", "kfintech", "mfcentral", "cdsl", "nsdl"]


def _valid_transaction(**overrides):
    transaction = {
        "date": "2026-07-01",
        "type": "PURCHASE",
        "description": "Synthetic purchase",
        "amount": 1005.05,
        "source_amount": 1005.05,
        "gross_amount": 1005.05,
        "stamp_duty": 0.05,
        "charges": {"stamp_duty": 0.05},
        "nav": 100.0,
        "price": 100.5,
        "units": 10.0,
    }
    transaction.update(overrides)
    return transaction


def _payload(dialect="cams", transactions=None):
    rows = [_valid_transaction()] if transactions is None else transactions
    return {
        "source_dialect": dialect,
        "mutual_funds": [
            {
                "folio_number": "SYNTHETIC-01",
                "schemes": [
                    {
                        "name": "Synthetic Mutual Fund - Growth",
                        "isin": "INF000A00001",
                        "additional_info": {"amfi": "100001"},
                        "transactions": rows,
                    }
                ],
            }
        ],
    }


@pytest.mark.parametrize("dialect", PROVIDERS)
def test_provider_golden_fixtures_pass(dialect):
    result = validate_and_canonicalize_cas(_payload(dialect))

    transaction = result["mutual_funds"][0]["schemes"][0]["transactions"][0]
    assert result["source_dialect"] == dialect
    assert result["contract_version"] == 1
    assert transaction["source_amount"] == 1005.05
    assert transaction["gross_amount"] == 1005.05
    assert transaction["stamp_duty"] == 0.05
    assert transaction["nav"] == 100.0
    assert transaction["price"] == 100.5
    assert transaction["normalised_type"] == "purchase"
    assert "description" not in transaction


@pytest.mark.parametrize("dialect", ["cams", "kfintech", "mfcentral"])
def test_standard_parser_adapter_retains_canonical_financial_fields(dialect):
    raw = {
        "folios": [
            {
                "folio": "SYNTHETIC-01",
                "schemes": [
                    {
                        "scheme": "Synthetic Mutual Fund - Growth",
                        "isin": "INF000A00001",
                        "type": "EQUITY",
                        "amfi": "100001",
                        "transactions": [_valid_transaction()],
                    }
                ],
            }
        ]
    }
    normalized = normalize_casparser_result(raw, dialect)
    result = validate_and_canonicalize_cas(normalized)
    transaction = result["mutual_funds"][0]["schemes"][0]["transactions"][0]

    assert result["source_dialect"] == dialect
    assert transaction["price"] == 100.5
    assert transaction["nav"] == 100.0
    assert transaction["stamp_duty"] == 0.05


def test_price_is_used_for_equation_when_it_differs_from_nav():
    result = validate_and_canonicalize_cas(
        _payload(
            transactions=[
                _valid_transaction(
                    amount=1010.0,
                    source_amount=1010.0,
                    gross_amount=1010.0,
                    stamp_duty=0.0,
                    charges={},
                    nav=100.0,
                    price=101.0,
                    units=10.0,
                )
            ]
        )
    )
    assert result["preflight_summary"]["rejected_rows_bucket"] == "0"


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"date": ""}, "invalid_date"),
        ({"date": "2026-02-30"}, "invalid_date"),
        ({"type": "FUTURE_UNMAPPED_EVENT"}, "unsupported_transaction_type"),
        ({"amount": 0, "source_amount": 0, "gross_amount": 0}, "invalid_amount"),
        ({"units": 0}, "invalid_units"),
        ({"nav": 0}, "invalid_nav"),
        ({"price": 0}, "invalid_price"),
        ({"units": -10}, "direction_mismatch"),
        ({"nav": 0.05, "price": 100}, "nav_price_mismatch"),
        (
            {"amount": 5000, "source_amount": 5000, "gross_amount": 5000},
            "accounting_mismatch",
        ),
    ],
)
def test_garbage_transactions_fail_closed(overrides, reason):
    with pytest.raises(CASPreflightError) as caught:
        validate_and_canonicalize_cas(
            _payload("nsdl", [_valid_transaction(**overrides)])
        )
    assert caught.value.reason == reason


def test_signed_redemption_inputs_are_retained_with_canonical_direction():
    result = validate_and_canonicalize_cas(
        _payload(
            "cams",
            [
                {
                    "date": "2026-07-01",
                    "type": "REDEMPTION",
                    "amount": -1200,
                    "units": -10,
                    "nav": 120,
                }
            ],
        )
    )
    transaction = result["mutual_funds"][0]["schemes"][0]["transactions"][0]
    assert transaction["source_amount"] == -1200
    assert transaction["gross_amount"] == 1200
    assert transaction["source_units"] == -10
    assert transaction["units"] == 10
    assert transaction["direction"] == "out"


def test_negative_signed_purchase_pair_rejected():
    candidate = _payload(
        "cams",
        [
            _valid_transaction(
                amount=-1000,
                source_amount=-1000,
                gross_amount=1000,
                units=-10,
                source_units=-10,
            )
        ],
    )
    with pytest.raises(CASPreflightError) as caught:
        validate_and_canonicalize_cas(candidate)
    assert caught.value.reason == "direction_mismatch"


@pytest.mark.parametrize(
    ("field", "reason"),
    [("nav", "invalid_nav"), ("price", "invalid_price")],
)
def test_negative_nav_or_price_rejected(field, reason):
    with pytest.raises(CASPreflightError) as caught:
        validate_and_canonicalize_cas(
            _payload("cams", [_valid_transaction(**{field: -100})])
        )
    assert caught.value.reason == reason


def test_purchase_and_redemption_use_direction_specific_charge_equations():
    purchase = _valid_transaction(
        amount=990,
        source_amount=990,
        gross_amount=990,
        stamp_duty=10,
        charges={"stamp_duty": 10},
    )
    with pytest.raises(CASPreflightError) as purchase_error:
        validate_and_canonicalize_cas(_payload("cams", [purchase]))
    assert purchase_error.value.reason == "accounting_mismatch"

    redemption = _valid_transaction(
        type="REDEMPTION",
        amount=1015,
        source_amount=1015,
        gross_amount=1015,
        stamp_duty=10,
        charges={"stamp_duty": 10},
    )
    with pytest.raises(CASPreflightError) as redemption_error:
        validate_and_canonicalize_cas(_payload("cams", [redemption]))
    assert redemption_error.value.reason == "accounting_mismatch"


@pytest.mark.parametrize(
    "overrides",
    [
        {"source_amount": 1005.05, "gross_amount": 1_000_000_000},
        {"amount": 500_000, "source_amount": 500_000, "gross_amount": 500_000_000},
        {"source_amount": 1005.05, "gross_amount": 1015.05},
    ],
)
def test_unreconciled_cash_cannot_widen_its_own_tolerance(overrides):
    with pytest.raises(CASPreflightError) as caught:
        validate_and_canonicalize_cas(
            _payload("cams", [_valid_transaction(**overrides)])
        )
    assert caught.value.reason == "accounting_mismatch"


def test_derived_accounting_overflow_fails_closed():
    with pytest.raises(CASPreflightError) as caught:
        validate_and_canonicalize_cas(
            _payload(
                "cams",
                [
                    _valid_transaction(
                        amount=1e308,
                        source_amount=1e308,
                        gross_amount=1e308,
                        nav=None,
                        price=1e308,
                        units=1e308,
                    )
                ],
            )
        )
    assert caught.value.reason == "accounting_mismatch"


@pytest.mark.parametrize("folio", ["No", "CDSL", "NSDL", "N/A"])
def test_placeholder_folios_fail_closed(folio):
    candidate = _payload()
    candidate["mutual_funds"][0]["folio_number"] = folio
    with pytest.raises(CASPreflightError) as caught:
        validate_and_canonicalize_cas(candidate)
    assert caught.value.reason == "invalid_folio"


def test_missing_folio_is_canonical_null():
    candidate = _payload()
    candidate["mutual_funds"][0]["folio_number"] = None
    result = validate_and_canonicalize_cas(candidate)
    assert result["mutual_funds"][0]["folio_number"] is None


@pytest.mark.parametrize("amfi", ["0", "2147483648", "9" * 5000])
def test_non_positive_or_out_of_range_amfi_fails_closed(amfi):
    candidate = _payload()
    candidate["mutual_funds"][0]["schemes"][0]["additional_info"] = {"amfi": amfi}
    with pytest.raises(CASPreflightError) as caught:
        validate_and_canonicalize_cas(candidate)
    assert caught.value.reason == "missing_scheme_identity"


def test_mixed_valid_and_corrupt_schemes_reject_together():
    candidate = _payload("kfintech")
    candidate["mutual_funds"][0]["schemes"].append(
        {
            "name": "Synthetic Corrupt Fund",
            "isin": "INF000A00002",
            "additional_info": {"amfi": "100002"},
            "transactions": [
                _valid_transaction(amount=9000, source_amount=9000, gross_amount=9000)
            ],
        }
    )
    with pytest.raises(CASPreflightError) as caught:
        validate_and_canonicalize_cas(candidate)
    assert caught.value.reason == "accounting_mismatch"


@pytest.mark.parametrize(
    "candidate",
    [
        {"mutual_funds": []},
        {"mutual_funds": [{"schemes": []}]},
        _payload(transactions=[]),
    ],
)
def test_empty_or_truncated_payloads_fail(candidate):
    with pytest.raises(CASPreflightError) as caught:
        validate_and_canonicalize_cas(candidate)
    assert caught.value.reason == "empty_payload"


@pytest.mark.parametrize(
    "candidate",
    [
        None,
        [],
        {},
        {"mutual_funds": {}},
        {"mutual_funds": [None]},
        {"mutual_funds": [{"schemes": {}}]},
        {"mutual_funds": [{"schemes": [None]}]},
        {
            "mutual_funds": [
                {"schemes": [{"additional_info": [], "transactions": []}]}
            ]
        },
        {
            "mutual_funds": [
                {"schemes": [{"additional_info": {}, "transactions": {}}]}
            ]
        },
        {
            "mutual_funds": [
                {"schemes": [{"additional_info": {}, "transactions": [None]}]}
            ]
        },
        {
            "mutual_funds": [
                {
                    "schemes": [
                        {
                            "additional_info": {},
                            "transactions": [
                                {
                                    "date": "2026-07-01",
                                    "type": "PURCHASE",
                                    "charges": [],
                                }
                            ],
                        }
                    ]
                }
            ]
        },
    ],
)
def test_malformed_runtime_shapes_fail_with_allowlisted_reason(candidate):
    with pytest.raises(CASPreflightError) as caught:
        validate_and_canonicalize_cas(candidate)
    assert caught.value.reason == "malformed_payload"


def test_paired_reversal_passes_but_corrupt_unpaired_reversal_fails():
    valid = _valid_transaction()
    result = validate_and_canonicalize_cas(
        _payload(
            "cams",
            [
                valid,
                {
                    "date": valid["date"],
                    "type": "REVERSAL",
                    "amount": -valid["source_amount"],
                },
            ],
        )
    )
    assert result["preflight_summary"]["valid_rows_bucket"] == "2-5"

    with pytest.raises(CASPreflightError) as caught:
        validate_and_canonicalize_cas(
            _payload(
                "cams",
                [
                    valid,
                    {
                        "date": "2026-07-02",
                        "type": "REVERSAL",
                        "amount": -999_999_999,
                        "nav": -5,
                        "price": 0,
                    },
                ],
            )
        )
    assert caught.value.reason == "invalid_nav"


def test_valid_cross_period_reversal_reports_unpaired_reason():
    with pytest.raises(CASPreflightError) as caught:
        validate_and_canonicalize_cas(
            _payload(
                "cams",
                [
                    _valid_transaction(),
                    {
                        "date": "2026-07-02",
                        "type": "REVERSAL",
                        "amount": -1005.05,
                    },
                ],
            )
        )
    assert caught.value.reason == "unpaired_reversal"


def test_paired_cash_only_reversal_derived_overflow_fails_closed():
    with pytest.raises(CASPreflightError) as caught:
        validate_and_canonicalize_cas(
            _payload(
                "cams",
                [
                    _valid_transaction(),
                    {
                        "date": "2026-07-01",
                        "type": "REVERSAL",
                        "amount": -1005.05,
                        "charges": {
                            "stamp_duty": 1e308,
                            "taxes": 1e308,
                            "exit_load": 1e308,
                            "other": 1e308,
                        },
                    },
                ],
            )
        )
    assert caught.value.reason == "accounting_mismatch"


def test_mixed_payload_with_transactionless_scheme_fails():
    candidate = _payload()
    candidate["mutual_funds"][0]["schemes"].append(
        {
            "name": "Synthetic Truncated Fund",
            "isin": "INF000A00002",
            "additional_info": {"amfi": "100002"},
            "transactions": [],
        }
    )
    with pytest.raises(CASPreflightError) as caught:
        validate_and_canonicalize_cas(candidate)
    assert caught.value.reason == "empty_payload"


def _pdf_mock(marker: str, table: list[list[str | None]]):
    page = MagicMock()
    page.extract_text.return_value = f"{marker} Consolidated Account Statement"
    page.extract_tables.return_value = [table]
    pdf = MagicMock()
    pdf.pages = [page]
    pdf.__enter__ = lambda value: value
    pdf.__exit__ = MagicMock(return_value=False)
    return pdf


CDSL_TABLE = [
    ["Folio No : SYNTHETIC-01", None, None, None, None, None, None],
    ["ISIN : INF000A00001", None, None, None, None, None, None],
    ["Date", "Description", "Amount", "NAV", "Price", "Units", "Stamp Duty"],
    ["01-07-2026", "Systematic Investment", "1000", "100", "100", "10", "0.05"],
]

NSDL_TABLE = [
    ["Folio No : SYNTHETIC-01", None, None, None, None, None, None],
    ["ISIN : INF000A00001", None, None, None, None, None, None],
    ["Date", "Description", "Amount", "Stamp Duty", "NAV", "Price", "Units"],
    ["01-07-2026", "Purchase", "1000", "0.05", "100", "100", "10"],
]


def test_observed_cdsl_table_order_passes_end_to_end():
    depository_parser._isin_cache = {
        "INF000A00001": (100001, "Equity", "Synthetic Mutual Fund - Growth")
    }
    try:
        with patch("pdfplumber.open", return_value=_pdf_mock("CDSL", CDSL_TABLE)):
            result = parse_cdsl_nsdl(b"synthetic", "synthetic-password")
    finally:
        depository_parser._isin_cache = None

    assert result["source_dialect"] == "cdsl"
    assert result["preflight_summary"]["valid_rows_bucket"] == "1"


def test_observed_nsdl_table_order_passes_end_to_end():
    depository_parser._isin_cache = {
        "INF000A00001": (100001, "Equity", "Synthetic Mutual Fund - Growth")
    }
    try:
        with patch("pdfplumber.open", return_value=_pdf_mock("NSDL", NSDL_TABLE)):
            result = parse_cdsl_nsdl(b"synthetic", "synthetic-password")
    finally:
        depository_parser._isin_cache = None

    assert result["source_dialect"] == "nsdl"
    transaction = result["mutual_funds"][0]["schemes"][0]["transactions"][0]
    assert transaction["source_amount"] == 1000
    assert transaction["gross_amount"] == 1000.05
    assert transaction["stamp_duty"] == 0.05
    assert transaction["nav"] == 100
    assert transaction["price"] == 100
    assert transaction["units"] == 10


def test_failure_body_and_telemetry_cannot_echo_private_source_fields():
    candidate = _payload("nsdl", [_valid_transaction(nav=0.05, price=100)])
    candidate["private_filename"] = "private-file.pdf"
    candidate["private_error"] = "upstream stack trace"

    with pytest.raises(CASPreflightError) as caught:
        validate_and_canonicalize_cas(candidate)

    output = {
        "body": safe_failure_body(caught.value),
        "telemetry": safe_parser_telemetry(
            "rejected",
            summary=caught.value.summary,
            reason=caught.value.reason,
        ),
    }
    serialized = json.dumps(output)
    for prohibited in [
        "private-file.pdf",
        "ABCDE1234F",
        "holder@example.test",
        "SYNTHETIC-01",
        "2026-07-01",
        "1005.05",
        "INF000A00001",
        "upstream stack trace",
    ]:
        assert prohibited not in serialized


@pytest.mark.parametrize(
    ("count", "expected"),
    [(0, "0"), (1, "1"), (5, "2-5"), (20, "6-20"), (100, "21-100"), (101, "101+")],
)
def test_count_buckets(count, expected):
    assert bucket_count(count) == expected
