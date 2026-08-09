"""Q2 routing and password-order contracts for depository CAS parsing."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import api._cdsl_nsdl_parser as depository_parser
from api._cas_parser import parse_cas_pdf_bytes


TABLE = [
    ["Folio No : SYNTHETIC-01", None, None, None, None, None, None],
    ["ISIN : INF000A00001", None, None, None, None, None, None],
    ["Date", "Description", "Amount", "Stamp Duty", "NAV", "Price", "Units"],
    ["01-07-2026", "Purchase", "1000", "0.05", "100", "100", "10"],
]


def _pdf(marker_page: int):
    pages = []
    for index in range(3):
        page = MagicMock()
        page.extract_text.return_value = (
            "NSDL Consolidated Account Statement" if index == marker_page else "cover"
        )
        page.extract_tables.return_value = [TABLE] if index == marker_page else []
        pages.append(page)
    pdf = MagicMock()
    pdf.pages = pages
    pdf.__enter__ = lambda value: value
    pdf.__exit__ = MagicMock(return_value=False)
    return pdf


def _with_isin_map():
    depository_parser._isin_cache = {
        "INF000A00001": (100001, "Equity", "Synthetic Mutual Fund - Growth")
    }


def test_page_two_marker_routes_and_parses_with_the_same_diagnostic_window():
    _with_isin_map()
    try:
        pdf = _pdf(marker_page=1)
        with patch("pdfplumber.open", return_value=pdf):
            result = parse_cas_pdf_bytes(b"synthetic", "PANPASSWORD")
    finally:
        depository_parser._isin_cache = None

    assert result["source_dialect"] == "nsdl"
    assert result["preflight_summary"]["valid_rows_bucket"] == "1"


def test_page_three_marker_routes_and_parses_with_the_same_diagnostic_window():
    _with_isin_map()
    try:
        pdf = _pdf(marker_page=2)
        with patch("pdfplumber.open", return_value=pdf):
            result = parse_cas_pdf_bytes(b"synthetic", "PANPASSWORD")
    finally:
        depository_parser._isin_cache = None

    assert result["source_dialect"] == "nsdl"


def test_primary_password_is_attempted_before_optional_depository_fallback():
    _with_isin_map()
    try:
        pdf = _pdf(marker_page=1)
        with patch(
            "pdfplumber.open",
            side_effect=[Exception("primary rejected"), pdf, pdf],
        ) as mocked_open:
            result = parse_cas_pdf_bytes(
                b"synthetic",
                "PANPASSWORD",
                "PANANDDOBPASSWORD",
            )
    finally:
        depository_parser._isin_cache = None

    assert result["source_dialect"] == "nsdl"
    assert [item.kwargs["password"] for item in mocked_open.call_args_list] == [
        "PANPASSWORD",
        "PANANDDOBPASSWORD",
        "PANANDDOBPASSWORD",
    ]
