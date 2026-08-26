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
  buildBulkPlan,
  bulkValueProblem,
  describeBulkResult,
} = await import('../src/utils/bulkChannels.ts');

const V = (enabled, min, max) => ({ enabled, min, max });
const T = (id, numChannels, hasState = true) => (
  { id, filename: `${id}.oir`, numChannels, hasState }
);

test('values must include one enabled channel with an ordered integer window', () => {
  assert.equal(bulkValueProblem([V(true, 0, 4095)]), '');
  assert.notEqual(bulkValueProblem([V(false, 0, 4095)]), '');
  assert.notEqual(bulkValueProblem([V(true, 100, 100)]), '');
  assert.notEqual(bulkValueProblem([V(true, 200, 100)]), '');
  assert.notEqual(bulkValueProblem([V(true, -1, 100)]), '');
  assert.notEqual(bulkValueProblem([V(true, 0.5, 100)]), '');
  assert.notEqual(bulkValueProblem([V(true, 0, NaN)]), '');
  // A disabled malformed row does not block the enabled ones.
  assert.equal(bulkValueProblem([V(true, 0, 100), V(false, 9, 3)]), '');
});

test('a short-channel file skips just the missing rows and reports them', () => {
  const values = [V(true, 0, 1000), V(false, 0, 0), V(true, 50, 500)];
  const plans = buildBulkPlan([T('five', 5), T('two', 2)], values);
  assert.deepEqual(plans[0].updates, [
    { channel: 0, min: 0, max: 1000 },
    { channel: 2, min: 50, max: 500 },
  ]);
  assert.deepEqual(plans[0].missing, []);
  // CH3 does not exist in the 2-channel file; CH1 still applies.
  assert.deepEqual(plans[1].updates, [{ channel: 0, min: 0, max: 1000 }]);
  assert.deepEqual(plans[1].missing, [2]);
});

test('tabs without established state are never planned', () => {
  const plans = buildBulkPlan(
    [T('shown', 3), T('never-shown', 3, false)],
    [V(true, 0, 100)],
  );
  assert.deepEqual(plans.map((p) => p.id), ['shown']);
});

test('the result line counts applied files and names skipped channels', () => {
  const values = [V(true, 0, 1000), V(true, 0, 2000)];
  const plans = buildBulkPlan([T('a', 2), T('b', 1), T('c', 1)], values);
  const text = describeBulkResult(plans);
  assert.match(text, /3 ファイルに適用しました/);
  assert.match(text, /CH2 は 2 ファイルでCH数不足のためスキップ/);
  assert.equal(describeBulkResult([]), '適用できるファイルがありませんでした。');
});
