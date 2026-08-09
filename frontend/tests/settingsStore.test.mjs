import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
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
const {
  loadSettings,
  resetSettings,
  scheduleSettingsSave,
  flushPendingSettingsForUnload,
  waitForSettingsIdle,
} = await import('../src/utils/settingsStore.ts');

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const snapshot = {
  channels: [{ color: [0, 255, 0], min: 10, max: 200, visible: true }],
  currentZ: 0,
  currentT: 0,
  showMIP: false,
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('an in-flight old PUT completes before reset DELETE and never follows it', async () => {
  const calls = [];
  let releasePut;
  const putGate = new Promise((resolve) => { releasePut = resolve; });
  let putCount = 0;
  globalThis.fetch = async (_url, init = {}) => {
    calls.push(init.method ?? 'GET');
    if (init.method === 'PUT') {
      putCount += 1;
      if (putCount === 1) await putGate;
      return jsonResponse({ saved: true, source_revision: 'rev' });
    }
    if (init.method === 'DELETE') return jsonResponse({ deleted: true });
    throw new Error(`unexpected ${init.method}`);
  };

  const errors = [];
  scheduleSettingsSave('queued', snapshot, (error) => errors.push(error), 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, ['PUT']);

  const resetting = resetSettings('queued');
  const fresh = { ...snapshot, currentZ: 1 };
  scheduleSettingsSave('queued', fresh, (error) => errors.push(error), 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, ['PUT']);
  releasePut();
  await resetting;
  await waitForSettingsIdle('queued');
  assert.deepEqual(calls, ['PUT', 'DELETE', 'PUT']);
  assert.deepEqual(errors, []);
});

test('reset cancels an unsent debounced snapshot instead of publishing it', async () => {
  const calls = [];
  globalThis.fetch = async (_url, init = {}) => {
    calls.push(init.method ?? 'GET');
    return jsonResponse({ deleted: true });
  };

  scheduleSettingsSave('pending', snapshot, () => {}, 60_000);
  await resetSettings('pending');
  await waitForSettingsIdle('pending');
  assert.deepEqual(calls, ['DELETE']);
});

test('page unload starts the latest debounced snapshot with a monotonic write id', async () => {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
    return jsonResponse({ saved: true, source_revision: 'rev' });
  };

  scheduleSettingsSave('unloading', snapshot, () => {}, 60_000);
  const latest = { ...snapshot, currentZ: 3 };
  scheduleSettingsSave('unloading', latest, () => {}, 60_000);
  flushPendingSettingsForUnload();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const request = requests.find((item) => item.url.includes('/unloading/view-settings'));
  assert.ok(request);
  assert.equal(request.method, 'PUT');
  assert.equal(request.body.currentZ, 3);
  assert.match(request.body.client_session, /^[A-Za-z0-9._-]+$/);
  assert.equal(Number.isSafeInteger(request.body.client_sequence), true);
  assert.equal(request.body.client_sequence > 0, true);
});

test('load refuses a response for another source revision', async () => {
  globalThis.fetch = async () => jsonResponse({
    found: true,
    source_identity: 'id',
    source_revision: 'old-revision',
    settings: snapshot,
  });
  await assert.rejects(
    loadSettings('image', 'id', 'current-revision'),
    /元画像が、現在の画像と一致しません/,
  );
});

test('reset invalidates a settings GET that finishes after DELETE', async () => {
  const calls = [];
  let releaseGet;
  const getGate = new Promise((resolve) => { releaseGet = resolve; });
  globalThis.fetch = async (_url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push(method);
    if (method === 'GET') {
      await getGate;
      return jsonResponse({
        found: true,
        source_identity: 'id',
        source_revision: 'rev',
        settings: snapshot,
      });
    }
    if (method === 'DELETE') return jsonResponse({ deleted: true });
    throw new Error(`unexpected ${method}`);
  };

  const loading = loadSettings('slow-get', 'id', 'rev');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await resetSettings('slow-get');
  releaseGet();
  assert.equal(await loading, null);
  assert.deepEqual(calls, ['GET', 'DELETE']);
});

test('legacy localStorage is never consulted', async () => {
  const previous = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem() { throw new Error('legacy localStorage was read'); } },
  });
  try {
    globalThis.fetch = async () => jsonResponse({ found: false, reason: 'none' });
    assert.equal(await loadSettings('image', 'id', 'rev'), null);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previous });
  }
});
