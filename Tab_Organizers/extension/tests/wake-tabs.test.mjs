import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/wake-tabs.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const { needsTabWake, TabWakeManager } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
const tab = (id, extra = {}) => ({ id, windowId: 1, url: `https://example.org/${id}`, title: `Page ${id}`, active: false, discarded: true, status: 'complete', ...extra });
function fixture(tabs, timeout = 1000) {
  const rows = new Map(tabs.map(t => [t.id, { ...t }]));
  const updates = new Set(), removals = new Set(), reloaded = [], progress = [];
  let queryCalls = 0;
  const browser = {
    query: async () => { queryCalls++; return [...rows.values()].map(t => ({ ...t })); },
    get: async id => { if (!rows.has(id)) throw Error('Tab closed'); return { ...rows.get(id) }; },
    reload: async id => { reloaded.push(id); rows.get(id).status = 'loading'; },
    onUpdated: { addListener: fn => updates.add(fn), removeListener: fn => updates.delete(fn) },
    onRemoved: { addListener: fn => removals.add(fn), removeListener: fn => removals.delete(fn) },
  };
  return {
    manager: new TabWakeManager(browser, value => progress.push(value), timeout), rows, reloaded, progress, updates, removals,
    get queryCalls() { return queryCalls; },
    complete(id) { const row = rows.get(id); Object.assign(row, { discarded: false, frozen: false, status: 'complete', title: `Real title ${id}` }); for (const fn of [...updates]) fn(id, { status: 'complete' }, { ...row }); },
    close(id) { rows.delete(id); for (const fn of [...removals]) fn(id); },
  };
}
async function until(predicate) {
  for (let i = 0; i < 250; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('Wake job did not reach the expected state');
}

test('recognizes sleeping and generic video tabs, protecting active, playing and restricted pages', () => {
  assert.equal(needsTabWake(tab(1)), true);
  assert.equal(needsTabWake(tab(1, { discarded: false, frozen: true })), true);
  assert.equal(needsTabWake(tab(1, { discarded: false, url: 'https://www.youtube.com/watch?v=example', title: 'www.youtube.com' })), true);
  assert.equal(needsTabWake(tab(1, { discarded: false, url: 'https://www.youtube.com/watch?v=example', title: 'Video editing in DaVinci Resolve' })), false);
  for (const change of [{ active: true }, { audible: true }, { status: 'loading' }, { url: 'chrome://settings' }, { url: 'chrome-extension://extension/popup.html' }]) assert.equal(needsTabWake(tab(1, change)), false);
  assert.equal(needsTabWake(tab(1, { discarded: false, url: 'https://www.youtube.com/', title: 'YouTube' })), false);
});

test('loads only two at once, reports real completion and coalesces repeated requests', async () => {
  const f = fixture([tab(1), tab(2), tab(3), tab(4, { windowId: 2 }), tab(5, { active: true })]);
  await Promise.all([f.manager.start(1), f.manager.start(1)]);
  await until(() => f.reloaded.length === 2);
  assert.equal(f.queryCalls, 1);
  assert.deepEqual(f.reloaded, [1, 2]);
  assert.equal(f.manager.status().completed, 0);
  f.complete(1);
  await until(() => f.reloaded.length === 3);
  assert.deepEqual(f.reloaded, [1, 2, 3]);
  f.complete(2); f.complete(3);
  await until(() => !f.manager.status().running);
  assert.equal(f.manager.status().woken, 3);
  assert.equal(f.manager.status().failed, 0);
  assert.equal(f.rows.get(3).title, 'Real title 3');
  assert.equal(f.rows.get(5).active, true);
  assert.equal(f.updates.size + f.removals.size, 0);
});

test('rechecks queued tabs instead of reloading a tab the user activated or navigated', async () => {
  const f = fixture([tab(1), tab(2), tab(3), tab(4)]);
  await f.manager.start(1); await until(() => f.reloaded.length === 2);
  f.rows.get(3).active = true;
  f.rows.get(4).url = 'https://example.org/new-unsaved-form';
  f.complete(1); f.complete(2);
  await until(() => !f.manager.status().running);
  assert.deepEqual(f.reloaded, [1, 2]);
  assert.equal(f.manager.status().skipped, 2);
});

test('a closed tab does not stop the queue, and all event listeners are removed', async () => {
  const f = fixture([tab(1), tab(2), tab(3)]);
  await f.manager.start(1); await until(() => f.reloaded.length === 2);
  f.close(1); f.complete(2);
  await until(() => f.reloaded.includes(3)); f.complete(3);
  await until(() => !f.manager.status().running);
  assert.equal(f.manager.status().woken, 2);
  assert.equal(f.manager.status().failed, 1);
  assert.equal(f.manager.status().completed, 3);
  assert.equal(f.updates.size + f.removals.size, 0);
});

test('offline or stalled loads time out and can be retried without a stuck busy state', async () => {
  const f = fixture([tab(1)], 15);
  await f.manager.start(1);
  await until(() => !f.manager.status().running);
  assert.equal(f.manager.status().failed, 1);
  assert.equal(f.updates.size + f.removals.size, 0);
  Object.assign(f.rows.get(1), { status: 'complete', discarded: true });
  await f.manager.start(1); await until(() => f.reloaded.length === 2); f.complete(1);
  await until(() => !f.manager.status().running);
  assert.equal(f.manager.status().woken, 1);
});

test('a progress listener failure does not prevent waking or strand the queue', async () => {
  const f=fixture([tab(1)]);
  f.manager['notify']=()=>{throw Error('Panel receiver disconnected');};
  await f.manager.start(1);await until(()=>f.reloaded.length===1);f.complete(1);
  await until(()=>!f.manager.status().running);
  assert.equal(f.manager.status().woken,1);
});
