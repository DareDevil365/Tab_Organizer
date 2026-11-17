import { normalizeUrl } from './url-normalize';

export const REMINDER_ALARM = 'page-reminder:';
export interface PageReminder { id:string;url:string;title:string;note:string;at:number;firedAt?:number;completedAt?:number;deletedAt?:number;updatedAt?:number;repeat?:{everyDays:number;times:string[];startDate:string;timezone:string} }
export interface ReminderBrowser {
  read():Promise<PageReminder[]>;
  write(rows:PageReminder[]):Promise<void>;
  cache(rows:PageReminder[]):Promise<void>;
  alarm(name:string,when:number):Promise<void>;
  clear(name:string):Promise<unknown>;
  notify(id:string,title:string,message:string):Promise<unknown>;
}
export class ReminderManager {
  private tail:Promise<unknown>=Promise.resolve();
  constructor(private browser:ReminderBrowser,private now=()=>Date.now()){}
  private serial<T>(task:()=>Promise<T>):Promise<T>{
    const result=this.tail.then(task);this.tail=result.catch(()=>{});return result;
  }
  set(input:{id?:string;url:string;title?:string;note?:string;at:number;repeat?:PageReminder['repeat']}):Promise<PageReminder>{return this.serial(async()=>{
    const url=new URL(input.url);
    if(!['https:','http:'].includes(url.protocol)||!Number.isFinite(input.at)||input.at<=this.now())throw Error('Choose a future time for a web page.');
    const rows=await this.browser.read(),key=normalizeUrl(input.url);
    const existing=rows.find(row=>!row.deletedAt&&(input.id?row.id===input.id:!row.completedAt&&normalizeUrl(row.url)===key));
    if(input.id&&!existing)throw Error('Reminder not found');
    if(input.repeat)validateRepeat(input.repeat);
    const reminder:PageReminder={id:existing?.id||crypto.randomUUID(),url:input.url,title:(input.title||url.hostname).slice(0,500),note:(input.note||'').trim().slice(0,2000),at:input.at,repeat:input.repeat,updatedAt:this.now()};
    await this.browser.write([...rows.filter(row=>row.id!==reminder.id),reminder]);
    await this.browser.alarm(REMINDER_ALARM+reminder.id,reminder.at);
    return reminder;
  });}
  change(id:string,action:'complete'|'snooze'|'remove',minutes=15):Promise<void>{return this.serial(async()=>{
    if(!['complete','snooze','remove'].includes(action))throw Error('Invalid reminder action');
    const rows=await this.browser.read(),row=rows.find(row=>row.id===id&&!row.deletedAt);if(!row)throw Error('Reminder not found');
    if(action==='snooze') {if(!Number.isFinite(minutes)||minutes<1||minutes>10080)throw Error('Invalid snooze');row.at=this.now()+minutes*60000;delete row.firedAt;delete row.completedAt;}
    if(action==='complete')row.completedAt=this.now();
    if(action==='remove')row.deletedAt=this.now();
    row.updatedAt=this.now();await this.browser.write(rows);await this.browser.clear(REMINDER_ALARM+id);
    if(action==='snooze')await this.browser.alarm(REMINDER_ALARM+id,row.at);
  });}
  merge(remote:PageReminder[],pending:PageReminder[]):Promise<void>{return this.serial(async()=>{
    const rows=new Map(remote.map(row=>[row.id,row]));
    for(const row of await this.browser.read())if((row.updatedAt||0)>(rows.get(row.id)?.updatedAt||0))rows.set(row.id,row);
    for(const row of pending)if((row.updatedAt||0)>=(rows.get(row.id)?.updatedAt||0))rows.set(row.id,row);
    const current=await this.browser.read();
    const merged=[...rows.values()];
    if(JSON.stringify(current)!==JSON.stringify(merged))await this.browser.cache(merged);
  });}
  reconcile():Promise<void>{return this.serial(async()=>{
    const rows=await this.browser.read();let changed=false;
    for(const row of rows){
      if(row.deletedAt||row.completedAt||row.firedAt)continue;
      if(row.at>this.now()) {await this.browser.alarm(REMINDER_ALARM+row.id,row.at).catch(()=>{});continue;}
      try {
        await this.browser.notify(REMINDER_ALARM+row.id,row.title,row.note||'Time to revisit this page.');
        if(row.repeat) {row.at=nextReminderTime(row.repeat,this.now());await this.browser.alarm(REMINDER_ALARM+row.id,row.at).catch(()=>{});}
        else row.firedAt=this.now();
        row.updatedAt=this.now();changed=true;
      } catch { /* Keep due records retryable if notifications are unavailable. */ }
    }
    if(changed)await this.browser.write(rows);
  });}
}

export function reminderCalendar(reminder:PageReminder):string {
  const escape=(value:string)=>value.replace(/\\/g,'\\\\').replace(/\r\n|[\r\n]/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
  const date=(value:number)=>new Date(value).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  // Fold UTF-8 lines at 75 octets, as required by the calendar format.
  const fold=(line:string)=>{let text='',size=0;for(const character of line){const bytes=new TextEncoder().encode(character).length;if(size+bytes>75){text+='\r\n ';size=1;}text+=character;size+=bytes;}return text;};
  const event=(id:string,at:number,rule?:string)=>['BEGIN:VEVENT',
    'UID:'+id+'@tab-organizer','DTSTAMP:'+date(Date.now()),'DTSTART:'+date(at),'DTEND:'+date(at+15*60000),
    ...(rule?[rule]:[]),'SUMMARY:'+escape(reminder.title),'DESCRIPTION:'+escape([reminder.note,reminder.url].filter(Boolean).join('\n')),
    'BEGIN:VALARM','ACTION:DISPLAY','TRIGGER:PT0M','DESCRIPTION:'+escape(reminder.note||reminder.title),'END:VALARM','END:VEVENT'];
  const repeat=reminder.repeat;
  const events=repeat?[...new Set(repeat.times)].flatMap((time,index)=>event(reminder.id+'-'+index,
    nextReminderTime({...repeat,times:[time]},Math.max(Date.now(),reminder.at-1)),'RRULE:FREQ=DAILY;INTERVAL='+repeat.everyDays)):event(reminder.id,reminder.at);
  return ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Tab Organizer//Page reminders//EN',...events,'END:VCALENDAR',''].map(fold).join('\r\n');
}


export function localDateTime(at:number,timezone:string):string {
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at);
 const get=(key:string)=>parts.find(part=>part.type===key)!.value;
 return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
export function validateRepeat(repeat:NonNullable<PageReminder['repeat']>){
 if(!Number.isInteger(repeat.everyDays)||repeat.everyDays<1||repeat.everyDays>365||!repeat.times.length||repeat.times.length>8||repeat.times.some(time=>!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))||!/^\d{4}-\d{2}-\d{2}$/.test(repeat.startDate))throw Error('Invalid repeat schedule');
 new Intl.DateTimeFormat('en',{timeZone:repeat.timezone}).format();
}
export function nextReminderTime(repeat:NonNullable<PageReminder['repeat']>,after:number):number {
 validateRepeat(repeat);
 const day=localDateTime(after,repeat.timezone).slice(0,10),anchor=Date.parse(repeat.startDate+'T00:00:00Z');
 const dayMs=86400000,today=Date.parse(day+'T00:00:00Z');
 if(!Number.isFinite(anchor)||new Date(anchor).toISOString().slice(0,10)!==repeat.startDate)throw Error('Choose a valid date.');
 const startOffset=Math.max(0,Math.round((anchor-today)/dayMs));
 for(let offset=startOffset;offset<=startOffset+2*repeat.everyDays;offset++){
  const date=new Date(today+offset*dayMs).toISOString().slice(0,10);
  const elapsed=Math.round((today+offset*dayMs-anchor)/dayMs);
  if(elapsed<0||elapsed%repeat.everyDays)continue;
  for(const time of [...new Set(repeat.times)].sort()){
   const wall=date+'T'+time,nominal=Date.parse(wall+':00Z');let instant=nominal;
   for(let step=0;step<4;step++){const represented=Date.parse(localDateTime(instant,repeat.timezone)+':00Z');const difference=nominal-represented;if(!difference)break;instant+=difference;}
   // Skip nonexistent wall times during a daylight-saving transition.
   if(localDateTime(instant,repeat.timezone)===wall&&instant>after)return instant;
  }
 }
 throw Error('No valid occurrence found. Choose a different time.');
}
