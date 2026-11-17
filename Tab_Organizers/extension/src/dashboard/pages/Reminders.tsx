import { useEffect, useState, useRef } from 'react';
import { PageReminder } from '../../lib/reminders';
import { getReminders, onRemindersChanged, openReminderEditor, reminderRequest, exportReminder, reminderDescription } from '../../lib/reminder-ui';
export function Reminders(){
 const [rows,setRows]=useState<PageReminder[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState('');
 const opened=useRef(false);
 const refresh=()=>{void getReminders().then(value=>{setRows(value.filter(row=>!row.deletedAt).sort((a,b)=>Number(!!a.completedAt)-Number(!!b.completedAt)||a.at-b.at));setError('');
  const target=new URLSearchParams(location.search).get('reminder');
  const row=value.find(row=>row.id===target&&!row.deletedAt);if(row&&!opened.current){opened.current=true;openReminderEditor(row,row);}
 }).catch(err=>setError(err.message));};
 useEffect(()=>{refresh();return onRemindersChanged(refresh);},[]);
 const change=async(row:PageReminder,action:string)=>{setBusy(row.id);try{await reminderRequest('CHANGE_PAGE_REMINDER',{id:row.id,action,minutes:15});refresh();}catch(err){setError((err as Error).message);}finally{setBusy('');}};
 return <section className="reminder-list" aria-label="Reminders"><p>Browser alerts catch up when you return. Repeats continue until you mark them done.</p>
 {error&&<p role="alert">{error}</p>}{!rows.length&&<p>No reminders yet. Use the clock above the notes bar on any page.</p>}
 {rows.map(row=><article className={'reminder-card'+(row.completedAt?' completed':'')} key={row.id}>
  <header><input type="checkbox" checked={!!row.completedAt} disabled={!!row.completedAt||busy===row.id} aria-label={'Mark '+row.title+' done'} onChange={()=>void change(row,'complete')}/><strong>{row.title}</strong></header>
  <p>{row.note}</p><small>{row.completedAt?'Done':row.firedAt?'Delivered':new Date(row.at).toLocaleString()} · {reminderDescription(row)}</small>
  <div className="reminder-actions"><button onClick={()=>openReminderEditor(row,row)}>Edit / reschedule</button>
  {!row.completedAt&&<button disabled={busy===row.id} onClick={()=>void change(row,'snooze')}>Snooze 15 min</button>}
  <button onClick={()=>exportReminder(row)}>Export calendar</button><button onClick={()=>void chrome.tabs.create({url:row.url})}>Open page</button>
  <button disabled={busy===row.id} onClick={()=>void change(row,'remove')}>Remove</button></div>
 </article>)}
 </section>;
}
