from __future__ import annotations

import io
import logging
from typing import Any

import casparser
import pdfplumber

from api._cdsl_nsdl_parser import (
    HoldingsOnlyError,
    detect_cdsl_nsdl,
    looks_like_depository_cas,
    parse_cdsl_nsdl,
)
from api._cas_preflight import detect_standard_dialect, validate_and_canonicalize_cas

logger = logging.getLogger(__name__)


def _to_float(value: Any) -> float | None:
    if value in (None, "", "-"):
        return None
    return float(value)


def _title_scheme_type(value: str | None) -> str | None:
    if not value:
        return None
    upper = value.upper()
    if upper == "EQUITY":
        return "Equity"
    if upper == "DEBT":
        return "Debt"
    if upper == "HYBRID":
        return "Hybrid"
    if upper == "OTHER":
        return "Other"
    return value.title()


def normalize_casparser_result(
    raw: dict[str, Any],
    source_dialect: str = "unknown_standard",
) -> dict[str, Any]:
    mutual_funds: list[dict[str, Any]] = []

    for folio in raw.get("folios", []):
        schemes: list[dict[str, Any]] = []
        for scheme in folio.get("schemes", []):
            transactions = [
                {
                    "date": tx.get("date"),
                    "type": tx.get("type"),
                    "description": tx.get("description"),
                    "amount": _to_float(tx.get("amount")),
                    "source_amount": _to_float(tx.get("source_amount", tx.get("amount"))),
                    "gross_amount": _to_float(tx.get("gross_amount", tx.get("amount"))),
                    "units": _to_float(tx.get("units")),
                    "source_units": _to_float(tx.get("source_units", tx.get("units"))),
                    "nav": _to_float(tx.get("nav")),
                    "price": _to_float(tx.get("price", tx.get("nav"))),
                    "stamp_duty": _to_float(tx.get("stamp_duty")) or 0.0,
                    "charges": tx.get("charges") if isinstance(tx.get("charges"), dict) else {},
                    "balance": _to_float(tx.get("balance")),
                }
                for tx in scheme.get("transactions", [])
            ]

            valuation = scheme.get("valuation") or {}
            schemes.append(
                {
                    "name": scheme.get("scheme"),
                    "isin": scheme.get("isin"),
                    "type": _title_scheme_type(scheme.get("type")),
                    "units": _to_float(scheme.get("close")),
                    "nav": _to_float(valuation.get("nav")),
                    "value": _to_float(valuation.get("value")),
                    "additional_info": {
                        "amfi": scheme.get("amfi"),
                        "rta_code": scheme.get("rta_code"),
                        "advisor": scheme.get("advisor"),
                        "open_units": _to_float(scheme.get("open")),
                        "close_units": _to_float(scheme.get("close")),
                    },
                    "transactions": transactions,
                }
            )

        mutual_funds.append(
            {
                "folio_number": folio.get("folio"),
                "amc": folio.get("amc"),
                "schemes": schemes,
            }
        )

    return {"source_dialect": source_dialect, "mutual_funds": mutual_funds}


def _detection_text(pdf: pdfplumber.PDF) -> str:
    """Concatenate text from the first 3 pages for CAS-type detection.

    CDSL/NSDL PDFs sometimes have a cover/disclaimer as page 1 that contains
    no "CDSL"/"NSDL" marker; those strings appear on page 2 or 3.
    """
    parts: list[str] = []
    for page in pdf.pages[:3]:
        parts.append(page.extract_text() or "")
    return "\n".join(parts)


def parse_cas_pdf_bytes(
    pdf_bytes: bytes,
    password: str,
    cdsl_password: str | None = None,
) -> dict[str, Any]:
    """Parse a CAS PDF, auto-detecting whether it is CAMS/KFintech or CDSL/NSDL.

    Strategy:
    1. Try to open with `password`. Extract first 3 pages of text for detection.
       If open fails AND cdsl_password provided → try cdsl_password.
    2. Scan extracted text for "CDSL"/"NSDL" markers.
       Matching → route to CDSL/NSDL parser.
       Not matching → route to casparser (CAMS/KFintech/MFCentral).
       If casparser also fails → fall back to CDSL/NSDL parser as last resort.
    """
    working_password: str | None = None
    detection_text = ""

    # Try primary password first
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes), password=password) as pdf:
            detection_text = _detection_text(pdf)
        working_password = password
    except Exception:
        pass

    # Fall back to CDSL password if primary open failed
    if working_password is None and cdsl_password:
        try:
            with pdfplumber.open(io.BytesIO(pdf_bytes), password=cdsl_password) as pdf:
                detection_text = _detection_text(pdf)
            working_password = cdsl_password
        except Exception:
            pass

    if working_password is None:
        raise Exception(
            "Wrong PDF password. "
            "For CAMS/KFintech/MFCentral PDFs your PAN is the password. "
            "FolioLens tried your saved PAN first and PAN + date of birth when available. "
            "Add your date of birth after a failed attempt, or enter a custom PDF password."
        )

    cas_type = detect_cdsl_nsdl(detection_text)
    logger.info(
        "[cas-parser] detected cas_type=%s, password_source=%s",
        cas_type,
        "primary" if working_password == password else "cdsl",
    )

    if looks_like_depository_cas(detection_text):
        return parse_cdsl_nsdl(pdf_bytes, working_password, detection_text)

    # CAMS / KFintech / MFCentral path — use casparser with the primary password
    try:
        raw = casparser.read_cas_pdf(io.BytesIO(pdf_bytes), password, output="dict")
    except Exception as exc:
        # casparser can't handle CDSL/NSDL PDFs. If the text we extracted looks
        # like it might be a demat CAS (has ISINs starting with INF), try our
        # CDSL/NSDL parser as a fallback before surfacing the error.
        import re as _re
        if _re.search(r"INF[A-Z0-9]{9}", detection_text):
            logger.warning(
                "[cas-parser] casparser failed and text contains ISINs — retrying with CDSL/NSDL parser"
            )
            return parse_cdsl_nsdl(pdf_bytes, working_password, detection_text)
        raise exc

    if hasattr(raw, "model_dump"):
        raw = raw.model_dump(mode="json")

    normalized = normalize_casparser_result(raw, detect_standard_dialect(detection_text))
    return validate_and_canonicalize_cas(normalized)
