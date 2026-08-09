import assert from 'node:assert/strict';
import test from 'node:test';

import { completedSavePercent, ThreeDSaveGuard } from '../src/utils/threeDSave.ts';

test('capture phases leave the final percentage for the filesystem write', () => {
  // MERGE + four channels + one all-or-nothing write.
  assert.deepEqual(
    Array.from({ length: 7 }, (_, completed) => completedSavePercent(completed, 6)),
    [0, 17, 33, 50, 67, 83, 100],
  );
});

test('save progress is bounded and empty work never claims completion', () => {
  assert.equal(completedSavePercent(-1, 2), 0);
  assert.equal(completedSavePercent(3, 2), 100);
  assert.equal(completedSavePercent(1, 0), 0);
});

test('one save owns one view revision and a second run cannot interleave', () => {
  const guard = new ThreeDSaveGuard();
  const first = guard.begin(7);
  assert.ok(first);
  assert.equal(guard.isLocked, true);
  assert.equal(guard.begin(7), null);
  assert.equal(guard.owns(first, 7), true);
  assert.equal(guard.owns(first, 8), false);

  guard.finish(first);
  const second = guard.begin(8);
  assert.ok(second);
  assert.notEqual(second.token, first.token);
  // A stale completion cannot release the current run.
  guard.finish(first);
  assert.equal(guard.isLocked, true);
  guard.finish(second);
  assert.equal(guard.isLocked, false);
});
