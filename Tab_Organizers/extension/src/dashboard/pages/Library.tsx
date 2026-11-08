import React, { useState, useEffect } from 'react';
import { PageCard } from '../components/PageCard';
import { apiClient } from '../../lib/api-client';
import { PageData } from '../../types';
import { LibraryFilters, emptyFilters } from '../../lib/page-filters';
import { VirtualPageGrid } from '../components/VirtualPageGrid';
import { SessionRecovery } from '../components/SessionRecovery';

interface LibraryProps {
  view?: 'library' | 'sessions';
  toolbarActions?: React.ReactNode;
  selectionMode?: boolean;
  selectedIds?: Set<number>;
  onToggleSelection?: (id: number) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  filters: LibraryFilters;
  setFilters: React.Dispatch<React.SetStateAction<LibraryFilters>>;
  pages: any[];
  filteredPages: any[];
  searchStatus: { pending: boolean; error: boolean; interpreted: string; mode: string };
  loading: boolean;
  onRefresh: () => void;
  onToggleImportant: (pageId: number, currentVal: boolean) => void;
  onToggleUrgent: (pageId: number, currentVal: boolean) => void;
  onDelete: (pageId: number) => void;
  onSelectPage?: (pageId: number) => void;
  onCompletionUpdated?: (page: PageData) => void;
}

export const Library: React.FC<LibraryProps> = ({
  view = 'library',
  toolbarActions,
  selectionMode,
  selectedIds,
  onToggleSelection,
  searchQuery,
  setSearchQuery,
  onRefresh,
  filters,
  setFilters,
  pages,
  filteredPages,
  searchStatus,
  loading,
  onToggleImportant,
  onToggleUrgent,
  onDelete,
  onSelectPage,
  onCompletionUpdated,
}) => {
  const [grouped, setGrouped] = useState(() => localStorage.getItem('karlx-library-grouped') === 'true');
  const [browserSessions, setBrowserSessions] = useState<any[]>([]);
  const [reincarnatingId, setReincarnatingId] = useState<string | null>(null);

  useEffect(() => {
    loadBrowserSessions();
  }, []);

  async function loadBrowserSessions() {
    try {
      chrome.runtime.sendMessage({ type: 'GET_ALL_BROWSER_SESSIONS' }, (res) => {
        if (res && res.sessions && res.sessions.length > 0) {
          setBrowserSessions(res.sessions);
        }
      });
    } catch {
      try {
        const res = await apiClient.get<any>('/api/windows/browser-sessions');
        if (res && res.sessions) setBrowserSessions(res.sessions);
      } catch {}
    }
  }

  const handleReincarnate = (session: any) => {
    if (!chrome?.runtime?.sendMessage) return;
    setReincarnatingId(session.session_id);
    chrome.runtime.sendMessage({
      type: 'REINCARNATE_BROWSER_SESSION',
      session
    }, (res) => {
      setReincarnatingId(null);
      if (res?.success) {
        setBrowserSessions(prev => prev.filter(s => s.session_id !== session.session_id));
      }
    });
  };

  const handleDismiss = (sessionId: string) => {
    setBrowserSessions(prev => prev.filter(s => s.session_id !== sessionId));
    if (chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'DELETE_BROWSER_SESSION', sessionId });
    } else {
      apiClient.delete(`/api/windows/browser-sessions/${sessionId}`).catch(loadBrowserSessions);
    }
  };

  // Derive domains and topics
  const domainCounts = new Map<string, number>();



  pages.forEach(p => {


    const domain = p.domain || (p.url_original ? (() => {
      try { return new URL(p.url_original).hostname.replace(/^www\./, ''); } catch { return ''; }
    })() : '');
    if (domain) domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);

  });


  const topDomains = Array.from(domainCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([domain, count]) => ({ domain, count }));

  // Filtering
  const filtered = filteredPages;

  return (
    <>
      {browserSessions.length > 0 && <SessionRecovery sessions={browserSessions} restoring={reincarnatingId} onRestore={handleReincarnate} onDismiss={handleDismiss}/>}

      {view === 'sessions' && browserSessions.length === 0 && (
        <div className="empty-state sessions-empty-state">
          <h2>No saved sessions yet</h2>
          <p>Recently closed browser windows will appear here so you can restore their tabs and groups. Open this workspace from the extension to recover a session.</p>
          <button className="pill" onClick={loadBrowserSessions}>Check for sessions</button>
        </div>
      )}
      {view === 'library' && <>
      <div className="library-toolbar">
        <div className="library-toolbar-filters pill-row" id="chips" aria-label="Filter library">
          {(['all','unseen','completed'] as const).map(status=><button key={status} className={`pill ${filters.status===status?'active':''}`} aria-pressed={filters.status===status} onClick={()=>setFilters(current=>({...current,status}))}>{status==='all'?'Everything':status==='unseen'?'Unseen':'Completed'}</button>)}
          {([['hasNotes','Has notes'],['important','Important'],['urgent','Urgent']] as const).map(([key,label])=><button key={key} className={`pill ${filters[key]?'active':''}`} aria-pressed={filters[key]} onClick={()=>setFilters(current=>({...current,[key]:!current[key]}))}>{label}</button>)}
        </div>
        <div className="library-toolbar-actions">
          <label className="library-domain-filter"><select aria-label="Filter by website" value={filters.domain} onChange={event=>setFilters(current=>({...current,domain:event.target.value}))}><option value="">All websites</option>{topDomains.map(({domain,count})=><option key={domain} value={domain}>{domain} ({count})</option>)}</select></label>
          <button className="pill library-view-toggle" aria-pressed={grouped}
            title={grouped ? 'Show all resources together' : 'Arrange resources by topic'}
            onClick={() => {
              const next = !grouped; setGrouped(next); localStorage.setItem('karlx-library-grouped', String(next));
            }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg>
            {grouped ? 'Grouped' : 'Group'}
          </button>
          {toolbarActions}
        </div>
      </div>

      {(filters.topic||filters.domain||filters.status!=='all'||filters.hasNotes||filters.important||filters.urgent)&&<div className="active-filters" aria-label="Active filters">{Object.entries(filters).filter(([key,value])=>value&&!(key==='status'&&value==='all')).map(([key,value])=><button className="pill" key={key} onClick={()=>setFilters(current=>({...current,[key]:emptyFilters[key as keyof LibraryFilters]}))}>{key==='hasNotes'?'Has notes':value===true?key:String(value)} ×</button>)}<button className="pill" onClick={()=>setFilters({...emptyFilters})}>Clear filters</button></div>}
      {/* Grid */}
      {searchQuery.trim() && <div className="library-search-status" role="status">
        <span>{searchStatus.pending ? 'Finding related resources…' : searchStatus.error ? 'Related search unavailable. Text matches are ranked first.' : searchStatus.mode === 'semantic' ? 'Ranked by meaning and text relevance' : 'Ranked by related topics and text'}</span>
        {searchStatus.interpreted && searchStatus.interpreted.toLowerCase() !== searchQuery.trim().toLowerCase() && <span>Interpreted as “{searchStatus.interpreted}”</span>}
        <small>All {filtered.length} resources in this view remain available.</small>
      </div>}
      <div className="library-content" id="grid">
        {loading ? (
          <div className="empty-state">
            <p role="status">Loading your saved tabs...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <h2>{pages.length === 0 ? 'Your library starts here' : 'No matching tabs'}</h2><p>{pages.length === 0 ? 'Save tabs from the extension popup to keep them here.' : 'Try a different search or clear your filters.'}</p>
            {(searchQuery || JSON.stringify(filters)!==JSON.stringify(emptyFilters)) && (
              <button
                onClick={() => {
                  setSearchQuery('');
                  setFilters({...emptyFilters});
                }}
              >
                Show all tabs
              </button>
            )}
          </div>
        ) : (
          <VirtualPageGrid pages={filtered} grouped={grouped} render={p=><PageCard key={p.id||p.url_normalized} page={p} onToggleImportant={onToggleImportant} relevance={searchQuery.trim()?(p as any).search_score:undefined} onToggleUrgent={onToggleUrgent} onDelete={onDelete} onSelectPage={onSelectPage} selectionMode={selectionMode} selected={selectedIds?.has(p.id!)} onToggleSelection={onToggleSelection} onCompletionUpdated={onCompletionUpdated}/>}/>

        )}
      </div>

      <footer className="library-footer">
        <button className="pill" onClick={onRefresh}>Refresh library</button>
        <span>{filtered.length} resource{filtered.length === 1 ? '' : 's'}{JSON.stringify(filters)!==JSON.stringify(emptyFilters) || searchQuery ? ` of ${pages.length}` : ''}</span>
      </footer>
      </>}
    </>
  );
};
