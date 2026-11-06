from app.services.url_normalizer import normalize_url


def test_youtube_normalization():
    # Strips timestamp and tracking, preserves video ID
    raw = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&utm_source=twitter&si=abc123xyz"
    expected = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert normalize_url(raw) == expected

    # Handles youtu.be shortlinks
    short = "https://youtu.be/dQw4w9WgXcQ?t=10"
    assert normalize_url(short) == expected

    # Handles shorts
    shorts = "https://www.youtube.com/shorts/dQw4w9WgXcQ"
    assert normalize_url(shorts) == expected


def test_amazon_normalization():
    # Strips affiliate / tracking parameters, extracts canonical /dp/ASIN
    raw = "https://www.amazon.com/dp/B08N5WRWNW?ref_=ast_sto_dp&th=1&psc=1&tag=affiliate-20"
    expected = "https://www.amazon.com/dp/B08N5WRWNW"
    assert normalize_url(raw) == expected

    # Handles /gp/product/ paths
    gp_raw = "https://www.amazon.co.uk/gp/product/B08N5WRWNW?utm_medium=email"
    assert normalize_url(gp_raw) == "https://www.amazon.co.uk/dp/B08N5WRWNW"


def test_generic_tracking_removal():
    # Strips UTM params, fbclid, gclid, igshid, etc.
    raw = "https://example.com/blog/article/?utm_source=newsletter&utm_medium=email&utm_campaign=summer_sale&fbclid=IwAR123"
    expected = "https://example.com/blog/article"
    assert normalize_url(raw) == expected


def test_case_and_trailing_slash():
    # Lowercases domain, removes trailing slash
    raw = "HTTP://Example.COM:80/docs/guide/"
    expected = "http://example.com/docs/guide"
    assert normalize_url(raw) == expected

    # Root slash preserved
    assert normalize_url("https://example.com/") == "https://example.com/"


def test_fragment_cleaning():
    raw = "https://example.com/page/#"
    assert normalize_url(raw) == "https://example.com/page"

    # In-page anchor fragment is stripped
    anchor = "https://example.com/page#section-1"
    assert normalize_url(anchor) == "https://example.com/page"

    # Chrome text fragment is stripped
    text_frag = "https://example.com/page#:~:text=hello%20world"
    assert normalize_url(text_frag) == "https://example.com/page"

    # SPA hash routing is preserved
    spa = "https://example.com/#/dashboard/metrics"
    assert normalize_url(spa) == "https://example.com/#/dashboard/metrics"

    # Root SPA slash is cleaned (root slash preserved)
    spa_root = "https://example.com/#/"
    assert normalize_url(spa_root) == "https://example.com/"

    # Gmail tag is preserved
    gmail = "https://mail.google.com/mail/u/0/#inbox"
    assert normalize_url(gmail) == "https://mail.google.com/mail/u/0#inbox"


def test_google_workspace_normalization():
    # Exact user case: doc with tab and heading vs doc with tab
    user_url_with_heading = "https://docs.google.com/document/d/exampleFixtureId01/edit?tab=t.0#heading=h.hodj8if4prow"
    user_url_plain_tab = "https://docs.google.com/document/d/exampleFixtureId01/edit?tab=t.0"
    user_url_plain = "https://docs.google.com/document/d/exampleFixtureId01/edit"
    user_url_user_account = "https://docs.google.com/document/u/0/d/exampleFixtureId01/edit?usp=sharing"

    canonical_doc = "https://docs.google.com/document/d/exampleFixtureId01/edit"

    assert normalize_url(user_url_with_heading) == canonical_doc
    assert normalize_url(user_url_plain_tab) == canonical_doc
    assert normalize_url(user_url_plain) == canonical_doc
    assert normalize_url(user_url_user_account) == canonical_doc

    # Sheets
    sheet_url = "https://docs.google.com/spreadsheets/d/exampleFixtureId02/edit?gid=0#gid=0"
    assert normalize_url(sheet_url) == "https://docs.google.com/spreadsheets/d/exampleFixtureId02/edit"

    # Slides
    slide_url = "https://docs.google.com/presentation/d/exampleFixtureId03/edit#slide=id.p"
    assert normalize_url(slide_url) == "https://docs.google.com/presentation/d/exampleFixtureId03/edit"

    # Drive file
    drive_file = "https://drive.google.com/file/d/exampleFixtureId03/view?usp=sharing"
    assert normalize_url(drive_file) == "https://drive.google.com/file/d/exampleFixtureId03/view"

