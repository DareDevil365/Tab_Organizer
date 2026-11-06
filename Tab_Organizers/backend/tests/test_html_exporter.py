import json
from app.services.html_exporter import generate_export_html


def test_export_empty_list():
    html = generate_export_html([], export_title="Empty Test")
    assert "<!DOCTYPE html>" in html
    assert "Empty Test" in html
    assert "total-count\">0<" in html
    assert "export-data" in html


def test_export_single_item():
    pages = [
        {
            "url_original": "https://example.com/article",
            "url_normalized": "https://example.com/article",
            "title": "Test Article Title",
            "description": "A very useful article about testing.",
            "favicon_url": "https://example.com/favicon.ico",
            "domain": "example.com",
            "category": "Development",
            "topic": "testing",
            "group_name": "Dev Tabs",
        }
    ]
    html = generate_export_html(pages, export_title="Single Item Collection")
    assert "Single Item Collection" in html
    assert "total-count\">1<" in html
    assert "Test Article Title" in html
    assert "example.com" in html

    # Verify zero external CDN links (offline safety)
    assert "https://cdn." not in html
    assert "https://cdnjs." not in html
    assert "https://unpkg.com" not in html

    # Verify embedded JSON payload is valid
    assert '"title": "Test Article Title"' in html


def test_export_multiple_items_and_domains():
    pages = [
        {"url_original": f"https://domain{i % 3}.com/item/{i}", "domain": f"domain{i % 3}.com", "title": f"Item {i}"}
        for i in range(10)
    ]
    html = generate_export_html(pages, export_title="Multi Item Test")
    assert "total-count\">10<" in html
    assert "domain0.com" in html
    assert "domain1.com" in html
