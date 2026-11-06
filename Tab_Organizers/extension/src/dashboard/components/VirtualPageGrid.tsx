import { useEffect, useMemo, useRef, useState } from 'react';
import { PageData } from '../../types';
interface Props {pages:PageData[];grouped:boolean;render:(page:PageData)=>React.ReactNode}
export function VirtualPageGrid({pages,grouped,render}:Props){
  const host=useRef<HTMLDivElement>(null),[width,setWidth]=useState(1000),[viewport,setViewport]=useState({top:0,bottom:1000});
  const columns=Math.max(1,Math.floor((width+24)/264)),cardHeight=Math.ceil((width-24*(columns-1))/columns*10/16)+118;
  const rows=useMemo(()=>{
    const groups=new Map<string,PageData[]>();
    pages.forEach(page=>{const key=grouped?(page.display_topic||page.topic||'Other saves'):'';if(!groups.has(key))groups.set(key,[]);groups.get(key)!.push(page);});
    const result:{key:string;top:number;height:number;title?:string;pages?:PageData[]}[]=[];let top=0;
    for(const [title,items]of groups){
      if(grouped){result.push({key:'heading:'+title,top,height:48,title});top+=48;}
      for(let index=0;index<items.length;index+=columns){result.push({key:title+':'+index,top,height:cardHeight+24,pages:items.slice(index,index+columns)});top+=cardHeight+24;}
    }
    return {items:result,height:top};
  },[pages,grouped,columns,cardHeight]);
  useEffect(()=>{
    const element=host.current;if(!element)return;let frame=0;
    const update=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{const bounds=element.getBoundingClientRect();setWidth(bounds.width);const top=-bounds.top;setViewport(previous=>Math.abs(previous.top-top)<3&&previous.bottom-top===innerHeight?previous:{top,bottom:top+innerHeight});});};
    const observer=new ResizeObserver(update);observer.observe(element);window.addEventListener('scroll',update,{passive:true});window.addEventListener('resize',update);update();
    return()=>{cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('scroll',update);window.removeEventListener('resize',update);};
  },[]);
  const buffer=cardHeight*2;
  return <div ref={host} className="virtual-library-grid" style={{height:rows.height,position:'relative'}} aria-label={`${pages.length} saved resources`}>
    {rows.items.filter(row=>row.top+row.height>=viewport.top-buffer&&row.top<=viewport.bottom+buffer).map(row=><div key={row.key} style={{position:'absolute',top:row.top,left:0,right:0,height:row.height-24}}>
      {row.title?<h2 className="library-group-title">{row.title}</h2>:<div className="virtual-card-row" style={{display:'grid',gridTemplateColumns:`repeat(${columns},minmax(0,1fr))`,gap:24,height:'100%'}}>{row.pages!.map(render)}</div>}
    </div>)}
  </div>;
}
