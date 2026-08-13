import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../'))
      && !/\.[a-z0-9]+$/i.test(specifier)) {
      for (const extension of ['.ts', '.tsx', '.js']) {
        const candidate = new URL(`${specifier}${extension}`, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) {
          return nextResolve(candidate.href, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  plateExportPercent,
  plateExportTotalUnits,
  plateZoomProblem,
} = await import('../src/utils/plateExport.ts');

test('eight-well Plate progress counts 18 completed units and reserves 100% for publish', () => {
  assert.equal(plateExportTotalUnits(8), 18);
  const values = Array.from({ length: 19 }, (_, completed) => (
    plateExportPercent(completed, 8)
  ));
  assert.equal(values[0], 0);
  assert.equal(values[1], 5);   // preflight completed
  assert.equal(values[2], 11);  // A01 data acquired
  assert.equal(values[3], 16);  // A01 render/PNG completed
  assert.equal(values[17], 94); // all eight wells completed; publish not verified
  assert.equal(values[18], 100);
  assert.ok(values.every((value, index) => index === 0 || value >= values[index - 1]));
  assert.ok(values.slice(0, -1).every((value) => value < 100));
});

test('single-well progress advances only after each completed unit', () => {
  assert.equal(plateExportTotalUnits(1), 4);
  assert.deepEqual(
    Array.from({ length: 5 }, (_, completed) => plateExportPercent(completed, 1)),
    [0, 25, 50, 75, 100],
  );
});

test('Plate zoom editing accepts a real percent but never treats an empty or unsafe draft as 0', () => {
  assert.equal(plateZoomProblem('100'), '');
  assert.equal(plateZoomProblem('125.5'), '');
  assert.match(plateZoomProblem(''), /数値/);
  assert.match(plateZoomProblem('not-a-number'), /数値/);
  assert.match(plateZoomProblem('0'), /10–1000/);
  assert.match(plateZoomProblem('-20'), /10–1000/);
  assert.match(plateZoomProblem('1001'), /10–1000/);
});

test('pattern count multiplies renders and publishes, and defaults to one', () => {
  // 1 preflight + wells*(1 fetch + P renders) + P publishes.
  assert.equal(plateExportTotalUnits(8), plateExportTotalUnits(8, 1));
  assert.equal(plateExportTotalUnits(8, 2), 1 + 8 * 3 + 2);
  assert.equal(plateExportPercent(0, 8, 2), 0);
  assert.equal(plateExportPercent(1 + 8 * 3 + 2, 8, 2), 100);
  // 100% is unreachable until the last publish unit lands.
  assert.ok(plateExportPercent(1 + 8 * 3 + 1, 8, 2) < 100);
});
