import { useEffect, useRef, useState } from 'react';
import { getBackendConnection } from '../lib/backend-connection';
import { deviceGet, deviceSet } from '../lib/device-store';
import { NoteAttachment } from '../types';
export function useNoteDraft(resource: string) {
  const [text,setText]=useState(''),[attachments,setAttachments]=useState<NoteAttachment[]>([]),[key,setKey]=useState('');
  const touched=useRef(false);
  useEffect(()=>{let active=true;
    getBackendConnection().then(async connection=>{
      const draftKey=JSON.stringify([connection.url,'note',resource]);
      const saved=await deviceGet<{text:string;attachments:NoteAttachment[]}>('drafts',draftKey);
      if(!active)return;
      if(saved&&!touched.current){setText(saved.text);setAttachments(saved.attachments);}
      setKey(draftKey);
    }).catch(()=>{});
    return()=>{active=false;};
  },[resource]);
  useEffect(()=>{if(key)void deviceSet('drafts',key,{text,attachments}).catch(()=>{});},[key,text,attachments]);
  return {text,attachments,setText:(value:React.SetStateAction<string>)=>{touched.current=true;setText(value);},
    setAttachments:(value:React.SetStateAction<NoteAttachment[]>)=>{touched.current=true;setAttachments(value);}};
}
