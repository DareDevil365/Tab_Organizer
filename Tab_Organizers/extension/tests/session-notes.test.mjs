import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const normalization = moduleUrl(compile(readFileSync(new URL('../src/lib/url-normalize.ts', import.meta.url), 'utf8')));
const source = compile(readFileSync(new URL('../src/lib/session-notes.ts', import.meta.url), 'utf8')).replace("'./url-normalize'", JSON.stringify(normalization));
const { notesForOpenTabs } = await import(moduleUrl(source));
const notes = [
  { id: 'old-open-video', videoUrl: 'https://youtu.be/abcdefghijk?t=12' },
  { id: 'closed-video', videoUrl: 'https://youtube.com/watch?v=12345678901' },
  { id: 'different-window', videoUrl: 'https://reference.example/other' },
  { id: 'open-article', videoUrl: 'https://reference.example/article#heading' },
];
const tabs = [
  { windowId: 1, url: 'https://www.youtube.com/watch?v=abcdefghijk&t=60&list=example' },
  { windowId: 1, url: 'https://reference.example/article?utm_source=source' },
  { windowId: 2, url: 'https://reference.example/other' },
];
test('only notes for currently open resources in the selected window appear, regardless of note age', () => {
  assert.deepEqual(notesForOpenTabs(notes, tabs, 1).map(n => n.id), ['old-open-video', 'open-article']);
});
test('current-page scope works for articles and never falls back to all history', () => {
  assert.deepEqual(notesForOpenTabs(notes, tabs, 1, 'https://reference.example/article').map(n => n.id), ['open-article']);
  assert.deepEqual(notesForOpenTabs(notes, tabs, 1, ''), []);
  assert.deepEqual(notesForOpenTabs(notes, [], 1), []);
});
test('closing a tab removes its notes and another window does not leak into scope', () => {
  assert.deepEqual(notesForOpenTabs(notes, tabs.slice(1), 1).map(n => n.id), ['open-article']);
  assert.deepEqual(notesForOpenTabs(notes, tabs, 2).map(n => n.id), ['different-window']);
});
test('a video ID prefix is never a match, and duplicate tabs do not duplicate notes', () => {
  assert.deepEqual(notesForOpenTabs(notes, [{ windowId: 1, url: 'https://youtube.com/watch?v=abcdefghijk2' }], 1), []);
  assert.equal(notesForOpenTabs(notes, [tabs[0], tabs[0]], 1).length, 1);
});
