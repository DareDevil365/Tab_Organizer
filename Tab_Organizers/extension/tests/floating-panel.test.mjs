import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const source=readFileSync(new URL('../src/lib/floating-panel.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020}}).outputText;
const {openFloatingPanel,authorizeFloatingPanel,closeInactivePanels}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
function fixture(result='opened') {
 const data={},calls=[];
 globalThis.chrome={runtime:{id:'test',getURL:p=>`chrome-extension://test/${p}`},storage:{session:{set:async value=>Object.assign(data,value),get:async key=>({[key]:data[key]}),remove:async key=>delete data[key]}},scripting:{executeScript:async options=>{calls.push(['inject',options]);if(result==='throw')throw Error('Restricted');return[{result}];}},action:{setPopup:async value=>calls.push(['popup',value.popup]),openPopup:async options=>calls.push(options?['native',options.windowId]:['native'])}};
 return {data,calls};
}
test('ordinary sites open the extension frame with a per-tab token and no native popup',async()=>{
 const f=fixture();await openFloatingPanel({id:7,url:'https://example.com'});
 assert.equal(f.calls[0][0],'inject');assert.equal(f.calls.length,1);
 assert.equal(new URL(f.calls[0][1].args[0]).searchParams.get('panel'),f.data.karlx_panel_7.token);
});
test('a second toolbar click closes the existing panel without opening a fallback',async()=>{
 const f=fixture('closed');await openFloatingPanel({id:7,url:'https://example.com'});assert.equal(f.calls.length,1);
});

test('own dashboard asks the matching workspace to mount the rounded panel without injection',async()=>{
 const f=fixture();chrome.runtime.sendMessage=async message=>{f.calls.push(['workspace',message]);return {status:'opened'};};
 await openFloatingPanel({id:7,url:'chrome-extension://test/src/dashboard/dashboard.html?local=true#library'});
 assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'workspace');
 assert.deepEqual(f.calls[0][1],{type:'TOGGLE_WORKSPACE_PANEL',tabId:7,token:f.data.karlx_panel_7.token});
});

test('other extensions and our popup itself cannot take the dashboard mounting route',async()=>{
 for(const url of ['chrome-extension://other/src/dashboard/dashboard.html','chrome-extension://test/src/popup/popup.html']){
  const f=fixture();await openFloatingPanel({id:7,url});
  assert.deepEqual(f.calls,[['popup','src/popup/popup.html'],['native'],['popup','']]);
 }
});

test('a workspace which cannot mount still falls back cleanly',async()=>{
 const f=fixture();chrome.runtime.sendMessage=async()=>({status:'unavailable'});
 await openFloatingPanel({id:7,url:'chrome-extension://test/src/dashboard/dashboard.html'});
 assert.equal(f.data.karlx_panel_7,undefined);
 assert.deepEqual(f.calls,[['popup','src/popup/popup.html'],['native'],['popup','']]);
});
test('restricted pages keep native popup behavior and reset the next toolbar click',async()=>{
 const f=fixture();await openFloatingPanel({id:7,url:'chrome://extensions/'});
 assert.deepEqual(f.calls,[['popup','src/popup/popup.html'],['native'],['popup','']]);
});

test('restricted pages use a larger detached panel with an inset and keep source-window scope',async()=>{
 const f=fixture();
 chrome.windows={get:async id=>id===91?{id:91,type:'popup',tabs:[{url:'chrome-extension://test/src/popup/popup.html?detached=true'}]}:({id:42,left:100,top:20,width:1400,height:900}),create:async options=>{f.calls.push(['window',options]);return{id:91};},remove:async id=>f.calls.push(['close-window',id])};
 await openFloatingPanel({id:7,windowId:42,url:'brave://newtab/'});
 assert.equal(f.calls.length,1);const options=f.calls[0][1];
 assert.equal(options.type,'popup');assert.equal(options.width,440);assert.equal(options.height,650);
 assert.equal(options.left,1012);assert.equal(options.top,148);
 assert.equal(new URL(options.url).searchParams.get('sourceWindow'),'42');
 await openFloatingPanel({id:7,windowId:42,url:'brave://newtab/'});
 assert.deepEqual(f.calls.at(-1),['close-window',91]);
 delete chrome.windows;
});

test('stale detached-window IDs cannot close an unrelated browser window',async()=>{
 const f=fixture();f.data.karlx_detached_panel={id:91};
 chrome.windows={get:async id=>({id,type:'normal',left:0,top:0,width:1400,height:900,tabs:[{url:'https://example.com/'}]}),create:async options=>{f.calls.push(['window',options]);return{id:92};},remove:async id=>f.calls.push(['close-window',id])};
 await openFloatingPanel({id:7,windowId:42,url:'brave://newtab/'});
 assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'window');assert.equal(f.data.karlx_detached_panel.id,92);
 delete chrome.windows;
});
test('native fallback targets the browser window where the user clicked',async()=>{
 const f=fixture();await openFloatingPanel({id:7,windowId:42,url:'chrome://extensions/'});
 assert.deepEqual(f.calls,[['popup','src/popup/popup.html'],['native',42],['popup','']]);
});
test('injection and frame-load failures both clean up the token and open the fallback',async()=>{
 for(const result of ['throw','unavailable']){const f=fixture(result);await openFloatingPanel({id:7,url:'https://example.com'});assert.equal(f.data.karlx_panel_7,undefined);assert.deepEqual(f.calls.slice(-3),[['popup','src/popup/popup.html'],['native'],['popup','']]);}
});
test('only the correct extension frame in the matching tab can initialize the controls',async()=>{
 const f=fixture();await openFloatingPanel({id:7,url:'https://example.com'});
 const token=f.data.karlx_panel_7.token;
 const sender={id:'test',tab:{id:7},url:`chrome-extension://test/src/popup/popup.html?panel=${token}`};
 assert.equal(await authorizeFloatingPanel(token,sender),true);
 assert.equal(await authorizeFloatingPanel('wrong',sender),false);
 assert.equal(await authorizeFloatingPanel(token,{...sender,tab:{id:8}}),false);
 assert.equal(await authorizeFloatingPanel(token,{...sender,id:'other'}),false);
 assert.equal(await authorizeFloatingPanel(token,{...sender,url:'https://example.com'}),false);
 f.data.karlx_panel_7.createdAt=Date.now()-13*3600000;
 assert.equal(await authorizeFloatingPanel(token,sender),false);
});

test('tab switching closes the old floating panel, retaining panels in other browser windows',async()=>{
 const f=fixture();
 f.data.karlx_panel_7={token:'old'};f.data.karlx_panel_8={token:'current'};f.data.karlx_panel_9={token:'other-window'};
 chrome.storage.session.get=async key=>key===null?{...f.data}:{[key]:f.data[key]};
 chrome.tabs={get:async id=>({id,windowId:id===9?2:1,url:'https://example.com',discarded:false})};
 await closeInactivePanels(8,1);
 assert.equal(f.calls.filter(call=>call[0]==='inject').length,1);
 assert.equal(f.calls[0][1].target.tabId,7);
 assert.equal(f.data.karlx_panel_7,undefined);
 assert.ok(f.data.karlx_panel_8&&f.data.karlx_panel_9);
});

test('switching away from a dashboard panel uses its close message, never script injection',async()=>{
 const f=fixture();f.data.karlx_panel_7={token:'dashboard'};
 chrome.storage.session.get=async()=>({...f.data});
 chrome.tabs={get:async()=>({id:7,windowId:1,url:'chrome-extension://test/src/dashboard/dashboard.html'})};
 chrome.runtime.sendMessage=async message=>{f.calls.push(['message',message]);return{closed:true};};
 await closeInactivePanels(8,1);
 assert.deepEqual(f.calls,[['message',{type:'CLOSE_WORKSPACE_PANEL',tabId:7}]]);
 assert.equal(f.data.karlx_panel_7,undefined);
});

test('discarded tabs are not woken merely to close a panel that no longer exists',async()=>{
 const f=fixture();f.data.karlx_panel_7={token:'old'};
 chrome.storage.session.get=async()=>({...f.data});
 chrome.tabs={get:async()=>({id:7,windowId:1,url:'https://example.com',discarded:true})};
 await closeInactivePanels(8,1);
 assert.deepEqual(f.calls,[]);assert.equal(f.data.karlx_panel_7,undefined);
});
