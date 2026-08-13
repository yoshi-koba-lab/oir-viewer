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
  VISIBLE_PATTERN,
  channelSetLabel,
  loadPatterns,
  patternChannelsFor,
  patternFileStem,
  patternMask,
  patternProblem,
  sanitizePatterns,
  savePatterns,
  unionChannelsFor,
  wellsMissingPatternChannels,
} = await import('../src/utils/platePatterns.ts');

const well = (wellId, numChannels, channelIdx) => ({ wellId, numChannels, channelIdx });
const P = (name, channels, key = `k-${name}`) => ({ key, name, channels });

test('visible pattern draws exactly the well\'s visible channels, sorted', () => {
  assert.deepEqual(patternChannelsFor(VISIBLE_PATTERN, well('B02', 4, [2, 0])), [0, 2]);
  assert.deepEqual(patternChannelsFor(P('CH1+2', [0, 1]), well('B02', 4, [2, 0])), [0, 1]);
});

test('a fixed pattern refuses wells that lack a named channel', () => {
  const pattern = P('CH3', [2]);
  const wells = [well('B02', 2, [0]), well('B03', 4, [0]), well('B04', 3, [1])];
  assert.deepEqual(wellsMissingPatternChannels(pattern, wells), ['B02']);
  // The visible pattern can never name a missing channel.
  assert.deepEqual(wellsMissingPatternChannels(VISIBLE_PATTERN, wells), []);
});

test('one fetch serves every pattern: union is sorted and deduplicated', () => {
  const w = well('B02', 4, [3]);
  const union = unionChannelsFor([VISIBLE_PATTERN, P('CH1+2', [0, 1]), P('CH2+3', [1, 2])], w);
  assert.deepEqual(union, [0, 1, 2, 3]);
  // Masks address positions in the fetched union, not raw channel numbers.
  assert.deepEqual(patternMask(P('CH1+2', [0, 1]), w, union), [true, true, false, false]);
  assert.deepEqual(patternMask(VISIBLE_PATTERN, w, union), [false, false, false, true]);
});

test('a single pattern keeps the typed filename; several suffix the name', () => {
  const one = P('全色', [0, 1, 2, 3]);
  assert.equal(patternFileStem('plate', one, 1), 'plate');
  assert.equal(patternFileStem('plate', one, 2), 'plate_全色');
});

test('pattern names obey filename rules because they become filenames', () => {
  assert.equal(patternProblem('CH1+2', [0, 1], []), '');
  assert.notEqual(patternProblem('bad/name', [0], []), '');
  assert.notEqual(patternProblem('', [0], []), '');
  assert.notEqual(patternProblem('CH5', [4], []), '');
  assert.notEqual(patternProblem('dup', [0, 0], []), '');
  assert.notEqual(patternProblem('none', [], []), '');
  assert.notEqual(patternProblem(VISIBLE_PATTERN.name, [0], []), '');
  assert.notEqual(patternProblem('X', [0], [P('x', [1])]), '');
  // NFC vs NFD spellings alias one file on macOS, so they are one name here.
  assert.notEqual(patternProblem('ガ', [0], [P('ガ', [1])]), '');
});

test('a corrupt store yields no patterns instead of a broken dialog', () => {
  assert.deepEqual(sanitizePatterns('garbage'), []);
  assert.deepEqual(sanitizePatterns([{ key: 'a' }]), []);
  assert.deepEqual(
    sanitizePatterns([{ key: 'a', name: 'ok', channels: [1, 0, 9, 0] }])
      .map((p) => p.channels),
    [[0, 1]],
  );
  // The built-in key can never be shadowed by a stored pattern.
  assert.deepEqual(
    sanitizePatterns([{ key: VISIBLE_PATTERN.key, name: 'fake', channels: [0] }]),
    [],
  );
});

test('save/load round-trips through a storage stand-in', () => {
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v); },
  };
  const patterns = [P('CH1+2', [0, 1], 'p1'), P('全色', [0, 1, 2, 3], 'p2')];
  savePatterns(storage, patterns);
  assert.deepEqual(loadPatterns(storage), patterns);
  // A quota failure loses persistence, never the running dialog.
  savePatterns({ setItem: () => { throw new Error('quota'); } }, patterns);
  assert.deepEqual(loadPatterns({ getItem: () => { throw new Error('denied'); } }), []);
});

test('channel labels are written the way the figure writes them', () => {
  assert.equal(channelSetLabel([0, 2]), 'CH1+CH3');
  assert.equal(channelSetLabel([]), '（なし）');
});
