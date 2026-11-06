const GENERIC_SITE_ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#aaa3b7" stroke-width="1.4"><circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="3.5" ry="8.5"/><path d="M3.5 12h17M5 7.5h14M5 16.5h14"/></svg>');

export function siteIconSources(url: string, favicon?: string): string[] {
  const candidates: string[] = [];
  if (favicon && /^(https?:\/\/|data:image\/|chrome(?:-extension)?:\/\/)/i.test(favicon)) candidates.push(favicon);
  try {
    const parsed = new URL(url);
    if (/^https?:$/.test(parsed.protocol)) candidates.push(`${parsed.origin}/favicon.ico`);
  } catch { /* Browser/internal pages use the neutral fallback. */ }
  return [...new Set([...candidates, GENERIC_SITE_ICON])];
}

export function createSiteIcon(url: string, favicon?: string, className = 'tab-favicon'): HTMLImageElement {
  const image = document.createElement('img');
  image.className = className; image.alt = ''; image.setAttribute('aria-hidden', 'true');
  image.referrerPolicy = 'no-referrer';
  const sources = siteIconSources(url, favicon);
  let index = 0;
  image.onerror = () => {
    index++;
    if (index >= sources.length - 1) image.onerror = null;
    image.src = sources[Math.min(index, sources.length - 1)];
  };
  image.src = sources[0];
  return image;
}
