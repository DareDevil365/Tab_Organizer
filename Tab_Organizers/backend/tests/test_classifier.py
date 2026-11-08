import json
import pytest
from app.services.ai_provider import parse_classification_json
from app.services.classifier import load_taxonomy, save_taxonomy, DEFAULT_TAXONOMY


@pytest.mark.parametrize('phrase', ['GAME CHANGER', 'game-changer', 'game changing', 'changes the game'])
def test_figurative_game_phrases_do_not_turn_cad_updates_into_gaming(phrase):
    from app.services.classifier import classify_by_rules
    rules=[{'name':'Gaming','keywords':['game','gaming','gameplay']},
           {'name':'Computer Aided Design','keywords':['freecad','cad']}]
    item={'title':f'FreeCAD 1.1 is finally here — a {phrase}',
          'url':f'https://example.org/freecad/{phrase.replace(" ","-")}',
          'description':f'A {phrase} for CAD users'}
    assert classify_by_rules(item,rules)=='Computer Aided Design'
    assert classify_by_rules(item,rules[:1]) is None


def test_real_gaming_evidence_survives_a_game_changer_phrase():
    from app.services.classifier import classify_by_rules
    rules=[{'name':'Gaming','keywords':['game','gameplay','minecraft']}]
    assert classify_by_rules({'title':'Minecraft gameplay: a GAME CHANGER update'},rules)=='Gaming'
    assert classify_by_rules({'title':'How I built my first game'},rules) is None
    assert classify_by_rules({'title':'Video game design fundamentals'},rules) is None


def test_suggested_tags_and_content_projection_do_not_reintroduce_a_false_gaming_label(monkeypatch):
    from app.services import classifier
    from app.services.content_subjects import library_subjects
    rules=[{'name':'Gaming','keywords':['game','gaming','gameplay']},
           {'name':'Computer Aided Design','keywords':['freecad']}]
    monkeypatch.setattr(classifier,'load_taxonomy_rules',lambda:rules)
    page={'title':'FreeCAD 1.1: a GAME CHANGER for 3D modeling','topic':'Gaming'}
    assert classifier.suggest_page_tags(page)==['freecad']
    assert 'Gaming' not in library_subjects(page)
    assert 'CAD & 3D Design' in library_subjects(page)


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



@pytest.mark.parametrize('title', ['Steam turbine efficiency', 'Python snake feeding', 'Stock photo editing', 'Apple pie recipe'])
def test_isolated_ambiguous_words_require_contextual_classification(title):
    from app.services.classifier import classify_by_rules
    rules=[{'name':'Gaming','keywords':['steam','game']},
           {'name':'Programming','keywords':['python','apple']},
           {'name':'Finance','keywords':['stock']}]
    assert classify_by_rules({'title':title,'url':'https://gaming.example/python/stock','tags':'game, python, stock'},rules) is None


@pytest.mark.asyncio
async def test_contextual_ai_sees_every_item_and_cannot_be_bypassed_by_keyword_matches(monkeypatch):
    from app.services import classifier
    captured=[]
    class Provider:
        async def classify_batch(self,items,taxonomy):
            captured.extend(items)
            return [{'id':1,'topic':'Engineering'},{'id':2,'topic':'Cooking'},{'id':999,'topic':'Gaming'}]
    async def provider():return Provider()
    monkeypatch.setattr(classifier,'get_ai_provider',provider)
    monkeypatch.setattr(classifier,'load_taxonomy_rules',lambda:[{'name':'Gaming','keywords':['steam','gameplay']}])
    items=[{'id':1,'title':'Steam turbine gameplay: an engineering simulator','description':'Mechanical engineering',
            'url':'https://private.example','domain':'private.example','topic':'Gaming','tags':'Gaming','notes':'Finance'},
           {'id':2,'title':'Apple pie recipe','description':'Baking pastries'}]
    result=await classifier.classify_pages_batch_with_fallback(items,['Gaming','Engineering','Cooking','other'])
    assert result==[{'id':1,'topic':'Engineering'},{'id':2,'topic':'Cooking'}]
    assert len(captured)==2
    assert all(set(item)=={'id','title','description'} for item in captured)
    assert 'private.example' not in str(captured) and 'Finance' not in str(captured)


@pytest.mark.asyncio
async def test_partial_ai_failure_keeps_all_records_and_abstains_on_weak_evidence(monkeypatch):
    from app.services import classifier
    class Provider:
        async def classify_batch(self,*args):return [{'id':1,'topic':'other'}]
    async def provider():return Provider()
    rules=[{'name':'Gaming','keywords':['minecraft','gameplay','steam']}]
    monkeypatch.setattr(classifier,'get_ai_provider',provider)
    monkeypatch.setattr(classifier,'load_taxonomy_rules',lambda:rules)
    items=[{'id':1,'title':'Minecraft gameplay'},{'id':2,'title':'Steam turbine efficiency'},
           {'id':3,'title':'Minecraft gameplay'}]
    assert await classifier.classify_pages_batch_with_fallback(items,['Gaming','other'])==[
        {'id':1,'topic':'other'},{'id':2,'topic':'other'},{'id':3,'topic':'Gaming'}]
    async def offline():raise RuntimeError('unavailable')
    monkeypatch.setattr(classifier,'get_ai_provider',offline)
    result=await classifier.classify_pages_batch_with_fallback(items,['Gaming','other'])
    assert [row['id'] for row in result]==[1,2,3]
    assert result[1]['topic']=='other'
