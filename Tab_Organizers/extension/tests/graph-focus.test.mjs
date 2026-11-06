import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/graph-focus.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { branchFocus } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
const nodes = [
  { id: 'root' },
  { id: 'development', parent_id: 'root' },
  { id: 'practice', parent_id: 'development' },
  { id: 'project', parent_id: 'practice' },
  { id: 'resource', parent_id: 'project' },
  { id: 'foundations', parent_id: 'development' },
  { id: 'design', parent_id: 'root' },
  { id: 'typography', parent_id: 'design' },
];
const focused = (selection, fixture = nodes) => [...branchFocus(fixture, selection)].sort();

test('selected parent retains every descendant across all nested levels', () => {
  assert.deepEqual(focused('development'), ['development', 'foundations', 'practice', 'project', 'resource', 'root']);
});
test('selected child includes ancestors without expanding siblings or cousin branches', () => {
  assert.deepEqual(focused('practice'), ['development', 'practice', 'project', 'resource', 'root']);
});
test('leaf selection shows only its ancestry', () => {
  assert.deepEqual(focused('resource'), ['development', 'practice', 'project', 'resource', 'root']);
});
test('empty or missing selection removes focus', () => {
  assert.equal(branchFocus(nodes, null), null);
  assert.equal(branchFocus(nodes, 'deleted'), null);
});
test('malformed ancestry cycles terminate while keeping reachable descendants', () => {
  assert.deepEqual(focused('a', [{ id: 'a', parent_id: 'b' }, { id: 'b', parent_id: 'a' }, { id: 'c', parent_id: 'b' }]), ['a', 'b', 'c']);
});

test('a shared resource highlights all its topics and their ancestors without cousins', () => {
 const graph=[...nodes,{id:'shared',parent_id:'practice',parent_ids:['practice','typography']},{id:'unrelated-design',parent_id:'design'}];
 assert.deepEqual(focused('shared',graph),['design','development','practice','root','shared','typography']);
 assert.deepEqual(focused('practice',graph),['design','development','practice','project','resource','root','shared','typography']);
});
