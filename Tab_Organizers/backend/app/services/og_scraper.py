import base64
import logging
from urllib.parse import urljoin, urlparse
from typing import Optional, Dict, Any, Tuple
import httpx
from bs4 import BeautifulSoup
import bleach

logger = logging.getLogger(__name__)

# Allowed HTML tags/attributes if we ever sanitize formatted snippets
ALLOWED_TAGS = ['b', 'i', 'u', 'em', 'strong', 'a', 'p', 'span']
ALLOWED_ATTRIBUTES = {'a': ['href', 'title', 'target']}


def sanitize_text(text: Optional[str]) -> str:
    """Sanitizes text by stripping dangerous HTML/scripts and removing script/style contents."""
    if not text:
        return ""
    
    # Parse with BeautifulSoup to decompose script, style, and iframe tags entirely
    soup = BeautifulSoup(text, "html.parser")
    for tag in soup(["script", "style", "iframe", "noscript"]):
        tag.decompose()
    
    raw_text = soup.get_text()
    cleaned = bleach.clean(raw_text.strip(), tags=[], strip=True)
    return " ".join(cleaned.split())


async def fetch_image_as_base64(client: httpx.AsyncClient, image_url: str) -> Tuple[Optional[str], Optional[str]]:
    """
    Downloads an image and converts it into a base64 data URI string and MIME type.
    This guarantees thumbnails remain cached and available offline.
    """
    if not image_url or not image_url.startswith(('http://', 'https://')):
        return None, None

    try:
        resp = await client.get(
            image_url,
            timeout=5.0,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        )
        if resp.status_code == 200:
            content_type = resp.headers.get("content-type", "image/jpeg").split(";")[0].strip()
            if not content_type.startswith("image/"):
                content_type = "image/jpeg"
            b64_data = base64.b64encode(resp.content).decode("utf-8")
            data_uri = f"data:{content_type};base64,{b64_data}"
            return data_uri, content_type
    except Exception as e:
        logger.debug(f"Failed to fetch image {image_url}: {e}")
    
    return None, None


async def scrape_opengraph_metadata(url: str, fetch_images: bool = True) -> Dict[str, Any]:
    """
    Server-side fallback scraper for OpenGraph metadata.
    Extracts: title, description, og:image, favicon, and canonical domain.
    """
    result: Dict[str, Any] = {
        "url_original": url,
        "title": None,
        "description": None,
        "favicon_url": None,
        "og_image_url": None,
        "og_image_data": None,
        "og_image_mime": None,
        "domain": None,
    }

    parsed = urlparse(url)
    result["domain"] = parsed.netloc

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
    }

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=8.0) as client:
            resp = await client.get(url, headers=headers)
            if resp.status_code >= 400:
                result["title"] = parsed.netloc
                return result

            html = resp.text
            soup = BeautifulSoup(html, "html.parser")

            # 1. Title extraction (og:title -> twitter:title -> <title>)
            og_title = (
                soup.find("meta", property="og:title")
                or soup.find("meta", attrs={"name": "twitter:title"})
            )
            if og_title and og_title.get("content"):
                result["title"] = sanitize_text(og_title["content"])
            elif soup.title and soup.title.string:
                result["title"] = sanitize_text(soup.title.string)
            else:
                result["title"] = parsed.netloc

            # 2. Description extraction (og:description -> meta description)
            og_desc = (
                soup.find("meta", property="og:description")
                or soup.find("meta", attrs={"name": "twitter:description"})
                or soup.find("meta", attrs={"name": "description"})
            )
            if og_desc and og_desc.get("content"):
                result["description"] = sanitize_text(og_desc["content"])

            # 3. Image extraction (og:image -> twitter:image -> first content img)
            og_image = (
                soup.find("meta", property="og:image")
                or soup.find("meta", attrs={"name": "twitter:image"})
            )
            if og_image and og_image.get("content"):
                img_url = urljoin(url, og_image["content"])
                result["og_image_url"] = img_url
            else:
                # Fallback: find first image in body
                first_img = soup.find("img")
                if first_img and first_img.get("src"):
                    result["og_image_url"] = urljoin(url, first_img["src"])

            # 4. Favicon extraction
            icon_tag = (
                soup.find("link", rel=lambda x: x and "icon" in x.lower())
                or soup.find("link", rel="shortcut icon")
            )
            if icon_tag and icon_tag.get("href"):
                result["favicon_url"] = urljoin(url, icon_tag["href"])
            else:
                result["favicon_url"] = f"{parsed.scheme}://{parsed.netloc}/favicon.ico"

            # 5. Optionally fetch image as base64 for offline export
            if fetch_images and result["og_image_url"]:
                data_uri, mime = await fetch_image_as_base64(client, result["og_image_url"])
                result["og_image_data"] = data_uri
                result["og_image_mime"] = mime

    except Exception as e:
        logger.debug(f"Error scraping {url}: {e}")
        if not result["title"]:
            result["title"] = parsed.netloc

    return result
