import re
from urllib.parse import urlparse, urlunparse, parse_qsl, urlencode


TRACKING_PARAMS = {
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'utm_id', 'utm_name', 'utm_cid', 'utm_reader', 'utm_viz_id', 'utm_pubreferrer',
    'fbclid', 'gclid', 'gclsrc', 'dclid', 'zanpid', 'msclkid',
    'si', 'feature', 'ref', 'ref_src', 'ref_url', 'igshid', 'mc_cid', 'mc_eid',
    '_ga', '_gl', '_hsenc', '_hsmi', '__hssc', '__hstc', '__hsfp',
    'mkt_tok', 'wickedid', 'yclid', '_openstat',
    'usp', 'authuser', 'ouid', 'pli', 'resourcekey'
}

AMAZON_DOMAINS = {
    'amazon.com', 'www.amazon.com',
    'amazon.co.uk', 'www.amazon.co.uk',
    'amazon.de', 'www.amazon.de',
    'amazon.fr', 'www.amazon.fr',
    'amazon.es', 'www.amazon.es',
    'amazon.it', 'www.amazon.it',
    'amazon.ca', 'www.amazon.ca',
    'amazon.in', 'www.amazon.in',
    'amazon.co.jp', 'www.amazon.co.jp',
    'amazon.com.au', 'www.amazon.com.au',
    'amazon.com.br', 'www.amazon.com.br',
    'amazon.com.mx', 'www.amazon.com.mx',
}


def normalize_url(url: str) -> str:
    """
    Normalizes a URL to serve as a reliable deduplication key.
    
    Rules:
    1. Lowercase scheme and domain (host).
    2. Remove default ports (80 for http, 443 for https).
    3. Remove trailing slashes (except root '/').
    4. Remove common tracking parameters (UTM, Facebook, Google, social tracking).
    5. Clean meaningless URL fragments ('#', '#/').
    6. Special handling for YouTube:
       - Keep '?v=' for watch URLs.
       - Remove timestamp ('&t=') and playlist context ('&list=', '&index=', '&si=').
       - Convert youtu.be/<id> to youtube.com/watch?v=<id>.
    7. Special handling for Amazon:
       - Extract canonical '/dp/<ASIN>' and drop tracking/referral parameters.
    """
    if not url or not isinstance(url, str):
        return ""
    
    url = url.strip()
    if not url:
        return ""

    try:
        parsed = urlparse(url)
    except Exception:
        return url

    scheme = parsed.scheme.lower()
    if not scheme:
        scheme = "http"
        parsed = urlparse(f"http://{url}")

    netloc = parsed.netloc.lower()
    
    # Remove standard ports
    if ":" in netloc:
        host, port = netloc.split(":", 1)
        if (scheme == "http" and port == "80") or (scheme == "https" and port == "443"):
            netloc = host

    path = parsed.path or "/"
    query = parsed.query
    fragment = parsed.fragment

    # 1. Google Workspace normalization (Docs, Sheets, Slides, Forms, Drive files)
    if netloc == 'docs.google.com':
        if path.startswith('/document/') or re.match(r'^/(?:u/\d+/)?document/', path) or re.match(r'^/(?:u/\d+/)?d/', path):
            doc_match = re.search(r'/d/([a-zA-Z0-9_-]+)', path)
            if doc_match:
                return f"https://docs.google.com/document/d/{doc_match.group(1)}/edit"
        elif path.startswith('/spreadsheets/') or re.match(r'^/(?:u/\d+/)?spreadsheets/', path):
            sheet_match = re.search(r'/d/([a-zA-Z0-9_-]+)', path)
            if sheet_match:
                return f"https://docs.google.com/spreadsheets/d/{sheet_match.group(1)}/edit"
        elif path.startswith('/presentation/') or re.match(r'^/(?:u/\d+/)?presentation/', path):
            pres_match = re.search(r'/d/([a-zA-Z0-9_-]+)', path)
            if pres_match:
                return f"https://docs.google.com/presentation/d/{pres_match.group(1)}/edit"
        elif path.startswith('/forms/') or re.match(r'^/(?:u/\d+/)?forms/', path):
            form_match = re.search(r'/d/([a-zA-Z0-9_-]+)', path)
            if form_match:
                is_edit = '/edit' in path
                action = 'edit' if is_edit else 'viewform'
                return f"https://docs.google.com/forms/d/{form_match.group(1)}/{action}"
    elif netloc == 'drive.google.com':
        file_match = re.search(r'/file/(?:u/\d+/)?d/([a-zA-Z0-9_-]+)', path)
        if file_match:
            return f"https://drive.google.com/file/d/{file_match.group(1)}/view"

    # 2. YouTube normalization
    if netloc in ('youtube.com', 'www.youtube.com', 'm.youtube.com'):
        if path == '/watch':
            query_dict = dict(parse_qsl(query, keep_blank_values=False))
            video_id = query_dict.get('v')
            if video_id:
                # Canonical watch URL
                return f"https://www.youtube.com/watch?v={video_id}"
        elif path.startswith('/shorts/'):
            video_id = path.split('/shorts/')[1].split('/')[0]
            if video_id:
                return f"https://www.youtube.com/watch?v={video_id}"
    elif netloc == 'youtu.be':
        video_id = path.lstrip('/').split('/')[0]
        if video_id:
            return f"https://www.youtube.com/watch?v={video_id}"

    # 3. Amazon normalization
    if netloc in AMAZON_DOMAINS or any(netloc.endswith('.' + d) for d in AMAZON_DOMAINS):
        # Match standard ASIN pattern: 10 alphanumeric characters
        asin_match = re.search(r'/(?:dp|gp/product|exec/obidos/ASIN)/([A-Z0-9]{10})', path, re.IGNORECASE)
        if asin_match:
            asin = asin_match.group(1).upper()
            clean_domain = netloc if netloc.startswith('www.') else f"www.{netloc}"
            return f"https://{clean_domain}/dp/{asin}"

    # 4. Path cleaning: remove trailing slashes unless it's just root '/'
    if len(path) > 1 and path.endswith('/'):
        path = path.rstrip('/')

    # 5. Filter tracking query parameters
    if query:
        filtered_params = []
        for key, val in parse_qsl(query, keep_blank_values=True):
            lower_key = key.lower()
            if lower_key not in TRACKING_PARAMS and not lower_key.startswith('utm_'):
                filtered_params.append((key, val))
        
        # Sort query params for deterministic output
        filtered_params.sort(key=lambda x: x[0])
        query = urlencode(filtered_params)
    else:
        query = ""

    # 6. Fragment cleaning:
    # Strip empty fragments, Chrome text fragments ('~:text='), and in-page anchor fragments.
    # Only preserve hash-based SPA routing (starting with '/' or '!/'), or Gmail ('mail.google.com').
    if fragment in ('', '/', '!', '#') or fragment.startswith('~:text='):
        fragment = ""
    elif netloc == 'mail.google.com':
        pass
    elif fragment.startswith('/') or fragment.startswith('!/'):
        pass
    else:
        fragment = ""

    return urlunparse((scheme, netloc, path, parsed.params, query, fragment))


def extract_domain(url: str) -> str:
    """Extracts a clean domain name from a URL."""
    if not url:
        return "unknown"
    try:
        parsed = urlparse(url if "://" in url else f"http://{url}")
        netloc = parsed.netloc.lower()
        if netloc.startswith("www."):
            netloc = netloc[4:]
        return netloc or "unknown"
    except Exception:
        return "unknown"


def extract_youtube_thumbnail(url: str) -> Optional[str]:
    """Extracts high quality YouTube thumbnail URL if URL is a YouTube video or short."""
    if not url:
        return None
    match = re.search(r'(?:youtube\.com\/(?:watch\?.*v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})', url)
    if match:
        return f"https://i.ytimg.com/vi/{match.group(1)}/hqdefault.jpg"
    return None


