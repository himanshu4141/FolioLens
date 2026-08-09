"""CDSL / NSDL CAS PDF parser.

Produces the same { "mutual_funds": [...] } shape as normalize_casparser_result()
so importCASData() in the TypeScript edge function needs zero changes.

Key design decisions:
- ISINs (INF[A-Z0-9]{9}) are always ASCII regardless of PDF language — used as
  the primary anchor for every scheme block.
- pdfplumber's position-based table extraction is language-agnostic; column
  values (amounts, units, NAV) are always ASCII numerals.
- "CDSL" and "NSDL" are acronyms that always appear as ASCII — used for detection.
- Dates and transaction descriptions may appear in Hindi (Devanagari) — handled
  via explicit mapping tables with re.UNICODE patterns.

Real CDSL CAS table structure (per scheme):
  Row: [Folio No : <folio> Mode of Holding : Single ...]   ← single merged cell
  Row: [ISIN : INF... UCC : ... Mobile : ... Email : ...]  ← single merged cell
  Row: [Hindi/English column headers]                       ← skipped
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
    ("equity", "Equity"),
    ("debt", "Debt"),
    ("hybrid", "Hybrid"),
    ("solution", "Hybrid"),
    ("other", "Other"),
    ("fund of fund", "Other"),
    ("index fund", "Equity"),
    ("etf", "Equity"),
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
    """Return 'cdsl', 'nsdl', or None.

    Checks first ~3000 chars for the ASCII acronyms CDSL / NSDL.
    Language-agnostic: the acronyms are always ASCII regardless of PDF language.
    """
    snippet = raw_text[:3000]
    if "CDSL" in snippet:
        return "cdsl"
    if "NSDL" in snippet:
        return "nsdl"
    return None


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

# Matches "Folio No : 28056620/47" — try "folio no" before just "folio" so
# regex engine doesn't stop at "folio" and capture "No" as the folio number.
_FOLIO_RE = re.compile(
    r"folio(?:\s+no\.?)?\s*[:\s]+([A-Z0-9][A-Z0-9/\-]*)",
    re.IGNORECASE,
)

_CLOSING_RE = re.compile(
    r"closing\s+balance|अंतिम\s+शेष|बंद\s+शेष",
    re.IGNORECASE | re.UNICODE,
)


def extract_mf_folios(
    pdf: pdfplumber.PDF,
    isin_map: dict[str, tuple[int, str, str]],
) -> list[dict[str, Any]]:
    """Extract mutual fund folio data from a CDSL/NSDL CAS PDF.

    State machine over all tables on all pages:
    - ISIN row (any cell contains INF...) → start/update scheme
    - Folio row (any cell matches Folio No pattern) → record pending folio
    - Closing Balance row → record close_units for current scheme
    - Transaction row (col 0 is a date) → append transaction

    Does NOT require isin_map to be populated — if AMFI fetch failed, schemes
    are still extracted with amfi=None and type='Other'.
    """
    schemes_by_isin: dict[str, dict[str, Any]] = {}
    folio_by_isin: dict[str, str] = {}

    current_isin: str | None = None
    pending_folio: str | None = None
    pending_name: str | None = None

    for page in pdf.pages:
        for table in page.extract_tables():
            if not table:
                continue

            for row in table:
                if not row or not any(c for c in row if c):
                    continue

                cells = [str(c or "").strip() for c in row]

                # ── 1. ISIN row — any cell contains INF[A-Z0-9]{9} ────────────
                isin_in_row: str | None = None
                for cell in cells:
                    found = _extract_isin_from_cell(cell)
                    if found:
                        isin_in_row = found
                        break

                if isin_in_row:
                    current_isin = isin_in_row

                    # Folio may have appeared in the previous row (pending_folio)
                    if pending_folio and current_isin not in folio_by_isin:
                        folio_by_isin[current_isin] = pending_folio

                    # Folio may also be in the same row as the ISIN
                    for cell in cells:
                        fm = _FOLIO_RE.search(cell)
                        if fm:
                            folio_by_isin[current_isin] = fm.group(1)
                            pending_folio = None
                            break

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
                for cell in cells:
                    fm = _FOLIO_RE.search(cell)
                    if fm:
                        pending_folio = fm.group(1)
                        if current_isin and current_isin not in folio_by_isin:
                            folio_by_isin[current_isin] = fm.group(1)
                        break

                # ── 3. Closing Balance row → capture close_units ───────────────
                second_cell = cells[1] if len(cells) > 1 else ""
                if _CLOSING_RE.search(second_cell):
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
                non_empty = [c for c in cells if c]
                if (
                    len(non_empty) == 1
                    and len(non_empty[0]) > 15
                    and not _ISIN_RE.search(non_empty[0])
                    and not _FOLIO_RE.search(non_empty[0])
                    and not _ROW_DATE_RE.match(non_empty[0])
                    and not _FLOAT_RE.match(non_empty[0].replace(",", ""))
                    and not _GARBLED_RE.search(non_empty[0])
                ):
                    pending_name = non_empty[0]

                # ── 5. Transaction row — col 0 is a date ──────────────────────
                first_cell = cells[0]
                if not first_cell or not _ROW_DATE_RE.match(first_cell):
                    continue

                if current_isin is None:
                    continue

                parsed_date = parse_date_cdsl(first_cell)
                if not re.match(r"^\d{4}-\d{2}-\d{2}$", parsed_date):
                    continue

                # Col 1: description
                desc = cells[1] if len(cells) > 1 else ""
                tx_type = normalise_cdsl_tx_type(desc)
                if tx_type is None:
                    continue

                # Cols 2+ (numeric): amount[0], nav[1], price[2], units[3], stamp[4]...
                # Preserve None for empty/dash cells so index positions stay aligned.
                nums: list[float | None] = []
                for c in cells[2:]:
                    nums.append(_parse_float(c))

                amount_val = nums[0] if len(nums) > 0 else None
                nav_val = nums[1] if len(nums) > 1 else None
                price_val = nums[2] if len(nums) > 2 else nav_val
                units_val = nums[3] if len(nums) > 3 else (nums[2] if len(nums) > 2 else None)
                stamp_duty_val = nums[4] if len(nums) > 4 else None

                if not units_val:
                    continue

                schemes_by_isin[current_isin]["transactions"].append({
                    "date": parsed_date,
                    "type": tx_type,
                    "description": desc or tx_type.title(),
                    "amount": abs(amount_val) if amount_val is not None else 0.0,
                    "source_amount": amount_val if amount_val is not None else 0.0,
                    "gross_amount": (
                        abs(amount_val) + abs(stamp_duty_val or 0.0)
                        if amount_val is not None else 0.0
                    ),
                    "units": abs(units_val),
                    "source_units": units_val,
                    "nav": nav_val or 0.0,
                    "price": price_val or 0.0,
                    "stamp_duty": abs(stamp_duty_val or 0.0),
                    "charges": {"stamp_duty": abs(stamp_duty_val or 0.0)},
                    "balance": None,
                })

    if not schemes_by_isin:
        return []

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

def parse_cdsl_nsdl(pdf_bytes: bytes, password: str) -> dict[str, Any]:
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
        first_page_text = pdf.pages[0].extract_text() or "" if pdf.pages else ""
        cas_type = detect_cdsl_nsdl(first_page_text)
        if cas_type is None:
            raise ValueError(
                "This PDF does not appear to be a CDSL or NSDL statement. "
                "For CAMS/KFintech/MFCentral PDFs, use the standard upload flow."
            )

        logger.info("[cdsl-parser] detected %s CAS", cas_type.upper())

        isin_map = fetch_amfi_isin_map()
        if not isin_map:
            logger.warning(
                "[cdsl-parser] AMFI map is empty (fetch failed?) — "
                "scheme codes and categories will be unavailable"
            )

        folios = extract_mf_folios(pdf, isin_map)

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
