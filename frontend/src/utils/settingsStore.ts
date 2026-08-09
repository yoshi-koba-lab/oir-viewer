/**
 * Revision-bound per-image display settings stored by the backend.
 *
 * Browser localStorage is deliberately not read: the packaged app is served on
 * the first free loopback port, and Chromium gives every port a different
 * origin. A reset on one origin could therefore leave an older Min/Max snapshot
 * waiting on another origin and silently resurrect it on a later launch.
 */

import {
  deleteViewSettings,
  fetchViewSettings,
  putViewSettings,
  type SavedImageView,
} from './api';

export type { SavedChannelView, SavedImageView } from './api';

type SaveErrorHandler = (error: unknown) => void;

interface PendingSave {
  settings: SavedImageView;
  sequence: number;
  onError: SaveErrorHandler;
  timer: ReturnType<typeof setTimeout>;
}

interface LatestSave {
  settings: SavedImageView;
  sequence: number;
}

const tails = new Map<string, Promise<void>>();
const pending = new Map<string, PendingSave>();
const latest = new Map<string, LatestSave>();
const loadGenerations = new Map<string, number>();
const clientSession = globalThis.crypto?.randomUUID?.()
  ?? `renderer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let nextSequence = 1;

function loadGeneration(imageId: string): number {
  return loadGenerations.get(imageId) ?? 0;
}

/** Synchronously invalidate a GET that may still be waiting on the backend. */
function invalidateSettingsLoad(imageId: string): void {
  loadGenerations.set(imageId, loadGeneration(imageId) + 1);
}

/** Serialize PUT/DELETE for one image so an older PUT can never overtake reset. */
function enqueue<T>(imageId: string, operation: () => Promise<T>): Promise<T> {
  const previous = tails.get(imageId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const settled = result.then(() => undefined, () => undefined);
  tails.set(imageId, settled);
  void settled.finally(() => {
    if (tails.get(imageId) === settled) tails.delete(imageId);
  });
  return result;
}

export async function loadSettings(
  imageId: string,
  sourceIdentity: string,
  sourceRevision: string,
): Promise<SavedImageView | null> {
  const generation = loadGeneration(imageId);
  const result = await fetchViewSettings(imageId);
  if (generation !== loadGeneration(imageId)) return null;
  if (!result.found) return null;
  // The backend is authoritative, but checking again prevents a response for a
  // superseded tab-switch request from being applied to the next source.
  if (result.source_identity !== sourceIdentity || result.source_revision !== sourceRevision) {
    throw new Error('保存済み表示設定の元画像が、現在の画像と一致しません');
  }
  return result.settings;
}

function saveSettings(
  imageId: string,
  settings: SavedImageView,
  sequence: number,
): Promise<void> {
  return enqueue(imageId, async () => {
    await putViewSettings(imageId, settings, clientSession, sequence);
    if (latest.get(imageId)?.sequence === sequence && !pending.has(imageId)) {
      latest.delete(imageId);
    }
  });
}

/** Keep only the newest unsent snapshot while a slider is moving. */
export function scheduleSettingsSave(
  imageId: string,
  settings: SavedImageView,
  onError: SaveErrorHandler,
  delayMs = 400,
): void {
  const sequence = nextSequence++;
  latest.set(imageId, { settings, sequence });
  const existing = pending.get(imageId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pending.delete(imageId);
    void saveSettings(imageId, settings, sequence).catch(onError);
  }, delayMs);
  pending.set(imageId, { settings, sequence, onError, timer });
}

/** Publish the latest debounced snapshot before the image id is closed. */
export async function flushSettings(imageId: string): Promise<void> {
  const item = pending.get(imageId);
  if (item) {
    clearTimeout(item.timer);
    pending.delete(imageId);
    await saveSettings(imageId, item.settings, item.sequence);
    return;
  }
  await (tails.get(imageId) ?? Promise.resolve());
}

/**
 * Drop an unsent old snapshot, then delete after every already-started PUT.
 * A fresh-baseline save scheduled by the reset render is queued after DELETE.
 */
export async function resetSettings(imageId: string): Promise<void> {
  // This must happen before the first await. A slow GET returning after DELETE
  // must not reapply the deleted Min/Max and schedule it as a fresh PUT.
  invalidateSettingsLoad(imageId);
  const item = pending.get(imageId);
  if (item) {
    clearTimeout(item.timer);
    pending.delete(imageId);
  }
  latest.delete(imageId);
  await enqueue(imageId, async () => {
    await deleteViewSettings(imageId);
  });
}

/** Forget timers for a server image id that no longer exists. */
export function discardSettingsWork(imageId: string): void {
  invalidateSettingsLoad(imageId);
  const item = pending.get(imageId);
  if (item) clearTimeout(item.timer);
  pending.delete(imageId);
  latest.delete(imageId);
}

/**
 * Queue the latest snapshot with `keepalive` before the renderer disappears.
 * This deliberately bypasses the in-page Promise tail: an unload destroys its
 * future microtasks. The backend's per-renderer sequence rejects any older PUT
 * that happens to finish after this last request.
 */
export function flushPendingSettingsForUnload(): void {
  for (const [imageId, item] of latest) {
    const waiting = pending.get(imageId);
    if (waiting) {
      clearTimeout(waiting.timer);
      pending.delete(imageId);
    }
    void putViewSettings(
      imageId, item.settings, clientSession, item.sequence,
    ).catch(ignoreUnloadSaveError());
  }
}

function ignoreUnloadSaveError(): SaveErrorHandler {
  // The document is leaving, so there is no durable UI on which to report this.
  // Normal in-app writes still use their supplied visible error handler.
  return () => undefined;
}

/** Test/diagnostic boundary: no queued write remains when this resolves. */
export async function waitForSettingsIdle(imageId: string): Promise<void> {
  await flushSettings(imageId);
}
