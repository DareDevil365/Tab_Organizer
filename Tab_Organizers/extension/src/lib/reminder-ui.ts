import { apiClient } from './api-client';
import { onDeviceSync } from './outbox';
import { normalizeUrl } from './url-normalize';
import { PageReminder, reminderCalendar, localDateTime, nextReminderTime } from './reminders';
import './reminder-ui.css';

const clock='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 8v5l3 2"/></svg>';
const alarm='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="13" r="7"/><path d="M12 9v4l3 2M3 6l4-3m10 0 4 3M7 19l-2 3m12-3 2 3"/></svg>';
export async function reminderRequest(type:string,values:Record<string,unknown>={}):Promise<any>{
 const response=await chrome.runtime.sendMessage({type,...values});
 if(!response?.success)throw Error(response?.error||'Could not reach reminders. Reload the extension and retry.');
 return response.reminder;
}
export async function getReminders():Promise<PageReminder[]>{return await reminderRequest('GET_PAGE_REMINDERS');}
export const reminderDescription=(row:PageReminder)=>row.repeat?`Every ${row.repeat.everyDays===1?'day':row.repeat.everyDays+' days'} at ${row.repeat.times.join(', ')} · until done`:'Once';
export function exportReminder(row:PageReminder){
 const url=URL.createObjectURL(new Blob([reminderCalendar(row)],{type:'text/calendar;charset=utf-8'}));
 const anchor=document.createElement('a');anchor.href=url;anchor.download='page-reminder.ics';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function onRemindersChanged(callback:()=>void){
 const listener=(message:any)=>{if(message?.type==='PAGE_REMINDERS_CHANGED')callback();};
 chrome.runtime.onMessage.addListener(listener);const stop=onDeviceSync(callback);
 return ()=>{chrome.runtime.onMessage.removeListener(listener);stop();};
}
export function openReminderEditor(context:{url:string;title:string;note?:string},existing?:PageReminder):void {
 const old=document.getElementById('page-reminder-editor');if(old)return;
 const zone=existing?.repeat?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone;
 const dialog=document.createElement('dialog');dialog.id='page-reminder-editor';dialog.className='reminder-editor';
 dialog.innerHTML=`<form><header><strong>Reminder</strong><button type="button" data-close aria-label="Close reminder">×</button></header>
 <p class="reminder-page"></p>
 <label>What to remember<textarea name="note" rows="2" maxlength="2000" placeholder="Your reminder…"></textarea></label>
 <label for="reminder-phrase">Describe the schedule</label><div class="reminder-interpret"><input id="reminder-phrase" name="phrase" maxlength="1000" placeholder="Tomorrow 7 am, every day, or make it 9 pm today"><button type="button" data-interpret>Interpret</button></div>
 <div class="reminder-fields"><label>Date & time<input name="when" type="datetime-local" required></label><label>Repeat<select name="repeat"><option value="0">Once</option><option value="1">Daily until done</option><option value="2">Alternate days until done</option></select></label></div>
 <label data-times hidden>Times each day (24-hour)<input name="times" placeholder="07:00, 19:00"></label>
 <p class="reminder-preview" role="status"></p><p class="reminder-error" role="alert"></p>
 <p class="reminder-help">Browser alerts catch up after reopening. For phone alerts, export and import into a synced calendar. Calendar copies are separate; check their notification settings.</p>
 <footer><button type="button" data-export>Export calendar</button><button type="submit" class="reminder-primary">${existing?'Update':'Set'} reminder</button></footer></form>`;
 const form=dialog.querySelector('form')!,field=(name:string)=>form.elements.namedItem(name) as HTMLInputElement;
 const preview=dialog.querySelector<HTMLElement>('.reminder-preview')!,error=dialog.querySelector<HTMLElement>('.reminder-error')!;
 const timesWrap=dialog.querySelector<HTMLElement>('[data-times]')!,submit=dialog.querySelector<HTMLButtonElement>('[type=submit]')!;
 dialog.querySelector('.reminder-page')!.textContent=context.title;
 field('note').value=existing?.note||context.note||'';
 field('when').value=localDateTime(existing?.at&&existing.at>Date.now()?existing.at:Date.now()+3600000,zone);
 field('repeat').value=String(existing?.repeat?.everyDays||0);field('times').value=existing?.repeat?.times.join(', ')||field('when').value.slice(11);
 const build=()=>{
  const wall=field('when').value,everyDays=Number(field('repeat').value);
  if(!wall)throw Error('Choose a date and time.');
  const schedule={everyDays:everyDays||1,times:everyDays?field('times').value.split(',').map(time=>time.trim()):[wall.slice(11)],startDate:wall.slice(0,10),timezone:zone};
  if(!Number.isFinite(Date.parse(wall+':00Z')))throw Error('Choose a valid date and time.');
  const first=nextReminderTime({...schedule,everyDays:1,times:[wall.slice(11)]},Date.parse(wall+':00Z')-2*86400000);
  if(localDateTime(first,zone)!==wall)throw Error('Choose a valid time in '+zone+'.');
  if(!everyDays&&first<=Date.now())throw Error('Choose a future date and time.');
  const at=everyDays?nextReminderTime(schedule,Math.max(Date.now(),first-1)):first;
  return {url:context.url,title:context.title,note:field('note').value,at,repeat:everyDays?schedule:undefined};
 };
 const update=()=>{error.textContent='';timesWrap.hidden=field('repeat').value==='0';try{const row=build();preview.textContent=`${new Date(row.at).toLocaleString(undefined,{timeZone:zone})} · ${zone}${row.repeat?' · repeats until done':''}`;}catch(err){error.textContent=(err as Error).message;}};
 for(const name of ['when','repeat','times'])field(name).addEventListener('change',update);
 let interpretRevision=0;
 dialog.querySelector('[data-interpret]')!.addEventListener('click',async()=>{
  if(!field('phrase').value.trim())return;const revision=++interpretRevision;
  const button=dialog.querySelector<HTMLButtonElement>('[data-interpret]')!;button.disabled=true;submit.disabled=true;error.textContent='';preview.textContent='Interpreting…';
  try {
   const value=await apiClient.post<any>('/api/reminders/interpret',{text:field('phrase').value,timezone:zone,now:new Date().toISOString()});
   if(revision!==interpretRevision||!dialog.isConnected)return;
   if(value.needsClarification)throw Error(value.confirmation||'Please clarify the time.');
   field('when').value=localDateTime(value.at,zone);field('repeat').value=String(value.repeat?.everyDays||0);field('times').value=value.repeat?.times?.join(', ')||field('when').value.slice(11);
   if(!['0','1','2'].includes(field('repeat').value))throw Error('Use daily or alternate-day repeats, or choose a date manually.');
   update();if(!error.textContent)preview.textContent='Confirm: '+preview.textContent+'. '+value.confirmation;
  }catch(err){error.textContent=(err as Error).message;}finally{button.disabled=false;submit.disabled=false;}
 });
 const close=()=>{interpretRevision++;dialog.close();dialog.remove();};
 dialog.querySelector('[data-close]')!.addEventListener('click',close);dialog.addEventListener('cancel',()=>{dialog.remove();});
 dialog.querySelector('[data-export]')!.addEventListener('click',()=>{try{exportReminder({id:existing?.id||crypto.randomUUID(),...build()});}catch(err){error.textContent=(err as Error).message;}});
 form.addEventListener('submit',async event=>{
  event.preventDefault();submit.disabled=true;error.textContent='';
  try {await reminderRequest('SET_PAGE_REMINDER',{reminder:{id:existing?.id,...build()}});close();}
  catch(err){error.textContent=(err as Error).message;}finally{submit.disabled=false;}
 });
 document.body.append(dialog);update();dialog.showModal();
}
export function mountReminderButton(button:HTMLButtonElement,context:()=>{url:string;title:string;note?:string}){
 let rows:PageReminder[]=[];
 let lastPaint='';
 const paint=()=>{const current=context(),row=rows.find(row=>!row.deletedAt&&!row.completedAt&&!row.firedAt&&normalizeUrl(row.url)===normalizeUrl(current.url));
  const key=JSON.stringify([current.url,row?.id,row?.at]);if(key===lastPaint)return;lastPaint=key;
  button.classList.toggle('reminder-set',!!row);button.innerHTML=row?alarm:clock;button.setAttribute('aria-pressed',String(!!row));
  button.title=row?'Reminder set: '+new Date(row.at).toLocaleString():'Set a reminder';button.setAttribute('aria-label',button.title);
  button.disabled=!/^https?:\/\//i.test(current.url);
 };
 const refresh=()=>{void getReminders().then(value=>{rows=value;paint();}).catch(()=>{});};
 const stop=onRemindersChanged(refresh);refresh();paint();
 button.addEventListener('click',()=>{const current=context();openReminderEditor(current,rows.find(row=>!row.deletedAt&&!row.completedAt&&normalizeUrl(row.url)===normalizeUrl(current.url)));});
 return {paint,stop};
}
