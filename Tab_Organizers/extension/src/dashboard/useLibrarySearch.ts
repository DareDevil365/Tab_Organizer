import { useEffect, useMemo, useState } from 'react';
import { PageData } from '../types';
import { apiClient } from '../lib/api-client';
import { rankTextPages, applySearchRanking } from '../lib/library-search';

interface Response {
  results: { id: number; score: number }[];
  interpreted_query: string;
  mode: 'semantic' | 'related-text';
  total: number;
}
export function useLibrarySearch<T extends PageData>(pages: T[], query: string) {
  const cleaned = query.trim();
  const [result, setResult] = useState<(Response & { query: string }) | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState(false);
  const contentKey=pages.filter(page=>page.id!>0).map(page=>[page.id,page.title,page.description,page.tags,page.content_summary].join('|')).join('\n');
  useEffect(() => {
    if (!cleaned || !pages.length) { setPending(false); setError(false); return; }
    const controller = new AbortController();
    setPending(true); setError(false);
    const timer = setTimeout(() => {
      apiClient.post<Response>('/api/search', { query: cleaned }, controller.signal)
        .then(value => { if (!controller.signal.aborted) setResult({ ...value, query: cleaned }); })
        .catch(() => { if (!controller.signal.aborted) { setResult(null); setError(true); } })
        .finally(() => { if (!controller.signal.aborted) setPending(false); });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [cleaned, contentKey]);
  const current = result?.query === cleaned ? result : null;
  const ranked = useMemo(() => !cleaned ? pages : current ? applySearchRanking(pages, current.results) : rankTextPages(pages, cleaned), [pages, cleaned, current]);
  return { pages: ranked, pending, error, interpreted: current?.interpreted_query || '', mode: current?.mode || 'related-text' };
}
