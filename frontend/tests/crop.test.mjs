import assert from 'node:assert/strict';
import test from 'node:test';

const {
  cropPlane,
  cropRectForFrame,
  cropRectForCapture,
  cropRectFromNormalized,
  cropRectFromPoints,
  cropRectToNormalized,
  fitCropViewport,
  fullCrop,
  normalizeCropRect,
} = await import('../src/utils/crop.ts');

test('2D crop fit centers an offset rectangle and respects aspect and zoom caps', () => {
  assert.deepEqual(
    fitCropViewport({ x: 25, y: 10, width: 50, height: 20 }, 100, 80, 400, 200),
    { zoom: 8, panX: 0, panY: 160 },
  );
  assert.deepEqual(
    fitCropViewport({ x: 0, y: 0, width: 1, height: 1 }, 100, 80, 1000, 1000),
    { zoom: 50, panX: 2475, panY: 1975 },
  );
  assert.throws(
    () => fitCropViewport({ x: 90, y: 0, width: 20, height: 10 }, 100, 80, 400, 200),
    /表示領域へ合わせられません/,
  );
});
const {
  SCALEBAR_BLOCK_H,
  planCroppedScalebar,
  scalebarLabelWidth,
} = await import('../src/utils/scalebar.ts');

test('full crop covers the complete source image', () => {
  assert.deepEqual(fullCrop({ width: 8, height: 5 }), {
    x: 0, y: 0, width: 8, height: 5,
  });
});

test('crop rectangle clamps to image bounds and rounds outward', () => {
  assert.deepEqual(normalizeCropRect({ x: -2.2, y: 1.2, width: 5.1, height: 8.1 }, {
    width: 8, height: 5,
  }), { x: 0, y: 1, width: 3, height: 4 });
  assert.deepEqual(normalizeCropRect({ x: 6.7, y: 3.8, width: 0, height: 0 }, {
    width: 8, height: 5,
  }), { x: 6, y: 3, width: 1, height: 1 });
});

test('dragging in any direction produces the same source rectangle', () => {
  assert.deepEqual(
    cropRectFromPoints({ x: 7.8, y: 6.4 }, { x: 2.1, y: 1.2 }, { width: 10, height: 10 }),
    cropRectFromPoints({ x: 2.1, y: 1.2 }, { x: 7.8, y: 6.4 }, { width: 10, height: 10 }),
  );
});

test('normalized crop state round-trips to the same pixel edges', () => {
  const source = { width: 640, height: 480 };
  const rect = { x: 80, y: 40, width: 320, height: 240 };
  const normalized = cropRectToNormalized(rect, source);
  assert.deepEqual(normalized, { x: 0.125, y: 1 / 12, width: 0.5, height: 0.5 });
  assert.deepEqual(cropRectFromNormalized(normalized, source), rect);
});

test('3D frame crop preserves the selected normalized fraction', () => {
  assert.deepEqual(cropRectForFrame(null, 100, 80, 600, 400), {
    x: 0, y: 0, width: 600, height: 400,
  });
  assert.deepEqual(cropRectForFrame({ x: 25, y: 20, width: 50, height: 40 }, 100, 80, 600, 400), {
    x: 150, y: 100, width: 300, height: 200,
  });
  assert.throws(
    () => cropRectForFrame({ x: 90, y: 0, width: 20, height: 10 }, 100, 80, 600, 400),
    /クロップ範囲が画像の範囲外です/,
  );
});

test('a 3D display-fit frame is not cropped a second time on save', () => {
  assert.deepEqual(
    cropRectForCapture({ x: 25, y: 20, width: 50, height: 40 }, 100, 80, 600, 400, true),
    { x: 0, y: 0, width: 600, height: 400 },
  );
  assert.deepEqual(
    cropRectForCapture({ x: 25, y: 20, width: 50, height: 40 }, 100, 80, 600, 400),
    { x: 150, y: 100, width: 300, height: 200 },
  );
});

test('cropped 3D scale bar auto-shortens at the same physical scale', () => {
  const unchanged = planCroppedScalebar({ um: 20, px: 40 }, 100, 80, 1, null);
  assert.equal(unchanged.um, 20);
  assert.equal(unchanged.px, 40);

  const plan = planCroppedScalebar(
    { um: 100, px: 200 },
    120,
    80,
    1,
    null,
  );
  assert.equal(plan.um, 20);
  assert.equal(plan.px, 40);
  assert.ok(Math.max(plan.px, plan.labelWidthPx) <= 120 - 2 * plan.padPx);
  assert.ok(80 - 2 * plan.padPx >= SCALEBAR_BLOCK_H);
});

test('cropped 3D scale bar refuses an explicit length or label that would clip', () => {
  assert.throws(
    () => planCroppedScalebar({ um: 100, px: 200 }, 120, 80, 1, 100),
    /指定したスケールバー.*収まりません/,
  );
  const labelWidth = scalebarLabelWidth(1, 1);
  assert.ok(labelWidth > 0);
  assert.throws(
    () => planCroppedScalebar({ um: 1, px: 10 }, 40, 80, 1, 1),
    /指定したスケールバー.*収まりません/,
  );
  assert.throws(
    () => planCroppedScalebar({ um: 1, px: 10 }, 120, 45, 1, 1),
    /狭すぎる/,
  );
});

test('cropped 3D scale bar accounts for export scale and inner padding', () => {
  const plan = planCroppedScalebar({ um: 10, px: 50 }, 180, 100, 2, 10, 10);
  assert.equal(plan.padPx, 20);
  assert.equal(plan.labelWidthPx, scalebarLabelWidth(10, 2));
  assert.ok(Math.max(plan.px * 2, plan.labelWidthPx) <= 180 - 40);
  // Padding is part of the safety contract: an explicit length is not silently
  // shortened when increasing it leaves no room for the bar.
  assert.throws(
    () => planCroppedScalebar({ um: 10, px: 50 }, 180, 200, 2, 10, 40),
    /指定したスケールバー.*収まりません/,
  );
});

test('cropPlane extracts rows without changing source data', () => {
  const data = Uint16Array.from({ length: 5 * 4 }, (_, i) => i);
  const output = cropPlane(data, 5, 4, { x: 1, y: 1, width: 3, height: 2 });
  assert.deepEqual([...output], [6, 7, 8, 11, 12, 13]);
  assert.equal(data[6], 6);
  assert.throws(() => cropPlane(new Uint16Array(3), 5, 4, fullCrop({ width: 5, height: 4 })), /expected at least 20/);
});
