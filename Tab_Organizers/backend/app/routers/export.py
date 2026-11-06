import datetime
from urllib.parse import urlparse
from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_db
from app.models.page import Page
from app.schemas.export import ExportRequest, ExportResponse
from app.services.url_normalizer import normalize_url, extract_youtube_thumbnail
from app.services.html_exporter import generate_export_html

router = APIRouter(prefix="/api/export", tags=["export"])


@router.post("", response_model=ExportResponse)
async def export_tabs(request: ExportRequest, db: AsyncSession = Depends(get_db)):
    """
    Accepts tab data from the extension, normalizes and upserts records into the SQLite database,
    and returns a rendered self-contained HTML file.
    """
    if not request.tabs:
        raise HTTPException(status_code=400, detail="No tabs provided for export")

    processed_pages = []

    for tab in request.tabs:
        norm_url = tab.url_normalized or normalize_url(tab.url_original)
        domain = tab.domain
        if not domain and tab.url_original:
            domain = urlparse(tab.url_original).netloc

        og_img = tab.og_image_url or extract_youtube_thumbnail(tab.url_original) or ""
        fav_icon = tab.favicon_url or (f"https://www.google.com/s2/favicons?domain={domain}&sz=64" if domain else "")

        # Persist to Page database only if requested
        if request.save_to_library:
            now = datetime.datetime.now(datetime.timezone.utc)
            stmt = select(Page).where(Page.url_normalized == norm_url)
            res = await db.execute(stmt)
            existing_page = res.scalar_one_or_none()

            if existing_page:
                if tab.title:
                    existing_page.title = tab.title
                if tab.description:
                    existing_page.description = tab.description
                if fav_icon:
                    existing_page.favicon_url = fav_icon
                if tab.category:
                    existing_page.category = tab.category
                existing_page.last_seen_open_at = now
                existing_page.updated_at = now
            else:
                page_record = Page(
                    url_original=tab.url_original,
                    url_normalized=norm_url,
                    title=tab.title or domain or "Untitled Page",
                    description=tab.description,
                    favicon_url=fav_icon,
                    domain=domain,
                    category=tab.category,
                    topic=tab.topic,
                    created_at=now,
                    updated_at=now,
                    last_seen_open_at=now,
                )
                db.add(page_record)

        processed_pages.append({
            "url_original": tab.url_original,
            "url_normalized": norm_url,
            "title": tab.title or domain or "Untitled Page",
            "description": tab.description or "",
            "favicon_url": fav_icon,
            "og_image_url": og_img,
            "og_image_data": tab.og_image_data or "",
            "domain": domain or "",
            "category": tab.category or "",
            "topic": tab.topic or "",
            "group_name": tab.group_name or "",
            "group_color": tab.group_color or "",
        })

    if request.save_to_library:
        await db.commit()

    # Generate standalone HTML file
    html_content = generate_export_html(processed_pages, export_title=request.title)

    return ExportResponse(
        html_content=html_content,
        item_count=len(processed_pages),
        title=request.title or "Saved Tab Collection"
    )


@router.post("/download")
async def download_export_html(request: ExportRequest, db: AsyncSession = Depends(get_db)):
    """Directly returns the exported HTML as a downloadable file attachment."""
    result = await export_tabs(request, db)
    filename = f"tabs_export_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.html"
    return Response(
        content=result.html_content,
        media_type="text/html",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )
