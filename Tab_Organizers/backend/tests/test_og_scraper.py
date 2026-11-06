from app.services.og_scraper import sanitize_text


def test_sanitize_text_strips_html_and_xss():
    dirty = '<script>alert("xss")</script><b>Hello</b> <a href="http://bad.com">World</a>'
    clean = sanitize_text(dirty)
    assert "<script>" not in clean
    assert "alert" not in clean
    assert "<b>" not in clean
    assert clean == "Hello World"


def test_sanitize_text_handles_empty_and_spaces():
    assert sanitize_text(None) == ""
    assert sanitize_text("   ") == ""
    assert sanitize_text("  Multiple   spaces   here  ") == "Multiple spaces here"
