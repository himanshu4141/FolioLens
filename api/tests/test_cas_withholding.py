"""Synthetic tests for the shared net-withholding narration gate."""

from __future__ import annotations

import pytest

from api._cas_withholding import (
    cash_basis_for_transaction,
    reported_withholding_from_description,
)


@pytest.mark.parametrize(
    "description",
    [
        "Synthetic switch out less TDS",
        "Synthetic redemption with tax deducted at source",
        "Synthetic redemption with withholding tax",
    ],
)
def test_explicit_positive_narration_with_residual_selects_net_basis(description):
    assert (
        cash_basis_for_transaction(
            "SWITCH_OUT", description, -88.0, 100.0, 12.0
        )
        == "net_of_withholding"
    )


@pytest.mark.parametrize(
    "description",
    [
        "Synthetic redemption - TDS Nil",
        "Synthetic redemption, TDS not applicable",
        "Synthetic redemption with no withholding tax",
        "Synthetic redemption - TDS: 0.00",
        "Synthetic redemption - Nil tax deducted at source",
    ],
)
def test_negated_withholding_narration_stays_on_source_basis(description):
    assert (
        cash_basis_for_transaction(
            "REDEMPTION", description, -55.0, 100.0, 45.0
        )
        == "source"
    )


def test_narration_without_positive_residual_stays_on_source_basis():
    assert (
        cash_basis_for_transaction(
            "REDEMPTION",
            "Synthetic redemption less TDS",
            -100.0,
            100.0,
            12.0,
        )
        == "source"
    )


def test_withholding_narration_does_not_apply_to_inflow():
    assert (
        cash_basis_for_transaction(
            "PURCHASE",
            "Synthetic purchase with TDS",
            88.0,
            100.0,
            12.0,
        )
        == "source"
    )


@pytest.mark.parametrize(
    "description",
    [
        "Synthetic redemption without TDS",
        "Synthetic redemption - TDS not deducted",
        "Synthetic redemption, no deduction of TDS",
        "Synthetic redemption exempt from TDS",
        "Synthetic redemption - TDS exempt",
        "Synthetic redemption - TDS amount nil",
        "Synthetic redemption - TDS: Rs. 0.00",
        "Synthetic redemption - TDS waived",
        "Synthetic redemption - TDS Not Charged",
        "Synthetic redemption - NIL rate of TDS",
    ],
)
def test_narration_cannot_substitute_for_reported_withholding(description):
    assert (
        cash_basis_for_transaction(
            "REDEMPTION", description, -55.0, 100.0, None
        )
        == "source"
    )


@pytest.mark.parametrize("reported_withholding", [0.0, 12.0, 43.0, 47.0])
def test_reported_withholding_must_match_the_residual(reported_withholding):
    assert (
        cash_basis_for_transaction(
            "REDEMPTION",
            "Synthetic redemption less TDS",
            -55.0,
            100.0,
            reported_withholding,
        )
        == "source"
    )


@pytest.mark.parametrize(
    ("description", "expected"),
    [
        ("Synthetic switch out less TDS - INR 12.00", 12.0),
        ("Synthetic redemption withholding tax: Rs. 1,234.50", 1234.5),
        ("Synthetic redemption tax deducted at source amount ₹ 25", 25.0),
        ("Synthetic redemption TDS: Rs. 0.00", 0.0),
        ("Synthetic redemption TDS at 12.5%", None),
        ("Synthetic redemption less TDS", None),
    ],
)
def test_only_explicit_currency_amounts_are_extracted(description, expected):
    assert reported_withholding_from_description(description) == expected
