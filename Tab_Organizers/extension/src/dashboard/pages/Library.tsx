import React, { useState, useEffect } from 'react';
import { PageCard } from '../components/PageCard';
import { apiClient } from '../../lib/api-client';

interface LibraryProps {
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  selectedFilter: string;
  setSelectedFilter: (f: string) => void;
  filterType: 'all' | 'domain' | 'topic' | 'important' | 'urgent';
  setFilterType: (t: 'all' | 'domain' | 'topic' | 'important' | 'urgent') => void;
  pages: any[];
  loading: boolean;
  onRefresh: () => void;
  onToggleImportant: (pageId: number, currentVal: boolean) => void;
  onToggleUrgent: (pageId: number, currentVal: boolean) => void;
  onDelete: (pageId: number) => void;
}

export const Library: React.FC<LibraryProps> = ({
  searchQuery,
  selectedFilter,
  setSelectedFilter,
  filterType,
  setFilterType,
  pages,
  loading,
  onToggleImportant,
  onToggleUrgent,
  onDelete,
}) => {
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
    chrome.runtime.sendMessage({ type: 'DELETE_BROWSER_SESSION', sessionId });
  };
  // Derive domains and topics
  const domainCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  const ignored = new Set(['general', 'other', 'uncategorized', 'none', 'unknown', '']);

  let importantCount = 0;
  let urgentCount = 0;

  pages.forEach(p => {
    if (p.is_important) importantCount++;
    if (p.is_urgent) urgentCount++;

    const domain = p.domain || (p.url_original ? (() => {
      try { return new URL(p.url_original).hostname.replace(/^www\./, ''); } catch { return ''; }
    })() : '');
    if (domain) domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);

    const topic = (p.topic || '').trim();
    if (topic && !ignored.has(topic.toLowerCase())) {
      topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
    }
  });

  const topTopics = Array.from(topicCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([topic, count]) => ({ topic, count }));

  const topDomains = Array.from(domainCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([d]) => d);

  // Filter pages
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

  return (
    <>
      {/* ✦ Reincarnate Hub (Last 2 Sessions Cache) */}
      {browserSessions.length > 0 && (
        <div
          id="reincarnate-hub"
          style={{
            background: 'linear-gradient(135deg, rgba(124, 92, 255, 0.12), rgba(16, 185, 129, 0.08))',
            border: '1px solid rgba(124, 92, 255, 0.35)',
            borderRadius: 14,
            padding: '16px 20px',
            marginBottom: 20,
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.2)'
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16 }}>✨</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                Reincarnate Station (Last {browserSessions.length} Session{browserSessions.length > 1 ? 's' : ''})
              </span>
              <span style={{ fontSize: 11, background: 'rgba(124, 92, 255, 0.2)', color: '#c4b5fd', padding: '2px 8px', borderRadius: 999, fontWeight: 600 }}>
                Cache Memory
              </span>
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              Restore full multi-window sessions with tabs & groups
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: browserSessions.length > 1 ? '1fr 1fr' : '1fr', gap: 12 }}>
            {browserSessions.map((session, idx) => (
              <div
                key={session.session_id || idx}
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '14px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: 10
                }}
              >
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                      🪟 {session.window_count || session.windows?.length || 1} Window{(session.window_count || session.windows?.length || 1) > 1 ? 's' : ''} · {session.total_tab_count || 0} Tabs
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)', background: 'var(--bg)', padding: '2px 6px', borderRadius: 4 }}>
                        {session.closed_ago || 'Recent'}
                      </span>
                      <button
                        onClick={() => handleDismiss(session.session_id)}
                        title="Dismiss this session snapshot"
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: 'var(--text-tertiary)',
                          cursor: 'pointer',
                          fontSize: 13,
                          padding: '0 2px'
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {session.title_preview || 'Saved browser session'}
                  </div>

                  {/* Window & Group Breakdown Tags */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {session.windows?.map((w: any, wIdx: number) => (
                      <span
                        key={wIdx}
                        style={{
                          fontSize: 10.5,
                          background: 'rgba(255, 255, 255, 0.05)',
                          border: '1px solid var(--border)',
                          borderRadius: 4,
                          padding: '1px 5px',
                          color: 'var(--text-tertiary)'
                        }}
                      >
                        Win {wIdx + 1}: {w.tabs?.length || 0} tabs
                      </span>
                    ))}
                  </div>
                </div>

                <button
                  onClick={() => handleReincarnate(session)}
                  disabled={reincarnatingId === session.session_id}
                  style={{
                    background: 'linear-gradient(135deg, #7c5cff, #a78bfa)',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: 8,
                    padding: '8px 14px',
                    fontSize: 12.5,
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    transition: 'all 0.15s ease'
                  }}
                >
                  <span>✦</span>
                  <span>{reincarnatingId === session.session_id ? 'Reincarnating...' : 'Reincarnate Session'}</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Category & Topic Pills */}
      <div className="pill-row" id="pill-row">
        <button
          className={`pill ${filterType === 'all' ? 'active' : ''}`}
          onClick={() => {
            setSelectedFilter('All');
            setFilterType('all');
          }}
        >
          All ({pages.length})
        </button>

        <button
          className={`pill pill-important ${filterType === 'important' ? 'active' : ''}`}
          onClick={() => {
            setSelectedFilter('Important');
            setFilterType('important');
          }}
        >
          ★ Important ({importantCount})
        </button>

        <button
          className={`pill pill-urgent ${filterType === 'urgent' ? 'active' : ''}`}
          onClick={() => {
            setSelectedFilter('Urgent');
            setFilterType('urgent');
          }}
        >
          🔥 Urgent ({urgentCount})
        </button>

        {/* Priority: Topic Tag Pills */}
        {topTopics.map(({ topic, count }) => (
          <button
            key={topic}
            className={`pill pill-topic ${selectedFilter.toLowerCase() === topic.toLowerCase() && filterType === 'topic' ? 'active' : ''}`}
            onClick={() => {
              setSelectedFilter(topic);
              setFilterType('topic');
            }}
          >
            #{topic} ({count})
          </button>
        ))}

        {/* Secondary: Top Domains */}
        {topDomains.map(domain => (
          <button
            key={domain}
            className={`pill ${selectedFilter.toLowerCase() === domain.toLowerCase() && filterType === 'domain' ? 'active' : ''}`}
            onClick={() => {
              setSelectedFilter(domain);
              setFilterType('domain');
            }}
          >
            {domain}
          </button>
        ))}
      </div>

      {/* Cards Grid */}
      <div className="grid" id="grid">
        {loading ? (
          <div className="empty-state">
            <p>Loading your saved tabs...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <p>No tabs found for this filter.</p>
            {(searchQuery || filterType !== 'all') && (
              <button
                onClick={() => {
                  setSelectedFilter('All');
                  setFilterType('all');
                }}
              >
                Show all tabs
              </button>
            )}
          </div>
        ) : (
          filtered.map(p => (
            <PageCard
              key={p.id || p.url_normalized}
              page={p}
              onToggleImportant={onToggleImportant}
              onToggleUrgent={onToggleUrgent}
              onDelete={onDelete}
            />
          ))
        )}
      </div>

      <footer>
        Karl X · {filtered.length} tab{filtered.length === 1 ? '' : 's'} shown
      </footer>
    </>
  );
};
