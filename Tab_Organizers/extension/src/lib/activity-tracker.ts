/** Durable focused-tab checkpoints. Browser events and upload share one queue. */
export interface TrackingContext { tabId: number; url: string; domain: string }
interface Session extends TrackingContext { startedAt: number }
export interface ActivityInterval {
  url: string; domain: string; started_at: string; ended_at: string; duration_seconds: number;
}
interface TrackingState { activity_queue?: ActivityInterval[]; activity_current_session_v2?: Session | null }
interface Dependencies {
  now: () => number;
  context: () => Promise<TrackingContext | null>;
  read: () => Promise<TrackingState>;
  write: (state: TrackingState) => Promise<void>;
  upload: (intervals: ActivityInterval[]) => Promise<unknown>;
}

export class ActivityTracker {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private dependencies: Dependencies) {}

  checkpoint({ flush = false, discardPrevious = false } = {}): Promise<void> {
    const work = this.tail.then(async () => {
      const state = await this.dependencies.read();
      const queue = [...(state.activity_queue || [])];
      const context = await this.dependencies.context();
      const now = this.dependencies.now();
      const previous = state.activity_current_session_v2;
      if (previous && !discardPrevious) {
        // Alarms normally checkpoint every 30s. A delayed wake/browser shutdown
        // must never turn hours of an unobserved gap into browsing time.
        const duration = Math.floor(Math.max(0, Math.min(now - previous.startedAt, 90000)) / 1000);
        if (duration >= 2) queue.push({
          url: previous.url, domain: previous.domain,
          started_at: new Date(previous.startedAt).toISOString(),
          ended_at: new Date(previous.startedAt + duration * 1000).toISOString(), duration_seconds: duration,
        });
      }
      const session = context && /^https?:\/\//i.test(context.url) ? { ...context, startedAt: now } : null;
      // Persist interval + new start atomically before attempting the network.
      await this.dependencies.write({ activity_queue: queue, activity_current_session_v2: session });
      if (flush && queue.length) {
        try {
          await this.dependencies.upload(queue);
          // Serialized checkpoints cannot append between upload and this clear.
          await this.dependencies.write({ activity_queue: [] });
        } catch { /* Offline queue remains durable for the next alarm. */ }
      }
    });
    this.tail = work.catch(() => {});
    return work;
  }
}
