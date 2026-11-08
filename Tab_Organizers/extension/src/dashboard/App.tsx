import { applyLibraryFilters, LibraryFilters, emptyFilters } from '../lib/page-filters';
import React, { useState, useEffect, useRef } from 'react';
import { Library } from './pages/Library';
import { LibrarySelection } from './components/LibrarySelection';
import { TimeTracking } from './pages/TimeTracking';
import { Brain } from './pages/Brain';
import { GraphView } from './pages/GraphView';
import { Settings } from './pages/Settings';
import { SavedGroups } from './pages/SavedGroups';
import { PageDetail } from './pages/PageDetail';
import { apiClient } from '../lib/api-client';
import { PageData } from '../types';
import { useLibrarySearch } from './useLibrarySearch';
import { getBackendConnection, LOCAL_BACKEND } from '../lib/backend-connection';
import { cacheForBackend,onDeviceSync,pendingSaves,PendingSave } from '../lib/outbox';
import { deviceChange } from '../lib/device-store';
import { SyncStatus } from './components/SyncStatus';
import { Notes } from './pages/Notes';
import { RecycleBin } from './components/RecycleBin';
import { ResourceSearch } from './components/ResourceSearch';
import { normalizeUrl } from '../lib/url-normalize';

type NavTab = 'home' | 'library' | 'groups' | 'sessions' | 'notes' | 'time' | 'graph' | 'settings';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<NavTab>('home');
  const [selectedPageId, setSelectedPageId] = useState<number | null>(null);
  const [selectedNoteId,setSelectedNoteId]=useState<string>();
  const [pendingJobs,setPendingJobs]=useState<PendingSave[]>([]);
  const [showRemoved,setShowRemoved]=useState(false);
  const [undoItems,setUndoItems]=useState<string[]>([]);
  const [undoBusy,setUndoBusy]=useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filters,setFilters]=useState<LibraryFilters>({...emptyFilters});
  const [pages, setPages] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState(false);
  const hasLoaded = useRef(false);
  const pagesRequestActive = useRef(false);
  const libraryRevision = useRef(0);
  const pendingRemovals = useRef(new Set<number>());
  const [actionError, setActionError] = useState('');
  const [aiOpen, setAiOpen] = useState(false);
  const [cloudConnected,setCloudConnected]=useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const resourceDialogRef = useRef<HTMLDialogElement>(null);
  const aiDialogRef = useRef<HTMLDialogElement>(null);
  const originRef = useRef<DOMRect | null>(null);
  const focusOriginRef = useRef<HTMLElement | null>(null);
  const closingRef = useRef(false);

  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(()=>{
    const update=()=>{libraryRevision.current++;void pendingSaves().then(setPendingJobs);void loadPages();};
    void pendingSaves().then(setPendingJobs);return onDeviceSync(update);
  },[]);

  useEffect(() => {
    getBackendConnection().then(connection=>setCloudConnected(connection.url!==LOCAL_BACKEND)).catch(()=>{});
    const savedTheme = (localStorage.getItem('karlx-theme') as 'dark' | 'light') || 'dark';
    setTheme(savedTheme);
    document.documentElement.setAttribute('data-theme', savedTheme);

    const handleHash = () => {
      const h = window.location.hash;
      setSearchQuery('');
      setFilters({...emptyFilters});
      setSelectedPageId(null); setSelectionMode(false); setSelectedIds(new Set());
      if (h === '#sessions') {
        setActiveTab('sessions');
      } else if (h === '#notes') {
        setActiveTab('notes');
        setFilters({...emptyFilters,hasNotes:true});
      } else if (h === '#brain') {
        setActiveTab('library');
        setAiOpen(true);
      } else if (h === '#groups' || h === '#saved-groups') {
        setActiveTab('groups');
      } else {
        const tab = h.slice(1) as NavTab;
        setActiveTab(['home', 'library', 'time', 'graph', 'settings'].includes(tab) ? tab : 'home');
      }
    };
    handleHash();
    window.addEventListener('hashchange', handleHash);

    loadPages();

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !target.closest('input, textarea, select, [contenteditable="true"]')) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('focus', loadPages);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('focus', loadPages);
      window.removeEventListener('hashchange', handleHash);
    };
  }, []);

  async function loadPages() {
    if (pagesRequestActive.current) return;
    pagesRequestActive.current = true;
    const revision = libraryRevision.current;
    // Focus returns from the snipping tool too. Keep the mounted grid and its
    // scroll anchor while refreshing existing data; show a loader only initially.
    if (!hasLoaded.current) setLoading(true);
    setLoadError(false);
    try {
      if(!hasLoaded.current){const cached=await cacheForBackend<any[]>('library');if(cached?.length){setPages(cached);hasLoaded.current=true;setLoading(false);}}
      const data: any[] = [];
      for (let offset = 0; ; offset += 300) {
        const batch = await apiClient.get<any[]>(`/api/pages?limit=300&offset=${offset}`);
        if (!Array.isArray(batch)) throw new Error('Invalid library response');
        data.push(...batch);
        if (batch.length < 300) break;
      }
      // A refresh begun before a deletion may still contain that resource.
      if (revision !== libraryRevision.current) return;
      const visible = data.filter(page => !pendingRemovals.current.has(page.id));
      setPages(previous => JSON.stringify(previous) === JSON.stringify(visible) ? previous : visible);
      await cacheForBackend('library',data);
      hasLoaded.current = true;


    } catch {
      setLoadError(true);
    } finally {
      pagesRequestActive.current = false;
      setLoading(false);
      if(revision!==libraryRevision.current)queueMicrotask(()=>void loadPages());
    }
  }

  const handleToggleImportant = async (pageId: number, currentVal: boolean) => {
    const newVal = !currentVal;
    setPages(prev => prev.map(p => p.id === pageId ? { ...p, is_important: newVal } : p));
    try {
      await apiClient.put(`/api/pages/${pageId}`, { is_important: newVal });
    } catch (err) {
      console.error('Failed to update important flag', err);
      loadPages();
    }
  };

  const handleToggleUrgent = async (pageId: number, currentVal: boolean) => {
    const newVal = !currentVal;
    setPages(prev => prev.map(p => p.id === pageId ? { ...p, is_urgent: newVal } : p));
    try {
      await apiClient.put(`/api/pages/${pageId}`, { is_urgent: newVal });
    } catch (err) {
      console.error('Failed to update urgent flag', err);
      loadPages();
    }
  };

  const handleDeletePages = async (ids: number[]): Promise<number[]> => {
    const removed = new Set(ids);
    const originals = pages.map((page, index) => ({ page, index })).filter(item => removed.has(item.page.id));
    ids.forEach(id => pendingRemovals.current.add(id));
    libraryRevision.current++;
    setActionError('');
    setPages(previous => previous.filter(page => !removed.has(page.id)));
    const failed: number[] = [];
    const recovery:string[]=[];
    // Bound concurrent writes instead of flooding the hosted database on a
    // large selection. Visual removal does not wait for these requests.
    const queue = [...ids];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const id = queue.shift()!;
        try { const result=await apiClient.delete<{recycle_id?:string}>(`/api/pages/${id}`);if(result?.recycle_id)recovery.push(result.recycle_id); }
        catch { failed.push(id); }
      }
    }));
    libraryRevision.current++;
    if(recovery.length)setUndoItems(previous=>[...previous,...recovery]);
    ids.forEach(id => pendingRemovals.current.delete(id));
    const deleted=new Set(ids.filter(id=>!failed.includes(id)));
    if(deleted.size){
      const connection=await getBackendConnection();
      const removedUrls=new Set(originals.filter(item=>deleted.has(item.page.id)).map(item=>normalizeUrl(item.page.url_original)));
      const survivingUrls=new Set(pages.filter(page=>!deleted.has(page.id)).map(page=>normalizeUrl(page.url_original)));
      await Promise.all([
        deviceChange<any[]>('cache',JSON.stringify([connection.url,'library']),current=>current?.filter(page=>!deleted.has(page.id))),
        deviceChange<any[]>('cache',JSON.stringify([connection.url,'notes']),current=>current?.filter(note=>!deleted.has(note.page_id))),
        deviceChange<any[]>('cache',JSON.stringify([connection.url,'saved-status']),current=>current?.filter(page=>!removedUrls.has(normalizeUrl(page.url_original))||survivingUrls.has(normalizeUrl(page.url_original)))),
        deviceChange<any>('cache',JSON.stringify([connection.url,'graph']),current=>{
          if(!current)return current;
          const nodes=current.nodes.filter((node:any)=>!deleted.has(node.page_id)),keep=new Set(nodes.map((node:any)=>node.id));
          const edges=current.edges.filter((edge:any)=>keep.has(edge.source)&&keep.has(edge.target));
          return {...current,nodes,edges,total_nodes:nodes.length,total_edges:edges.length,resource_count:nodes.filter((node:any)=>node.type==='page').length};
        }),
      ]).catch(()=>{});
    }
    if (failed.length) {
      setPages(previous => {
        const restored = [...previous];
        originals.filter(item => failed.includes(item.page.id)).forEach(({ page, index }) => {
          if (!restored.some(item => item.id === page.id)) restored.splice(Math.min(index, restored.length), 0, page);
        });
        return restored;
      });
      setActionError(`Could not remove ${failed.length} resource${failed.length === 1 ? '' : 's'}. Restored them to your library; please retry.`);
    }
    return failed;
  };
  const handleDelete = (pageId: number) => { void handleDeletePages([pageId]); };

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('karlx-theme', next);
    document.documentElement.setAttribute('data-theme', next);
  };

  const applyPageUpdates = (updates: PageData[]) => {
    const byId = new Map(updates.map(page => [page.id, page]));
    setPages(previous => previous.map(page => byId.has(page.id) ? { ...page, ...byId.get(page.id) } : page));
  };

  const availablePages=React.useMemo(()=>{
    let result=[...pages];
    for(const job of pendingJobs){
      if(job.kind==='remove-page'){result=result.filter(page=>normalizeUrl(page.url_original)!==normalizeUrl(job.payload.url));continue;}
      if(!['page','note'].includes(job.kind))continue;
      const url=job.kind==='note'?job.payload.video_url:job.payload.url_original;
      if(!url)continue;
      const normalized=normalizeUrl(job.payload.url_normalized||url),index=result.findIndex(page=>normalizeUrl(page.url_normalized)===normalized);
      if(index<0){let hash=0;for(const letter of normalized)hash=(hash*31+letter.charCodeAt(0))>>>0;
        result.push({id:-(hash+1),...job.payload,url_original:url,url_normalized:normalized,title:job.payload.title||job.payload.video_title,description:'',favicon_url:job.payload.favicon_url||'',pendingSync:true});}
      else if(job.kind==='page')result[index]={...result[index],pendingSync:true};
    }
    return result;
  },[pages,pendingJobs]);
  const librarySearch = useLibrarySearch(availablePages, searchQuery);
  const filtered = applyLibraryFilters(librarySearch.pages, filters);
  const isLibrary = ['home', 'library', 'notes'].includes(activeTab);
  const titles: Record<NavTab, string> = { home: 'Library', library: 'Library', groups: 'Collections', sessions: 'Sessions', notes: 'Notes', time: 'Activity', graph: 'Your knowledge', settings: 'Settings' };
  const subtitles: Record<NavTab, string> = { home: 'A little less scattered. A little more yours.', library: 'A little less scattered. A little more yours.', groups: 'Keep the threads of an idea together.', sessions: 'A place to leave off. A way to come back.', notes: 'The things you wanted to remember.', time: 'What you finished. Where your attention went.', graph: 'Follow a thought. See what connects.', settings: 'Make this space work your way.' };

  const handleNavClick = (tab: NavTab) => {
    setSearchQuery('');
    setSelectedPageId(null);
    setActiveTab(tab);
    setAiOpen(false);
    setFilters({...emptyFilters});
    window.location.hash = tab;
    if (tab === 'home' || tab === 'library' || tab === 'notes') loadPages();
  };

  const updateSearch = (value: string) => {
    setSearchQuery(value);
    if (!isLibrary) {
      // Typing starts a new library search; explicit navigation clears it.
      setActiveTab('library'); setFilters({...emptyFilters});
      setSelectionMode(false); setSelectedIds(new Set());
      window.history.replaceState(null, '', '#library');
      loadPages();
    }
  };

  const openResource = (id: number) => {
    setSelectedNoteId(undefined);
    const card = document.querySelector<HTMLElement>(`[data-page-id="${id}"]`);
    originRef.current = card?.getBoundingClientRect() || null;
    focusOriginRef.current = card || document.activeElement as HTMLElement;
    closingRef.current = false;
    setSelectedPageId(id);
  };

  const undoRemoval=async()=>{
    setUndoBusy(true);const failed:string[]=[];
    for(const id of undoItems)try{await apiClient.post(`/api/recycle-bin/${id}/restore`,{});}catch{failed.push(id);}
    setUndoItems(failed);setUndoBusy(false);void loadPages();
    if(failed.length)setActionError('Some items could not be restored. They remain available in Removed items until their recovery period expires.');
  };

  const cardTransform = (dialog: HTMLDialogElement) => {
    const origin = originRef.current;
    const box = dialog.getBoundingClientRect();
    if (!origin || !box.width || !box.height) return 'translateY(12px) scale(.97)';
    return `translate(${origin.x + origin.width / 2 - box.x - box.width / 2}px, ${origin.y + origin.height / 2 - box.y - box.height / 2}px) scale(${Math.min(1, origin.width / box.width)}, ${Math.min(1, origin.height / box.height)})`;
  };

  const closeResource = () => {
    const dialog = resourceDialogRef.current;
    if (!dialog?.open || closingRef.current) return;
    closingRef.current = true;
    const finish = () => {
      dialog.close();
      setSelectedPageId(null);
      closingRef.current = false;
      focusOriginRef.current?.focus({ preventScroll: true });
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return finish();
    dialog.classList.add('is-closing');
    dialog.animate([{ transform: 'none', opacity: 1 }, { transform: cardTransform(dialog), opacity: 0 }], { duration: 240, easing: 'cubic-bezier(.4,0,.7,1)', fill: 'forwards' }).finished.then(finish, finish);
  };

  useEffect(() => {
    const dialog = resourceDialogRef.current;
    if (selectedPageId === null) { if (dialog?.open) dialog.close(); return; }
    if (!dialog) return;
    dialog.getAnimations().forEach(animation => animation.cancel());
    dialog.classList.remove('is-closing');
    if (!dialog.open) dialog.showModal();
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      dialog.animate([{ transform: cardTransform(dialog), opacity: .2 }, { transform: 'none', opacity: 1 }], { duration: 360, easing: 'cubic-bezier(.2,.75,.2,1)' });
    }
  }, [selectedPageId]);

  useEffect(() => {
    const dialog = aiDialogRef.current;
    if (aiOpen && dialog && !dialog.open) dialog.showModal();
    if (!aiOpen && dialog?.open) dialog.close();
  }, [aiOpen]);

  const outsideDialog = (event: React.MouseEvent<HTMLDialogElement>, close: () => void) => {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
  };

  const navItems: { tab: NavTab; label: string; icon: string }[] = [
    { tab: 'library', label: 'Library', icon: 'grid' },
    { tab: 'groups', label: 'Collections', icon: 'layers' },
    { tab: 'sessions', label: 'Sessions', icon: 'window' },
    { tab: 'notes', label: 'Notes', icon: 'note' },
    { tab: 'time', label: 'Activity', icon: 'activity' },
  ];

  return (
    <div className={`dashboard-layout workspace-shell ${collapsed ? 'workspace-compact' : ''}`}>
      <aside className={`sidebar workspace-rail ${collapsed ? 'collapsed' : ''}`} aria-label="Main navigation">
        <button className="workspace-brand" onClick={() => handleNavClick('library')} aria-label="Open library" title="Your workspace">
          <img src="/public/icons/icon48.png" alt="" />
          <span>Karl X<small>Your corner of the internet.</small></span>
        </button>
        <nav className="workspace-nav">
          {navItems.map(item => <button key={item.tab} className={`nav-item ${activeTab === item.tab || item.tab === 'library' && (activeTab === 'home' || activeTab === 'graph') ? 'active' : ''}`} aria-current={activeTab === item.tab || item.tab === 'library' && (activeTab === 'home' || activeTab === 'graph') ? 'page' : undefined} onClick={() => handleNavClick(item.tab)} title={item.label}>
            <Icon name={item.icon} /><span className="label">{item.label}</span>
          </button>)}
        </nav>
        <div className="workspace-rail-bottom">
          <span className="workspace-local">{cloudConnected?'Cloud workspace':'Local workspace'}</span>
          <button className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`} aria-current={activeTab === 'settings' ? 'page' : undefined} onClick={() => handleNavClick('settings')} title="Settings"><Icon name="settings" /><span className="label">Settings</span></button>
        </div>
      </aside>
      <div className="main workspace-main">
        <header className="workspace-topbar">
          <button className="icon-btn workspace-sidebar-toggle" onClick={() => setCollapsed(!collapsed)} title="Toggle navigation" aria-label="Toggle navigation" aria-expanded={!collapsed}><Icon name="sidebar" /></button>
          <ResourceSearch inputRef={searchInputRef} value={searchQuery} onChange={updateSearch} onTopic={topic=>setFilters(current=>({...current,topic}))} topic={filters.topic} pages={availablePages} enabled={activeTab==='home'||activeTab==='library'} />
          <div className="header-right workspace-top-actions">
            <button className="icon-btn" id="theme-toggle" onClick={toggleTheme} title="Switch theme" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}><Icon name="theme" /></button>
            <button className="workspace-ai-button" onClick={() => setAiOpen(true)}><Icon name="sparkles" /><span>Ask Karl</span></button>
          </div>
        </header>
        {isLibrary&&<div className="recovery-shortcut"><button className="pill" onClick={()=>setShowRemoved(value=>!value)}>Removed items</button></div>}
        {showRemoved&&<RecycleBin onRestored={loadPages}/>}
        <div className="workspace-page-head"><div><h1>{titles[activeTab]}</h1><p>{subtitles[activeTab]}</p></div><span className="workspace-resource-count">{isLibrary && <><strong>{pages.length}</strong><span>saved resources</span></>}</span></div>
        {activeTab === 'graph' && <div className="workspace-view-tools">
          <button className="workspace-view-toggle" onClick={() => handleNavClick(activeTab === 'graph' ? 'library' : 'graph')} title={activeTab === 'graph' ? 'Show grid view' : 'Show map view'} aria-label={activeTab === 'graph' ? 'Show grid view' : 'Show map view'}><Icon name={activeTab === 'graph' ? 'grid' : 'map'} /></button>
        </div>}
        <SyncStatus/>
        {!!undoItems.length&&<div className="sync-status" role="status"><span>Moved {undoItems.length} resource{undoItems.length===1?'':'s'} to the five-day recycle bin.</span><button className="pill" disabled={undoBusy} onClick={()=>void undoRemoval()}>{undoBusy?'Restoring…':'Undo removal'}</button><button className="pill" onClick={()=>setUndoItems([])}>Dismiss</button></div>}
        {loadError && isLibrary && <div className="connection-notice" role="alert"><span>Can’t connect to your library. Check the backend connection in Settings.</span><button className="pill" onClick={loadPages}>Retry connection</button></div>}
        {actionError && isLibrary && <div className="connection-notice" role="alert"><span>{actionError}</span><button className="pill" onClick={() => setActionError('')}>Dismiss</button></div>}
        <div className="workspace-content">
          {activeTab==='notes'&&<Notes pages={availablePages} query={searchQuery} onOpen={(id,noteId)=>{openResource(id);setSelectedNoteId(noteId);}}/>}
          {((isLibrary&&activeTab!=='notes') || activeTab === 'sessions') && <Library view={activeTab === 'sessions' ? 'sessions' : 'library'} toolbarActions={<><LibrarySelection active={selectionMode} onActiveChange={setSelectionMode} selected={selectedIds} onSelectionChange={setSelectedIds} pages={pages} visibleIds={filtered.map(p => p.id).filter(id=>id>0)} onDeletePages={handleDeletePages} onPagesUpdated={applyPageUpdates} /><button className="workspace-view-toggle" onClick={() => handleNavClick('graph')} title="Show map view" aria-label="Show map view"><Icon name="map" /></button></>} filteredPages={filtered} searchStatus={librarySearch} searchQuery={searchQuery} setSearchQuery={setSearchQuery} filters={filters} setFilters={setFilters} pages={availablePages} loading={loading} onRefresh={loadPages} onToggleImportant={handleToggleImportant} onToggleUrgent={handleToggleUrgent} onDelete={id=>{const page=availablePages.find(page=>page.id===id);if(id<0&&page)void import('../lib/outbox').then(module=>module.removeSavedUrl(page.url_original));else handleDelete(id);}} onSelectPage={openResource} onCompletionUpdated={page => applyPageUpdates([page])} selectionMode={selectionMode} selectedIds={selectedIds} onToggleSelection={id => setSelectedIds(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; })} />}
          {activeTab === 'groups' && <div className="subpage-container"><SavedGroups /></div>}
          {activeTab === 'time' && <div className="subpage-container"><TimeTracking onSelectPage={openResource} /></div>}
          {activeTab === 'graph' && <div className="subpage-container"><GraphView onSelectPage={openResource} /></div>}
          {activeTab === 'settings' && <div className="subpage-container"><Settings onReclassified={loadPages} /></div>}
        </div>
      </div>
      <dialog ref={resourceDialogRef} className="workspace-dialog workspace-resource-dialog" aria-label="Saved resource" onCancel={event => { event.preventDefault(); closeResource(); }} onClick={event => outsideDialog(event, closeResource)} onClose={() => setSelectedPageId(null)}>
        <div className="workspace-dialog-bar"><span>Saved resource</span><div className="workspace-dialog-actions"><button onClick={closeResource} title="Minimize resource" aria-label="Minimize resource"><Icon name="minimize" /></button><button onClick={closeResource} title="Close resource" aria-label="Close resource"><Icon name="close" /></button></div></div>
        <div className="workspace-dialog-body">{selectedPageId !== null && <PageDetail key={selectedPageId} pageId={selectedPageId} initialNoteId={selectedNoteId} onBack={closeResource} onRefresh={loadPages} />}</div>
      </dialog>
      <dialog ref={aiDialogRef} className="workspace-dialog workspace-ai-dialog" aria-label="Ask Karl" onCancel={event => { event.preventDefault(); setAiOpen(false); }} onClick={event => outsideDialog(event, () => setAiOpen(false))} onClose={() => setAiOpen(false)}>
        <div className="workspace-dialog-bar"><span><Icon name="sparkles" /> Ask Karl</span><div className="workspace-dialog-actions"><button onClick={() => setAiOpen(false)} aria-label="Close Ask Karl"><Icon name="close" /></button></div></div>
        <div className="workspace-dialog-body">{aiOpen && <Brain />}</div>
      </dialog>
    </div>
  );
};

function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
    window: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></>,
    note: <><path d="M14 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9M8 7h3M8 12h3M8 17h8m1-14 4 4-7 7h-4v-4l7-7Z" /></>,
    activity: <><path d="M4 20V10m5 10V5m6 15V12m5 8V3" /></>,
    settings: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="8" cy="18" r="2" /></>,
    sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
    theme: <><circle cx="12" cy="12" r="8" /><path d="M12 4v16" /></>,
    sparkles: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4m-2-2h4" /></>,
    map: <><path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5ZM9 3v16m6-14v16" /></>,
    external: <><path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" /></>,
    minimize: <path d="M5 15h14" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.grid}</svg>;
}

export default App;
