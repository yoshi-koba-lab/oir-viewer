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

const { parseVolume, planPlateScalebar } = await import('../src/utils/plateRender.ts');
const { VOLUME_CAMERA_FOV_DEG } = await import('../src/utils/volumeShader.ts');

test('Plate volume physical size comes from source dimensions, not downsampled dimensions', () => {
  const data = new ArrayBuffer(32 + 8 + 12);
  const head = new Uint32Array(data, 0, 8);
  head.set([1, 2, 2, 3, 1, 50, 2000, 3000]);

  const volume = parseVolume(data, {
    channels: [0],
    out: [2, 2, 3],
    max_xy: 3,
    source: [1, 50, 2000, 3000],
    bytes: data.byteLength,
    voxel: [0.2, 0.3, 1],
    source_identity: 'identity',
    source_revision: 'revision',
    t: 0,
    levels: [[0, 255]],
  });

  assert.equal(volume.geometry.calibrated, true);
  assert.equal(volume.geometry.maxDimUm, 600);
  assert.deepEqual(
    [volume.geometry.scaleX, volume.geometry.scaleY, volume.geometry.scaleZ],
    [1, 1, 50 / 600],
  );
  assert.equal(volume.channels.length, 1);
  assert.equal(volume.channels[0].byteLength, 12);
});

test('Plate scale bar uses centre-depth physical calibration and stays bottom-left', () => {
  const size = 600;
  const radius = 2;
  const maxDimensionUm = 500;
  const requestedUm = 100;
  const plan = planPlateScalebar('A01', size, radius, maxDimensionUm, requestedUm);
  const expectedUmPerPx = (
    2 * radius * Math.tan((VOLUME_CAMERA_FOV_DEG * Math.PI / 180) / 2)
    * maxDimensionUm / size
  );

  assert.equal(plan.um, requestedUm);
  assert.ok(Math.abs(plan.px - requestedUm / expectedUmPerPx) < 1e-9);
  assert.equal(plan.x, 15);
  assert.equal(plan.baseline, 585);
  assert.equal(plan.visualScale, 1);
  assert.ok(plan.x + plan.px < size);
});

test('Plate scale bar label and strokes scale with the selected cell resolution', () => {
  const cases = [
    [300, 0.75],
    [600, 1],
    [1200, 2],
    [2000, 2000 / 600],
  ];
  for (const [size, expectedScale] of cases) {
    const plan = planPlateScalebar('A01', size, 2, 500, 100);
    assert.ok(Math.abs(plan.visualScale - expectedScale) < 1e-9);
    const pad = Math.round(15 * expectedScale);
    assert.equal(plan.x, pad);
    assert.equal(plan.baseline, size - pad);
  }
});

test('Plate auto scale bar is round and an oversized explicit bar fails with well provenance', () => {
  const auto = planPlateScalebar('B02', 300, 2, 500, null);
  const power = 10 ** Math.floor(Math.log10(auto.um));
  assert.ok([1, 2, 5].includes(auto.um / power));
  assert.ok(auto.px <= 300 * 0.55);

  assert.throws(
    () => planPlateScalebar('C03', 300, 2, 500, 10_000),
    /C03:.*画像内に収まりません/,
  );
});
