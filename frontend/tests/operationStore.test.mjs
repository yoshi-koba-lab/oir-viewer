import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
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

const { useOperationStore } = await import('../src/stores/operationStore.ts');
const { useViewStore } = await import('../src/stores/viewStore.ts');
const { useImageStore } = await import('../src/stores/imageStore.ts');
const {
  closeImageById,
  imageOperationIsBusy,
  openAndReload,
  runImageOperation,
  switchToImage,
  uploadAndReload,
} = await import('../src/hooks/useImageLoader.ts');

test('one App-lifetime 3D save blocks navigation until its owning token finishes', async () => {
  useOperationStore.setState(useOperationStore.getInitialState(), true);
  useViewStore.setState(useViewStore.getInitialState(), true);
  useImageStore.setState(useImageStore.getInitialState(), true);
  useImageStore.getState().setActiveImageId('A');
  useViewStore.getState().setViewMode('3d');

  const token = useOperationStore.getState().beginThreeDSave({
    percent: -10,
    label: '保存先を選択中…',
  });
  assert.ok(token);
  assert.equal(
    useOperationStore.getState().beginThreeDSave({ percent: 0, label: 'second' }),
    null,
  );

  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error('blocked operations must not reach fetch');
  };
  try {
    useViewStore.getState().setViewMode('2d');
    await switchToImage('B');
    await closeImageById('A');
    assert.equal(await openAndReload('/must/not/open.oir'), null);
    assert.equal(await uploadAndReload({ name: 'must-not-upload.oir' }), null);
    assert.equal(networkCalls, 0);
    assert.equal(useViewStore.getState().viewMode, '3d');
    assert.equal(useImageStore.getState().activeImageId, 'A');
  } finally {
    globalThis.fetch = originalFetch;
  }

  useOperationStore.getState().updateThreeDSave(token + 1, { percent: 99, label: 'stale' });
  assert.equal(useOperationStore.getState().threeDSave?.percent, 0);
  useOperationStore.getState().updateThreeDSave(token, { percent: 167.4, label: 'writing' });
  assert.deepEqual(useOperationStore.getState().threeDSave, {
    token,
    percent: 100,
    label: 'writing',
  });
  useOperationStore.getState().finishThreeDSave(token + 1);
  assert.ok(useOperationStore.getState().threeDSave);

  useOperationStore.getState().finishThreeDSave(token);
  const nextToken = useOperationStore.getState().beginThreeDSave({ percent: 0, label: 'next' });
  assert.ok(nextToken);
  useOperationStore.getState().finishThreeDSave(token);
  assert.equal(useOperationStore.getState().threeDSave?.token, nextToken);
  useOperationStore.getState().finishThreeDSave(nextToken);
  useViewStore.getState().setViewMode('2d');
  assert.equal(useViewStore.getState().viewMode, '2d');
  assert.equal(useOperationStore.getState().threeDSave, null);
});

test('an image operation queued before save is refused again after its queue wait', async () => {
  useOperationStore.setState(useOperationStore.getInitialState(), true);
  let releaseFirst;
  let markStarted;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise((resolve) => { markStarted = resolve; });
  let secondRan = false;

  const first = runImageOperation(async () => {
    markStarted();
    await firstGate;
  }, undefined);
  await firstStarted;
  const second = runImageOperation(async () => {
    secondRan = true;
  }, undefined);
  assert.equal(imageOperationIsBusy(), true);

  // Volume3DViewer normally refuses to begin while the queue is non-empty. This
  // forced acquisition proves the second line of defence at queue wake-up.
  const token = useOperationStore.getState().beginThreeDSave({ percent: 0, label: 'saving' });
  assert.ok(token);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(secondRan, false);
  assert.equal(imageOperationIsBusy(), false);
  useOperationStore.getState().finishThreeDSave(token);
});

test('whole-image progress is token-owned, monotonic, and mutually exclusive with 3D save', () => {
  useOperationStore.setState(useOperationStore.getInitialState(), true);
  const token = useOperationStore.getState().beginImageLoad({
    totalUnits: 12,
    totalItems: 2,
    label: 'A (1/2): waiting',
  });
  assert.ok(token);
  assert.deepEqual(useOperationStore.getState().imageLoad, {
    token,
    completedUnits: 0,
    totalUnits: 12,
    percent: 0,
    label: 'A (1/2): waiting',
    itemIndex: 0,
    totalItems: 2,
  });
  assert.equal(
    useOperationStore.getState().beginImageLoad({
      totalUnits: 6,
      totalItems: 1,
      label: 'second',
    }),
    null,
  );
  assert.equal(
    useOperationStore.getState().beginThreeDSave({ percent: 0, label: 'save' }),
    null,
  );

  useOperationStore.getState().updateImageLoad(token + 1, {
    completedUnits: 12,
    itemIndex: 1,
    label: 'stale owner',
  });
  useOperationStore.getState().updateImageLoad(token, {
    completedUnits: 3,
    itemIndex: 0,
    label: 'A: baseline verified',
  });
  assert.equal(useOperationStore.getState().imageLoad?.percent, 25);
  useOperationStore.getState().updateImageLoad(token, {
    completedUnits: 2,
    itemIndex: 0,
    label: 'late earlier milestone',
  });
  assert.equal(useOperationStore.getState().imageLoad?.completedUnits, 3);
  assert.equal(useOperationStore.getState().imageLoad?.label, 'A: baseline verified');
  useOperationStore.getState().updateImageLoad(token, {
    completedUnits: 99,
    itemIndex: 99,
    label: 'B: complete',
  });
  assert.equal(useOperationStore.getState().imageLoad?.completedUnits, 12);
  assert.equal(useOperationStore.getState().imageLoad?.percent, 100);
  assert.equal(useOperationStore.getState().imageLoad?.itemIndex, 1);

  useOperationStore.getState().finishImageLoad(token + 1);
  assert.ok(useOperationStore.getState().imageLoad);
  useOperationStore.getState().finishImageLoad(token);
  assert.equal(useOperationStore.getState().imageLoad, null);
});
