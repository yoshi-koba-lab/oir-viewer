import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
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

const originalFetch = globalThis.fetch;
const { useImageStore } = await import('../src/stores/imageStore.ts');
const { useViewStore } = await import('../src/stores/viewStore.ts');
const { openAndReload } = await import('../src/hooks/useImageLoader.ts');

afterEach(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  useImageStore.setState(useImageStore.getInitialState(), true);
  useViewStore.setState(useViewStore.getInitialState(), true);
});

function metadata(id, path, overrides = {}) {
  return {
    id,
    filename: path.split('/').at(-1),
    source_path: path,
    source_identity: `${id}-identity`,
    source_revision: `${id}-revision`,
    num_channels: 1,
    num_z: 3,
    num_t: 1,
    width: 2,
    height: 2,
    pixel_size_x: 1,
    pixel_size_y: 1,
    pixel_size_z: 1,
    channel_names: ['Ch0'],
    channel_types: ['fluorescence'],
    channel_colors: [[0, 255, 0]],
    channel_ranges: [[10, 100]],
    bit_depth: 12,
    ...overrides,
  };
}

function seedActive(id = 'A', path = '/data/A.oir') {
  const store = useImageStore.getState();
  store.setActiveImageId(id);
  store.setMetadata(metadata(id, path));
  store.initChannels(1);
  store.setProjection({ active: false, method: 'max', zFrom: 0, zTo: 2 });
  store.setChannelData(0, new Uint16Array([1, 2, 3, 4]), 1, 4);
  store.captureSourceDefaults();
  useViewStore.getState().setViewMode('3d');
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function binaryResponse(values, autoMin = 1, autoMax = 100) {
  const width = 2;
  const height = 2;
  const channels = 1;
  const buffer = new ArrayBuffer(12 + channels * 8 + values.length * 2);
  const view = new DataView(buffer);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setUint32(8, channels, true);
  view.setInt32(12, autoMin, true);
  view.setInt32(16, autoMax, true);
  new Uint16Array(buffer, 20, values.length).set(values);
  return new Response(buffer, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

test('opening the already-active source preserves its live view and mode', async () => {
  seedActive();
  const store = useImageStore.getState();
  store.setCurrentZ(2);
  store.setChannelRange(0, 40, 80);
  const livePixels = useImageStore.getState().channels[0].data;

  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.startsWith('/api/open?')) {
      return jsonResponse({ ...metadata('A', '/data/A.oir'), reused: true });
    }
    if (path === '/api/images') {
      return jsonResponse([{ ...metadata('A', '/data/A.oir'), active: true }]);
    }
    throw new Error(`unexpected request: ${path}`);
  };

  assert.equal(await openAndReload('/data/A.oir'), 'A');
  const current = useImageStore.getState();
  assert.equal(current.currentZ, 2);
  assert.equal(current.channels[0].min, 40);
  assert.equal(current.channels[0].max, 80);
  assert.equal(current.channels[0].data, livePixels);
  assert.equal(useViewStore.getState().viewMode, '3d');
});

test('opening an inactive reused id restores its session plane atomically', async () => {
  seedActive();
  const aChannel = useImageStore.getState().channels[0];
  useImageStore.setState((state) => ({
    imageViewStates: {
      ...state.imageViewStates,
      B: {
        channels: [{ ...aChannel, min: 200, max: 300, data: null }],
        currentZ: 2,
        currentT: 0,
        showMIP: false,
        projection: { active: false, method: 'max', zFrom: 0, zTo: 2 },
        volume3D: { az: 10, el: 20, radius: 3, zStart: 1, zEnd: 3, zTotal: 3 },
      },
    },
  }));
  const notifications = [];
  const unsubscribe = useImageStore.subscribe((state) => {
    if (state.activeImageId === 'B') {
      notifications.push({ z: state.currentZ, pixel: state.channels[0]?.data?.[0] });
    }
  });

  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.startsWith('/api/open?')) {
      return jsonResponse({ ...metadata('B', '/data/B.oir'), reused: true });
    }
    if (path.startsWith('/api/image/all-channels-bin?')) {
      const query = new URL(path, 'http://localhost').searchParams;
      return Number(query.get('z')) === 2
        ? binaryResponse([901, 902, 903, 904], 900, 904)
        : binaryResponse([11, 12, 13, 14], 10, 14);
    }
    if (path === '/api/images') {
      return jsonResponse([
        { ...metadata('A', '/data/A.oir'), active: false },
        { ...metadata('B', '/data/B.oir'), active: true },
      ]);
    }
    throw new Error(`unexpected request: ${path}`);
  };

  assert.equal(await openAndReload('/data/B.oir'), 'B');
  unsubscribe();
  assert.equal(notifications.length > 0, true);
  assert.equal(notifications.every(({ z, pixel }) => z === 2 && pixel === 901), true);
  assert.equal(useImageStore.getState().channels[0].min, 200);
  assert.equal(useImageStore.getState().channels[0].max, 300);
});

test('edits made to A while fresh B opens are captured immediately before B install', async () => {
  seedActive();
  let releaseOpen;
  let signalOpenStarted;
  const openStarted = new Promise((resolve) => { signalOpenStarted = resolve; });
  const openGate = new Promise((resolve) => { releaseOpen = resolve; });

  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.startsWith('/api/open?')) {
      signalOpenStarted();
      await openGate;
      return jsonResponse({ ...metadata('B2', '/data/B2.oir'), reused: false });
    }
    if (path === '/api/images/B2/view-settings') {
      return jsonResponse({ found: false, reason: 'none' });
    }
    if (path.startsWith('/api/image/all-channels-bin?')) {
      return binaryResponse([21, 22, 23, 24], 20, 24);
    }
    if (path === '/api/images') {
      return jsonResponse([
        { ...metadata('A', '/data/A.oir'), active: false },
        { ...metadata('B2', '/data/B2.oir'), active: true },
      ]);
    }
    throw new Error(`unexpected request: ${path}`);
  };

  const opening = openAndReload('/data/B2.oir');
  await openStarted;
  useImageStore.getState().setChannelRange(0, 700, 800);
  releaseOpen();
  assert.equal(await opening, 'B2');
  assert.equal(useImageStore.getState().imageViewStates.A.channels[0].min, 700);
  assert.equal(useImageStore.getState().imageViewStates.A.channels[0].max, 800);
});
