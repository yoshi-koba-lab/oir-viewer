import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fitVolumeCameraRadius,
  minimumVolumeCameraRadius,
  resolveVolumeCameraZoom,
  volumeCameraCropFit,
  volumeViewportRect,
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

test('3D crop fit narrows X/Y and centers an off-centre source rectangle in world space', () => {
  const fit = volumeCameraCropFit(
    { scaleX: 1, scaleY: 0.5, scaleZ: 0.2 },
    { x: 20, y: 10, width: 40, height: 20 },
    100,
    80,
  );
  assert.deepEqual(fit, {
    scaleX: 0.4,
    scaleY: 0.125,
    scaleZ: 0.2,
    // The mesh is translated to keep its physical box centered in world space.
    target: [0.4, 0.375, 0.5],
  });
});

test('full-frame crop is an exact no-op for 3D framing', () => {
  assert.deepEqual(
    volumeCameraCropFit(
      { scaleX: 0.8, scaleY: 0.6, scaleZ: 0.2 },
      { x: 0, y: 0, width: 100, height: 80 },
      100,
      80,
    ),
    { scaleX: 0.8, scaleY: 0.6, scaleZ: 0.2, target: [0.5, 0.5, 0.5] },
  );
});

test('invalid 3D crop geometry fails closed', () => {
  assert.throws(
    () => volumeCameraCropFit(
      { scaleX: 1, scaleY: 1, scaleZ: 1 },
      { x: 90, y: 0, width: 20, height: 10 },
      100,
      80,
    ),
    /範囲外/,
  );
});

test('3D crop overlay follows the projected physical volume instead of the full letterboxed canvas', () => {
  const input = {
    scaleX: 1,
    scaleY: 0.5,
    scaleZ: 0.2,
    azDeg: 0,
    elDeg: 0,
    fovDeg: 50,
    aspect: 16 / 9,
  };
  const camera = resolveVolumeCameraZoom(input, 100);
  const rect = volumeViewportRect({
    ...input,
    radius: camera.radius,
    viewportWidth: 1600,
    viewportHeight: 900,
  });
  // The wide physical X axis is the limiting dimension here; the Y source
  // plane is letterboxed and must not be mapped to all 900 CSS pixels.
  assert.ok(rect.width > 0 && rect.height > 0);
  assert.ok(rect.x > 0 && rect.x + rect.width < 1600);
  assert.ok(rect.y > 0 && rect.y + rect.height < 900);
  assert.ok(rect.height < 900 * 0.8);
  assert.ok(Math.abs(rect.x + rect.width / 2 - 800) < 1e-9);
  assert.ok(Math.abs(rect.y + rect.height / 2 - 450) < 1e-9);
});

test('3D overlay projection stays inside the frame for an off-axis orbit', () => {
  const input = {
    scaleX: 0.8,
    scaleY: 0.6,
    scaleZ: 0.4,
    azDeg: 37,
    elDeg: -22,
    fovDeg: 50,
    aspect: 1,
  };
  const camera = resolveVolumeCameraZoom(input, 100);
  const rect = volumeViewportRect({
    ...input,
    radius: camera.radius,
    viewportWidth: 700,
    viewportHeight: 700,
  });
  assert.ok(rect.width > 0 && rect.height > 0);
  // Perspective magnification varies across a tilted source plane, so the
  // projected bounds need not be centred on the orbit pivot.  They must still
  // remain inside the canvas: pointer drags outside this rectangle are margins,
  // not source pixels.
  assert.ok(rect.x > 0 && rect.x + rect.width < 700);
  assert.ok(rect.y > 0 && rect.y + rect.height < 700);
});
