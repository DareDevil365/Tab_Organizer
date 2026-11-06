import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const source=readFileSync(new URL('../src/lib/cover-palette.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020}}).outputText;
const {coverInk}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const rgb=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255);
const luminance=values=>values.map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
test('small notebook labels remain readable on every ink, including the sheen',()=>{
 const subjects=['Artificial intelligence','Programming','Entertainment & Video','Hackathons','Academics & Science','Typography'];
 const names=new Set();
 for(const subject of subjects){const ink=coverInk(subject);names.add(ink.name);
  for(const color of [ink.from,ink.to]){const background=rgb(color).map(v=>v*.98+.02);const contrast=(luminance(rgb('#faf3e4'))+.05)/(luminance(background)+.05);assert.ok(contrast>=4.5,`${ink.name} contrast ${contrast}`);}
 }
 assert.equal(names.size,6);
});
test('a subject retains its ink between cards and after reload',()=>{
 assert.deepEqual(coverInk('Neural networks'),coverInk('Artificial Intelligence'));
 assert.deepEqual(coverInk('A custom research topic'),coverInk('a custom research topic'));
});
