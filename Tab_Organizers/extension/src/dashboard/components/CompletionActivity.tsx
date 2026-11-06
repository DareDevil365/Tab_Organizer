import { useEffect, useState } from 'react';
import { apiClient } from '../../lib/api-client';

interface CompletionSummary {
  completed: number; watched: number; read: number; unseen: number;
  total_saved: number; total_completed: number;
  recent: { id: number; title: string; kind: 'watched' | 'read'; completed_at: string }[];
}

export function CompletionActivity({ days, onSelectPage }: { days: number; onSelectPage?: (id: number) => void }) {
  const [summary, setSummary] = useState<CompletionSummary | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [undoing, setUndoing] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    apiClient.get<CompletionSummary>(`/api/activity/completions?days=${days}`).then(result => { if (active) setSummary(result); })
      .catch(() => { if (active) { setSummary(null); setError('Could not load your completion history.'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [days, revision]);
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener('resource-completion-updated', refresh);
    return () => window.removeEventListener('resource-completion-updated', refresh);
  }, []);
  async function undo(id: number) {
    setUndoing(id); setError('');
    try { await apiClient.put(`/api/pages/${id}/completion`, { completed: false }); window.dispatchEvent(new Event('resource-completion-updated')); }
    catch { setError('Could not undo completion. Please retry.'); }
    finally { setUndoing(null); }
  }
  const period = days === 1 ? 'Last 24 hours' : `Last ${days} days`;
  return <section className="completion-activity" aria-label="Saved resource progress">
    <div className="completion-heading"><div><h2>From saved to finished.</h2><p>{period} · Your explicit watched and read marks</p></div><span>Opening a tab never marks it complete.</span></div>
    {error && <p className="completion-error" role="alert">{error} <button onClick={() => setRevision(value => value + 1)}>Retry</button></p>}
    {loading ? <p role="status">Loading your progress…</p> : summary && <>
      <div className="completion-stats">
        {[[summary.completed, 'Completed in this period'], [summary.watched, 'Videos watched'], [summary.read, 'Resources read'], [summary.unseen, 'Still unseen']].map(([value, label]) => <div key={String(label)}><strong>{value}</strong><span>{label}</span></div>)}
      </div>
      <div className="completion-progress"><span>{summary.total_completed} of {summary.total_saved} saved resources completed</span><progress max={Math.max(1, summary.total_saved)} value={summary.total_completed} aria-label="Library completion" /></div>
      <div className="completion-history"><h3>Completion log</h3>
        {summary.recent.length ? <ul>{summary.recent.map(item => <li key={item.id}>
          <span className={`completion-kind ${item.kind}`}>{item.kind === 'watched' ? 'Watched' : 'Read'}</span>
          <button className="completion-resource" onClick={() => onSelectPage?.(item.id)}>{item.title}</button>
          <time dateTime={item.completed_at}>{new Date(item.completed_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</time>
          <button className="completion-undo" disabled={undoing !== null} aria-label={`Undo completion for ${item.title}`} onClick={() => undo(item.id)}>{undoing === item.id ? 'Saving…' : 'Undo'}</button>
        </li>)}</ul> : <p>No completions in this period yet. Mark a resource watched or read when you finish it.</p>}
        {summary.completed > 50 && <small>Showing the 50 most recent completions in this period.</small>}
      </div>
    </>}
  </section>;
}
