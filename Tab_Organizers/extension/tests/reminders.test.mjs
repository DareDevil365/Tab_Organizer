import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const toModule=(name,replace=(text)=>text)=>'data:text/javascript;base64,'+Buffer.from(replace(ts.transpileModule(readFileSync(new URL('../src/lib/'+name+'.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020}}).outputText)).toString('base64');
const {ReminderManager,nextReminderTime,reminderCalendar}=await import(toModule('reminders',text=>text.replace("'./url-normalize'",JSON.stringify(toModule('url-normalize')))));
const repeat={everyDays:2,times:['07:00','19:00'],startDate:'2026-11-18',timezone:'Asia/Kolkata'};
const timestamp=(s)=>Date.parse(s);
test('alternate day and twice-daily schedules work across timezone and missed days',()=>{
 assert.equal(nextReminderTime(repeat,timestamp('2026-11-18T01:30:00Z')),timestamp('2026-11-18T13:30:00Z'));
 assert.equal(nextReminderTime(repeat,timestamp('2026-11-19T12:00:00Z')),timestamp('2026-11-20T01:30:00Z'));
 assert.equal(nextReminderTime(repeat,timestamp('2026-10-01T12:00:00Z')),timestamp('2026-11-18T01:30:00Z'));
});
test('recurring browser reminders catch up once, survive snooze/restart and stop on completion',async()=>{
 let now=timestamp('2026-11-18T00:30:00Z'),rows=[];const alerts=[],alarms=new Map();
 const save=async value=>{rows=structuredClone(value);};
 const browser={read:async()=>structuredClone(rows),write:save,cache:save,alarm:async(id,at)=>alarms.set(id,at),clear:async id=>alarms.delete(id),notify:async(...args)=>alerts.push(args)};
 let manager=new ReminderManager(browser,()=>now);
 const row=await manager.set({url:'https://example.org/page',title:'Read',note:'Chapter 4',at:nextReminderTime(repeat,now),repeat});
 now=timestamp('2026-11-21T23:30:00Z');
 manager=new ReminderManager(browser,()=>now);await manager.reconcile();await manager.reconcile();
 assert.equal(alerts.length,1);assert.equal(rows[0].at,timestamp('2026-11-22T01:30:00Z'));
 await manager.change(row.id,'snooze',15);assert.equal(rows[0].at,now+900000);
 now+=900000;await manager.reconcile();assert.equal(alerts.length,2);
 await manager.change(row.id,'complete');now+=7*86400000;await manager.reconcile();assert.equal(alerts.length,2);assert.equal(alarms.size,0);
 const edited=await manager.set({id:row.id,url:row.url,at:now+3600000});assert.equal(edited.id,row.id);assert.equal(rows.length,1);
});
test('calendar export escapes note fields and gives each time its own recurring event',()=>{
 const at=Date.now()+86400000,startDate=new Date(at).toISOString().slice(0,10);
 const ics=reminderCalendar({id:'sample',url:'https://example.org',title:'Read, review',note:'Line 1\nSUMMARY:fake',at,repeat:{...repeat,startDate}});
 assert.equal((ics.match(/BEGIN:VEVENT/g)||[]).length,2);
 assert.match(ics,/RRULE:FREQ=DAILY;INTERVAL=2/);
 assert.ok(ics.includes('SUMMARY:Read\\, review'));
 assert.ok(!ics.includes('\r\nSUMMARY:fake'));
});
