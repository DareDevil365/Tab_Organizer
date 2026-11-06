import json
from app.services.ai_provider import parse_classification_json
from app.services.classifier import load_taxonomy, save_taxonomy, DEFAULT_TAXONOMY


def test_parse_valid_classification_json():
    items = [{"id": 1, "title": "Python Docs"}, {"id": 2, "title": "Design System"}]
    taxonomy = ["programming", "design", "other"]
    raw = json.dumps([{"id": 1, "topic": "programming"}, {"id": 2, "topic": "design"}])

    results = parse_classification_json(raw, items, taxonomy)
    assert len(results) == 2
    assert results[0] == {"id": 1, "topic": "programming"}
    assert results[1] == {"id": 2, "topic": "design"}


def test_parse_markdown_wrapped_json():
    items = [{"id": 10, "title": "Math Article"}]
    taxonomy = ["math_science", "other"]
    raw = "```json\n[{\"id\": 10, \"topic\": \"math_science\"}]\n```"

    results = parse_classification_json(raw, items, taxonomy)
    assert len(results) == 1
    assert results[0] == {"id": 10, "topic": "math_science"}


def test_parse_malformed_json_graceful_fallback():
    items = [{"id": 5, "title": "Unparseable"}]
    taxonomy = ["programming", "other"]
    raw = "Here is your classification: {id: 5, topic: broken json string..."

    results = parse_classification_json(raw, items, taxonomy)
    assert len(results) == 1
    assert results[0] == {"id": 5, "topic": "other"}


def test_parse_unrecognized_topic_fallback():
    items = [{"id": 7, "title": "Unknown Topic Item"}]
    taxonomy = ["programming", "design", "other"]
    raw = json.dumps([{"id": 7, "topic": "some_random_invented_topic"}])

    results = parse_classification_json(raw, items, taxonomy)
    assert len(results) == 1
    assert results[0] == {"id": 7, "topic": "other"}


def test_taxonomy_loading_and_saving(tmp_path, monkeypatch):
    import app.services.classifier as c_module
    test_rules_file = tmp_path / "taxonomy_rules.json"
    test_file = tmp_path / "taxonomy.json"
    monkeypatch.setattr(c_module, "TAXONOMY_RULES_FILE", test_rules_file)
    monkeypatch.setattr(c_module, "TAXONOMY_FILE", test_file)
    monkeypatch.setattr(c_module, "DATA_DIR", tmp_path)
    monkeypatch.setattr(c_module, "_get_rules_file", lambda: test_rules_file)
    monkeypatch.setattr(c_module, "_get_taxonomy_file", lambda: test_file)

    custom = ["ai", "crypto", "robotics"]
    save_taxonomy(custom)

    loaded = load_taxonomy()
    assert "ai" in loaded
    assert "crypto" in loaded
    assert "other" in loaded  # Ensures 'other' is always preserved


def test_classify_by_rules_direct():
    from app.services.classifier import classify_single_page_rule

    # 1. AI & Machine Learning
    res_ai = classify_single_page_rule({
        "title": "Introduction to Large Language Models and Deep Learning",
        "url": "https://arxiv.org/abs/2301.00001",
        "domain": "arxiv.org"
    })
    assert res_ai == "Artificial Intelligence"

    # 2. Programming
    res_prog = classify_single_page_rule({
        "title": "FastAPI Repo - Async Python Web Framework",
        "url": "https://github.com/tiangolo/fastapi",
        "domain": "github.com"
    })
    assert res_prog == "Programming"

    # 3. Hardware & Tech (with plural matching)
    res_hw = classify_single_page_rule({
        "title": "New Semiconductor Devices and Electronic Circuits",
        "url": "https://anandtech.com/show/123",
        "domain": "anandtech.com"
    })
    assert res_hw == "Hardware & Tech"

    # 4. Academics & Science
    res_sci = classify_single_page_rule({
        "title": "Signals and Systems: Fourier Transforms and Linear Algebra",
        "url": "https://mit.edu/courses/signals-systems",
        "domain": "mit.edu"
    })
    assert res_sci == "Academics & Science"

    # 5. Finance & Business
    res_fin = classify_single_page_rule({
        "title": "S&P 500 Stock Market Analysis and Crypto Portfolio",
        "url": "https://bloomberg.com/markets",
        "domain": "bloomberg.com"
    })
    assert res_fin == "Finance & Business"


def test_suggest_page_tags_extraction():
    from app.services.classifier import suggest_page_tags

    tags = suggest_page_tags({
        "title": "Building Neural Networks in Python and PyTorch",
        "url": "https://github.com/example/repo",
        "domain": "github.com"
    })
    assert len(tags) > 0
    # Should find keywords like 'neural network' or 'python' or 'pytorch'
    lower_tags = [t.lower() for t in tags]
    assert any(k in lower_tags for k in ["neural network", "python", "pytorch", "github"])


def test_parse_classification_json_with_slug_and_alias_mapping():
    items = [
        {"id": 1, "title": "Transformer Tutorial"},
        {"id": 2, "title": "React Component Patterns"},
        {"id": 3, "title": "CPU Overclocking Guide"}
    ]
    taxonomy = ["Artificial Intelligence", "Programming", "Hardware & Tech", "other"]
    
    # Simulate LLM returning slugged/shortened names
    raw = json.dumps([
        {"id": 1, "topic": "ai"},
        {"id": 2, "topic": "programming"},
        {"id": 3, "topic": "hardware"}
    ])

    results = parse_classification_json(raw, items, taxonomy)
    assert len(results) == 3
    assert results[0]["topic"] == "Artificial Intelligence"
    assert results[1]["topic"] == "Programming"
    assert results[2]["topic"] == "Hardware & Tech"


def test_reset_taxonomy_rules(tmp_path, monkeypatch):
    import app.services.classifier as c_module
    test_rules_file = tmp_path / "taxonomy_rules.json"
    monkeypatch.setattr(c_module, "TAXONOMY_RULES_FILE", test_rules_file)
    monkeypatch.setattr(c_module, "DATA_DIR", tmp_path)
    monkeypatch.setattr(c_module, "_get_rules_file", lambda: test_rules_file)

    rules = c_module.reset_taxonomy_rules_to_default()
    assert len(rules) >= 13
    names = [r["name"] for r in rules]
    assert "Artificial Intelligence" in names
    assert "Programming" in names
    assert "Academics & Science" in names
    assert test_rules_file.exists()

