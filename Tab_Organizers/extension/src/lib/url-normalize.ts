export function normalizeUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    
    // 1. Lowercase scheme and host
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    
    // 2. Remove trailing slash from pathname if present (unless it's just '/')
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }

    // 3. Google Workspace special handling (Docs, Sheets, Slides, Forms, Drive files)
    if (url.hostname === 'docs.google.com') {
      const p = url.pathname;
      if (p.startsWith('/document/') || /^\/(?:u\/\d+\/)?document\//.test(p) || /^\/(?:u\/\d+\/)?d\//.test(p)) {
        const docMatch = p.match(/\/d\/([a-zA-Z0-9_-]+)/);
        if (docMatch) return `https://docs.google.com/document/d/${docMatch[1]}/edit`;
      } else if (p.startsWith('/spreadsheets/') || /^\/(?:u\/\d+\/)?spreadsheets\//.test(p)) {
        const sheetMatch = p.match(/\/d\/([a-zA-Z0-9_-]+)/);
        if (sheetMatch) return `https://docs.google.com/spreadsheets/d/${sheetMatch[1]}/edit`;
      } else if (p.startsWith('/presentation/') || /^\/(?:u\/\d+\/)?presentation\//.test(p)) {
        const presMatch = p.match(/\/d\/([a-zA-Z0-9_-]+)/);
        if (presMatch) return `https://docs.google.com/presentation/d/${presMatch[1]}/edit`;
      } else if (p.startsWith('/forms/') || /^\/(?:u\/\d+\/)?forms\//.test(p)) {
        const formMatch = p.match(/\/d\/([a-zA-Z0-9_-]+)/);
        if (formMatch) {
          const isEdit = p.includes('/edit');
          return `https://docs.google.com/forms/d/${formMatch[1]}/${isEdit ? 'edit' : 'viewform'}`;
        }
      }
    } else if (url.hostname === 'drive.google.com') {
      const fileMatch = url.pathname.match(/\/file\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/);
      if (fileMatch) {
        return `https://drive.google.com/file/d/${fileMatch[1]}/view`;
      }
    }
    
    // 4. Strip tracking parameters
    const paramsToRemove = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'utm_id', 'utm_name', 'utm_cid', 'utm_reader', 'utm_viz_id', 'utm_pubreferrer',
      'fbclid', 'gclid', 'gclsrc', 'dclid', 'zanpid', 'msclkid',
      'si', 'feature', 'ref', 'ref_src', 'ref_url', 'igshid', 'mc_cid', 'mc_eid',
      '_ga', '_gl', '_hsenc', '_hsmi', '__hssc', '__hstc', '__hsfp',
      'mkt_tok', 'wickedid', 'yclid', '_openstat',
      'usp', 'authuser', 'ouid', 'pli', 'resourcekey'
    ];
    
    // YouTube special handling
    if (url.hostname === 'www.youtube.com' || url.hostname === 'youtube.com' || url.hostname === 'm.youtube.com') {
      paramsToRemove.push('t', 'list', 'index');
      if (url.pathname === '/watch') {
        const v = url.searchParams.get('v');
        if (v) {
          return `https://www.youtube.com/watch?v=${v}`;
        }
      } else if (url.pathname.startsWith('/shorts/')) {
        const videoId = url.pathname.split('/shorts/')[1]?.split('/')[0];
        if (videoId) {
          return `https://www.youtube.com/watch?v=${videoId}`;
        }
      }
    } else if (url.hostname === 'youtu.be') {
      const videoId = url.pathname.replace(/^\/+/, '').split('/')[0];
      if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    }
    
    const params = new URLSearchParams(url.search);
    for (const param of paramsToRemove) {
      params.delete(param);
    }
    // Also strip any custom utm_ keys
    for (const key of Array.from(params.keys())) {
      if (key.toLowerCase().startsWith('utm_')) {
        params.delete(key);
      }
    }
    
    url.search = params.toString();
    
    // 5. Amazon special handling - extract /dp/ASIN as canonical
    if (url.hostname.includes('amazon.')) {
      const dpMatch = url.pathname.match(/\/dp\/([A-Z0-9]{10})/i);
      const gpMatch = url.pathname.match(/\/(?:gp\/product|exec\/obidos\/ASIN)\/([A-Z0-9]{10})/i);
      const asin = dpMatch ? dpMatch[1] : (gpMatch ? gpMatch[1] : null);
      if (asin) {
        const host = url.hostname.startsWith('www.') ? url.hostname : `www.${url.hostname}`;
        return `https://${host}/dp/${asin.toUpperCase()}`;
      }
    }
    
    // 6. Fragment cleaning:
    // Strip empty fragments ('#', '#/'), Chrome text fragments ('#:~:text=...'),
    // and in-page anchor fragments (e.g. '#heading=...', '#section-1', '#readme').
    // Only preserve hash-based SPA routing (starting with '#/' or '#!/'),
    // except for known exceptions like Gmail (mail.google.com) which uses '#inbox', '#sent', etc.
    if (url.hash) {
      if (url.hash === '#' || url.hash === '#/' || url.hash === '#!/') {
        url.hash = '';
      } else if (url.hash.startsWith('#:~:text=')) {
        url.hash = '';
      } else if (url.hostname === 'mail.google.com') {
        // Gmail uses #inbox, #sent, etc. Keep intact.
      } else if (url.hash.startsWith('#/') || url.hash.startsWith('#!/')) {
        // SPA hash router path (e.g. #/dashboard, #!/profile). Keep intact.
      } else {
        // In-page DOM anchor (e.g. #heading=..., #section, #readme, #top, etc.)
        url.hash = '';
      }
    }
    
    return url.toString();
  } catch (error) {
    // If it's not a valid URL, return original
    return urlStr;
  }
}
