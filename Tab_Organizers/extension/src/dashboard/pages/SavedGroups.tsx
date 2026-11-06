import React, { useState, useEffect, useRef } from 'react';
import './tools.css';
import { ToolIcon } from './ToolIcon';
import { SiteIcon } from '../components/SiteIcon';
import { cacheForBackend,onDeviceSync,pendingSaves,saveOnDevice } from '../../lib/outbox';
import { apiClient } from '../../lib/api-client';
import {
  getNextContrastingGroupColor,
  markGroupColorUsed,
  VALID_GROUP_COLORS,
  getChromeColorHex
} from '../../lib/group-colors';

interface ChromeGroupItem {
  group: any;
  tabs: any[];
}

export const SavedGroups: React.FC = () => {
  const [activeSubtab, setActiveSubtab] = useState<'saved' | 'unsaved'>('saved');
  const [groups, setGroups] = useState<any[]>([]);
  const [unsavedChromeGroups, setUnsavedChromeGroups] = useState<ChromeGroupItem[]>([]);
  const [allOpenChromeTabs, setAllOpenChromeTabs] = useState<any[]>([]);
  const loaded=useRef(false), refreshing=useRef(false);
  const [refreshError,setRefreshError]=useState('');
  const [loading, setLoading] = useState<boolean>(true);
  const [search, setSearch] = useState<string>('');
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const [savingGroupId, setSavingGroupId] = useState<number | null>(null);
  const [expandedGroupId, setExpandedGroupId] = useState<number | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // New Group Modal State
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);
  const [newGroupName, setNewGroupName] = useState<string>('');
  const [newGroupColor, setNewGroupColor] = useState<string>('blue');
  const [selectedTabIdsForNewGroup, setSelectedTabIdsForNewGroup] = useState<number[]>([]);

  useEffect(() => {
    loadAllData();

    let timer:ReturnType<typeof setTimeout>;
    const onChromeEvent = (_id?:unknown,change?:unknown) => {
      if(change&&typeof change==='object'&&!('isWindowClosing' in change)&&!('url' in change||'title' in change||'groupId' in change))return;
      clearTimeout(timer);timer=setTimeout(()=>void loadAllData(),250);
    };
    const stop=onDeviceSync(()=>void loadAllData());

    if (typeof chrome !== 'undefined') {
      chrome.tabs?.onCreated?.addListener(onChromeEvent);
      chrome.tabs?.onRemoved?.addListener(onChromeEvent);
      chrome.tabs?.onUpdated?.addListener(onChromeEvent);
      chrome.tabGroups?.onCreated?.addListener(onChromeEvent);
      chrome.tabGroups?.onRemoved?.addListener(onChromeEvent);
      chrome.tabGroups?.onUpdated?.addListener(onChromeEvent);
    }

    return () => {
      clearTimeout(timer);stop();
      if (typeof chrome !== 'undefined') {
        chrome.tabs?.onCreated?.removeListener(onChromeEvent);
        chrome.tabs?.onRemoved?.removeListener(onChromeEvent);
        chrome.tabs?.onUpdated?.removeListener(onChromeEvent);
        chrome.tabGroups?.onCreated?.removeListener(onChromeEvent);
        chrome.tabGroups?.onRemoved?.removeListener(onChromeEvent);
        chrome.tabGroups?.onUpdated?.removeListener(onChromeEvent);
      }
    };
  }, []);

  function showToast(msg: string) {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3000);
  }

  async function loadAllData() {
    if(refreshing.current)return;refreshing.current=true;
    if(!loaded.current)setLoading(true);
    try {
      let savedList:any[]=await cacheForBackend<any[]>('groups')||[];
      if(!loaded.current&&savedList.length){setGroups(savedList);setLoading(false);}
      try {
        savedList=await apiClient.get<any[]>('/api/groups');await cacheForBackend('groups',savedList);setRefreshError('');
      }catch{setRefreshError('Showing device copies. Collections will update when connected.');}
      const pending=(await pendingSaves()).filter(job=>job.kind==='group');
      const signature=(tabs:any[])=>tabs.map(tab=>tab.url||tab.url_original).sort().join('\n');
      savedList=[...pending.filter(job=>!savedList.some(group=>group.name===job.payload.name&&signature(group.tabs||[])===signature(job.payload.tabs))).map(job=>({...job.payload,id:'pending:'+job.payload.client_id,tab_count:job.payload.tabs.length,pendingSync:true})),...savedList];
      setGroups(previous=>JSON.stringify(previous)===JSON.stringify(savedList)?previous:savedList);
      // Purge legacy custom_unsaved_groups to prevent ghost groups
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.remove(['custom_unsaved_groups']);
      }

      // Query active Chrome tab groups and tabs
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabGroups) {
        try {
          const [cGroups, cTabs] = await Promise.all([
            chrome.tabGroups.query({}),
            chrome.tabs.query({})
          ]);

          setAllOpenChromeTabs(cTabs);

          const unsaved: ChromeGroupItem[] = [];
          for (const cg of cGroups) {
            const tabsInGroup = cTabs.filter(t => t.groupId === cg.id);
            if (tabsInGroup.length === 0) continue;

            const cgTitle = (cg.title || '').trim().toLowerCase();
            const isSaved = savedList.some(sg => {
              const sgTitle = (sg.name || '').trim().toLowerCase();
              return cgTitle&&sgTitle&&cgTitle===sgTitle&&signature(sg.tabs||[])===signature(tabsInGroup);
            });

            if (!isSaved) {
              unsaved.push({ group: cg, tabs: tabsInGroup });
            }
          }
          setUnsavedChromeGroups(unsaved);
        } catch (e) {
          console.debug('Chrome tabs/groups not accessible:', e);
        }
      }
    } finally {
      loaded.current=true;refreshing.current=false;setLoading(false);
    }
  }

  function getChromeColor(colorName: string): string {
    return getChromeColorHex(colorName);
  }

  const handleRestore = async (group: any) => {
    setRestoringId(group.id);
    try {
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabGroups) {
        const rawTabs: any[] = group.tabs || [];
        const validTabs = rawTabs.filter(t => t && t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));
        if (validTabs.length === 0) {
          throw new Error('No valid web URLs in this group');
        }

        const currentWin = await chrome.windows.getLastFocused({ populate: false });
        const windowId = currentWin?.id;

        const createResults = await Promise.allSettled(
          validTabs.map(t => chrome.tabs.create({ windowId, url: t.url, active: false }))
        );

        const createdTabIds: number[] = [];
        for (const res of createResults) {
          if (res.status === 'fulfilled' && res.value?.id) {
            createdTabIds.push(res.value.id);
          }
        }

        if (createdTabIds.length === 0) {
          throw new Error('Chrome could not create any tabs');
        }

        const groupId = await chrome.tabs.group({
          tabIds: createdTabIds
        });

        let safeColor = VALID_GROUP_COLORS.includes(group.color) ? group.color : '';
        if (!safeColor) {
          safeColor = await getNextContrastingGroupColor();
          await markGroupColorUsed(safeColor);
        }

        try {
          await chrome.tabGroups.update(groupId, {
            title: group.name || 'Saved Group',
            color: safeColor as any
          });
        } catch (colErr) {
          console.debug('Failed to update group styling:', colErr);
        }

        try {
          await chrome.tabs.update(createdTabIds[0], { active: true });
        } catch {}

        showToast(`✓ Restored "${group.name}" with ${createdTabIds.length} tabs in Chrome!`);
      } else {
        // Fallback: open tabs in regular browser windows
        const tabs: any[] = group.tabs || [];
        tabs.forEach(t => {
          if (t.url) window.open(t.url, '_blank');
        });
        showToast(`Opened ${tabs.length} tabs`);
      }
    } catch (err: any) {
      console.error('Failed to restore group', err);
      showToast(err?.message ? `Failed: ${err.message}` : 'Failed to restore group');
    } finally {
      setRestoringId(null);
    }
  };

  const handleSaveChromeGroup = async (item: ChromeGroupItem) => {
    setSavingGroupId(item.group.id);
    const tabsPayload = item.tabs.map(t => ({
      url: t.url || '',
      title: t.title || t.url || 'Untitled',
      favicon_url: t.favIconUrl || '',
      domain: t.url ? (() => { try { return new URL(t.url).hostname.replace(/^www\./, ''); } catch { return ''; } })() : ''
    }));

    const groupName = item.group.title || 'Chrome Group';
    const groupColor = item.group.color || 'blue';

    try {
      const job=await saveOnDevice('group',{name:groupName,color:groupColor,tabs:tabsPayload});
      const savedResult={...job.payload,id:'pending:'+job.payload.client_id,tab_count:tabsPayload.length,pendingSync:true};

      setGroups(prev => [savedResult, ...prev]);
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.get(['saved_tab_groups'], (res) => {
          const arr = res?.saved_tab_groups || [];
          arr.unshift(savedResult);
          chrome.storage.local.set({ saved_tab_groups: arr });
        });
      }
      setUnsavedChromeGroups(prev => prev.filter(x => x.group.id !== item.group.id));
      showToast(`Saved “${groupName}” on this device. Uploading when connected.`);
      setActiveSubtab('saved');
    } catch (err) {
      console.error('Failed to save Chrome group', err);
      showToast('Failed to save group');
    } finally {
      setSavingGroupId(null);
    }
  };

  const handleCreateNewGroupSubmit = async () => {
    if (!newGroupName.trim()) {
      showToast('Please enter a group name');
      return;
    }
    if (selectedTabIdsForNewGroup.length === 0) {
      showToast('Please select at least 1 tab');
      return;
    }

    try {
      // 1. Group in Chrome directly
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabGroups) {
        try {
          const groupId = await chrome.tabs.group({
            tabIds: selectedTabIdsForNewGroup
          });
          const safeColor = VALID_GROUP_COLORS.includes(newGroupColor as any) ? newGroupColor : 'blue';
          await chrome.tabGroups.update(groupId, {
            title: newGroupName.trim(),
            color: safeColor as any
          });
          await markGroupColorUsed(safeColor);
        } catch (e) {
          console.debug('Failed to group in Chrome', e);
        }
      }

      setShowCreateModal(false);
      setNewGroupName('');
      setSelectedTabIdsForNewGroup([]);
      setActiveSubtab('unsaved');
      showToast(`✓ Created group "${newGroupName.trim()}" in Chrome!`);
      loadAllData();
    } catch (err) {
      console.error('Failed to create group', err);
      showToast('Failed to create group');
    }
  };

  const handleExport = async (group: any) => {
    try {
      showToast(`Generating export for "${group.name}"...`);
      const res = await apiClient.post<{ html_content: string; item_count: number; title: string }>(
        `/api/groups/${group.id}/export`,
        {}
      );
      const blob = new Blob([res.html_content], { type: 'text/html;charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob);
      const filename = `${group.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_group.html`;

      if (typeof chrome !== 'undefined' && chrome.downloads) {
        await chrome.downloads.download({ url: blobUrl, filename, saveAs: true });
      } else {
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        a.click();
      }
      showToast(`✓ Exported "${group.name}"!`);
    } catch (err) {
      console.error('Export failed', err);
      showToast('Failed to export HTML');
    }
  };

  const handleDelete = async (groupId: number, groupName: string) => {
    try {
      await apiClient.delete(`/api/groups/${groupId}`);
    } catch {showToast('Could not remove this collection. It is still saved.');return;}
    const updated = groups.filter(g => g.id !== groupId);
    setGroups(updated);
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ saved_tab_groups: updated });
    }
    showToast(`✓ Deleted group "${groupName}"`);
    loadAllData();
  };

  const filteredSaved = groups.filter(g => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    if ((g.name || '').toLowerCase().includes(q)) return true;
    if (Array.isArray(g.tabs)) {
      return g.tabs.some((t: any) =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.url || '').toLowerCase().includes(q) ||
        (t.domain || '').toLowerCase().includes(q)
      );
    }
    return false;
  });

  const filteredUnsaved = unsavedChromeGroups.filter(item => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    if ((item.group.title || '').toLowerCase().includes(q)) return true;
    return item.tabs.some(t =>
      (t.title || '').toLowerCase().includes(q) ||
      (t.url || '').toLowerCase().includes(q)
    );
  });

  const colorPalette = VALID_GROUP_COLORS;

  const openCreate = async () => {
    const active = allOpenChromeTabs.find(tab => tab.active) || allOpenChromeTabs[0];
    setSelectedTabIdsForNewGroup(active?.id ? [active.id] : []);
    setNewGroupColor(await getNextContrastingGroupColor());
    setShowCreateModal(true);
  };
  const openLink = (tab: any, live: boolean) => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      if (live && tab.id !== undefined) chrome.tabs.update(tab.id, { active: true });
      else if (tab.url) chrome.tabs.create({ url: tab.url });
    } else if (tab.url) window.open(tab.url, '_blank', 'noopener,noreferrer');
  };
  const renderCard = (item: any, live: boolean) => {
    const group = live ? item.group : item;
    const tabs: any[] = live ? item.tabs : (Array.isArray(item.tabs) ? item.tabs : []);
    const name = live ? group.title || 'Untitled collection' : group.name || 'Untitled collection';
    const count = live ? tabs.length : group.tab_count ?? tabs.length;
    const isExpanded = expandedGroupId === group.id;
    return <article key={group.id} className="collection-card" style={{ '--collection-accent': getChromeColor(group.color || 'blue') } as React.CSSProperties}>
      <div className="collection-card-top"><span className="collection-kind"><i />{live ? 'Open in browser' : group.pendingSync?'Pending upload':'Saved collection'}</span>
        {!live&&!group.pendingSync && <details className="tool-more"><summary aria-label={`More actions for ${name}`}><ToolIcon name="more"/></summary><div className="tool-more-menu"><button onClick={() => handleDelete(group.id, name)} className="tool-danger"><ToolIcon name="trash"/>Unsave collection</button></div></details>}
      </div>
      <div className="collection-preview" aria-hidden="true"><span className="collection-cover"><ToolIcon name="layers"/></span><div className="collection-favicons">{tabs.slice(0,4).map((tab,index) => <SiteIcon key={index} url={tab.url || ''} favicon={tab.favicon_url || tab.favIconUrl}/>)}</div><span>{count} tab{count === 1 ? '' : 's'}</span></div>
      <h2>{name}</h2><p className="collection-description">{tabs.slice(0,2).map(tab => tab.title || tab.domain || 'Saved page').join(' · ') || 'Your links, kept together.'}</p>
      <button className="collection-expand" aria-expanded={isExpanded} onClick={() => setExpandedGroupId(isExpanded ? null : group.id)}><ToolIcon name="chevron"/>{isExpanded ? 'Hide links' : `View ${count} ${count === 1 ? 'link' : 'links'}`}</button>
      {isExpanded && <div className="collection-links">{tabs.map((tab,index) => <button key={index} onClick={() => openLink(tab, live)} title={tab.url}><SiteIcon url={tab.url || ''} favicon={tab.favicon_url || tab.favIconUrl}/><span>{tab.title || tab.url || 'Untitled'}</span><ToolIcon name="open"/></button>)}</div>}
      <div className="collection-card-footer">{live ? <button className="tool-button tool-primary" disabled={savingGroupId === group.id} onClick={() => handleSaveChromeGroup(item)}><ToolIcon name="plus"/>{savingGroupId === group.id ? 'Saving…' : 'Save collection'}</button> : <><button className="tool-button tool-primary" disabled={group.pendingSync||restoringId === group.id} onClick={() => handleRestore(group)}><ToolIcon name="open"/>{restoringId === group.id ? 'Opening…' : 'Open collection'}</button><button className="tool-button" disabled={group.pendingSync} onClick={() => handleExport(group)} title="Export collection to offline HTML"><ToolIcon name="download"/>Export</button></>}
        {!live && <small>{group.created_at ? new Date(group.created_at).toLocaleDateString(undefined,{month:'short',day:'numeric'}) : 'Saved'}</small>}
      </div>
    </article>;
  };

  return <div className="workspace-tools collections-page">{refreshError&&<p role="status">{refreshError}</p>}
    {toastMsg && <div className="tool-toast" role="status">{toastMsg.replace(/^[✓✦]\s*/, '')}</div>}
    <div className="tools-toolbar">
      <div className="tools-segments" aria-label="Collection type"><button aria-pressed={activeSubtab === 'saved'} onClick={() => setActiveSubtab('saved')}>Saved<span>{groups.length}</span></button><button aria-pressed={activeSubtab === 'unsaved'} onClick={() => setActiveSubtab('unsaved')}>Open in browser<span>{unsavedChromeGroups.length}</span></button></div>
      <div className="tools-toolbar-actions"><label className="tools-search"><ToolIcon name="search"/><input type="search" aria-label="Search collections or links" placeholder="Find a collection…" value={search} onChange={event => setSearch(event.target.value)}/></label><button className="tool-button tool-primary" onClick={openCreate}><ToolIcon name="plus"/>New collection</button><button className="tool-icon-button" onClick={loadAllData} aria-label="Refresh collections"><ToolIcon name="refresh"/></button></div>
    </div>
    {loading ? <div className="tool-empty" role="status">Loading your collections…</div> : <div className="collections-grid">{(activeSubtab === 'saved' ? filteredSaved : filteredUnsaved).map(item => renderCard(item, activeSubtab === 'unsaved'))}</div>}
    {!loading && (activeSubtab === 'saved' ? filteredSaved : filteredUnsaved).length === 0 && <div className="tool-empty"><ToolIcon name="layers"/><h2>{search ? 'No collections match' : activeSubtab === 'saved' ? 'A home for your next idea' : 'No unsaved browser groups'}</h2><p>{search ? 'Try a different name, page title or website.' : activeSubtab === 'saved' ? 'Save a browser group to keep its links together, ready to open when you need them.' : 'Your open groups are already saved, or there are no groups open right now.'}</p><button className="tool-button" onClick={search ? () => setSearch('') : openCreate}>{search ? 'Clear search' : 'Create collection'}</button></div>}
    {showCreateModal && <div className="tool-modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setShowCreateModal(false); }} onKeyDown={event => { if (event.key === 'Escape') setShowCreateModal(false); }}><section className="tool-modal" role="dialog" aria-modal="true" aria-labelledby="create-collection-title">
      <div className="tool-section-head"><div><h2 id="create-collection-title">Create a collection</h2><p>Bring a few open tabs together.</p></div><button className="tool-icon-button" onClick={() => setShowCreateModal(false)} aria-label="Close create collection"><ToolIcon name="close"/></button></div>
      <form onSubmit={event => { event.preventDefault(); handleCreateNewGroupSubmit(); }}>
        <label className="tool-field">Collection name<input autoFocus value={newGroupName} onChange={event => setNewGroupName(event.target.value)} placeholder="e.g. Research, Design, Weekend ideas" required/></label>
        <fieldset className="collection-color-field"><legend>Group color</legend><div className="collection-colors">{colorPalette.map(color => <button type="button" key={color} aria-label={color} aria-pressed={newGroupColor === color} style={{ '--swatch':getChromeColor(color) } as React.CSSProperties} onClick={() => setNewGroupColor(color)}/>)}</div></fieldset>
        <div className="tool-section-head collection-tab-head"><span>Open tabs <small>{selectedTabIdsForNewGroup.length} selected</small></span><div><button type="button" className="tool-text-button" onClick={() => setSelectedTabIdsForNewGroup(allOpenChromeTabs.map(tab => tab.id).filter(Boolean))}>Select all</button><button type="button" className="tool-text-button" onClick={() => setSelectedTabIdsForNewGroup([])}>Clear</button></div></div>
        <div className="collection-tab-picker">{allOpenChromeTabs.length ? allOpenChromeTabs.map(tab => <label key={tab.id}><input type="checkbox" checked={!!tab.id && selectedTabIdsForNewGroup.includes(tab.id)} onChange={event => setSelectedTabIdsForNewGroup(prev => event.target.checked ? [...prev,tab.id] : prev.filter(id => id !== tab.id))}/><span>{tab.title || tab.url || 'Untitled'}</span></label>) : <p>Open this workspace from the extension to create a collection from your tabs.</p>}</div>
        <div className="tool-form-actions"><button type="button" className="tool-button" onClick={() => setShowCreateModal(false)}>Cancel</button><button className="tool-button tool-primary" type="submit" disabled={!newGroupName.trim() || !selectedTabIdsForNewGroup.length}>Create group</button></div>
      </form>
    </section></div>}
  </div>;
};
