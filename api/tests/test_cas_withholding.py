"""Synthetic tests for the shared net-withholding narration gate."""

from __future__ import annotations

import pytest

from api._cas_withholding import cash_basis_for_transaction


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
        cash_basis_for_transaction("SWITCH_OUT", description, -88.0, 100.0)
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
        cash_basis_for_transaction("REDEMPTION", description, -55.0, 100.0)
        == "source"
    )


def test_narration_without_positive_residual_stays_on_source_basis():
    assert (
        cash_basis_for_transaction(
            "REDEMPTION",
            "Synthetic redemption less TDS",
            -100.0,
            100.0,
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
        )
        == "source"
    )
