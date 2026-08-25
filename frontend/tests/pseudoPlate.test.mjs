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
  PSEUDO_FORMATS,
  assignWithMove,
  duplicateSourcePositions,
  prefillAssignments,
  pseudoPositions,
  pseudoWellId,
  remapAssignments,
  tabLabels,
} = await import('../src/utils/pseudoPlate.ts');

test('formats are the standard culture-plate geometries, without 96', () => {
  assert.deepEqual(
    PSEUDO_FORMATS.map((f) => [f.key, f.rows, f.cols, f.rows * f.cols]),
    [['6', 2, 3, 6], ['12', 3, 4, 12], ['24', 4, 6, 24], ['48', 6, 8, 48]],
  );
});

test('well IDs match the backend canonical zero-padded form', () => {
  // backend validate_pdf_layout requires exactly `${chr(65+row)}${col+1:02d}`.
  assert.equal(pseudoWellId(0, 0), 'A01');
  assert.equal(pseudoWellId(1, 2), 'B03');
  assert.equal(pseudoWellId(5, 7), 'F08');
  assert.deepEqual(pseudoPositions(2, 3), ['A01', 'A02', 'A03', 'B01', 'B02', 'B03']);
});

test('prefill drops files into row-major positions and stops at the grid size', () => {
  assert.deepEqual(prefillAssignments(2, 3, ['x', 'y']), { A01: 'x', A02: 'y' });
  const overfull = prefillAssignments(2, 3, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.equal(Object.keys(overfull).length, 6);
  assert.equal(overfull.B03, 'f');
  assert.ok(!Object.values(overfull).includes('g'));
});

test('remap keeps in-grid assignments to open tabs and drops the rest', () => {
  const prev = { A01: 'x', C05: 'y', B02: 'closed' };
  assert.deepEqual(
    remapAssignments(prev, 2, 3, ['x', 'y']),
    { A01: 'x' },   // C05 is outside 2x3; B02's tab is no longer open
  );
});

test('assigning a file elsewhere moves it instead of duplicating it', () => {
  let a = { A01: 'x', A02: 'y' };
  a = assignWithMove(a, 'B01', 'x');
  assert.deepEqual(a, { A02: 'y', B01: 'x' });
  a = assignWithMove(a, 'B01', '');
  assert.deepEqual(a, { A02: 'y' });
  // Reselecting the same position just replaces it.
  a = assignWithMove(a, 'A02', 'z');
  assert.deepEqual(a, { A02: 'z' });
});

test('two tabs of the same source bytes are reported as duplicates, in plate order', () => {
  const identity = (id) => ({ t1: 'same', t2: 'same', t3: 'other' })[id];
  assert.deepEqual(
    duplicateSourcePositions({ B01: 't2', A01: 't1', A02: 't3' }, identity),
    [['A01', 'B01']],
  );
  assert.deepEqual(duplicateSourcePositions({ A01: 't1', A02: 't3' }, identity), []);
});

test('dropdown labels stay plain until a filename collides, then carry the folder', () => {
  const labels = tabLabels([
    { id: '1', filename: 'a.oir', source_path: '/data/exp1/a.oir' },
    { id: '2', filename: 'b.oir', source_path: '/data/exp1/b.oir' },
  ]);
  assert.equal(labels.get('1'), 'a.oir');
  assert.equal(labels.get('2'), 'b.oir');

  const collided = tabLabels([
    { id: '1', filename: 'a.oir', source_path: '/data/exp1/a.oir' },
    { id: '2', filename: 'a.oir', source_path: 'C:\\data\\exp2\\a.oir' },
  ]);
  assert.equal(collided.get('1'), 'a.oir — exp1');
  assert.equal(collided.get('2'), 'a.oir — exp2');
});
