"""Provider-neutral CAS canonicalization and fail-closed financial preflight.

Only low-cardinality reason codes and count buckets leave this module on
failure. Transaction descriptions, identifiers, dates, and financial values
must never be added to ``CASPreflightError`` or its summary.
"""

from __future__ import annotations

import copy
import math
import re
from datetime import datetime
from typing import Any, Literal, TypedDict


CASSourceDialect = Literal[
    "cams", "kfintech", "mfcentral", "cdsl", "nsdl", "unknown_standard"
]

CASPreflightReason = Literal[
    "empty_payload",
    "malformed_payload",
    "missing_scheme_identity",
    "invalid_isin",
    "invalid_folio",
    "invalid_date",
    "unsupported_transaction_type",
    "invalid_amount",
    "invalid_units",
    "invalid_nav",
    "invalid_price",
    "direction_mismatch",
    "nav_price_mismatch",
    "accounting_mismatch",
    "unpaired_reversal",
    "no_actionable_transactions",
]

CASCountBucket = Literal["0", "1", "2-5", "6-20", "21-100", "101+"]


class CASPreflightSummary(TypedDict):
    dialect: CASSourceDialect
    folios_bucket: CASCountBucket
    schemes_bucket: CASCountBucket
    rows_bucket: CASCountBucket
    valid_rows_bucket: CASCountBucket
    rejected_rows_bucket: CASCountBucket


class CASPreflightError(ValueError):
    """A privacy-safe parser rejection carrying no source row values."""

    def __init__(self, reason: CASPreflightReason, summary: CASPreflightSummary):
        super().__init__(f"cas_preflight:{reason}")
        self.reason = reason
        self.summary = summary


_DIALECTS: set[str] = {
    "cams",
    "kfintech",
    "mfcentral",
    "cdsl",
    "nsdl",
    "unknown_standard",
}

_PLACEHOLDER_FOLIOS = {"NO", "CDSL", "NSDL", "N/A", "NA", "NONE", "UNKNOWN", "-"}

_IGNORED_TYPES = {
    "REVERSAL",
    "SEGREGATION",
    "STAMP_DUTY_TAX",
    "TDS_TAX",
    "STT_TAX",
    "MISC",
}

_ISIN_RE = re.compile(r"^INF[A-Z0-9]{9}$")
_AMFI_RE = re.compile(r"^\d+$")


def bucket_count(count: int) -> CASCountBucket:
    if count <= 0:
        return "0"
    if count == 1:
        return "1"
    if count <= 5:
        return "2-5"
    if count <= 20:
        return "6-20"
    if count <= 100:
        return "21-100"
    return "101+"


def detect_standard_dialect(raw_text: str) -> CASSourceDialect:
    """Return a coarse standard-CAS dialect for safe telemetry and fixtures."""
    lowered = raw_text[:6000].lower()
    if "mfcentral" in lowered or "mf central" in lowered:
        return "mfcentral"
    if "kfintech" in lowered or "karvy" in lowered or "kfin technologies" in lowered:
        return "kfintech"
    if "cams" in lowered or "computer age management services" in lowered:
        return "cams"
    return "unknown_standard"


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _absolute(value: Any) -> float | None:
    number = _number(value)
    return abs(number) if number is not None else None


def _normalise_date(value: Any) -> str:
    raw = str(value or "").strip()
    for pattern in ("%Y-%m-%d", "%d-%b-%Y"):
        try:
            return datetime.strptime(raw, pattern).date().isoformat()
        except ValueError:
            continue
    return raw


def _valid_iso_date(value: str) -> bool:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date().isoformat() == value
    except ValueError:
        return False


def normalise_transaction_type(raw: str) -> str | None:
    upper = raw.upper().strip()
    if upper in {"PURCHASE", "PURCHASE_SIP"}:
        return "purchase"
    if upper == "REDEMPTION":
        return "redemption"
    if upper in {"SWITCH_IN", "SWITCH_IN_MERGER"}:
        return "switch_in"
    if upper in {"SWITCH_OUT", "SWITCH_OUT_MERGER"}:
        return "switch_out"
    if upper == "DIVIDEND_REINVEST":
        return "dividend_reinvest"
    if upper in {"DIVIDEND_PAYOUT", "DIVIDEND"}:
        return "dividend"
    if upper in _IGNORED_TYPES:
        return None

    lowered = raw.lower().strip()
    if lowered in {"purchase", "buy", "sip"}:
        return "purchase"
    if "switch in" in lowered:
        return "switch_in"
    if "switch out" in lowered:
        return "switch_out"
    if "redempt" in lowered or "withdrawal" in lowered:
        return "redemption"
    if "dividend reinvest" in lowered:
        return "dividend_reinvest"
    if "dividend" in lowered:
        return "dividend"
    return None


def _direction(transaction_type: str | None) -> str:
    if transaction_type in {"purchase", "switch_in", "dividend_reinvest"}:
        return "in"
    if transaction_type in {"redemption", "switch_out"}:
        return "out"
    if transaction_type == "dividend":
        return "cash"
    return "ignored"


def _canonical_transaction(transaction: dict[str, Any]) -> dict[str, Any]:
    canonical = copy.deepcopy(transaction)
    raw_type = str(transaction.get("type") or transaction.get("description") or "").strip()
    source_amount = _number(transaction.get("source_amount", transaction.get("amount"))) or 0.0
    explicit_gross_amount = _number(transaction.get("gross_amount"))
    gross_amount = (
        explicit_gross_amount
        if explicit_gross_amount is not None
        else abs(source_amount)
    )
    raw_charges = transaction.get("charges")
    charges = raw_charges if isinstance(raw_charges, dict) else {}
    stamp_duty = _absolute(transaction.get("stamp_duty", charges.get("stamp_duty"))) or 0.0
    nav = _number(transaction.get("nav"))
    price = _number(transaction.get("price"))
    if price is None:
        price = nav
    source_units = _number(transaction.get("source_units", transaction.get("units")))
    units = abs(source_units) if source_units is not None else None
    normalised_type = normalise_transaction_type(raw_type)

    # Descriptions can contain provider text or reference identifiers and are
    # not needed after type normalization.
    canonical.pop("description", None)
    canonical.update(
        {
            "date": _normalise_date(transaction.get("date")),
            "type": raw_type,
            "normalised_type": normalised_type,
            "direction": _direction(normalised_type),
            "amount": abs(source_amount),
            "source_amount": source_amount,
            "gross_amount": gross_amount,
            "units": units,
            "source_units": source_units,
            "nav": nav,
            "price": price,
            "stamp_duty": stamp_duty,
            "charges": {
                "stamp_duty": stamp_duty,
                "taxes": _absolute(charges.get("taxes")) or 0.0,
                "exit_load": _absolute(charges.get("exit_load")) or 0.0,
                "other": _absolute(charges.get("other")) or 0.0,
            },
        }
    )
    return canonical


def _malformed_payload_shape(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return True
    raw_folios = payload.get("mutual_funds")
    if not isinstance(raw_folios, list):
        return True
    for folio in raw_folios:
        if not isinstance(folio, dict):
            return True
        raw_schemes = folio.get("schemes")
        if not isinstance(raw_schemes, list):
            return True
        for scheme in raw_schemes:
            if not isinstance(scheme, dict):
                return True
            if not isinstance(scheme.get("additional_info"), dict):
                return True
            raw_transactions = scheme.get("transactions")
            if not isinstance(raw_transactions, list):
                return True
            for transaction in raw_transactions:
                if not isinstance(transaction, dict):
                    return True
                charges = transaction.get("charges")
                if charges is not None and not isinstance(charges, dict):
                    return True
    return False


def canonicalize_cas_payload(payload: Any) -> dict[str, Any]:
    source = payload if isinstance(payload, dict) else {}
    canonical = copy.deepcopy(source)
    dialect = source.get("source_dialect")
    if not isinstance(dialect, str) or dialect not in _DIALECTS:
        dialect = "unknown_standard"

    folios: list[dict[str, Any]] = []
    raw_folios = source.get("mutual_funds")
    for raw_folio in raw_folios if isinstance(raw_folios, list) else []:
        if not isinstance(raw_folio, dict):
            continue
        folio = copy.deepcopy(raw_folio)
        raw_folio_number = raw_folio.get("folio_number")
        folio["folio_number"] = str(raw_folio_number).strip() if raw_folio_number else None
        schemes: list[dict[str, Any]] = []
        raw_schemes = raw_folio.get("schemes")
        for raw_scheme in raw_schemes if isinstance(raw_schemes, list) else []:
            if not isinstance(raw_scheme, dict):
                continue
            scheme = copy.deepcopy(raw_scheme)
            scheme["isin"] = str(raw_scheme.get("isin") or "").strip().upper()
            additional = raw_scheme.get("additional_info")
            additional = copy.deepcopy(additional) if isinstance(additional, dict) else {}
            additional["amfi"] = str(additional.get("amfi") or "").strip()
            scheme["additional_info"] = additional
            raw_transactions = raw_scheme.get("transactions")
            scheme["transactions"] = [
                _canonical_transaction(transaction)
                for transaction in raw_transactions if isinstance(transaction, dict)
            ] if isinstance(raw_transactions, list) else []
            schemes.append(scheme)
        folio["schemes"] = schemes
        folios.append(folio)

    canonical["contract_version"] = 1
    canonical["source_dialect"] = dialect
    canonical["mutual_funds"] = folios
    return canonical


def _flatten(payload: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    schemes = [
        scheme
        for folio in payload["mutual_funds"]
        for scheme in folio["schemes"]
    ]
    rows = [transaction for scheme in schemes for transaction in scheme["transactions"]]
    return schemes, rows


def _summary(
    payload: dict[str, Any], valid_rows: int, rejected_rows: int
) -> CASPreflightSummary:
    schemes, rows = _flatten(payload)
    return {
        "dialect": payload["source_dialect"],
        "folios_bucket": bucket_count(len(payload["mutual_funds"])),
        "schemes_bucket": bucket_count(len(schemes)),
        "rows_bucket": bucket_count(len(rows)),
        "valid_rows_bucket": bucket_count(valid_rows),
        "rejected_rows_bucket": bucket_count(rejected_rows),
    }


def _reject(
    payload: dict[str, Any], reason: CASPreflightReason, valid_rows: int
) -> None:
    _, rows = _flatten(payload)
    raise CASPreflightError(
        reason,
        _summary(payload, valid_rows, max(1, len(rows) - valid_rows)),
    )


def _accounting_matches(transaction: dict[str, Any]) -> bool:
    price = transaction.get("price") or transaction.get("nav") or 0.0
    units = transaction.get("units") or 0.0
    base = price * units
    charges = sum(transaction["charges"].values())
    expected_candidates = (
        {base, base + charges}
        if transaction["direction"] == "in"
        else {base, max(0.0, base - charges)}
    )
    # Price x units is independently validated. An untrusted cash field must
    # never be able to widen its own acceptance tolerance.
    tolerance = max(1.0, abs(base) * 0.002)
    if not (
        math.isfinite(base)
        and math.isfinite(charges)
        and all(math.isfinite(expected) for expected in expected_candidates)
        and math.isfinite(tolerance)
    ):
        return False
    source_cash = abs(transaction["source_amount"])
    gross_cash = transaction["gross_amount"]
    source_matches = any(
        abs(source_cash - expected) <= tolerance for expected in expected_candidates
    )
    gross_matches = any(
        abs(gross_cash - expected) <= tolerance for expected in expected_candidates
    )
    source_gross_delta = abs(gross_cash - source_cash)
    relationship_matches = (
        source_gross_delta <= tolerance
        or abs(source_gross_delta - charges) <= tolerance
    )
    return source_matches and gross_matches and relationship_matches


def _reversal_cash_matches(transaction: dict[str, Any]) -> bool:
    source_cash = abs(transaction["source_amount"])
    charges = sum(transaction["charges"].values())
    tolerance = max(1.0, source_cash * 0.002)
    delta = abs(transaction["gross_amount"] - source_cash)
    return delta <= tolerance or abs(delta - charges) <= tolerance


def validate_and_canonicalize_cas(payload: Any) -> dict[str, Any]:
    malformed = _malformed_payload_shape(payload)
    canonical = canonicalize_cas_payload(payload)
    schemes, rows = _flatten(canonical)
    if malformed:
        _reject(canonical, "malformed_payload", 0)
    if not canonical["mutual_funds"] or not schemes or not rows:
        _reject(canonical, "empty_payload", 0)

    valid_rows = 0
    actionable_rows = 0
    for folio in canonical["mutual_funds"]:
        if not folio["schemes"]:
            _reject(canonical, "empty_payload", valid_rows)
        folio_number = folio["folio_number"]
        if folio_number and folio_number.upper() in _PLACEHOLDER_FOLIOS:
            _reject(canonical, "invalid_folio", valid_rows)

        for scheme in folio["schemes"]:
            if not scheme["transactions"]:
                _reject(canonical, "empty_payload", valid_rows)
            amfi = scheme["additional_info"]["amfi"]
            if (
                not amfi
                or not _AMFI_RE.fullmatch(amfi)
                or not 0 < int(amfi) <= 2_147_483_647
            ):
                _reject(canonical, "missing_scheme_identity", valid_rows)
            if not _ISIN_RE.fullmatch(scheme["isin"]):
                _reject(canonical, "invalid_isin", valid_rows)

            purchase_keys = {
                f'{transaction["date"]}:{transaction["amount"]}'
                for transaction in scheme["transactions"]
                if transaction["normalised_type"] == "purchase"
            }

            for transaction in scheme["transactions"]:
                if not _valid_iso_date(transaction["date"]):
                    _reject(canonical, "invalid_date", valid_rows)

                upper_type = transaction["type"].upper().strip()
                ignored = upper_type in _IGNORED_TYPES
                if transaction["normalised_type"] is None and not ignored:
                    _reject(canonical, "unsupported_transaction_type", valid_rows)
                if ignored and upper_type == "REVERSAL":
                    if (
                        abs(transaction["source_amount"]) <= 0
                        or transaction["gross_amount"] <= 0
                    ):
                        _reject(canonical, "invalid_amount", valid_rows)
                    if not _reversal_cash_matches(transaction):
                        _reject(canonical, "accounting_mismatch", valid_rows)
                    if transaction["nav"] is not None and transaction["nav"] <= 0:
                        _reject(canonical, "invalid_nav", valid_rows)
                    if transaction["price"] is not None and transaction["price"] <= 0:
                        _reject(canonical, "invalid_price", valid_rows)
                    if transaction["nav"] is not None and transaction["price"] is not None:
                        difference = abs(transaction["nav"] - transaction["price"])
                        tolerance = max(transaction["nav"], transaction["price"]) * 0.05
                        if difference > tolerance:
                            _reject(canonical, "nav_price_mismatch", valid_rows)
                    if transaction["source_units"] is not None:
                        if transaction["units"] is None or transaction["units"] <= 0:
                            _reject(canonical, "invalid_units", valid_rows)
                        if math.copysign(1, transaction["source_units"]) != math.copysign(
                            1, transaction["source_amount"]
                        ):
                            _reject(canonical, "direction_mismatch", valid_rows)
                        if transaction["price"] is None or transaction["price"] <= 0:
                            _reject(canonical, "invalid_price", valid_rows)
                        if not _accounting_matches(transaction):
                            _reject(canonical, "accounting_mismatch", valid_rows)
                    reversal_key = f'{transaction["date"]}:{transaction["amount"]}'
                    if reversal_key not in purchase_keys:
                        _reject(canonical, "unpaired_reversal", valid_rows)
                if ignored:
                    valid_rows += 1
                    continue

                actionable_rows += 1
                if abs(transaction["source_amount"]) <= 0 or transaction["gross_amount"] <= 0:
                    _reject(canonical, "invalid_amount", valid_rows)
                if transaction["normalised_type"] == "dividend":
                    valid_rows += 1
                    continue
                if transaction["units"] is None or transaction["units"] <= 0:
                    _reject(canonical, "invalid_units", valid_rows)
                if (
                    transaction["source_units"] is not None
                    and transaction["source_amount"] != 0
                    and math.copysign(1, transaction["source_units"])
                    != math.copysign(1, transaction["source_amount"])
                ):
                    _reject(canonical, "direction_mismatch", valid_rows)
                if transaction["direction"] == "in" and (
                    transaction["source_amount"] < 0
                    or (transaction["source_units"] or 0) < 0
                ):
                    _reject(canonical, "direction_mismatch", valid_rows)
                if transaction["nav"] is not None and transaction["nav"] <= 0:
                    _reject(canonical, "invalid_nav", valid_rows)
                if transaction["price"] is None or transaction["price"] <= 0:
                    _reject(canonical, "invalid_price", valid_rows)
                if transaction["nav"] is not None:
                    difference = abs(transaction["nav"] - transaction["price"])
                    tolerance = max(transaction["nav"], transaction["price"]) * 0.05
                    if difference > tolerance:
                        _reject(canonical, "nav_price_mismatch", valid_rows)
                if not _accounting_matches(transaction):
                    _reject(canonical, "accounting_mismatch", valid_rows)
                valid_rows += 1

    if actionable_rows == 0:
        _reject(canonical, "no_actionable_transactions", valid_rows)

    canonical["preflight_summary"] = _summary(canonical, valid_rows, 0)
    return canonical


def safe_failure_body(error: CASPreflightError) -> dict[str, str]:
    """Build the complete safe HTTP failure body for the Python route."""
    return {
        "error": "This statement could not be validated safely. No portfolio data was changed.",
        "reason": error.reason,
    }


def safe_parser_telemetry(
    outcome: Literal["success", "wrong_password", "holdings_only", "rejected", "exception"],
    *,
    summary: CASPreflightSummary | None = None,
    reason: CASPreflightReason | None = None,
) -> dict[str, str]:
    """Return the complete allowlisted PostHog property set for parser outcomes."""
    properties: dict[str, str] = {"outcome": outcome}
    if summary is not None:
        properties.update(
            {
                "dialect": summary["dialect"],
                "rows_bucket": summary["rows_bucket"],
                "valid_rows_bucket": summary["valid_rows_bucket"],
                "rejected_rows_bucket": summary["rejected_rows_bucket"],
            }
        )
    if reason is not None:
        properties["failure_reason"] = reason
    return properties
