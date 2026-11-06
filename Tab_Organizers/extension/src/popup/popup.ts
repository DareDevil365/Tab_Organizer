import { apiClient } from '../lib/api-client';
import { storage } from '../lib/storage';
import { normalizeUrl } from '../lib/url-normalize';
import { extractPageMetadata, ScrapedPageMetadata } from '../content/metadata-scraper';
import {
  getNextContrastingGroupColor,
  markGroupColorUsed,
  VALID_GROUP_COLORS,
  getChromeColorHex
} from '../lib/group-colors';

export interface TerminatorTarget {
  pattern: string;
  description?: string;
  enabled: boolean;
}

export interface TerminatorConfig {
  terminate_new_tabs: boolean;
  deduplicate_tabs: boolean;
  custom_targets: TerminatorTarget[];
}

export const DEFAULT_TERMINATOR_CONFIG: TerminatorConfig = {
  terminate_new_tabs: true,
  deduplicate_tabs: true,
  custom_targets: []
};

export function isNewTabPage(url: string): boolean {
  if (!url) return true;
  const lower = url.toLowerCase().trim();
  return (
    lower.startsWith('chrome://newtab') ||
    lower.startsWith('brave://newtab') ||
    lower.startsWith('edge://newtab') ||
    lower.startsWith('about:blank') ||
    lower.startsWith('chrome://welcome') ||
    lower === 'about:newtab'
  );
}

export function normalizeLinkTarget(pattern: string): string {
  let clean = pattern.trim();
  if (!clean) return '';
  if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
    clean = 'https://' + clean;
  }
  return normalizeUrl(clean);
}

export function matchesCustomTerminatorTarget(url: string, targets: TerminatorTarget[]): boolean {
  if (!url || !targets || targets.length === 0) return false;
  const lowerUrl = url.toLowerCase().trim();
  
  if (lowerUrl.startsWith('chrome://') || lowerUrl.startsWith('brave://') || lowerUrl.startsWith('edge://') || lowerUrl === 'about:blank') {
    return false;
  }

  const normTabUrl = normalizeUrl(url);
  const canonicalTab = normTabUrl.replace(/^https?:\/\/(www\.)?/, 'https://');

  return targets.some(t => {
    if (!t.enabled || !t.pattern || !t.pattern.trim()) return false;
    const targetNorm = normalizeLinkTarget(t.pattern);
    const canonicalTarget = targetNorm.replace(/^https?:\/\/(www\.)?/, 'https://');

    // EXACT link match: e.g. "youtube.com" matches ONLY "https://youtube.com/"
    // and will NEVER match "https://youtube.com/watch?v=..."
    return canonicalTab === canonicalTarget;
  });
}

interface ExtendedTab extends chrome.tabs.Tab {
  normalizedUrl: string;
  isDuplicate?: boolean;
  isTarget?: boolean;
  isNewTab?: boolean;
  isSavedInLibrary?: boolean;
}

document.addEventListener('DOMContentLoaded', async () => {
  const statusDot = document.getElementById('status-dot') as HTMLDivElement;
  const backendDot = document.getElementById('backend-dot') as HTMLSpanElement;
  const statusText = document.getElementById('backend-status-text') as HTMLSpanElement;
  const container = document.getElementById('tab-groups-container') as HTMLDivElement;
  const loading = document.getElementById('loading') as HTMLDivElement;
  const btnExport = document.getElementById('btn-export') as HTMLButtonElement | null;
  const btnDeleteTabs = document.getElementById('btn-delete-tabs') as HTMLButtonElement;
  const deleteTabsText = document.getElementById('delete-tabs-btn-text') as HTMLSpanElement;
  const btnOpenDashboard = document.getElementById('btn-open-dashboard') as HTMLDivElement;
  const btnSelectAll = document.getElementById('btn-select-all') as HTMLSpanElement;
  const btnDeselectAll = document.getElementById('btn-deselect-all') as HTMLSpanElement;
  const selectedCountSpan = document.getElementById('selected-count') as HTMLSpanElement;
  const totalCountSpan = document.getElementById('total-count') as HTMLSpanElement;
  const dupBanner = document.getElementById('dup-banner') as HTMLDivElement;
  const dupText = document.getElementById('dup-text') as HTMLSpanElement;
  const dupClose = document.getElementById('dup-close') as HTMLSpanElement;
  const btnTerminator = (document.getElementById('btn-terminator') || document.getElementById('btn-rip')) as HTMLButtonElement;

  // Single Consolidated Recovery Banner Elements
  const recoveryBanner = document.getElementById('recovery-banner') as HTMLDivElement;
  const recoveryIcon = document.getElementById('recovery-icon') as HTMLSpanElement;
  const recoveryTitle = document.getElementById('recovery-title') as HTMLSpanElement;
  const recoveryTimer = document.getElementById('recovery-timer') as HTMLSpanElement;
  const recoveryPreview = document.getElementById('recovery-preview') as HTMLDivElement;
  const btnRecoveryAction = document.getElementById('btn-recovery-action') as HTMLButtonElement;
  const recoveryActionText = document.getElementById('recovery-action-text') as HTMLSpanElement;
  const btnRecoveryHistory = document.getElementById('btn-recovery-history') as HTMLButtonElement;
  const recoveryDismiss = document.getElementById('recovery-dismiss') as HTMLSpanElement;
  const winHistoryModal = document.getElementById('win-history-modal') as HTMLDivElement;
  const winHistoryList = document.getElementById('win-history-list') as HTMLDivElement;
  const winHistoryClose = document.getElementById('win-history-close') as HTMLSpanElement;
  const progressContainer = document.getElementById('progress-container') as HTMLDivElement;
  const progressFill = document.getElementById('progress-fill') as HTMLDivElement;
  const progressStatus = document.getElementById('progress-status') as HTMLSpanElement;
  const progressPercent = document.getElementById('progress-percent') as HTMLSpanElement;
  const exportTitleInput = document.getElementById('export-title') as HTMLInputElement | null;
  const toastEl = document.getElementById('toast') as HTMLDivElement;

  const segLibrary = document.getElementById('seg-library') as HTMLDivElement;
  const segGroup = document.getElementById('seg-group') as HTMLDivElement;
  const groupSubnav = document.getElementById('group-subnav') as HTMLDivElement;
  const subtabSaved = document.getElementById('subtab-saved') as HTMLButtonElement;
  const subtabUnsaved = document.getElementById('subtab-unsaved') as HTMLButtonElement;
  const badgeSavedGroups = document.getElementById('badge-saved-groups') as HTMLSpanElement;
  const badgeUnsavedGroups = document.getElementById('badge-unsaved-groups') as HTMLSpanElement;
  const btnGroupPlus = document.getElementById('btn-group-plus') as HTMLButtonElement;
  const selectRow = document.querySelector('.select-row') as HTMLDivElement;
  const footerControls = document.getElementById('footer-controls') as HTMLDivElement;

  // Group Action Buttons in Footer
  const groupActionRow = document.getElementById('group-action-row') as HTMLDivElement;
  const btnCreateGroup = (document.getElementById('btn-create-group') || document.getElementById('btn-group-tabs')) as HTMLButtonElement;
  const createGroupText = (document.getElementById('create-group-btn-text') || document.getElementById('group-tabs-btn-text')) as HTMLSpanElement;
  const btnUngroup = document.getElementById('btn-ungroup') as HTMLButtonElement | null;
  const ungroupBtnText = document.getElementById('ungroup-btn-text') as HTMLSpanElement | null;

  // Group Creation & Save Modal
  const groupModal = document.getElementById('group-modal') as HTMLDivElement;
  const groupModalTitle = document.getElementById('group-modal-title') as HTMLSpanElement;
  const groupModalIcon = document.getElementById('group-modal-icon') as HTMLSpanElement;
  const groupModalClose = document.getElementById('group-modal-close') as HTMLSpanElement;
  const groupNameInput = document.getElementById('group-name-input') as HTMLInputElement;
  const groupColorPicker = document.getElementById('group-color-picker') as HTMLDivElement;
  const groupSaveCloseRow = document.getElementById('group-save-close-row') as HTMLDivElement;
  const groupCloseTabsCheckbox = document.getElementById('group-close-tabs-checkbox') as HTMLInputElement;
  const btnGroupModalCancel = document.getElementById('btn-group-modal-cancel') as HTMLButtonElement;
  const btnGroupModalConfirm = document.getElementById('btn-group-modal-confirm') as HTMLButtonElement;

  // ─── Toast Helper (replaces blocking alert()) ─────────────────────────────
  let toastTimer: any = null;
  function showToast(message: string, type: 'success' | 'error' | 'info' = 'info', durationMs = 3000) {
    if (!toastEl) return;
    if (toastTimer) clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.className = `toast ${type} show`;
    toastEl.style.display = 'block';
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('show');
      setTimeout(() => { toastEl.style.display = 'none'; }, 220);
    }, durationMs);
  }

  // ─── sendMessage with timeout guard ─────────────────────────────────────
  // Prevents buttons from being stuck in "Reincarnating..." if SW response is delayed.
  function sendMessageWithTimeout(
    msg: any,
    timeoutMs = 8000
  ): Promise<any> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ success: false, error: 'timeout' }), timeoutMs);
      chrome.runtime.sendMessage(msg, (res) => {
        clearTimeout(timer);
        resolve(res || { success: false, error: 'no_response' });
      });
    });
  }

  let allOpenTabs: ExtendedTab[] = [];
  let allGroups: chrome.tabGroups.TabGroup[] = [];
  let allSavedGroups: any[] = [];
  const selectedTabIds = new Set<number>();
  const selectedSavedTabKeys = new Set<string>();
  const selectedGroupKeys = new Set<string>();
  let currentMode: 'library' | 'group' = 'library';
  let currentGroupSubtab: 'saved' | 'unsaved' = 'saved';
  let savedLibraryUrlSet = new Set<string>();

  // Marvel Multiverse Earth designations
  const MARVEL_EARTH_NAMES = [
    'Earth-616',    // Marvel Prime
    'Earth-101',    // Explicitly requested
    'Earth-601',    // Explicitly requested
    'Earth-838',    // Illuminati Earth
    'Earth-199999', // MCU Main
    'Earth-928',    // Spider-Man 2099
    'Earth-1610',   // Ultimate Marvel
    'Earth-65',     // Spider-Gwen
    'Earth-1218',   // Real World
  ];
  let selectedWindowId: number | null = null;
  let normalWindows: chrome.windows.Window[] = [];

  // Immediately purge any stale custom_unsaved_groups so phantom groups never appear
  storage.remove('custom_unsaved_groups').catch(() => {});
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.remove(['custom_unsaved_groups']);
  }

  function isUrlSavedInLibrary(url: string): boolean {
    if (!url) return false;
    const norm = normalizeUrl(url);
    return savedLibraryUrlSet.has(norm);
  }

  // 1. Health check
  try {
    const health = await apiClient.healthCheck();
    if (health.status === 'ok') {
      statusDot.className = 'status-dot';
      statusDot.title = `Backend connected (v${health.version})`;
      backendDot.className = 'backend-dot';
      statusText.textContent = `Backend: Connected`;
      await storage.setBackendStatus('connected');
    } else {
      setBackendOffline();
    }
  } catch {
    setBackendOffline();
  }

  function setBackendOffline() {
    statusDot.className = 'status-dot disconnected';
    statusDot.title = 'Backend offline (127.0.0.1:8742)';
    backendDot.className = 'backend-dot disconnected';
    statusText.textContent = 'Backend: Offline';
    storage.setBackendStatus('disconnected');
  }

  // 2. Open dashboard
  btnOpenDashboard.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
  });

  // Multiverse Window Switcher & Position Swap (Universal format swap via Service Worker)
  async function switchAndSwapWindow(targetWindowId: number) {
    try {
      // 1. Identify current window and its live geometry before anything changes
      let currentWin: chrome.windows.Window | null = null;
      try {
        currentWin = await chrome.windows.getCurrent();
      } catch {}

      if (!currentWin || !currentWin.id || currentWin.id === targetWindowId) {
        if (selectedWindowId && selectedWindowId !== targetWindowId) {
          try {
            currentWin = await chrome.windows.get(selectedWindowId);
          } catch {}
        }
      }

      // If user clicked the window they are already on, do nothing
      if (currentWin && currentWin.id === targetWindowId) {
        return;
      }

      const sourceWindowId = currentWin?.id;
      const sourceBounds = currentWin ? {
        left: currentWin.left,
        top: currentWin.top,
        width: currentWin.width,
        height: currentWin.height,
        state: currentWin.state
      } : undefined;

      // 2. Optimistically update local selected Earth in popup
      selectedWindowId = targetWindowId;
      selectedTabIds.clear();
      selectedGroupKeys.clear();
      renderEarthWindowBar(normalWindows);

      // 3. Delegate execution to background Service Worker so it runs reliably even if popup closes!
      chrome.runtime.sendMessage({
        type: 'SWITCH_AND_SWAP_WINDOW',
        targetWindowId,
        sourceWindowId,
        sourceBounds
      }, async () => {
        // In case popup is still open, refresh tabs
        try {
          await refreshTabsFromChrome();
          renderTabs();
          updateGroupBadges();
          updateSelectionUI();
        } catch {}
      });
    } catch (err) {
      console.error('Error in switchAndSwapWindow:', err);
      // Fallback
      chrome.runtime.sendMessage({
        type: 'SWITCH_AND_SWAP_WINDOW',
        targetWindowId
      });
    }
  }

  function renderEarthWindowBar(wins: chrome.windows.Window[]) {
    const earthBar = document.getElementById('earth-window-bar');
    if (!earthBar) return;

    if (wins.length <= 1) {
      earthBar.style.display = 'none';
      earthBar.innerHTML = '';
      return;
    }

    earthBar.style.display = 'flex';
    earthBar.innerHTML = '';

    const activeIconUrl = chrome.runtime?.getURL ? chrome.runtime.getURL('icons/earth_active_clean.png') : 'icons/earth_active_clean.png';
    const barrenIconUrl = chrome.runtime?.getURL ? chrome.runtime.getURL('icons/earth_barren_clean.png') : 'icons/earth_barren_clean.png';

    // Sort deterministically so Earth-616 is consistently the first window (Blue theme)
    // and Earth-101 is consistently the second window (Red theme)
    const sortedWins = wins.slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

    sortedWins.forEach((win, index) => {
      if (!win.id) return;
      const isCurrent = win.id === selectedWindowId;
      const earthName = MARVEL_EARTH_NAMES[index % MARVEL_EARTH_NAMES.length];
      const tabCount = win.tabs ? win.tabs.length : 0;

      // Keep Earth identity constant per window (Earth-616 = Blue/Cyan lush cube, Earth-101 = Red/Magma barren cube)
      const isBlue = (index % 2 === 0);
      const earthIconUrl = isBlue ? activeIconUrl : barrenIconUrl;
      const themeClass = isBlue ? 'theme-blue' : 'theme-red';

      const tabBtn = document.createElement('div');
      tabBtn.className = `earth-tab ${themeClass} ${isCurrent ? 'active' : 'inactive'}`;
      tabBtn.setAttribute('data-window-id', String(win.id));
      tabBtn.setAttribute('title', `${earthName} (${tabCount} tabs) - ${isCurrent ? 'Active Window' : (win.state === 'minimized' ? 'Minimized — Click to Restore & Swap' : 'Click to Switch & Swap')}`);

      const iconImg = document.createElement('img');
      iconImg.className = 'earth-cube-icon';
      iconImg.src = earthIconUrl;
      iconImg.alt = earthName;

      const labelSpan = document.createElement('span');
      labelSpan.className = 'earth-tab-name';
      labelSpan.textContent = earthName;

      const badgeSpan = document.createElement('span');
      badgeSpan.className = 'earth-tab-badge';
      badgeSpan.textContent = `${tabCount}`;

      tabBtn.appendChild(iconImg);
      tabBtn.appendChild(labelSpan);
      tabBtn.appendChild(badgeSpan);

      tabBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (win.id) {
          await switchAndSwapWindow(win.id);
        }
      });

      earthBar.appendChild(tabBtn);
    });
  }

  // 3. Query Tabs & Tab Groups
  async function refreshTabsFromChrome() {
    try {
      try {
        normalWindows = await chrome.windows.getAll({ windowTypes: ['normal'], populate: true });
      } catch (winErr) {
        console.debug('Failed to get normal windows:', winErr);
        normalWindows = [];
      }

      // Determine active / selected window
      if (normalWindows.length > 0) {
        if (!selectedWindowId || !normalWindows.some(w => w.id === selectedWindowId)) {
          try {
            const lastFocused = await chrome.windows.getLastFocused({ windowTypes: ['normal'], populate: false });
            if (lastFocused?.id && normalWindows.some(w => w.id === lastFocused.id)) {
              selectedWindowId = lastFocused.id;
            }
          } catch {}
          if (!selectedWindowId) {
            const focusedWin = normalWindows.find(w => w.focused) || normalWindows[0];
            selectedWindowId = focusedWin ? focusedWin.id ?? null : null;
          }
        }
      } else {
        selectedWindowId = null;
      }

      // Render Multiverse Earth Window Bar (only visible when 2+ windows)
      renderEarthWindowBar(normalWindows);

      let rawTabs: chrome.tabs.Tab[] = [];
      try {
        if (selectedWindowId) {
          rawTabs = await chrome.tabs.query({ windowId: selectedWindowId });
        } else {
          rawTabs = await chrome.tabs.query({ currentWindow: true });
        }
        if (rawTabs.length === 0) {
          const lastWin = await chrome.windows.getLastFocused({ populate: false });
          if (lastWin?.id) {
            rawTabs = await chrome.tabs.query({ windowId: lastWin.id });
          }
        }
      } catch {}
      if (rawTabs.length === 0) {
        rawTabs = await chrome.tabs.query({});
      }

      try {
        if (selectedWindowId) {
          allGroups = await chrome.tabGroups.query({ windowId: selectedWindowId });
        } else {
          allGroups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
        }
        if (allGroups.length === 0) {
          allGroups = await chrome.tabGroups.query({});
        }
      } catch {
        allGroups = await chrome.tabGroups.query({});
      }
      loading.style.display = 'none';

      // Compute Terminator clutter (Duplicates, New Tabs, Custom Target list)
      let termConfig: TerminatorConfig = DEFAULT_TERMINATOR_CONFIG;
      try {
        const storedConfig = await storage.get<TerminatorConfig>('terminator_config');
        if (storedConfig) {
          termConfig = storedConfig;
        } else {
          const apiConfig = await apiClient.get<TerminatorConfig>('/api/terminator/rules');
          if (apiConfig && typeof apiConfig.terminate_new_tabs === 'boolean') {
            termConfig = apiConfig;
            await storage.set('terminator_config', apiConfig);
          }
        }
      } catch {
        // fallback to default
      }

      // Fetch saved library pages to check which open tabs are already saved
      let savedUrlSet = new Set<string>();
      try {
        const savedPages = await apiClient.get<any[]>('/api/pages?limit=1000');
        if (Array.isArray(savedPages)) {
          savedPages.forEach(p => {
            if (p.url_normalized) savedUrlSet.add(p.url_normalized);
            if (p.url_original) savedUrlSet.add(normalizeUrl(p.url_original));
          });
          savedLibraryUrlSet = savedUrlSet;
        }
      } catch {
        // offline fallback
      }

      const urlCountMap = new Map<string, number>();
      allOpenTabs = rawTabs.map(t => {
        const norm = normalizeUrl(t.url || '');
        urlCountMap.set(norm, (urlCountMap.get(norm) || 0) + 1);
        return { ...t, normalizedUrl: norm };
      });

      let excessDuplicateCopies = 0;
      for (const [, count] of urlCountMap.entries()) {
        if (count > 1) {
          excessDuplicateCopies += (count - 1);
        }
      }

      let newTabCount = 0;
      let customTargetCount = 0;

      allOpenTabs.forEach(t => {
        const isDup = (urlCountMap.get(t.normalizedUrl) || 0) > 1;
        const isNewTab = isNewTabPage(t.url || '');
        const isTarget = matchesCustomTerminatorTarget(t.url || '', termConfig.custom_targets || []);
        const isSaved = savedUrlSet.has(t.normalizedUrl);

        if (isSaved) {
          t.isSavedInLibrary = true;
        }
        if (isDup) {
          t.isDuplicate = true;
        }
        if (isNewTab) {
          t.isNewTab = true;
          newTabCount++;
        }
        if (isTarget) {
          t.isTarget = true;
          customTargetCount++;
        }
      });

      // Determine total tabs that will actually be closed by Terminator
      const totalClutter = (termConfig.deduplicate_tabs ? excessDuplicateCopies : 0) + 
                           (termConfig.terminate_new_tabs ? newTabCount : 0) + 
                           customTargetCount;

      if (totalClutter > 0) {
        dupBanner.style.display = 'flex';
        const details: string[] = [];
        if (excessDuplicateCopies > 0) details.push(`${excessDuplicateCopies} extra duplicates`);
        if (termConfig.terminate_new_tabs && newTabCount > 0) details.push(`${newTabCount} new tabs`);
        if (customTargetCount > 0) details.push(`${customTargetCount} targets`);

        dupText.textContent = `${totalClutter} clutter tabs (${details.join(', ')})`;
      } else {
        dupBanner.style.display = 'none';
      }

      totalCountSpan.textContent = String(allOpenTabs.length);
      renderTabs();
      updateSelectionUI();
    } catch (err) {
      loading.textContent = 'Error loading tabs.';
      console.error(err);
    }
  }

  await Promise.all([
    refreshTabsFromChrome(),
    loadSavedGroups()
  ]);
  updateGroupBadges();

  dupClose.addEventListener('click', () => {
    dupBanner.style.display = 'none';
  });

  btnTerminator?.addEventListener('click', async (e) => {
    e.stopPropagation();

    let termConfig: TerminatorConfig = DEFAULT_TERMINATOR_CONFIG;
    try {
      const storedConfig = await storage.get<TerminatorConfig>('terminator_config');
      if (storedConfig) termConfig = storedConfig;
    } catch {
      // fallback
    }

    const tabsToCloseSet = new Set<number>();

    // 1. Terminate New Tabs if enabled
    if (termConfig.terminate_new_tabs) {
      allOpenTabs.forEach(t => {
        if (t.id !== undefined && isNewTabPage(t.url || '')) {
          tabsToCloseSet.add(t.id);
        }
      });
    }

    // 2. Terminate Custom Target Tabs
    if (termConfig.custom_targets && termConfig.custom_targets.length > 0) {
      allOpenTabs.forEach(t => {
        if (t.id !== undefined && matchesCustomTerminatorTarget(t.url || '', termConfig.custom_targets)) {
          tabsToCloseSet.add(t.id);
        }
      });
    }

    // 3. Deduplicate tabs (Keep 1 copy, terminate siblings)
    if (termConfig.deduplicate_tabs) {
      const urlMap = new Map<string, ExtendedTab[]>();
      for (const tab of allOpenTabs) {
        // Skip already queued tabs
        if (tab.id !== undefined && tabsToCloseSet.has(tab.id)) continue;
        const list = urlMap.get(tab.normalizedUrl) || [];
        list.push(tab);
        urlMap.set(tab.normalizedUrl, list);
      }

      for (const [, tabs] of urlMap.entries()) {
        if (tabs.length > 1) {
          // Keep active tab if one is active, otherwise keep the first tab
          const activeIdx = tabs.findIndex(t => t.active);
          const keepIdx = activeIdx >= 0 ? activeIdx : 0;

          tabs.forEach((t, idx) => {
            if (idx !== keepIdx && t.id !== undefined) {
              tabsToCloseSet.add(t.id);
            }
          });
        }
      }
    }

    const tabsToClose = Array.from(tabsToCloseSet);

    if (tabsToClose.length === 0) {
      dupBanner.style.display = 'none';
      return;
    }

    try {
      // 1. Close tabs in Chrome
      await chrome.tabs.remove(tabsToClose);

      // 2. Remove closed tabs from allOpenTabs
      const closedSet = new Set(tabsToClose);
      allOpenTabs = allOpenTabs.filter(t => t.id === undefined || !closedSet.has(t.id));

      // 3. Remove closed tabs from selectedTabIds
      tabsToClose.forEach(id => selectedTabIds.delete(id));

      // 4. Clear isDuplicate flags on remaining tabs
      allOpenTabs.forEach(t => {
        t.isDuplicate = false;
      });

      // 5. Update counts and re-render UI
      totalCountSpan.textContent = String(allOpenTabs.length);
      dupBanner.style.display = 'none';

      renderTabs();
      updateSelectionUI();
    } catch (err) {
      console.error('Error in Terminator cleanup:', err);
    }
  });

  // ─── Unified Smart Recovery Banner ────────────────────────────────────────
  let activeRecoverySession: { type: 'startup' | 'window'; session: any } | null = null;
  let allClosedSessions: any[] = [];
  let recoveryTimerInterval: any = null;

  function formatElapsed(elapsedSec: number): string {
    if (elapsedSec < 60) return `${elapsedSec}s ago`;
    if (elapsedSec < 3600) return `${Math.floor(elapsedSec / 60)}m ago`;
    return `${Math.floor(elapsedSec / 3600)}h ago`;
  }

  function showRecoveryBanner(type: 'startup' | 'window', session: any) {
    if (!recoveryBanner) return;
    activeRecoverySession = { type, session };

    if (type === 'startup') {
      if (recoveryIcon) recoveryIcon.textContent = '✨';
      if (recoveryTitle) recoveryTitle.textContent = `Previous Session (${session.total_tab_count || 0} tabs, ${session.window_count || 1} win)`;
      if (recoveryTimer) recoveryTimer.textContent = session.closed_ago || 'Ready';
      if (recoveryPreview) recoveryPreview.textContent = session.title_preview || 'Restore all windows and tab groups';
      if (recoveryActionText) recoveryActionText.textContent = '✦ Reincarnate Session';
      if (btnRecoveryHistory) btnRecoveryHistory.textContent = 'All Sessions';
    } else {
      if (recoveryIcon) recoveryIcon.textContent = '🪟';
      if (recoveryTitle) recoveryTitle.textContent = `Closed Window (${session.tab_count} tabs)`;
      if (recoveryTimer) recoveryTimer.textContent = session.closed_ago || 'Recent';
      if (recoveryPreview) recoveryPreview.textContent = session.title_preview || 'Saved tabs session';
      if (recoveryActionText) recoveryActionText.textContent = '✦ Reincarnate';
      if (btnRecoveryHistory) btnRecoveryHistory.textContent = 'History';
    }

    recoveryBanner.style.display = 'flex';
  }

  function startRecoveryTimer(startTimeMs: number) {
    if (recoveryTimerInterval) clearInterval(recoveryTimerInterval);
    recoveryTimerInterval = setInterval(() => {
      if (!activeRecoverySession || recoveryBanner.style.display === 'none') {
        clearInterval(recoveryTimerInterval);
        return;
      }
      const elapsed = Math.round((Date.now() - startTimeMs) / 1000);
      if (elapsed > 300) {
        recoveryBanner.style.display = 'none';
        activeRecoverySession = null;
        clearInterval(recoveryTimerInterval);
        return;
      }
      if (recoveryTimer) recoveryTimer.textContent = formatElapsed(elapsed);
    }, 1000);
  }

  async function checkStartupBrowserSession(retryIfEmpty = true) {
    try {
      chrome.runtime.sendMessage({ type: 'GET_BROWSER_STARTUP_STATUS' }, (res) => {
        if (res?.latest_session && res?.is_startup_active) {
          showRecoveryBanner('startup', res.latest_session);
        } else if (retryIfEmpty && res && res.is_startup_active) {
          setTimeout(() => checkStartupBrowserSession(false), 1200);
        } else {
          checkClosedWindows();
        }
      });
    } catch (e) {
      console.debug('Error checking startup browser session', e);
      checkClosedWindows();
    }
  }

  function checkClosedWindows() {
    try {
      chrome.runtime.sendMessage({ type: 'GET_RECENT_CLOSED_WINDOWS' }, (response) => {
        if (response?.sessions?.length > 0) {
          allClosedSessions = response.sessions;
          const recent = allClosedSessions[0];
          if (recent && recent.elapsed_seconds <= 300 && (!activeRecoverySession || activeRecoverySession.type !== 'startup')) {
            showRecoveryBanner('window', recent);
            if (recent.closed_at) {
              startRecoveryTimer(recent.closed_at);
            }
          }
        }
      });
    } catch (e) {
      console.debug('Error checking closed windows', e);
    }
  }

  checkStartupBrowserSession();

  recoveryDismiss?.addEventListener('click', () => {
    recoveryBanner.style.display = 'none';
    activeRecoverySession = null;
    if (recoveryTimerInterval) clearInterval(recoveryTimerInterval);
  });

  btnRecoveryAction?.addEventListener('click', async () => {
    if (!activeRecoverySession) return;
    const originalText = recoveryActionText ? recoveryActionText.textContent : '✦ Reincarnate';
    if (recoveryActionText) recoveryActionText.textContent = 'Reincarnating...';
    btnRecoveryAction.disabled = true;

    const msgType = activeRecoverySession.type === 'startup' ? 'REINCARNATE_BROWSER_SESSION' : 'RESTORE_CLOSED_WINDOW';
    const res = await sendMessageWithTimeout({
      type: msgType,
      session: activeRecoverySession.session
    });

    if (res?.success) {
      recoveryBanner.style.display = 'none';
      activeRecoverySession = null;
      window.close();
    } else {
      showToast(res?.error === 'timeout' ? 'Restore timed out — try again' : 'Restore failed', 'error');
      if (recoveryActionText) recoveryActionText.textContent = originalText;
      btnRecoveryAction.disabled = false;
    }
  });

  btnRecoveryHistory?.addEventListener('click', () => {
    if (activeRecoverySession?.type === 'startup') {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html#sessions') });
    } else {
      renderHistoryModal();
      winHistoryModal.style.display = 'flex';
    }
  });

  winHistoryClose?.addEventListener('click', () => {
    winHistoryModal.style.display = 'none';
  });

  function renderHistoryModal() {
    winHistoryList.innerHTML = '';
    if (!allClosedSessions || allClosedSessions.length === 0) {
      winHistoryList.innerHTML = '<div style="color: var(--text-tertiary); font-size: 12px; text-align: center; padding: 20px;">No closed window sessions recorded yet.</div>';
      return;
    }

    allClosedSessions.forEach((session) => {
      const item = document.createElement('div');
      item.className = 'win-history-item';
      item.innerHTML = `
        <div class="win-history-item-top">
          <div class="win-history-item-title">🪟 ${session.tab_count} tabs</div>
          <div class="win-history-item-time">${session.closed_ago}</div>
        </div>
        <div class="win-history-item-preview">${session.title_preview || 'Tab session'}</div>
      `;

      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'win-history-item-btn';
      restoreBtn.textContent = '✦ Reincarnate';
      restoreBtn.addEventListener('click', async () => {
        restoreBtn.textContent = 'Reincarnating...';
        restoreBtn.disabled = true;
        const res = await sendMessageWithTimeout({ type: 'RESTORE_CLOSED_WINDOW', session });
        if (res?.success) {
          winHistoryModal.style.display = 'none';
          closedWinBanner.style.display = 'none';
          window.close();
        } else {
          restoreBtn.textContent = '✦ Reincarnate';
          restoreBtn.disabled = false;
          showToast('Restore failed — try again', 'error');
        }
      });

      item.appendChild(restoreBtn);
      winHistoryList.appendChild(item);
    });
  }

  function findOpenChromeGroupForSavedGroup(savedGroup: any): { group: chrome.tabGroups.TabGroup; tabs: ExtendedTab[] } | null {
    if (!savedGroup) return null;
    const savedName = (savedGroup.name || '').trim().toLowerCase();
    const savedTabs: any[] = Array.isArray(savedGroup.tabs) ? savedGroup.tabs : [];
    const savedUrls = new Set<string>();
    for (const t of savedTabs) {
      if (t.url) savedUrls.add(t.url.trim().toLowerCase());
      if (t.url_original) savedUrls.add(t.url_original.trim().toLowerCase());
      if (t.url_normalized) savedUrls.add(t.url_normalized.trim().toLowerCase());
    }

    for (const cg of allGroups) {
      const cgTabs = allOpenTabs.filter(t => t.groupId === cg.id);
      if (cgTabs.length === 0) continue;
      const cgTitle = (cg.title || '').trim().toLowerCase();

      // 1. Direct title match
      if (savedName && cgTitle && savedName === cgTitle) {
        return { group: cg, tabs: cgTabs };
      }

      // 2. Tab URL overlap match
      if (savedUrls.size > 0) {
        const matches = cgTabs.filter(t => {
          const u = (t.url || '').trim().toLowerCase();
          const norm = (t.url_normalized || '').trim().toLowerCase();
          return savedUrls.has(u) || (norm && savedUrls.has(norm));
        });
        if (matches.length > 0 && (matches.length === cgTabs.length || matches.length === savedUrls.size)) {
          return { group: cg, tabs: cgTabs };
        }
      }
    }
    return null;
  }

  function getOpenSavedGroups(): any[] {
    return allSavedGroups.filter(g => findOpenChromeGroupForSavedGroup(g) !== null);
  }

  // Segment & Subnav switcher logic
  function updateGroupBadges() {
    if (badgeSavedGroups) {
      const openSaved = getOpenSavedGroups();
      badgeSavedGroups.textContent = String(openSaved.length);
    }
    if (badgeUnsavedGroups) {
      const unsaved = getUnsavedChromeGroups();
      badgeUnsavedGroups.textContent = String(unsaved.length);
    }
  }

  function switchToMode(mode: 'library' | 'group') {
    currentMode = mode;
    selectedTabIds.clear();
    selectedSavedTabKeys.clear();
    selectedGroupKeys.clear();
    if (mode === 'library') {
      segLibrary?.classList.add('active');
      segGroup?.classList.remove('active');
      if (groupSubnav) groupSubnav.style.display = 'none';
      if (selectRow) selectRow.style.display = 'flex';
      if (footerControls) footerControls.style.display = 'flex';
    } else {
      segGroup?.classList.add('active');
      segLibrary?.classList.remove('active');
      if (groupSubnav) groupSubnav.style.display = 'flex';
      if (selectRow) selectRow.style.display = 'flex';
      updateGroupBadges();
    }
    renderTabs();
    updateSelectionUI();
  }

  segLibrary?.addEventListener('click', () => {
    if (currentMode === 'library') return;
    switchToMode('library');
  });

  segGroup?.addEventListener('click', async () => {
    if (currentMode === 'group') return;
    selectedTabIds.clear();
    selectedSavedTabKeys.clear();
    selectedGroupKeys.clear();
    await loadSavedGroups();
    switchToMode('group');
  });

  subtabSaved?.addEventListener('click', () => {
    if (currentGroupSubtab === 'saved') return;
    currentGroupSubtab = 'saved';
    selectedTabIds.clear();
    selectedSavedTabKeys.clear();
    selectedGroupKeys.clear();
    subtabSaved.classList.add('active');
    subtabUnsaved.classList.remove('active');
    renderTabs();
    updateSelectionUI();
  });

  subtabUnsaved?.addEventListener('click', () => {
    if (currentGroupSubtab === 'unsaved') return;
    currentGroupSubtab = 'unsaved';
    selectedTabIds.clear();
    selectedSavedTabKeys.clear();
    selectedGroupKeys.clear();
    subtabUnsaved.classList.add('active');
    subtabSaved.classList.remove('active');
    renderTabs();
    updateSelectionUI();
  });

  btnGroupPlus?.addEventListener('click', async () => {
    const selectedIds = Array.from(selectedTabIds);
    if (selectedIds.length > 0) {
      await openGroupModal('group', selectedIds);
    } else {
      const activeTab = allOpenTabs.find(t => t.active) || allOpenTabs[0];
      const targetIds = activeTab?.id ? [activeTab.id] : allOpenTabs.map(t => t.id).filter((id): id is number => id !== undefined);
      await openGroupModal('group', targetIds, 'New Group');
    }
  });

  // Group Modal Logic
  let groupModalMode: 'group' | 'save' = 'group';
  let groupModalTargetTabIds: number[] = [];
  let groupModalTargetSavedKeys: string[] = [];
  let selectedGroupColor = 'blue';

  async function openGroupModal(
    mode: 'group' | 'save',
    tabIds: number[],
    savedKeysOrTitle: string[] | string = [],
    defaultTitle = '',
    defaultColor = ''
  ) {
    groupModalMode = mode;
    groupModalTargetTabIds = [...tabIds];

    let savedKeys: string[] = [];
    let title = defaultTitle;
    let color = defaultColor;

    if (Array.isArray(savedKeysOrTitle)) {
      savedKeys = savedKeysOrTitle;
    } else if (typeof savedKeysOrTitle === 'string') {
      title = savedKeysOrTitle;
      color = defaultTitle;
    }
    groupModalTargetSavedKeys = [...savedKeys];

    if (color) {
      selectedGroupColor = color;
    } else {
      selectedGroupColor = await getNextContrastingGroupColor();
    }

    const distinctCount = new Set([
      ...tabIds.map(id => `id:${id}`),
      ...savedKeys.map(k => `url:${k.split(':::').slice(2).join(':::')}`)
    ]).size;
    const totalCount = distinctCount || tabIds.length || savedKeys.length;

    groupModalTitle.textContent = `New Group (${totalCount})`;
    groupModalIcon.textContent = '🗂';
    btnGroupModalConfirm.textContent = 'Create Group';
    if (groupSaveCloseRow) groupSaveCloseRow.style.display = 'none';

    if (!title && tabIds.length > 0) {
      const firstTab = allOpenTabs.find(t => t.id === tabIds[0]);
      if (firstTab?.url) {
        try {
          const dom = new URL(firstTab.url).hostname.replace(/^www\./, '');
          title = dom.charAt(0).toUpperCase() + dom.slice(1);
        } catch {}
      }
    } else if (!title && savedKeys.length > 0) {
      const firstKey = savedKeys[0];
      const url = firstKey.split(':::').slice(2).join(':::');
      if (url) {
        try {
          const dom = new URL(url).hostname.replace(/^www\./, '');
          title = dom.charAt(0).toUpperCase() + dom.slice(1);
        } catch {}
      }
    }
    groupNameInput.value = title || 'New Group';

    groupColorPicker.querySelectorAll('.color-swatch').forEach(swatch => {
      const c = swatch.getAttribute('data-color');
      swatch.classList.toggle('selected', c === selectedGroupColor);
    });

    groupModal.style.display = 'flex';
    setTimeout(() => {
      groupNameInput.focus();
      groupNameInput.select();
    }, 80);
  }

  groupModalClose.addEventListener('click', () => {
    groupModal.style.display = 'none';
  });
  btnGroupModalCancel.addEventListener('click', () => {
    groupModal.style.display = 'none';
  });

  groupNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      btnGroupModalConfirm.click();
    }
  });

  groupColorPicker.addEventListener('click', (e) => {
    const swatch = (e.target as HTMLElement).closest('.color-swatch');
    if (swatch) {
      selectedGroupColor = swatch.getAttribute('data-color') || 'blue';
      groupColorPicker.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      swatch.classList.add('selected');
    }
  });

  btnGroupModalConfirm.addEventListener('click', async () => {
    const name = groupNameInput.value.trim() || 'New Group';
    const color = selectedGroupColor;
    const tabIds = [...groupModalTargetTabIds];
    const savedKeys = [...groupModalTargetSavedKeys];

    groupModal.style.display = 'none';

    try {
      // 1. Query all currently live tabs in Chrome
      const allLiveTabs = await chrome.tabs.query({});
      const liveTabMap = new Map(allLiveTabs.map(t => [t.id, t]));

      // 2. If saved keys were selected, remove those tabs from their existing Saved Groups in Karl X
      const savedTabsPayload: Array<{ url: string; title: string; favicon_url?: string; domain?: string }> = [];
      if (savedKeys.length > 0) {
        const byGroup = new Map<number, Set<string>>();
        savedKeys.forEach(k => {
          const parts = k.split(':::');
          const gId = parseInt(parts[0], 10);
          const url = parts.slice(2).join(':::');
          if (!byGroup.has(gId)) byGroup.set(gId, new Set());
          if (url) byGroup.get(gId)!.add(url);
        });

        for (const [gId, urlsToRemove] of byGroup.entries()) {
          const grp = allSavedGroups.find(g => g.id === gId);
          if (grp && Array.isArray(grp.tabs)) {
            const removed = grp.tabs.filter((t: any) => urlsToRemove.has(t.url || ''));
            removed.forEach((t: any) => {
              savedTabsPayload.push({
                url: t.url || '',
                title: t.title || t.url || 'Untitled',
                favicon_url: t.favicon_url || t.favIconUrl || '',
                domain: t.domain || ''
              });
            });

            // Remove selected tabs from their original saved group!
            const remainingTabs = grp.tabs.filter((t: any) => !urlsToRemove.has(t.url || ''));
            grp.tabs = remainingTabs;
            grp.tab_count = remainingTabs.length;
            try {
              if (remainingTabs.length > 0) {
                await apiClient.put(`/api/groups/${gId}`, { tabs: remainingTabs });
              } else {
                await apiClient.delete(`/api/groups/${gId}`);
                allSavedGroups = allSavedGroups.filter(g => g.id !== gId);
              }
            } catch (e) {
              console.debug('Failed to update old saved group:', e);
            }
          }
        }
        await storage.set('saved_tab_groups', allSavedGroups);

        // For any saved tab not currently open in Chrome, open it in Chrome so it can be grouped
        for (const st of savedTabsPayload) {
          if (!st.url) continue;
          const live = allLiveTabs.find(t => t.url === st.url || (t as any).url_normalized === st.url);
          if (live && live.id !== undefined) {
            if (!tabIds.includes(live.id)) {
              tabIds.push(live.id);
            }
          } else {
            try {
              const created = await chrome.tabs.create({ url: st.url, active: false });
              if (created.id !== undefined) {
                tabIds.push(created.id);
                allLiveTabs.push(created);
                liveTabMap.set(created.id, created);
              }
            } catch (e) {
              console.debug('Failed to create tab for saved tab url:', st.url, e);
            }
          }
        }
      }

      // 3. Identify live target tabs
      let targetTabs = tabIds
        .map(id => liveTabMap.get(id))
        .filter((t): t is chrome.tabs.Tab => !!t && t.id !== undefined);

      if (targetTabs.length === 0) {
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (activeTab && activeTab.id !== undefined) {
          targetTabs = [activeTab];
        } else if (allOpenTabs.length > 0 && allOpenTabs[0].id !== undefined) {
          const fallback = liveTabMap.get(allOpenTabs[0].id);
          if (fallback) targetTabs = [fallback];
        }
      }

      if (targetTabs.length === 0) {
        const freshTab = await chrome.tabs.create({ active: true });
        targetTabs = [freshTab];
      }

      // 4. Ensure all tabs belong to the same window (Chrome requires all group tabs in one window)
      const targetWindowId = targetTabs[0].windowId;
      for (const t of targetTabs) {
        if (t.windowId !== targetWindowId && t.id !== undefined) {
          try {
            await chrome.tabs.move(t.id, { windowId: targetWindowId, index: -1 });
            t.windowId = targetWindowId;
          } catch (e) {
            console.debug('Failed to move tab to target window:', e);
          }
        }
      }

      // 5. TAKE THOSE TABS OUT OF THE EXISTING GROUP IF THEY ARE IN A GROUP!
      // If not, we are already good to go!
      const tabsInExistingChromeGroup = targetTabs.filter(t =>
        t.groupId !== undefined &&
        t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE &&
        t.groupId > 0
      );
      if (tabsInExistingChromeGroup.length > 0) {
        const idsToUngroup = tabsInExistingChromeGroup.map(t => t.id!).filter(Boolean);
        try {
          await chrome.tabs.ungroup(idsToUngroup);
        } catch (ungroupErr) {
          console.debug('Failed to ungroup tabs from old group:', ungroupErr);
        }
      }

      // 6. Group all selected tabs directly in Chrome
      const cleanTabIds = targetTabs.map(t => t.id as number).filter(Boolean);
      const groupId = await chrome.tabs.group({ tabIds: cleanTabIds });

      // 7. Apply title and color to tab group
      const safeColor = VALID_GROUP_COLORS.includes(color as any) ? color : 'blue';
      try {
        await chrome.tabGroups.update(groupId, {
          title: name,
          color: safeColor as any
        });
        await markGroupColorUsed(safeColor);
      } catch (styleErr) {
        console.debug('Failed to set group styling:', styleErr);
      }

      // 8. If in Saved mode, or groupModalMode is 'save', or saved keys were selected:
      // Also save this newly formed group as a Saved Group in Karl X!
      if (currentGroupSubtab === 'saved' || groupModalMode === 'save' || savedKeys.length > 0) {
        const newGroupTabsPayload = targetTabs.map(t => ({
          url: t.url || '',
          title: t.title || t.url || 'Untitled',
          favicon_url: t.favIconUrl || '',
          domain: t.url ? (() => { try { return new URL(t.url).hostname.replace(/^www\./, ''); } catch { return ''; } })() : ''
        }));

        try {
          let savedResult: any = null;
          try {
            savedResult = await apiClient.post('/api/groups', {
              name,
              color: safeColor,
              tabs: newGroupTabsPayload
            });
          } catch {
            savedResult = {
              id: Date.now(),
              name,
              color: safeColor,
              tab_count: newGroupTabsPayload.length,
              tabs: newGroupTabsPayload,
              created_at: new Date().toISOString()
            };
          }
          const cached = (await storage.get<any[]>('saved_tab_groups')) || [];
          cached.unshift(savedResult);
          await storage.set('saved_tab_groups', cached);
          allSavedGroups = cached;
        } catch (saveErr) {
          console.debug('Failed to save newly created group in Karl X:', saveErr);
        }
      }

      // 9. Refresh open tabs & groups from Chrome
      await refreshTabsFromChrome();

      selectedTabIds.clear();
      selectedSavedTabKeys.clear();
      selectedGroupKeys.clear();

      if (currentMode === 'group') {
        updateGroupBadges();
        if (currentGroupSubtab === 'saved') {
          subtabSaved.classList.add('active');
          subtabUnsaved.classList.remove('active');
        } else {
          subtabUnsaved.classList.add('active');
          subtabSaved.classList.remove('active');
        }
      } else {
        switchToMode('group');
        currentGroupSubtab = 'unsaved';
        subtabUnsaved.classList.add('active');
        subtabSaved.classList.remove('active');
        updateGroupBadges();
      }

      renderTabs();
      updateSelectionUI();
      showToast(`✓ Created group "${name}" in Chrome!`, 'success');
    } catch (err: any) {
      console.error('Group tabs error', err);
      showToast(err?.message ? `Failed: ${err.message}` : 'Error creating group', 'error');
    }
  });

  // Saved Groups loading & rendering
  async function loadSavedGroups(): Promise<any[]> {
    try {
      const apiGroups = await apiClient.get<any[]>('/api/groups');
      if (Array.isArray(apiGroups)) {
        allSavedGroups = apiGroups;
        await storage.set('saved_tab_groups', apiGroups);
        return apiGroups;
      }
    } catch {}
    const cached = (await storage.get<any[]>('saved_tab_groups')) || [];
    allSavedGroups = cached;
    return cached;
  }

  function createTabLibraryActionButton(url: string, title?: string, faviconUrl?: string, onToggled?: (saved: boolean) => void): HTMLElement {
    const norm = normalizeUrl(url || '');
    const isSaved = savedLibraryUrlSet.has(norm);
    const actionBtn = document.createElement('button');
    actionBtn.className = `btn-lib-action ${isSaved ? 'remove' : 'add'}`;
    actionBtn.innerHTML = isSaved
      ? '<svg width="10" height="2" viewBox="0 0 10 2" fill="none"><rect width="10" height="2" rx="1" fill="#FFFFFF"/></svg>'
      : '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M5 1V9M1 5H9" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/></svg>';
    actionBtn.title = isSaved ? 'Remove from Karl X Library' : 'Save to Karl X Library';

    actionBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      actionBtn.disabled = true;
      actionBtn.style.opacity = '0.5';

      const currentlySaved = savedLibraryUrlSet.has(norm);

      if (currentlySaved) {
        try {
          await apiClient.delete(`/api/pages/by-url?url=${encodeURIComponent(url || '')}`);
          savedLibraryUrlSet.delete(norm);
          actionBtn.className = 'btn-lib-action add';
          actionBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M5 1V9M1 5H9" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/></svg>';
          actionBtn.title = 'Save to Karl X Library';
          onToggled?.(false);
          showToast('Removed from Library', 'info');
        } catch (err) {
          console.error('Failed to remove page from library', err);
        }
      } else {
        try {
          let dom = '';
          try { if (url) dom = new URL(url).hostname.replace(/^www\./, ''); } catch {}
          await apiClient.post('/api/pages/save-bulk', {
            tabs: [{
              url_original: url || '',
              url_normalized: norm,
              title: title || dom || 'Untitled',
              favicon_url: faviconUrl || '',
              domain: dom
            }]
          });
          savedLibraryUrlSet.add(norm);
          actionBtn.className = 'btn-lib-action remove';
          actionBtn.innerHTML = '<svg width="10" height="2" viewBox="0 0 10 2" fill="none"><rect width="10" height="2" rx="1" fill="#FFFFFF"/></svg>';
          actionBtn.title = 'Remove from Karl X Library';
          onToggled?.(true);
          showToast('Saved to Library', 'success');
        } catch (err) {
          console.error('Failed to save page to library', err);
        }
      }
      actionBtn.disabled = false;
      actionBtn.style.opacity = '1';
    });

    return actionBtn;
  }

  async function saveChromeGroupAction(group: chrome.tabGroups.TabGroup, tabs: ExtendedTab[]) {
    const tabsPayload = tabs.map(t => ({
      url: t.url || '',
      title: t.title || t.url || 'Untitled',
      favicon_url: t.favIconUrl || '',
      domain: t.url ? (() => { try { return new URL(t.url).hostname.replace(/^www\./, ''); } catch { return ''; } })() : ''
    }));

    try {
      const groupName = group.title || 'Chrome Group';
      let savedResult: any = null;
      try {
        savedResult = await apiClient.post('/api/groups', {
          name: groupName,
          color: group.color || 'blue',
          tabs: tabsPayload
        });
      } catch {
        savedResult = {
          id: Date.now(),
          name: groupName,
          color: group.color || 'blue',
          tab_count: tabsPayload.length,
          tabs: tabsPayload,
          created_at: new Date().toISOString()
        };
      }

      const cached = (await storage.get<any[]>('saved_tab_groups')) || [];
      cached.unshift(savedResult);
      await storage.set('saved_tab_groups', cached);
      allSavedGroups = cached;



      showToast(`✓ Saved "${groupName}" into Saved Groups!`, 'success');
      updateGroupBadges();
      currentGroupSubtab = 'saved';
      subtabSaved?.classList.add('active');
      subtabUnsaved?.classList.remove('active');
      renderTabs();
    } catch (err) {
      console.error('Failed to save Chrome group', err);
      showToast('Failed to save group', 'error');
    }
  }

  function renderSavedGroups() {
    const fragment = document.createDocumentFragment();
    const openSaved = getOpenSavedGroups();

    if (openSaved.length === 0) {
      const emptyNotice = document.createElement('div');
      emptyNotice.style.textAlign = 'center';
      emptyNotice.style.padding = '36px 16px';
      emptyNotice.style.color = 'var(--text-tertiary)';
      emptyNotice.innerHTML = `
        <div style="font-size: 32px; margin-bottom: 10px;">📑</div>
        <div style="font-size: 13.5px; font-weight: 700; color: var(--text-secondary); margin-bottom: 6px;">No Saved Groups Open in Browser</div>
        <div style="font-size: 12px; line-height: 1.4; max-width: 270px; margin: 0 auto 14px; color: var(--text-tertiary);">
          All saved groups are safely stored in your database. View or restore them in the Dashboard.
        </div>
        <button class="cta-btn primary" id="btn-empty-open-dashboard" style="display: inline-flex; width: auto; padding: 7px 16px; font-size: 11.5px; border-radius: 8px; margin: 0 auto;">
          Open Dashboard
        </button>
      `;
      emptyNotice.querySelector('#btn-empty-open-dashboard')?.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html#groups') });
      });
      fragment.appendChild(emptyNotice);
    } else {
      openSaved.forEach(group => {
        fragment.appendChild(createSavedGroupCard(group));
      });

      // Subtle footer link to view all saved groups in database via Dashboard
      const dashLinkRow = document.createElement('div');
      dashLinkRow.style.textAlign = 'center';
      dashLinkRow.style.padding = '12px 10px 8px';
      dashLinkRow.innerHTML = `
        <span class="link-btn" style="font-size: 11px; color: var(--accent); text-decoration: underline; cursor: pointer;">
          View all saved groups in Database (${allSavedGroups.length}) →
        </span>
      `;
      dashLinkRow.querySelector('.link-btn')?.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html#groups') });
      });
      fragment.appendChild(dashLinkRow);
    }
    container.replaceChildren(fragment);
  }

  function createSavedGroupCard(group: any): HTMLElement {
    const liveGroup = findOpenChromeGroupForSavedGroup(group);
    const card = document.createElement('div');
    card.className = 'saved-group-card is-saved';
    const rawColor = (liveGroup ? liveGroup.group.color : group.color) || 'green';
    const grpColor = getChromeColor(rawColor);
    card.style.borderLeftColor = grpColor;
    card.style.background = `linear-gradient(90deg, ${hexToRgba(grpColor, 0.14)} 0%, var(--surface) 45%)`;

    const tabs: any[] = liveGroup ? liveGroup.tabs : (group.tabs || []);
    const count = tabs.length;

    const header = document.createElement('div');
    header.className = 'saved-group-header';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'saved-group-title';
    titleDiv.textContent = (liveGroup ? liveGroup.group.title : group.name) || group.name || 'Saved Group';
    titleDiv.style.color = grpColor;

    const countDiv = document.createElement('div');
    countDiv.className = 'saved-group-badge';
    countDiv.textContent = `(${count})`;

    const statusPill = document.createElement('span');
    statusPill.className = 'group-status-pill saved';
    statusPill.textContent = 'Saved';

    const timeDiv = document.createElement('div');
    timeDiv.className = 'saved-group-time';
    timeDiv.innerHTML = `<span style="color: ${grpColor}; font-weight: 600;">Active in Chrome</span>`;

    // Circular minus (-) button: unsaves group from database
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-lib-action remove';
    removeBtn.innerHTML = '<svg width="10" height="2" viewBox="0 0 10 2" fill="none"><rect width="10" height="2" rx="1" fill="#FFFFFF"/></svg>';
    removeBtn.title = 'Unsave group from Database';
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      removeBtn.disabled = true;

      const groupName = group.name || 'Unnamed Group';

      // 1. Remove from Saved Groups in database
      try {
        await apiClient.delete(`/api/groups/${group.id}`);
      } catch {}
      allSavedGroups = allSavedGroups.filter(g => g.id !== group.id);
      await storage.set('saved_tab_groups', allSavedGroups);

      // Check if this group is currently open in Chrome
      const stillLive = findOpenChromeGroupForSavedGroup(group);
      updateGroupBadges();

      if (stillLive && stillLive.tabs.length > 0) {
        currentGroupSubtab = 'unsaved';
        subtabUnsaved?.classList.add('active');
        subtabSaved?.classList.remove('active');
        renderTabs();
        showToast(`✓ Moved "${groupName}" to Unsaved Groups`, 'info');
      } else {
        renderTabs();
        showToast(`✓ Removed "${groupName}" from Saved Groups`, 'info');
      }
    });

    const chevron = document.createElement('div');
    chevron.className = 'chevron';
    chevron.textContent = '▾';

    header.appendChild(titleDiv);
    header.appendChild(countDiv);
    header.appendChild(statusPill);
    header.appendChild(timeDiv);
    header.appendChild(removeBtn);
    header.appendChild(chevron);

    const body = document.createElement('div');

    const actionsRow = document.createElement('div');
    actionsRow.className = 'saved-group-actions';

    const exportBtn = document.createElement('button');
    exportBtn.className = 'btn-saved-action';
    exportBtn.innerHTML = '<span>⇩ HTML</span>';
    exportBtn.title = 'Download offline HTML export for this group';
    exportBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      exportBtn.disabled = true;
      exportBtn.innerHTML = '<span>Exporting...</span>';
      try {
        const res = await apiClient.post<{ html_content: string; item_count: number; title: string }>(
          `/api/groups/${group.id}/export`,
          {}
        );
        const blob = new Blob([res.html_content], { type: 'text/html;charset=utf-8' });
        const blobUrl = URL.createObjectURL(blob);
        const filename = `${(group.name || 'group').toLowerCase().replace(/[^a-z0-9]/g, '_')}_group.html`;
        if (chrome.downloads) {
          await chrome.downloads.download({ url: blobUrl, filename, saveAs: true });
        } else {
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = filename;
          a.click();
        }
        showToast(`✓ Exported group "${group.name}"`, 'success');
      } catch (err) {
        console.error('Failed to export saved group', err);
        showToast('Failed to export HTML', 'error');
      } finally {
        exportBtn.disabled = false;
        exportBtn.innerHTML = '<span>⇩ HTML</span>';
      }
    });

    // Dustbin button to close tabs of this group in browser (keeps saved in database)
    const closeBrowserBtn = document.createElement('button');
    closeBrowserBtn.className = 'btn-saved-action delete';
    closeBrowserBtn.innerHTML = '<span>🗑</span>';
    closeBrowserBtn.title = 'Close tabs of this group in browser (keeps in Saved Groups)';
    closeBrowserBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      closeBrowserBtn.disabled = true;
      try {
        const liveInfo = findOpenChromeGroupForSavedGroup(group);
        const tabIds = liveInfo
          ? liveInfo.tabs.map(t => t.id).filter((id): id is number => typeof id === 'number')
          : [];
        if (tabIds.length > 0) {
          if (allOpenTabs.length <= tabIds.length) {
            await chrome.tabs.create({});
          }
          await chrome.tabs.remove(tabIds);
        }
        await refreshTabsFromChrome();
        renderTabs();
        updateSelectionUI();
        showToast(`✓ Closed "${group.name}" tabs in browser`, 'info');
      } catch (err: any) {
        console.error('Failed to close group tabs in Chrome:', err);
        showToast('Failed to close tabs', 'error');
      }
    });

    actionsRow.appendChild(exportBtn);
    actionsRow.appendChild(closeBrowserBtn);

    const groupKey = `saved-${group.id}`;
    if (selectedGroupKeys.has(groupKey)) {
      card.classList.add('group-selected');
      header.classList.add('selected');
    }

    const tabsList = document.createElement('div');
    tabsList.className = 'saved-tabs-list';

    tabs.forEach((tab: any, idx: number) => {
      const tabUrl = tab.url || tab.url_original || '';
      const tabKey = `${group.id}:::${idx}:::${tabUrl}`;
      const tabId = tab.id !== undefined ? tab.id : (allOpenTabs.find(ot => ot.url === tabUrl || ot.url_normalized === tabUrl)?.id);
      const isChecked = (tabId !== undefined && selectedTabIds.has(tabId)) || selectedSavedTabKeys.has(tabKey);

      const tabEl = document.createElement('div');
      tabEl.className = `tab-item ${isChecked ? 'checked' : ''}`;
      tabEl.style.paddingLeft = '14px';

      const favicon = document.createElement('img');
      favicon.className = 'tab-favicon';
      favicon.src = tab.favIconUrl || tab.favicon_url || 'public/icons/icon16.png';
      favicon.onerror = () => { favicon.src = 'public/icons/icon16.png'; };

      const title = document.createElement('div');
      title.className = 'tab-title';
      title.textContent = tab.title || tabUrl || 'Untitled';
      title.title = tabUrl;

      tabEl.appendChild(favicon);
      tabEl.appendChild(title);

      if (tab.active) {
        tabEl.appendChild(createPokeballIndicator(tab));
      }

      const libBtn = createTabLibraryActionButton(tabUrl, tab.title, tab.favIconUrl || tab.favicon_url);
      tabEl.appendChild(libBtn);

      // Single-click toggles selection of this individual tab
      tabEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const nowChecked = !tabEl.classList.contains('checked');
        tabEl.classList.toggle('checked', nowChecked);
        if (nowChecked) {
          selectedSavedTabKeys.add(tabKey);
          if (tabId !== undefined) selectedTabIds.add(tabId);
        } else {
          selectedSavedTabKeys.delete(tabKey);
          if (tabId !== undefined) selectedTabIds.delete(tabId);
          selectedGroupKeys.delete(groupKey);
          card.classList.remove('group-selected');
          header.classList.remove('selected');
        }
        updateSelectionUI();
      });

      // Double-click switches to or opens tab in Chrome
      tabEl.addEventListener('dblclick', async (e) => {
        e.stopPropagation();
        if (tabId !== undefined) {
          try {
            await chrome.tabs.update(tabId, { active: true });
            if (tab.windowId !== undefined) {
              await chrome.windows.update(tab.windowId, { focused: true });
            }
            window.close();
          } catch {}
        }
      });

      tabsList.appendChild(tabEl);
    });

    body.appendChild(actionsRow);
    if (tabs.length > 0) {
      body.appendChild(tabsList);
    }

    let collapsed = false;
    header.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.chevron')) {
        collapsed = !collapsed;
        body.style.display = collapsed ? 'none' : '';
        chevron.classList.toggle('collapsed', collapsed);
        return;
      }
      if (target.closest('.btn-lib-action') || target.closest('.btn-saved-action')) {
        return;
      }

      // Clicking group header toggles selection for the whole group!
      const nowSelected = !selectedGroupKeys.has(groupKey);
      if (nowSelected) {
        selectedGroupKeys.add(groupKey);
        card.classList.add('group-selected');
        header.classList.add('selected');
        tabs.forEach((t: any, idx: number) => {
          const tUrl = t.url || t.url_original || '';
          selectedSavedTabKeys.add(`${group.id}:::${idx}:::${tUrl}`);
          const tId = t.id !== undefined ? t.id : allOpenTabs.find(ot => ot.url === tUrl || ot.url_normalized === tUrl)?.id;
          if (tId !== undefined) selectedTabIds.add(tId);
        });
        tabsList.querySelectorAll('.tab-item').forEach(el => el.classList.add('checked'));
      } else {
        selectedGroupKeys.delete(groupKey);
        card.classList.remove('group-selected');
        header.classList.remove('selected');
        tabs.forEach((t: any, idx: number) => {
          const tUrl = t.url || t.url_original || '';
          selectedSavedTabKeys.delete(`${group.id}:::${idx}:::${tUrl}`);
          const tId = t.id !== undefined ? t.id : allOpenTabs.find(ot => ot.url === tUrl || ot.url_normalized === tUrl)?.id;
          if (tId !== undefined) selectedTabIds.delete(tId);
        });
        tabsList.querySelectorAll('.tab-item').forEach(el => el.classList.remove('checked'));
      }
      updateSelectionUI();
    });

    card.appendChild(header);
    card.appendChild(body);
    return card;
  }

  function getUnsavedChromeGroups(): { group: chrome.tabGroups.TabGroup; tabs: ExtendedTab[] }[] {
    const unsaved: { group: chrome.tabGroups.TabGroup; tabs: ExtendedTab[] }[] = [];
    for (const group of allGroups) {
      const tabsInGroup = allOpenTabs.filter(t => t.groupId === group.id);
      if (tabsInGroup.length === 0) continue;

      const groupTitleNorm = (group.title || '').trim().toLowerCase();

      // Check if this group matches any saved group in allSavedGroups
      const isSaved = allSavedGroups.some(sg => {
        const savedTitleNorm = (sg.name || '').trim().toLowerCase();
        if (groupTitleNorm && savedTitleNorm && groupTitleNorm === savedTitleNorm) {
          return true;
        }
        if (Array.isArray(sg.tabs) && sg.tabs.length > 0) {
          const matchCount = tabsInGroup.filter(t => sg.tabs.some((st: any) => st.url === t.url)).length;
          if (matchCount === tabsInGroup.length) return true;
        }
        return false;
      });

      if (!isSaved) {
        unsaved.push({ group, tabs: tabsInGroup });
      }
    }
    return unsaved;
  }

  function renderUnsavedGroups() {
    const fragment = document.createDocumentFragment();
    const unsavedList = getUnsavedChromeGroups();
    const ungroupedTabs = allOpenTabs.filter(t => t.groupId === undefined || t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE);

    if (unsavedList.length === 0 && ungroupedTabs.length === 0) {
      const emptyNotice = document.createElement('div');
      emptyNotice.style.textAlign = 'center';
      emptyNotice.style.padding = '40px 16px';
      emptyNotice.style.color = 'var(--text-tertiary)';
      emptyNotice.innerHTML = `
        <div style="font-size: 32px; margin-bottom: 10px;">✨</div>
        <div style="font-size: 13.5px; font-weight: 700; color: var(--text-secondary); margin-bottom: 6px;">All Groups Saved</div>
        <div style="font-size: 12px; line-height: 1.4; max-width: 260px; margin: 0 auto;">
          All tab groups are currently saved in Karl X. Click <b>+ New Group</b> above to create a new group.
        </div>
      `;
      fragment.appendChild(emptyNotice);
      container.replaceChildren(fragment);
      return;
    }

    // Render unsaved Chrome tab groups (active in browser)
    for (const item of unsavedList) {
      const group = item.group;
      const tabs = item.tabs;
      const grpColor = getChromeColor(group.color || 'blue');

      const card = document.createElement('div');
      card.className = 'saved-group-card is-unsaved';
      card.style.borderLeftColor = grpColor;
      card.style.background = `linear-gradient(90deg, ${hexToRgba(grpColor, 0.14)} 0%, var(--surface) 45%)`;

      const header = document.createElement('div');
      header.className = 'saved-group-header';

      const titleDiv = document.createElement('div');
      titleDiv.className = 'saved-group-title';
      titleDiv.textContent = group.title || 'Unnamed Chrome Group';
      titleDiv.style.color = grpColor;

      const badgeDiv = document.createElement('div');
      badgeDiv.className = 'saved-group-badge';
      badgeDiv.textContent = `(${tabs.length})`;

      const statusPill = document.createElement('span');
      statusPill.className = 'group-status-pill unsaved';
      statusPill.textContent = 'Unsaved';

      const timeDiv = document.createElement('div');
      timeDiv.className = 'saved-group-time';
      timeDiv.innerHTML = `<span style="color: ${grpColor}; font-weight: 600;">Active in Chrome</span>`;

      const chevron = document.createElement('div');
      chevron.className = 'chevron';
      chevron.textContent = '▾';

      const addHeaderBtn = document.createElement('button');
      addHeaderBtn.className = 'btn-lib-action add';
      addHeaderBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M5 1V9M1 5H9" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/></svg>';
      addHeaderBtn.title = 'Save group to Karl X Saved Groups';
      addHeaderBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        addHeaderBtn.disabled = true;
        await saveChromeGroupAction(group, tabs);
      });

      header.appendChild(titleDiv);
      header.appendChild(badgeDiv);
      header.appendChild(statusPill);
      header.appendChild(timeDiv);
      header.appendChild(addHeaderBtn);
      header.appendChild(chevron);

      const body = document.createElement('div');
      const actionsRow = document.createElement('div');
      actionsRow.className = 'saved-group-actions';

      const exportBtn = document.createElement('button');
      exportBtn.className = 'btn-saved-action';
      exportBtn.innerHTML = '<span>⇩ HTML</span>';
      exportBtn.title = 'Export this group to HTML';
      exportBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const tabsPayload = tabs.map(t => ({
          url_original: t.url || '',
          title: t.title || t.url || 'Untitled',
          favicon_url: t.favIconUrl || '',
          domain: t.url ? new URL(t.url).hostname : ''
        }));
        try {
          const res = await apiClient.post<{ html_content: string }>('/api/export', {
            title: group.title || 'Chrome Group',
            tabs: tabsPayload
          });
          const blob = new Blob([res.html_content], { type: 'text/html;charset=utf-8' });
          const blobUrl = URL.createObjectURL(blob);
          const filename = `${(group.title || 'group').toLowerCase().replace(/[^a-z0-9]/g, '_')}.html`;
          if (chrome.downloads) {
            await chrome.downloads.download({ url: blobUrl, filename, saveAs: true });
          }
          showToast(`✓ Exported group`, 'success');
        } catch {
          showToast('Export failed', 'error');
        }
      });

      const closeGroupBtn = document.createElement('button');
      closeGroupBtn.className = 'btn-saved-action delete';
      closeGroupBtn.innerHTML = '<span>🗑</span>';
      closeGroupBtn.title = 'Close this group in browser (will disappear)';
      closeGroupBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeGroupBtn.disabled = true;
        try {
          const tabIds = tabs.map(t => t.id).filter((id): id is number => typeof id === 'number');
          if (tabIds.length > 0) {
            if (allOpenTabs.length <= tabIds.length) {
              await chrome.tabs.create({});
            }
            await chrome.tabs.remove(tabIds);
          }
          await refreshTabsFromChrome();
          renderTabs();
          showToast(`✓ Closed "${group.title || 'group'}" in browser`, 'info');
        } catch (err: any) {
          console.error('Failed to close group in Chrome:', err);
          showToast('Failed to close group', 'error');
        }
      });

      const groupKey = `chrome-${group.id}`;
      if (selectedGroupKeys.has(groupKey)) {
        card.classList.add('group-selected');
        header.classList.add('selected');
      }

      actionsRow.appendChild(exportBtn);
      actionsRow.appendChild(closeGroupBtn);

      const tabsList = document.createElement('div');
      tabsList.className = 'saved-tabs-list';
      tabs.forEach(tab => {
        const isChecked = tab.id !== undefined && selectedTabIds.has(tab.id);
        const tabEl = document.createElement('div');
        tabEl.className = `tab-item ${isChecked ? 'checked' : ''}`;
        tabEl.style.paddingLeft = '14px';

        const fav = document.createElement('img');
        fav.className = 'tab-favicon';
        fav.src = tab.favIconUrl || 'public/icons/icon16.png';
        fav.onerror = () => { fav.src = 'public/icons/icon16.png'; };

        const tit = document.createElement('div');
        tit.className = 'tab-title';
        tit.textContent = tab.title || tab.url || 'Untitled';
        tit.title = tab.url || '';

        tabEl.appendChild(fav);
        tabEl.appendChild(tit);

        // Circular +/- button for tab library status
        const libBtn = createTabLibraryActionButton(tab.url, tab.title, tab.favIconUrl);
        tabEl.appendChild(libBtn);

        // Single-click toggles selection of this tab
        tabEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (tab.id === undefined) return;
          const nowChecked = !tabEl.classList.contains('checked');
          tabEl.classList.toggle('checked', nowChecked);
          if (nowChecked) {
            selectedTabIds.add(tab.id);
          } else {
            selectedTabIds.delete(tab.id);
            selectedGroupKeys.delete(groupKey);
            card.classList.remove('group-selected');
            header.classList.remove('selected');
          }
          updateSelectionUI();
        });

        // Double-click switches directly to tab in Chrome
        tabEl.addEventListener('dblclick', async (e) => {
          e.stopPropagation();
          if (tab.id !== undefined) {
            try {
              await chrome.tabs.update(tab.id, { active: true });
              if (tab.windowId !== undefined) {
                await chrome.windows.update(tab.windowId, { focused: true });
              }
              window.close();
            } catch {}
          }
        });

        tabsList.appendChild(tabEl);
      });

      body.appendChild(actionsRow);
      body.appendChild(tabsList);

      let collapsed = false;
      header.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('.chevron')) {
          collapsed = !collapsed;
          body.style.display = collapsed ? 'none' : '';
          chevron.classList.toggle('collapsed', collapsed);
          return;
        }
        if (target.closest('.btn-lib-action') || target.closest('.btn-saved-action')) {
          return;
        }

        // Clicking group header toggles selection of whole group!
        const nowSelected = !selectedGroupKeys.has(groupKey);
        if (nowSelected) {
          selectedGroupKeys.add(groupKey);
          card.classList.add('group-selected');
          header.classList.add('selected');
          tabs.forEach(t => {
            if (t.id !== undefined) selectedTabIds.add(t.id);
          });
          tabsList.querySelectorAll('.tab-item').forEach(el => el.classList.add('checked'));
        } else {
          selectedGroupKeys.delete(groupKey);
          card.classList.remove('group-selected');
          header.classList.remove('selected');
          tabs.forEach(t => {
            if (t.id !== undefined) selectedTabIds.delete(t.id);
          });
          tabsList.querySelectorAll('.tab-item').forEach(el => el.classList.remove('checked'));
        }
        updateSelectionUI();
      });

      card.appendChild(header);
      card.appendChild(body);
      fragment.appendChild(card);
    }



    // Ungrouped tabs card if any
    if (ungroupedTabs.length > 0) {
      const card = document.createElement('div');
      card.className = 'saved-group-card is-unsaved';
      card.style.borderLeftColor = '#64748b';
      card.style.background = 'linear-gradient(90deg, rgba(100, 116, 139, 0.12) 0%, var(--surface) 45%)';

      const header = document.createElement('div');
      header.className = 'saved-group-header';

      const titleDiv = document.createElement('div');
      titleDiv.className = 'saved-group-title';
      titleDiv.textContent = 'Ungrouped Open Tabs';
      titleDiv.style.color = '#cbd5e1';

      const badgeDiv = document.createElement('div');
      badgeDiv.className = 'saved-group-badge';
      badgeDiv.textContent = `(${ungroupedTabs.length})`;

      const statusPill = document.createElement('span');
      statusPill.className = 'group-status-pill unsaved';
      statusPill.textContent = 'Unsaved';

      const chevron = document.createElement('div');
      chevron.className = 'chevron';
      chevron.textContent = '▾';

      header.appendChild(titleDiv);
      header.appendChild(badgeDiv);
      header.appendChild(statusPill);
      header.appendChild(chevron);

      const body = document.createElement('div');
      const actionsRow = document.createElement('div');
      actionsRow.className = 'saved-group-actions';

      const groupBtn = document.createElement('button');
      groupBtn.className = 'btn-saved-action save';
      groupBtn.innerHTML = '<span>🗂 Create Group in Chrome</span>';
      groupBtn.title = 'Create a tab group in Chrome from these open tabs';
      groupBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const tabIds = ungroupedTabs.map(t => t.id).filter((id): id is number => id !== undefined);
        await openGroupModal('group', tabIds, 'New Group');
      });

      actionsRow.appendChild(groupBtn);

      const tabsList = document.createElement('div');
      tabsList.className = 'saved-tabs-list';
      ungroupedTabs.forEach(tab => {
        const isChecked = tab.id !== undefined && selectedTabIds.has(tab.id);
        const tabEl = document.createElement('div');
        tabEl.className = `tab-item ${isChecked ? 'checked' : ''}`;
        tabEl.style.paddingLeft = '14px';

        const fav = document.createElement('img');
        fav.className = 'tab-favicon';
        fav.src = tab.favIconUrl || 'public/icons/icon16.png';
        fav.onerror = () => { fav.src = 'public/icons/icon16.png'; };

        const tit = document.createElement('div');
        tit.className = 'tab-title';
        tit.textContent = tab.title || tab.url || 'Untitled';

        tabEl.appendChild(fav);
        tabEl.appendChild(tit);

        const libBtn = createTabLibraryActionButton(tab.url, tab.title, tab.favIconUrl);
        tabEl.appendChild(libBtn);

        // Single-click toggles selection of ungrouped tab
        tabEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (tab.id === undefined) return;
          const nowChecked = !tabEl.classList.contains('checked');
          tabEl.classList.toggle('checked', nowChecked);
          if (nowChecked) selectedTabIds.add(tab.id);
          else selectedTabIds.delete(tab.id);
          updateSelectionUI();
        });

        // Double-click switches directly to tab in Chrome
        tabEl.addEventListener('dblclick', async (e) => {
          e.stopPropagation();
          if (tab.id !== undefined) {
            try {
              await chrome.tabs.update(tab.id, { active: true });
              if (tab.windowId !== undefined) {
                await chrome.windows.update(tab.windowId, { focused: true });
              }
              window.close();
            } catch {}
          }
        });

        tabsList.appendChild(tabEl);
      });

      body.appendChild(actionsRow);
      body.appendChild(tabsList);

      let collapsed = true;
      body.style.display = 'none';
      chevron.classList.add('collapsed');

      header.addEventListener('click', () => {
        collapsed = !collapsed;
        body.style.display = collapsed ? 'none' : '';
        chevron.classList.toggle('collapsed', collapsed);
      });

      card.appendChild(header);
      card.appendChild(body);
      fragment.appendChild(card);
    }

    container.replaceChildren(fragment);
  }

  function hexToRgba(hex: string, alpha: number): string {
    const clean = hex.replace('#', '');
    const bigint = parseInt(clean, 16);
    const r = (bigint >> 16) & 255, g = (bigint >> 8) & 255, b = bigint & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function getChromeColor(colorName: string): string {
    return getChromeColorHex(colorName);
  }

  function renderTabs() {
    if (currentMode === 'group') {
      updateGroupBadges();
      if (currentGroupSubtab === 'saved') {
        renderSavedGroups();
      } else {
        renderUnsavedGroups();
      }
      return;
    }

    // Library Mode: 2 boxes — 'Not Saved' and 'Saved'
    const fragment = document.createDocumentFragment();
    const unsavedTabs = allOpenTabs.filter(t => !t.isSavedInLibrary && !t.isNewTab);
    const savedTabs = allOpenTabs.filter(t => t.isSavedInLibrary);

    fragment.appendChild(createGroupCard({
      name: 'Not Saved', color: '#f97316', tabs: unsavedTabs,
      libraryMode: { isSavedGroup: false, emptyText: 'All open tabs are saved in library! ✨' }
    }));
    fragment.appendChild(createGroupCard({
      name: 'Saved', color: '#10b981', tabs: savedTabs,
      libraryMode: { isSavedGroup: true, emptyText: 'No open tabs saved in library yet.' }
    }));

    container.replaceChildren(fragment);

    // Auto-scroll active tab into view if needed
    setTimeout(() => {
      const activeEl = container.querySelector('.tab-item.active-tab');
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }, 60);
  }

  interface GroupCardOptions {
    name: string;
    color: string;
    rawColorName?: string;
    tabs: ExtendedTab[];
    /** When set, renders library-style action buttons instead of tag badges */
    libraryMode?: { isSavedGroup: boolean; emptyText: string };
    /** Render tabs with a flat style (no indent) */
    flat?: boolean;
  }

  function createGroupCard(opts: GroupCardOptions): HTMLElement {
    const { name, color, rawColorName, tabs, libraryMode, flat } = opts;

    const card = document.createElement('div');
    card.className = 'group-card';
    card.style.borderLeftColor = color;
    card.style.background = `linear-gradient(90deg, ${hexToRgba(color, 0.10)}, var(--surface) 45%)`;

    const header = document.createElement('div');
    header.className = 'group-header';
    if (libraryMode) header.style.paddingLeft = '14px';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'group-name';
    titleDiv.textContent = name;
    titleDiv.style.color = color;

    const countDiv = document.createElement('div');
    countDiv.className = 'group-count';
    countDiv.textContent = `(${tabs.length})`;

    header.appendChild(titleDiv);
    header.appendChild(countDiv);

    if (!libraryMode && name !== 'Ungrouped') {
      const headerActions = document.createElement('div');
      headerActions.className = 'group-header-actions';
      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn-group-header-action';
      saveBtn.innerHTML = '💾 Save';
      saveBtn.title = 'Save this group as an isolated Saved Group (not in library)';
      saveBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const validIds = tabs.map(t => t.id!).filter(Boolean);
        await openGroupModal('save', validIds, name, rawColorName || 'blue');
      });
      headerActions.appendChild(saveBtn);
      header.appendChild(headerActions);
    }

    const chevron = document.createElement('div');
    chevron.className = 'chevron';
    chevron.textContent = '▾';
    header.appendChild(chevron);

    const body = document.createElement('div');
    if (tabs.length === 0) {
      const emptyNotice = document.createElement('div');
      emptyNotice.style.padding = libraryMode ? '10px 14px' : '8px 12px 8px 14px';
      emptyNotice.style.fontSize = libraryMode ? '12px' : '11.5px';
      emptyNotice.style.color = 'var(--text-tertiary)';
      emptyNotice.textContent = libraryMode?.emptyText ?? 'No tabs in this section.';
      body.appendChild(emptyNotice);
    } else {
      tabs.forEach(tab => {
        body.appendChild(
          libraryMode
            ? createLibraryTabItem(tab, libraryMode.isSavedGroup)
            : createTabItem(tab, flat)
        );
      });
    }

    let collapsed = false;
    header.addEventListener('click', () => {
      collapsed = !collapsed;
      body.style.display = collapsed ? 'none' : '';
      chevron.classList.toggle('collapsed', collapsed);
    });

    card.appendChild(header);
    card.appendChild(body);
    return card;
  }

  function createPokeballIndicator(tab: ExtendedTab): HTMLElement {
    const el = document.createElement('div');
    el.className = 'tab-pokeball-indicator';
    el.title = 'Currently open tab (Active)';
    el.innerHTML = `
      <svg class="pokeball-svg" viewBox="0 0 24 24" width="16" height="16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M 2 12 A 10 10 0 0 1 22 12 Z" fill="#EE1515"/>
        <path d="M 2 12 A 10 10 0 0 0 22 12 Z" fill="#FFFFFF"/>
        <path d="M 3.8 14.5 A 10 10 0 0 0 20.2 14.5 A 9 6.5 0 0 1 3.8 14.5 Z" fill="#CBD5E1" opacity="0.6"/>
        <line x1="2" y1="12" x2="22" y2="12" stroke="#18181B" stroke-width="2.2"/>
        <circle cx="12" cy="12" r="10" stroke="#18181B" stroke-width="2.2" fill="none"/>
        <circle cx="12" cy="12" r="3.4" fill="#FFFFFF" stroke="#18181B" stroke-width="2.2"/>
        <circle cx="12" cy="12" r="1.4" fill="#FFFFFF" stroke="#71717A" stroke-width="0.75"/>
      </svg>
    `;

    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (tab.id !== undefined) {
        try {
          await chrome.tabs.update(tab.id, { active: true });
          if (tab.windowId !== undefined) {
            await chrome.windows.update(tab.windowId, { focused: true });
          }
        } catch (err) {
          console.error('Failed to focus tab:', err);
        }
      }
    });

    return el;
  }

  function createLibraryTabItem(tab: ExtendedTab, isSavedGroup: boolean): HTMLElement {
    const isChecked = tab.id ? selectedTabIds.has(tab.id) : false;
    const item = document.createElement('div');
    item.className = `tab-item library-item ${isChecked ? 'checked' : ''} ${tab.active ? 'active-tab' : ''}`;
    item.style.paddingLeft = '14px';

    const favicon = document.createElement('img');
    favicon.className = 'tab-favicon';
    favicon.src = tab.favIconUrl || 'public/icons/icon16.png';
    favicon.onerror = () => { favicon.src = 'public/icons/icon16.png'; };

    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = tab.title || tab.url || 'Untitled';
    title.title = tab.url || '';

    const actionBtn = document.createElement('button');
    actionBtn.className = `btn-lib-action ${isSavedGroup ? 'remove' : 'add'}`;
    actionBtn.innerHTML = isSavedGroup
      ? '<svg width="10" height="2" viewBox="0 0 10 2" fill="none"><rect width="10" height="2" rx="1" fill="#FFFFFF"/></svg>'
      : '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M5 1V9M1 5H9" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/></svg>';
    actionBtn.title = isSavedGroup ? 'Remove from Karl X Library' : 'Save to Karl X Library';

    actionBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      actionBtn.disabled = true;
      actionBtn.style.opacity = '0.5';

      if (isSavedGroup) {
        // Remove from library
        try {
          await apiClient.delete(`/api/pages/by-url?url=${encodeURIComponent(tab.url || '')}`);
          tab.isSavedInLibrary = false;
          if (tab.url) savedLibraryUrlSet.delete(normalizeUrl(tab.url));
          renderTabs();
        } catch (err) {
          console.error('Failed to remove page from library', err);
        }
      } else {
        // Add to library
        try {
          let dom = '';
          try {
            if (tab.url) dom = new URL(tab.url).hostname.replace(/^www\./, '');
          } catch {}

          const norm = tab.normalizedUrl || normalizeUrl(tab.url || '');
          await apiClient.post('/api/pages/save-bulk', {
            tabs: [{
              url_original: tab.url || '',
              url_normalized: norm,
              title: tab.title || dom || 'Untitled',
              favicon_url: tab.favIconUrl || '',
              domain: dom
            }]
          });
          tab.isSavedInLibrary = true;
          savedLibraryUrlSet.add(norm);
          renderTabs();
        } catch (err) {
          console.error('Failed to save page to library', err);
        }
      }
    });

    // Clicking row toggles tab selection for delete/export
    item.addEventListener('click', () => {
      if (!tab.id) return;
      const nowChecked = !selectedTabIds.has(tab.id);
      if (nowChecked) selectedTabIds.add(tab.id);
      else selectedTabIds.delete(tab.id);
      item.classList.toggle('checked', nowChecked);
      updateSelectionUI();
    });

    // Double-clicking row switches directly to tab
    item.addEventListener('dblclick', async (e) => {
      e.stopPropagation();
      if (tab.id !== undefined) {
        try {
          await chrome.tabs.update(tab.id, { active: true });
          if (tab.windowId !== undefined) {
            await chrome.windows.update(tab.windowId, { focused: true });
          }
          window.close();
        } catch (err) {
          console.error('Failed to switch tab on dblclick:', err);
        }
      }
    });

    item.appendChild(favicon);
    item.appendChild(title);
    if (tab.active) {
      item.appendChild(createPokeballIndicator(tab));
    }
    item.appendChild(actionBtn);

    return item;
  }

  function createTabItem(tab: ExtendedTab, isFlat = false): HTMLElement {
    const isChecked = tab.id ? selectedTabIds.has(tab.id) : false;
    const item = document.createElement('div');
    item.className = `tab-item ${isFlat ? 'flat' : ''} ${isChecked ? 'checked' : ''} ${tab.active ? 'active-tab' : ''}`;

    const favicon = document.createElement('img');
    favicon.className = 'tab-favicon';
    favicon.src = tab.favIconUrl || 'public/icons/icon16.png';
    favicon.onerror = () => { favicon.src = 'public/icons/icon16.png'; };

    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = tab.title || tab.url || 'Untitled';
    title.title = tab.url || '';

    item.appendChild(favicon);
    item.appendChild(title);

    if (tab.active) {
      item.appendChild(createPokeballIndicator(tab));
    }

    if (tab.isDuplicate) {
      const dupTag = document.createElement('span');
      dupTag.className = 'tab-dup-tag';
      dupTag.textContent = 'DUP';
      dupTag.title = 'Duplicate copy (1 copy kept, extras removed)';
      item.appendChild(dupTag);
    }

    if (tab.isTarget || tab.isNewTab) {
      const nopeTag = document.createElement('span');
      nopeTag.className = 'tab-nope-tag';
      nopeTag.textContent = 'NOPE';
      nopeTag.title = tab.isNewTab ? 'Empty / New Tab (will be terminated)' : 'Terminator target match (will be terminated)';
      item.appendChild(nopeTag);
    }

    // Clicking row toggles tab selection
    item.addEventListener('click', () => {
      if (!tab.id) return;
      const nowChecked = !selectedTabIds.has(tab.id);
      if (nowChecked) selectedTabIds.add(tab.id);
      else selectedTabIds.delete(tab.id);
      item.classList.toggle('checked', nowChecked);
      updateSelectionUI();
    });

    // Double-clicking row switches directly to tab
    item.addEventListener('dblclick', async (e) => {
      e.stopPropagation();
      if (tab.id !== undefined) {
        try {
          await chrome.tabs.update(tab.id, { active: true });
          if (tab.windowId !== undefined) {
            await chrome.windows.update(tab.windowId, { focused: true });
          }
          window.close();
        } catch (err) {
          console.error('Failed to switch tab on dblclick:', err);
        }
      }
    });

    return item;
  }

  // createGroupCard (old duplicate) — now handled by unified createGroupCard(opts) above.

  // 4. Selection Button Handlers
  btnSelectAll.addEventListener('click', () => {
    if (currentMode === 'group') {
      if (currentGroupSubtab === 'saved') {
        const openSaved = getOpenSavedGroups();
        openSaved.forEach(g => {
          selectedGroupKeys.add(`saved-${g.id}`);
          const live = findOpenChromeGroupForSavedGroup(g);
          const tabsToSelect = live ? live.tabs : (g.tabs || []);
          tabsToSelect.forEach((t: any, idx: number) => {
            selectedSavedTabKeys.add(`${g.id}:::${idx}:::${t.url || ''}`);
            const liveTab = allOpenTabs.find(ot => ot.url === t.url || ot.url_normalized === t.url || ot.id === t.id);
            if (liveTab?.id !== undefined) selectedTabIds.add(liveTab.id);
          });
        });
      } else {
        const unsaved = getUnsavedChromeGroups();
        unsaved.forEach(u => {
          selectedGroupKeys.add(`chrome-${u.group.id}`);
          u.tabs.forEach(t => { if (t.id !== undefined) selectedTabIds.add(t.id); });
        });

        const ungroupedTabs = allOpenTabs.filter(t => t.groupId === undefined || t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE);
        ungroupedTabs.forEach(t => { if (t.id !== undefined) selectedTabIds.add(t.id); });
      }
      document.querySelectorAll('.tab-item').forEach(item => item.classList.add('checked'));
      document.querySelectorAll('.saved-group-card').forEach(c => c.classList.add('group-selected'));
      document.querySelectorAll('.saved-group-header').forEach(h => h.classList.add('selected'));
    } else {
      allOpenTabs.forEach(t => t.id && selectedTabIds.add(t.id));
      document.querySelectorAll('.tab-item').forEach(item => item.classList.add('checked'));
    }
    updateSelectionUI();
  });

  btnDeselectAll.addEventListener('click', () => {
    selectedTabIds.clear();
    selectedSavedTabKeys.clear();
    selectedGroupKeys.clear();
    document.querySelectorAll('.tab-item').forEach(item => item.classList.remove('checked'));
    document.querySelectorAll('.saved-group-card').forEach(c => c.classList.remove('group-selected'));
    document.querySelectorAll('.saved-group-header').forEach(h => h.classList.remove('selected'));
    updateSelectionUI();
  });

  function updateSelectionUI() {
    const totalSelected = selectedTabIds.size + selectedSavedTabKeys.size;
    selectedCountSpan.textContent = String(totalSelected);

    if (currentMode === 'group') {
      if (selectRow) selectRow.style.display = 'flex';

      // Count total tabs in current group view
      let totalGroupTabs = 0;
      if (currentGroupSubtab === 'saved') {
        const openSaved = getOpenSavedGroups();
        totalGroupTabs = openSaved.reduce((acc, g) => {
          const live = findOpenChromeGroupForSavedGroup(g);
          const count = live ? live.tabs.length : (Array.isArray(g.tabs) ? g.tabs.length : (g.tab_count || 0));
          return acc + count;
        }, 0);
      } else {
        const unsaved = getUnsavedChromeGroups();
        const unsavedTabsCount = unsaved.reduce((acc, u) => acc + u.tabs.length, 0);
        const ungroupedTabs = allOpenTabs.filter(t => t.groupId === undefined || t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE);
        totalGroupTabs = unsavedTabsCount + ungroupedTabs.length;
      }
      totalCountSpan.textContent = String(totalGroupTabs);

      if (totalSelected > 0 || selectedGroupKeys.size > 0) {
        if (footerControls) footerControls.style.display = 'flex';
        if (groupActionRow) groupActionRow.style.display = 'flex';

        if (totalSelected > 0) {
          if (btnCreateGroup) {
            btnCreateGroup.style.display = 'flex';
            if (createGroupText) {
              createGroupText.textContent = totalSelected === 1 ? 'New Group (1)' : `New Group (${totalSelected})`;
            }
          }
          if (btnDeleteTabs) {
            btnDeleteTabs.style.display = 'flex';
            if (deleteTabsText) {
              deleteTabsText.textContent = totalSelected === 1 ? 'Delete (1)' : `Delete (${totalSelected})`;
            }
          }
        } else {
          if (btnCreateGroup) btnCreateGroup.style.display = 'none';
          if (btnDeleteTabs) btnDeleteTabs.style.display = 'none';
        }

        if (selectedGroupKeys.size > 0) {
          if (btnUngroup) {
            btnUngroup.style.display = 'flex';
            if (ungroupBtnText) {
              ungroupBtnText.textContent = selectedGroupKeys.size === 1 ? 'Ungroup' : `Ungroup (${selectedGroupKeys.size})`;
            }
          }
        } else {
          if (btnUngroup) btnUngroup.style.display = 'none';
        }
      } else {
        if (footerControls) footerControls.style.display = 'none';
        if (groupActionRow) groupActionRow.style.display = 'none';
        if (btnCreateGroup) btnCreateGroup.style.display = 'none';
        if (btnUngroup) btnUngroup.style.display = 'none';
        if (btnDeleteTabs) btnDeleteTabs.style.display = 'none';
      }
      return;
    }

    // Library mode
    if (selectRow) selectRow.style.display = 'flex';
    totalCountSpan.textContent = String(allOpenTabs.length);

    if (selectedTabIds.size > 0) {
      if (footerControls) footerControls.style.display = 'flex';
      if (groupActionRow) groupActionRow.style.display = 'flex';
      if (btnCreateGroup) {
        btnCreateGroup.style.display = 'flex';
        if (createGroupText) {
          createGroupText.textContent = selectedTabIds.size === 1 ? 'New Group (1)' : `New Group (${selectedTabIds.size})`;
        }
      }
      if (btnDeleteTabs) {
        btnDeleteTabs.style.display = 'flex';
        if (deleteTabsText) {
          deleteTabsText.textContent = selectedTabIds.size === 1 ? 'Delete (1)' : `Delete (${selectedTabIds.size})`;
        }
      }
    } else {
      if (footerControls) footerControls.style.display = 'none';
      if (groupActionRow) groupActionRow.style.display = 'none';
      if (btnCreateGroup) btnCreateGroup.style.display = 'none';
      if (btnDeleteTabs) btnDeleteTabs.style.display = 'none';
    }
  }

  btnCreateGroup?.addEventListener('click', async () => {
    const tabIds = Array.from(selectedTabIds);
    const savedKeys = Array.from(selectedSavedTabKeys);
    if (tabIds.length === 0 && savedKeys.length === 0) return;
    await openGroupModal('group', tabIds, savedKeys);
  });

  // Ungroup selected group(s)
  btnUngroup?.addEventListener('click', async () => {
    if (selectedGroupKeys.size === 0) return;
    btnUngroup.disabled = true;

    try {
      const keysToUngroup = Array.from(selectedGroupKeys);
      let ungroupedCount = 0;

      for (const key of keysToUngroup) {
        if (key.startsWith('chrome-')) {
          const groupId = parseInt(key.replace('chrome-', ''), 10);
          const tabsInGrp = allOpenTabs.filter(t => t.groupId === groupId && t.id !== undefined);
          const tabIds = tabsInGrp.map(t => t.id as number);
          if (tabIds.length > 0) {
            await chrome.tabs.ungroup(tabIds);
            ungroupedCount++;
          }
        } else if (key.startsWith('saved-')) {
          const groupId = parseInt(key.replace('saved-', ''), 10);
          const savedGrp = allSavedGroups.find(g => g.id === groupId);
          if (savedGrp) {
            const liveInfo = findOpenChromeGroupForSavedGroup(savedGrp);
            if (liveInfo && liveInfo.tabs.length > 0) {
              const tabIds = liveInfo.tabs.map(t => t.id).filter((id): id is number => typeof id === 'number');
              if (tabIds.length > 0) {
                await chrome.tabs.ungroup(tabIds);
              }
            }
            try {
              await apiClient.delete(`/api/groups/${groupId}`);
            } catch {}
            allSavedGroups = allSavedGroups.filter(g => g.id !== groupId);
            await storage.set('saved_tab_groups', allSavedGroups);
            ungroupedCount++;
          }

        }
      }

      selectedGroupKeys.clear();
      selectedTabIds.clear();
      selectedSavedTabKeys.clear();

      await refreshTabsFromChrome();
      renderTabs();
      updateSelectionUI();
      showToast(`✓ Ungrouped ${ungroupedCount === 1 ? 'group' : ungroupedCount + ' groups'}!`, 'success');
    } catch (err: any) {
      console.error('Failed to ungroup:', err);
      showToast('Failed to ungroup', 'error');
    } finally {
      btnUngroup.disabled = false;
    }
  });

  // Delete Selected Tabs from Browser & Saved Groups
  btnDeleteTabs?.addEventListener('click', async () => {
    const tabIdsToDelete = Array.from(selectedTabIds);
    const savedKeysToDelete = Array.from(selectedSavedTabKeys);
    if (tabIdsToDelete.length === 0 && savedKeysToDelete.length === 0) return;

    btnDeleteTabs.disabled = true;
    try {
      // 1. Close tabs open in Chrome
      if (tabIdsToDelete.length > 0) {
        const currentWindowTabs = await chrome.tabs.query(selectedWindowId ? { windowId: selectedWindowId } : { currentWindow: true });
        const willCloseWindow = currentWindowTabs.every(t => t.id !== undefined && tabIdsToDelete.includes(t.id));
        if (willCloseWindow) {
          await chrome.tabs.create(selectedWindowId ? { windowId: selectedWindowId, active: true } : { active: true });
        }
        await chrome.tabs.remove(tabIdsToDelete);
        const deletedSet = new Set(tabIdsToDelete);
        allOpenTabs = allOpenTabs.filter(t => t.id === undefined || !deletedSet.has(t.id));
      }

      // 2. Remove tabs from Saved Groups in Karl X
      if (savedKeysToDelete.length > 0) {
        const byGroup = new Map<number, Set<string>>();

        savedKeysToDelete.forEach(k => {
          const parts = k.split(':::');
          const gId = parseInt(parts[0], 10);
          const url = parts.slice(2).join(':::');
          if (!byGroup.has(gId)) byGroup.set(gId, new Set());
          if (url) byGroup.get(gId)!.add(url);
        });

        for (const [gId, urlsToRemove] of byGroup.entries()) {
          const grp = allSavedGroups.find(g => g.id === gId);
          if (grp && Array.isArray(grp.tabs)) {
            const remainingTabs = grp.tabs.filter((t: any) => !urlsToRemove.has(t.url || ''));
            grp.tabs = remainingTabs;
            grp.tab_count = remainingTabs.length;
            try {
              if (remainingTabs.length > 0) {
                await apiClient.put(`/api/groups/${gId}`, { tabs: remainingTabs });
              } else {
                await apiClient.delete(`/api/groups/${gId}`);
                allSavedGroups = allSavedGroups.filter(g => g.id !== gId);
              }
            } catch {}
          }
        }
        await storage.set('saved_tab_groups', allSavedGroups);
      }

      const totalDeleted = tabIdsToDelete.length + savedKeysToDelete.length;
      selectedTabIds.clear();
      selectedSavedTabKeys.clear();
      selectedGroupKeys.clear();

      await refreshTabsFromChrome();
      renderTabs();
      updateSelectionUI();
      showToast(`✓ Closed/Deleted ${totalDeleted} selected tab(s)`, 'info');
    } catch (err) {
      console.error('Failed to close selected tabs', err);
      showToast('Failed to delete selected tabs', 'error');
    } finally {
      btnDeleteTabs.disabled = false;
    }
  });

  // 5. Export Execution Flow
  if (btnExport) {
    btnExport.addEventListener('click', async () => {
      const tabsToExport = allOpenTabs.filter(t => t.id && selectedTabIds.has(t.id));
      if (tabsToExport.length === 0) return;

      btnExport.disabled = true;
      progressContainer.style.display = 'block';
      progressFill.style.width = '5%';
      progressPercent.textContent = '5%';
      progressStatus.textContent = 'Scraping tab metadata...';

      const processedPages = [];
      const total = tabsToExport.length;

      for (let i = 0; i < total; i++) {
        const tab = tabsToExport[i];
        const percent = Math.round(((i + 1) / total) * 80);
        progressFill.style.width = `${percent}%`;
        progressPercent.textContent = `${percent}%`;
        progressStatus.textContent = `Scraping (${i + 1}/${total}): ${(tab.title || tab.url || '').slice(0, 24)}...`;

        let scraped: Partial<ScrapedPageMetadata> = {};

        if (tab.id && tab.url && tab.url.startsWith('http')) {
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: extractPageMetadata,
            });
            if (results && results[0]?.result) {
              scraped = results[0].result as ScrapedPageMetadata;
            }
          } catch {
            // Tab may not allow scripting
          }
        }

        let groupName: string | undefined;
        let groupColor: string | undefined;
        if (tab.groupId !== undefined && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
          const grp = allGroups.find(g => g.id === tab.groupId);
          if (grp) {
            groupName = grp.title || undefined;
            groupColor = grp.color;
          }
        }

        processedPages.push({
          url_original: tab.url || '',
          url_normalized: tab.normalizedUrl,
          title: scraped.title || tab.title || tab.url || 'Untitled',
          description: scraped.description || '',
          favicon_url: scraped.favicon_url || tab.favIconUrl || '',
          og_image_url: scraped.og_image_url || '',
          og_image_data: scraped.og_image_data || '',
          domain: scraped.domain || (tab.url ? new URL(tab.url).hostname : ''),
          group_name: groupName,
          group_color: groupColor,
        });
      }

      progressFill.style.width = '85%';
      progressPercent.textContent = '85%';
      progressStatus.textContent = 'Generating Karl X export...';

      const customTitle = exportTitleInput?.value.trim() || 'Karl X — Saved Tabs';

      try {
        const response = await apiClient.post<{ html_content: string; item_count: number; title: string }>('/api/export', {
          title: customTitle,
          tabs: processedPages,
        });

        progressFill.style.width = '100%';
        progressPercent.textContent = '100%';
        progressStatus.textContent = 'Downloading export...';

        const blob = new Blob([response.html_content], { type: 'text/html;charset=utf-8' });
        const blobUrl = URL.createObjectURL(blob);
        const filename = `${customTitle.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${new Date().toISOString().slice(0, 10)}.html`;

        if (chrome.downloads) {
          await chrome.downloads.download({
            url: blobUrl,
            filename: filename,
            saveAs: true,
          });
        } else {
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = filename;
          a.click();
        }

        setTimeout(() => {
          progressContainer.style.display = 'none';
          if (btnExport) btnExport.disabled = false;
        }, 600);

      } catch (err) {
        console.error('Export failed:', err);
        progressStatus.textContent = 'Export error!';
        alert('Failed to export tabs. Ensure local backend is running at http://127.0.0.1:8742.');
        progressContainer.style.display = 'none';
        if (btnExport) btnExport.disabled = false;
      }
    });
  }

  // Keep popup/sidepanel UI in sync if tabs or groups change in the browser
  let refreshDebounceTimer: any = null;
  const debouncedChromeRefresh = () => {
    clearTimeout(refreshDebounceTimer);
    refreshDebounceTimer = setTimeout(async () => {
      try {
        await refreshTabsFromChrome();
        updateGroupBadges();
        renderTabs();
        updateSelectionUI();
      } catch (err) {
        console.debug('Debounced Chrome refresh error:', err);
      }
    }, 200);
  };

  if (typeof chrome !== 'undefined') {
    chrome.tabs?.onCreated?.addListener(debouncedChromeRefresh);
    chrome.tabs?.onRemoved?.addListener(debouncedChromeRefresh);
    chrome.tabs?.onUpdated?.addListener(debouncedChromeRefresh);
    chrome.tabGroups?.onCreated?.addListener(debouncedChromeRefresh);
    chrome.tabGroups?.onRemoved?.addListener(debouncedChromeRefresh);
    chrome.tabGroups?.onUpdated?.addListener(debouncedChromeRefresh);
    chrome.windows?.onCreated?.addListener(debouncedChromeRefresh);
    chrome.windows?.onRemoved?.addListener(debouncedChromeRefresh);
    chrome.windows?.onFocusChanged?.addListener((winId) => {
      if (winId !== chrome.windows.WINDOW_ID_NONE && winId !== selectedWindowId) {
        selectedWindowId = winId;
        debouncedChromeRefresh();
      }
    });
  }
});

