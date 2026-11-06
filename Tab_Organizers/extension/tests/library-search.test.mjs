import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/library-search.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { rankTextPages, applySearchRanking } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
const pages = [{ id: 1, title: 'Gardening' }, { id: 2, title: 'Video editing' }, { id: 3, title: 'Another reference' }];

test('immediate typo tolerant ranking keeps all resources and does not mutate them', () => {
  assert.deepEqual(rankTextPages(pages, 'viddeo edditing').map(p => p.id), [2, 1, 3]);
  assert.equal(pages[0].search_score, undefined);
  assert.equal(rankTextPages(pages, '   '), pages);
});
test('server ranking preserves new pages, ignores deleted IDs and keeps zero scores', () => {
  const result = applySearchRanking(pages, [{ id: 3, score: 81 }, { id: 9, score: 70 }, { id: 1, score: 0 }]);
  assert.deepEqual(result.map(p => [p.id, p.search_score]), [[3, 81], [1, 0], [2, 0]]);
});
