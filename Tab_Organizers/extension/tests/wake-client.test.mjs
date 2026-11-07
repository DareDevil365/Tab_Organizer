import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const source=readFileSync(new URL('../src/lib/wake-client.ts',import.meta.url),'utf8');
const javascript=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020}}).outputText;
const {WakeClient}=await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
const progress=(overrides={})=>({ownerId:'worker',revision:0,running:false,windowId:1,total:0,completed:0,woken:0,failed:0,skipped:0,...overrides});
function panelFixture(){
 let state=progress({ownerId:'panel'}),starts=0;
 return {status:()=>state,start:async()=>{starts++;state=progress({ownerId:'panel',running:true,total:5,revision:1});return state;},get starts(){return starts;}};
}
test('old worker with no wake handler falls back instead of showing the failed-request toast',async()=>{
 const panel=panelFixture(),messages=[];
 const client=new WakeClient(async message=>{messages.push(message.type);return undefined;},panel);
 assert.equal((await client.start(1)).running,true);
 assert.equal(panel.starts,1);
 assert.deepEqual(messages,['GET_TAB_WAKE_STATUS']);
});
test('a suspended or disconnected worker does not disable direct panel wake',async()=>{
 const panel=panelFixture();const client=new WakeClient(async()=>{throw Error('Receiving end does not exist');},panel);
 assert.equal((await client.start(1)).ownerId,'panel');assert.equal(panel.starts,1);
});
test('a supported worker owns the batch so panel closure does not interrupt normal waking',async()=>{
 const panel=panelFixture();
 const client=new WakeClient(async message=>({success:true,progress:progress(message.type==='WAKE_SLEEPING_TABS'?{running:true,total:5,revision:1}:{})}),panel);
 assert.equal((await client.start(1)).running,true);assert.equal(panel.starts,0);
});
test('lost start acknowledgement checks actual worker progress before considering fallback',async()=>{
 const panel=panelFixture();let started=false;
 const client=new WakeClient(async message=>{
  if(message.type==='WAKE_SLEEPING_TABS'){started=true;throw Error('Message port closed');}
  return {success:true,progress:progress(started?{running:true,total:5,revision:2}:{})};
 },panel);
 assert.equal((await client.start(1)).ownerId,'worker');assert.equal(panel.starts,0);
});
test('fast completion with a lost acknowledgement is not repeated',async()=>{
 const panel=panelFixture();let started=false;
 const client=new WakeClient(async message=>{
  if(message.type==='WAKE_SLEEPING_TABS'){started=true;return {success:false,error:'no_response'};}
  return {success:true,progress:progress(started?{total:5,completed:5,woken:5,revision:7}:{})};
 },panel);
 assert.equal((await client.start(1)).woken,5);assert.equal(panel.starts,0);
});
test('once fallback is running, repeated clicks cannot start a parallel worker queue',async()=>{
 const panel=panelFixture();let sends=0;
 const client=new WakeClient(async()=>{sends++;return undefined;},panel);
 await client.start(1);await client.start(1);
 assert.equal(panel.starts,1);assert.equal(sends,1);
});
