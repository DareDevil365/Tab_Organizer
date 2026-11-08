import { useEffect, useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { SiteIcon } from '../components/SiteIcon';
import { CompletionActivity } from '../components/CompletionActivity';
import './activity.css';

interface TimeSummary {
  total_seconds: number; daily_average_seconds: number; top_domain?: string; top_topic?: string;
  domain_breakdown: { domain: string; duration_seconds: number; percentage: number; topic?: string }[];
  topic_breakdown: { topic: string; duration_seconds: number; percentage: number }[];
  trends: { date: string; duration_seconds: number }[];
}
const duration = (seconds: number) => {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
};
async function flushCurrentActivity() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id || !chrome.runtime.sendMessage) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 1200);
    try { chrome.runtime.sendMessage({ type: 'FLUSH_ACTIVITY_NOW' }, () => { void chrome.runtime.lastError; clearTimeout(timer); resolve(); }); }
    catch { clearTimeout(timer); resolve(); }
  });
}
export function TimeTracking({ onSelectPage }: { onSelectPage?: (id: number) => void }) {
  const [summary, setSummary] = useState<TimeSummary | null>(null);
  const [days, setDays] = useState(7), [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [showAllSites, setShowAllSites] = useState(false);
  const [subjectStatus, setSubjectStatus] = useState('');
  const [subjectRetry, setSubjectRetry] = useState(0);
  useEffect(() => {
    let active = true;
    (async () => {
      setSubjectStatus('Updating subjects from watched content…');
      try {
        // Independent of summary loading: AI cannot hold up charts or totals.
        for (let batch = 0; batch < 20 && active; batch++) {
          const result = await apiClient.post<{classified:number;remaining:number;busy:boolean;unresolved?:number;provider_unavailable?:boolean}>('/api/activity/classify', {limit:20});
          if (!active) return;
          if (result.classified) setRevision(value => value + 1);
          if (result.busy) { setSubjectStatus('Subjects are updating in the background.'); return; }
          if (result.provider_unavailable) { setSubjectStatus('Subject analysis is temporarily unavailable. Browsing time is still recorded.'); return; }
          if (!result.remaining) { setSubjectStatus(result.unresolved ? 'Some older entries need more context to identify their subject.' : ''); return; }
        }
        if (active) setSubjectStatus('More subjects will update as you browse.');
      } catch { if (active) setSubjectStatus('Could not update subjects. Your recorded time is unchanged.'); }
    })();
    return () => { active = false; };
  }, [subjectRetry]);
  useEffect(() => {
    let active = true; setLoading(true); setError('');
    (async () => {
      await flushCurrentActivity();
      try {
        const result = await apiClient.get<TimeSummary>(`/api/activity/summary?days=${days}&utc_offset_minutes=${-new Date().getTimezoneOffset()}`);
        if (active) setSummary(result);
      } catch { if (active) setError('Could not refresh browsing time. Check the backend connection and retry.'); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [days, revision]);
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    const timer = setInterval(refresh, 30000); window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);
  const websites = summary?.domain_breakdown || [], trends = summary?.trends || [];
  const peak = Math.max(1, ...trends.map(day => day.duration_seconds));
  const dateLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return <div className="activity-page">
    <div className="page-header activity-period-header"><div><h2 className="page-title">Your progress & browsing</h2><p>What you finished, and where you spent your time.</p></div>
      <div className="activity-periods" aria-label="Activity period">{[1, 7, 14, 30].map(value => <button key={value} className={`activity-period-button ${days === value ? 'active' : ''}`} aria-pressed={days === value} onClick={() => { setDays(value); setShowAllSites(false); }}>{value === 1 ? '24 hours' : `${value} days`}</button>)}</div>
    </div>
    <CompletionActivity days={days} onSelectPage={onSelectPage} />
    <section className="browsing-section" aria-label="Website browsing time">
      <div className="browsing-heading"><div><span className="browsing-eyebrow">YOUR BROWSER, IN PERSPECTIVE</span><h2>Time well accounted for.</h2><p>Time on the active web tab in your focused browser window.</p></div><button className="browsing-refresh" onClick={() => setRevision(value => value + 1)} disabled={loading}>{loading && !summary ? 'Updating…' : 'Refresh'}</button></div>
      <div className="tracking-explanation"><span className="tracking-state-dot" />Background tabs and minimized windows are excluded. Tracking pauses after 60 seconds of inactivity. Updates about every 30 seconds.</div>
      {error && <p className="completion-error" role="alert">{error}</p>}
      {loading && !summary && <p role="status" className="browsing-empty">Loading browsing time…</p>}
      {summary && <>
        <div className="browsing-metrics">
          <div><span>Active browsing</span><strong>{duration(summary.total_seconds)}</strong><small>Last {days === 1 ? '24 hours' : `${days} days`}</small></div>
          <div><span>Daily average</span><strong>{duration(summary.daily_average_seconds)}</strong><small>Across this period</small></div>
          <div><span>Websites visited</span><strong>{websites.length}</strong><small>With recorded active time</small></div>
          <div><span>Most visited</span><strong className="browsing-top-site">{summary.top_domain || '—'}</strong><small>{websites[0] ? duration(websites[0].duration_seconds) : 'No browsing time yet'}</small></div>
        </div>
        {summary.total_seconds > 0 ? <>
          <div className="browsing-chart-panel"><div className="browsing-panel-heading"><h3>Your daily rhythm</h3><span>Local dates · first and last days may be partial</span></div>
            <div className="browsing-chart" role="img" aria-label={`Daily active browsing time over the last ${days} days`}>{trends.map((day, index) => <div className="browsing-day" key={day.date} title={`${dateLabel(day.date)}: ${duration(day.duration_seconds)}`}><div className="browsing-bar-track"><span style={{ height: day.duration_seconds ? `${Math.max(2, day.duration_seconds / peak * 100)}%` : '2px' }} /></div><small>{trends.length <= 9 || index % Math.ceil(trends.length / 8) === 0 || index === trends.length - 1 ? dateLabel(day.date) : ''}</small><span className="visually-hidden">{dateLabel(day.date)}: {duration(day.duration_seconds)}</span></div>)}</div>
          </div>
          <div className="browsing-breakdowns"><div className="browsing-sites-panel"><div className="browsing-panel-heading"><h3>Where the time went</h3><span>{websites.length} websites</span></div>
            <ol className="browsing-sites">{(showAllSites ? websites : websites.slice(0, 8)).map(site => <li key={site.domain}><span className="browsing-site-icon"><SiteIcon url={`https://${site.domain}`} /></span><div className="browsing-site-info"><strong>{site.domain}</strong><span>{site.topic && site.topic.toLowerCase() !== 'other' ? site.topic : 'Active browsing'}</span><div className="browsing-share-track"><span style={{ width: `${site.percentage}%` }} /></div></div><div className="browsing-site-time"><strong>{duration(site.duration_seconds)}</strong><small>{site.percentage}%</small></div></li>)}</ol>
            {websites.length > 8 && <button className="browsing-show-all" onClick={() => setShowAllSites(value => !value)}>{showAllSites ? 'Show fewer websites' : `Show all ${websites.length} websites`}</button>}
          </div><div className="browsing-topics-panel"><div className="browsing-panel-heading"><h3>By subject</h3><button className="browsing-show-all" onClick={() => setSubjectRetry(value => value + 1)}>Update subjects</button></div><p className="browsing-panel-note">Headings follow what you browse in this period, using content titles and channels—even when you haven’t saved the page. Smaller interests move down as your habits change.</p>{subjectStatus && <p className="browsing-panel-note" role="status">{subjectStatus}</p>}{summary.topic_breakdown.map(topic => <div className="browsing-topic" key={topic.topic}><div><span>{topic.topic.toLowerCase() === 'other' ? 'Not enough context yet' : topic.topic}</span><strong>{duration(topic.duration_seconds)}</strong></div><progress value={topic.percentage} max={100} aria-label={`${topic.topic}: ${topic.percentage}%`} /></div>)}</div></div>
        </> : <div className="browsing-empty"><h3>Your browsing time will appear here.</h3><p>Use the browser with the extension enabled. Only your focused, active web tab counts; leaving a site open in the background does not.</p></div>}
      </>}
    </section>
  </div>;
}
