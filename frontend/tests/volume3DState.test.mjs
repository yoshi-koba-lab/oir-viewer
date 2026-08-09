import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_VOLUME_3D,
  volume3DCameraForMount,
  volume3DForFreshImage,
  volume3DForRestoredImage,
  volume3DForResampledVolume,
} from '../src/utils/volume3DState.ts';

test('the first mounted camera uses the store default rather than a local placeholder', () => {
  assert.deepEqual(volume3DCameraForMount(DEFAULT_VOLUME_3D), {
    az: 0,
    el: 0,
    radius: 2.5,
    zoomPercent: 100,
  });
});

test('a fresh Z stack starts at its full metadata range', () => {
  assert.deepEqual(volume3DForFreshImage(DEFAULT_VOLUME_3D, 50), {
    ...DEFAULT_VOLUME_3D,
    zStart: 1,
    zEnd: 50,
    zTotal: 50,
  });
});

test('a fresh image carries the camera but not the previous slab', () => {
  const previous = {
    az: 37,
    el: -12,
    radius: 3.25,
    zoomPercent: 225,
    zStart: 10,
    zEnd: 30,
    zTotal: 50,
  };

  assert.deepEqual(volume3DForFreshImage(previous, 80), {
    az: 37,
    el: -12,
    radius: 3.25,
    zoomPercent: 100,
    zStart: 1,
    zEnd: 80,
    zTotal: 80,
  });
  assert.deepEqual(previous, {
    az: 37,
    el: -12,
    radius: 3.25,
    zoomPercent: 225,
    zStart: 10,
    zEnd: 30,
    zTotal: 50,
  });
});

test('invalid or empty metadata still produces a non-empty one-slice range', () => {
  for (const numZ of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const state = volume3DForFreshImage(DEFAULT_VOLUME_3D, numZ);
    assert.equal(state.zStart, 1);
    assert.equal(state.zEnd, 1);
    assert.equal(state.zTotal, 1);
  }
});

test('restore preserves an explicitly selected per-image slab', () => {
  const saved = {
    az: 15,
    el: 25,
    radius: 2,
    zoomPercent: 180,
    zStart: 8,
    zEnd: 21,
    zTotal: 50,
  };
  const restored = volume3DForRestoredImage(DEFAULT_VOLUME_3D, saved, 50);

  assert.deepEqual(restored, saved);
  assert.notEqual(restored, saved);
});

test('restore migrates a pre-3D 1/1/1 placeholder to the full stack', () => {
  const placeholder = {
    az: 35,
    el: -10,
    radius: 4,
    zoomPercent: 130,
    zStart: 1,
    zEnd: 1,
    zTotal: 1,
  };

  assert.deepEqual(volume3DForRestoredImage(DEFAULT_VOLUME_3D, placeholder, 50), {
    ...placeholder,
    zEnd: 50,
    zTotal: 50,
  });
});

test('restore without an older volume field keeps the angle but starts fitted', () => {
  const current = {
    az: 90,
    el: 0,
    radius: 1.5,
    zoomPercent: 240,
    zStart: 3,
    zEnd: 4,
    zTotal: 10,
  };

  assert.deepEqual(volume3DForRestoredImage(current, undefined, 12), {
    ...current,
    zoomPercent: 100,
    zStart: 1,
    zEnd: 12,
    zTotal: 12,
  });
});

test('quality and T reloads preserve the physical slab fraction', () => {
  const backHalf128 = {
    az: 10, el: 20, radius: 3, zoomPercent: 150, zStart: 65, zEnd: 128, zTotal: 128,
  };
  assert.deepEqual(volume3DForResampledVolume(backHalf128, 200), {
    az: 10, el: 20, radius: 3, zoomPercent: 150, zStart: 101, zEnd: 200, zTotal: 200,
  });
  assert.deepEqual(
    volume3DForResampledVolume({ ...backHalf128, zStart: 1, zEnd: 128 }, 50),
    { az: 10, el: 20, radius: 3, zoomPercent: 150, zStart: 1, zEnd: 50, zTotal: 50 },
  );
});

test('older session camera state without zoom migrates to fit', () => {
  const legacy = {
    az: 20, el: 10, radius: 2.5, zStart: 2, zEnd: 5, zTotal: 8,
  };
  assert.deepEqual(volume3DForRestoredImage(DEFAULT_VOLUME_3D, legacy, 8), {
    ...legacy,
    zoomPercent: 100,
  });
});
