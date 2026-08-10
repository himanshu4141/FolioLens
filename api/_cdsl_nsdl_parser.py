"""CDSL / NSDL CAS PDF parser.

Produces the same { "mutual_funds": [...] } shape as normalize_casparser_result()
so importCASData() in the TypeScript edge function needs zero changes.

Key design decisions:
- ISINs (INF[A-Z0-9]{9}) are always ASCII regardless of PDF language — used as
  the primary anchor for every scheme block.
- Each transaction table establishes a normalized header map before any dated
  row is accepted; issuer text is diagnostic and never selects column indexes.
- pdfplumber's table extraction is language-agnostic; financial values are
  always ASCII numerals.
- Dates and transaction descriptions may appear in Hindi (Devanagari) — handled
  via explicit mapping tables with re.UNICODE patterns.

Real CDSL CAS table structure (per scheme):
  Row: [Folio No : <folio> Mode of Holding : Single ...]   ← single merged cell
  Row: [ISIN : INF... UCC : ... Mobile : ... Email : ...]  ← single merged cell
  Row: [Hindi/English column headers]                       ← schema authority
  Row: [Opening Balance  <units>]                          ← balance row
  Row: [DD-MM-YYYY  SIP Purchase ...  amount nav price units stamp ...]
  Row: [Closing Balance  <units>]                          ← balance row
"""

from __future__ import annotations

import io
import logging
import re
import urllib.request
from typing import Any

import pdfplumber

from api._cas_preflight import validate_and_canonicalize_cas

logger = logging.getLogger(__name__)

# ── AMFI ISIN → scheme_code cache ─────────────────────────────────────────────

# tuple: (scheme_code, broad_category, scheme_name)
_isin_cache: dict[str, tuple[int, str, str]] | None = None

AMFI_NAV_URL = "https://www.amfiindia.com/spages/NAVAll.txt"

_CATEGORY_MAP = [
    ("fund of fund", "Other"),
    ("index fund", "Equity"),
    ("etf", "Equity"),
    ("solution", "Hybrid"),
    ("hybrid", "Hybrid"),
    ("equity", "Equity"),
    ("debt", "Debt"),
    ("other", "Other"),
]


def _broad_category(header: str) -> str | None:
    """Return category label if header matches a known keyword, else None.

    Returns None (not "Other") when no keyword matches so that AMC name lines
    like 'HDFC Mutual Fund' do not accidentally reset the current category.
    """
    low = header.lower()
    for keyword, label in _CATEGORY_MAP:
        if keyword in low:
            return label
    return None


def fetch_amfi_isin_map() -> dict[str, tuple[int, str, str]]:
    """Return { isin: (scheme_code, broad_category, scheme_name) } for all MF ISINs.

    Result is cached module-level so warm Vercel invocations skip the network
    round-trip.
    """
    global _isin_cache
    if _isin_cache is not None:
        return _isin_cache

    logger.info("[cdsl-parser] fetching AMFI ISIN map from %s", AMFI_NAV_URL)
    try:
        with urllib.request.urlopen(AMFI_NAV_URL, timeout=15) as resp:
            text = resp.read().decode("utf-8", errors="replace")
    except Exception as exc:
        logger.error("[cdsl-parser] AMFI fetch failed: %s", exc)
        _isin_cache = {}
        return _isin_cache

    result: dict[str, tuple[int, str, str]] = {}
    current_category = "Other"

    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue

        # Section header lines (no semicolons) may be category headers like
        # "Open Ended Schemes(Equity Scheme - Multi Cap Fund)" or AMC name lines
        # like "HDFC Mutual Fund". Only update current_category if a keyword
        # matches — AMC name lines must not reset the category to "Other".
        if ";" not in line:
            cat = _broad_category(line)
            if cat is not None:
                current_category = cat
            continue

        parts = line.split(";")
        if len(parts) < 6:
            continue

        # NAVAll.txt columns:
        # scheme_code ; ISIN_growth ; ISIN_div_reinvest ; scheme_name ; nav ; date
        try:
            code = int(parts[0].strip())
        except ValueError:
            continue

        scheme_name = parts[3].strip() if len(parts) > 3 else ""

        for col in (1, 2):
            isin = parts[col].strip()
            if re.match(r"^INF[A-Z0-9]{9}$", isin):
                result[isin] = (code, current_category, scheme_name)

    logger.info("[cdsl-parser] AMFI map loaded: %d ISINs", len(result))
    _isin_cache = result
    return result


# ── Detection ──────────────────────────────────────────────────────────────────

def detect_cdsl_nsdl(raw_text: str) -> str | None:
    """Return a deterministic issuer diagnostic, never a column-layout choice."""
    snippet = raw_text.upper()
    cdsl_strong = "CENTRAL DEPOSITORY SERVICES" in snippet
    nsdl_strong = "NATIONAL SECURITIES DEPOSITORY" in snippet
    if cdsl_strong != nsdl_strong:
        return "cdsl" if cdsl_strong else "nsdl"

    has_cdsl = bool(re.search(r"\bCDSL\b", snippet))
    has_nsdl = bool(re.search(r"\bNSDL\b", snippet))
    if has_cdsl != has_nsdl:
        return "cdsl" if has_cdsl else "nsdl"
    return None


def looks_like_depository_cas(raw_text: str) -> bool:
    """Return whether multi-page text contains a depository-CAS routing hint."""
    snippet = raw_text.upper()
    return bool(
        re.search(r"\b(?:CDSL|NSDL)\b", snippet)
        or "CENTRAL DEPOSITORY SERVICES" in snippet
        or "NATIONAL SECURITIES DEPOSITORY" in snippet
    )


# ── Date parsing ───────────────────────────────────────────────────────────────

MONTH_MAP: dict[str, str] = {
    # English (3-letter abbreviations)
    "jan": "01", "feb": "02", "mar": "03", "apr": "04",
    "may": "05", "jun": "06", "jul": "07", "aug": "08",
    "sep": "09", "oct": "10", "nov": "11", "dec": "12",
    # Hindi full month names (Devanagari)
    "जनवरी": "01",
    "फरवरी": "02",
    "मार्च": "03",
    "अप्रैल": "04",
    "मई": "05",
    "जून": "06",
    "जुलाई": "07",
    "अगस्त": "08",
    "सितंबर": "09",
    "अक्तूबर": "10",
    "अक्टूबर": "10",
    "नवंबर": "11",
    "दिसंबर": "12",
}

# DD-MM-YYYY (numeric month) — most common in actual CDSL CAS PDFs
_DATE_NUMERIC_RE = re.compile(r"^(\d{1,2})[/\-](\d{2})[/\-](\d{4})$")

# DD-MonthName-YYYY (English abbreviation or full Hindi month name)
_DATE_TEXT_RE = re.compile(
    r"^(\d{1,2})[/\-]([A-Za-zऀ-ॿ]+)[/\-](\d{4})$",
    re.UNICODE,
)


def parse_date_cdsl(raw: str) -> str:
    """Parse a date string to ISO YYYY-MM-DD.

    Handles:
    - DD-MM-YYYY  (numeric month, most common in CDSL)
    - DD-Apr-YYYY (English 3-letter month)
    - DD-अप्रैल-YYYY (Hindi month name)
    - YYYY-MM-DD  (passthrough)
    """
    if not raw:
        return ""
    raw = raw.strip()

    # Already ISO
    if re.match(r"^\d{4}-\d{2}-\d{2}$", raw):
        return raw

    # DD-MM-YYYY (numeric month) — handle first, most common in CDSL
    m = _DATE_NUMERIC_RE.match(raw)
    if m:
        dd, mm, yyyy = m.group(1), m.group(2), m.group(3)
        return f"{yyyy}-{mm}-{dd.zfill(2)}"

    # DD-Mon-YYYY or DD-HindiMonth-YYYY
    m = _DATE_TEXT_RE.match(raw)
    if m:
        dd, mon_raw, yyyy = m.group(1), m.group(2), m.group(3)
        key = mon_raw.lower()
        mm = MONTH_MAP.get(key) or MONTH_MAP.get(mon_raw)
        if mm:
            return f"{yyyy}-{mm}-{dd.zfill(2)}"

    logger.warning("[cdsl-parser] unrecognised_date")
    return raw


# ── Transaction type normalisation ─────────────────────────────────────────────

TX_KEYWORDS: list[tuple[str, str]] = [
    # "Systematic Investment" and "Sys. Investment" are SIP purchases in CDSL CAS
    (r"खरीद|purchase|buy|nfo|sip|systematic|sys\b", "PURCHASE"),
    (r"मोचन|redemption|redeem|withdrawal", "REDEMPTION"),
    (r"स्विच.*इन|switch.*in", "SWITCH_IN"),
    (r"स्विच.*आउट|switch.*out", "SWITCH_OUT"),
    (r"लाभांश.*पुनर्निवेश|dividend.*reinvest", "DIVIDEND_REINVEST"),
    (r"लाभांश|dividend", "DIVIDEND"),
]

_TX_COMPILED = [(re.compile(pat, re.IGNORECASE | re.UNICODE), typ) for pat, typ in TX_KEYWORDS]


def normalise_cdsl_tx_type(description: str) -> str | None:
    """Map an English or Hindi transaction description to an uppercase type string.

    Returns None for unrecognised descriptions (caller skips the row).
    """
    if not description:
        return None
    for pattern, tx_type in _TX_COMPILED:
        if pattern.search(description):
            return tx_type
    return None


# ── ISIN / numeric helpers ─────────────────────────────────────────────────────

_ISIN_RE = re.compile(r"\bINF[A-Z0-9]{9}\b")

_FLOAT_RE = re.compile(r"^-?[\d,]+\.?\d*$")

# Detects garbled text like "STATEME0N1T" where letters and digits alternate
# inside words. Real fund names don't have patterns like "E0N" or "T0R2A4".
_GARBLED_RE = re.compile(r"[A-Za-z]\d[A-Za-z]")


def _parse_float(val: Any) -> float | None:
    if val is None:
        return None
    s = str(val).strip().replace(",", "")
    if not s or s == "-":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _extract_isin_from_cell(cell: Any) -> str | None:
    """Return the ISIN string from a cell like 'ISIN : INF179K01XQ0', or None."""
    if not cell:
        return None
    m = _ISIN_RE.search(str(cell))
    return m.group(0) if m else None


def _cell_is_isin(cell: Any) -> bool:
    return bool(cell and _ISIN_RE.search(str(cell).strip()))


# ── Core extraction ────────────────────────────────────────────────────────────

# Matches both DD-MM-YYYY and DD-Mon-YYYY / DD-HindiMonth-YYYY
_ROW_DATE_RE = re.compile(
    r"^\d{1,2}[/\-](?:\d{2}|[A-Za-zऀ-ॿ]+)[/\-]\d{4}$",
    re.UNICODE,
)

# Matches the row label only. The value is validated separately so a following
# field such as "Mode of Holding" cannot be mistaken for the folio identifier.
_FOLIO_LABEL_RE = re.compile(
    r"^\s*folio(?:\s+(?:no(?:\.)?|number))?\s*(?P<suffix>.*)$",
    re.IGNORECASE,
)
_FOLIO_DELIMITED_VALUE_RE = re.compile(
    r"^(?::|[-\u2010-\u2015])\s*(?P<value>.*)$",
    re.IGNORECASE,
)
_FOLIO_VALUE_RE = re.compile(r"^[A-Z0-9][A-Z0-9/\-.]*$", re.IGNORECASE)
_FOLIO_SENTINEL_VALUES = {
    "NO",
    "CDSL",
    "NSDL",
    "N/A",
    "NA",
    "NONE",
    "UNKNOWN",
}
_FOLIO_TRAILING_FIELD_RE = re.compile(
    r"(?:^|\s+)(?=(?:mode\s+of\s+holding|holder\s+details|kyc\s+status|"
    r"account\s+number|no\.?\s+of\s+units|current\s+nav)\b\s*:)",
    re.IGNORECASE,
)

_CLOSING_RE = re.compile(
    r"closing\s+balance|अंतिम\s+शेष|बंद\s+शेष",
    re.IGNORECASE | re.UNICODE,
)
_HEADER_ALIASES: dict[str, tuple[str, ...]] = {
    "date": ("date", "transaction date", "txn date"),
    "description": (
        "description",
        "transaction description",
        "transaction details",
        "narration",
        "particulars",
    ),
    "amount": ("amount", "transaction amount", "txn amount"),
    "stamp_duty": ("stamp duty",),
    "nav": ("nav", "net asset value"),
    "price": ("price", "transaction price", "txn price", "unit price"),
    "units": ("units", "quantity"),
    "taxes": ("tax", "taxes"),
    "exit_load": ("exit load",),
}

_REQUIRED_HEADER_FIELDS = {"date", "description", "amount", "units"}


class UnsupportedLayoutError(ValueError):
    """Raised when a transaction table has no safe, unambiguous header map."""


def _normalise_header(cell: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", cell.lower()).split())


def _header_field(cell: str) -> str | None:
    normalised = _normalise_header(cell)
    if not normalised:
        return None
    compact = re.sub(r"[^a-z0-9]+", "", cell.lower())

    exact_matches = [
        field
        for field, aliases in _HEADER_ALIASES.items()
        if normalised in aliases
    ]
    if len(exact_matches) == 1:
        return exact_matches[0]

    padded = f" {normalised} "
    candidates: list[tuple[int, str]] = []
    for field, aliases in _HEADER_ALIASES.items():
        for alias in aliases:
            compact_alias = re.sub(r"[^a-z0-9]+", "", alias)
            if f" {alias} " in padded or compact_alias in compact:
                candidates.append((len(compact_alias), field))
    if not candidates:
        return None

    longest = max(length for length, _field in candidates)
    fields = {field for length, field in candidates if length == longest}
    return next(iter(fields)) if len(fields) == 1 else None


def _transaction_header_map(cells: list[str]) -> dict[str, int] | None:
    recognised: list[tuple[str, int]] = []
    for index, cell in enumerate(cells):
        field = _header_field(cell)
        if field:
            recognised.append((field, index))

    fields = {field for field, _index in recognised}
    financial_fields = fields & (
        _REQUIRED_HEADER_FIELDS | {"nav", "price", "stamp_duty", "taxes", "exit_load"}
    )
    looks_like_header = (
        "date" in fields and len(financial_fields) >= 3
    ) or (
        {"description", "amount"}.issubset(fields) and len(financial_fields) >= 3
    )
    if not looks_like_header:
        return None

    if len(fields) != len(recognised):
        raise UnsupportedLayoutError("The transaction table has ambiguous headers.")

    missing = _REQUIRED_HEADER_FIELDS - fields
    if missing or not ({"nav", "price"} & fields):
        raise UnsupportedLayoutError("The transaction table is missing required headers.")

    return {field: index for field, index in recognised}


def _schema_dialect(header_map: dict[str, int]) -> str | None:
    stamp_index = header_map.get("stamp_duty")
    if stamp_index is None:
        return None
    amount_index = header_map["amount"]
    units_index = header_map["units"]
    if stamp_index > units_index:
        return "cdsl"
    nav_or_price_index = min(
        index for field, index in header_map.items() if field in {"nav", "price"}
    )
    if amount_index < stamp_index < nav_or_price_index:
        return "nsdl"
    return None


def _cell_at(cells: list[str], header_map: dict[str, int], field: str) -> str:
    index = header_map.get(field)
    return cells[index] if index is not None and index < len(cells) else ""


def _looks_like_adjacent_folio_value(value: str) -> bool:
    return bool(
        _FOLIO_VALUE_RE.fullmatch(value)
        and not _ISIN_RE.fullmatch(value.upper())
        and (
            re.search(r"\d", value)
            or "/" in value
            or value.upper() in _FOLIO_SENTINEL_VALUES
        )
        and not _ROW_DATE_RE.fullmatch(value)
    )


def _folio_from_cells(cells: list[str]) -> str | None:
    non_empty = [(index, cell) for index, cell in enumerate(cells) if cell]

    for index, cell in enumerate(cells):
        label_match = _FOLIO_LABEL_RE.search(cell)
        if not label_match:
            continue

        suffix = label_match.group("suffix").strip()
        has_explicit_delimiter = False
        if suffix:
            delimited_match = _FOLIO_DELIMITED_VALUE_RE.match(suffix)
            if not delimited_match:
                if any(candidate for candidate in cells[index + 1:] if candidate):
                    # A multi-column summary header may begin with text such as
                    # "Folio No. / Account No.". It is not a folio-value row.
                    return None
                raise UnsupportedLayoutError(
                    "A folio label is missing an explicit delimiter or value."
                )

            has_explicit_delimiter = True
            value = delimited_match.group("value").strip()
            had_inline_value = bool(value)
            trailing_field = _FOLIO_TRAILING_FIELD_RE.search(value)
            if trailing_field:
                value = value[:trailing_field.start()].strip()
            if (
                value
                and _FOLIO_VALUE_RE.fullmatch(value)
                and not _ISIN_RE.fullmatch(value.upper())
            ):
                return value
            if had_inline_value:
                raise UnsupportedLayoutError(
                    "A folio label is missing an explicit delimiter or value."
                )

        later_values = [
            candidate
            for candidate_index, candidate in non_empty
            if candidate_index > index
        ]
        if has_explicit_delimiter:
            # A retained delimiter is positive evidence that this is a folio
            # value row. Extraction may split the same logical line into
            # folio label, folio value, and one or more trailing field cells.
            # Only the immediate logical neighbour can be the split value;
            # skipping over a field label could capture a later ISIN or number.
            if later_values and _looks_like_adjacent_folio_value(later_values[0]):
                return later_values[0]
        elif (
            len(non_empty) == 2
            and later_values
            and _looks_like_adjacent_folio_value(later_values[0])
        ):
            return later_values[0]

        if has_explicit_delimiter or len(non_empty) == 1:
            raise UnsupportedLayoutError(
                "A folio label is missing an explicit delimiter or value."
            )

        # A bare label beside a non-folio value is a summary/header row, not a
        # malformed folio-value row. Unknown header vocabularies must not abort
        # an otherwise supported statement.
        return None

    return None


def extract_mf_folios(
    pdf: pdfplumber.PDF,
    isin_map: dict[str, tuple[int, str, str]],
    observed_dialects: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Extract mutual fund folio data from a CDSL/NSDL CAS PDF.

    State machine over all tables on all pages:
    - ISIN row (any cell contains INF...) → start/update scheme
    - Folio row (any cell matches Folio No pattern) → record pending folio
    - Closing Balance row → record close_units for current scheme
    - Transaction header row → establish/refresh the financial column map
    - Transaction row (mapped Date cell is a date) → append transaction

    Does NOT require isin_map to be populated — if AMFI fetch failed, schemes
    are still extracted with amfi=None and type='Other'.
    """
    schemes_by_isin: dict[str, dict[str, Any]] = {}
    folio_by_isin: dict[str, str] = {}

    current_isin: str | None = None
    pending_folio: str | None = None
    pending_name: str | None = None
    active_header_map: dict[str, int] | None = None
    active_header_page: int | None = None

    for page_index, page in enumerate(pdf.pages):
        for table in page.extract_tables():
            if not table:
                continue

            # A leading header-only table may define sibling transaction tables
            # on the same PDF page (an observed NSDL extraction shape). A
            # scheme-local header that follows folio/ISIN rows is scoped to its
            # own table. Same-scheme continuations may retain either map across
            # a page break, but a new scheme may only inherit a page-scoped map
            # from the current page.
            table_has_valid_header = False
            table_saw_nonheader_row = False

            for row in table:
                if not row or not any(c for c in row if c):
                    continue

                cells = [str(c or "").strip() for c in row]
                non_empty = [c for c in cells if c]

                header_map = _transaction_header_map(cells)
                if header_map is not None:
                    active_header_map = header_map
                    active_header_page = (
                        page_index if not table_saw_nonheader_row else None
                    )
                    table_has_valid_header = True
                    observed_dialect = _schema_dialect(header_map)
                    if observed_dialect and observed_dialects is not None:
                        observed_dialects.add(observed_dialect)
                    continue

                table_saw_nonheader_row = True

                # ── 1. ISIN row — any cell contains INF[A-Z0-9]{9} ────────────
                isin_in_row: str | None = None
                for cell in cells:
                    found = _extract_isin_from_cell(cell)
                    if found:
                        isin_in_row = found
                        break

                if isin_in_row:
                    if (
                        isin_in_row != current_isin
                        and not table_has_valid_header
                        and active_header_page != page_index
                    ):
                        # Do not reuse a prior table's schema for a new scheme.
                        # Only a leading page-scoped header on this exact page
                        # may cover a sibling table's new scheme.
                        active_header_map = None
                        active_header_page = None
                    current_isin = isin_in_row

                    # Folio may have appeared in the previous row (pending_folio)
                    if pending_folio and current_isin not in folio_by_isin:
                        folio_by_isin[current_isin] = pending_folio

                    # Folio may also be in the same row as the ISIN
                    folio = _folio_from_cells(cells)
                    if folio:
                        folio_by_isin[current_isin] = folio
                        pending_folio = None

                    if current_isin not in schemes_by_isin:
                        amfi_code: int | None = None
                        category = "Other"
                        amfi_name: str | None = None
                        if current_isin in isin_map:
                            entry = isin_map[current_isin]
                            amfi_code, category = entry[0], entry[1]
                            amfi_name = entry[2] if len(entry) > 2 and entry[2] else None

                        schemes_by_isin[current_isin] = {
                            # Prefer AMFI name (authoritative); fall back to
                            # pending_name from adjacent table text
                            "name": amfi_name or pending_name,
                            "isin": current_isin,
                            "type": category,
                            "units": None,
                            "nav": None,
                            "value": None,
                            "additional_info": {
                                "amfi": str(amfi_code) if amfi_code is not None else None,
                                "rta_code": None,
                                "advisor": None,
                                "open_units": None,
                                "close_units": None,
                            },
                            "transactions": [],
                        }
                    pending_name = None
                    continue

                # ── 2. Folio row ───────────────────────────────────────────────
                # Only assign to current_isin if it hasn't been given a folio yet.
                # A new folio row between two ISINs belongs to the NEXT scheme,
                # not the current one — so it must remain pending until the next
                # ISIN row claims it.
                folio = _folio_from_cells(cells)
                if folio:
                    pending_folio = folio
                    if current_isin and current_isin not in folio_by_isin:
                        folio_by_isin[current_isin] = folio

                # ── 3. Closing Balance row → capture close_units ───────────────
                if any(_CLOSING_RE.search(cell) for cell in cells):
                    unit_index = active_header_map.get("units") if active_header_map else None
                    preferred = (
                        _parse_float(cells[unit_index])
                        if unit_index is not None and unit_index < len(cells)
                        else None
                    )
                    if preferred is not None and preferred > 0 and current_isin in schemes_by_isin:
                        s = schemes_by_isin[current_isin]
                        s["units"] = preferred
                        s["additional_info"]["close_units"] = preferred
                        continue
                    for ci in range(2, len(cells)):
                        v = _parse_float(cells[ci])
                        if v is not None and v > 0 and current_isin and current_isin in schemes_by_isin:
                            s = schemes_by_isin[current_isin]
                            s["units"] = v
                            s["additional_info"]["close_units"] = v
                            break
                    continue

                # ── 4. Scheme name candidate (clean single-cell text row) ───────
                # Only used as fallback when AMFI name is unavailable.
                # Reject garbled text (letter-digit-letter patterns like "E0N").
                if (
                    len(non_empty) == 1
                    and len(non_empty[0]) > 15
                    and not _ISIN_RE.search(non_empty[0])
                    and not _FOLIO_LABEL_RE.search(non_empty[0])
                    and not _ROW_DATE_RE.match(non_empty[0])
                    and not _FLOAT_RE.match(non_empty[0].replace(",", ""))
                    and not _GARBLED_RE.search(non_empty[0])
                ):
                    pending_name = non_empty[0]

                # ── 5. Transaction row — active header map is authoritative ──
                date_cells = [cell for cell in cells if _ROW_DATE_RE.match(cell)]
                if not date_cells:
                    continue

                if active_header_map is None:
                    raise UnsupportedLayoutError(
                        "A transaction row appeared before a supported header."
                    )

                date_cell = _cell_at(cells, active_header_map, "date")
                if not _ROW_DATE_RE.match(date_cell):
                    raise UnsupportedLayoutError(
                        "The transaction date does not match the declared header."
                    )

                required_indices = [
                    active_header_map[field] for field in _REQUIRED_HEADER_FIELDS
                ]
                if any(index >= len(cells) for index in required_indices):
                    raise UnsupportedLayoutError(
                        "A transaction row is shorter than its declared header."
                    )
                value_indices = [
                    index
                    for field, index in active_header_map.items()
                    if field in {"nav", "price"}
                ]
                if not any(index < len(cells) for index in value_indices):
                    raise UnsupportedLayoutError(
                        "A transaction row is shorter than its declared header."
                    )

                if current_isin is None:
                    continue

                parsed_date = parse_date_cdsl(date_cell)
                if not re.match(r"^\d{4}-\d{2}-\d{2}$", parsed_date):
                    continue

                desc = _cell_at(cells, active_header_map, "description")
                tx_type = normalise_cdsl_tx_type(desc)
                if tx_type is None:
                    continue

                amount_val = _parse_float(_cell_at(cells, active_header_map, "amount"))
                nav_val = _parse_float(_cell_at(cells, active_header_map, "nav"))
                price_val = _parse_float(_cell_at(cells, active_header_map, "price"))
                units_val = _parse_float(_cell_at(cells, active_header_map, "units"))
                stamp_duty_val = _parse_float(
                    _cell_at(cells, active_header_map, "stamp_duty")
                )
                taxes_val = _parse_float(_cell_at(cells, active_header_map, "taxes"))
                exit_load_val = _parse_float(
                    _cell_at(cells, active_header_map, "exit_load")
                )

                nav_val = nav_val if nav_val is not None else price_val
                price_val = price_val if price_val is not None else nav_val

                if not units_val:
                    continue

                charges = {
                    key: abs(value)
                    for key, value in {
                        "stamp_duty": stamp_duty_val,
                        "taxes": taxes_val,
                        "exit_load": exit_load_val,
                    }.items()
                    if value is not None
                }
                charge_total = sum(charges.values())

                schemes_by_isin[current_isin]["transactions"].append({
                    "date": parsed_date,
                    "type": tx_type,
                    "description": desc or tx_type.title(),
                    "amount": abs(amount_val) if amount_val is not None else 0.0,
                    "source_amount": amount_val if amount_val is not None else 0.0,
                    "gross_amount": (
                        abs(amount_val) + charge_total
                        if amount_val is not None else 0.0
                    ),
                    "units": abs(units_val),
                    "source_units": units_val,
                    "nav": nav_val or 0.0,
                    "price": price_val or 0.0,
                    "stamp_duty": abs(stamp_duty_val or 0.0),
                    "charges": charges,
                    "balance": None,
                })

    if not schemes_by_isin:
        return []

    # Consolidated depository statements include holdings-summary tables before
    # the transaction section. Those ISIN rows are not truncated transaction
    # schemes and must not make the Q1 all-payload preflight reject an otherwise
    # complete detailed statement. Retain them only when the whole document is
    # holdings-only so the caller can still return HoldingsOnlyError.
    transaction_isins = {
        isin
        for isin, scheme in schemes_by_isin.items()
        if scheme["transactions"]
    }
    if transaction_isins:
        schemes_by_isin = {
            isin: scheme
            for isin, scheme in schemes_by_isin.items()
            if isin in transaction_isins
        }

    folio_schemes: dict[str | None, list[dict[str, Any]]] = {}
    for isin, scheme in schemes_by_isin.items():
        fn = folio_by_isin.get(isin)
        folio_schemes.setdefault(fn, []).append(scheme)

    return [
        {"folio_number": fn, "amc": None, "schemes": schemes}
        for fn, schemes in folio_schemes.items()
    ]


# ── Custom exceptions ──────────────────────────────────────────────────────────

class HoldingsOnlyError(ValueError):
    """Raised when the CDSL/NSDL CAS contains no transaction history."""


# ── Public entry point ─────────────────────────────────────────────────────────

def parse_cdsl_nsdl(
    pdf_bytes: bytes,
    password: str,
    diagnostic_text: str | None = None,
) -> dict[str, Any]:
    """Parse a CDSL or NSDL CAS PDF and return a CASParseResult-compatible dict.

    Raises:
        ValueError: If the PDF is not a CDSL/NSDL statement.
        HoldingsOnlyError: If the statement has schemes but no transaction history.
        Exception: If the PDF cannot be decrypted (wrong password).
    """
    try:
        pdf = pdfplumber.open(io.BytesIO(pdf_bytes), password=password)
    except Exception as exc:
        raise Exception(f"Could not open PDF — check your password: {exc}") from exc

    with pdf:
        if diagnostic_text is None:
            diagnostic_text = "\n".join(
                (page.extract_text() or "") for page in pdf.pages[:3]
            )
        diagnostic_issuer = detect_cdsl_nsdl(diagnostic_text)

        isin_map = fetch_amfi_isin_map()
        if not isin_map:
            logger.warning(
                "[cdsl-parser] AMFI map is empty (fetch failed?) — "
                "scheme codes and categories will be unavailable"
            )

        observed_dialects: set[str] = set()
        folios = extract_mf_folios(pdf, isin_map, observed_dialects)

    if len(observed_dialects) > 1:
        raise UnsupportedLayoutError(
            "The statement contains conflicting depository table layouts."
        )

    schema_dialect = next(iter(observed_dialects), None)
    cas_type = schema_dialect or diagnostic_issuer
    if cas_type is None:
        raise ValueError(
            "This PDF does not appear to be a CDSL or NSDL statement. "
            "For CAMS/KFintech/MFCentral PDFs, use the standard upload flow."
        )

    logger.info("[cdsl-parser] detected %s CAS", cas_type.upper())

    total_transactions = sum(
        len(s.get("transactions", []))
        for f in folios
        for s in f.get("schemes", [])
    )

    # Only raise if we found scheme blocks but zero transactions across all of them.
    # A genuinely holdings-only statement has ISINs/folios but no transaction rows.
    if folios and total_transactions == 0:
        raise HoldingsOnlyError(
            "This appears to be a holdings-only statement. Please download a Detailed CAS "
            "from CDSL/NSDL to include your transaction history."
        )

    logger.info(
        "[cdsl-parser] done — folios=%d, transactions=%d",
        len(folios),
        total_transactions,
    )

    return validate_and_canonicalize_cas(
        {"source_dialect": cas_type, "mutual_funds": folios}
    )
