import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
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
  cropOwnerForMetadata,
  cropOwnerMatchesMetadata,
  useViewStore,
} = await import('../src/stores/viewStore.ts');

beforeEach(() => {
  useViewStore.setState(useViewStore.getInitialState(), true);
});

test('crop selection is stored independently and rejects degenerate rectangles', () => {
  const store = useViewStore.getState();
  store.setCropRect({ x: -4, y: 3, width: 120, height: 80 });
  assert.deepEqual(useViewStore.getState().cropRect, { x: 0, y: 3, width: 120, height: 80 });

  store.setCropRect({ x: 10, y: 12, width: 0, height: 80 });
  assert.equal(useViewStore.getState().cropRect, null);
  store.setCropRect(null);
  assert.equal(useViewStore.getState().cropRect, null);
});

test('activating crop editing disables ROI drawing without changing the selection', () => {
  const store = useViewStore.getState();
  store.setRoiTool('rect');
  store.setDrawingRoi({ type: 'rect', params: { x: 1, y: 2, width: 3, height: 4 } });
  store.setCropRect({ x: 4, y: 5, width: 20, height: 30 });
  store.setCropActive(true);
  assert.equal(useViewStore.getState().cropActive, true);
  assert.equal(useViewStore.getState().roiTool, 'none');
  assert.equal(useViewStore.getState().drawingRoi, null);
  assert.deepEqual(useViewStore.getState().cropRect, { x: 4, y: 5, width: 20, height: 30 });

  store.setCropActive(false);
  assert.equal(useViewStore.getState().cropActive, false);
  assert.deepEqual(useViewStore.getState().cropRect, { x: 4, y: 5, width: 20, height: 30 });
  store.resetCrop();
  assert.equal(useViewStore.getState().cropRect, null);
});

test('closing crop panel also releases pointer editing without clearing selection', () => {
  const store = useViewStore.getState();
  store.setCropRect({ x: 4, y: 5, width: 20, height: 30 });
  store.setCropPanelOpen(true);
  assert.equal(useViewStore.getState().cropPanelOpen, true);
  assert.equal(useViewStore.getState().cropActive, false);

  store.setCropActive(true);
  store.setCropPanelOpen(false);
  assert.equal(useViewStore.getState().cropPanelOpen, false);
  assert.equal(useViewStore.getState().cropActive, false);
  assert.deepEqual(useViewStore.getState().cropRect, { x: 4, y: 5, width: 20, height: 30 });
});

test('crop fit request freezes its exact rectangle and reset cancels it', () => {
  const metadata = {
    source_identity: 'sha-fit', source_revision: 'rev-fit', width: 100, height: 80,
  };
  const owner = cropOwnerForMetadata('image-fit', metadata);
  assert.ok(owner);
  const store = useViewStore.getState();
  store.setCropRect({ x: 4, y: 5, width: 20, height: 30 }, owner);
  store.requestCropFit(owner);
  assert.deepEqual(useViewStore.getState().cropFitRequest?.rect, {
    x: 4, y: 5, width: 20, height: 30,
  });
  store.setCropRect({ x: 8, y: 10, width: 40, height: 20 }, owner);
  assert.deepEqual(useViewStore.getState().cropFitRequest?.rect, {
    x: 4, y: 5, width: 20, height: 30,
  });
  store.resetCrop();
  assert.equal(useViewStore.getState().cropFitRequest, null);
});

test('crop selection is owned by the exact active source, not just its dimensions', () => {
  const metadata = {
    source_identity: 'sha-a', source_revision: 'rev-a', width: 100, height: 80,
  };
  const owner = cropOwnerForMetadata('image-a', metadata);
  assert.ok(owner);
  const store = useViewStore.getState();
  store.setCropRect({ x: 4, y: 5, width: 20, height: 30 }, owner);
  assert.equal(useViewStore.getState().cropOwner?.key, owner.key);
  assert.equal(cropOwnerMatchesMetadata(owner, 'image-a', metadata), true);
  assert.equal(cropOwnerMatchesMetadata(owner, 'image-b', { ...metadata, source_identity: 'sha-b' }), false);
  assert.equal(cropOwnerMatchesMetadata(owner, 'image-a', { ...metadata, width: 100, height: 81 }), false);
  store.setCropPanelOpen(true);
  store.setCropActive(true);
  store.setCropPanelOpen(false);
  assert.equal(useViewStore.getState().cropActive, false);
});

test('crop panel completion can request a one-shot 2D fit for its owner', () => {
  const owner = cropOwnerForMetadata('image-a', {
    source_identity: 'sha-a', source_revision: 'rev-a', width: 100, height: 80,
  });
  assert.ok(owner);
  useViewStore.getState().setCropRect({ x: 20, y: 10, width: 40, height: 30 }, owner);
  useViewStore.getState().requestCropFit(owner);
  const request = useViewStore.getState().cropFitRequest;
  assert.deepEqual(request, {
    sequence: 1,
    ownerKey: owner.key,
    rect: { x: 20, y: 10, width: 40, height: 30 },
  });
  useViewStore.getState().consumeCropFit(request.sequence);
  assert.equal(useViewStore.getState().cropFitRequest, null);
});

test('3D viewport stays pinned and crop settings dock beside the image', () => {
  const viewer = readFileSync(new URL('../src/components/Volume3DViewer.tsx', import.meta.url), 'utf8');
  const controls = readFileSync(new URL('../src/components/CropControls.tsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../src/components/CropSettingsPanel.tsx', import.meta.url), 'utf8');
  const overlay = readFileSync(new URL('../src/components/CropOverlay.tsx', import.meta.url), 'utf8');
  const save = readFileSync(new URL('../src/components/SaveDialog.tsx', import.meta.url), 'utf8');
  const projection = readFileSync(new URL('../src/components/ProjectionDialog.tsx', import.meta.url), 'utf8');

  // `absolute` and `relative` on the same viewport wrapper made the final
  // utility order browser-dependent and collapsed the WebGL canvas height.
  assert.match(viewer, /className="absolute inset-y-0 left-0 right-\[238px\] min-w-0 overflow-hidden"/);
  assert.doesNotMatch(viewer, /className="absolute inset-y-0 left-0 right-\[238px\] min-w-0 overflow-hidden relative"/);

  // The toolbar now only toggles the crop state. The editor is a normal flex
  // sibling in the main workspace, so its width pushes the image aside rather
  // than covering it at wide desktop sizes.
  assert.doesNotMatch(controls, /data-crop-popover|top-full|right-full/);
  assert.match(app, /data-main-workspace className="flex flex-1 overflow-hidden"/);
  assert.match(app, /cropPanelOpen && \(viewMode === '2d' \|\| viewMode === '3d'\)/);
  assert.match(app, /<CropSettingsPanel metadata=\{metadata\} \/>/);
  assert.match(panel, /data-crop-settings-panel/);
  assert.match(panel, /画像上でドラッグして範囲を決定する/);
  assert.match(panel, /aria-pressed=\{cropActive\}/);
  assert.match(panel, /setCropActive\(false\);\s*setCropPanelOpen\(false\)/);
  assert.match(panel, /requestCropFit\(owner\)/);
  assert.match(panel, /bg-\[var\(--accent\)\]/);
  assert.match(controls, /if \(opening\).*if \(ownerMatches\) setCropActive\(true\)/s);
  assert.match(controls, /else \{\s*setCropActive\(false\);/);
  assert.match(controls, /if \(ownerMatches\) setCropActive\(true\)/);
  assert.match(controls, /disabled=\{!usable \|\| threeDSaveBusy\}/);
  assert.doesNotMatch(controls, /disabled=\{!sourceUsable/);
  assert.match(overlay, /setCropRect\(next, currentOwner\)/);
  assert.match(overlay, /pointerEvents: canEdit \? 'all' : 'none'/);
  assert.match(save, /imageOperationIsBusy\(\)/);
  assert.match(save, /cropOwnerMatchesMetadata\(currentView\.cropOwner/);
  assert.match(projection, /imageOperationIsBusy\(\)/);
  assert.match(projection, /cropOwnerMatchesMetadata\(currentView\.cropOwner/);
  assert.match(readFileSync(new URL('../src/components/Viewport.tsx', import.meta.url), 'utf8'), /cropFitRequest/);
  assert.match(panel, /w-64 shrink-0 overflow-y-auto/);
});
