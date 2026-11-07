/** Wake only background tabs, with bounded loading and no tab activation. */
export interface WakeTab {
  id?: number;
  windowId: number;
  url?: string;
  title?: string;
  active: boolean;
  audible?: boolean;
  discarded?: boolean;
  frozen?: boolean;
  status?: string;
}

export interface WakeProgress {
  ownerId: string;
  revision: number;
  running: boolean;
  windowId: number | null;
  total: number;
  completed: number;
  woken: number;
  failed: number;
  skipped: number;
}

type Updated = (id: number, change: { status?: string }, tab: WakeTab) => void;
type Removed = (id: number) => void;
export interface WakeBrowser {
  query(query: { windowId: number }): Promise<WakeTab[]>;
  get(id: number): Promise<WakeTab>;
  reload(id: number): Promise<void>;
  onUpdated: { addListener(fn: Updated): void; removeListener(fn: Updated): void };
  onRemoved: { addListener(fn: Removed): void; removeListener(fn: Removed): void };
}

export function needsTabWake(tab: WakeTab): boolean {
  if (tab.id === undefined || tab.active || tab.audible || tab.status === 'loading') return false;
  let url: URL;
  try { url = new URL(tab.url || ''); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (tab.discarded || tab.frozen || tab.status === 'unloaded') return true;
  // Session-restored YouTube tabs can have a hostname in place of the title
  // even when Chromium has not marked them discarded yet.
  const host = url.hostname.replace(/^(www|m)\./, '');
  const video = host === 'youtu.be' ? url.pathname.length > 1 :
    host === 'youtube.com' && ((url.pathname === '/watch' && !!url.searchParams.get('v')) || /^\/(shorts|live|embed)\/[^/]+/.test(url.pathname));
  const title = (tab.title || '').trim().toLowerCase().replace(/\s+-\s+youtube$/, '');
  return video && (!title || ['youtube', 'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'untitled', 'untitled video'].includes(title) || title === url.href.toLowerCase());
}

function reloadUntilReady(browser: WakeBrowser, id: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browser.onUpdated.removeListener(updated);
      browser.onRemoved.removeListener(removed);
      if (error) reject(error); else resolve();
    };
    const ready = (tab: WakeTab) => tab.status === 'complete' && !tab.discarded && !tab.frozen;
    const updated: Updated = (tabId, change, tab) => {
      if (tabId === id && change.status === 'complete' && ready(tab)) finish();
    };
    const removed: Removed = tabId => { if (tabId === id) finish(new Error('Tab closed')); };
    const timer = setTimeout(() => finish(new Error('Tab is still loading')), timeoutMs);
    browser.onUpdated.addListener(updated);
    browser.onRemoved.addListener(removed);
    void (async () => {
      try {
        await browser.reload(id);
        if (!settled && ready(await browser.get(id))) finish();
      } catch { finish(new Error('Could not wake tab')); }
    })();
  });
}

export class TabWakeManager {
  private progress: WakeProgress = { ownerId: crypto.randomUUID(), revision: 0, running: false, windowId: null, total: 0, completed: 0, woken: 0, failed: 0, skipped: 0 };
  private starting: Promise<WakeProgress> | null = null;
  private job: Promise<void> | null = null;
  constructor(private browser: WakeBrowser, private notify: (progress: WakeProgress) => void, private timeoutMs = 15000) {}
  status(): WakeProgress { return { ...this.progress }; }
  start(windowId: number): Promise<WakeProgress> {
    if (this.starting) return this.starting;
    if (this.job) return Promise.resolve(this.status());
    if (!Number.isInteger(windowId) || windowId < 0) return Promise.reject(new Error('Invalid window'));
    this.starting = this.prepare(windowId).finally(() => { this.starting = null; });
    return this.starting;
  }
  private publish() {
    this.progress.revision++;
    try { this.notify(this.status()); } catch { /* A closed panel must not fail the wake queue. */ }
  }
  private async prepare(windowId: number): Promise<WakeProgress> {
    const tabs = (await this.browser.query({ windowId })).filter(tab => tab.windowId === windowId && needsTabWake(tab));
    this.progress = { ownerId: this.progress.ownerId, revision: this.progress.revision, running: tabs.length > 0, windowId, total: tabs.length, completed: 0, woken: 0, failed: 0, skipped: 0 };
    this.publish();
    if (tabs.length) this.job = this.run(tabs).finally(() => { this.job = null; });
    return this.status();
  }
  private async run(tabs: WakeTab[]) {
    let next = 0;
    const worker = async () => {
      while (next < tabs.length) {
        const original = tabs[next++];
        try {
          const fresh = await this.browser.get(original.id!);
          if (fresh.windowId !== original.windowId || fresh.url !== original.url || !needsTabWake(fresh)) this.progress.skipped++;
          else {
            await reloadUntilReady(this.browser, original.id!, this.timeoutMs);
            this.progress.woken++;
          }
        } catch { this.progress.failed++; }
        this.progress.completed++;
        this.publish();
      }
    };
    try { await Promise.all([worker(), worker()]); }
    finally { this.progress.running = false; this.publish(); }
  }
}
