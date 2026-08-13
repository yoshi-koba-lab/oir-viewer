import assert from 'node:assert/strict';
import test from 'node:test';

const {
  cropPlane,
  cropRectForFrame,
  cropRectForCapture,
  cropRectFromDragPoints,
  cropRectFromNormalized,
  cropRectFromPoints,
  cropRectToNormalized,
  fitCropViewport,
  fullCrop,
  moveCropRect,
  normalizeCropRect,
  resizeCropRect,
  sourcePointFromClient,
  clientPointFromSource,
} = await import('../src/utils/crop.ts');

test('2D crop geometry uses the rendered canvas CSS frame for both axes', () => {
  // The canvas can be narrower than its flex wrapper while a dock/panel is
  // opening.  A square drag on the visible canvas must remain square in source
  // pixels; using the wrapper rect makes the overlay and renderer disagree.
  const frame = { left: 37, top: 19, width: 640, height: 360 };
  const source = { width: 1600, height: 900 };
  const state = { zoom: 0.4, panX: 12, panY: -8 };
  const start = clientPointFromSource(300, 200, frame, source.width, source.height, state.zoom, state.panX, state.panY);
  const end = clientPointFromSource(800, 700, frame, source.width, source.height, state.zoom, state.panX, state.panY);
  const a = sourcePointFromClient(start.x, start.y, frame, source.width, source.height, state.zoom, state.panX, state.panY);
  const b = sourcePointFromClient(end.x, end.y, frame, source.width, source.height, state.zoom, state.panX, state.panY);
  assert.deepEqual({ x: b.x - a.x, y: b.y - a.y }, { x: 500, y: 500 });
});

test('regression: a square canvas drag cannot become a vertical crop at a wrapper mismatch', () => {
  // Reproduces the reported export shape: during the dock transition the
  // outer flex wrapper was wider/taller than the canvas that actually painted
  // the image. The old overlay mapped against that wrapper, clipping only the
  // X edge and turning a 100×100 CSS-pixel drag into 100×200 source pixels.
  const canvas = { left: 0, top: 0, width: 600, height: 300 };
  const wrapper = { left: 0, top: 0, width: 1200, height: 400 };
  const source = { width: 1200, height: 600 };
  const start = clientPointFromSource(500, 100, canvas, source.width, source.height, 0.5, 0, 0);
  const end = clientPointFromSource(700, 300, canvas, source.width, source.height, 0.5, 0, 0);
  const fixedStart = sourcePointFromClient(start.x, start.y, canvas, source.width, source.height, 0.5, 0, 0);
  const fixedEnd = sourcePointFromClient(end.x, end.y, canvas, source.width, source.height, 0.5, 0, 0);
  const legacyStart = sourcePointFromClient(start.x, start.y, wrapper, source.width, source.height, 0.5, 0, 0);
  const legacyEnd = sourcePointFromClient(end.x, end.y, wrapper, source.width, source.height, 0.5, 0, 0);
  assert.deepEqual(
    { width: fixedEnd.x - fixedStart.x, height: fixedEnd.y - fixedStart.y },
    { width: 200, height: 200 },
  );
  assert.deepEqual(
    { width: legacyEnd.x - legacyStart.x, height: legacyEnd.y - legacyStart.y },
    { width: 100, height: 200 },
  );
});

test('screen/source transforms round-trip across aspect ratios, zoom and pan', () => {
  const cases = [
    { source: [640, 480], frame: { left: 12, top: 27, width: 1200, height: 700 }, zoom: 1.25, pan: [37, -19] },
    { source: [1600, 400], frame: { left: 81, top: 9, width: 500, height: 900 }, zoom: 0.35, pan: [-80, 123] },
    { source: [97, 131], frame: { left: 0, top: 0, width: 333, height: 271 }, zoom: 4.75, pan: [-31, 42] },
  ];
  for (const { source: [width, height], frame, zoom, pan: [panX, panY] } of cases) {
    for (const point of [
      [0, 0], [width, height], [Math.floor(width * 0.37), Math.floor(height * 0.63)],
    ]) {
      const screen = clientPointFromSource(point[0], point[1], frame, width, height, zoom, panX, panY);
      const roundTrip = sourcePointFromClient(screen.x, screen.y, frame, width, height, zoom, panX, panY);
      assert.ok(Math.abs(roundTrip.x - point[0]) <= 1, `${JSON.stringify({ frame, point, screen, roundTrip })}`);
      assert.ok(Math.abs(roundTrip.y - point[1]) <= 1, `${JSON.stringify({ frame, point, screen, roundTrip })}`);
    }
  }
});

test('fit-to-canvas source mapping uses CSS pixels, not device pixels', () => {
  const frame = { left: 37, top: 19, width: 801, height: 603 };
  const source = [1000, 500];
  const point = [375, 220];
  const screen = clientPointFromSource(point[0], point[1], frame, source[0], source[1], 1, 0, 0, true);
  assert.deepEqual(sourcePointFromClient(screen.x, screen.y, frame, source[0], source[1], 1, 0, 0, true), { x: point[0], y: point[1] });
  // A DPR-scaled backing store leaves the CSS frame and pointer coordinates unchanged.
  for (const dpr of [1, 1.5, 2, 3]) {
    assert.deepEqual(sourcePointFromClient(screen.x, screen.y, frame, source[0], source[1], 1, 0, 0, true), { x: point[0], y: point[1] }, `dpr=${dpr}`);
  }
  assert.deepEqual(sourcePointFromClient(frame.left, frame.top, frame, source[0], source[1], 1, 0, 0, true), { x: 0, y: 0 });
  assert.deepEqual(sourcePointFromClient(frame.left + frame.width, frame.top + frame.height, frame, source[0], source[1], 1, 0, 0, true), { x: 1000, y: 500 });
});

test('fit-to-canvas mapping honors a projected source-plane rectangle and its margins', () => {
  const frame = { left: 100, top: 50, width: 1200, height: 700 };
  const fitRect = { x: 100, y: 200, width: 1000, height: 300 };
  const source = [1000, 500];
  const transform = [source[0], source[1], 1, 0, 0, true, fitRect];
  const center = clientPointFromSource(500, 250, frame, ...transform);
  assert.deepEqual(center, { x: 700, y: 400 });
  assert.deepEqual(sourcePointFromClient(center.x, center.y, frame, ...transform), { x: 500, y: 250 });
  // Pointer positions in the letterboxed margins clamp to the nearest source edge.
  assert.deepEqual(sourcePointFromClient(frame.left + fitRect.x - 20, center.y, frame, ...transform), { x: 0, y: 250 });
  assert.deepEqual(sourcePointFromClient(frame.left + fitRect.x + fitRect.width + 20, center.y, frame, ...transform), { x: 1000, y: 250 });
});

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

test('interactive drag, move and all eight resize handles stay in bounds', () => {
  const width = 100;
  const height = 80;
  const base = { x: 30, y: 25, width: 40, height: 30 };
  assert.deepEqual(cropRectFromDragPoints({ x: 90, y: 70 }, { x: 10, y: 5 }, width, height), {
    x: 10, y: 5, width: 80, height: 65,
  });
  assert.deepEqual(cropRectFromDragPoints({ x: -10, y: 20 }, { x: 0, y: 20 }, width, height), {
    x: 0, y: 20, width: 1, height: 1,
  });
  assert.deepEqual(moveCropRect(base, 100, -100, width, height), {
    x: 60, y: 0, width: 40, height: 30,
  });
  for (const handle of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    const resized = resizeCropRect(base, handle, { x: 0, y: 0 }, width, height);
    assert.ok(resized.width >= 1 && resized.height >= 1, `${handle} minimum size`);
    assert.ok(resized.x >= 0 && resized.y >= 0, `${handle} top-left`);
    assert.ok(resized.x + resized.width <= width && resized.y + resized.height <= height, `${handle} bounds`);
  }
  // A handle cannot cross its opposite edge; it clamps at one source pixel.
  assert.deepEqual(resizeCropRect(base, 'e', { x: -20, y: 0 }, width, height), {
    x: 30, y: 25, width: 1, height: 30,
  });
  assert.deepEqual(resizeCropRect(base, 'nw', { x: 1000, y: 1000 }, width, height), {
    x: 69, y: 54, width: 1, height: 1,
  });
});

test('fitCropViewport centers the selected crop in the viewport', () => {
  const source = { width: 800, height: 600 };
  const frame = { left: 0, top: 0, width: 1000, height: 700 };
  const crop = { x: 120, y: 90, width: 360, height: 180 };
  const fit = fitCropViewport(crop, source.width, source.height, frame.width, frame.height);
  const center = clientPointFromSource(crop.x + crop.width / 2, crop.y + crop.height / 2,
    frame, source.width, source.height, fit.zoom, fit.panX, fit.panY);
  assert.ok(center);
  assert.ok(Math.abs(center.x - frame.width / 2) < 1e-9);
  assert.ok(Math.abs(center.y - frame.height / 2) < 1e-9);
  const topLeft = clientPointFromSource(crop.x, crop.y, frame, source.width, source.height, fit.zoom, fit.panX, fit.panY);
  const bottomRight = clientPointFromSource(crop.x + crop.width, crop.y + crop.height,
    frame, source.width, source.height, fit.zoom, fit.panX, fit.panY);
  assert.ok(bottomRight.x - topLeft.x <= frame.width + 1e-9);
  assert.ok(bottomRight.y - topLeft.y <= frame.height + 1e-9);
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
