import React, { useState, useEffect } from 'react';
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

    const onChromeEvent = () => {
      loadAllData();
    };

    if (typeof chrome !== 'undefined') {
      chrome.tabs?.onCreated?.addListener(onChromeEvent);
      chrome.tabs?.onRemoved?.addListener(onChromeEvent);
      chrome.tabs?.onUpdated?.addListener(onChromeEvent);
      chrome.tabGroups?.onCreated?.addListener(onChromeEvent);
      chrome.tabGroups?.onRemoved?.addListener(onChromeEvent);
      chrome.tabGroups?.onUpdated?.addListener(onChromeEvent);
    }

    return () => {
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
    setLoading(true);
    try {
      let savedList: any[] = [];
      try {
        const res = await apiClient.get<any[]>('/api/groups');
        if (Array.isArray(res)) {
          savedList = res;
          setGroups(res);
        }
      } catch {
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
          chrome.storage.local.get(['saved_tab_groups'], (result) => {
            if (result && Array.isArray(result.saved_tab_groups)) {
              savedList = result.saved_tab_groups;
              setGroups(result.saved_tab_groups);
            }
          });
        }
      }

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
              return cgTitle && sgTitle && cgTitle === sgTitle;
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
      setLoading(false);
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
      let savedResult: any = null;
      try {
        savedResult = await apiClient.post('/api/groups', {
          name: groupName,
          color: groupColor,
          tabs: tabsPayload
        });
      } catch {
        savedResult = {
          id: Date.now(),
          name: groupName,
          color: groupColor,
          tab_count: tabsPayload.length,
          tabs: tabsPayload,
          created_at: new Date().toISOString()
        };
      }

      setGroups(prev => [savedResult, ...prev]);
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.get(['saved_tab_groups'], (res) => {
          const arr = res?.saved_tab_groups || [];
          arr.unshift(savedResult);
          chrome.storage.local.set({ saved_tab_groups: arr });
        });
      }
      setUnsavedChromeGroups(prev => prev.filter(x => x.group.id !== item.group.id));
      showToast(`✓ Saved "${groupName}" into Saved Groups!`);
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
      const selectedTabs = allOpenChromeTabs.filter(t => selectedTabIdsForNewGroup.includes(t.id));
      const tabsPayload = selectedTabs.map(t => ({
        url: t.url || '',
        title: t.title || t.url || 'Untitled',
        favicon_url: t.favIconUrl || '',
        domain: t.url ? (() => { try { return new URL(t.url).hostname.replace(/^www\./, ''); } catch { return ''; } })() : ''
      }));

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
    } catch {}
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

  return (
    <div style={{ padding: '0 4px' }}>
      {toastMsg && (
        <div style={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          background: 'var(--surface-2)',
          border: '1px solid var(--accent)',
          color: 'var(--text-primary)',
          padding: '10px 18px',
          borderRadius: 8,
          boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
          zIndex: 9999,
          fontSize: 13,
          fontWeight: 600
        }}>
          {toastMsg}
        </div>
      )}

      {/* Header Info */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 20,
        flexWrap: 'wrap',
        gap: 12
      }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
            📑 Groups
          </h2>
          <p style={{ fontSize: 13, color: 'var(--text-tertiary)', margin: '4px 0 0' }}>
            Manage saved tab groups and active browser groups
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="text"
            placeholder="Search groups or links..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
              borderRadius: 8,
              padding: '8px 14px',
              fontSize: 13,
              width: 240,
              outline: 'none'
            }}
          />
          <button
            onClick={async () => {
              if (allOpenChromeTabs.length > 0) {
                const active = allOpenChromeTabs.find(t => t.active) || allOpenChromeTabs[0];
                if (active?.id) setSelectedTabIdsForNewGroup([active.id]);
              }
              const nextColor = await getNextContrastingGroupColor();
              setNewGroupColor(nextColor);
              setShowCreateModal(true);
            }}
            style={{
              background: 'linear-gradient(135deg, #7c5cff, #a78bfa)',
              border: 'none',
              color: '#ffffff',
              borderRadius: 8,
              padding: '8px 14px',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }}
          >
            <span>+</span> New Group
          </button>
          <button
            onClick={loadAllData}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
              borderRadius: 8,
              padding: '8px 12px',
              cursor: 'pointer',
              fontSize: 13
            }}
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Sub-tabs Row (Saved Groups vs Unsaved Groups) */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 20,
        borderBottom: '1px solid var(--border)',
        paddingBottom: 10
      }}>
        <button
          onClick={() => setActiveSubtab('saved')}
          style={{
            background: activeSubtab === 'saved' ? 'rgba(16, 185, 129, 0.15)' : 'transparent',
            border: activeSubtab === 'saved' ? '1px solid rgba(16, 185, 129, 0.4)' : '1px solid transparent',
            color: activeSubtab === 'saved' ? '#34d399' : 'var(--text-secondary)',
            borderRadius: 8,
            padding: '7px 14px',
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            transition: 'background 0.1s ease, color 0.1s ease, border-color 0.1s ease'
          }}
        >
          <span>Saved</span>
          <span style={{
            background: activeSubtab === 'saved' ? '#10b981' : 'rgba(255,255,255,0.08)',
            color: activeSubtab === 'saved' ? '#ffffff' : 'var(--text-tertiary)',
            padding: '1px 6px',
            borderRadius: 999,
            fontSize: 11
          }}>
            {groups.length}
          </span>
        </button>

        <button
          onClick={() => setActiveSubtab('unsaved')}
          style={{
            background: activeSubtab === 'unsaved' ? 'rgba(249, 115, 22, 0.15)' : 'transparent',
            border: activeSubtab === 'unsaved' ? '1px solid rgba(249, 115, 22, 0.4)' : '1px solid transparent',
            color: activeSubtab === 'unsaved' ? '#fb923c' : 'var(--text-secondary)',
            borderRadius: 8,
            padding: '7px 14px',
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            transition: 'background 0.1s ease, color 0.1s ease, border-color 0.1s ease'
          }}
        >
          <span>Unsaved</span>
          <span style={{
            background: activeSubtab === 'unsaved' ? '#f97316' : 'rgba(255,255,255,0.08)',
            color: activeSubtab === 'unsaved' ? '#ffffff' : 'var(--text-tertiary)',
            padding: '1px 6px',
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 700
          }}>
            {filteredUnsaved.length}
          </span>
        </button>
      </div>

      {/* Main Content Area */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-tertiary)' }}>
          Loading groups...
        </div>
      ) : activeSubtab === 'saved' ? (
        filteredSaved.length === 0 ? (
          <div style={{
            background: 'var(--surface)',
            border: '1px dashed var(--border)',
            borderRadius: 14,
            padding: '50px 20px',
            textAlign: 'center',
            color: 'var(--text-tertiary)'
          }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>📑</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>
              {search ? 'No groups match your search' : 'No Saved Tab Groups Yet'}
            </div>
            <div style={{ fontSize: 13, maxWidth: 360, margin: '0 auto', lineHeight: 1.4 }}>
              {search
                ? 'Try searching with a different term or clear the search input.'
                : 'Save open tabs as a group from the popup or click "+ New Group" above to stash tab collections.'}
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 16 }}>
            {filteredSaved.map(group => {
              const colorHex = getChromeColor(group.color || 'blue');
              const isExpanded = expandedGroupId === group.id;
              const tabs: any[] = group.tabs || [];
              const count = group.tab_count || tabs.length;

              const grpColor = getChromeColor(group.color || 'green');
              return (
                <div
                  key={group.id}
                  style={{
                    background: `linear-gradient(90deg, ${grpColor}18 0%, var(--surface) 45%)`,
                    border: '1px solid var(--border)',
                    borderLeft: `5px solid ${grpColor}`,
                    borderRadius: 12,
                    padding: '16px 18px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.15)'
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                        <span style={{
                          width: 10,
                          height: 10,
                          borderRadius: '50%',
                          backgroundColor: grpColor,
                          display: 'inline-block',
                          flexShrink: 0
                        }} />
                        <h3 style={{
                          margin: 0,
                          fontSize: 15,
                          fontWeight: 700,
                          color: grpColor,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis'
                        }}>
                          {group.name}
                        </h3>
                        <span style={{
                          fontSize: 12,
                          background: `${grpColor}26`,
                          padding: '2px 7px',
                          borderRadius: 999,
                          color: grpColor,
                          fontWeight: 600,
                          flexShrink: 0
                        }}>
                          {count} tab{count === 1 ? '' : 's'}
                        </span>
                        <span style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: grpColor,
                          background: `${grpColor}20`,
                          padding: '2px 8px',
                          borderRadius: 6
                        }}>
                          Saved
                        </span>
                      </div>

                      <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', flexShrink: 0 }}>
                        {group.created_at ? new Date(group.created_at).toLocaleDateString() : 'Saved'}
                      </div>
                    </div>

                    {/* Tab previews / list */}
                    <div style={{ marginTop: 10, marginBottom: 14 }}>
                      <div
                        onClick={() => setExpandedGroupId(isExpanded ? null : group.id)}
                        style={{
                          fontSize: 12,
                          color: '#10b981',
                          cursor: 'pointer',
                          fontWeight: 600,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          marginBottom: 8
                        }}
                      >
                        <span>{isExpanded ? '▾ Hide links' : '▸ View all links'}</span>
                      </div>

                      {isExpanded && (
                        <div style={{
                          maxHeight: 200,
                          overflowY: 'auto',
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          padding: '6px 8px',
                          background: 'var(--bg)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6
                        }}>
                          {tabs.map((t: any, idx: number) => (
                            <div
                              key={idx}
                              onClick={() => {
                                if (t.url) {
                                  if (typeof chrome !== 'undefined' && chrome.tabs) {
                                    chrome.tabs.create({ url: t.url });
                                  } else {
                                    window.open(t.url, '_blank');
                                  }
                                }
                              }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                padding: '4px 6px',
                                borderRadius: 6,
                                cursor: 'pointer',
                                background: 'var(--surface)',
                                fontSize: 12,
                                color: 'var(--text-secondary)'
                              }}
                              title={t.url || ''}
                            >
                              <img
                                src={t.favicon_url || '/public/icons/icon16.png'}
                                onError={(e) => { e.currentTarget.src = '/public/icons/icon16.png'; }}
                                alt=""
                                style={{ width: 14, height: 14, borderRadius: 2, flexShrink: 0 }}
                              />
                              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                                {t.title || t.url || 'Untitled'}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Card Action Buttons */}
                  <div style={{
                    display: 'flex',
                    gap: 8,
                    paddingTop: 12,
                    borderTop: '1px solid var(--border)'
                  }}>
                    <button
                      onClick={() => handleRestore(group)}
                      disabled={restoringId === group.id}
                      style={{
                        flex: 1,
                        background: 'linear-gradient(135deg, #10b981, #059669)',
                        color: '#ffffff',
                        border: 'none',
                        borderRadius: 8,
                        padding: '7px 12px',
                        fontSize: 12.5,
                        fontWeight: 700,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6
                      }}
                    >
                      <span>✦</span>
                      <span>{restoringId === group.id ? 'Restoring...' : 'Restore in Chrome'}</span>
                    </button>

                    <button
                      onClick={() => handleExport(group)}
                      title="Export group to offline HTML"
                      style={{
                        background: 'var(--surface-2)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-primary)',
                        borderRadius: 8,
                        padding: '7px 11px',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer'
                      }}
                    >
                      ⇩ HTML
                    </button>

                    <button
                      onClick={() => handleDelete(group.id, group.name)}
                      title="Unsave group (moves to Unsaved Groups)"
                      style={{
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        color: '#f87171',
                        borderRadius: 8,
                        padding: '7px 10px',
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: 'pointer'
                      }}
                    >
                      - Unsave
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : (
        /* Unsaved Groups Subtab */
        filteredUnsaved.length === 0 ? (
          <div style={{
            background: 'var(--surface)',
            border: '1px dashed var(--border)',
            borderRadius: 14,
            padding: '50px 20px',
            textAlign: 'center',
            color: 'var(--text-tertiary)'
          }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>✨</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>
              All Open Chrome Groups Are Saved
            </div>
            <div style={{ fontSize: 13, maxWidth: 360, margin: '0 auto', lineHeight: 1.4 }}>
              There are no unsaved tab groups open in your browser right now. You can create a new group anytime using the button above.
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 16 }}>
            {/* Live Chrome Groups */}
            {filteredUnsaved.map(item => {
              const isExpanded = expandedGroupId === item.group.id;
              const count = item.tabs.length;
              const grpColor = getChromeColor(item.group.color || 'blue');

              return (
                <div
                  key={item.group.id}
                  style={{
                    background: `linear-gradient(90deg, ${grpColor}18 0%, var(--surface) 45%)`,
                    border: '1px solid var(--border)',
                    borderLeft: `5px solid ${grpColor}`,
                    borderRadius: 12,
                    padding: '16px 18px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.15)'
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                        <span style={{
                          width: 10,
                          height: 10,
                          borderRadius: '50%',
                          backgroundColor: grpColor,
                          display: 'inline-block',
                          flexShrink: 0
                        }} />
                        <h3 style={{
                          margin: 0,
                          fontSize: 15,
                          fontWeight: 700,
                          color: grpColor,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis'
                        }}>
                          {item.group.title || 'Unnamed Chrome Group'}
                        </h3>
                        <span style={{
                          fontSize: 12,
                          background: `${grpColor}26`,
                          padding: '2px 7px',
                          borderRadius: 999,
                          color: grpColor,
                          fontWeight: 600,
                          flexShrink: 0
                        }}>
                          {count} tab{count === 1 ? '' : 's'}
                        </span>
                        <span style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: grpColor,
                          background: `${grpColor}20`,
                          padding: '2px 8px',
                          borderRadius: 6
                        }}>
                          Active in Chrome
                        </span>
                      </div>
                    </div>

                    {/* Tab list */}
                    <div style={{ marginTop: 10, marginBottom: 14 }}>
                      <div
                        onClick={() => setExpandedGroupId(isExpanded ? null : item.group.id)}
                        style={{
                          fontSize: 12,
                          color: grpColor,
                          cursor: 'pointer',
                          fontWeight: 600,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          marginBottom: 8
                        }}
                      >
                        <span>{isExpanded ? '▾ Hide links' : '▸ View all links'}</span>
                      </div>

                      {isExpanded && (
                        <div style={{
                          maxHeight: 200,
                          overflowY: 'auto',
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          padding: '6px 8px',
                          background: 'var(--bg)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6
                        }}>
                          {item.tabs.map((t: any, idx: number) => (
                            <div
                              key={idx}
                              onClick={() => {
                                if (t.id !== undefined && typeof chrome !== 'undefined' && chrome.tabs) {
                                  chrome.tabs.update(t.id, { active: true });
                                }
                              }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                padding: '4px 6px',
                                borderRadius: 6,
                                cursor: 'pointer',
                                background: 'var(--surface)',
                                fontSize: 12,
                                color: 'var(--text-secondary)'
                              }}
                              title={t.url || ''}
                            >
                              <img
                                src={t.favIconUrl || '/public/icons/icon16.png'}
                                onError={(e) => { e.currentTarget.src = '/public/icons/icon16.png'; }}
                                alt=""
                                style={{ width: 14, height: 14, borderRadius: 2, flexShrink: 0 }}
                              />
                              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                                {t.title || t.url || 'Untitled'}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Unsaved Card Action Buttons */}
                  <div style={{
                    display: 'flex',
                    gap: 8,
                    paddingTop: 12,
                    borderTop: '1px solid var(--border)'
                  }}>
                    <button
                      onClick={() => handleSaveChromeGroup(item)}
                      disabled={savingGroupId === item.group.id}
                      style={{
                        flex: 1,
                        background: `linear-gradient(135deg, ${grpColor}, ${grpColor}dd)`,
                        color: '#ffffff',
                        border: 'none',
                        borderRadius: 8,
                        padding: '7px 12px',
                        fontSize: 12.5,
                        fontWeight: 700,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                        boxShadow: `0 2px 6px ${grpColor}40`
                      }}
                    >
                      <span>💾</span>
                      <span>{savingGroupId === item.group.id ? 'Saving...' : 'Save as Group'}</span>
                    </button>
                  </div>
                </div>
              );
            })}

          </div>
        )
      )}

      {/* Modal for + New Group */}
      {showCreateModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.7)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10000,
          padding: 20
        }}>
          <div style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 14,
            width: '100%',
            maxWidth: 480,
            boxShadow: '0 16px 40px rgba(0,0,0,0.5)',
            overflow: 'hidden'
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '16px 20px',
              borderBottom: '1px solid var(--border)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
                <span>🗂</span>
                <span>Create New Tab Group</span>
              </div>
              <span
                onClick={() => setShowCreateModal(false)}
                style={{ cursor: 'pointer', color: 'var(--text-tertiary)', fontSize: 16 }}
              >
                ✕
              </span>
            </div>

            <div style={{ padding: '16px 20px' }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                Group Name
              </label>
              <input
                type="text"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="e.g. Research, YouTube, Work"
                style={{
                  width: '100%',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-primary)',
                  borderRadius: 8,
                  padding: '9px 12px',
                  fontSize: 13,
                  outline: 'none',
                  boxSizing: 'border-box',
                  marginBottom: 14
                }}
              />

              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                Color
              </label>
              <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                {colorPalette.map(c => {
                  const hex = getChromeColor(c);
                  const isSel = newGroupColor === c;
                  return (
                    <div
                      key={c}
                      onClick={() => setNewGroupColor(c)}
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: '50%',
                        backgroundColor: hex,
                        cursor: 'pointer',
                        boxShadow: isSel ? `0 0 0 2px var(--surface), 0 0 0 4px ${hex}` : 'none',
                        transition: 'transform 0.15s ease'
                      }}
                      title={c}
                    />
                  );
                })}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
                  Select Open Tabs ({selectedTabIdsForNewGroup.length} selected)
                </label>
                <div style={{ fontSize: 11 }}>
                  <span
                    onClick={() => setSelectedTabIdsForNewGroup(allOpenChromeTabs.map(t => t.id).filter(Boolean))}
                    style={{ color: 'var(--accent)', cursor: 'pointer', marginRight: 8 }}
                  >
                    Select All
                  </span>
                  <span
                    onClick={() => setSelectedTabIdsForNewGroup([])}
                    style={{ color: 'var(--text-tertiary)', cursor: 'pointer' }}
                  >
                    Clear
                  </span>
                </div>
              </div>

              <div style={{
                maxHeight: 180,
                overflowY: 'auto',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '6px 8px',
                background: 'var(--bg)',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                marginBottom: 18
              }}>
                {allOpenChromeTabs.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '10px 4px' }}>
                    No open tabs detected
                  </div>
                ) : (
                  allOpenChromeTabs.map(tab => {
                    const checked = tab.id && selectedTabIdsForNewGroup.includes(tab.id);
                    return (
                      <div
                        key={tab.id}
                        onClick={() => {
                          if (!tab.id) return;
                          if (checked) {
                            setSelectedTabIdsForNewGroup(prev => prev.filter(id => id !== tab.id));
                          } else {
                            setSelectedTabIdsForNewGroup(prev => [...prev, tab.id]);
                          }
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '5px 8px',
                          borderRadius: 6,
                          cursor: 'pointer',
                          background: checked ? 'rgba(124, 92, 255, 0.12)' : 'transparent',
                          color: checked ? 'var(--text-primary)' : 'var(--text-secondary)',
                          fontSize: 12
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(checked)}
                          onChange={() => {}}
                          style={{ cursor: 'pointer' }}
                        />
                        <img
                          src={tab.favIconUrl || '/public/icons/icon16.png'}
                          onError={(e) => { e.currentTarget.src = '/public/icons/icon16.png'; }}
                          alt=""
                          style={{ width: 14, height: 14, borderRadius: 2 }}
                        />
                        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                          {tab.title || tab.url || 'Untitled'}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button
                  onClick={() => setShowCreateModal(false)}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--border)',
                    color: 'var(--text-secondary)',
                    borderRadius: 8,
                    padding: '8px 16px',
                    fontSize: 13,
                    cursor: 'pointer'
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateNewGroupSubmit}
                  style={{
                    background: 'linear-gradient(135deg, #7c5cff, #a78bfa)',
                    border: 'none',
                    color: '#ffffff',
                    borderRadius: 8,
                    padding: '8px 18px',
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: 'pointer'
                  }}
                >
                  Create & Save Group
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
