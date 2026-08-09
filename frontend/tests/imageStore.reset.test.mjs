import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
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

const { useImageStore } = await import('../src/stores/imageStore.ts');
const {
  applyChannelResponseIfCurrent,
  captureChannelRequest,
} = await import('../src/hooks/useImageLoader.ts');

beforeEach(() => {
  useImageStore.setState(useImageStore.getInitialState(), true);
});

function initialiseFreshImage() {
  const store = useImageStore.getState();
  store.setActiveImageId('source');
  store.setMetadata({
    filename: 'source.oir',
    source_path: '/data/source.oir',
    source_identity: 'source-id',
    source_revision: 'source-rev',
    num_channels: 2,
    num_z: 3,
    num_t: 2,
    width: 2,
    height: 2,
    pixel_size_x: 1,
    pixel_size_y: 1,
    pixel_size_z: 1,
    channel_names: ['GFP', 'DIC'],
    channel_types: ['fluorescence', 'transmitted'],
    channel_colors: [[11, 22, 33], []],
    channel_ranges: [[100, 1000], []],
    bit_depth: 12,
  });
  store.initChannels(2);
  store.setProjection({ active: false, method: 'max', zFrom: 0, zTo: 2 });
  const first = new Uint16Array([1, 2, 3, 4]);
  const second = new Uint16Array([5, 6, 7, 8]);
  store.setChannelData(0, first, 10, 200);
  store.setChannelData(1, second, 20, 300);
  store.captureSourceDefaults();
  return { first, second };
}

test('reset reproduces the fresh file view and keeps the already-correct Z0/T0 pixels', () => {
  const { first, second } = initialiseFreshImage();
  let store = useImageStore.getState();

  assert.deepEqual(store.sourceViewDefaults.source.channels.map((channel) => ({
    color: channel.color,
    min: channel.min,
    max: channel.max,
    visible: channel.visible,
  })), [
    { color: [11, 22, 33], min: 100, max: 1000, visible: true },
    { color: [180, 180, 180], min: 20, max: 300, visible: false },
  ]);

  store.setChannelColor(0, [255, 0, 0]);
  store.setChannelRange(0, 400, 500);
  store.toggleChannel(0);
  store.setChannelColor(1, [0, 255, 0]);
  store.setChannelRange(1, 50, 60);
  store.toggleChannel(1);
  // A second capture must not turn user edits into the new definition of source.
  store.captureSourceDefaults();

  assert.equal(useImageStore.getState().resetActiveImageToSource(), true);
  store = useImageStore.getState();
  assert.deepEqual(store.channels.map((channel) => ({
    color: channel.color,
    min: channel.min,
    max: channel.max,
    visible: channel.visible,
  })), [
    { color: [11, 22, 33], min: 100, max: 1000, visible: true },
    { color: [180, 180, 180], min: 20, max: 300, visible: false },
  ]);
  assert.equal(store.channels[0].data, first);
  assert.equal(store.channels[1].data, second);
  assert.equal(store.imageViewStates.source.channels[0].data, null);
  assert.equal(store.imageViewStates.source.channels[1].data, null);
});

test('reset clears every per-image 2D position/projection but preserves the 3D camera', () => {
  initialiseFreshImage();
  let store = useImageStore.getState();
  store.setCurrentZ(2);
  store.setCurrentT(1);
  store.setShowMIP(true);
  store.setProjection({ active: true, method: 'avg', zFrom: 1, zTo: 2 });
  store.setVolume3D({ az: 37, el: -9, radius: 3.5, zStart: 2, zEnd: 3, zTotal: 3 });

  assert.equal(useImageStore.getState().resetActiveImageToSource(), true);
  store = useImageStore.getState();
  assert.equal(store.currentZ, 0);
  assert.equal(store.currentT, 0);
  assert.equal(store.showMIP, false);
  assert.deepEqual(store.projection, { active: false, method: 'max', zFrom: 0, zTo: 2 });
  assert.deepEqual(store.volume3D, {
    az: 37, el: -9, radius: 3.5, zoomPercent: 100, zStart: 2, zEnd: 3, zTotal: 3,
  });
  assert.equal(store.channels[0].data, null);
  assert.deepEqual(store.imageViewStates.source.volume3D, store.volume3D);

  // The UI reset handler explicitly reloads Z0/T0. Incoming pixels must attach
  // without replacing the source baseline with their auto window.
  const reloaded = new Uint16Array([9, 10, 11, 12]);
  store.setChannelData(0, reloaded, 5, 50);
  store = useImageStore.getState();
  assert.equal(store.channels[0].data, reloaded);
  assert.equal(store.channels[0].min, 100);
  assert.equal(store.channels[0].max, 1000);
});

test('3D reset restores the fresh camera and full slab as well as the source LUT', () => {
  initialiseFreshImage();
  const baseline = structuredClone(useImageStore.getState().sourceViewDefaults.source.volume3D);
  useImageStore.getState().setVolume3D({
    az: 123, el: -34, radius: 6, zStart: 2, zEnd: 2, zTotal: 3,
  });
  useImageStore.getState().setChannelRange(0, 400, 500);

  assert.equal(useImageStore.getState().resetActiveImageToSource(true), true);
  const store = useImageStore.getState();
  assert.deepEqual(store.volume3D, baseline);
  assert.deepEqual(store.imageViewStates.source.volume3D, baseline);
  assert.equal(store.channels[0].min, 100);
  assert.equal(store.channels[0].max, 1000);
});

test('reset is unavailable until an exact fresh baseline has been captured', () => {
  const store = useImageStore.getState();
  store.setActiveImageId('uncaptured');
  assert.equal(store.resetActiveImageToSource(), false);
});

test('a saved coordinate and its verified pixels are published in one store transition', () => {
  initialiseFreshImage();
  const metadata = {
    ...useImageStore.getState().metadata,
    id: 'restored',
    filename: 'restored.oir',
    source_path: '/data/restored.oir',
    source_identity: 'restored-id',
    source_revision: 'restored-rev',
    num_z: 4,
    num_t: 3,
  };
  const source0 = new Uint16Array([1, 2, 3, 4]);
  const source1 = new Uint16Array([5, 6, 7, 8]);
  const target0 = new Uint16Array([101, 102, 103, 104]);
  const target1 = new Uint16Array([201, 202, 203, 204]);
  const notifications = [];
  const unsubscribe = useImageStore.subscribe((state) => {
    notifications.push({
      id: state.activeImageId,
      z: state.currentZ,
      t: state.currentT,
      mip: state.showMIP,
      firstPixel: state.channels[0]?.data?.[0],
    });
  });

  useImageStore.getState().presentPreparedImage({
    id: 'restored',
    metadata,
    sourceResponse: {
      channels: [
        { channel: 0, data: source0, auto_min: 10, auto_max: 20 },
        { channel: 1, data: source1, auto_min: 30, auto_max: 40 },
      ],
    },
    targetResponse: {
      channels: [
        { channel: 0, data: target0, auto_min: 100, auto_max: 200 },
        { channel: 1, data: target1, auto_min: 300, auto_max: 400 },
      ],
    },
    view: {
      currentZ: 2,
      currentT: 1,
      showMIP: true,
      projection: { active: false, method: 'max', zFrom: 0, zTo: 3 },
    },
    persistedSettings: {
      channels: [
        { color: [255, 0, 0], min: 400, max: 500, visible: true },
        { color: [0, 255, 0], min: 50, max: 60, visible: false },
      ],
      currentZ: 2,
      currentT: 1,
      showMIP: true,
    },
  });
  unsubscribe();

  assert.deepEqual(notifications, [
    { id: 'restored', z: 2, t: 1, mip: true, firstPixel: 101 },
  ]);
  const state = useImageStore.getState();
  assert.equal(state.channels[0].data, target0);
  assert.equal(state.channels[1].data, target1);
  assert.equal(state.channels[0].min, 400);
  assert.equal(state.channels[0].max, 500);
  assert.equal(state.sourceViewDefaults.restored.channels[0].data, null);
  assert.equal(state.sourceViewDefaults.restored.channels[0].min, 100);
  assert.equal(state.sourceViewDefaults.restored.channels[0].max, 1000);
  assert.equal(state.sourceViewDefaults.restored.channels[1].min, 30);
  assert.equal(state.sourceViewDefaults.restored.channels[1].max, 40);
});

test('a partial prepared response is rejected before active image state changes', () => {
  initialiseFreshImage();
  const before = useImageStore.getState();
  const metadata = { ...before.metadata, id: 'partial' };
  const onePlane = new Uint16Array([1, 2, 3, 4]);
  assert.throws(() => useImageStore.getState().presentPreparedImage({
    id: 'partial',
    metadata,
    sourceResponse: {
      channels: [{ channel: 0, data: onePlane, auto_min: 1, auto_max: 4 }],
    },
    targetResponse: {
      channels: [{ channel: 0, data: onePlane, auto_min: 1, auto_max: 4 }],
    },
    view: {
      currentZ: 0,
      currentT: 0,
      showMIP: false,
      projection: { active: false, method: 'max', zFrom: 0, zTo: 2 },
    },
  }), /expected 2 channels, got 1/);
  assert.equal(useImageStore.getState().activeImageId, 'source');
  assert.equal(useImageStore.getState().metadata.source_identity, 'source-id');
});

test('the outgoing source guard captures edits made during a slow replacement load', () => {
  initialiseFreshImage();
  const store = useImageStore.getState();
  store.saveViewState();
  store.setChannelRange(0, 400, 500);

  assert.equal(store.saveViewStateIfSource('source', 'source-id', 'wrong-rev'), false);
  assert.equal(useImageStore.getState().imageViewStates.source.channels[0].min, 100);
  assert.equal(store.saveViewStateIfSource('source', 'source-id', 'source-rev'), true);
  assert.equal(useImageStore.getState().imageViewStates.source.channels[0].min, 400);
  assert.equal(useImageStore.getState().imageViewStates.source.channels[0].max, 500);
});

test('a late reset reload cannot overwrite a newer T plane or another image', () => {
  initialiseFreshImage();
  const request = captureChannelRequest('source');
  assert.ok(request);
  const stalePixels = new Uint16Array([99, 99, 99, 99]);

  useImageStore.getState().setCurrentT(1);
  const currentPixels = useImageStore.getState().channels[0].data;
  assert.equal(applyChannelResponseIfCurrent(request, {
    channels: [{ channel: 0, data: stalePixels, auto_min: 99, auto_max: 99 }],
  }), false);
  assert.equal(useImageStore.getState().channels[0].data, currentPixels);

  const previousMetadata = useImageStore.getState().metadata;
  useImageStore.getState().setActiveImageId('other');
  useImageStore.getState().setMetadata({
    ...previousMetadata,
    filename: 'other.oir',
    source_path: '/data/other.oir',
    source_identity: 'other-id',
    source_revision: 'other-rev',
  });
  useImageStore.getState().initChannels(2);
  const otherPixels = new Uint16Array([7, 7, 7, 7]);
  useImageStore.getState().setChannelData(0, otherPixels, 7, 7);
  assert.equal(applyChannelResponseIfCurrent(request, {
    channels: [{ channel: 0, data: stalePixels, auto_min: 99, auto_max: 99 }],
  }), false);
  assert.equal(useImageStore.getState().channels[0].data, otherPixels);
});
