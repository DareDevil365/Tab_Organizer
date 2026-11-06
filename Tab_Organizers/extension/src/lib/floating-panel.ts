/** Serialized by chrome.scripting: keep this function self-contained. */
export async function mountFloatingPanel(popupUrl: string, token: string): Promise<'opened' | 'closed' | 'unavailable'> {
  const id = 'karlx-floating-panel';
  const existing = document.getElementById(id);
  if (existing) { existing.dispatchEvent(new Event('karlx-dismiss')); return 'closed'; }
  let resolveReady!: (status: 'opened' | 'closed' | 'unavailable') => void;
  const ready = new Promise<'opened' | 'closed' | 'unavailable'>(resolve => { resolveReady = resolve; });
  const popup = new URL(popupUrl);
  const origin = `${popup.protocol}//${popup.host}`;
  const host = document.createElement('div');
  host.id = id;
  host.setAttribute('popover', 'manual');
  // Inline important properties protect the host from a page's reset stylesheet.
  const properties: Record<string, string> = {
    all: 'initial', position: 'fixed', inset: 'clamp(16px, 4vh, 40px) clamp(16px, 4vw, 56px) auto auto',
    width: 'min(420px, calc(100vw - 48px))', height: 'min(600px, calc(100dvh - 64px))',
    padding: '0', margin: '0', border: '0', 'border-radius': '22px',
    background: 'transparent', overflow: 'hidden', 'z-index': '2147483647',
    'box-shadow': '0 22px 70px #0008, 0 0 0 1px #ffffff14',
    'color-scheme': 'dark', 'box-sizing': 'border-box',
  };
  for (const [key, value] of Object.entries(properties)) host.style.setProperty(key, value, 'important');
  const root = host.attachShadow({ mode: 'closed' });
  const frame = document.createElement('iframe');
  frame.src = popupUrl;
  frame.title = 'Karl X tabs and notes';
  frame.allow = 'clipboard-write';
  frame.style.cssText = 'display:block;width:100%;height:100%;border:0;background:transparent;color-scheme:dark;';
  root.append(frame);
  let dismissed = false;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(timer);
    resolveReady('closed');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape, true);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('message', message);
    if (!reduced && !document.hidden && host.isConnected) {
      host.getAnimations().forEach(animation => animation.cancel());
      const exit = host.animate([{ opacity: 1, transform: 'translateY(0) scale(1)' }, { opacity: 0, transform: 'translateY(-8px) scale(.985)' }], { duration: 160, easing: 'ease-in', fill: 'forwards' });
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
  try { host.showPopover(); } catch { /* Fixed positioning remains a fallback. */ }
  if (!reduced) host.animate([{ opacity: 0, transform: 'translateY(-10px) scale(.985)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }], { duration: 220, easing: 'cubic-bezier(.2,.75,.2,1)' });
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', escape, true);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('message', message);
  timer = setTimeout(() => { resolveReady('unavailable'); close(); }, 4000);
  return ready;
}

export const floatingSessionKey = (tabId: number) => `karlx_panel_${tabId}`;

export async function openFloatingPanel(tab: chrome.tabs.Tab): Promise<void> {
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
      const status = isWorkspace
        ? (await chrome.runtime.sendMessage({ type: 'TOGGLE_WORKSPACE_PANEL', tabId: tab.id, token }))?.status
        : (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: mountFloatingPanel, args: [url.href, token] }))[0]?.result;
      if (status !== 'opened' && status !== 'closed') throw new Error('Panel frame unavailable');
      return;
    } catch { await chrome.storage.session.remove(key).catch(() => {}); }
  }
  // Internal browser pages block document injection. A detached extension
  // window keeps the same usable size, instead of the toolbar's square frame.
  try {
    const key='karlx_detached_panel';
    const previous=(await chrome.storage.session.get(key))[key];
    if(previous?.id){
      try {
        const existing = await chrome.windows.get(previous.id, { populate: true });
        if (existing.type === 'popup' && existing.tabs?.some(item => (item.url || '').split('?')[0] === chrome.runtime.getURL(path))) {
          await chrome.windows.remove(previous.id);await chrome.storage.session.remove(key);return;
        }
      } catch {/* Previously closed window. */}
      await chrome.storage.session.remove(key);
    }
    const source=tab.windowId!==undefined?await chrome.windows.get(tab.windowId):await chrome.windows.getLastFocused({windowTypes:['normal']});
    const url=new URL(chrome.runtime.getURL(path));url.searchParams.set('detached','true');
    if(source.id!==undefined)url.searchParams.set('sourceWindow',String(source.id));
    const sourceHeight=source.height || 800;
    const topInset=Math.min(180,Math.max(96,sourceHeight-(tab.height || sourceHeight-96)+32));
    const width=Math.min(440,Math.max(320,(source.width || 1000)-96));
    const height=Math.min(650,Math.max(320,sourceHeight-topInset-32));
    const options: chrome.windows.CreateData={type:'popup',url:url.href,width,height,focused:true};
    let opened: chrome.windows.Window;
    try {
      opened=await chrome.windows.create({...options,
        left:Math.max(0,(source.left || 0)+(source.width || 1000)-width-48),top:Math.max(0,(source.top || 0)+topInset)});
    } catch {
      // A moved/disconnected monitor can make the source bounds invalid.
      // Let the window manager place the same panel on a visible display.
      opened=await chrome.windows.create(options);
    }
    if(opened.id!==undefined)await chrome.storage.session.set({[key]:{id:opened.id}});
    return;
  }catch{/* Last-resort native popup if the window manager cannot create a panel. */}
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
