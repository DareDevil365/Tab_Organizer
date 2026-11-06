const panelToken = new URLSearchParams(window.location.search).get('panel');
const embedded = window.parent !== window;

/** Gate web-accessible frames before initializing privileged tab controls. */
export async function preparePopupHost(): Promise<boolean> {
  if (!embedded) {
    if(new URLSearchParams(location.search).get('detached')==='true'){
      document.documentElement.classList.add('detached-panel');
      document.getElementById('btn-close-panel')?.addEventListener('click',closePopup);
    }
    return true;
  }
  let allowed = false;
  try {
    if (panelToken) allowed = (await chrome.runtime.sendMessage({ type: 'AUTHORIZE_FLOATING_PANEL', token: panelToken }))?.allowed === true;
  } catch { /* Extension reload or untrusted embed. */ }
  if (!allowed) {
    document.body.textContent = 'Open Karl X from the extension icon.';
    return false;
  }
  document.documentElement.classList.add('floating-panel');
  window.parent.postMessage({ type: 'KARLX_PANEL_READY', token: panelToken }, '*');
  document.getElementById('btn-close-panel')?.addEventListener('click', closePopup);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    // An inner dialog gets the first Escape; the next closes the panel.
    const modal = Array.from(document.querySelectorAll<HTMLElement>('.win-modal-overlay')).some(element => getComputedStyle(element).display !== 'none');
    if (!modal) closePopup();
  });
  return true;
}

export function closePopup(): void {
  if (embedded && panelToken) window.parent.postMessage({ type: 'KARLX_PANEL_CLOSE', token: panelToken }, '*');
  else window.close();
}

/** Clipboard API requires a secure ancestor; HTTP pages still need Copy Notes. */
export async function copyPopupText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch { /* Fall back to a user-initiated copy inside this extension frame. */ }
  const focused = document.activeElement as HTMLElement | null;
  const field = document.createElement('textarea');
  field.value = text;
  field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.append(field);
  field.select();
  try {
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
  } finally { field.remove(); focused?.focus(); }
}
