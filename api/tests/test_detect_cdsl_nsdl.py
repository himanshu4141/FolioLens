from api._cdsl_nsdl_parser import detect_cdsl_nsdl, looks_like_depository_cas


def test_detects_cdsl_english():
    text = "Central Depository Services (India) Limited\nCDSL Consolidated Account Statement\nPeriod: 01-Apr-2024 to 31-Mar-2025"
    assert detect_cdsl_nsdl(text) == "cdsl"


def test_detects_nsdl_english():
    text = "National Securities Depository Limited\nNSDL Consolidated Account Statement\nINF123456789"
    assert detect_cdsl_nsdl(text) == "nsdl"


def test_detects_cdsl_with_hindi_text():
    # CDSL acronym present even in bilingual PDF
    text = "खाते का प्रकार\nCDSL\nINF456789012\n01-अप्रैल-2024"
    assert detect_cdsl_nsdl(text) == "cdsl"


def test_detects_nsdl_with_hindi_text():
    text = "राष्ट्रीय प्रतिभूति निक्षेपागार\nNSDL\nINF123456789"
    assert detect_cdsl_nsdl(text) == "nsdl"


def test_returns_none_for_cams():
    text = "Computer Age Management Services Limited\nCAMS Mutual Fund CAS\nINF123456789"
    assert detect_cdsl_nsdl(text) is None


def test_returns_none_for_kfintech():
    text = "KFin Technologies Limited\nMutual Fund Account Statement\nINF789012345"
    assert detect_cdsl_nsdl(text) is None


def test_empty_text():
    assert detect_cdsl_nsdl("") is None


def test_preserves_full_three_page_detection_window_after_long_cover_text():
    prefix = "x" * 12001
    text = prefix + "\nNSDL Consolidated Account Statement"
    assert detect_cdsl_nsdl(text) == "nsdl"
    assert looks_like_depository_cas(text) is True


def test_mixed_acronyms_are_ambiguous_but_still_route_to_depository_parser():
    text = "NSDL participant details\nCDSL Consolidated Account Statement"
    assert detect_cdsl_nsdl(text) is None
    assert looks_like_depository_cas(text) is True


def test_full_issuer_name_wins_over_other_incidental_acronym():
    text = "Central Depository Services (India) Limited\nNSDL participant reference"
    assert detect_cdsl_nsdl(text) == "cdsl"
