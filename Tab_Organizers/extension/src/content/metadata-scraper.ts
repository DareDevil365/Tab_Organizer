/**
 * Content script to extract OpenGraph, Twitter, and standard metadata from the current page.
 * Executed on-demand when user exports or saves tabs.
 */

export interface ScrapedPageMetadata {
  url_original: string;
  title: string;
  description: string;
  favicon_url: string;
  og_image_url: string;
  og_image_data?: string;
  domain: string;
}

export function extractPageMetadata(): ScrapedPageMetadata {
  const url = window.location.href;
  const domain = window.location.hostname;

  // 1. Title extraction
  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
  const twitterTitle = document.querySelector('meta[name="twitter:title"]')?.getAttribute('content');
  const docTitle = document.title;
  const title = (ogTitle || twitterTitle || docTitle || domain).trim();

  // 2. Description extraction
  const ogDesc = document.querySelector('meta[property="og:description"]')?.getAttribute('content');
  const twitterDesc = document.querySelector('meta[name="twitter:description"]')?.getAttribute('content');
  const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content');
  const description = (ogDesc || twitterDesc || metaDesc || '').trim();

  // 3. Image extraction (og:image -> twitter:image -> first content image)
  let ogImageUrl = document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
                   document.querySelector('meta[name="twitter:image"]')?.getAttribute('content') || '';

  if (ogImageUrl && !ogImageUrl.startsWith('http://') && !ogImageUrl.startsWith('https://') && !ogImageUrl.startsWith('data:')) {
    try {
      ogImageUrl = new URL(ogImageUrl, window.location.href).href;
    } catch {
      // ignore
    }
  }

  // Fallback: look for large image in page if no og:image found
  if (!ogImageUrl) {
    const images = Array.from(document.querySelectorAll('img'));
    for (const img of images) {
      if (img.naturalWidth > 200 && img.naturalHeight > 120 && img.src && img.src.startsWith('http')) {
        ogImageUrl = img.src;
        break;
      }
    }
  }

  // 4. Favicon extraction
  let faviconUrl = document.querySelector('link[rel~="icon"]')?.getAttribute('href') ||
                   document.querySelector('link[rel="shortcut icon"]')?.getAttribute('href') || '';
  if (faviconUrl && !faviconUrl.startsWith('http://') && !faviconUrl.startsWith('https://') && !faviconUrl.startsWith('data:')) {
    try {
      faviconUrl = new URL(faviconUrl, window.location.href).href;
    } catch {
      // ignore
    }
  }
  if (!faviconUrl) {
    faviconUrl = `${window.location.protocol}//${window.location.host}/favicon.ico`;
  }

  return {
    url_original: url,
    title,
    description,
    favicon_url: faviconUrl,
    og_image_url: ogImageUrl,
    domain,
  };
}

// When injected as a direct script via chrome.scripting.executeScript, return the result
extractPageMetadata();
