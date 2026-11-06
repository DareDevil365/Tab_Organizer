import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiClient } from '../../lib/api-client';
import { PageData } from '../../types';
import { saveOnDevice } from '../../lib/outbox';

interface Props {
  active: boolean;
  onActiveChange: (active: boolean) => void;
  selected: Set<number>;
  onSelectionChange: (ids: Set<number>) => void;
  pages: PageData[];
  visibleIds: number[];
  onDeletePages: (ids: number[]) => Promise<number[]>;
  onPagesUpdated: (pages: PageData[]) => void;
}

export function LibrarySelection({ active, onActiveChange, selected, onSelectionChange, pages, visibleIds, onDeletePages, onPagesUpdated }: Props) {
  const [action, setAction] = useState<'delete' | 'group' | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const chosen = pages.filter(page => page.id && selected.has(page.id));
  const hiddenCount = chosen.filter(page => !visibleIds.includes(page.id!)).length;
  useEffect(() => {
    if (action) dialog.current?.showModal();
    else dialog.current?.close();
  }, [action]);
  const done = () => { onSelectionChange(new Set()); onActiveChange(false); setMessage(''); };

  async function openSelected() {
    setBusy(true); setMessage('');
    let opened = 0;
    for (const page of chosen) {
      try {
        const url = page.url_original || page.url_normalized;
        if (typeof chrome !== 'undefined' && chrome.tabs?.create) await chrome.tabs.create({ url, active: false });
        else if (!window.open(url, '_blank')) throw new Error('Browser blocked a new tab');
        opened++;
      } catch { break; }
    }
    setMessage(opened === chosen.length ? `Opened ${opened} selected tab${opened === 1 ? '' : 's'}.` : `Opened ${opened} of ${chosen.length}. Open this workspace through the extension to open all selected tabs.`);
    setBusy(false);
  }

  async function completeSelected(completed: boolean) {
    setBusy(true); setMessage('');
    try {
      // Chunking respects the backend's batch bound without limiting selection size.
      for (let offset = 0; offset < chosen.length; offset += 1000) {
        const batch = chosen.slice(offset, offset + 1000);
        onPagesUpdated(await apiClient.put<PageData[]>('/api/pages/completion', { page_ids: batch.map(page => page.id), completed }));
        window.dispatchEvent(new Event('resource-completion-updated'));
      }
      setMessage(completed ? `Marked ${chosen.length} selected resources complete.` : `Marked ${chosen.length} selected resources unseen.`);
    } catch { setMessage('Could not update every resource. Successful changes are kept; retry the selection to finish.'); }
    finally { setBusy(false); }
  }

  async function confirmAction(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      if (action === 'group') {
        await saveOnDevice('group', { name: name.trim(), color: 'purple', tabs: chosen.map(page => ({
          url: page.url_original || page.url_normalized, title: page.title, domain: page.domain,
          favicon_url: page.favicon_url, description: page.description, og_image_url: page.og_image_url,
        })) });
        setMessage(`Saved “${name.trim()}” on this device. Uploading when connected.`);
      } else {
        setAction(null);
        const failed = await onDeletePages(chosen.map(page => page.id!));
        onSelectionChange(new Set(failed));
        setMessage(failed.length ? `Deleted ${chosen.length - failed.length}; ${failed.length} could not be deleted. They remain selected for retry.` : `Deleted ${chosen.length} selected resources.`);
      }
      setAction(null); setName('');
    } catch { setMessage('Could not complete the action. Your selection is kept; please retry.'); }
    finally { setBusy(false); }
  }

  return <>
    <button className="library-select-toggle" aria-pressed={active} onClick={() => { if (active) done(); else onActiveChange(true); }} disabled={busy}>{active ? 'Done selecting' : 'Select'}</button>
    {active && createPortal(<div className="library-selection-bar" role="region" aria-label="Selected resource actions">
      <div className="selection-summary"><strong>{chosen.length}</strong><span>selected{hiddenCount ? ` · ${hiddenCount} outside this filter` : ''}</span></div>
      <button disabled={busy || !visibleIds.length} onClick={() => onSelectionChange(new Set([...selected, ...visibleIds]))}>Select visible</button>
      <button disabled={busy || !selected.size} onClick={() => onSelectionChange(new Set())}>Clear</button>
      <span className="selection-divider" />
      <button disabled={busy || !chosen.length} onClick={openSelected}>Open</button>
      <button disabled={busy || !chosen.some(page => !page.completed_at)} onClick={() => completeSelected(true)}>Mark complete</button>
      <button disabled={busy || !chosen.some(page => !!page.completed_at)} onClick={() => completeSelected(false)}>Mark unseen</button>
      <button disabled={busy || !chosen.length} onClick={() => setAction('group')}>Group</button>
      <button className="selection-delete" disabled={busy || !chosen.length} onClick={() => setAction('delete')}>Delete</button>
      <button aria-label="Exit select mode" disabled={busy} onClick={done}>×</button>
      {message && <p role="status">{message}</p>}
    </div>, document.body)}
    <dialog ref={dialog} className="workspace-dialog selection-dialog" aria-label={action === 'group' ? 'Group selected resources' : 'Delete selected resources'} onCancel={event => { event.preventDefault(); if (!busy) setAction(null); }}>
      <form onSubmit={confirmAction}>
        <h2>{action === 'group' ? 'Keep these together' : `Delete ${chosen.length} selected resource${chosen.length === 1 ? '' : 's'}?`}</h2>
        <p>{action === 'group' ? `${chosen.length} selected resources will be saved as a collection.` : 'These resources and their attached notes will be deleted from your library. Open browser tabs stay open.'}</p>
        {action === 'group' && <label>Collection name<input autoFocus required maxLength={255} value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Weekend research" /></label>}
        {message && <p role="alert">{message}</p>}
        <div className="selection-dialog-actions"><button type="button" disabled={busy} onClick={() => setAction(null)}>Cancel</button><button type="submit" disabled={busy || !chosen.length || action === 'group' && !name.trim()}>{busy ? 'Working…' : action === 'group' ? 'Create collection' : 'Delete selected'}</button></div>
      </form>
    </dialog>
  </>;
}
