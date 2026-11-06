import React, { useEffect, useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { storage } from '../../lib/storage';

interface RuleItem {
  name: string;
  slug?: string;
  keywords: string[];
  description?: string;
}

interface TerminatorTarget {
  pattern: string;
  description?: string;
  enabled: boolean;
}

interface TerminatorConfig {
  terminate_new_tabs: boolean;
  deduplicate_tabs: boolean;
  custom_targets: TerminatorTarget[];
}

interface SettingsProps {
  onReclassified?: () => void;
}

export const Settings: React.FC<SettingsProps> = ({ onReclassified }) => {
  const [rules, setRules] = useState<RuleItem[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [nameInput, setNameInput] = useState<string>('');
  const [keywordsInput, setKeywordsInput] = useState<string>('');
  const [descInput, setDescInput] = useState<string>('');
  const [classifyStatus, setClassifyStatus] = useState<any>(null);
  const [healthStatus, setHealthStatus] = useState<any>(null);
  const [statusMsg, setStatusMsg] = useState<{ text: string; type: 'info' | 'success' | 'error' } | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [closedWindows, setClosedWindows] = useState<any[]>([]);
  const [browserSessions, setBrowserSessions] = useState<any[]>([]);

  // Terminator Config State
  const [termConfig, setTermConfig] = useState<TerminatorConfig>({
    terminate_new_tabs: true,
    deduplicate_tabs: true,
    custom_targets: []
  });
  const [newTargetPattern, setNewTargetPattern] = useState<string>('');
  const [newTargetDesc, setNewTargetDesc] = useState<string>('');

  useEffect(() => {
    loadSettingsData();
  }, []);

  async function loadSettingsData() {
    try {
      const health = await apiClient.healthCheck();
      setHealthStatus(health);

      // 1. Load taxonomy rules from local storage first, then sync with backend
      try {
        const localRules = await storage.get<RuleItem[]>('custom_taxonomy_rules');
        if (localRules && Array.isArray(localRules) && localRules.length > 0) {
          setRules(localRules);
        }
        const rulesRes = await apiClient.get<{ rules: RuleItem[] }>('/api/classify/rules');
        if (rulesRes && Array.isArray(rulesRes.rules)) {
          setRules(rulesRes.rules);
          await storage.set('custom_taxonomy_rules', rulesRes.rules);
        }
      } catch {
        // use local rules
      }

      const statusRes = await apiClient.get<any>('/api/classify/status');
      setClassifyStatus(statusRes);

      try {
        const winRes = await apiClient.get<{ sessions: any[] }>('/api/windows/closed');
        if (winRes && Array.isArray(winRes.sessions)) {
          setClosedWindows(winRes.sessions);
        }
      } catch {
        // ignore if offline
      }

      try {
        const bsRes = await apiClient.get<{ sessions: any[] }>('/api/windows/browser-sessions');
        if (bsRes && Array.isArray(bsRes.sessions)) {
          setBrowserSessions(bsRes.sessions);
        }
      } catch {
        const localBs = await storage.get<any[]>('browser_sessions_cache');
        if (localBs) setBrowserSessions(localBs);
      }

      // Load Terminator config
      try {
        const localTerm = await storage.get<TerminatorConfig>('terminator_config');
        if (localTerm) {
          setTermConfig(localTerm);
        } else {
          const apiTerm = await apiClient.get<TerminatorConfig>('/api/terminator/rules');
          if (apiTerm && typeof apiTerm.terminate_new_tabs === 'boolean') {
            setTermConfig(apiTerm);
            await storage.set('terminator_config', apiTerm);
          }
        }
      } catch {
        // fallback
      }
    } catch (e) {
      console.error('Error loading settings data', e);
    }
  }

  async function saveTerminatorConfig(updated: TerminatorConfig) {
    setTermConfig(updated);
    try {
      await storage.set('terminator_config', updated);
      await apiClient.put('/api/terminator/rules', updated);
      showMsg('✓ Terminator settings saved!', 'success');
    } catch {
      showMsg('Saved locally in browser.', 'info');
    }
  }

  function handleAddTarget(e: React.FormEvent) {
    e.preventDefault();
    if (!newTargetPattern.trim()) return;
    const cleanPattern = newTargetPattern.trim().replace(/^https?:\/\//, '');
    const updatedTargets = [
      ...(termConfig.custom_targets || []),
      {
        pattern: cleanPattern,
        description: newTargetDesc.trim() || undefined,
        enabled: true
      }
    ];
    const updated: TerminatorConfig = { ...termConfig, custom_targets: updatedTargets };
    saveTerminatorConfig(updated);
    setNewTargetPattern('');
    setNewTargetDesc('');
  }

  function handleToggleTarget(index: number) {
    const updatedTargets = [...termConfig.custom_targets];
    updatedTargets[index].enabled = !updatedTargets[index].enabled;
    saveTerminatorConfig({ ...termConfig, custom_targets: updatedTargets });
  }

  function handleDeleteTarget(index: number) {
    const updatedTargets = termConfig.custom_targets.filter((_, i) => i !== index);
    saveTerminatorConfig({ ...termConfig, custom_targets: updatedTargets });
  }

  function showMsg(text: string, type: 'info' | 'success' | 'error' = 'info') {
    setStatusMsg({ text, type });
    setTimeout(() => setStatusMsg(null), 5000);
  }

  function handleStartAdd() {
    setEditingIndex(-1); // -1 indicates new rule
    setNameInput('');
    setKeywordsInput('');
    setDescInput('');
  }

  function handleStartEdit(index: number) {
    const rule = rules[index];
    setEditingIndex(index);
    setNameInput(rule.name);
    setKeywordsInput(rule.keywords.join(', '));
    setDescInput(rule.description || '');
  }

  function handleCancelEdit() {
    setEditingIndex(null);
    setNameInput('');
    setKeywordsInput('');
    setDescInput('');
  }

  async function handleSaveRule(e: React.FormEvent) {
    e.preventDefault();
    if (!nameInput.trim()) {
      showMsg('Please provide a Tag / Topic Name', 'error');
      return;
    }

    const parsedKeywords = keywordsInput
      .split(/[,;\n]+/)
      .map(k => k.trim())
      .filter(k => k.length > 0);

    const newRule: RuleItem = {
      name: nameInput.trim(),
      slug: nameInput.trim().toLowerCase().replace(/[^a-z0-9]/g, '_'),
      keywords: parsedKeywords,
      description: descInput.trim()
    };

    let updatedRules: RuleItem[];
    if (editingIndex === -1) {
      // Add new
      updatedRules = [...rules, newRule];
    } else if (editingIndex !== null && editingIndex >= 0) {
      // Edit existing
      updatedRules = rules.map((r, i) => i === editingIndex ? newRule : r);
    } else {
      return;
    }

    setRules(updatedRules);
    handleCancelEdit();
    await storage.set('custom_taxonomy_rules', updatedRules);

    try {
      await apiClient.put('/api/classify/rules', { rules: updatedRules });
      showMsg(`Saved tag rule "${newRule.name}" successfully!`, 'success');
      loadSettingsData();
    } catch {
      showMsg('Saved locally in browser (Backend offline).', 'info');
    }
  }

  async function handleDeleteRule(index: number) {
    const ruleToDelete = rules[index];
    if (!confirm(`Are you sure you want to delete the tag rule "${ruleToDelete.name}"?`)) return;

    const updatedRules = rules.filter((_, i) => i !== index);
    setRules(updatedRules);
    if (editingIndex === index) handleCancelEdit();
    await storage.set('custom_taxonomy_rules', updatedRules);

    try {
      await apiClient.put('/api/classify/rules', { rules: updatedRules });
      showMsg(`Deleted tag rule "${ruleToDelete.name}"`, 'success');
      loadSettingsData();
    } catch {
      showMsg('Removed locally in browser.', 'info');
    }
  }

  async function handleResetDefaultRules() {
    if (!confirm('Are you sure you want to reset all tag classification rules to the default rich taxonomy?')) return;
    try {
      const res = await apiClient.post<{ rules: RuleItem[]; message: string }>('/api/classify/rules/reset');
      if (res?.rules) {
        setRules(res.rules);
        await storage.set('custom_taxonomy_rules', res.rules);
        showMsg(`✓ ${res.message || 'Taxonomy rules restored to defaults!'}`, 'success');
        loadSettingsData();
      }
    } catch {
      showMsg('Failed to reset rules to defaults.', 'error');
    }
  }

  async function triggerReclassifyAll() {
    setIsProcessing(true);
    showMsg('Classifying all saved tabs using rules & Gemini AI...', 'info');
    try {
      const res = await apiClient.post<any>('/api/classify/reclassify-all', { limit: 500 });
      showMsg(`✓ Reclassification complete! Processed ${res.classified_count} tabs.`, 'success');
      await loadSettingsData();
      onReclassified?.();
    } catch {
      showMsg('Reclassification failed. Check backend connection.', 'error');
    } finally {
      setIsProcessing(false);
    }
  }

  async function triggerIndexEmbeddings() {
    setIsProcessing(true);
    showMsg('Generating vector embeddings for AI semantic search...', 'info');
    try {
      const res = await apiClient.post<any>('/api/brain/embed-all', {});
      showMsg(`✓ Embeddings updated for ${res.embedded_count} tabs!`, 'success');
    } catch {
      showMsg('Embedding generation failed.', 'error');
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleRestoreWindow(session: any) {
    try {
      chrome.runtime.sendMessage({
        type: 'RESTORE_CLOSED_WINDOW',
        session
      }, (res) => {
        if (res?.success) {
          showMsg(`✓ Restored window with ${session.tab_count} tabs!`, 'success');
          loadSettingsData();
        } else {
          showMsg('Failed to restore window.', 'error');
        }
      });
    } catch {
      showMsg('Failed to send restore request to extension.', 'error');
    }
  }

  async function handleReincarnateBrowserSession(session: any) {
    try {
      chrome.runtime.sendMessage({
        type: 'REINCARNATE_BROWSER_SESSION',
        session
      }, (res) => {
        if (res?.success) {
          showMsg(`✦ Restored full session (${res.restored_windows || session.window_count || 1} windows)!`, 'success');
          setBrowserSessions(prev => prev.filter(s => s.session_id !== session.session_id));
        } else {
          showMsg('Failed to reincarnate session.', 'error');
        }
      });
    } catch {
      showMsg('Failed to communicate with extension background.', 'error');
    }
  }

  async function handleDeleteBrowserSession(sessionId: string) {
    setBrowserSessions(prev => prev.filter(s => s.session_id !== sessionId));
    chrome.runtime.sendMessage({ type: 'DELETE_BROWSER_SESSION', sessionId });
    showMsg('Session removed from cache.', 'info');
  }

  async function handleClearAllBrowserSessions() {
    setBrowserSessions([]);
    await storage.set('browser_sessions_cache', []);
    try {
      await apiClient.delete('/api/windows/browser-sessions');
    } catch {}
    showMsg('All browser session history cleared.', 'info');
  }

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', paddingBottom: 60 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: '-0.02em' }}>Settings & Rules</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginTop: 4, marginBottom: 0 }}>
            Configure custom words and descriptions to categorize your tabs into topics automatically
          </p>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            className="btn-primary"
            onClick={triggerReclassifyAll}
            disabled={isProcessing}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <span>⚡</span>
            <span>{isProcessing ? 'Classifying...' : 'Reclassify All Tabs'}</span>
          </button>
        </div>
      </div>

      {statusMsg && (
        <div style={{
          padding: '12px 18px',
          background: statusMsg.type === 'success' ? 'rgba(46, 160, 67, 0.15)' : statusMsg.type === 'error' ? 'rgba(239, 68, 68, 0.15)' : 'var(--accent-soft)',
          border: `1px solid ${statusMsg.type === 'success' ? '#2ea043' : statusMsg.type === 'error' ? '#ef4444' : 'var(--accent)'}`,
          borderRadius: 10,
          color: statusMsg.type === 'success' ? '#3fb950' : statusMsg.type === 'error' ? '#f87171' : 'var(--accent)',
          marginBottom: 24,
          fontSize: 13.5,
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          gap: 8
        }}>
          <span>{statusMsg.type === 'success' ? '✓' : statusMsg.type === 'error' ? '⚠️' : 'ℹ️'}</span>
          <span>{statusMsg.text}</span>
        </div>
      )}

      {/* Backend & AI Status Card */}
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 14,
        padding: '20px 24px',
        marginBottom: 24,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 16
      }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.05em' }}>Backend Status</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4, color: healthStatus?.status === 'ok' ? '#3fb950' : '#ef4444' }}>
            {healthStatus?.status === 'ok' ? '🟢 Online (v' + healthStatus.version + ')' : '🔴 Disconnected'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>Host: 127.0.0.1:8742</div>
        </div>

        <div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.05em' }}>AI Engine</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4, color: 'var(--text-primary)' }}>
            Google Gemini + Rules
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>Multi-key pool configured</div>
        </div>

        <div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.05em' }}>Classified Tabs</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4, color: 'var(--accent)' }}>
            {classifyStatus?.classified_pages ?? 0} / {classifyStatus?.total_pages ?? 0} ({classifyStatus?.percentage_classified ?? 100}%)
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{classifyStatus?.pending_pages ?? 0} pending review</div>
        </div>
      </div>

      {/* Tag / Topic Rules Section */}
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 14,
        padding: '24px',
        marginBottom: 24
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>🏷️ Custom Topic & Tag Classification Rules</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13.5, marginTop: 4, marginBottom: 0 }}>
              Add keywords and descriptions for each topic tag so any saved video or article matches instantly
            </p>
          </div>

          {editingIndex === null && (
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={handleResetDefaultRules}
                style={{
                  background: 'transparent',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '8px 14px',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease'
                }}
                title="Restore full default taxonomy rules and keywords"
              >
                ↺ Reset to Defaults
              </button>
              <button
                onClick={handleStartAdd}
                style={{
                  background: 'var(--accent-soft)',
                  color: 'var(--accent)',
                  border: '1px solid var(--accent)',
                  borderRadius: 8,
                  padding: '8px 16px',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease'
                }}
              >
                + Add Custom Tag Rule
              </button>
            </div>
          )}
        </div>

        {/* Add/Edit Rule Form */}
        {editingIndex !== null && (
          <form
            onSubmit={handleSaveRule}
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--accent)',
              borderRadius: 12,
              padding: '20px',
              marginBottom: 24,
              display: 'flex',
              flexDirection: 'column',
              gap: 14
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>
              {editingIndex === -1 ? '✨ Add New Topic Rule' : `✏️ Edit Rule: ${rules[editingIndex]?.name}`}
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                Topic / Tag Name
              </label>
              <input
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="e.g. Artificial Intelligence, Cryptography, Gaming"
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  color: 'var(--text-primary)',
                  fontSize: 14,
                  outline: 'none'
                }}
                required
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                Trigger Keywords & Words (Comma-separated)
              </label>
              <input
                type="text"
                value={keywordsInput}
                onChange={(e) => setKeywordsInput(e.target.value)}
                placeholder="e.g. ai, llm, gpt, claude, gemini, machine learning, neural, diffusion, transformer"
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  color: 'var(--text-primary)',
                  fontSize: 14,
                  outline: 'none'
                }}
                required
              />
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 4 }}>
                Any tab with these words in its title, URL, channel, or description will be auto-assigned to this tag.
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                Description & Semantic Context
              </label>
              <textarea
                value={descInput}
                onChange={(e) => setDescInput(e.target.value)}
                placeholder="e.g. Artificial intelligence research, large language models, neural networks, and AI agent frameworks"
                rows={2}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  color: 'var(--text-primary)',
                  fontSize: 14,
                  outline: 'none',
                  resize: 'vertical'
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 6 }}>
              <button
                type="button"
                onClick={handleCancelEdit}
                style={{
                  padding: '9px 16px',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: 'transparent',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn-primary"
                style={{ padding: '9px 20px', fontSize: 13 }}
              >
                Save Topic Rule
              </button>
            </div>
          </form>
        )}

        {/* List of Active Rules */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rules.map((rule, idx) => (
            <div
              key={rule.name + idx}
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: '16px 20px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 16
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                    #{rule.name}
                  </span>
                  <span style={{ fontSize: 11, background: 'var(--accent-soft)', color: 'var(--accent)', padding: '2px 8px', borderRadius: 999, fontWeight: 600 }}>
                    {rule.keywords.length} keywords
                  </span>
                </div>

                {rule.description && (
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4 }}>
                    {rule.description}
                  </div>
                )}

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                  {rule.keywords.map((kw, kIdx) => (
                    <span
                      key={kw + kIdx}
                      style={{
                        fontSize: 11.5,
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-secondary)',
                        padding: '2px 8px',
                        borderRadius: 6
                      }}
                    >
                      {kw}
                    </span>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button
                  onClick={() => handleStartEdit(idx)}
                  title="Edit Rule"
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    color: 'var(--text-secondary)',
                    padding: '6px 10px',
                    fontSize: 12,
                    cursor: 'pointer'
                  }}
                >
                  ✏️ Edit
                </button>
                <button
                  onClick={() => handleDeleteRule(idx)}
                  title="Delete Rule"
                  style={{
                    background: 'transparent',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    borderRadius: 6,
                    color: '#ef4444',
                    padding: '6px 10px',
                    fontSize: 12,
                    cursor: 'pointer'
                  }}
                >
                  🗑️
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Terminator Automation & Target List */}
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 14,
        padding: '24px',
        marginBottom: 24
      }}>
        <div style={{ marginBottom: 18 }}>
          <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>⚡</span>
            <span>Terminator Automation & Clutter Rules</span>
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4, marginBottom: 0 }}>
            Configure what tabs are purged when you trigger the <strong>Terminator</strong> in your extension popup.
          </p>
        </div>

        {/* Global Action Toggles */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginBottom: 20 }}>
          <label style={{
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '14px 16px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            cursor: 'pointer'
          }}>
            <input
              type="checkbox"
              checked={termConfig.terminate_new_tabs}
              onChange={(e) => saveTerminatorConfig({ ...termConfig, terminate_new_tabs: e.target.checked })}
              style={{ marginTop: 3, cursor: 'pointer' }}
            />
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                Terminate Empty / New Tabs
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                Closes all blank and new tab pages (<code>chrome://newtab</code>, <code>about:blank</code>, etc.)
              </div>
            </div>
          </label>

          <label style={{
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '14px 16px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            cursor: 'pointer'
          }}>
            <input
              type="checkbox"
              checked={termConfig.deduplicate_tabs}
              onChange={(e) => saveTerminatorConfig({ ...termConfig, deduplicate_tabs: e.target.checked })}
              style={{ marginTop: 3, cursor: 'pointer' }}
            />
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                Deduplicate Sibling Tabs
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                Keeps exactly 1 copy of duplicate URLs and terminates all extra sibling copies.
              </div>
            </div>
          </label>
        </div>

        {/* Custom Target List (e.g. youtube.com) */}
        <div>
          <h4 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 6px 0' }}>
            🎯 Terminator Target List (Exact Link Matching)
          </h4>
          <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '0 0 12px 0' }}>
            Add specific exact links or homepages (e.g. <code>youtube.com</code> or <code>twitter.com/home</code>). Only tabs matching this <strong>exact link</strong> will be terminated, leaving all other video/article pages on that website safe.
          </p>

          {/* Add Target Form */}
          <form onSubmit={handleAddTarget} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
            <input
              type="text"
              value={newTargetPattern}
              onChange={(e) => setNewTargetPattern(e.target.value)}
              placeholder="Exact link or homepage (e.g. youtube.com)"
              style={{
                flex: 1,
                minWidth: 200,
                padding: '9px 12px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg)',
                color: 'var(--text-primary)',
                fontSize: 13,
                outline: 'none'
              }}
              required
            />
            <input
              type="text"
              value={newTargetDesc}
              onChange={(e) => setNewTargetDesc(e.target.value)}
              placeholder="Description / note (e.g. YouTube feeds)"
              style={{
                flex: 1,
                minWidth: 180,
                padding: '9px 12px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg)',
                color: 'var(--text-primary)',
                fontSize: 13,
                outline: 'none'
              }}
            />
            <button
              type="submit"
              className="btn-primary"
              style={{ padding: '9px 16px', fontSize: 12.5, whiteSpace: 'nowrap' }}
            >
              + Add Target
            </button>
          </form>

          {/* Targets List */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(!termConfig.custom_targets || termConfig.custom_targets.length === 0) ? (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontStyle: 'italic', padding: '10px 0' }}>
                No custom target websites added yet.
              </div>
            ) : (
              termConfig.custom_targets.map((target, idx) => (
                <div
                  key={idx}
                  style={{
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: '10px 14px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <input
                      type="checkbox"
                      checked={target.enabled}
                      onChange={() => handleToggleTarget(idx)}
                      title={target.enabled ? 'Enabled' : 'Disabled'}
                      style={{ cursor: 'pointer' }}
                    />
                    <div>
                      <span style={{
                        fontFamily: 'monospace',
                        fontWeight: 700,
                        fontSize: 13,
                        color: target.enabled ? '#f87171' : 'var(--text-tertiary)',
                        background: 'rgba(239, 68, 68, 0.1)',
                        padding: '2px 8px',
                        borderRadius: 4
                      }}>
                        {target.pattern}
                      </span>
                      {target.description && (
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 8 }}>
                          {target.description}
                        </span>
                      )}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleDeleteTarget(idx)}
                    title="Remove Target"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--text-tertiary)',
                      cursor: 'pointer',
                      fontSize: 14
                    }}
                  >
                    🗑️
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Multi-Window Browser Shutdown Sessions (Last 2 Sessions Cache) */}
      <div style={{
        background: 'var(--surface)',
        border: '1px solid rgba(124, 92, 255, 0.35)',
        borderRadius: 14,
        padding: '24px',
        marginBottom: 24,
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>✨</span>
              <span>Full Browser Shutdown Reincarnation (Last 2 Sessions)</span>
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4, marginBottom: 0 }}>
              Whenever you quit the browser, all your open windows, tabs, and tab groups are preserved in temporary cache memory.
            </p>
          </div>
          {browserSessions.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--accent)', background: 'var(--accent-soft)', padding: '3px 10px', borderRadius: 999, fontWeight: 600 }}>
                {browserSessions.length} / 2 cached
              </span>
              <button
                onClick={handleClearAllBrowserSessions}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  color: 'var(--text-tertiary)',
                  padding: '4px 10px',
                  borderRadius: 6,
                  fontSize: 11.5,
                  cursor: 'pointer'
                }}
              >
                Clear Cache
              </button>
            </div>
          )}
        </div>

        {browserSessions.length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13, background: 'var(--bg)', borderRadius: 10, border: '1px solid var(--border)' }}>
            No browser shutdown sessions cached yet. When you close all windows of your browser, the session snapshot will be cached here!
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {browserSessions.map((session) => (
              <div
                key={session.session_id}
                style={{
                  background: 'var(--bg)',
                  border: '1px solid rgba(124, 92, 255, 0.4)',
                  borderRadius: 10,
                  padding: '16px 20px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 16
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                      🪟 {session.window_count || session.windows?.length || 1} Window{(session.window_count || session.windows?.length || 1) > 1 ? 's' : ''} · {session.total_tab_count || 0} Tabs
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 700, background: 'rgba(124, 92, 255, 0.2)', color: '#c4b5fd', padding: '1px 6px', borderRadius: 4 }}>
                      {session.closed_ago || 'Recent'}
                    </span>
                  </div>

                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {session.title_preview || 'Saved multi-window browser session'}
                  </div>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    {session.windows?.map((w: any, wIdx: number) => (
                      <span
                        key={wIdx}
                        style={{
                          fontSize: 11,
                          background: 'var(--surface)',
                          border: '1px solid var(--border)',
                          borderRadius: 4,
                          padding: '1px 6px',
                          color: 'var(--text-secondary)'
                        }}
                      >
                        Window {wIdx + 1}: {w.tabs?.length || 0} tabs {w.groups?.length ? `(${w.groups.length} groups)` : ''}
                      </span>
                    ))}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    onClick={() => handleReincarnateBrowserSession(session)}
                    style={{
                      background: 'linear-gradient(135deg, #7c5cff, #a78bfa)',
                      color: '#ffffff',
                      border: 'none',
                      borderRadius: 8,
                      padding: '9px 18px',
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    ✦ Reincarnate Session
                  </button>
                  <button
                    onClick={() => handleDeleteBrowserSession(session.session_id)}
                    title="Delete this session"
                    style={{
                      background: 'transparent',
                      border: '1px solid var(--border)',
                      color: 'var(--text-tertiary)',
                      borderRadius: 8,
                      padding: '8px 10px',
                      cursor: 'pointer'
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recently Closed Single Windows Recovery */}
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 14,
        padding: '24px',
        marginBottom: 24
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>🪟</span>
              <span>Recently Closed Windows & Time Machine</span>
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4, marginBottom: 0 }}>
              Never lose your research session if you accidentally close your main screen or multi-tab window.
            </p>
          </div>
          {closedWindows.length > 0 && (
            <span style={{ fontSize: 12, color: 'var(--accent)', background: 'var(--accent-soft)', padding: '3px 10px', borderRadius: 999, fontWeight: 600 }}>
              {closedWindows.length} sessions stored
            </span>
          )}
        </div>

        {closedWindows.length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13, background: 'var(--bg)', borderRadius: 10, border: '1px solid var(--border)' }}>
            No recently closed windows recorded yet. When you close any multi-tab window, it will appear here for instant 1-click recovery!
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {closedWindows.map((session) => (
              <div
                key={session.session_id}
                style={{
                  background: 'var(--bg)',
                  border: session.is_recent_5m ? '1px solid rgba(99, 102, 241, 0.5)' : '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '14px 18px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 16,
                  boxShadow: session.is_recent_5m ? '0 2px 10px rgba(99, 102, 241, 0.12)' : 'none'
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                      🪟 {session.tab_count} tabs
                    </span>
                    <span style={{
                      fontSize: 11,
                      fontWeight: 700,
                      background: session.is_recent_5m ? 'rgba(99, 102, 241, 0.25)' : 'var(--surface)',
                      color: session.is_recent_5m ? '#818cf8' : 'var(--text-tertiary)',
                      padding: '1px 6px',
                      borderRadius: 4
                    }}>
                      {session.closed_ago}
                    </span>
                    {session.is_recent_5m && (
                      <span style={{ fontSize: 10.5, fontWeight: 700, color: '#34d399', background: 'rgba(52, 211, 153, 0.15)', padding: '1px 6px', borderRadius: 4 }}>
                        ⚡ Just closed
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {session.title_preview || 'Saved browser session'}
                  </div>
                </div>

                <button
                  onClick={() => handleRestoreWindow(session)}
                  className="btn-primary"
                  style={{ padding: '8px 16px', fontSize: 12.5, whiteSpace: 'nowrap' }}
                >
                  ✦ Reincarnate
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Semantic Vector Search Indexing */}
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 14,
        padding: '20px 24px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 16
      }}>
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>🧠 Semantic Knowledge Brain</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4, marginBottom: 0 }}>
            Rebuild vector embeddings for natural language AI question answering
          </p>
        </div>
        <button
          onClick={triggerIndexEmbeddings}
          disabled={isProcessing}
          style={{
            background: '#238636',
            color: '#ffffff',
            border: 'none',
            borderRadius: 8,
            padding: '10px 18px',
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer'
          }}
        >
          {isProcessing ? 'Indexing...' : 'Rebuild Vector Embeddings'}
        </button>
      </div>
    </div>
  );
};
