import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('../src/lib/graph-camera.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { cameraLimits, keepGraphVisible } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
const nodes = [{ x: -300, y: -100 }, { x: 400, y: 200 }, { x: 0, y: 0 }];
test('fit and zoom limits are finite for large, single-node and narrow graphs', () => {
  for (const fixture of [nodes, [{ x: 0, y: 0 }], [{ x: 0, y: 0 }, { x: 1e6, y: -1e6 }]]) {
    const limits = cameraLimits(fixture, 260, 570);
    assert.ok(limits.minZoom > 0 && limits.minZoom < limits.fitZoom && limits.fitZoom < limits.maxZoom);
    assert.ok(Number.isFinite(limits.fitZoom));
  }
});
test('normal camera stays unchanged; extreme pan retains a node inside the viewport', () => {
  assert.deepEqual(keepGraphVisible({ x: 0, y: 0 }, 1, nodes, 900, 570), { x: 0, y: 0 });
  for (const zoom of [.3, 1, 8]) {
    for (const center of [{ x: 1e6, y: -1e6 }, { x: -1e6, y: 1e6 }]) {
      const bounded = keepGraphVisible(center, zoom, nodes, 900, 570);
      assert.ok(nodes.some(n => Math.abs(n.x - bounded.x) <= (900 / 2 - 44) / zoom && Math.abs(n.y - bounded.y) <= (570 / 2 - 44) / zoom));
    }
  }
});
