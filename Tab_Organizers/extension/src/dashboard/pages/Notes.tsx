import { useEffect,useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { cacheForBackend,onDeviceSync,pendingSaves } from '../../lib/outbox';
import { parseNote } from '../../lib/note-data';
import { CompanionNote,PageData } from '../../types';
import { normalizeUrl } from '../../lib/url-normalize';
export function Notes({pages,query,onOpen}:{pages:PageData[];query:string;onOpen:(pageId:number,noteId:string)=>void}){
  const [notes,setNotes]=useState<CompanionNote[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  useEffect(()=>{let active=true;
    const update=async()=>{
      let remote=await cacheForBackend<any[]>('notes')||[];
      const apply=async()=>{
        const merged=new Map(remote.map(note=>[note.id,parseNote(note)]));
        for(const job of await pendingSaves()){
          if(job.kind==='note')merged.set(job.payload.id,{...parseNote(job.payload),pendingSync:true});
          if(job.kind==='remove-note')merged.delete(job.payload.id);
          if(job.kind==='remove-page')for(const [id,note]of merged)if(normalizeUrl(note.videoUrl)===normalizeUrl(job.payload.url))merged.delete(id);
        }
        if(active){setNotes([...merged.values()].sort((a,b)=>b.createdAt-a.createdAt));setLoading(false);}
      };await apply();
      try{const all:any[]=[];for(let offset=0;;offset+=1000){const batch=await apiClient.get<any[]>(`/api/companion?limit=1000&offset=${offset}`);all.push(...batch);if(batch.length<1000)break;}remote=all;await cacheForBackend('notes',remote);if(active)setError('');await apply();}
      catch{if(active)setError('Showing notes saved on this device. Updates will appear when connected.');}
    };void update();const off=onDeviceSync(()=>void update());return()=>{active=false;off();};
  },[]);
  const results=notes.filter(note=>(note.comment+' '+note.videoTitle).toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="notes-workspace">{error&&<p role="status">{error}</p>}{loading&&<p role="status">Loading your notes…</p>}
    {!loading&&!results.length&&<div className="empty-state"><h2>{query?'No notes match':'Your notes, in context'}</h2><p>{query?'Try a different phrase.':'Add a note from the popup or a saved resource.'}</p></div>}
    <div className="notes-grid">{results.map(note=>{const page=pages.find(page=>page.id===note.pageId)||pages.find(page=>normalizeUrl(page.url_original)===normalizeUrl(note.videoUrl));return <article className="tool-panel note-preview" key={note.id}>
      <div className="note-preview-head"><span>{note.timestampFormatted}</span><time>{new Date(note.createdAt).toLocaleDateString()}</time></div>
      <p className="note-excerpt">{note.comment}</p>{!!note.attachments?.length&&<small>{note.attachments.length} attachment{note.attachments.length===1?'':'s'}</small>}
      {note.pendingSync&&<small className="pending-label">Saved on device · Pending upload</small>}
      <button className="note-source" disabled={!page?.id||page.id<0} onClick={()=>onOpen(page!.id!,note.id)}>{note.videoTitle} <span>↗ Open note</span></button>
    </article>;})}</div>
  </div>;
}
