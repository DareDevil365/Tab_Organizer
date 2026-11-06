import { useState } from 'react';
import { SiteIcon } from './SiteIcon';
import { ToolIcon } from '../pages/ToolIcon';
import './session-recovery.css';

function sessionTabs(session: any) {
  return Array.isArray(session.windows) ? session.windows.flatMap((window: any,index: number) => (window.tabs || []).map((tab: any) => ({...tab,windowNumber:index+1}))) : (session.tabs || []).map((tab: any) => ({...tab,windowNumber:1}));
}

export function SessionRecovery({ sessions, restoring, onRestore, onDismiss }: {
  sessions: any[]; restoring: string | null; onRestore: (session: any) => void; onDismiss: (id: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return <section className="session-recovery" aria-label="Session recovery">
    <div className="session-recovery-heading"><div><span className="session-recovery-icon"><ToolIcon name="refresh"/></span><div><h2>Pick up where you left off</h2><p>Your windows, tabs and groups, kept together.</p></div></div><span>{sessions.length} saved session{sessions.length===1?'':'s'}</span></div>
    <div className="session-recovery-grid">{sessions.map(session => {
      const tabs=sessionTabs(session), expanded=open===session.session_id;
      const count=tabs.length || session.total_tab_count || 0;
      const windows=session.window_count || session.windows?.length || 1;
      const busy=restoring===session.session_id;
      return <article className={`recovery-session ${expanded?'is-expanded':''}`} key={session.session_id} data-session-id={session.session_id}
        onMouseEnter={()=>setOpen(session.session_id)} onMouseLeave={()=>setOpen(null)}
        onFocus={()=>setOpen(session.session_id)} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setOpen(null);}}>
        <button className="recovery-dismiss" aria-label="Dismiss saved session" title="Dismiss saved session" onClick={()=>onDismiss(session.session_id)}><ToolIcon name="close"/></button>
        <button className="recovery-session-preview" aria-expanded={expanded} aria-label={`Preview ${count} tabs from saved session`} onClick={()=>setOpen(session.session_id)}>
          <span className="recovery-session-meta"><strong>{count} tab{count===1?'':'s'}<small> · {windows} window{windows===1?'':'s'}</small></strong><time>{session.closed_at ? new Date(session.closed_at).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : 'Recently closed'}</time></span>
          <span className="recovery-site-strip">{tabs.slice(0,9).map((tab:any,index:number)=><span className="recovery-site-icon" key={index} title={tab.title || tab.url}><SiteIcon url={tab.url || tab.url_original || ''} favicon={tab.favIconUrl || tab.favicon_url}/></span>)}{tabs.length>9 && <span className="recovery-site-more">+{tabs.length-9}</span>}{!tabs.length && <span className="recovery-preview-empty">Tab preview unavailable</span>}</span>
          <span className="recovery-session-hint">{expanded?'Tabs in this session':'Preview tabs'}<ToolIcon name="chevron"/></span>
        </button>
        <div className="recovery-tab-expansion" aria-hidden={!expanded}><div className="recovery-tab-scroll">{tabs.map((tab:any,index:number)=><div className="recovery-tab" key={index}><span className="recovery-site-icon"><SiteIcon url={tab.url || tab.url_original || ''} favicon={tab.favIconUrl || tab.favicon_url}/></span><span><strong>{tab.title || 'Untitled tab'}</strong><small>{windows>1?`Window ${tab.windowNumber} · `:''}{(()=>{try{return new URL(tab.url || tab.url_original).hostname.replace(/^www\./,'');}catch{return 'Saved tab';}})()}</small></span></div>)}</div></div>
        <div className="recovery-session-actions"><button className="recovery-restore" disabled={busy || typeof chrome==='undefined' || !chrome.runtime?.sendMessage} onClick={()=>onRestore(session)}><ToolIcon name="refresh"/>{busy?'Restoring…':'Restore session'}</button></div>
      </article>;
    })}</div>
  </section>;
}
