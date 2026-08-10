"""Synthetic Q2 contracts for header-aware CDSL/NSDL extraction."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

import api._cdsl_nsdl_parser as parser
from api._cas_preflight import CASPreflightError
from api._cdsl_nsdl_parser import UnsupportedLayoutError, parse_cdsl_nsdl


ISIN_MAP = {
    "INF000A00001": (100001, "Equity", "Synthetic Mutual Fund - Growth"),
    "INF000A00002": (100002, "Equity", "Synthetic Holdings-Only Fund"),
}


def _page(text: str, tables: list[list[list[str | None]]]):
    page = MagicMock()
    page.extract_text.return_value = text
    page.extract_tables.return_value = tables
    return page


def _pdf(*pages):
    pdf = MagicMock()
    pdf.pages = list(pages)
    pdf.__enter__ = lambda value: value
    pdf.__exit__ = MagicMock(return_value=False)
    return pdf


def _table(header, row, folio="Folio No : SYNTHETIC-01"):
    width = max(len(header), len(row))
    return [
        [folio, *([None] * (width - 1))],
        ["ISIN : INF000A00001", *([None] * (width - 1))],
        header,
        row,
    ]


def _parse(pdf):
    parser._isin_cache = ISIN_MAP
    try:
        with patch("pdfplumber.open", return_value=pdf):
            return parse_cdsl_nsdl(b"synthetic", "synthetic-password")
    finally:
        parser._isin_cache = None


@pytest.mark.parametrize(
    ("marker", "header", "row", "dialect"),
    [
        (
            "CDSL",
            ["Date", "Description", "Amount", "NAV", "Price", "Units", "Stamp Duty"],
            ["01-07-2026", "Purchase", "1000", "100", "100", "10", "0.05"],
            "cdsl",
        ),
        (
            "NSDL",
            ["Date", "Description", "Amount", "Stamp Duty", "NAV", "Price", "Units"],
            ["01-07-2026", "Purchase", "1000", "0.05", "100", "100", "10"],
            "nsdl",
        ),
    ],
)
def test_observed_provider_orders_map_the_same_financial_values(marker, header, row, dialect):
    result = _parse(_pdf(_page(marker, [_table(header, row)])))
    transaction = result["mutual_funds"][0]["schemes"][0]["transactions"][0]

    assert result["source_dialect"] == dialect
    assert transaction["source_amount"] == 1000
    assert transaction["gross_amount"] == 1000.05
    assert transaction["stamp_duty"] == 0.05
    assert transaction["nav"] == 100
    assert transaction["price"] == 100
    assert transaction["units"] == 10


def test_mixed_cover_vocabulary_cannot_override_the_transaction_schema():
    header = ["Date", "Description", "Amount", "Stamp Duty", "NAV", "Price", "Units"]
    row = ["01-07-2026", "Purchase", "1000", "0.05", "100", "100", "10"]
    result = _parse(_pdf(_page("CDSL account with NSDL participant details", [_table(header, row)])))

    assert result["source_dialect"] == "nsdl"


def test_aliases_optional_trailing_charges_and_repeated_page_header_are_supported():
    header = [
        "Txn Date",
        "Transaction Details",
        "Transaction Amount",
        "Stamp Duty",
        "Net Asset Value",
        "Unit Price",
        "Quantity",
        "Taxes",
    ]
    first = _table(
        header,
        ["01-07-2026", "Purchase", "1000", "0.05", "100", "100", "10", "0.10"],
    )
    continuation = [
        [],
        header,
        ["02-07-2026", "Purchase", "1000", "0.05", "100", "100", "10", "0.10"],
    ]

    result = _parse(
        _pdf(
            _page("cover page", [first]),
            _page("NSDL Consolidated Account Statement", [continuation]),
        )
    )
    transactions = result["mutual_funds"][0]["schemes"][0]["transactions"]

    assert result["source_dialect"] == "nsdl"
    assert len(transactions) == 2
    assert transactions[0]["gross_amount"] == 1000.15
    assert transactions[0]["charges"]["stamp_duty"] == 0.05
    assert transactions[0]["charges"]["taxes"] == 0.1


def test_line_wrapped_cdsl_header_words_are_reassembled_for_matching():
    header = [
        "Date",
        "Transaction\nDescription",
        "Amo\nunt",
        "NA\nV",
        "Pri\nce",
        "Units",
        "Stam\np Du\nty",
        "Income\nDistribution",
        "Capital\nWithdrawal",
    ]
    row = ["01-07-2026", "Purchase", "1000", "100", "100", "10", "0.05", "0", "0"]
    result = _parse(_pdf(_page("CDSL", [_table(header, row)])))

    assert result["source_dialect"] == "cdsl"
    assert result["preflight_summary"]["valid_rows_bucket"] == "1"


def test_unrelated_date_and_folio_table_headers_are_ignored():
    unrelated = [
        ["Date of Birth", "Registered Email", "Account Number"],
        ["Folio No.", "Holder Details", "KYC Status"],
        ["Folio No. / Account No.", "Scheme Name", "Current Value"],
    ]
    header = ["Date", "Description", "Amount", "Stamp Duty", "NAV", "Price", "Units"]
    row = ["01-07-2026", "Purchase", "1000", "0.05", "100", "100", "10"]
    result = _parse(_pdf(_page("NSDL", [unrelated, _table(header, row)])))

    assert result["source_dialect"] == "nsdl"
    assert result["preflight_summary"]["valid_rows_bucket"] == "1"


def test_holdings_summary_isins_do_not_become_empty_transaction_schemes():
    holdings_summary = [
        ["ISIN", "ISIN Description", "Folio No.", "No. of Units", "Current NAV"],
        ["INF000A00002", "Synthetic Holdings-Only Fund", "HOLDING-01", "2", "100"],
    ]
    header = ["Date", "Description", "Amount", "Stamp Duty", "NAV", "Price", "Units"]
    row = ["01-07-2026", "Purchase", "1000", "0.05", "100", "100", "10"]
    result = _parse(_pdf(_page("NSDL", [holdings_summary, _table(header, row)])))

    schemes = [
        scheme
        for folio in result["mutual_funds"]
        for scheme in folio["schemes"]
    ]
    assert [scheme["isin"] for scheme in schemes] == ["INF000A00001"]


def test_explicit_net_of_tax_switch_out_fails_closed_until_q3_models_gross_cash():
    header = ["Date", "Description", "Amount", "Stamp Duty", "NAV", "Price", "Units"]
    row = [
        "01-07-2026",
        "Switch Out Less TDS, STT - synthetic",
        "90",
        "0",
        "10",
        "10",
        "10",
    ]
    with pytest.raises(CASPreflightError) as caught:
        _parse(_pdf(_page("NSDL", [_table(header, row)])))
    assert caught.value.reason == "accounting_mismatch"


@pytest.mark.parametrize(
    ("description", "amount"),
    [
        ("Switch Out - synthetic", "90"),
        ("Switch Out Less TDS, STT - synthetic", "80"),
    ],
)
def test_unmarked_or_excessive_outflow_gap_still_fails_preflight(description, amount):
    header = ["Date", "Description", "Amount", "Stamp Duty", "NAV", "Price", "Units"]
    row = ["01-07-2026", description, amount, "0", "10", "10", "10"]

    with pytest.raises(CASPreflightError) as caught:
        _parse(_pdf(_page("NSDL", [_table(header, row)])))
    assert caught.value.reason == "accounting_mismatch"


@pytest.mark.parametrize(
    "header",
    [
        ["Date", "Description", "Amount", "NAV", "Price", "Stamp Duty"],
        ["Date", "Description", "Amount", "NAV", "Price", "Units", "Quantity"],
        ["Date", "Description", "Amount", "Units", "Stamp Duty"],
    ],
)
def test_missing_or_ambiguous_required_headers_fail_closed(header):
    row = ["01-07-2026", "Purchase", "1000", "100", "100", "10", "0.05"]
    with pytest.raises(UnsupportedLayoutError):
        _parse(_pdf(_page("CDSL", [_table(header, row)])))


def test_dated_row_before_any_transaction_header_fails_closed():
    table = [
        ["ISIN : INF000A00001", None, None, None],
        ["01-07-2026", "Purchase", "1000", "10"],
    ]
    with pytest.raises(UnsupportedLayoutError):
        _parse(_pdf(_page("CDSL", [table])))


def test_new_scheme_cannot_reuse_previous_scheme_header_map():
    header = ["Date", "Description", "Amount", "NAV", "Price", "Units"]
    first = _table(
        header,
        ["01-07-2026", "Purchase", "1000", "100", "100", "10"],
    )
    second = [
        ["Folio No : SYNTHETIC-02", None, None, None, None, None],
        ["ISIN : INF000A00002", None, None, None, None, None],
        [
            "02-07-2026",
            "Switch Out Less TDS, STT - synthetic",
            "90",
            "10",
            "10",
            "10",
        ],
    ]

    with pytest.raises(UnsupportedLayoutError):
        _parse(_pdf(_page("CDSL", [first, second])))


def test_unused_header_only_table_can_bind_immediately_following_scheme_table():
    header = ["Date", "Description", "Amount", "Stamp Duty", "NAV", "Price", "Units"]
    header_only = [header]
    content = [
        ["Folio No : SYNTHETIC-02", None, None, None, None, None, None],
        ["ISIN : INF000A00002", None, None, None, None, None, None],
        ["02-07-2026", "Purchase", "1000", "0.05", "100", "100", "10"],
    ]

    result = _parse(_pdf(_page("NSDL", [header_only, content])))
    transactions = result["mutual_funds"][0]["schemes"][0]["transactions"]

    assert result["source_dialect"] == "nsdl"
    assert len(transactions) == 1


def test_page_scoped_header_cannot_bind_a_new_scheme_on_the_next_page():
    header = ["Date", "Description", "Amount", "Stamp Duty", "NAV", "Price", "Units"]
    content = [
        ["Folio No : SYNTHETIC-02", None, None, None, None, None, None],
        ["ISIN : INF000A00002", None, None, None, None, None, None],
        ["02-07-2026", "Purchase", "1000", "0.05", "100", "100", "10"],
    ]

    with pytest.raises(UnsupportedLayoutError):
        _parse(
            _pdf(
                _page("NSDL cover", [[header]]),
                _page("continuation", [content]),
            )
        )


@pytest.mark.parametrize(
    ("folio_cell", "expected"),
    [
        ("Folio No : ALPHA/01", "ALPHA/01"),
        ("Folio No - ALPHA-01", "ALPHA-01"),
        ("Folio No – ALPHA.01", "ALPHA.01"),
        ("Statement has no folio identifier", None),
        ("Folio No : N/A", "N/A"),
    ],
)
def test_folio_delimiters_missing_value_and_sentinel_are_extracted_without_guessing(
    folio_cell,
    expected,
):
    header = ["Date", "Description", "Amount", "NAV", "Price", "Units"]
    row = ["01-07-2026", "Purchase", "1000", "100", "100", "10"]
    table = _table(header, row, folio=folio_cell)

    if expected == "N/A":
        with pytest.raises(Exception) as caught:
            _parse(_pdf(_page("CDSL", [table])))
        assert getattr(caught.value, "reason", None) == "invalid_folio"
    else:
        result = _parse(_pdf(_page("CDSL", [table])))
        assert result["mutual_funds"][0]["folio_number"] == expected


@pytest.mark.parametrize("folio_cell", ["Folio No", "Folio No -", "Folio: "])
def test_folio_label_without_explicit_value_is_rejected(folio_cell):
    header = ["Date", "Description", "Amount", "NAV", "Price", "Units"]
    row = ["01-07-2026", "Purchase", "1000", "100", "100", "10"]
    with pytest.raises(UnsupportedLayoutError):
        _parse(_pdf(_page("CDSL", [_table(header, row, folio=folio_cell)])))


def test_empty_folio_value_in_multi_cell_row_is_rejected():
    header = ["Date", "Description", "Amount", "NAV", "Price", "Units"]
    row = ["01-07-2026", "Purchase", "1000", "100", "100", "10"]
    table = _table(header, row)
    table[0] = ["Folio No -", "Mode of Holding: Single", None, None, None, None]

    with pytest.raises(UnsupportedLayoutError):
        _parse(_pdf(_page("CDSL", [table])))


def test_merged_folio_cell_stops_before_the_next_labeled_field():
    header = ["Date", "Description", "Amount", "NAV", "Price", "Units"]
    row = ["01-07-2026", "Purchase", "1000", "100", "100", "10"]
    table = _table(
        header,
        row,
        folio="Folio No : ALPHA/01 Mode of Holding : Single",
    )

    result = _parse(_pdf(_page("CDSL", [table])))

    assert result["mutual_funds"][0]["folio_number"] == "ALPHA/01"


def test_merged_empty_folio_cannot_capture_the_next_field_label():
    header = ["Date", "Description", "Amount", "NAV", "Price", "Units"]
    row = ["01-07-2026", "Purchase", "1000", "100", "100", "10"]

    with pytest.raises(UnsupportedLayoutError):
        _parse(
            _pdf(
                _page(
                    "CDSL",
                    [_table(header, row, folio="Folio No - Mode of Holding : Single")],
                )
            )
        )


@pytest.mark.parametrize("folio_label", ["Folio No.", "Folio No", "Folio No :"])
def test_split_cell_folio_value_is_recovered(folio_label):
    header = ["Date", "Description", "Amount", "NAV", "Price", "Units"]
    row = ["01-07-2026", "Purchase", "1000", "100", "100", "10"]
    table = _table(header, row)
    table[0] = [folio_label, "SYN-99", None, None, None, None]

    result = _parse(_pdf(_page("CDSL", [table])))

    assert result["mutual_funds"][0]["folio_number"] == "SYN-99"


def test_split_cell_non_folio_value_is_rejected():
    header = ["Date", "Description", "Amount", "NAV", "Price", "Units"]
    row = ["01-07-2026", "Purchase", "1000", "100", "100", "10"]
    table = _table(header, row)
    table[0] = ["Folio No.", "Mode of Holding: Single", None, None, None, None]

    with pytest.raises(UnsupportedLayoutError):
        _parse(_pdf(_page("CDSL", [table])))


def test_dated_transaction_row_shorter_than_declared_header_is_rejected():
    header = ["Date", "Description", "Amount", "NAV", "Price", "Units", "Stamp Duty"]
    valid_row = ["01-07-2026", "Purchase", "1000", "100", "100", "10", "0.05"]
    truncated_row = ["02-07-2026", "Purchase", "1000", "100", "100"]
    table = _table(header, valid_row)
    table.append(truncated_row)

    with pytest.raises(UnsupportedLayoutError):
        _parse(_pdf(_page("CDSL", [table])))


def test_present_but_empty_units_cell_remains_a_skippable_unitless_payout():
    header = ["Date", "Description", "Amount", "NAV", "Price", "Units", "Stamp Duty"]
    valid_row = ["01-07-2026", "Purchase", "1000", "100", "100", "10", "0.05"]
    unitless_row = ["02-07-2026", "Dividend Payout", "50", "100", "100", "", ""]
    table = _table(header, valid_row)
    table.append(unitless_row)

    result = _parse(_pdf(_page("CDSL", [table])))
    transactions = result["mutual_funds"][0]["schemes"][0]["transactions"]

    assert len(transactions) == 1
    assert transactions[0]["type"] == "PURCHASE"


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("Other Scheme - Index Funds", "Equity"),
        ("Other Scheme - Fund of Funds", "Other"),
        ("Solution Oriented Scheme - Retirement Fund", "Hybrid"),
        ("Open Ended Schemes (Equity Scheme)", "Equity"),
        ("Open Ended Schemes (Debt Scheme)", "Debt"),
        ("Open Ended Schemes (Hybrid Scheme)", "Hybrid"),
    ],
)
def test_amfi_category_matching_prefers_specific_sections(header, expected):
    assert parser._broad_category(header) == expected
