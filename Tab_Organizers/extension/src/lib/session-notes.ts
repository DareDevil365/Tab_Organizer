import { normalizeUrl } from './url-normalize';

interface NoteUrl { videoUrl: string }
interface OpenUrl { url?: string; windowId?: number }

/** Only resources open in the selected window qualify; note age is irrelevant. */
export function notesForOpenTabs<T extends NoteUrl>(notes: T[], tabs: OpenUrl[], windowId: number | null, currentUrl?: string): T[] {
  const openUrls = new Set(tabs.filter(tab => windowId === null || tab.windowId === windowId)
    .map(tab => tab.url || '').filter(url => /^https?:\/\//i.test(url)).map(normalizeUrl));
  const current = currentUrl === undefined ? undefined : normalizeUrl(currentUrl);
  return notes.filter(note => {
    const url = normalizeUrl(note.videoUrl);
    return openUrls.has(url) && (current === undefined || url === current);
  });
}
