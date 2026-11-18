import { useEffect, useState } from 'react';
import { apiClient } from '../../lib/api-client';

interface CalendarStatus {
  configured: boolean;
  connected: boolean;
}

export function CalendarConnection() {
  const [status, setStatus] = useState<CalendarStatus>();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const result = await apiClient.get<CalendarStatus>('/api/calendar/status');
        if (active) setStatus(result);
      } catch {
        if (active) setStatus(undefined);
      }
    };
    void refresh();
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
    };
  }, []);

  async function perform(action: 'connect' | 'sync' | 'test' | 'disconnect') {
    setBusy(true);
    setFeedback('');
    setError('');
    try {
      if (action === 'connect') {
        const { url } = await apiClient.post<{ url: string }>('/api/calendar/oauth/start', {});
        if (new URL(url).origin !== 'https://accounts.google.com') {
          throw new Error('The backend returned an invalid Google sign-in URL.');
        }
        await chrome.tabs.create({ url });
      } else if (action === 'sync') {
        const result = await apiClient.post<{ synced: number; failed: number }>('/api/calendar/sync', {});
        setFeedback(result.synced ? `Synced ${result.synced} reminder(s).` : 'No reminders needed updating.');
        if (result.failed) setError('Some changes couldn’t reach Google Calendar. Reconnect if the problem persists.');
      } else if (action === 'test') {
        const result = await apiClient.post<{ at: string }>('/api/calendar/test-alert', {});
        const time = new Date(result.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        setFeedback(`Test alert scheduled for ${time}. Check your phone’s Google Calendar notifications.`);
      } else {
        await apiClient.post('/api/calendar/disconnect', {});
        setStatus({ configured: true, connected: false });
        setFeedback('Disconnected. Existing events are still in Google Calendar.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach Calendar sync.');
    } finally {
      setBusy(false);
    }
  }

  if (!status?.configured) return null;
  return (
    <article className="reminder-card calendar-connection">
      <header><strong>Google Calendar</strong>{status.connected && <small>Connected</small>}</header>
      <p>{status.connected
        ? 'Reminders sync to your Tab Organizer Reminders calendar.'
        : 'Connect once to send reminders to your Google Calendar, even when your laptop is off.'}</p>
      <div className="reminder-actions">
        {status.connected && <button disabled={busy} onClick={() => void perform('test')}>Send test alert</button>}
        {status.connected && <button disabled={busy} onClick={() => void perform('sync')}>Sync now</button>}
        <button disabled={busy} onClick={() => void perform('connect')}>
          {status.connected ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}
        </button>
        {status.connected && <button disabled={busy} onClick={() => void perform('disconnect')}>Disconnect</button>}
      </div>
      {feedback && <p role="status">{feedback}</p>}
      {error && <p role="alert">{error}</p>}
    </article>
  );
}
