import { useEffect, useState } from 'react';
import { connectBackend, getBackendConnection, LOCAL_BACKEND, useLocalBackend } from '../../lib/backend-connection';

export function BackendConnectionPanel(){
  const [url,setUrl]=useState(LOCAL_BACKEND),[key,setKey]=useState(''),[current,setCurrent]=useState(LOCAL_BACKEND);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  useEffect(()=>{getBackendConnection().then(value=>{setUrl(value.url);setCurrent(value.url);}).catch(()=>setMessage('Update the saved backend address.'));},[]);
  async function connect(event:React.FormEvent){
    event.preventDefault();setBusy(true);setMessage('');
    try{await connectBackend(url,key);setKey('');location.reload();}
    catch(error){setMessage(error instanceof Error?error.message:'Could not connect.');}
    finally{setBusy(false);}
  }
  return <section className="tool-panel" aria-labelledby="backend-connection-title">
    <div className="tool-section-head"><div><h2 id="backend-connection-title">Backend connection</h2><p>{current===LOCAL_BACKEND?'Using this computer.':'Using your private cloud backend.'} Connect once; your popup and browser tracking use the same connection.</p></div></div>
    <form className="tool-edit-form" onSubmit={connect}>
      <div className="tool-form-grid">
        <label className="tool-field">Backend URL<input type="url" value={url} onChange={event=>setUrl(event.target.value)} required placeholder="https://your-project.vercel.app"/></label>
        <label className="tool-field">Private connection key<input type="password" autoComplete="off" value={key} onChange={event=>setKey(event.target.value)} placeholder="Paste the key from cloud setup"/><small>Saved only in your extension. Cloudflare, Gemini and database secrets stay on the backend.</small></label>
      </div>
      {message&&<p role="alert">{message}</p>}
      <div className="tool-form-actions"><button type="button" className="tool-button" disabled={busy} onClick={async()=>{await useLocalBackend();location.reload();}}>Use local backend</button><button className="tool-button tool-primary" disabled={busy}>{busy?'Checking…':'Connect'}</button></div>
    </form>
  </section>;
}
