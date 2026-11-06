import { useEffect, useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { ToolIcon } from '../pages/ToolIcon';

interface DeletedItem { id: string; kind: 'page' | 'note'; title: string; expires_at: string; note_count: number }

export function RecycleBin({ onRestored }: { onRestored?: () => void }) {
  const [items, setItems] = useState<DeletedItem[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [restoring, setRestoring] = useState<string | null>(null);
  async function load() {
    setLoading(true); setError('');
    try { setItems(await apiClient.get<DeletedItem[]>('/api/recycle-bin')); }
    catch { setError('Could not load the recycle bin. Check the local backend and retry.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function restore(item: DeletedItem) {
    setRestoring(item.id); setError('');
    try {
      await apiClient.post(`/api/recycle-bin/${item.id}/restore`, {});
      setItems(previous => previous.filter(entry => entry.id !== item.id));
      onRestored?.();
    } catch { setError('Could not restore this item. It may have passed its five-day recovery period. Refresh to check.'); }
    finally { setRestoring(null); }
  }
  return <section className="tool-panel" aria-labelledby="recycle-bin-title">
    <div className="tool-section-head"><div><h2 id="recycle-bin-title">Recycle bin</h2><p>Removed links and notes stay here for 5 days, then are permanently removed. Restoring a link brings back its notes too.</p></div><button className="tool-text-button" onClick={load} disabled={loading}>Refresh</button></div>
    {error && <p role="alert">{error}</p>}
    {loading ? <p className="tool-muted" role="status">Loading removed items…</p> : !items.length ? <div className="settings-empty">Your recycle bin is empty.</div> :
      <div className="settings-session-list">{items.map(item => <article className="settings-session" key={item.id}><div><h3>{item.title}</h3><p>{item.kind === 'page' ? `Link · ${item.note_count} note${item.note_count === 1 ? '' : 's'}` : 'Note'}</p><small>Automatically removed {new Date(item.expires_at).toLocaleString()}</small></div><button className="tool-button" disabled={restoring !== null} onClick={() => restore(item)} aria-label={`Restore ${item.title}`}><ToolIcon name="refresh"/>{restoring === item.id ? 'Restoring…' : 'Restore'}</button></article>)}</div>}
  </section>;
}
