import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../'))
      && !/\.[a-z0-9]+$/i.test(specifier)) {
      for (const extension of ['.ts', '.tsx', '.js']) {
        const candidate = new URL(`${specifier}${extension}`, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  defaultViewMode, rememberableViewMode, rememberedOrDefaultViewMode,
} = await import('../src/utils/imageViewMode.ts');

test('Z stacks open in 3D and single-plane images open in 2D', () => {
  assert.equal(defaultViewMode(50), '3d');
  assert.equal(defaultViewMode(2), '3d');
  assert.equal(defaultViewMode(1), '2d');
  assert.equal(defaultViewMode(0), '2d');
});

test('returning to an image keeps its 2D/3D choice without forcing the default again', () => {
  assert.equal(rememberedOrDefaultViewMode('2d', 50), '2d');
  assert.equal(rememberedOrDefaultViewMode('3d', 50), '3d');
  assert.equal(rememberedOrDefaultViewMode('3d', 1), '2d');
  assert.equal(rememberedOrDefaultViewMode(undefined, 50), '3d');
});

test('an intermediate batch image is not mistaken for a user-selected 2D view', () => {
  assert.equal(rememberableViewMode(false, '2d'), undefined);
  assert.equal(rememberedOrDefaultViewMode(undefined, 50), '3d');
  assert.equal(rememberableViewMode(true, '2d'), '2d');
});
