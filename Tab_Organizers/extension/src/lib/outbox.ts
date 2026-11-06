import { getBackendConnection } from './backend-connection';
import type { BackendConnection } from './backend-connection';
import { deviceChange, deviceEntries, deviceSet, deviceGet } from './device-store';
import { normalizeUrl } from './url-normalize';

export type SaveKind = 'page' | 'note' | 'group' | 'remove-page' | 'remove-note';
export interface PendingSave {
  key: string; backend: string; kind: SaveKind; payload: any; version: string;
  createdAt: number; attempts: number; retryAt: number; leaseUntil: number;
  blocked?: boolean; error?: string;
}
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('karl-sync') : null;
let changeTimer:ReturnType<typeof setTimeout>|undefined;
function changed() {
  if(changeTimer)return;
  changeTimer=setTimeout(()=>{changeTimer=undefined;channel?.postMessage('changed');if(typeof window!=='undefined')window.dispatchEvent(new Event('device-sync-changed'));},80);
}
export function onDeviceSync(callback: () => void) {
  const listener = () => callback(); channel?.addEventListener('message', listener);
  if (typeof window !== 'undefined') window.addEventListener('device-sync-changed', listener);
  return () => { channel?.removeEventListener('message', listener); if (typeof window !== 'undefined') window.removeEventListener('device-sync-changed', listener); };
}
export async function pendingSaves() {
  const connection = await getBackendConnection();
  return (await deviceEntries<PendingSave>('outbox')).map(row => row.value).filter(job => job.backend === connection.url).sort((a,b) => a.createdAt-b.createdAt);
}
export async function saveOnDevice(kind: SaveKind, payload: any): Promise<PendingSave> {
  const connection = await getBackendConnection();
  if(kind==='page'||kind==='note'){
    const address=new URL(kind==='note'?payload.video_url:payload.url_original);
    if(!['http:','https:'].includes(address.protocol))throw new Error('Save a web page with an HTTP or HTTPS address.');
  }
  const identity = kind === 'note' || kind === 'remove-note' ? payload.id : kind === 'group' ? (payload.client_id ||= crypto.randomUUID()) : normalizeUrl(payload.url_original || payload.url);
  if (!identity) throw new Error('This page has no saveable address');
  const key = JSON.stringify([connection.url, kind === 'remove-page' ? 'page' : kind === 'remove-note' ? 'note' : kind, identity]);
  const job = { key, backend: connection.url, kind, payload, version: crypto.randomUUID(), createdAt: Date.now(), attempts: 0, retryAt: 0, leaseUntil: 0 };
  // Acknowledge only after the write transaction commits. A failed/quota-limited
  // write throws: the caller must retain the user's input and show the error.
  await deviceChange<PendingSave>('outbox',key,current=>({...job,leaseUntil:current?.leaseUntil||0})); changed();
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) void chrome.runtime.sendMessage({ type: 'FLUSH_SAVE_OUTBOX' }).catch(() => {});
  void flushSaves(); return job;
}
export async function savePagesOnDevice(tabs: any[]) {
  for (const tab of tabs) await saveOnDevice('page', tab);
}
export async function cacheForBackend<T>(name: string, value?: T): Promise<T | undefined> {
  const { url } = await getBackendConnection(), key = JSON.stringify([url,name]);
  if (value !== undefined) await deviceSet('cache', key, value);
  return deviceGet<T>('cache', key);
}
let flushing: Promise<void> | undefined;
export function flushSaves(force = false): Promise<void> {
  return flushing ??= runFlush(force).finally(() => {
    flushing = undefined;
    void pendingSaves().then(jobs=>{
      if(jobs.some(job=>!job.blocked&&job.retryAt<=Date.now()&&job.leaseUntil<=Date.now()))setTimeout(()=>void flushSaves(),1000);
    }).catch(()=>{});
  });
}

export async function removeSavedUrl(url: string) {
  for(const job of await pendingSaves())if(job.kind==='note'&&normalizeUrl(job.payload.video_url)===normalizeUrl(url))await saveOnDevice('remove-note',{id:job.payload.id});
  await saveOnDevice('remove-page',{url});
}
async function runFlush(force: boolean) {
  const connection = await getBackendConnection();
  const lockKey=JSON.stringify([connection.url,'sync-lease']),token=crypto.randomUUID();let acquired=false;
  await deviceChange<{token:string;until:number}>('cache',lockKey,current=>{
    if(current&&current.until>Date.now())return current;
    acquired=true;return {token,until:Date.now()+45000};
  });
  if(!acquired)return;
  try{await flushOwned(connection,force,async()=>{
    let owned=false;await deviceChange<{token:string;until:number}>('cache',lockKey,current=>{
      if(current?.token!==token)return current;owned=true;return {token,until:Date.now()+45000};
    });return owned;
  });}finally{await deviceChange<{token:string;until:number}>('cache',lockKey,current=>current?.token===token?undefined:current);}
}
async function flushOwned(connection:BackendConnection,force:boolean,renew:()=>Promise<boolean>){
  const candidates=(await pendingSaves()).slice(0,25),processed=new Set<string>();
  for(const candidate of candidates){
    if(!await renew())return;
    if(processed.has(candidate.key))continue;
    const batch=candidate.kind==='page'?candidates.filter(item=>item.kind==='page'&&!processed.has(item.key)):[candidate];
    const claimed:PendingSave[]=[];
    for(const item of batch){
      processed.add(item.key);let acquired=false;const now=Date.now();
      const job=await deviceChange<PendingSave>('outbox',item.key,current=>{
        if(!current||current.kind!==candidate.kind||current.leaseUntil>now||(!force&&(current.blocked||current.retryAt>now)))return current;
        acquired=true;return {...current,leaseUntil:now+45000};
      });if(acquired&&job)claimed.push(job);
    }
    if(!claimed.length)continue;
    if((await getBackendConnection()).url!==connection.url){
      for(const job of claimed)await deviceChange<PendingSave>('outbox',job.key,current=>current?{...current,leaseUntil:0}:undefined);return;
    }
    const job=claimed[0],removing=job.kind.startsWith('remove-');
    const endpoint=job.kind==='page'?'/api/pages/save-bulk':job.kind==='note'?'/api/companion':job.kind==='group'?'/api/groups':job.kind==='remove-note'?'/api/companion/'+encodeURIComponent(job.payload.id):'/api/pages/by-url?url='+encodeURIComponent(job.payload.url);
    try{
      const response=await fetch(connection.url+endpoint,{method:removing?'DELETE':'POST',headers:{'Content-Type':'application/json',...(connection.key?{Authorization:'Bearer '+connection.key}:{})},
        body:removing?undefined:JSON.stringify(job.kind==='page'?{tabs:claimed.map(item=>item.payload)}:job.payload),signal:AbortSignal.timeout(20000)});
      if(!response.ok&&!(removing&&response.status===404)){
        const blocked=response.status>=400&&response.status<500&&![408,429].includes(response.status),body=await response.json().catch(()=>null);
        throw Object.assign(new Error(typeof body?.detail==='string'?body.detail:`Server returned ${response.status}`),{blocked});
      }
      const body=response.status===204?null:await response.json().catch(()=>null);
      const mutateCache=(name:string,update:(rows:any[])=>any[])=>deviceChange<any[]>('cache',JSON.stringify([job.backend,name]),current=>update(current||[]));
      const upsert=(rows:any[],items:any[],key:(item:any)=>any)=>{
        const result=[...rows];for(const item of items){const index=result.findIndex(old=>key(old)===key(item));if(index<0)result.unshift(item);else result[index]={...result[index],...item};}return result;
      };
      if(job.kind==='page'){
        if(!Array.isArray(body?.saved_pages)||body.saved_pages.length!==claimed.length)throw new Error('The server did not confirm every saved page. Device copies are retained.');
        await mutateCache('library',rows=>upsert(rows,body.saved_pages,(item:any)=>item.id));
        await mutateCache('saved-status',rows=>upsert(rows,body.saved_pages.map((page:any)=>({url_original:page.url_original,url_normalized:page.url_normalized})),(item:any)=>item.url_normalized));
      }
      if(job.kind==='group'){
        if(!body?.id)throw new Error('The server did not confirm the collection. Device copy is retained.');
        await mutateCache('groups',rows=>upsert(rows,[body],(item:any)=>item.id));
      }
      if(job.kind==='note'){
        if(body?.id!==job.payload.id||!body.page_id)throw new Error('The server did not confirm the note. Device copy is retained.');
        await mutateCache('notes',rows=>upsert(rows,[body],(item:any)=>item.id));
        await mutateCache('library',rows=>rows.some(page=>page.id===body.page_id)?rows.map(page=>page.id===body.page_id?{...page,...(body.page_note_count!==undefined?{note_count:body.page_note_count}:{})}:page):[{id:body.page_id,url_original:body.video_url,url_normalized:normalizeUrl(body.video_url),title:body.video_title,description:'',favicon_url:'',note_count:body.page_note_count||1,domain:new URL(body.video_url).hostname},...rows]);
        await mutateCache('saved-status',rows=>upsert(rows,[{url_original:body.video_url,url_normalized:normalizeUrl(body.video_url)}],(item:any)=>item.url_normalized));
      }
      if(job.kind==='remove-note')await mutateCache('notes',rows=>rows.filter(note=>note.id!==job.payload.id));
      if(job.kind==='remove-page'&&response.ok){
        const id=body?.recycle_id||response.headers.get('X-Recycle-Id');
        if(id)await deviceSet('cache',JSON.stringify([job.backend,'recent-removal']),{id,url:job.payload.url,at:Date.now()});
        await mutateCache('notes',rows=>rows.filter(note=>normalizeUrl(note.video_url)!==normalizeUrl(job.payload.url)));
        await mutateCache('library',rows=>rows.filter(page=>normalizeUrl(page.url_original)!==normalizeUrl(job.payload.url)));
        await mutateCache('saved-status',rows=>rows.filter(page=>normalizeUrl(page.url_original)!==normalizeUrl(job.payload.url)));
      }
      for(const item of claimed)await deviceChange<PendingSave>('outbox',item.key,current=>current?.version===item.version?undefined:current?{...current,leaseUntil:0}:undefined);
    }catch(error){
      for(const item of claimed)await deviceChange<PendingSave>('outbox',item.key,current=>current?.version===item.version?{...current,leaseUntil:0,attempts:current.attempts+1,retryAt:Date.now()+Math.min(300000,15000*2**Math.min(current.attempts,5)),blocked:!!(error as {blocked?:boolean}).blocked,error:error instanceof Error?error.message:'Connection unavailable'}:current);
      changed();return;
    }
    changed();
  }

}
export function startSaveSync() {
  void flushSaves();
  const online = () => { void flushSaves(true); };
  if (typeof window !== 'undefined') {
    window.addEventListener('online',online); window.addEventListener('backend-connection-changed',online);
    const timer = setInterval(() => { void flushSaves(); },30000);
    return () => { clearInterval(timer); window.removeEventListener('online',online); window.removeEventListener('backend-connection-changed',online); };
  }
  return () => {};
}
