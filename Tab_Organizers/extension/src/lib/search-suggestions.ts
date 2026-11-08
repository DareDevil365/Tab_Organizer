import type { PageData } from '../types';

const words=(text:string)=>text.normalize('NFKD').toLowerCase().replace(/(.)\1+/g,'$1').match(/[\p{L}\p{N}]+/gu)||[];
function closeWord(left:string,right:string):boolean {
  if(Math.abs(left.length-right.length)>2||left.length<4)return false;
  if(left.length===right.length){
    const different=Array.from(left).map((_,index)=>index).filter(index=>left[index]!==right[index]);
    if(different.length===2&&different[1]===different[0]+1&&left[different[0]]===right[different[1]]&&left[different[1]]===right[different[0]])return true;
  }
  let previous=Array.from({length:right.length+1},(_,index)=>index);
  for(let i=1;i<=left.length;i++){
    const row=[i];
    for(let j=1;j<=right.length;j++)row[j]=Math.min(row[j-1]+1,previous[j]+1,previous[j-1]+(left[i-1]===right[j-1]?0:1));
    if(Math.min(...row)>2)return false;
    previous=row;
  }
  return previous[right.length]<= (left.length<6?1:2);
}

/** Suggestions use real saved titles and tolerate partial words/repeated keys. */
export function suggestResources<T extends PageData>(pages:T[],query:string,limit=8):T[]{
  const tokens=words(query).slice(0,6).map(word=>word.slice(0,48));
  if(!tokens.length)return [];
  return pages.map((page,index)=>{
    const title=words(page.title||'').slice(0,35);
    let score=0,matched=0;
    for(const token of tokens){
      const weight=title.some(word=>word===token)?5:title.some(word=>word.startsWith(token))?4:title.some(word=>closeWord(token,word))?2:0;
      if(weight)matched++;score+=weight;
    }
    return {page,index,score:matched===tokens.length?score:0};
  }).filter(item=>item.score>0).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,limit).map(item=>item.page);
}
