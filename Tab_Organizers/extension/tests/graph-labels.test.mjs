import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const source=readFileSync(new URL('../src/lib/graph-labels.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
const {graphLabelView,showGraphLabel,shortGraphLabel,wrapGraphTitle}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
test('saved graph view is validated and new or stale preferences use topic labels',()=>{
 assert.equal(graphLabelView('titles'),'titles');assert.equal(graphLabelView(null),'topics');assert.equal(graphLabelView('retired'),'topics');
});
test('resource labels appear only at readable zoom in the chosen detailed views',()=>{
 for(const mode of ['short','titles']){assert.equal(showGraphLabel(mode,true,.6,false),false);assert.equal(showGraphLabel(mode,true,1,false),true);}
 assert.equal(showGraphLabel('topics',true,3,false),false);assert.equal(showGraphLabel('minimal',false,3,false),false);
 assert.equal(showGraphLabel('minimal',true,.3,true),true);
});
test('short labels keep descriptive words, while title wrapping preserves the text',()=>{
 assert.equal(shortGraphLabel('How to build motion graphics with After Effects - YouTube'),'build motion graphics After Effects');
 const title='Building a wireless GPU for AI agents using spare phones and local inference';
 assert.equal(wrapGraphTitle(title).join(' '),title);assert.ok(wrapGraphTitle(title).length>1);
});
