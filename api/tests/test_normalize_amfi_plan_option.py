"""Tests for _normalize_amfi_plan_type / _normalize_amfi_option_type — the
mapping from AMFI's raw NAVAll Plan/Option column text to scheme_master's
plan_type/option_type enums. See docs/plans/amfi-nav-format-change.md M2.1.
"""

from api._cdsl_nsdl_parser import (
    _normalize_amfi_option_type,
    _normalize_amfi_plan_type,
)


class TestNormalizeAmfiPlanType:
    def test_direct_plan(self):
        assert _normalize_amfi_plan_type("Direct Plan") == "direct"

    def test_regular_plan(self):
        assert _normalize_amfi_plan_type("Regular Plan") == "regular"

    def test_is_case_insensitive(self):
        assert _normalize_amfi_plan_type("DIRECT PLAN") == "direct"
        assert _normalize_amfi_plan_type("regular plan") == "regular"

    def test_tolerates_surrounding_whitespace(self):
        assert _normalize_amfi_plan_type("  Direct Plan  ") == "direct"

    def test_blank_returns_none(self):
        assert _normalize_amfi_plan_type("") is None
        assert _normalize_amfi_plan_type("   ") is None

    def test_unrecognised_text_returns_none(self):
        assert _normalize_amfi_plan_type("Institutional Plan") is None


class TestNormalizeAmfiOptionType:
    def test_growth(self):
        assert _normalize_amfi_option_type("Growth") == "growth"

    def test_bonus(self):
        assert _normalize_amfi_option_type("Bonus") == "bonus"

    def test_bare_idcw(self):
        assert _normalize_amfi_option_type("IDCW Option") == "idcw"

    def test_idcw_reinvestment(self):
        assert _normalize_amfi_option_type("IDCW-Re-investment") == "reinvest"
        assert _normalize_amfi_option_type("IDCW Reinvestment") == "reinvest"

    def test_hyphenated_reinvestment_tolerated(self):
        # AMFI's live 8-column NAVAll uses this exact hyphenated spelling —
        # "reinvest" is not a literal substring of "re-investment".
        assert _normalize_amfi_option_type("Re-investment") == "reinvest"

    def test_hyphenated_payout_tolerated(self):
        assert _normalize_amfi_option_type("Pay-out") == "payout"

    def test_idcw_payout(self):
        assert _normalize_amfi_option_type("IDCW Payout") == "payout"
        assert _normalize_amfi_option_type("Payout of IDCW") == "payout"

    def test_dividend_reinvestment_without_idcw_word(self):
        assert _normalize_amfi_option_type("Dividend Reinvestment") == "reinvest"

    def test_dividend_payout_without_idcw_word(self):
        assert _normalize_amfi_option_type("Dividend Payout") == "payout"

    def test_bare_dividend_defaults_to_idcw(self):
        assert _normalize_amfi_option_type("Dividend") == "idcw"

    def test_income_distribution_phrase(self):
        assert (
            _normalize_amfi_option_type("Payout of Income Distribution cum Capital Withdrawal")
            == "payout"
        )

    def test_bare_reinvest_without_idcw_or_dividend(self):
        assert _normalize_amfi_option_type("Reinvestment") == "reinvest"

    def test_bare_payout_without_idcw_or_dividend(self):
        assert _normalize_amfi_option_type("Payout") == "payout"

    def test_growth_takes_precedence_over_other_keywords(self):
        # Defensive: a "Growth" option should never be misread as a payout
        # variant even if other keywords happened to co-occur.
        assert _normalize_amfi_option_type("Growth") == "growth"

    def test_blank_returns_none(self):
        assert _normalize_amfi_option_type("") is None
        assert _normalize_amfi_option_type("   ") is None

    def test_unrecognised_text_returns_none(self):
        assert _normalize_amfi_option_type("Some Unknown Option") is None
