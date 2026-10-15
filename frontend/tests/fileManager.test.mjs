import assert from 'node:assert/strict';
import test from 'node:test';

const { closeOrder, isSameSetReordered, pruneFileSelection, reorderedIds } = await import('../src/utils/fileManager.ts');

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

test('dropping a tab before or after another moves it there and nowhere else', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(reorderedIds(ids, 'd', 'a', true), ['d', 'a', 'b', 'c']);
  assert.deepEqual(reorderedIds(ids, 'a', 'd', false), ['b', 'c', 'd', 'a']);
  assert.deepEqual(reorderedIds(ids, 'a', 'c', true), ['b', 'a', 'c', 'd']);
  assert.deepEqual(reorderedIds(ids, 'c', 'a', false), ['a', 'c', 'b', 'd']);
  // Dropping a tab on its own slot, on itself, or on an unknown id is a no-op.
  assert.deepEqual(reorderedIds(ids, 'b', 'b', true), ids);
  assert.deepEqual(reorderedIds(ids, 'b', 'a', false), ids);
  assert.deepEqual(reorderedIds(ids, 'zzz', 'a', true), ids);
  assert.deepEqual(reorderedIds(ids, 'a', 'zzz', true), ids);
  assert.deepEqual(ids, ['a', 'b', 'c', 'd']);
});

test('only a permutation of the same ids counts as a reorder', () => {
  assert.equal(isSameSetReordered(['a', 'b'], ['b', 'a']), true);
  assert.equal(isSameSetReordered(['a', 'b'], ['a', 'b']), false);
  assert.equal(isSameSetReordered(['a', 'b'], ['a']), false);
  assert.equal(isSameSetReordered(['a', 'b'], ['a', 'c']), false);
  assert.equal(isSameSetReordered(['a', 'b'], ['a', 'a']), false);
});
