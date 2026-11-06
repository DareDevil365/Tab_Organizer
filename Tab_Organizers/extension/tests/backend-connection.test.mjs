import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const js=ts.transpileModule(readFileSync(new URL('../src/lib/backend-connection.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020}}).outputText;
const {normalizeBackendUrl,getBackendConnection,connectBackend,useLocalBackend}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

function fixture(){
 const data={};globalThis.chrome={storage:{local:{get:async key=>({[key]:data[key]}),set:async value=>Object.assign(data,value),remove:async keys=>{for(const key of [].concat(keys))delete data[key];}}}};return data;
}
test('cloud addresses require HTTPS without embedded credentials or paths',()=>{
 assert.equal(normalizeBackendUrl('https://app.example/'),'https://app.example');assert.equal(normalizeBackendUrl('http://127.0.0.1:8742'),'http://127.0.0.1:8742');
 for(const url of ['http://app.example/','https://secret@app.example/','https://app.example/api','https://app.example/?key=secret'])assert.throws(()=>normalizeBackendUrl(url));
});
test('connect verifies the private key before saving and preserves offline drafts per backend',async()=>{
 const data=fixture();data.companion_notes=[{id:'draft',pendingSync:true},{id:'synced'}];let requested;
 globalThis.fetch=async(url,options)=>{requested={url,options};return new Response('{"connected":true}',{status:200});};
 await connectBackend('https://backend.example','k'.repeat(64));
 assert.equal(requested.url,'https://backend.example/auth/session');assert.equal(requested.options.headers.Authorization,'Bearer '+'k'.repeat(64));
 assert.equal((await getBackendConnection()).url,'https://backend.example');assert.deepEqual(data.companion_notes,[]);
 await useLocalBackend();assert.equal((await getBackendConnection()).url,'http://127.0.0.1:8742');assert.deepEqual(data.companion_notes,[{id:'draft',pendingSync:true}]);
});
test('a rejected key keeps the current connection and cached notes intact',async()=>{
 const data=fixture();data.companion_notes=[{id:'keep'}];globalThis.fetch=async()=>new Response('{}',{status:401});
 await assert.rejects(connectBackend('https://backend.example','k'.repeat(64)),/incorrect/);
 assert.equal((await getBackendConnection()).url,'http://127.0.0.1:8742');assert.deepEqual(data.companion_notes,[{id:'keep'}]);
});
