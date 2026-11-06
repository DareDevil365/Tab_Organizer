import React, { useEffect, useState } from 'react';
import { apiClient } from '../../lib/api-client';

interface TimeSummary {
  total_seconds: number;
  daily_average_seconds: number;
  top_domain?: string;
  top_topic?: string;
  domain_breakdown: Array<{ domain: string; duration_seconds: number; percentage: number }>;
  topic_breakdown: Array<{ topic: string; duration_seconds: number; percentage: number }>;
  trends: Array<{ date: string; duration_seconds: number }>;
}

export const TimeTracking: React.FC = () => {
  const [summary, setSummary] = useState<TimeSummary | null>(null);
  const [days, setDays] = useState<number>(7);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    loadData(days);
  }, [days]);

  async function loadData(selectedDays: number) {
    setLoading(true);
    try {
      const res = await apiClient.get<TimeSummary>(`/api/activity/summary?days=${selectedDays}`);
      setSummary(res);
    } catch {
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }

  function formatDuration(seconds: number): string {
    if (!seconds || seconds <= 0) return '0m';
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Activity & Time Tracking</h1>
          <p style={{ color: '#9098a9', fontSize: 13, marginTop: 4 }}>
            Passive focus time spent across domains and AI-classified topics
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[1, 7, 14, 30].map(d => (
            <button
              key={d}
              className={`chip ${days === d ? 'active' : ''}`}
              style={{
                padding: '6px 14px',
                borderRadius: 16,
                background: days === d ? 'var(--accent)' : 'var(--bg-card)',
                color: days === d ? '#000' : 'var(--text-primary)',
                border: '1px solid var(--border)',
                cursor: 'pointer',
                fontWeight: days === d ? 600 : 400
              }}
              onClick={() => setDays(d)}
            >
              {d === 1 ? 'Today' : `${d} Days`}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p style={{ color: '#9098a9', textAlign: 'center', marginTop: 40 }}>Loading tracking metrics...</p>
      ) : !summary || summary.total_seconds === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: '#9098a9' }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>⏱️</div>
          <h3>No activity recorded in this period yet</h3>
          <p style={{ fontSize: 13, marginTop: 6 }}>
            Browse normally with the extension active and time will be automatically logged.
          </p>
        </div>
      ) : (
        <>
          {/* Summary Stat Cards */}
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-label">Total Focus Time</div>
              <div className="stat-val">{formatDuration(summary.total_seconds)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Daily Average</div>
              <div className="stat-val">{formatDuration(summary.daily_average_seconds)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Top Domain</div>
              <div className="stat-val" style={{ fontSize: '1.2rem', wordBreak: 'break-all' }}>
                {summary.top_domain || 'None'}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Top Topic</div>
              <div className="stat-val" style={{ fontSize: '1.2rem', textTransform: 'capitalize' }}>
                {summary.top_topic || 'None'}
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginTop: 24 }}>
            {/* Top Domains */}
            <div className="stat-card">
              <h3 style={{ fontSize: 15, marginBottom: 16 }}>🌐 Time by Domain</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {summary.domain_breakdown.map(d => (
                  <div key={d.domain}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                      <span>{d.domain}</span>
                      <span style={{ color: '#9098a9' }}>{formatDuration(d.duration_seconds)} ({d.percentage}%)</span>
                    </div>
                    <div style={{ height: 6, background: 'var(--bg-input)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${d.percentage}%`, height: '100%', background: 'var(--accent)', borderRadius: 3 }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Top Topics */}
            <div className="stat-card">
              <h3 style={{ fontSize: 15, marginBottom: 16 }}>🏷️ Time by Topic</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {summary.topic_breakdown.map(t => (
                  <div key={t.topic}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                      <span style={{ textTransform: 'capitalize' }}>{t.topic}</span>
                      <span style={{ color: '#9098a9' }}>{formatDuration(t.duration_seconds)} ({t.percentage}%)</span>
                    </div>
                    <div style={{ height: 6, background: 'var(--bg-input)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${t.percentage}%`, height: '100%', background: '#3fb950', borderRadius: 3 }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
