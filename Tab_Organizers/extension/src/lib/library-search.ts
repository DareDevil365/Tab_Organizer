import { PageData } from '../types';

/** Immediate/offline ranking keeps every resource, even before semantic results. */
export function rankTextPages<T extends PageData>(pages: T[], query: string): (T & { search_score?: number })[] {
  const normalize = (value: string) => value.normalize('NFKD').toLowerCase().replace(/(.)\1+/g, '$1');
  const terms = normalize(query.trim()).split(/\s+/).filter(Boolean);
  if (!terms.length) return pages;
  return pages.map((page, index) => {
    const text = normalize([page.title, page.description, page.topic, page.category, page.tags, page.content_summary, page.url_original].filter(Boolean).join(' '));
    const count = terms.filter(term => text.includes(term)).length;
    return { page, index, score: count / terms.length * 85 };
  }).sort((a, b) => b.score - a.score || a.index - b.index).map(item => ({ ...item.page, search_score: Math.round(item.score) }));
}

export function applySearchRanking<T extends PageData>(pages: T[], results: { id: number; score: number }[]): (T & { search_score: number })[] {
  const scores = new Map(results.map((item, index) => [item.id, { score: item.score, index }]));
  return pages.map((page, index) => ({ page, index, rank: scores.get(page.id!) }))
    .sort((a, b) => (a.rank?.index ?? results.length + a.index) - (b.rank?.index ?? results.length + b.index))
    .map(({ page, rank }) => ({ ...page, search_score: rank?.score ?? 0 }));
}
