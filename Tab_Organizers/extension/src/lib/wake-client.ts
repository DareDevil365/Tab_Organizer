import type { WakeProgress } from './wake-tabs';

interface WakeRunner {
  start(windowId: number): Promise<WakeProgress>;
  status(): WakeProgress;
}
type Send = (message: { type: string; windowId?: number }) => Promise<unknown>;

function progressFrom(response: unknown): WakeProgress | null {
  const value = response as { success?: boolean; progress?: WakeProgress } | null;
  const progress = value?.progress;
  return value?.success === true && progress && typeof progress.running === 'boolean' &&
    Number.isInteger(progress.revision) && Number.isInteger(progress.completed) &&
    Number.isInteger(progress.total) ? progress : null;
}

/** A freshly rebuilt panel can coexist with an older registered service worker. */
export class WakeClient {
  private workerAvailable = false;
  private checking: Promise<WakeProgress> | null = null;
  constructor(private send: Send, private panel: WakeRunner) {}
  get panelRunning(): boolean { return this.panel.status().running; }
  status(): Promise<WakeProgress> {
    if (this.checking) return this.checking;
    this.checking = this.check().finally(() => { this.checking = null; });
    return this.checking;
  }
  private async check(): Promise<WakeProgress> {
    if (this.panel.status().running) {
      this.workerAvailable = false;
      return this.panel.status();
    }
    try {
      const progress = progressFrom(await this.send({ type: 'GET_TAB_WAKE_STATUS' }));
      this.workerAvailable = progress !== null;
      return progress || this.panel.status();
    } catch {
      this.workerAvailable = false;
      return this.panel.status();
    }
  }
  async start(windowId: number): Promise<WakeProgress> {
    // Capability check avoids handing the action to a worker that has no handler.
    const before = await this.status();
    if (before.running) return before;
    if (this.workerAvailable) {
      try {
        const progress = progressFrom(await this.send({ type: 'WAKE_SLEEPING_TABS', windowId }));
        if (progress) return progress;
      } catch { /* The worker may have stopped between the handshake and start. */ }
      // A lost acknowledgement must not cause a second queue if the worker
      // already started (or finished) the requested batch.
      const after = await this.status();
      if (this.workerAvailable && (after.running || (after.windowId === windowId && after.revision > before.revision))) return after;
    }
    // Popup and authorized floating frames already have the Tabs API. A worker
    // update gap must not make the button unusable while this panel is open.
    return this.panel.start(windowId);
  }
}
