/** Serialized by chrome.scripting: keep this function self-contained. */
export async function mountFloatingPanel(popupUrl: string, token: string): Promise<'opened' | 'closed' | 'unavailable'> {
  const id = 'karlx-floating-panel';
  const existing = document.getElementById(id);
  if (existing) {
    existing.dispatchEvent(new Event('karlx-dismiss'));
    if (existing.getAttribute('data-karlx-dismissed') === 'true') return 'closed';
    // Reloading the extension can leave an old host whose listeners no longer
    // exist. It must not swallow every subsequent toolbar click.
    existing.remove();
  }
  let resolveReady!: (status: 'opened' | 'closed' | 'unavailable') => void;
  const ready = new Promise<'opened' | 'closed' | 'unavailable'>(resolve => { resolveReady = resolve; });
  const popup = new URL(popupUrl);
  const origin = `${popup.protocol}//${popup.host}`;
  const host = document.createElement('div');
  host.id = id;
  host.style.cssText = 'all:initial!important;display:contents!important;';
  const root = host.attachShadow({ mode: 'closed' });
  const panel = document.createElement('div');
  panel.setAttribute('popover', 'manual');
  const style = document.createElement('style');
  // Site backdrop rules must never dim, blur or recolor the surrounding page.
  style.textContent = '[popover]::backdrop{background:transparent!important;backdrop-filter:none!important;pointer-events:none!important}';
  // Inline important properties protect the host from a page's reset stylesheet.
  const properties: Record<string, string> = {
    all: 'initial', position: 'fixed', inset: 'clamp(16px, 4vh, 40px) clamp(16px, 4vw, 56px) auto auto',
    width: 'min(420px, calc(100vw - 48px))', height: 'min(600px, calc(100dvh - 64px))',
    padding: '0', margin: '0', border: '0', 'border-radius': '22px',
    background: 'transparent', overflow: 'hidden', 'z-index': '2147483647',
    'box-shadow': '0 22px 70px #0008, 0 0 0 1px #ffffff14',
    'color-scheme': 'dark', 'box-sizing': 'border-box',
  };
  for (const [key, value] of Object.entries(properties)) panel.style.setProperty(key, value, 'important');
  const frame = document.createElement('iframe');
  frame.src = popupUrl;
  frame.title = 'Karl X tabs and notes';
  frame.allow = 'clipboard-write';
  frame.style.cssText = 'display:block;width:100%;height:100%;border:0;background:transparent;color-scheme:dark;';
  panel.append(frame);
  root.append(style, panel);
  let dismissed = false;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (dismissed) return;
    dismissed = true;
    host.setAttribute('data-karlx-dismissed', 'true');
    clearTimeout(timer);
    resolveReady('closed');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape, true);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', close);
    window.removeEventListener('message', message);
    if (!reduced && !document.hidden && host.isConnected) {
      panel.getAnimations().forEach(animation => animation.cancel());
      const exit = panel.animate([{ opacity: 1, transform: 'translateY(0) scale(1)' }, { opacity: 0, transform: 'translateY(-8px) scale(.985)' }], { duration: 160, easing: 'ease-in', fill: 'forwards' });
      void exit.finished.catch(() => {}).finally(() => host.remove());
    } else host.remove();
  };
  const outside = (event: Event) => { if (!event.composedPath().includes(host)) close(); };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
  const visibility = () => { if (document.hidden) close(); };
  const message = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== origin || event.data?.token !== token) return;
    if (event.data.type === 'KARLX_PANEL_CLOSE') close();
    if (event.data.type === 'KARLX_PANEL_READY') { clearTimeout(timer); resolveReady('opened'); }
  };
  host.addEventListener('karlx-dismiss', close, { once: true });
  frame.addEventListener('load', () => frame.contentWindow?.focus(), { once: true });
  document.documentElement.append(host);
  // The top layer avoids clipping by websites with transformed root containers.
  try { panel.showPopover(); } catch { /* Fixed positioning remains a fallback. */ }
  if (!reduced) panel.animate([{ opacity: 0, transform: 'translateY(-10px) scale(.985)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }], { duration: 220, easing: 'cubic-bezier(.2,.75,.2,1)' });
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', escape, true);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', close);
  window.addEventListener('message', message);
  timer = setTimeout(() => { resolveReady('unavailable'); close(); }, 4000);
  return ready;
}

export const floatingSessionKey = (tabId: number) => `karlx_panel_${tabId}`;

/** Browser activation events close panels even if the old page is throttled. */
export async function closeInactivePanels(activeTabId: number, windowId: number): Promise<void> {
  const state=await chrome.storage.session.get(null);
  await Promise.allSettled(Object.keys(state).filter(key=>/^karlx_panel_\d+$/.test(key)).map(async key=>{
    const tabId=Number(key.slice('karlx_panel_'.length));
    if(tabId===activeTabId)return;
    try {
      const tab=await chrome.tabs.get(tabId);
      if(tab.active||tab.windowId!==windowId)return;
      if((tab.url||'').split(/[?#]/)[0]===chrome.runtime.getURL('src/dashboard/dashboard.html')) {
        await chrome.runtime.sendMessage({type:'CLOSE_WORKSPACE_PANEL',tabId});
      } else if(!tab.discarded) {
        await chrome.scripting.executeScript({target:{tabId},func:()=>{
          document.getElementById('karlx-floating-panel')?.dispatchEvent(new Event('karlx-dismiss'));
        }});
      }
      await chrome.storage.session.remove(key);
    } catch { /* A closed or navigated tab already lost its panel. */ }
  }));
  const detached=state.karlx_detached_panel;
  if(detached?.sourceWindowId===windowId&&detached.sourceTabId!==undefined&&detached.sourceTabId!==activeTabId){
    try {
      const window=await chrome.windows.get(detached.id,{populate:true});
      if(window.type==='popup'&&window.tabs?.some(tab=>(tab.url||'').split('?')[0]===chrome.runtime.getURL('src/popup/popup.html')))await chrome.windows.remove(detached.id);
      await chrome.storage.session.remove('karlx_detached_panel');
    }catch{/* Already closed. */}
  }
}

const openingPanels = new Map<number, Promise<void>>();
async function waitForPanel<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Panel initialization timed out')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

export function openFloatingPanel(tab: chrome.tabs.Tab): Promise<void> {
  const key = tab.id ?? tab.windowId;
  const existing = openingPanels.get(key);
  if (existing) return existing;
  const opening = openPanel(tab).finally(() => { openingPanels.delete(key); });
  openingPanels.set(key, opening);
  return opening;
}

async function openPanel(tab: chrome.tabs.Tab): Promise<void> {
  const path = 'src/popup/popup.html';
  const isWorkspace = (tab.url || '').split(/[?#]/)[0] === chrome.runtime.getURL('src/dashboard/dashboard.html');
  if (tab.id !== undefined && (isWorkspace || /^https?:\/\//i.test(tab.url || ''))) {
    const token = crypto.randomUUID();
    const key = floatingSessionKey(tab.id);
    try {
      await chrome.storage.session.set({ [key]: { token, createdAt: Date.now() } });
      const url = new URL(chrome.runtime.getURL(path));
      url.searchParams.set('panel', token);
      // Extension pages mount their own host; scripting injection is for websites.
      const status = await waitForPanel(isWorkspace
        ? chrome.runtime.sendMessage({ type: 'TOGGLE_WORKSPACE_PANEL', tabId: tab.id, token }).then(result => result?.status)
        : chrome.scripting.executeScript({ target: { tabId: tab.id }, func: mountFloatingPanel, args: [url.href, token] }).then(result => result[0]?.result));
      if (status !== 'opened' && status !== 'closed') throw new Error('Panel frame unavailable');
      return;
    } catch { await chrome.storage.session.remove(key).catch(() => {}); }
  }
  // Internal/restricted pages use the browser toolbar popup. A separate window
  // looked like another application and could outlive the page that opened it.
  await chrome.action.setPopup({ popup: path });
  try { await chrome.action.openPopup(tab.windowId === undefined ? undefined : { windowId: tab.windowId }); }
  finally { await chrome.action.setPopup({ popup: '' }); }
}

export async function authorizeFloatingPanel(token: unknown, sender: chrome.runtime.MessageSender): Promise<boolean> {
  if (typeof token !== 'string' || sender.id !== chrome.runtime.id || sender.tab?.id === undefined) return false;
  const url = sender.url || '';
  if (!url.startsWith(chrome.runtime.getURL('src/popup/popup.html') + '?')) return false;
  const key = floatingSessionKey(sender.tab.id);
  const session = (await chrome.storage.session.get(key))[key];
  return !!session && session.token === token && Date.now() - session.createdAt < 12 * 60 * 60 * 1000;
}
