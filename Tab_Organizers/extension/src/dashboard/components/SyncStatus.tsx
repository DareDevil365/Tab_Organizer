import { useEffect, useState } from 'react';
import { cacheForBackend,flushSaves, onDeviceSync, pendingSaves, PendingSave } from '../../lib/outbox';
import { apiClient } from '../../lib/api-client';
export function SyncStatus() {
  const [jobs,setJobs] = useState<PendingSave[]>([]);
  const [recent,setRecent]=useState<{id:string;at:number}|null>(),[undoBusy,setUndoBusy]=useState(false),[error,setError]=useState('');
  useEffect(() => { const update=()=>{void pendingSaves().then(setJobs);void cacheForBackend<{id:string;at:number}>('recent-removal').then(setRecent);};update();return onDeviceSync(update); },[]);
  const undo=async()=>{if(!recent)return;setUndoBusy(true);try{await apiClient.post(`/api/recycle-bin/${recent.id}/restore`,{});await cacheForBackend('recent-removal',null);setRecent(null);window.dispatchEvent(new Event('device-sync-changed'));window.dispatchEvent(new Event('resources-restored'));}catch{setError('Could not restore yet. Retry when connected, or open Removed items.');}finally{setUndoBusy(false);}};
  if (!jobs.length) return recent&&Date.now()-recent.at<600000?<div className="sync-status" role="status"><span>Moved to the five-day recycle bin.</span><button className="pill" disabled={undoBusy} onClick={()=>void undo()}>{undoBusy?'Restoring…':'Undo removal'}</button>{error&&<span>{error}</span>}</div>:null;
  const blocked=jobs.some(job=>job.blocked);
  return <div className="sync-status" role="status"><span>{blocked ? 'Some saves need attention. Your copies are safe on this device.' : `${jobs.length} pending change${jobs.length===1?'':'s'} saved on this device. Uploading when connected…`}</span><button className="pill" onClick={()=>void flushSaves(true)}>Retry upload</button><details><summary>Details</summary>{jobs.map(job=><p key={job.key}>{job.payload.title || job.payload.video_title || job.payload.name || 'Saved page'}{job.error ? ` · ${job.error}` : ' · Pending upload'}</p>)}</details></div>;
}
