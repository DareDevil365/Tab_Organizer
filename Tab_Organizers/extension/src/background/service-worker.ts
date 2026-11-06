import { apiClient } from '../lib/api-client';
import { storage } from '../lib/storage';
import { normalizeUrl } from '../lib/url-normalize';
import {
  getNextContrastingGroupColor,
  markGroupColorUsed,
  VALID_GROUP_COLORS
} from '../lib/group-colors';

const HEALTH_ALARM = 'backend-health-check';
const FLUSH_ACTIVITY_ALARM = 'flush-activity-logs';

interface ActiveTabSession {
  tabId: number;
  url: string;
  domain: string;
  startedAt: number; // ms
}

interface QueuedActivity {
  url: string;
  domain: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
}

export interface ClosedWindowTab {
  title: string;
  url: string;
  favIconUrl?: string;
  groupId?: number;
  groupTitle?: string;
  groupColor?: string;
}

export interface ClosedWindowGroup {
  id: number;
  title?: string;
  color?: string;
}

export interface ClosedWindowSession {
  session_id: string;
  closed_at: number; // ms timestamp
  tab_count: number;
  title_preview: string;
  tabs: ClosedWindowTab[];
  groups?: ClosedWindowGroup[];
}

export interface BrowserWindowSnapshot {
  window_index: number;
  tabs: ClosedWindowTab[];
  groups: ClosedWindowGroup[];
}

export interface BrowserSessionSnapshot {
  session_id: string;
  closed_at: number; // ms timestamp
  window_count: number;
  total_tab_count: number;
  title_preview: string;
  windows: BrowserWindowSnapshot[];
}

let currentSession: ActiveTabSession | null = null;
let isUserActive = true;
let lastKnownBackendStatus: 'connected' | 'disconnected' | 'checking' = 'checking';

// In-memory active window tracking + persisted to storage for Service Worker sleep safety
const activeWindowsSnapshot = new Map<number, {
  tabs: ClosedWindowTab[];
  groups: ClosedWindowGroup[];
  lastUpdated: number;
}>();

// Buffer holding recent window snapshots before deletion to prevent race condition when windows are closed
const closedWindowsBuffer = new Map<number, {
  tabs: ClosedWindowTab[];
  groups: ClosedWindowGroup[];
  lastUpdated: number;
}>();

// Session cluster lock to prevent race condition when closing multiple windows rapidly
let isProcessingWindowRemoval = false;
const removalQueue: number[] = [];

// Track last known normal bounds for each window to support perfect bidirectional format swapping
const lastKnownNormalBounds = new Map<number, { left: number; top: number; width: number; height: number }>();

// Continuously record window geometry when in normal state
chrome.windows.onBoundsChanged.addListener((win) => {
  if (
    win.id &&
    win.state === 'normal' &&
    typeof win.left === 'number' &&
    typeof win.top === 'number' &&
    typeof win.width === 'number' &&
    typeof win.height === 'number'
  ) {
    if (win.left > -10000 && win.width > 50 && win.height > 50) {
      lastKnownNormalBounds.set(win.id, {
        left: win.left,
        top: win.top,
        width: win.width,
        height: win.height
      });
    }
  }
});

// 1. Extension Lifecycle Listeners
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Tab Organizer installed.');
  const now = Date.now();
  await storage.set('browser_startup_time', now);
  storage.setBackendStatus('checking');
  setupAlarms();
  setupContextMenus();
  await snapshotAllWindows();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('Tab Organizer started.');
  const now = Date.now();
  await storage.set('browser_startup_time', now);
  storage.setBackendStatus('checking');
  setupAlarms();
  checkPendingReminders();
  await snapshotAllWindows();
});

function setupAlarms() {
  chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.create(FLUSH_ACTIVITY_ALARM, { periodInMinutes: 0.5 });
  checkBackendHealth();
}

function setupContextMenus() {
  chrome.contextMenus.create({
    id: 'save-to-library',
    title: 'Save to Tab Organizer Library',
    contexts: ['page', 'link']
  }, () => {
    if (chrome.runtime.lastError) {
      // Ignore if already exists
    }
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'save-to-library' && tab?.url) {
    const targetUrl = info.linkUrl || tab.url;
    try {
      await apiClient.post('/api/pages', {
        url_original: targetUrl,
        url_normalized: normalizeUrl(targetUrl),
        title: tab.title || targetUrl,
        favicon_url: tab.favIconUrl || '',
        domain: new URL(targetUrl).hostname,
      });
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'public/icons/icon48.png',
        title: 'Tab Organizer',
        message: 'Saved to your personal library!'
      });
    } catch {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'public/icons/icon48.png',
        title: 'Tab Organizer',
        message: 'Failed to save page. Ensure backend is running.'
      });
    }
  }
});

// 2. Alarm Dispatcher
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === HEALTH_ALARM) {
    await checkBackendHealth();
  } else if (alarm.name === FLUSH_ACTIVITY_ALARM) {
    await flushActivityLogs();
  }
});

async function checkBackendHealth() {
  try {
    const health = await apiClient.healthCheck();
    const isOk = health.status === 'ok';
    const newStatus = isOk ? 'connected' : 'disconnected';

    if (newStatus === 'connected' && lastKnownBackendStatus === 'disconnected') {
      checkPendingReminders();
    }

    lastKnownBackendStatus = newStatus;
    await storage.setBackendStatus(newStatus);
  } catch {
    lastKnownBackendStatus = 'disconnected';
    await storage.setBackendStatus('disconnected');
  }
}

// 3. Time Tracking & Tab Listeners
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await endCurrentSession();
  await startSessionForTab(activeInfo.tabId);
  debouncedSnapshot();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (currentSession && currentSession.tabId === tabId && changeInfo.url) {
    await endCurrentSession();
    await startSessionForTab(tabId);
  }
  if (changeInfo.status === 'complete' || changeInfo.url || changeInfo.title) {
    debouncedSnapshot();
  }
});

chrome.tabs.onCreated.addListener(() => debouncedSnapshot());
chrome.tabs.onRemoved.addListener(() => debouncedSnapshot());
chrome.tabs.onMoved.addListener(() => debouncedSnapshot());
chrome.tabs.onAttached.addListener(() => debouncedSnapshot());
chrome.tabs.onDetached.addListener(() => debouncedSnapshot());

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await endCurrentSession();
  } else {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab?.id) {
      await startSessionForTab(tab.id);
    }
  }
  debouncedSnapshot();
});

chrome.idle.onStateChanged.addListener(async (newState) => {
  isUserActive = (newState === 'active');
  if (!isUserActive) {
    await endCurrentSession();
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await startSessionForTab(tab.id);
    }
  }
});

async function startSessionForTab(tabId: number) {
  if (!isUserActive) return;

  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.url && tab.url.startsWith('http')) {
      const domain = new URL(tab.url).hostname;
      currentSession = {
        tabId,
        url: tab.url,
        domain,
        startedAt: Date.now()
      };
    }
  } catch {
    currentSession = null;
  }
}

async function endCurrentSession() {
  if (!currentSession) return;

  const now = Date.now();
  const durationMs = now - currentSession.startedAt;
  const durationSeconds = Math.round(durationMs / 1000);

  if (durationSeconds >= 2 && currentSession.url.startsWith('http')) {
    const activity: QueuedActivity = {
      url: currentSession.url,
      domain: currentSession.domain,
      started_at: new Date(currentSession.startedAt).toISOString(),
      ended_at: new Date(now).toISOString(),
      duration_seconds: durationSeconds
    };

    await queueActivity(activity);
  }

  currentSession = null;
}

async function queueActivity(activity: QueuedActivity) {
  const currentQueue = (await storage.get<QueuedActivity[]>('activity_queue')) || [];
  currentQueue.push(activity);
  await storage.set('activity_queue', currentQueue);
}

async function flushActivityLogs() {
  const queue = await storage.get<QueuedActivity[]>('activity_queue');
  if (!queue || queue.length === 0) return;

  try {
    await apiClient.post('/api/activity', { activities: queue });
    await storage.set('activity_queue', []);
  } catch (error) {
    console.debug('Failed to flush activity logs to backend, will retry next alarm.');
  }
}

// 4. Live Windows Snapshot Engine (Always Persisted)
let snapshotTimeout: any = null;
function debouncedSnapshot() {
  if (snapshotTimeout) clearTimeout(snapshotTimeout);
  snapshotTimeout = setTimeout(() => {
    snapshotAllWindows();
  }, 250);
}

async function snapshotAllWindows(): Promise<Record<string, { tabs: ClosedWindowTab[]; groups: ClosedWindowGroup[]; lastUpdated: number }>> {
  try {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    const liveStorageMap: Record<string, { tabs: ClosedWindowTab[]; groups: ClosedWindowGroup[]; lastUpdated: number }> = {};
    const currentWindowIds = new Set<number>();

    for (const win of windows) {
      if (!win.id || !win.tabs || win.tabs.length === 0) continue;
      currentWindowIds.add(win.id);

      let groupMap = new Map<number, chrome.tabGroups.TabGroup>();
      try {
        const groups = await chrome.tabGroups.query({ windowId: win.id });
        groups.forEach(g => groupMap.set(g.id, g));
      } catch {}

      const meaningfulTabs = win.tabs.filter(t => t.url && !t.url.startsWith('chrome://newtab') && !t.url.startsWith('edge://newtab') && !t.url.startsWith('brave://newtab'));
      const tabsToRecord = meaningfulTabs.length > 0 ? meaningfulTabs : win.tabs;

      const tabsInfo: ClosedWindowTab[] = tabsToRecord.map(t => {
        const grp = t.groupId && t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? groupMap.get(t.groupId) : undefined;
        return {
          title: t.title || t.url || 'Untitled Tab',
          url: t.url || '',
          favIconUrl: t.favIconUrl,
          groupId: t.groupId,
          groupTitle: grp?.title,
          groupColor: grp?.color
        };
      });

      const groupsInfo: ClosedWindowGroup[] = Array.from(groupMap.values()).map(g => ({
        id: g.id,
        title: g.title,
        color: g.color
      }));

      const windowData = {
        tabs: tabsInfo,
        groups: groupsInfo,
        lastUpdated: Date.now()
      };

      activeWindowsSnapshot.set(win.id, windowData);
      liveStorageMap[String(win.id)] = windowData;
    }

    // Move disappearing windows to closedWindowsBuffer instead of discarding them
    for (const winId of Array.from(activeWindowsSnapshot.keys())) {
      if (!currentWindowIds.has(winId)) {
        const existingData = activeWindowsSnapshot.get(winId);
        if (existingData) {
          closedWindowsBuffer.set(winId, existingData);
        }
        activeWindowsSnapshot.delete(winId);
      }
    }

    // Keep closedWindowsBuffer bounded
    if (closedWindowsBuffer.size > 50) {
      const oldestKeys = Array.from(closedWindowsBuffer.keys()).slice(0, closedWindowsBuffer.size - 50);
      oldestKeys.forEach(k => closedWindowsBuffer.delete(k));
    }

    // Persist live snapshot AND archive buffer to chrome.storage.local
    await storage.set('live_windows_snapshot', liveStorageMap);
    try {
      const existingArchive = (await storage.get<Record<string, any>>('window_snapshots_archive')) || {};
      const mergedArchive = { ...existingArchive, ...liveStorageMap };
      const archiveKeys = Object.keys(mergedArchive);
      if (archiveKeys.length > 50) {
        archiveKeys.slice(0, archiveKeys.length - 50).forEach(k => delete mergedArchive[k]);
      }
      await storage.set('window_snapshots_archive', mergedArchive);
    } catch {}

    return liveStorageMap;
  } catch (err) {
    console.debug('Error taking window snapshot:', err);
    return {};
  }
}

// 5. Robust Window Removal & Session Clustering Pipeline
chrome.windows.onRemoved.addListener((windowId) => {
  lastKnownNormalBounds.delete(windowId);
  removalQueue.push(windowId);
  processRemovalQueue();
});

async function processRemovalQueue() {
  if (isProcessingWindowRemoval) return;
  isProcessingWindowRemoval = true;

  while (removalQueue.length > 0) {
    const windowId = removalQueue.shift()!;
    try {
      await handleWindowRemoved(windowId);
    } catch (err) {
      console.debug('Error processing window removal:', err);
    }
  }

  isProcessingWindowRemoval = false;
}

async function handleWindowRemoved(windowId: number) {
  // 1. Check in-memory active map, then buffer, then live storage, then archive storage
  let snapshot = activeWindowsSnapshot.get(windowId) || closedWindowsBuffer.get(windowId);
  if (!snapshot) {
    const liveStorage = (await storage.get<Record<string, { tabs: ClosedWindowTab[]; groups: ClosedWindowGroup[]; lastUpdated: number }>>('live_windows_snapshot')) || {};
    snapshot = liveStorage[String(windowId)];
  }
  if (!snapshot) {
    const archiveStorage = (await storage.get<Record<string, { tabs: ClosedWindowTab[]; groups: ClosedWindowGroup[]; lastUpdated: number }>>('window_snapshots_archive')) || {};
    snapshot = archiveStorage[String(windowId)];
  }

  if (!snapshot || !snapshot.tabs || snapshot.tabs.length === 0) {
    console.debug(`No snapshot found for closed window ${windowId}`);
    return;
  }

  const validTabs = snapshot.tabs.filter(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));
  const tabsToSave = validTabs.length > 0 ? validTabs : snapshot.tabs.filter(t => t.url && !t.url.startsWith('chrome://newtab') && !t.url.startsWith('edge://newtab') && !t.url.startsWith('brave://newtab'));
  if (tabsToSave.length === 0) return;

  const now = Date.now();
  const titles = tabsToSave.slice(0, 3).map(t => (t.title || 'Tab').split(' - ')[0].trim()).join(', ');
  const remainder = tabsToSave.length > 3 ? ` (+${tabsToSave.length - 3} more)` : '';
  const titlePreview = `${titles}${remainder}`;

  // 2. Save Single Closed Window Session (Keep up to 30)
  const singleClosedSession: ClosedWindowSession = {
    session_id: `win_${now}_${windowId}`,
    closed_at: now,
    tab_count: tabsToSave.length,
    title_preview: titlePreview,
    tabs: tabsToSave,
    groups: snapshot.groups
  };

  try {
    const existing = (await storage.get<ClosedWindowSession[]>('recently_closed_windows')) || [];
    const updated = [singleClosedSession, ...existing.filter(s => s.session_id !== singleClosedSession.session_id)].slice(0, 30);
    await storage.set('recently_closed_windows', updated);
    // Notify backend asynchronously without blocking local persistence
    apiClient.post('/api/windows/closed', singleClosedSession).catch(err => {
      console.debug('Failed to sync closed window to backend:', err);
    });
  } catch (err) {
    console.debug('Saved single-window closed snapshot locally.', err);
  }

  // 3. Multi-Window Session Clustering (Persistent across all window closes)
  const clusterState = (await storage.get<{ pendingWindows: BrowserWindowSnapshot[]; lastClosedAt: number; sessionId: string }>('cluster_state')) || {
    pendingWindows: [],
    lastClosedAt: 0,
    sessionId: ''
  };

  const CLUSTER_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
  let newPendingWindows: BrowserWindowSnapshot[];
  let newSessionId: string;

  const windowSnap: BrowserWindowSnapshot = {
    window_index: clusterState.pendingWindows.length,
    tabs: tabsToSave,
    groups: snapshot.groups || []
  };

  if (now - clusterState.lastClosedAt > CLUSTER_THRESHOLD_MS || clusterState.pendingWindows.length === 0) {
    newSessionId = `session_${now}`;
    newPendingWindows = [windowSnap];
  } else {
    windowSnap.window_index = clusterState.pendingWindows.length;
    newPendingWindows = [...clusterState.pendingWindows, windowSnap];
    newSessionId = clusterState.sessionId || `session_${now}`;
  }

  await storage.set('cluster_state', {
    pendingWindows: newPendingWindows,
    lastClosedAt: now,
    sessionId: newSessionId
  });

  const totalTabsInCluster = newPendingWindows.reduce((acc, w) => acc + w.tabs.length, 0);
  const clusterPreview = newPendingWindows.map((w, idx) => `Window ${idx + 1} (${w.tabs.length} tabs)`).join(' · ');

  const browserSessionSnap: BrowserSessionSnapshot = {
    session_id: newSessionId,
    closed_at: now,
    window_count: newPendingWindows.length,
    total_tab_count: totalTabsInCluster,
    title_preview: clusterPreview,
    windows: [...newPendingWindows]
  };

  try {
    const existingSessions = (await storage.get<BrowserSessionSnapshot[]>('browser_sessions_cache')) || [];
    const updatedSessions = [
      browserSessionSnap,
      ...existingSessions.filter(s => s.session_id !== newSessionId)
    ].slice(0, 5);
    await storage.set('browser_sessions_cache', updatedSessions);
    // Notify backend asynchronously without blocking local persistence
    apiClient.post('/api/windows/browser-sessions', browserSessionSnap).catch(err => {
      console.debug('Failed to sync browser session to backend:', err);
    });
  } catch (err) {
    console.debug('Saved multi-window browser session locally.', err);
  }

  // Remove from live memory & storage
  activeWindowsSnapshot.delete(windowId);
  closedWindowsBuffer.delete(windowId);
  const liveStorage = (await storage.get<Record<string, any>>('live_windows_snapshot')) || {};
  delete liveStorage[String(windowId)];
  await storage.set('live_windows_snapshot', liveStorage);
}

// 6. Fast, Direct Tab Group Rebuilder & Tab Resolver
async function getTabsForWindow(windowId: number, expectedCount: number, maxRetries = 6): Promise<chrome.tabs.Tab[]> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const tabs = await chrome.tabs.query({ windowId });
      if (tabs && tabs.length >= expectedCount) {
        return tabs;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 60));
  }
  try {
    return await chrome.tabs.query({ windowId });
  } catch {
    return [];
  }
}

async function restoreTabGroupsForWindow(
  windowId: number,
  createdTabs: chrome.tabs.Tab[],
  validTabs: ClosedWindowTab[],
  groups: ClosedWindowGroup[]
): Promise<void> {
  if (!groups || groups.length === 0 || !createdTabs || createdTabs.length === 0) return;

  try {
    // Map original groupId -> list of new tab IDs by 1:1 index matching with validTabs
    const groupTabsMap = new Map<number, number[]>();

    const minLen = Math.min(validTabs.length, createdTabs.length);
    for (let i = 0; i < minLen; i++) {
      const orig = validTabs[i];
      const created = createdTabs[i];
      if (orig && orig.groupId && orig.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && created && created.id) {
        const list = groupTabsMap.get(orig.groupId) || [];
        list.push(created.id);
        groupTabsMap.set(orig.groupId, list);
      }
    }

    for (const [origGroupId, tabIds] of groupTabsMap.entries()) {
      if (tabIds.length === 0) continue;
      try {
        const newGroupId = await chrome.tabs.group({ tabIds, windowId });
        const meta = groups.find(g => g.id === origGroupId);
        if (meta && (meta.title || meta.color)) {
          await chrome.tabGroups.update(newGroupId, {
            title: meta.title || '',
            color: (meta.color as any) || 'blue'
          });
        }
      } catch (grpErr) {
        console.debug('Failed to group tab batch:', grpErr);
      }
    }
  } catch (err) {
    console.debug('Error in restoreTabGroupsForWindow:', err);
  }
}

// 7. Message Handlers for Reincarnation
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Reincarnate Single Closed Window
  if (message.type === 'RESTORE_CLOSED_WINDOW' && message.session) {
    const session: ClosedWindowSession = message.session;
    (async () => {
      try {
        const validTabs = session.tabs.filter(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));
        const urls = validTabs.map(t => t.url);
        if (urls.length === 0) {
          sendResponse({ success: false, error: 'No valid URLs found in session' });
          return;
        }

        const newWin = await chrome.windows.create({ url: urls, focused: true, populate: true });

        if (newWin.id && session.groups && session.groups.length > 0) {
          const actualTabs = await getTabsForWindow(newWin.id, urls.length);
          await restoreTabGroupsForWindow(newWin.id, actualTabs, validTabs, session.groups);
        }

        // Clean up from storage & backend
        const existing = (await storage.get<ClosedWindowSession[]>('recently_closed_windows')) || [];
        await storage.set('recently_closed_windows', existing.filter(s => s.session_id !== session.session_id));
        try { await apiClient.delete(`/api/windows/closed/${session.session_id}`); } catch {}

        sendResponse({ success: true, windowId: newWin.id });
      } catch (err: any) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // Get Recent Closed Windows
  if (message.type === 'GET_RECENT_CLOSED_WINDOWS') {
    (async () => {
      try {
        let sessions = (await storage.get<ClosedWindowSession[]>('recently_closed_windows')) || [];
        if (sessions.length === 0) {
          try {
            const res = await apiClient.get<{ sessions: ClosedWindowSession[] }>('/api/windows/closed?limit=30');
            if (res?.sessions?.length) {
              sessions = res.sessions;
              await storage.set('recently_closed_windows', sessions);
            }
          } catch {}
        }

        const now = Date.now();
        const enriched = sessions.map(s => {
          const elapsedSec = Math.max(0, Math.round((now - s.closed_at) / 1000));
          return {
            ...s,
            elapsed_seconds: elapsedSec,
            is_recent_5m: elapsedSec <= 300,
            closed_ago: elapsedSec < 60 ? `${elapsedSec}s ago` : elapsedSec < 3600 ? `${Math.floor(elapsedSec / 60)}m ago` : `${Math.floor(elapsedSec / 3600)}h ago`
          };
        });

        sendResponse({ sessions: enriched });
      } catch (e: any) {
        sendResponse({ sessions: [], error: e.message });
      }
    })();
    return true;
  }

  // Get Browser Startup & Latest Sessions Status
  if (message.type === 'GET_BROWSER_STARTUP_STATUS') {
    (async () => {
      try {
        let sessions = (await storage.get<BrowserSessionSnapshot[]>('browser_sessions_cache')) || [];
        if (sessions.length === 0) {
          try {
            const apiRes = await apiClient.get<{ sessions: BrowserSessionSnapshot[] }>('/api/windows/browser-sessions');
            if (apiRes?.sessions?.length) {
              sessions = apiRes.sessions;
              await storage.set('browser_sessions_cache', sessions);
            }
          } catch {}
        }

        const now = Date.now();
        const startupTime = (await storage.get<number>('browser_startup_time')) || now;
        const elapsedSinceStartup = Math.max(0, Math.round((now - startupTime) / 1000));
        // Startup banner is active during the first 5 minutes (300 seconds) after browser launch
        const isStartupActive = elapsedSinceStartup <= 300;

        const latest = sessions[0] || null;
        let elapsedSinceClosed = 0;
        let closedAgo = '';

        if (latest) {
          elapsedSinceClosed = Math.max(0, Math.round((now - latest.closed_at) / 1000));
          closedAgo = elapsedSinceClosed < 60
            ? `${elapsedSinceClosed}s ago`
            : elapsedSinceClosed < 3600
            ? `${Math.floor(elapsedSinceClosed / 60)}m ago`
            : elapsedSinceClosed < 86400
            ? `${Math.floor(elapsedSinceClosed / 3600)}h ago`
            : `${Math.floor(elapsedSinceClosed / 86400)}d ago`;
        }

        sendResponse({
          has_session: !!latest,
          is_startup_active: isStartupActive,
          startup_seconds_left: Math.max(0, 300 - elapsedSinceStartup),
          elapsed_since_startup: elapsedSinceStartup,
          latest_session: latest ? { ...latest, closed_ago: closedAgo } : null,
          total_sessions: sessions.length
        });
      } catch (err: any) {
        sendResponse({ error: err.message, has_session: false });
      }
    })();
    return true;
  }

  // Get All Browser Sessions
  if (message.type === 'GET_ALL_BROWSER_SESSIONS') {
    (async () => {
      try {
        let sessions = (await storage.get<BrowserSessionSnapshot[]>('browser_sessions_cache')) || [];
        try {
          const apiRes = await apiClient.get<{ sessions: any[] }>('/api/windows/browser-sessions');
          if (apiRes?.sessions?.length) {
            sessions = apiRes.sessions;
            await storage.set('browser_sessions_cache', sessions.slice(0, 5));
          }
        } catch {}
        sendResponse({ sessions });
      } catch {
        sendResponse({ sessions: [] });
      }
    })();
    return true;
  }

  // Reincarnate Full Multi-Window Browser Session
  if (message.type === 'REINCARNATE_BROWSER_SESSION' && message.session) {
    const session: BrowserSessionSnapshot = message.session;
    (async () => {
      try {
        let createdWindowsCount = 0;
        const newWindowIds = new Set<number>();

        // Check if current active window is just 1 empty newtab to auto-close it cleanly
        let initialBlankWindowId: number | null = null;
        try {
          const allCurrentWins = await chrome.windows.getAll({ populate: true });
          if (allCurrentWins.length === 1 && allCurrentWins[0].tabs?.length === 1) {
            const singleTabUrl = allCurrentWins[0].tabs[0].url || '';
            if (singleTabUrl.startsWith('chrome://newtab') || singleTabUrl.startsWith('edge://newtab') || singleTabUrl.startsWith('brave://newtab') || singleTabUrl === 'about:blank') {
              initialBlankWindowId = allCurrentWins[0].id || null;
            }
          }
        } catch {}

        for (let i = 0; i < session.windows.length; i++) {
          const win = session.windows[i];
          const validTabs = win.tabs.filter(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));
          const urls = validTabs.map(t => t.url);
          if (urls.length === 0) continue;

          const createdWin = await chrome.windows.create({ url: urls, focused: i === 0, populate: true });
          if (createdWin.id) {
            newWindowIds.add(createdWin.id);
            createdWindowsCount++;

            if (win.groups && win.groups.length > 0) {
              const actualTabs = await getTabsForWindow(createdWin.id, urls.length);
              await restoreTabGroupsForWindow(createdWin.id, actualTabs, validTabs, win.groups);
            }
          }
        }

        // Close initial blank new tab window if new windows were created
        if (initialBlankWindowId && createdWindowsCount > 0 && !newWindowIds.has(initialBlankWindowId)) {
          try {
            await chrome.windows.remove(initialBlankWindowId);
          } catch {}
        }

        // Clean up from storage & backend
        const existing = (await storage.get<BrowserSessionSnapshot[]>('browser_sessions_cache')) || [];
        await storage.set('browser_sessions_cache', existing.filter(s => s.session_id !== session.session_id));
        try { await apiClient.delete(`/api/windows/browser-sessions/${session.session_id}`); } catch {}

        sendResponse({ success: true, restored_windows: createdWindowsCount });
      } catch (err: any) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // Delete Specific Browser Session
  if (message.type === 'DELETE_BROWSER_SESSION' && message.sessionId) {
    (async () => {
      const existing = (await storage.get<BrowserSessionSnapshot[]>('browser_sessions_cache')) || [];
      await storage.set('browser_sessions_cache', existing.filter(s => s.session_id !== message.sessionId));
      try { await apiClient.delete(`/api/windows/browser-sessions/${message.sessionId}`); } catch {}
      sendResponse({ success: true });
    })();
    return true;
  }

  // Create Chrome Tab Group from selected tab IDs
  if (message.type === 'CREATE_TAB_GROUP' && Array.isArray(message.tabIds)) {
    (async () => {
      try {
        if (message.tabIds.length === 0) {
          sendResponse({ success: false, error: 'No tabs provided' });
          return;
        }
        const groupId = await chrome.tabs.group({ tabIds: message.tabIds });
        let groupColor = message.color;
        if (!groupColor || !VALID_GROUP_COLORS.includes(groupColor)) {
          groupColor = await getNextContrastingGroupColor();
        }
        await chrome.tabGroups.update(groupId, {
          title: message.title || '',
          color: groupColor as any
        });
        await markGroupColorUsed(groupColor);
        sendResponse({ success: true, groupId });
      } catch (err: any) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // Restore Saved Tab Group into Chrome
  if (message.type === 'RESTORE_SAVED_GROUP' && Array.isArray(message.tabs)) {
    (async () => {
      try {
        const validTabs = message.tabs.filter((t: any) => t && t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));
        if (validTabs.length === 0) {
          sendResponse({ success: false, error: 'No valid URLs found to restore' });
          return;
        }

        const currentWin = await chrome.windows.getLastFocused({ populate: false });
        const windowId = currentWin?.id;

        const createResults = await Promise.allSettled(
          validTabs.map((t: any) => chrome.tabs.create({ windowId, url: t.url, active: false }))
        );

        const createdTabIds: number[] = [];
        for (const res of createResults) {
          if (res.status === 'fulfilled' && res.value?.id) {
            createdTabIds.push(res.value.id);
          }
        }

        if (createdTabIds.length > 0) {
          const groupId = await chrome.tabs.group({
            tabIds: createdTabIds,
            createProperties: windowId ? { windowId } : undefined
          });

          let safeColor = VALID_GROUP_COLORS.includes(message.color) ? message.color : '';
          if (!safeColor) {
            safeColor = await getNextContrastingGroupColor();
            await markGroupColorUsed(safeColor);
          }

          if (message.name || safeColor) {
            try {
              await chrome.tabGroups.update(groupId, {
                title: message.name || '',
                color: safeColor as any
              });
            } catch {}
          }

          try {
            await chrome.tabs.update(createdTabIds[0], { active: true });
          } catch {}

          sendResponse({ success: true, groupId, count: createdTabIds.length });
        } else {
          sendResponse({ success: false, error: 'Failed to create tabs' });
        }
      } catch (err: any) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // Switch and Swap Multiverse Earth Windows (Preserves 1:3 split or form factor)
  if (message.type === 'SWITCH_AND_SWAP_WINDOW' && message.targetWindowId) {
    (async () => {
      const res = await switchAndSwapWindowServiceWorker(
        message.targetWindowId,
        message.sourceWindowId,
        message.sourceBounds
      );
      sendResponse(res);
    })();
    return true;
  }
});

async function transitionWindowToNormalAndSetBounds(
  winId: number,
  bounds: { left: number; top: number; width: number; height: number }
): Promise<void> {
  const rLeft = Math.round(bounds.left);
  const rTop = Math.round(bounds.top);
  const rWidth = Math.max(200, Math.round(bounds.width));
  const rHeight = Math.max(150, Math.round(bounds.height));

  try {
    const current = await chrome.windows.get(winId);

    // If window is minimized or maximized, transition to 'normal' first
    if (current.state !== 'normal') {
      await chrome.windows.update(winId, { state: 'normal' });

      // Poll until state is confirmed 'normal'
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 25));
        const check = await chrome.windows.get(winId);
        if (check.state === 'normal') break;
      }
      // DWM settle buffer
      await new Promise((r) => setTimeout(r, 50));
    }

    // Apply geometry with retry loop
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await chrome.windows.update(winId, {
          left: rLeft,
          top: rTop,
          width: rWidth,
          height: rHeight
        });
        break;
      } catch (err) {
        await new Promise((r) => setTimeout(r, 50));
        try {
          await chrome.windows.update(winId, { state: 'normal' });
        } catch {}
      }
    }

    // Verification check: ensure Windows DWM didn't drop the coordinates
    await new Promise((r) => setTimeout(r, 60));
    const verified = await chrome.windows.get(winId);
    if (
      verified.state === 'normal' &&
      (Math.abs((verified.left ?? 0) - rLeft) > 25 ||
        Math.abs((verified.top ?? 0) - rTop) > 25 ||
        Math.abs((verified.width ?? 0) - rWidth) > 25 ||
        Math.abs((verified.height ?? 0) - rHeight) > 25)
    ) {
      await chrome.windows.update(winId, {
        left: rLeft,
        top: rTop,
        width: rWidth,
        height: rHeight
      });
    }

    // Keep tracked bounds updated
    lastKnownNormalBounds.set(winId, { left: rLeft, top: rTop, width: rWidth, height: rHeight });
  } catch (err) {
    console.debug('transitionWindowToNormalAndSetBounds error:', err);
  }
}

async function switchAndSwapWindowServiceWorker(
  targetWindowId: number,
  sourceWindowId?: number,
  providedSourceBounds?: { left?: number; top?: number; width?: number; height?: number; state?: string }
): Promise<{ success: boolean; error?: string }> {
  try {
    const targetWin = await chrome.windows.get(targetWindowId);
    if (!targetWin || !targetWin.id) {
      return { success: false, error: 'Target window not found' };
    }

    // Determine source window
    let sourceWin: chrome.windows.Window | null = null;
    if (sourceWindowId && sourceWindowId !== targetWindowId) {
      try {
        sourceWin = await chrome.windows.get(sourceWindowId);
      } catch {}
    }
    if (!sourceWin || !sourceWin.id || sourceWin.id === targetWindowId) {
      try {
        const allNormal = await chrome.windows.getAll({ windowTypes: ['normal'] });
        sourceWin = allNormal.find(w => w.id !== targetWindowId && w.focused)
                 || allNormal.find(w => w.id !== targetWindowId)
                 || null;
      } catch {}
    }

    if (!sourceWin || !sourceWin.id || sourceWin.id === targetWin.id) {
      // Single window fallback: just focus and restore target
      if (targetWin.state === 'minimized') {
        await chrome.windows.update(targetWindowId, { state: 'normal' });
      }
      await chrome.windows.update(targetWindowId, { focused: true });
      const activeTabs = await chrome.tabs.query({ windowId: targetWindowId, active: true });
      if (activeTabs.length > 0 && activeTabs[0]?.id) {
        await chrome.tabs.update(activeTabs[0].id, { active: true });
      }
      return { success: true };
    }

    // Capture real-time pre-swap source state & bounds
    const curState = sourceWin.state || providedSourceBounds?.state || 'normal';
    const curLeft = (typeof sourceWin.left === 'number' && sourceWin.left > -10000)
      ? sourceWin.left
      : (typeof providedSourceBounds?.left === 'number' ? providedSourceBounds.left : undefined);
    const curTop = (typeof sourceWin.top === 'number' && sourceWin.top > -10000)
      ? sourceWin.top
      : (typeof providedSourceBounds?.top === 'number' ? providedSourceBounds.top : undefined);
    const curWidth = (typeof sourceWin.width === 'number' && sourceWin.width > 50)
      ? sourceWin.width
      : (typeof providedSourceBounds?.width === 'number' ? providedSourceBounds.width : undefined);
    const curHeight = (typeof sourceWin.height === 'number' && sourceWin.height > 50)
      ? sourceWin.height
      : (typeof providedSourceBounds?.height === 'number' ? providedSourceBounds.height : undefined);

    const hasValidCurBounds = typeof curLeft === 'number' &&
      typeof curTop === 'number' &&
      typeof curWidth === 'number' &&
      typeof curHeight === 'number';

    // Capture real-time pre-swap target state & bounds
    const tgtState = targetWin.state;
    const tgtLeft = (typeof targetWin.left === 'number' && targetWin.left > -10000)
      ? targetWin.left
      : lastKnownNormalBounds.get(targetWindowId)?.left;
    const tgtTop = (typeof targetWin.top === 'number' && targetWin.top > -10000)
      ? targetWin.top
      : lastKnownNormalBounds.get(targetWindowId)?.top;
    const tgtWidth = (typeof targetWin.width === 'number' && targetWin.width > 50)
      ? targetWin.width
      : lastKnownNormalBounds.get(targetWindowId)?.width;
    const tgtHeight = (typeof targetWin.height === 'number' && targetWin.height > 50)
      ? targetWin.height
      : lastKnownNormalBounds.get(targetWindowId)?.height;

    const hasValidTgtBounds = typeof tgtLeft === 'number' &&
      typeof tgtTop === 'number' &&
      typeof tgtWidth === 'number' &&
      typeof tgtHeight === 'number';

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 1: TARGET WINDOW COMES AND REPLACES THE ACTIVE FLOATING / SPLIT WINDOW
    // ─────────────────────────────────────────────────────────────────────────
    if (curState === 'maximized') {
      // Active window was maximized: Target window unminimizes (if needed) and becomes maximized
      if (tgtState === 'minimized') {
        await chrome.windows.update(targetWin.id, { state: 'normal' });
        await new Promise(r => setTimeout(r, 50));
      }
      await chrome.windows.update(targetWin.id, { state: 'maximized' });
    } else if (hasValidCurBounds) {
      // Active window was floating or split screen: Target window takes this exact format!
      await transitionWindowToNormalAndSetBounds(targetWin.id, {
        left: curLeft!,
        top: curTop!,
        width: curWidth!,
        height: curHeight!
      });
    } else {
      if (tgtState === 'minimized') {
        await chrome.windows.update(targetWin.id, { state: 'normal' });
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 2: FOCUS TARGET WINDOW AND ACTIVATE ITS ACTIVE TAB
    // ─────────────────────────────────────────────────────────────────────────
    try {
      await chrome.windows.update(targetWin.id, { focused: true });
      const activeTabs = await chrome.tabs.query({ windowId: targetWindowId, active: true });
      if (activeTabs.length > 0 && activeTabs[0]?.id) {
        await chrome.tabs.update(activeTabs[0].id, { active: true });
      }
    } catch {}

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 3: INITIAL ACTIVE WINDOW TAKES THE FORMAT OF THE NONACTIVE WINDOW
    // ─────────────────────────────────────────────────────────────────────────
    if (sourceWin?.id && sourceWin.id !== targetWin.id) {
      if (tgtState === 'minimized') {
        // "and if the nonactive one was minimized then now that initial active one will be minimized ."
        try {
          await chrome.windows.update(sourceWin.id, { state: 'minimized' });
        } catch (e) {
          console.debug('Failed to minimize source window:', e);
        }
      } else if (tgtState === 'maximized') {
        // "or say the initial nonactive one was opened in some format say full screen ... now the initial active window will have that format"
        try {
          if (curState !== 'normal') {
            await chrome.windows.update(sourceWin.id, { state: 'normal' });
            await new Promise(r => setTimeout(r, 50));
          }
          await chrome.windows.update(sourceWin.id, { state: 'maximized' });
        } catch {}
      } else if (hasValidTgtBounds) {
        // "or say the initial nonactive one was opened in some format say floating window or split screen now the initial active window will have that format"
        await transitionWindowToNormalAndSetBounds(sourceWin.id, {
          left: tgtLeft!,
          top: tgtTop!,
          width: tgtWidth!,
          height: tgtHeight!
        });
      }

      // Re-affirm focus on Target window so Windows OS keeps Target in the foreground
      try {
        await chrome.windows.update(targetWin.id, { focused: true });
        const activeTabs = await chrome.tabs.query({ windowId: targetWindowId, active: true });
        if (activeTabs.length > 0 && activeTabs[0]?.id) {
          await chrome.tabs.update(activeTabs[0].id, { active: true });
        }
      } catch {}
    }

    return { success: true };
  } catch (err: any) {
    console.error('switchAndSwapWindowServiceWorker error:', err);
    try {
      await chrome.windows.update(targetWindowId, { focused: true, state: 'normal' });
      const activeTabs = await chrome.tabs.query({ windowId: targetWindowId, active: true });
      if (activeTabs.length > 0 && activeTabs[0]?.id) {
        await chrome.tabs.update(activeTabs[0].id, { active: true });
      }
    } catch {}
    return { success: false, error: err.message };
  }
}

async function checkPendingReminders() {
  try {
    const res = await apiClient.get<{ reminders: Array<{ id: number; page_title?: string; note?: string; url: string }> }>('/api/reminders/pending');
    if (res?.reminders?.length) {
      for (const r of res.reminders) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'public/icons/icon48.png',
          title: 'Tab Reminder',
          message: r.note || `Remember to check: ${r.page_title || r.url}`
        });
      }
    }
  } catch {}
}
