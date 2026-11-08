import { floatingSessionKey, mountFloatingPanel } from './floating-panel';

/** The extension's dashboard can mount a panel directly, without script injection. */
export async function registerWorkspacePanel(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage || window.parent !== window) return;
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id === undefined) return;
  const tabId = tab.id;
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if(message?.type==='CLOSE_WORKSPACE_PANEL'&&message.tabId===tabId&&sender.id===chrome.runtime.id&&!sender.tab){
      document.getElementById('karlx-floating-panel')?.dispatchEvent(new Event('karlx-dismiss'));
      respond({closed:true});return false;
    }
    if (message?.type !== 'TOGGLE_WORKSPACE_PANEL' || message.tabId !== tabId ||
        sender.id !== chrome.runtime.id || sender.tab || typeof message.token !== 'string') return;
    const token = message.token;
    void (async () => {
      const key = floatingSessionKey(tabId);
      const session = (await chrome.storage.session.get(key))[key];
      if (!session || session.token !== token || Date.now() - session.createdAt > 12 * 60 * 60 * 1000) {
        respond({ status: 'unavailable' }); return;
      }
      const url = new URL(chrome.runtime.getURL('src/popup/popup.html'));
      url.searchParams.set('panel', token);
      respond({ status: await mountFloatingPanel(url.href, token) });
    })().catch(() => respond({ status: 'unavailable' }));
    return true;
  });
}
