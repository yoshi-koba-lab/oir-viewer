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
  IDENTITY_ORIENTATION,
  isIdentityOrientation,
  normalizeOrientation,
  orientationLabel,
  orientationSwapsAxes,
  sameOrientation,
} = await import('../src/utils/orientation.ts');

test('anything an old record or the API may hold normalizes to a canonical value', () => {
  assert.deepEqual(normalizeOrientation(undefined), IDENTITY_ORIENTATION);
  assert.deepEqual(normalizeOrientation(null), IDENTITY_ORIENTATION);
  assert.deepEqual(normalizeOrientation({}), IDENTITY_ORIENTATION);
  assert.deepEqual(normalizeOrientation({ rotation: 90 }), { rotation: 90, flipH: false, flipV: false });
  // Values the backend would refuse never reach the UI as anything but the identity.
  assert.deepEqual(normalizeOrientation({ rotation: 45, flipH: 1, flipV: 'yes' }), IDENTITY_ORIENTATION);
  assert.deepEqual(normalizeOrientation({ rotation: '90' }), IDENTITY_ORIENTATION);
});

test('identity and equality', () => {
  assert.equal(isIdentityOrientation({ rotation: 0, flipH: false, flipV: false }), true);
  assert.equal(isIdentityOrientation({ rotation: 0, flipH: false, flipV: true }), false);
  assert.equal(sameOrientation({ rotation: 180, flipH: true, flipV: false }, { rotation: 180, flipH: true, flipV: false }), true);
  assert.equal(sameOrientation({ rotation: 180, flipH: true, flipV: false }, { rotation: 180, flipH: false, flipV: false }), false);
});

test('90 and 270 swap the axes; 0 and 180 do not', () => {
  assert.equal(orientationSwapsAxes(normalizeOrientation({ rotation: 90 })), true);
  assert.equal(orientationSwapsAxes(normalizeOrientation({ rotation: 270 })), true);
  assert.equal(orientationSwapsAxes(normalizeOrientation({ rotation: 180 })), false);
  assert.equal(orientationSwapsAxes(IDENTITY_ORIENTATION), false);
});

test('the toolbar label is empty for the identity and names every active part', () => {
  assert.equal(orientationLabel(IDENTITY_ORIENTATION), '');
  assert.equal(orientationLabel({ rotation: 90, flipH: false, flipV: false }), '90°');
  assert.equal(orientationLabel({ rotation: 0, flipH: false, flipV: true }), '上下');
  assert.equal(orientationLabel({ rotation: 270, flipH: true, flipV: true }), '270°・上下・左右');
});
