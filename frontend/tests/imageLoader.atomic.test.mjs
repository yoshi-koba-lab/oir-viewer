import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
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
const { useOperationStore } = await import('../src/stores/operationStore.ts');
const {
  openAndReload,
  openPathBatch,
  startupActiveImage,
  uploadAndReload,
} = await import('../src/hooks/useImageLoader.ts');

afterEach(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  useImageStore.setState(useImageStore.getInitialState(), true);
  useViewStore.setState(useViewStore.getInitialState(), true);
  useOperationStore.setState(useOperationStore.getInitialState(), true);
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

test('empty startup image list stays empty for the Welcome screen', () => {
  assert.equal(startupActiveImage([]), undefined);
  assert.equal(
    startupActiveImage([
      { id: 'A', filename: 'A.oir', active: false },
      { id: 'B', filename: 'B.oir', active: true },
    ]).id,
    'B',
  );
});

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

test('a whole-image open reports only verified milestones and paints 100 before clearing', async () => {
  seedActive('PROG-A', '/data/progress.oir');
  const observed = [];
  const unsubscribe = useOperationStore.subscribe((state) => {
    if (state.imageLoad) observed.push({ ...state.imageLoad });
  });
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.startsWith('/api/open?')) {
      return jsonResponse({ ...metadata('PROG-A', '/data/progress.oir'), reused: true });
    }
    if (path === '/api/images') {
      return jsonResponse([
        { ...metadata('PROG-A', '/data/progress.oir'), active: true },
      ]);
    }
    throw new Error(`unexpected request: ${path}`);
  };

  assert.equal(await openAndReload('/data/progress.oir'), 'PROG-A');
  unsubscribe();
  assert.deepEqual(
    [...new Set(observed.map(({ percent }) => percent))],
    [0, 17, 33, 50, 67, 83, 100],
  );
  assert.equal(observed.at(-1).completedUnits, 6);
  assert.equal(useOperationStore.getState().imageLoad, null);

  // The deterministic counter ends at the coherent 2D presentation boundary.
  // Opaque source decode and the following Maximum 3D load remain visibly
  // indeterminate instead of borrowing this percentage or inventing time.
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const genericLoading = appSource.slice(
    appSource.indexOf('{/* Loading indicator */}'),
    appSource.indexOf('{/* Whole-image Open/activate progress.'),
  );
  const imageLoading = appSource.slice(
    appSource.indexOf('{/* Whole-image Open/activate progress.'),
    appSource.indexOf('{/* Drag & drop overlay */}'),
  );
  const volumeSource = readFileSync(
    new URL('../src/components/Volume3DViewer.tsx', import.meta.url),
    'utf8',
  );
  const volumeLoading = volumeSource.slice(
    volumeSource.indexOf('{/* Loading overlay */}'),
    volumeSource.indexOf('{/* Error overlay */}'),
  );
  const volumeReset = volumeSource.slice(
    volumeSource.indexOf('{/* Reset every per-file display choice'),
    volumeSource.indexOf('{/* Info overlay */}'),
  );
  const compareSource = readFileSync(
    new URL('../src/components/CompareView.tsx', import.meta.url),
    'utf8',
  );
  const compareLoading = compareSource.slice(
    compareSource.indexOf('function CompareLoadingIndicator'),
    compareSource.indexOf('export function CompareView'),
  );
  const channelSource = readFileSync(
    new URL('../src/components/ChannelPanel.tsx', import.meta.url),
    'utf8',
  );
  const channelReset = channelSource.slice(
    channelSource.indexOf("{viewMode === '2d' && ("),
    channelSource.indexOf("{viewMode === '3d' &&"),
  );
  assert.match(imageLoading, /2D表示を準備中/);
  assert.match(imageLoading, /2D表示の準備完了/);
  assert.match(
    imageLoading,
    /value=\{imageLoad\.completedUnits === 0 \? undefined : imageLoad\.percent\}/,
  );
  assert.match(genericLoading, /<progress/);
  assert.doesNotMatch(genericLoading, /\bvalue=/);
  assert.match(volumeLoading, /3D画像を読み込み中/);
  assert.match(volumeLoading, /<progress/);
  assert.doesNotMatch(volumeLoading, /\bvalue=/);
  assert.match(compareLoading, /<progress/);
  assert.doesNotMatch(compareLoading, /\bvalue=/);
  assert.equal(
    (compareSource.match(/<CompareLoadingIndicator(?: compact)? \/>/g) ?? []).length,
    2,
  );
  assert.match(channelReset, /2D表示設定のリセット待ち/);
  assert.doesNotMatch(channelReset, /\bvalue=/);
  assert.match(volumeReset, /3D表示設定のリセット待ち/);
  assert.doesNotMatch(volumeReset, /\bvalue=/);
});

test('a failed whole-image open clears progress without claiming 100%', async () => {
  const observed = [];
  const unsubscribe = useOperationStore.subscribe((state) => {
    if (state.imageLoad) observed.push(state.imageLoad.percent);
  });
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.startsWith('/api/open?')) {
      return new Response('decode failed', { status: 500 });
    }
    if (path === '/api/images') return jsonResponse([]);
    throw new Error(`unexpected request: ${path}`);
  };

  await assert.rejects(openAndReload('/data/broken.oir'), /decode failed/);
  unsubscribe();
  assert.equal(observed.includes(100), false);
  assert.equal(useOperationStore.getState().imageLoad, null);
  assert.equal(useImageStore.getState().loading, false);
  assert.match(useImageStore.getState().loadError, /broken\.oir/);
});

test('a two-well path batch has one monotonic denominator and preserves well labels', async () => {
  let currentId = 'PLATE-A';
  const observed = [];
  const unsubscribe = useOperationStore.subscribe((state) => {
    if (state.imageLoad) observed.push({ ...state.imageLoad });
  });
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.startsWith('/api/open?')) {
      const source = new URL(path, 'http://localhost').searchParams.get('path');
      currentId = source?.endsWith('C05.oir') ? 'PLATE-C05' : 'PLATE-B02';
      return jsonResponse({ ...metadata(currentId, source), reused: false });
    }
    if (path === '/api/images/PLATE-B02/view-settings'
        || path === '/api/images/PLATE-C05/view-settings') {
      return jsonResponse({ found: false, reason: 'none' });
    }
    if (path.startsWith('/api/image/all-channels-bin?')) {
      return binaryResponse([31, 32, 33, 34], 30, 34);
    }
    if (path === '/api/images') {
      return jsonResponse([
        { ...metadata('PLATE-B02', '/plate/B02.oir'), active: currentId === 'PLATE-B02' },
        { ...metadata('PLATE-C05', '/plate/C05.oir'), active: currentId === 'PLATE-C05' },
      ]);
    }
    throw new Error(`unexpected request: ${path}`);
  };

  const result = await openPathBatch(
    ['/plate/B02.oir', '/plate/C05.oir'],
    ['B02', 'C05'],
  );
  unsubscribe();
  assert.equal(result.lastOpenedId, 'PLATE-C05');
  assert.deepEqual(result.failures, []);
  assert.equal(observed.every(({ totalUnits }) => totalUnits === 12), true);
  assert.equal(observed.every(({ totalItems }) => totalItems === 2), true);
  assert.equal(observed.some(({ label }) => label.startsWith('B02 (1/2):')), true);
  assert.equal(observed.some(({ label }) => label.startsWith('C05 (2/2):')), true);
  const percents = observed.map(({ percent }) => percent);
  assert.deepEqual([...percents].sort((a, b) => a - b), percents);
  assert.equal(percents.at(-1), 100);
  assert.equal(useOperationStore.getState().imageLoad, null);
});

test('a two-item all-failure batch never advances unverified units or reports 100%', async () => {
  const observed = [];
  const unsubscribe = useOperationStore.subscribe((state) => {
    if (state.imageLoad) observed.push({ ...state.imageLoad });
  });
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.startsWith('/api/open?')) {
      return new Response('source decode failed', { status: 500 });
    }
    if (path === '/api/images') return jsonResponse([]);
    throw new Error(`unexpected request: ${path}`);
  };

  const result = await openPathBatch(
    ['/plate/B02-failed.oir', '/plate/C05-failed.oir'],
    ['B02', 'C05'],
  );
  unsubscribe();
  assert.equal(result.lastOpenedId, null);
  assert.deepEqual(result.failures.map(({ label }) => label), ['B02', 'C05']);
  assert.equal(Math.max(...observed.map(({ completedUnits }) => completedUnits)), 0);
  assert.equal(observed.some(({ percent }) => percent === 100), false);
  assert.equal(useOperationStore.getState().imageLoad, null);
});

test('a successful item followed by failure stops at verified success units', async () => {
  const first = metadata('PARTIAL-A', '/plate/B02.oir');
  const observed = [];
  const unsubscribe = useOperationStore.subscribe((state) => {
    if (state.imageLoad) observed.push({ ...state.imageLoad });
  });
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.startsWith('/api/open?')) {
      const source = new URL(path, 'http://localhost').searchParams.get('path');
      return source?.endsWith('B02.oir')
        ? jsonResponse({ ...first, reused: false })
        : new Response('second source failed', { status: 500 });
    }
    if (path === '/api/images/PARTIAL-A/view-settings') {
      return jsonResponse({ found: false, reason: 'none' });
    }
    if (path === '/api/images/PARTIAL-A/activate') return jsonResponse(first);
    if (path.startsWith('/api/image/all-channels-bin?')) {
      return binaryResponse([51, 52, 53, 54], 50, 54);
    }
    if (path === '/api/images') {
      return jsonResponse([{ ...first, active: true }]);
    }
    throw new Error(`unexpected request: ${path}`);
  };

  const result = await openPathBatch(
    ['/plate/B02.oir', '/plate/C05-failed.oir'],
    ['B02', 'C05'],
  );
  unsubscribe();
  assert.equal(result.lastOpenedId, 'PARTIAL-A');
  assert.deepEqual(result.failures.map(({ label }) => label), ['C05']);
  assert.equal(Math.max(...observed.map(({ completedUnits }) => completedUnits)), 6);
  assert.equal(Math.max(...observed.map(({ percent }) => percent)), 50);
  assert.equal(observed.some(({ percent }) => percent === 100), false);
  assert.equal(useOperationStore.getState().imageLoad, null);
});

test('a dropped upload uses the same verified 0–100 progress contract', async () => {
  const observed = [];
  const unsubscribe = useOperationStore.subscribe((state) => {
    if (state.imageLoad) observed.push(state.imageLoad.percent);
  });
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path === '/api/upload') {
      return jsonResponse({ ...metadata('UPLOAD-A', '/uploads/drop.oir'), reused: false });
    }
    if (path === '/api/images/UPLOAD-A/view-settings') {
      return jsonResponse({ found: false, reason: 'none' });
    }
    if (path.startsWith('/api/image/all-channels-bin?')) {
      return binaryResponse([41, 42, 43, 44], 40, 44);
    }
    if (path === '/api/images') {
      return jsonResponse([
        { ...metadata('UPLOAD-A', '/uploads/drop.oir'), active: true },
      ]);
    }
    throw new Error(`unexpected request: ${path}`);
  };

  const file = new File([new Uint8Array([1, 2, 3])], 'drop.oir');
  assert.equal(await uploadAndReload(file), 'UPLOAD-A');
  unsubscribe();
  assert.deepEqual([...new Set(observed)], [0, 17, 33, 50, 67, 83, 100]);
  assert.equal(useOperationStore.getState().imageLoad, null);
});
