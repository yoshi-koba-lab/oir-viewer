import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The application uses bundler-style extensionless imports. Resolve those to
// source TypeScript so this test exercises the real Zustand store without a
// second build or a test-only copy of its state transitions.
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
const { volume3DCameraForMount } = await import('../src/utils/volume3DState.ts');

beforeEach(() => {
  useImageStore.setState(useImageStore.getInitialState(), true);
});

test('A to B to A restores camera and zoom before the keyed viewer first writes', () => {
  let store = useImageStore.getState();

  store.setActiveImageId('A');
  store.setMetadata({ num_z: 40 });
  store.setVolume3D({
    az: 123,
    el: -27,
    radius: 4.25,
    zoomPercent: 235,
    zStart: 5,
    zEnd: 30,
    zTotal: 40,
  });
  store.saveViewState();

  store = useImageStore.getState();
  store.setActiveImageId('B');
  store.setMetadata({ num_z: 60 });
  store.setVolume3D({ az: 15, el: 8, radius: 2, zoomPercent: 140 });
  store.saveViewState();

  store = useImageStore.getState();
  store.setMetadata({ num_z: 40 });
  store.restoreViewState('A');
  const mountedCamera = volume3DCameraForMount(useImageStore.getState().volume3D);

  // This is the first camera write performed by scene initialisation. It must
  // round-trip the restored values, not replace them with 0/0/100.
  useImageStore.getState().setVolume3D(mountedCamera);
  assert.deepEqual(volume3DCameraForMount(useImageStore.getState().volume3D), {
    az: 123,
    el: -27,
    radius: 4.25,
    zoomPercent: 235,
  });
  assert.deepEqual(
    volume3DCameraForMount(useImageStore.getState().imageViewStates.A.volume3D),
    mountedCamera,
  );
});

test('pre-3D tab switches save and restore the full metadata Z range', () => {
  let store = useImageStore.getState();
  store.setActiveImageId('B02');
  store.setMetadata({ num_z: 50 });

  assert.deepEqual(useImageStore.getState().volume3D, {
    az: 0,
    el: 0,
    radius: 2.5,
    zoomPercent: 100,
    zStart: 1,
    zEnd: 50,
    zTotal: 50,
  });

  // This is the exact failing workflow: leave the 2D-only well, which saves its
  // view before Volume3DViewer has ever had a chance to initialise the slab.
  useImageStore.getState().saveViewState();
  assert.deepEqual(useImageStore.getState().imageViewStates.B02.volume3D, {
    az: 0,
    el: 0,
    radius: 2.5,
    zoomPercent: 100,
    zStart: 1,
    zEnd: 50,
    zTotal: 50,
  });

  store = useImageStore.getState();
  store.setVolume3D({ az: 30, el: -5, radius: 3, zStart: 10, zEnd: 20, zTotal: 50 });
  store.setActiveImageId('B03');
  store.setMetadata({ num_z: 80 });

  // A fresh well carries its angle, but starts fitted with its own full slab.
  assert.deepEqual(useImageStore.getState().volume3D, {
    az: 30,
    el: -5,
    radius: 3,
    zoomPercent: 100,
    zStart: 1,
    zEnd: 80,
    zTotal: 80,
  });

  store = useImageStore.getState();
  store.setMetadata({ num_z: 50 });
  store.restoreViewState('B02');
  assert.equal(useImageStore.getState().volume3D.zEnd, 50);
  assert.equal(useImageStore.getState().volume3D.zTotal, 50);
});

test('restoring an old pre-3D placeholder migrates both live and saved state', () => {
  let store = useImageStore.getState();
  store.setActiveImageId('legacy');
  store.setMetadata({ num_z: 50 });
  store.setVolume3D({ az: 40, el: 10, radius: 2, zStart: 1, zEnd: 1, zTotal: 1 });
  store.saveViewState();

  store = useImageStore.getState();
  store.setActiveImageId('other');
  store.setMetadata({ num_z: 12 });
  store.setMetadata({ num_z: 50 });
  store.restoreViewState('legacy');

  assert.deepEqual(useImageStore.getState().volume3D, {
    az: 40,
    el: 10,
    radius: 2,
    zoomPercent: 100,
    zStart: 1,
    zEnd: 50,
    zTotal: 50,
  });
  assert.deepEqual(
    useImageStore.getState().imageViewStates.legacy.volume3D,
    useImageStore.getState().volume3D,
  );
});
