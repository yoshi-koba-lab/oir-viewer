import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(testsDir, '..');
const repoDir = path.resolve(frontendDir, '..');

test('the frontend and desktop shell use the OIR Viewer window title', async () => {
  const [html, desktopMain] = await Promise.all([
    readFile(path.join(frontendDir, 'index.html'), 'utf8'),
    readFile(path.join(repoDir, 'desktop', 'main.js'), 'utf8'),
  ]);

  const htmlTitles = [...html.matchAll(/<title>(.*?)<\/title>/giu)].map((match) => match[1]);
  assert.deepEqual(htmlTitles, ['OIR Viewer']);
  assert.match(desktopMain, /title:\s*['"]OIR Viewer['"]/u);
});
