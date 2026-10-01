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


def cash_basis_for_transaction(
    transaction_type: str,
    description: str,
    source_amount: float | None,
    independent_gross: float | None,
) -> CASCashBasis:
    """Return net basis only with positive, non-negated evidence of withholding.

    Provider narration is necessary but not sufficient. The independently
    supported gross value must also exceed the magnitude of source cash by more
    than the accounting tolerance. The canonical preflight remains responsible
    for the upper withholding bound and the complete financial equation.
    """
    normalized_type = transaction_type.upper().strip()
    if normalized_type not in _NET_WITHHOLDING_OUTFLOW_TYPES:
        return "source"
    if not _NET_WITHHOLDING_RE.search(description):
        return "source"
    if _NEGATED_NET_WITHHOLDING_RE.search(description):
        return "source"
    if source_amount is None or independent_gross is None:
        return "source"

    gross = abs(independent_gross)
    source = abs(source_amount)
    if not math.isfinite(gross) or not math.isfinite(source) or gross <= 0:
        return "source"

    tolerance = max(1.0, gross * 0.002)
    return "net_of_withholding" if gross - source > tolerance else "source"
