import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('../src/lib/activity-tracker.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const { ActivityTracker } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
function fixture() {
  let now = Date.UTC(2026,10,4,12), state = {}, context = {tabId:1,url:'https://example.com/first',domain:'example.com'};
  const uploads = [];
  let uploader = async queue => uploads.push(structuredClone(queue));
  const dependencies = {now:()=>now,context:async()=>context,read:async()=>structuredClone(state),write:async value=>{state={...state,...structuredClone(value)};},upload:queue=>uploader(queue)};
  return {tracker:new ActivityTracker(dependencies),dependencies,uploads,advance:seconds=>now+=seconds*1000,setContext:value=>context=value,setUpload:fn=>uploader=fn,get state(){return state;}};
}
test('a long focused tab is counted by heartbeat before any tab switch', async()=>{
  const f=fixture(); await f.tracker.checkpoint(); f.advance(30); await f.tracker.checkpoint({flush:true});
  assert.equal(f.uploads[0][0].duration_seconds,30); assert.equal(f.state.activity_queue.length,0);
  assert.equal(f.state.activity_current_session_v2.url,'https://example.com/first');
});
test('idle or unfocused time stops until the context becomes eligible again',async()=>{
  const f=fixture(); await f.tracker.checkpoint(); f.advance(12); f.setContext(null); await f.tracker.checkpoint();
  f.advance(120); await f.tracker.checkpoint(); assert.equal(f.state.activity_queue.length,1);
  assert.equal(f.state.activity_queue[0].duration_seconds,12); assert.equal(f.state.activity_current_session_v2,null);
  f.setContext({tabId:2,url:'https://other.test',domain:'other.test'}); await f.tracker.checkpoint(); f.advance(10); await f.tracker.checkpoint();
  assert.deepEqual(f.state.activity_queue.map(item=>item.duration_seconds),[12,10]);
});
test('new worker instance resumes persisted checkpoints and retains offline intervals',async()=>{
  const f=fixture(); await f.tracker.checkpoint(); f.advance(30);
  f.setUpload(async()=>{throw Error('offline');}); const restarted=new ActivityTracker(f.dependencies);
  await restarted.checkpoint({flush:true}); assert.equal(f.state.activity_queue[0].duration_seconds,30);
  f.advance(30); f.setUpload(async queue=>f.uploads.push(structuredClone(queue))); await restarted.checkpoint({flush:true});
  assert.equal(f.uploads[0].reduce((sum,item)=>sum+item.duration_seconds,0),60); assert.equal(f.state.activity_queue.length,0);
});
test('events during an upload are serialized rather than erased by queue clearing',async()=>{
  const f=fixture(); await f.tracker.checkpoint(); f.advance(30); let release;
  f.setUpload(()=>new Promise(resolve=>{release=resolve;})); const upload=f.tracker.checkpoint({flush:true});
  while(!release) await new Promise(resolve=>setTimeout(resolve,0)); f.advance(10); const event=f.tracker.checkpoint();
  release(); await Promise.all([upload,event]); assert.equal(f.state.activity_queue[0].duration_seconds,10);
});
test('startup discards stale browser-closed time and delayed heartbeats are bounded',async()=>{
  const f=fixture(); await f.tracker.checkpoint(); f.advance(7200); await f.tracker.checkpoint({discardPrevious:true});
  assert.equal(f.state.activity_queue.length,0); f.advance(7200); await f.tracker.checkpoint();
  assert.equal(f.state.activity_queue[0].duration_seconds,90);
});

test('late video title and channel enrich only the matching active URL, without borrowing the next video',async()=>{
 const f=fixture();
 f.setContext({tabId:1,url:'https://example.com/first',domain:'example.com',title:'www.youtube.com'});
 await f.tracker.checkpoint();f.advance(30);
 f.setContext({tabId:1,url:'https://example.com/first',domain:'example.com',title:'An electronics experiment',channel:'Maker channel'});
 await f.tracker.checkpoint();
 assert.equal(f.state.activity_queue[0].title,'An electronics experiment');
 assert.equal(f.state.activity_queue[0].channel,'Maker channel');
 f.advance(30);f.setContext({tabId:2,url:'https://example.com/second',domain:'example.com',title:'A mathematics lecture',channel:'Math channel'});
 await f.tracker.checkpoint();
 assert.equal(f.state.activity_queue[1].title,'An electronics experiment');
 assert.equal(f.state.activity_queue[1].channel,'Maker channel');
 assert.equal(f.state.activity_current_session_v2.title,'A mathematics lecture');
});
