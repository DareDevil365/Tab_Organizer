import React, { useEffect, useId, useRef, useState } from 'react';
import { pageTopics } from '../../lib/page-filters';
import { coverInk } from '../../lib/cover-palette';
import { suggestResources } from '../../lib/search-suggestions';
import type { PageData } from '../../types';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onTopic: (topic: string) => void;
  topic: string;
  pages: PageData[];
  enabled: boolean;
  inputRef: React.RefObject<HTMLInputElement>;
}

export function ResourceSearch({value,onChange,onTopic,topic,pages,enabled,inputRef}: Props) {
  const [open,setOpen]=useState(false),[active,setActive]=useState(-1);
  const root=useRef<HTMLDivElement>(null);
  const choosing=useRef(false);
  const listId=useId();
  const counts=new Map<string,{topic:string;count:number}>();
  pages.forEach(page=>pageTopics(page).forEach(label=>{
    const key=label.toLocaleLowerCase();
    const item=counts.get(key)||{topic:label,count:0};item.count++;counts.set(key,item);
  }));
  const query=value.trim().toLocaleLowerCase();
  const topics=[...counts.values()]
    .sort((a,b)=>b.count-a.count||a.topic.localeCompare(b.topic));
  const suggestions=suggestResources(pages.filter(page=>!topic||pageTopics(page).some(label=>label.toLowerCase()===topic.toLowerCase())),query);
  const options=query?suggestions.map(page=>({label:page.title||'Saved resource',count:0,page})):topics.map(item=>({label:item.topic,count:item.count,page:null}));
  useEffect(()=>{setActive(-1);},[value,open]);
  useEffect(()=>{
    if(!enabled)setOpen(false);
    else if(document.activeElement===inputRef.current)setOpen(true);
  },[enabled]);
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    document.addEventListener('pointerdown',outside);
    return()=>document.removeEventListener('pointerdown',outside);
  },[]);
  useEffect(()=>{
    if(active>=0)document.getElementById(`${listId}-${active}`)?.scrollIntoView({block:'nearest'});
  },[active,listId]);
  const choose=(label:string)=>{onTopic(label);onChange('');setOpen(false);setActive(-1);choosing.current=true;inputRef.current?.focus();choosing.current=false;};
  const chooseSuggestion=(title:string)=>{onChange(title);setOpen(false);setActive(-1);choosing.current=true;inputRef.current?.focus();choosing.current=false;};
  const showing=enabled&&open;
  return <div className="resource-search" ref={root} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setOpen(false);}}>
    <label className="search-wrap workspace-search">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>
      <input ref={inputRef} className="search-bar" id="search" placeholder="Find something you saved…" aria-label="Search your resources" value={value}
        role="combobox" aria-autocomplete="list" aria-expanded={showing} aria-controls={showing?listId:undefined}
        aria-activedescendant={showing&&active>=0?`${listId}-${active}`:undefined} autoComplete="off"
        onFocus={()=>{if(enabled&&!choosing.current)setOpen(true);}} onChange={event=>{onChange(event.target.value);if(enabled)setOpen(true);}}
        onKeyDown={event=>{
          if(event.key==='Escape'){setOpen(false);setActive(-1);return;}
          if(event.key==='ArrowDown'||event.key==='ArrowUp'){
            if(!enabled||!options.length)return;
            event.preventDefault();setOpen(true);setActive(previous=>event.key==='ArrowDown'?Math.min(options.length-1,previous+1):Math.max(0,previous<0?options.length-1:previous-1));
          }
          if(event.key==='Enter'){
            if(showing&&active>=0&&options[active]){event.preventDefault();if(query)chooseSuggestion(options[active].label);else choose(options[active].label);}
            else setOpen(false); // Free text remains ordinary semantic search.
          }
        }}/><kbd>/</kbd>
    </label>
    {showing&&<div className={`resource-search-menu ${query?'resource-suggestions':'resource-categories'}`}>
      {topic&&<button type="button" className="resource-search-clear" aria-label="Clear category" onMouseDown={event=>event.preventDefault()} onClick={()=>choose('')}>{topic} ×</button>}
      <div id={listId} role="listbox" aria-label={query?'Suggested searches':'Resource categories'} className={`resource-search-options ${query?'':'resource-category-keys'}`}>
        {options.map((item,index)=>{
          const ink=coverInk(item.label);
          return <button type="button" tabIndex={-1} role="option" aria-selected={!query&&item.label===topic} id={`${listId}-${index}`} key={item.page?.id??item.label}
            style={!query?{'--key-from':ink.from,'--key-to':ink.to,'--key-ink':ink.dot} as React.CSSProperties:undefined}
            className={index===active?'keyboard-active':''} onMouseDown={event=>event.preventDefault()} onClick={()=>query?chooseSuggestion(item.label):choose(item.label)}>
            <span>{item.label}</span>{!query&&<small>{item.count}</small>}
          </button>;
        })}
        {!options.length&&<p>{query?'No saved title suggestions.':'No categories yet.'}</p>}
      </div>
    </div>}
  </div>;
}
