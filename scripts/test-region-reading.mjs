import assert from 'node:assert/strict';
import { hashRegionImage, isUsableRegion, normalizeRegion, outputSize, regionPixels, REGION_ACTIONS } from '../lib/rag/region-reading.ts';

assert.deepEqual(normalizeRegion(0.8, 0.7, 0.2, 0.1), { x: 0.2, y: 0.1, width: 0.6000000000000001, height: 0.6 });
assert.deepEqual(normalizeRegion(-1, 0.25, 2, 1.5), { x: 0, y: 0.25, width: 1, height: 0.75 });
assert.equal(isUsableRegion({ x: 0, y: 0, width: 0.01, height: 0.5 }, 1000, 1000), false);
assert.equal(isUsableRegion({ x: 0, y: 0, width: 0.2, height: 0.2 }, 1000, 1000), true);
assert.deepEqual(regionPixels({ x: 0.1, y: 0.2, width: 0.5, height: 0.25 }, 1200, 1600), { x: 120, y: 320, width: 600, height: 400 });
assert.deepEqual(outputSize(3600, 1800), { width: 1800, height: 900 });
assert.deepEqual(outputSize(900, 1200), { width: 900, height: 1200 });
assert.equal(REGION_ACTIONS.formula.task, 'formula');
assert.equal(REGION_ACTIONS.table.task, 'table');
assert.equal(REGION_ACTIONS.code.task, 'text');
assert.equal(REGION_ACTIONS.translate.task, 'text');
const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
assert.equal(await hashRegionImage(bytes), await hashRegionImage(bytes));
assert.notEqual(await hashRegionImage(bytes), await hashRegionImage(Uint8Array.from([1, 2, 3, 4, 6])));

console.log(JSON.stringify({ actions: Object.keys(REGION_ACTIONS), maxEdge: outputSize(3600, 1800).width, hashStable: true }));
