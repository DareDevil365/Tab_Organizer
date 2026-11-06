import React, { useEffect, useState } from 'react';
import './tools.css';
import { ToolIcon } from './ToolIcon';
import { apiClient } from '../../lib/api-client';
import { storage } from '../../lib/storage';
import { RecycleBin } from '../components/RecycleBin';
import { BackendConnectionPanel } from '../components/BackendConnection';

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

  async function loadSettingsData(){
    await Promise.allSettled([
      apiClient.healthCheck().then(setHealthStatus),
      (async()=>{const local=await storage.get<RuleItem[]>('custom_taxonomy_rules');if(local?.length)setRules(local);
        const remote=await apiClient.get<{rules:RuleItem[]}>('/api/classify/rules');if(Array.isArray(remote.rules)){setRules(remote.rules);await storage.set('custom_taxonomy_rules',remote.rules);}})(),
      apiClient.get<any>('/api/classify/status').then(setClassifyStatus),
      apiClient.get<{sessions:any[]}>('/api/windows/closed').then(value=>setClosedWindows(value.sessions||[])),
      (async()=>{try{const value=await apiClient.get<{sessions:any[]}>('/api/windows/browser-sessions');setBrowserSessions(value.sessions||[]);}catch{const local=await storage.get<any[]>('browser_sessions_cache');if(local)setBrowserSessions(local);}})(),
      (async()=>{const local=await storage.get<TerminatorConfig>('terminator_config');if(local)setTermConfig(local);
        const remote=await apiClient.get<TerminatorConfig>('/api/terminator/rules');if(typeof remote.terminate_new_tabs==='boolean'){setTermConfig(remote);await storage.set('terminator_config',remote);}})(),
    ]);
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
      const res = await apiClient.post<{ rules: RuleItem[]; message: string }>('/api/classify/rules/reset', {});
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

  return <div className="workspace-tools settings-page">
    <details className="tool-panel settings-disclosure"><summary>Backend connection · Change address or key</summary><BackendConnectionPanel/></details>
    <div className="tools-toolbar settings-toolbar"><p>Fine-tune how your workspace saves, sorts and remembers.</p><button className="tool-button" onClick={loadSettingsData}><ToolIcon name="refresh"/>Refresh status</button></div>
    {statusMsg && <div className={`tool-notice ${statusMsg.type}`} role="status">{statusMsg.text.replace(/^[✓✦]\s*/, '')}</div>}
    <section className="tool-panel settings-status-grid" aria-label="Workspace status">
      <div><span className="tool-eyebrow">Connection</span><strong className={healthStatus?.status === 'ok' ? 'tool-online' : 'tool-offline'}><i/>{healthStatus?.status === 'ok' ? 'Backend online' : healthStatus ? 'Backend offline' : 'Checking connection…'}</strong><small>{healthStatus?.status === 'ok' ? `Version ${healthStatus.version}` : 'Start your local backend to reconnect.'}</small></div>
      <div><span className="tool-eyebrow">Legacy keyword rules</span><strong>{classifyStatus?.classified_pages ?? 0}<em> / {classifyStatus?.total_pages ?? 0} tabs</em></strong><small>{classifyStatus?.pending_pages ?? 0} waiting to be classified</small></div>
      <div><span className="tool-eyebrow">AI setup</span><strong>Your configured provider</strong><small>Provider and API keys stay in the backend configuration.</small></div>
    </section>

    <details className="tool-panel settings-disclosure"><summary>Advanced · Legacy keyword rules</summary><p>Optional keyword rules are separate from automatic knowledge-graph topics. These counts do not measure graph readiness.</p>
      <div className="tool-section-head"><div><h2 id="settings-topics-title">Topics & classification</h2><p>Use your own keywords to organize saved videos, articles and pages.</p></div><button className="tool-button tool-primary" onClick={triggerReclassifyAll} disabled={isProcessing}><ToolIcon name="refresh"/>{isProcessing ? 'Processing…' : 'Reclassify tabs'}</button></div>
      <div className="settings-section-toolbar"><span className="tool-eyebrow">{rules.length} topic rules</span><div className="tool-actions"><button className="tool-text-button" onClick={handleResetDefaultRules}>Reset defaults</button>{editingIndex === null && <button className="tool-button" onClick={handleStartAdd}><ToolIcon name="plus"/>Add topic</button>}</div></div>
      {editingIndex !== null && <form className="tool-edit-form" onSubmit={handleSaveRule}>
        <h3>{editingIndex === -1 ? 'New topic rule' : `Edit ${rules[editingIndex]?.name}`}</h3>
        <div className="tool-form-grid"><label className="tool-field">Topic name<input autoFocus value={nameInput} onChange={event => setNameInput(event.target.value)} placeholder="e.g. Artificial intelligence" required/></label><label className="tool-field">Keywords<input value={keywordsInput} onChange={event => setKeywordsInput(event.target.value)} placeholder="machine learning, neural networks"/><small>Separate keywords with commas, semicolons or new lines.</small></label></div>
        <label className="tool-field">Description<textarea value={descInput} onChange={event => setDescInput(event.target.value)} rows={2} placeholder="What belongs in this topic?"/></label><div className="tool-form-actions"><button type="button" className="tool-button" onClick={handleCancelEdit}>Cancel</button><button className="tool-button tool-primary" type="submit">Save topic rule</button></div>
      </form>}
      <div className="settings-rules">{rules.map((rule,index) => <article key={rule.name+index} className="settings-rule"><div><div className="tool-title-row"><h3>{rule.name}</h3><span className="tool-counter">{rule.keywords.length} keywords</span></div>{rule.description && <p>{rule.description}</p>}<div className="settings-keywords">{rule.keywords.map((keyword,key) => <span key={keyword+key}>{keyword}</span>)}</div></div><div className="tool-actions"><button className="tool-icon-button" onClick={() => handleStartEdit(index)} aria-label={`Edit ${rule.name}`}><ToolIcon name="edit"/></button><button className="tool-icon-button tool-danger" onClick={() => handleDeleteRule(index)} aria-label={`Delete ${rule.name}`}><ToolIcon name="trash"/></button></div></article>)}</div>
      {!rules.length && editingIndex === null && <p className="tool-muted">No custom rules loaded. Add a topic or restore the default rules.</p>}
    </details>

    <section className="tool-panel" aria-labelledby="settings-cleanup-title"><div className="tool-section-head"><div><h2 id="settings-cleanup-title">Tab cleanup</h2><p>Choose what the popup’s cleanup action removes. Nothing closes until you run it.</p></div></div>
      <div className="settings-toggle-grid"><label className="settings-toggle"><div><strong>Empty & new tabs</strong><span>Include blank pages and unused new tabs.</span></div><input type="checkbox" role="switch" checked={termConfig.terminate_new_tabs} onChange={event => saveTerminatorConfig({...termConfig,terminate_new_tabs:event.target.checked})}/></label><label className="settings-toggle"><div><strong>Duplicate tabs</strong><span>Keep one copy of a URL and remove extras.</span></div><input type="checkbox" role="switch" checked={termConfig.deduplicate_tabs} onChange={event => saveTerminatorConfig({...termConfig,deduplicate_tabs:event.target.checked})}/></label></div>
      <div className="tool-section-head settings-subsection"><div><h3>Exact links to include</h3><p>Match a homepage or specific link. Other articles and videos on that website stay open.</p></div></div>
      <form className="settings-target-form" onSubmit={handleAddTarget}><label className="tool-field">Exact link<input value={newTargetPattern} onChange={event => setNewTargetPattern(event.target.value)} placeholder="e.g. youtube.com" required/></label><label className="tool-field">Note <small>(optional)</small><input value={newTargetDesc} onChange={event => setNewTargetDesc(event.target.value)} placeholder="e.g. Video feed"/></label><button type="submit" className="tool-button"><ToolIcon name="plus"/>Add link</button></form>
      <div className="settings-targets">{(termConfig.custom_targets || []).map((target,index) => <div className="settings-target" key={index}><label><input type="checkbox" role="switch" checked={target.enabled} onChange={() => handleToggleTarget(index)} aria-label={`Include ${target.pattern}`}/><span><strong>{target.pattern}</strong>{target.description && <small>{target.description}</small>}</span></label><button className="tool-icon-button tool-danger" onClick={() => handleDeleteTarget(index)} aria-label={`Remove ${target.pattern}`}><ToolIcon name="trash"/></button></div>)}</div>
      {!termConfig.custom_targets?.length && <p className="tool-muted">No extra links added.</p>}
    </section>

    <section className="tool-panel" aria-labelledby="settings-recovery-title"><div className="tool-section-head"><div><h2 id="settings-recovery-title">Session recovery</h2><p>Pick up where you left off, across tabs and windows.</p></div>{browserSessions.length > 0 && <button className="tool-text-button tool-danger" onClick={handleClearAllBrowserSessions}>Clear session cache</button>}</div>
      <div className="settings-section-toolbar"><span className="tool-eyebrow">Browser sessions</span><span className="tool-counter">{browserSessions.length} / 2 cached</span></div>
      {!browserSessions.length && <div className="settings-empty">Your last browser sessions will appear here after you close all browser windows.</div>}
      <div className="settings-session-list">{browserSessions.map(session => <article className="settings-session" key={session.session_id}><div><h3>{session.window_count || session.windows?.length || 1} window{(session.window_count || session.windows?.length || 1) !== 1 ? 's' : ''} · {session.total_tab_count || 0} tabs</h3><p>{session.title_preview || 'Saved browser session'}</p><div className="settings-keywords">{session.windows?.map((window:any,index:number) => <span key={index}>Window {index+1}: {window.tabs?.length || 0} tabs{window.groups?.length ? ` · ${window.groups.length} groups` : ''}</span>)}</div><small>{session.closed_ago || 'Recently saved'}</small></div><div className="tool-actions"><button className="tool-button" onClick={() => handleReincarnateBrowserSession(session)}><ToolIcon name="open"/>Restore</button><button className="tool-icon-button tool-danger" onClick={() => handleDeleteBrowserSession(session.session_id)} aria-label="Delete browser session"><ToolIcon name="trash"/></button></div></article>)}</div>
      <div className="settings-section-toolbar settings-subsection"><span className="tool-eyebrow">Recently closed windows</span><span className="tool-counter">{closedWindows.length} saved</span></div>
      {!closedWindows.length && <div className="settings-empty">Closed windows with multiple tabs will appear here for recovery.</div>}
      <div className="settings-session-list">{closedWindows.map(session => <article className="settings-session" key={session.session_id}><div><h3>{session.tab_count} tabs{session.is_recent_5m && <span className="tool-counter">Just closed</span>}</h3><p>{session.title_preview || 'Saved browser window'}</p><small>{session.closed_ago}</small></div><button className="tool-button" onClick={() => handleRestoreWindow(session)}><ToolIcon name="open"/>Restore window</button></article>)}</div>
    </section>
    <RecycleBin onRestored={onReclassified}/>
    <details className="tool-panel settings-disclosure"><summary>Advanced · Search index maintenance</summary><section className="settings-index-panel"><div><h2>Search & AI index</h2><p>Refresh the saved-resource embeddings used for semantic search and answers.</p></div><button className="tool-button" onClick={triggerIndexEmbeddings} disabled={isProcessing}><ToolIcon name="refresh"/>{isProcessing ? 'Processing…' : 'Rebuild search index'}</button></section></details>
  </div>;
};
