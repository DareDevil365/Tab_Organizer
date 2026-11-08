import { PageData } from '../types';

export type PageFilter = 'all' | 'domain' | 'topic' | 'important' | 'urgent' | 'notes' | 'unseen' | 'completed';
export interface LibraryFilters { status:'all'|'unseen'|'completed';hasNotes:boolean;important:boolean;urgent:boolean;topic:string;domain:string }
export const emptyFilters:LibraryFilters={status:'all',hasNotes:false,important:false,urgent:false,topic:'',domain:''};
export function applyLibraryFilters<T extends PageData>(pages:T[],filters:LibraryFilters):T[]{
  return pages.filter(page=>(filters.status==='all'||(filters.status==='completed'?!!page.completed_at:!page.completed_at))
    &&(!filters.hasNotes||(page.note_count||0)>0)&&(!filters.important||!!page.is_important)&&(!filters.urgent||!!page.is_urgent)
    &&(!filters.topic||pageTopics(page).some(topic=>topic.toLowerCase()===filters.topic.toLowerCase()))
    &&(!filters.domain||pageDomain(page)===filters.domain));
}

export function pageTopics(page: PageData): string[] {
  // Generated subtopics extend existing subjects; they do not erase them.
  const labels = [...(page.subject_topics || []), page.display_topic || '', page.topic || ''];
  const seen = new Set<string>();
  return labels.map(label=>label.trim()).filter(label => {
    const key=label.toLowerCase();
    if(!label||seen.has(key)||['general','other','unknown','uncategorized','none','needs a topic'].includes(key)||/https?:\/\/|\b\w+\.\w+\b/i.test(label))return false;
    seen.add(key);return true;
  });
}

export function pageDomain(page: PageData): string {
  if (page.domain) return page.domain;
  try { return new URL(page.url_original || page.url_normalized).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

export function filterPages<T extends PageData>(pages: T[], query: string, type: PageFilter, value: string): T[] {
  const search = query.trim().toLowerCase();
  return pages.filter(page => {
    if (search && ![page.title, page.url_original, page.url_normalized, page.description, page.topic, pageDomain(page)]
      .some(field => (field || '').toLowerCase().includes(search))) return false;
    if (type === 'important') return !!page.is_important;
    if (type === 'urgent') return !!page.is_urgent;
    if (type === 'notes') return (page.note_count || 0) > 0;
    if (type === 'unseen') return !page.completed_at;
    if (type === 'completed') return !!page.completed_at;
    if (type === 'topic') return pageTopics(page).some(topic => topic.toLowerCase() === value.toLowerCase());
    if (type === 'domain') return pageDomain(page) === value;
    return true;
  });
}
