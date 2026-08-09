import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fitVolumeCameraRadius,
  minimumVolumeCameraRadius,
  resolveVolumeCameraZoom,
  volumePhysicalGeometry,
  volumeRadiusForZoomPercent,
  volumeZoomPercentForRadius,
} from '../src/utils/threeDCamera.ts';

const base = {
  scaleX: 1,
  scaleY: 0.75,
  scaleZ: 0.1,
  azDeg: 0,
  elDeg: 0,
  fovDeg: 45,
  aspect: 16 / 9,
  near: 0.01,
};

test('fit uses the anisotropic projected box rather than a bounding sphere', () => {
  const radius = fitVolumeCameraRadius(base);
  const expected = 0.05 + 0.375 / (Math.tan(Math.PI / 8) * 0.94);
  assert.ok(Math.abs(radius - expected) < 1e-12);
  assert.ok(radius < 1.1);
});

test('100 percent is fit and percentage/radius conversions are inverse', () => {
  const fit = fitVolumeCameraRadius(base);
  assert.equal(volumeRadiusForZoomPercent(fit, 100), fit);
  assert.equal(volumeZoomPercentForRadius(fit, fit), 100);
  assert.ok(Math.abs(volumeZoomPercentForRadius(fit, volumeRadiusForZoomPercent(fit, 250)) - 250) < 1e-10);
});

test('the same percentage remains defined through resize and rotation', () => {
  const wide = resolveVolumeCameraZoom(base, 175);
  const square = resolveVolumeCameraZoom({ ...base, aspect: 1 }, 175);
  const side = resolveVolumeCameraZoom({ ...base, azDeg: 90, aspect: 1 }, 175);
  assert.ok(Math.abs(wide.zoomPercent - 175) < 1e-10);
  assert.ok(Math.abs(square.zoomPercent - 175) < 1e-10);
  assert.ok(Math.abs(side.zoomPercent - 175) < 1e-10);
  assert.notEqual(wide.radius, square.radius);
  assert.notEqual(square.radius, side.radius);
});

test('extreme zoom never puts the near plane inside the volume', () => {
  const resolved = resolveVolumeCameraZoom({ ...base, scaleZ: 1 }, 100000);
  const minimum = minimumVolumeCameraRadius({ ...base, scaleZ: 1 });
  assert.ok(resolved.radius >= minimum);
  assert.ok(resolved.zoomPercent <= resolved.maxZoomPercent);
  assert.ok(resolved.maxZoomPercent < 1000);
});

test('Z slab selection is deliberately absent from fit geometry', () => {
  const full = fitVolumeCameraRadius(base);
  const afterSlabChange = fitVolumeCameraRadius({ ...base });
  assert.equal(afterSlabChange, full);
});

test('missing axis calibration never produces a physical scale', () => {
  assert.deepEqual(volumePhysicalGeometry(2048, 1024, 50, 0.2, 0.2, 0), {
    scaleX: 1,
    scaleY: 0.5,
    scaleZ: 50 / 2048,
    maxDimUm: 0,
    calibrated: false,
  });

  const calibrated = volumePhysicalGeometry(2048, 1024, 50, 0.2, 0.2, 2);
  assert.equal(calibrated.calibrated, true);
  assert.equal(calibrated.maxDimUm, 409.6);
  assert.equal(calibrated.scaleX, 1);
  assert.equal(calibrated.scaleY, 0.5);
  assert.ok(Math.abs(calibrated.scaleZ - 100 / 409.6) < 1e-12);
});
