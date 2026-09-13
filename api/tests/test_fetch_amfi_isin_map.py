"""Tests for fetch_amfi_isin_map() using mocked HTTP responses."""

from unittest.mock import MagicMock, patch
import api._cdsl_nsdl_parser as parser_module
from api._cdsl_nsdl_parser import fetch_amfi_isin_map


SAMPLE_NAVALL = """\
Open Ended Schemes(Equity Scheme - Multi Cap Fund)
;
Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date
119551;INF846K01DP8;INF846K01VD5;Axis Bluechip Fund - Direct Growth;85.1200;01-May-2024

Open Ended Schemes(Debt Scheme - Liquid Fund)
;
Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date
120465;INF179K01VK5;INF179K01VL3;Aditya Birla SL Liquid Fund - Direct Growth;382.5100;01-May-2024
"""

# New 8-column layout (AMFI, live-verified 2026-09-10 — see
# docs/plans/amfi-nav-format-change.md). Scheme Name is now the family name
# only; Plan and Option are standalone columns. Old_NAVAll.txt (6-column) is
# only served until 30 Sep 2026, so both layouts must keep working.
SAMPLE_NAVALL_NEW_LAYOUT = """\
Open Ended Schemes(Debt Scheme - Banking and PSU Fund)
;
Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date
119551;INF209KA12Z1;INF209KA13Z9;Aditya Birla Sun Life Banking & PSU Debt Fund;Direct Plan;IDCW-Re-investment;107.2309;09-Sep-2026

Open Ended Schemes(Equity Scheme - Multi Cap Fund)
;
Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date
120716;INF846K01EW2;INF846K01EX0;Axis Bluechip Fund;Direct Plan;Growth;95.4400;09-Sep-2026
120717;INF846K01FA3;INF846K01FB1;Axis Bluechip Fund;;Growth;91.2200;09-Sep-2026
"""


def _make_mock_urlopen(text: str):
    mock_resp = MagicMock()
    mock_resp.read.return_value = text.encode("utf-8")
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    return mock_resp


def test_fetch_amfi_isin_map_returns_correct_mapping():
    parser_module._isin_cache = None  # clear cache before test

    mock_resp = _make_mock_urlopen(SAMPLE_NAVALL)
    with patch("urllib.request.urlopen", return_value=mock_resp):
        result = fetch_amfi_isin_map()

    assert "INF846K01DP8" in result
    code, cat, name = result["INF846K01DP8"]
    assert (code, cat) == (119551, "Equity")
    assert "Axis Bluechip" in name

    assert "INF846K01VD5" in result
    assert result["INF846K01VD5"][:2] == (119551, "Equity")

    assert "INF179K01VK5" in result
    assert result["INF179K01VK5"][:2] == (120465, "Debt")

    assert "INF179K01VL3" in result
    assert result["INF179K01VL3"][:2] == (120465, "Debt")


def test_fetch_amfi_isin_map_uses_cache():
    sentinel = {"INF999X01ZZ0": (999999, "Equity")}
    parser_module._isin_cache = sentinel

    with patch("urllib.request.urlopen") as mock_urlopen:
        result = fetch_amfi_isin_map()
        mock_urlopen.assert_not_called()

    assert result is sentinel
    parser_module._isin_cache = None  # restore


def test_fetch_amfi_isin_map_handles_network_error():
    parser_module._isin_cache = None

    with patch("urllib.request.urlopen", side_effect=OSError("network error")):
        result = fetch_amfi_isin_map()

    assert result == {}
    parser_module._isin_cache = None  # restore


def test_fetch_amfi_isin_map_uses_portal_url():
    """AMFI's original www.amfiindia.com/spages/NAVAll.txt now redirects to
    portal.amfiindia.com — fetch the new host directly rather than relying on
    the redirect, which may not survive past the 30 Sep 2026 cutover."""
    assert parser_module.AMFI_NAV_URL == "https://portal.amfiindia.com/spages/NAVAll.txt"


def test_fetch_amfi_isin_map_new_layout_composes_scheme_name_with_plan_and_option():
    """New 8-column layout: Scheme Name is the family name only; Plan/Option
    are standalone columns. The composed name keeps the old display shape so
    CAS-created provisional identities don't regress."""
    parser_module._isin_cache = None

    mock_resp = _make_mock_urlopen(SAMPLE_NAVALL_NEW_LAYOUT)
    with patch("urllib.request.urlopen", return_value=mock_resp):
        result = fetch_amfi_isin_map()

    assert "INF209KA12Z1" in result
    code, cat, name = result["INF209KA12Z1"]
    assert code == 119551
    assert cat == "Debt"
    assert name == "Aditya Birla Sun Life Banking & PSU Debt Fund - Direct Plan - IDCW-Re-investment"

    assert "INF846K01EW2" in result
    code2, cat2, name2 = result["INF846K01EW2"]
    assert code2 == 120716
    assert cat2 == "Equity"
    assert name2 == "Axis Bluechip Fund - Direct Plan - Growth"
    parser_module._isin_cache = None  # restore


def test_fetch_amfi_isin_map_new_layout_handles_blank_plan_column():
    """Plan can be blank (e.g. schemes AMFI hasn't classified) — the composed
    name should skip the blank segment rather than leaving a stray ' - '."""
    parser_module._isin_cache = None

    mock_resp = _make_mock_urlopen(SAMPLE_NAVALL_NEW_LAYOUT)
    with patch("urllib.request.urlopen", return_value=mock_resp):
        result = fetch_amfi_isin_map()

    assert "INF846K01FA3" in result
    code, cat, name = result["INF846K01FA3"]
    assert code == 120717
    assert name == "Axis Bluechip Fund - Growth"
    parser_module._isin_cache = None  # restore


def test_fetch_amfi_isin_map_old_layout_still_leaves_scheme_name_unchanged():
    """Old 6-column layout has no Plan/Option columns — scheme_name stays as
    AMFI's already-composed 'Fund - Direct Growth' string, unmodified."""
    parser_module._isin_cache = None

    mock_resp = _make_mock_urlopen(SAMPLE_NAVALL)
    with patch("urllib.request.urlopen", return_value=mock_resp):
        result = fetch_amfi_isin_map()

    _, _, name = result["INF846K01DP8"]
    assert name == "Axis Bluechip Fund - Direct Growth"
    parser_module._isin_cache = None  # restore
