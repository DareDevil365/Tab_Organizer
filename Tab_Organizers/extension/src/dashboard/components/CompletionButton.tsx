import React, { useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { PageData } from '../../types';

export function CompletionButton({ page, onUpdated }: { page: PageData; onUpdated: (page: PageData) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const completed = !!page.completed_at;
  const kind = page.completion_kind === 'watched' ? 'watched' : 'read';
  async function toggle(event: React.MouseEvent) {
    event.stopPropagation(); event.preventDefault();
    if (busy || !page.id) return;
    setBusy(true); setError('');
    try {
      onUpdated(await apiClient.put<PageData>(`/api/pages/${page.id}/completion`, { completed: !completed }));
      window.dispatchEvent(new Event('resource-completion-updated'));
    }
    catch { setError('Could not save. Try again.'); }
    finally { setBusy(false); }
  }
  return <span className="completion-control" onClick={event => event.stopPropagation()}>
    <button className={`completion-toggle ${completed ? 'is-complete' : ''}`} disabled={busy||page.id!<0}
      aria-pressed={completed} aria-label={completed ? `Mark ${page.title} as unseen` : `Mark ${page.title} as ${kind}`}
      title={completed ? 'Undo completion' : `Mark as ${kind}`} onClick={toggle}>
      <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="10" cy="10" r="7.5" />{completed && <path d="m6.5 10 2.5 2.5 4.5-5" />}</svg>
      {busy ? 'Saving…' : completed ? `${kind === 'watched' ? 'Watched' : 'Read'} · Undo` : `Mark ${kind}`}
    </button>
    {error && <small role="alert">{error}</small>}
  </span>;
}
