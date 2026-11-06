import React, { useState, useEffect, useRef } from 'react';
import { Library } from './pages/Library';
import { TimeTracking } from './pages/TimeTracking';
import { Brain } from './pages/Brain';
import { GraphView } from './pages/GraphView';
import { Settings } from './pages/Settings';
import { SavedGroups } from './pages/SavedGroups';
import { apiClient } from '../lib/api-client';

type NavTab = 'home' | 'library' | 'groups' | 'time' | 'brain' | 'graph' | 'settings';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<NavTab>('home');
  const [collapsed, setCollapsed] = useState<boolean>(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedFilter, setSelectedFilter] = useState<string>('All');
  const [filterType, setFilterType] = useState<'all' | 'domain' | 'topic' | 'important' | 'urgent'>('all');
  const [pages, setPages] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [topics, setTopics] = useState<{ topic: string; count: number }[]>([]);

  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const savedTheme = (localStorage.getItem('karlx-theme') as 'dark' | 'light') || 'dark';
    setTheme(savedTheme);
    document.documentElement.setAttribute('data-theme', savedTheme);

    const handleHash = () => {
      const h = window.location.hash;
      if (h === '#sessions') {
        setActiveTab('library');
      } else if (h === '#groups' || h === '#saved-groups') {
        setActiveTab('groups');
      }
    };
    handleHash();
    window.addEventListener('hashchange', handleHash);

    loadPages();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== searchInputRef.current) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  async function loadPages() {
    setLoading(true);
    try {
      const res = await apiClient.get<any[]>('/api/pages?limit=300');
      const data = Array.isArray(res) ? res : [];
      setPages(data);

      // Extract topics
      const counts = new Map<string, number>();
      const ignored = new Set(['general', 'other', 'uncategorized', 'none', 'unknown', '']);
      data.forEach(p => {
        const t = (p.topic || '').trim();
        if (t && !ignored.has(t.toLowerCase())) {
          counts.set(t, (counts.get(t) || 0) + 1);
        }
      });
      const list = Array.from(counts.entries())
        .map(([topic, count]) => ({ topic, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);
      setTopics(list);
    } catch {
      setPages([]);
    } finally {
      setLoading(false);
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

  const handleDelete = async (pageId: number) => {
    setPages(prev => prev.filter(p => p.id !== pageId));
    try {
      await apiClient.delete(`/api/pages/${pageId}`);
    } catch (err) {
      console.error('Failed to delete page', err);
      loadPages();
    }
  };

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    document.documentElement.setAttribute('data-theme', nextTheme);
    localStorage.setItem('karlx-theme', nextTheme);
  };

  const importantCount = pages.filter(p => p.is_important).length;
  const urgentCount = pages.filter(p => p.is_urgent).length;

  // Filtered pages for Open All button
  const filtered = pages.filter(p => {
    if (filterType === 'important') {
      if (!p.is_important) return false;
    } else if (filterType === 'urgent') {
      if (!p.is_urgent) return false;
    } else if (filterType === 'domain') {
      const domain = p.domain || (p.url_original ? (() => {
        try { return new URL(p.url_original).hostname.replace(/^www\./, ''); } catch { return ''; }
      })() : '');
      if (domain.toLowerCase() !== selectedFilter.toLowerCase()) return false;
    } else if (filterType === 'topic') {
      const topic = (p.topic || '').trim().toLowerCase();
      if (topic !== selectedFilter.toLowerCase()) return false;
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        (p.title || '').toLowerCase().includes(q) ||
        (p.domain || '').toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q) ||
        (p.topic || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  // Staggered Open All
  function handleOpenAll() {
    if (filtered.length === 0) return;
    const limit = Math.min(filtered.length, 30);
    filtered.slice(0, limit).forEach((page, i) => {
      setTimeout(() => {
        const url = page.url_original || page.url_normalized;
        if (url) {
          if (typeof chrome !== 'undefined' && chrome.tabs) {
            chrome.tabs.create({ url, active: false });
          } else {
            window.open(url, '_blank');
          }
        }
      }, i * 350);
    });
  }

  return (
    <div className="dashboard-layout">
      {/* Sidebar */}
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`} id="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <img
              src={typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL('public/icons/icon128.png') : '/public/icons/icon128.png'}
              alt="Karl X logo"
              onError={(e) => {
                // Fallback directly to public/icons/icon128.png or root relative
                const img = e.currentTarget;
                if (!img.src.includes('data:')) {
                  img.src = chrome?.runtime?.getURL ? chrome.runtime.getURL('public/icons/icon128.png') : '/public/icons/icon128.png';
                }
              }}
            />
          </div>
          <div className="brand-name label">Karl X — Saved Tabs</div>
        </div>

        <button
          className={`nav-item ${activeTab === 'home' && filterType === 'all' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('home');
            setSelectedFilter('All');
            setFilterType('all');
            loadPages();
          }}
        >
          <span className="nav-icon">⌂</span>
          <span className="label">Home</span>
        </button>

        <button
          className={`nav-item ${activeTab === 'library' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('library');
            loadPages();
          }}
        >
          <span className="nav-icon">▤</span>
          <span className="label">Library</span>
        </button>

        <button
          className={`nav-item ${activeTab === 'groups' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('groups');
          }}
        >
          <span className="nav-icon">📑</span>
          <span className="label">Group</span>
        </button>

        {/* Pinned Section */}
        <div className="section-title">Pinned</div>
        <button
          className={`nav-item ${activeTab === 'home' && filterType === 'important' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('home');
            setSelectedFilter('Important');
            setFilterType('important');
          }}
        >
          <span className="nav-icon" style={{ color: '#f59e0b' }}>★</span>
          <span className="label">Important</span>
          <span className="sidebar-badge">{importantCount}</span>
        </button>

        <button
          className={`nav-item ${activeTab === 'home' && filterType === 'urgent' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('home');
            setSelectedFilter('Urgent');
            setFilterType('urgent');
          }}
        >
          <span className="nav-icon" style={{ color: '#ef4444' }}>🔥</span>
          <span className="label">Urgent</span>
          <span className="sidebar-badge">{urgentCount}</span>
        </button>

        <div className="section-title">Tools</div>
        <button
          className={`nav-item ${activeTab === 'time' ? 'active' : ''}`}
          onClick={() => setActiveTab('time')}
        >
          <span className="nav-icon">◔</span>
          <span className="label">Time Spent</span>
        </button>

        <button
          className={`nav-item ${activeTab === 'brain' ? 'active' : ''}`}
          onClick={() => setActiveTab('brain')}
        >
          <span className="nav-icon">✦</span>
          <span className="label">Ask Karl</span>
        </button>

        <button
          className={`nav-item ${activeTab === 'graph' ? 'active' : ''}`}
          onClick={() => setActiveTab('graph')}
        >
          <span className="nav-icon">🕸️</span>
          <span className="label">Knowledge Graph</span>
        </button>

        <button
          className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          <span className="nav-icon">⚙️</span>
          <span className="label">Settings</span>
        </button>

        {!collapsed && topics.length > 0 && (
          <>
            <div className="section-title">Topics</div>
            <div className="topic-list-nav" id="topic-nav">
              {topics.map(t => (
                <div
                  key={t.topic}
                  className={`topic-nav-item ${selectedFilter === t.topic && filterType === 'topic' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('home');
                    setSelectedFilter(t.topic);
                    setFilterType('topic');
                  }}
                >
                  <span>#{t.topic}</span>
                  <span className="topic-count">{t.count}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </aside>

      {/* Main Column */}
      <div className="main">
        <header>
          <button
            className="icon-btn"
            id="sidebar-toggle"
            onClick={() => setCollapsed(!collapsed)}
            title="Toggle Sidebar"
          >
            ☰
          </button>

          <div className="search-wrap">
            <span className="search-icon">⌕</span>
            <input
              ref={searchInputRef}
              className="search-bar"
              id="search"
              placeholder="Search your saved tabs...  (press /)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="header-right">
            <button
              className="btn-primary"
              id="open-all"
              onClick={handleOpenAll}
              disabled={filtered.length === 0}
            >
              Open All ({filtered.length})
            </button>
            <button
              className="icon-btn"
              id="theme-toggle"
              onClick={toggleTheme}
              title={`Switch theme`}
            >
              ◐
            </button>
          </div>
        </header>

        {(activeTab === 'home' || activeTab === 'library') && (
          <Library
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            selectedFilter={selectedFilter}
            setSelectedFilter={setSelectedFilter}
            filterType={filterType}
            setFilterType={setFilterType}
            pages={pages}
            loading={loading}
            onRefresh={loadPages}
            onToggleImportant={handleToggleImportant}
            onToggleUrgent={handleToggleUrgent}
            onDelete={handleDelete}
          />
        )}

        {activeTab === 'groups' && (
          <div className="subpage-container">
            <SavedGroups />
          </div>
        )}

        {activeTab === 'time' && (
          <div className="subpage-container">
            <TimeTracking />
          </div>
        )}

        {activeTab === 'brain' && (
          <div className="subpage-container">
            <Brain />
          </div>
        )}

        {activeTab === 'graph' && (
          <div className="subpage-container">
            <GraphView />
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="subpage-container">
            <Settings onReclassified={loadPages} />
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
