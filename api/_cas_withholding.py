"""Shared, fail-closed classification for CAS net-withholding outflows."""

from __future__ import annotations

import math
import re
from typing import Literal


CASCashBasis = Literal["source", "net_of_withholding"]

_NET_WITHHOLDING_OUTFLOW_TYPES = {"REDEMPTION", "SWITCH_OUT"}
_WITHHOLDING_TERM = (
    r"(?:tds|tax\s+deducted\s+at\s+source|withholding(?:\s+tax)?)"
)
_NET_WITHHOLDING_RE = re.compile(
    rf"\b{_WITHHOLDING_TERM}\b",
    re.IGNORECASE | re.UNICODE,
)
_NEGATED_NET_WITHHOLDING_RE = re.compile(
    rf"(?:"
    rf"\b(?:no|nil|none|zero|n\s*\.?\s*a\s*\.?)\s+{_WITHHOLDING_TERM}\b"
    rf"|"
    rf"\b{_WITHHOLDING_TERM}\b\s*"
    rf"(?:[:=,@/\-–—]\s*)?(?:deduction\s+)?(?:is\s+)?"
    rf"(?:nil|n\s*\.?\s*a\s*\.?|not\s+applicable|none|zero|0(?:\.0+)?|no)\b"
    rf")",
    re.IGNORECASE | re.UNICODE,
)
_REPORTED_WITHHOLDING_AMOUNT_RE = re.compile(
    rf"\b{_WITHHOLDING_TERM}\b"
    rf"(?:\s+(?:amount|deducted))?\s*"
    rf"(?:[:=,@/\-–—]\s*|(?:rs\.?|inr|₹)\s+)"
    rf"(?:(?:rs\.?|inr|₹)\s*)?"
    rf"(?P<amount>\d+(?:,\d{{2,3}})*(?:\.\d+)?)"
    rf"(?![\d.,])"
    rf"(?!\s*%)",
    re.IGNORECASE | re.UNICODE,
)


def reported_withholding_from_description(description: str) -> float | None:
    """Return an explicitly printed withholding amount, never an inferred residual."""
    match = _REPORTED_WITHHOLDING_AMOUNT_RE.search(description)
    if match is None:
        return None
    try:
        amount = float(match.group("amount").replace(",", ""))
    except (TypeError, ValueError):
        return None
    return amount if math.isfinite(amount) else None


def cash_basis_for_transaction(
    transaction_type: str,
    description: str,
    source_amount: float | None,
    independent_gross: float | None,
    reported_withholding: float | None,
) -> CASCashBasis:
    """Return net basis only when reported withholding reconciles exactly.

    Provider narration is only a permission signal. Price times units must
    independently support gross cash, and a separately reported tax amount must
    match the gross-versus-source residual within the accounting tolerance. The
    canonical preflight repeats that corroboration and the upper withholding
    bound before any import can proceed.
    """
    normalized_type = transaction_type.upper().strip()
    if normalized_type not in _NET_WITHHOLDING_OUTFLOW_TYPES:
        return "source"
    if not _NET_WITHHOLDING_RE.search(description):
        return "source"
    if _NEGATED_NET_WITHHOLDING_RE.search(description):
        return "source"
    if (
        source_amount is None
        or independent_gross is None
        or reported_withholding is None
    ):
        return "source"

    gross = abs(independent_gross)
    source = abs(source_amount)
    reported = reported_withholding
    if (
        not math.isfinite(gross)
        or not math.isfinite(source)
        or not math.isfinite(reported)
        or gross <= 0
    ):
        return "source"

    tolerance = max(1.0, gross * 0.002)
    withheld = gross - source
    if withheld <= tolerance or reported <= tolerance:
        return "source"
    return (
        "net_of_withholding"
        if abs(withheld - reported) <= tolerance
        else "source"
    )
