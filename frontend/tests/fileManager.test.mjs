import assert from 'node:assert/strict';
import test from 'node:test';

const { closeOrder, pruneFileSelection } = await import('../src/utils/fileManager.ts');

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('file manager drops selections for files no longer open', () => {
  assert.deepEqual(
    [...pruneFileSelection(['a', 'missing', 'c'], items)],
    ['a', 'c'],
  );
});

test('file manager closes background selections first and active selection last', () => {
  assert.deepEqual(closeOrder(['c', 'a'], items, 'a'), ['c', 'a']);
  assert.deepEqual(closeOrder(['c', 'b'], items, 'a'), ['b', 'c']);
  assert.deepEqual(closeOrder(['a'], items, null), ['a']);
});
