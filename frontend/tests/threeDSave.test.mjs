import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  completedSavePercent,
  ownsThreeDSaveCrop,
  ThreeDSaveGuard,
} from '../src/utils/threeDSave.ts';

test('capture phases leave the final percentage for the filesystem write', () => {
  // MERGE + four channels + one all-or-nothing write.
  assert.deepEqual(
    Array.from({ length: 7 }, (_, completed) => completedSavePercent(completed, 6)),
    [0, 17, 33, 50, 67, 83, 100],
  );
});

test('save progress is bounded and empty work never claims completion', () => {
  assert.equal(completedSavePercent(-1, 2), 0);
  assert.equal(completedSavePercent(3, 2), 100);
  assert.equal(completedSavePercent(1, 0), 0);
});

test('one save owns one view revision and a second run cannot interleave', () => {
  const guard = new ThreeDSaveGuard();
  const first = guard.begin(7);
  assert.ok(first);
  assert.equal(guard.isLocked, true);
  assert.equal(guard.begin(7), null);
  assert.equal(guard.owns(first, 7), true);
  assert.equal(guard.owns(first, 8), false);

  guard.finish(first);
  const second = guard.begin(8);
  assert.ok(second);
  assert.notEqual(second.token, first.token);
  // A stale completion cannot release the current run.
  guard.finish(first);
  assert.equal(guard.isLocked, true);
  guard.finish(second);
  assert.equal(guard.isLocked, false);
});

test('one 3D save freezes one crop for every MERGE/channel frame', () => {
  const guard = new ThreeDSaveGuard();
  const crop = { x: 10, y: 20, width: 300, height: 240 };
  const owner = {
    imageId: 'image-a',
    sourceIdentity: 'identity-a',
    sourceRevision: 'revision-a',
    width: 640,
    height: 480,
  };
  const snapshot = guard.begin(11, crop, owner);
  assert.ok(snapshot);
  assert.deepEqual(snapshot.cropRect, crop);
  assert.deepEqual(snapshot.cropOwner, owner);
  crop.width = 1;
  assert.equal(snapshot.cropRect.width, 300);

  // Every frame reads the copied snapshot, not a mutable store object.
  const frames = [snapshot.cropRect, snapshot.cropRect, snapshot.cropRect];
  const frozen = { x: 10, y: 20, width: 300, height: 240 };
  assert.deepEqual(frames, [frozen, frozen, frozen]);
  assert.equal(ownsThreeDSaveCrop(snapshot, frozen, owner), true);
  assert.equal(
    ownsThreeDSaveCrop(snapshot, { ...crop, width: crop.width - 1 }, owner),
    false,
  );
  assert.equal(
    ownsThreeDSaveCrop(snapshot, crop, { ...owner, sourceRevision: 'revision-b' }),
    false,
  );
  const published = [];
  if (ownsThreeDSaveCrop(snapshot, { ...frozen, x: 11 }, owner)) {
    published.push('must-not-publish');
  }
  assert.deepEqual(published, []);
  guard.finish(snapshot);
});

test('3D capture aborts before publication on crop/source mismatch', () => {
  const viewer = readFileSync(new URL('../src/components/Volume3DViewer.tsx', import.meta.url), 'utf8');
  assert.match(viewer, /assertThreeDSaveCrop\(saveSnapshot\)/);
  assert.match(viewer, /cropRectForCapture\(\s*saveSnapshot\.cropRect/);
  assert.match(viewer, /sameThreeDSaveCropRect\(request\.rect, cropRect\)/);
  assert.doesNotMatch(viewer, /const cropState = useViewStore\.getState\(\)/);
  const publish = viewer.indexOf('const res = await saveRender');
  const finalAssert = viewer.lastIndexOf('assertThreeDSaveCrop(saveSnapshot)', publish);
  assert.ok(publish > 0 && finalAssert > 0 && finalAssert < publish);
});

test('completed 3D crop fits the display and avoids a second capture crop', () => {
  const viewer = readFileSync(new URL('../src/components/Volume3DViewer.tsx', import.meta.url), 'utf8');
  const shader = readFileSync(new URL('../src/utils/volumeShader.ts', import.meta.url), 'utf8');
  const plate = readFileSync(new URL('../src/utils/plateRender.ts', import.meta.url), 'utf8');
  assert.match(viewer, /volumeCameraCropFit\(/);
  assert.match(viewer, /cropPanelOpen/);
  assert.match(viewer, /orbit\.current\.az = 0/);
  assert.match(viewer, /orbit\.current\.el = 0/);
  assert.match(viewer, /previousCropPanelOpenRef/);
  assert.match(viewer, /cropPanelOpen && \(\s*<CropOverlay/);
  assert.match(viewer, /volumeViewportRect\(/);
  assert.match(viewer, /fitRect=\{cropViewportRect \?\? undefined\}/);
  assert.match(viewer, /renderedRect=\{cropViewportRect/);
  assert.match(readFileSync(new URL('../src/components/ScalebarOverlay.tsx', import.meta.url), 'utf8'), /renderedRect/);
  assert.match(viewer, /displayFitted && cropViewportRect/);
  assert.match(viewer, /if \(cropPanelOpen\) \{\s*orbit\.current\.az = 0;\s*orbit\.current\.el = 0;/);
  assert.match(viewer, /\}, \[activeImageId, cropPanelOpen\]\);/);
  assert.match(viewer, /setVolume3D\(\{\s*az,\s*el/);
  assert.match(readFileSync(new URL('../src/components/CropSettingsPanel.tsx', import.meta.url), 'utf8'), /viewMode === '2d' \|\| viewMode === '3d'/);
  assert.match(viewer, /cropRectForCapture\(/);
  assert.match(viewer, /displayCropMatchesSnapshot\(displayCropFitRef\.current, saveSnapshot\)/);
  assert.match(shader, /uniform vec2 uCropMin/);
  assert.match(shader, /uniform vec2 uCropMax/);
  assert.match(shader, /samplePos\.x < uCropMin\.x/);
  assert.match(plate, /uCropMin: \{ value: new THREE\.Vector2\(0, 0\) \}/);
  assert.match(plate, /uCropMax: \{ value: new THREE\.Vector2\(1, 1\) \}/);
});
