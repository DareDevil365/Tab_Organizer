import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const source=readFileSync(new URL('../src/lib/page-filters.ts',import.meta.url),'utf8');
const javascript=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {applyLibraryFilters,emptyFilters,pageTopics}=await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
test('topic, website, notes, completion and priority intersect without dropping earlier choices',()=>{
  const pages=[{id:1,domain:'youtube.com',subject_topics:['AI'],note_count:2,is_important:true},
    {id:2,domain:'youtube.com',subject_topics:['AI'],note_count:0,is_important:true},
    {id:3,domain:'other.test',subject_topics:['AI'],note_count:2,is_important:true},
    {id:4,domain:'youtube.com',subject_topics:['AI'],note_count:2,is_important:true,completed_at:'2026-11-05'}];
  const filters={...emptyFilters,topic:'AI',domain:'youtube.com',hasNotes:true,important:true,status:'unseen'};
  assert.deepEqual(applyLibraryFilters(pages,filters).map(page=>page.id),[1]);
  assert.deepEqual(applyLibraryFilters(pages,{...filters,status:'completed'}).map(page=>page.id),[4]);
  assert.equal(applyLibraryFilters(pages,emptyFilters).length,4);
  assert.equal(filters.hasNotes,true);
});

test('new generated categories preserve older saved categories and deduplicate their counts',()=>{
 const page={topic:'Academics & Science',display_topic:'Mathematics',subject_topics:['Learning','Mathematics',' mathematics ','youtube.com','Other']};
 assert.deepEqual(pageTopics(page),['Learning','Mathematics','Academics & Science']);
 assert.equal(applyLibraryFilters([page],{...emptyFilters,topic:'Academics & Science'}).length,1);
 assert.equal(applyLibraryFilters([page],{...emptyFilters,topic:'Mathematics'}).length,1);
});
