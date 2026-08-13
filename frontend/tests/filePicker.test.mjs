import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const { pickedFileInput } = await import('../src/utils/api.ts');

test('picker result normalization routes browser files, native paths, and cancel safely', () => {
  const browserFile = { name: 'image.tif' };
  assert.deepEqual(
    pickedFileInput({ paths: [], files: [browserFile], cancelled: false }),
    { kind: 'files', files: [browserFile] },
  );
  assert.deepEqual(
    pickedFileInput({ paths: ['/data/image.tif'], cancelled: false }),
    { kind: 'paths', paths: ['/data/image.tif'] },
  );
  assert.equal(pickedFileInput({ paths: [], cancelled: true }), null);
});

test('browser file picker uploads File objects while Electron keeps native paths', async () => {
  const [api, toolbar, app] = await Promise.all([
    readFile(new URL('../src/utils/api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/Toolbar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  ]);

  // The Electron bridge remains the first branch, so packaged native dialogs
  // are not replaced by an HTML input.
  assert.match(api, /if \(api\) return api\.chooseFiles\(\);/u);
  // Plain browsers must have a real, user-triggered file selection path; an
  // HTTP request to the backend's native-dialog endpoint can hang or be absent
  // in a static trial build.
  assert.match(api, /document\.createElement\('input'\)/u);
  assert.match(api, /input\.type = 'file'/u);
  assert.match(api, /input\.multiple = true/u);
  assert.match(api, /input\.click\(\)/u);
  assert.match(api, /files: File\[\]/u);
  assert.match(api, /typeof document !== 'undefined'\) return chooseBrowserFiles\(\)/u);
  // Both entry points must upload browser File objects, never pass their empty
  // browser `paths` array to `/api/open`.
  assert.match(toolbar, /if \(picked\.cancelled\) return;/u);
  assert.match(toolbar, /selected\.kind === 'files'[\s\S]*uploadFileBatch\(selected\.files\)/u);
  assert.match(app, /selected\.kind === 'files'[\s\S]*uploadFileBatch\(selected\.files\)/u);
});
