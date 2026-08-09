import { useEffect, useRef } from 'react';
import {
  useImageStore,
  type ImageViewState,
  type PreparedChannelResponse,
  type PreparedImageView,
} from '../stores/imageStore';
import { useViewStore, type ViewMode } from '../stores/viewStore';
import {
  fetchMetadata, openFile, uploadFile,
  listImages, activateImage, closeImage,
  type AllChannelsBinResponse,
  type ImageMetadata,
  type SavedImageView,
} from '../utils/api';
import { fetchAllChannelsCached, prefetchSlice, clearImageCache } from '../utils/sliceCache';
import {
  discardSettingsWork,
  flushSettings,
  flushPendingSettingsForUnload,
  loadSettings,
  scheduleSettingsSave,
} from '../utils/settingsStore';
import {
  defaultViewMode, rememberableViewMode, rememberedOrDefaultViewMode,
} from '../utils/imageViewMode';
import { threeDSaveIsBusy } from '../stores/operationStore';

/** Human-readable message for a failed load, for the error toast. */
function describeError(e: unknown, what: string): string {
  const detail = e instanceof Error ? e.message : String(e);
  return `${what}: ${detail}`;
}

/**
 * Last path segment, for either separator. Splitting on '/' alone left Windows
 * paths whole, so a message meant to name one file printed its entire
 * `C:\Users\...` path and pushed the actual reason off the end.
 */
export function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * Monotonic token for whole-image switches. Rapid tab clicks used to interleave —
 * one run's metadata could land with another run's pixels — so every entry point
 * that swaps the active image takes a token and abandons its writes if a newer
 * switch has started.
 */
let switchToken = 0;

/**
 * Whole-image operations are serialized, not merely guarded when their UI
 * responses land. A slow Open request also changes the backend's active image;
 * allowing a later tab switch or Drop to overtake it left the frontend and the
 * persisted backend session naming different active images. The queue keeps the
 * server-side transition order identical to the order observed here.
 */
let imageOperationTail: Promise<void> = Promise.resolve();
let imageOperationRunning = false;
let imageOperationPending = 0;

export async function runImageOperation<T>(
  operation: () => Promise<T>,
  blockedResult: T,
): Promise<T> {
  const previous = imageOperationTail;
  let release!: () => void;
  imageOperationTail = new Promise<void>((resolve) => { release = resolve; });
  imageOperationPending += 1;
  try {
    await previous;
    // The operation may have queued before a 3D save acquired its lock. Recheck
    // after the queue wait so that an old tab/open request cannot unmount the
    // volume in the middle of a later save.
    if (threeDSaveIsBusy()) return blockedResult;
    imageOperationRunning = true;
    return await operation();
  } finally {
    imageOperationRunning = false;
    imageOperationPending -= 1;
    release();
  }
}

/** A save may acquire navigation ownership only when this queue is empty. */
export const imageOperationIsBusy = (): boolean => (
  imageOperationRunning || imageOperationPending > 0
);

/**
 * Image ids whose persisted settings have already been applied this session.
 * Keyed by id rather than source path: keying by path meant re-opening the same
 * file skipped the restore and then persisted its auto levels over the user's
 * saved window, and it re-applied stale settings on every switch back.
 */
const appliedSettings = new Set<string>();

interface PersistedSettingsLoad {
  settings: SavedImageView | null;
  error: unknown | null;
}

const applyingSettings = new Map<string, Promise<PersistedSettingsLoad>>();

/** Session-only 2D/3D choice for an image the user has already visited. */
const rememberedViewModes = new Map<string, Extract<ViewMode, '2d' | '3d'>>();
const presentedViewIds = new Set<string>();

function rememberActiveViewMode(): void {
  const imageId = useImageStore.getState().activeImageId;
  const mode = useViewStore.getState().viewMode;
  const rememberable = imageId
    ? rememberableViewMode(presentedViewIds.has(imageId), mode) : undefined;
  if (imageId && rememberable) {
    rememberedViewModes.set(imageId, rememberable);
  }
}

function showRememberedOrDefaultView(imageId: string, numZ: number): void {
  const remembered = rememberedViewModes.get(imageId);
  useViewStore.getState().setViewMode(rememberedOrDefaultViewMode(remembered, numZ));
  presentedViewIds.add(imageId);
}

/** Load one persisted snapshot without publishing any of its labels yet. */
async function loadSettingsOnce(
  id: string,
  metadata: ImageMetadata,
): Promise<PersistedSettingsLoad> {
  if (appliedSettings.has(id)) return { settings: null, error: null };
  const existing = applyingSettings.get(id);
  if (existing) return existing;

  const task = (async () => {
    // Dummy/dev images and unsupported old session entries have no stable
    // source token. They remain usable, but must not enter persistent storage.
    if (!metadata.source_identity || !metadata.source_revision) {
      return { settings: null, error: null };
    }
    try {
      const settings = await loadSettings(
        id, metadata.source_identity, metadata.source_revision,
      );
      return { settings, error: null };
    } catch (e) {
      // Saved view state is optional. A corrupt/unreadable store must never make
      // an image that already loaded look as if the source itself failed to open.
      // The caller presents the source baseline and surfaces this separately.
      return { settings: null, error: e };
    }
  })();
  applyingSettings.set(id, task);
  try {
    return await task;
  } finally {
    if (applyingSettings.get(id) === task) applyingSettings.delete(id);
  }
}

/** Refresh the image list from the server. */
export async function refreshImageList() {
  const list = await listImages();
  useImageStore.getState().setImageList(list);
  return list;
}

interface OutgoingSource {
  id: string;
  sourceIdentity: string;
  sourceRevision: string;
}

function captureOutgoingSource(): OutgoingSource | null {
  const state = useImageStore.getState();
  if (!state.activeImageId || !state.metadata) return null;
  return {
    id: state.activeImageId,
    sourceIdentity: state.metadata.source_identity,
    sourceRevision: state.metadata.source_revision,
  };
}

/** Capture edits made to the old image while a slow replacement was staging. */
function saveOutgoingIfStillCurrent(outgoing: OutgoingSource | null): void {
  if (!outgoing) return;
  const state = useImageStore.getState();
  state.saveViewStateIfSource(
    outgoing.id, outgoing.sourceIdentity, outgoing.sourceRevision,
  );
}

/** Best-effort repair after the backend opened/activated an image we could not present. */
async function reconcileBackendActive(previousImageId: string | null): Promise<void> {
  try {
    if (previousImageId) await activateImage(previousImageId);
    await refreshImageList();
  } catch {
    // Preserve the original, more useful load error. The next list refresh or
    // tab click can retry this secondary reconciliation explicitly.
  }
}

function applyDefaultViewForActiveImage(expectedImageId?: string): boolean {
  const { activeImageId, metadata } = useImageStore.getState();
  if (expectedImageId && activeImageId !== expectedImageId) return false;
  useViewStore.getState().setViewMode(defaultViewMode(metadata?.num_z ?? 0));
  if (activeImageId) presentedViewIds.add(activeImageId);
  return true;
}

/** Show the format-appropriate default after one complete batch activation. */
export function showDefaultViewForActiveImage(expectedImageId?: string): boolean {
  // A different Open/Switch has already started. Let that operation choose its
  // own final mode instead of mounting a Maximum volume for the outgoing image.
  if (imageOperationRunning) return false;
  const { activeImageId, metadata } = useImageStore.getState();
  if (expectedImageId && activeImageId !== expectedImageId) return false;
  // A batch may end on an existing inactive tab returned by backend dedup. It
  // is a tab switch, not a fresh open, so keep the user's remembered 2D/3D mode.
  if (activeImageId && presentedViewIds.has(activeImageId)) {
    showRememberedOrDefaultView(activeImageId, metadata?.num_z ?? 0);
    return true;
  }
  return applyDefaultViewForActiveImage(expectedImageId);
}

export interface ChannelRequestSnapshot {
  id: string;
  sourceIdentity: string;
  sourceRevision: string;
  currentZ: number;
  currentT: number;
  showMIP: boolean;
  projection: {
    active: boolean;
    method: 'max' | 'min' | 'avg';
    zFrom: number;
    zTo: number;
  };
}

/** Freeze every coordinate that gives a channel response its meaning. */
export function captureChannelRequest(id?: string): ChannelRequestSnapshot | null {
  const state = useImageStore.getState();
  const imageId = id ?? state.activeImageId;
  if (!imageId || state.activeImageId !== imageId || !state.metadata) return null;
  return {
    id: imageId,
    sourceIdentity: state.metadata.source_identity,
    sourceRevision: state.metadata.source_revision,
    currentZ: state.currentZ,
    currentT: state.currentT,
    showMIP: state.showMIP,
    projection: { ...state.projection },
  };
}

export function channelRequestStillCurrent(request: ChannelRequestSnapshot): boolean {
  const state = useImageStore.getState();
  const projection = state.projection;
  return state.activeImageId === request.id
    && state.metadata?.source_identity === request.sourceIdentity
    && state.metadata?.source_revision === request.sourceRevision
    && state.currentZ === request.currentZ
    && state.currentT === request.currentT
    && state.showMIP === request.showMIP
    && projection.active === request.projection.active
    && projection.method === request.projection.method
    && projection.zFrom === request.projection.zFrom
    && projection.zTo === request.projection.zTo;
}

type ChannelResponse = PreparedChannelResponse;

/** Fetch the one plane that defines the file-derived reset baseline. */
async function fetchSourceBaseline(id: string): Promise<AllChannelsBinResponse> {
  return fetchAllChannelsCached({
    z: 0,
    t: 0,
    mip: false,
    proj: false,
    projMethod: 'max',
    projZFrom: 0,
    projZTo: 0,
    id,
  });
}

interface PreparedImageLoad {
  sourceResponse: AllChannelsBinResponse;
  targetResponse: AllChannelsBinResponse;
  view: PreparedImageView;
  sessionState?: ImageViewState;
  persistedSettings?: SavedImageView;
  settingsError: unknown | null;
}

function clampIndex(value: number, size: number): number {
  const index = Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.max(0, Math.min(index, Math.max(0, size - 1)));
}

function resolvedPreparedView(
  metadata: ImageMetadata,
  sessionState: ImageViewState | undefined,
  persistedSettings: SavedImageView | null,
): PreparedImageView {
  const currentZ = clampIndex(
    sessionState?.currentZ ?? persistedSettings?.currentZ ?? 0,
    metadata.num_z,
  );
  const currentT = clampIndex(
    sessionState?.currentT ?? persistedSettings?.currentT ?? 0,
    metadata.num_t,
  );
  const savedProjection = sessionState?.projection;
  const maxZ = Math.max(0, metadata.num_z - 1);
  const zFrom = clampIndex(savedProjection?.zFrom ?? 0, metadata.num_z);
  const zTo = clampIndex(savedProjection?.zTo ?? maxZ, metadata.num_z);
  return {
    currentZ,
    currentT,
    showMIP: sessionState?.showMIP ?? persistedSettings?.showMIP ?? false,
    projection: savedProjection
      ? {
          ...savedProjection,
          zFrom: Math.min(zFrom, zTo),
          zTo: Math.max(zFrom, zTo),
        }
      : { active: false, method: 'max', zFrom: 0, zTo: maxZ },
  };
}

function assertResponseGeometry(
  metadata: ImageMetadata,
  response: AllChannelsBinResponse,
  label: string,
): void {
  if (response.width !== metadata.width || response.height !== metadata.height) {
    throw new Error(
      `${label}: received ${response.width}x${response.height}; expected ${metadata.width}x${metadata.height}`,
    );
  }
}

/** Stage baseline, saved state and its exact pixels while the old image stays coherent. */
async function prepareImageLoad(
  id: string,
  metadata: ImageMetadata,
  sessionState?: ImageViewState,
): Promise<PreparedImageLoad> {
  const settingsTask = sessionState
    ? Promise.resolve<PersistedSettingsLoad>({ settings: null, error: null })
    : loadSettingsOnce(id, metadata);
  const [sourceResponse, loaded] = await Promise.all([
    fetchSourceBaseline(id),
    settingsTask,
  ]);
  assertResponseGeometry(metadata, sourceResponse, 'Source baseline');

  const persistedSettings = sessionState ? null : loaded.settings;
  const view = resolvedPreparedView(metadata, sessionState, persistedSettings);
  const usesSourcePixels = view.currentZ === 0
    && view.currentT === 0
    && !view.showMIP
    && !view.projection.active;
  const targetResponse = usesSourcePixels
    ? sourceResponse
    : await fetchAllChannelsCached({
        z: view.currentZ,
        t: view.currentT,
        mip: view.showMIP && !view.projection.active,
        proj: view.projection.active,
        projMethod: view.projection.method,
        projZFrom: view.projection.zFrom,
        projZTo: view.projection.zTo,
        id,
      });
  assertResponseGeometry(metadata, targetResponse, 'Restored view');
  return {
    sourceResponse,
    targetResponse,
    view,
    sessionState,
    ...(persistedSettings ? { persistedSettings } : {}),
    settingsError: loaded.error,
  };
}

function presentPreparedImage(
  id: string,
  metadata: ImageMetadata,
  prepared: PreparedImageLoad,
): void {
  const store = useImageStore.getState();
  store.presentPreparedImage({
    id,
    metadata,
    sourceResponse: prepared.sourceResponse,
    targetResponse: prepared.targetResponse,
    view: prepared.view,
    ...(prepared.sessionState ? { sessionState: prepared.sessionState } : {}),
    ...(prepared.persistedSettings
      ? { persistedSettings: prepared.persistedSettings }
      : {}),
  });
  appliedSettings.add(id);
  if (prepared.settingsError) {
    store.setLoadError(describeError(
      prepared.settingsError, 'Failed to restore view settings',
    ));
  }
}

/** Apply pixels only while they still name the active image and plane. */
export function applyChannelResponseIfCurrent(
  request: ChannelRequestSnapshot,
  response: ChannelResponse,
): boolean {
  if (!channelRequestStillCurrent(request)) return false;
  const state = useImageStore.getState();
  for (const channel of response.channels) {
    state.setChannelData(channel.channel, channel.data, channel.auto_min, channel.auto_max);
  }
  // This is still the fresh state on first open. Persisted overrides are applied
  // only after this snapshot exists, so reset can reproduce fallback auto levels.
  state.captureSourceDefaults();
  return true;
}

/** Load channel data for the currently active image. */
export async function reloadActiveChannelData(id?: string): Promise<boolean> {
  const request = captureChannelRequest(id);
  if (!request) return false;
  const response = await fetchAllChannelsCached({
    z: request.currentZ,
    t: request.currentT,
    mip: request.showMIP && !request.projection.active,
    proj: request.projection.active,
    projMethod: request.projection.method,
    projZFrom: request.projection.zFrom,
    projZTo: request.projection.zTo,
    id: request.id,
  });
  return applyChannelResponseIfCurrent(request, response);
}

/** Switch to a different image by ID. */
async function switchToImageNow(id: string) {
  const store = useImageStore.getState();
  if (id === store.activeImageId) return;

  const outgoing = captureOutgoingSource();
  const previousImageId = store.activeImageId;
  const previousViewMode = useViewStore.getState().viewMode;
  const token = ++switchToken;
  store.setLoading(true);
  store.setLoadError(null);
  rememberActiveViewMode();
  // Unmount the previous WebGL volume before loading another multi-gigabyte
  // source. The new image enters its own default view only after its metadata,
  // pixels and persisted display settings agree.
  useViewStore.getState().setViewMode('2d');
  try {
    // Save current view state
    store.saveViewState();

    // Activate on server
    await activateImage(id);
    if (token !== switchToken) return;

    // Load metadata
    const m = await fetchMetadata(id);
    if (token !== switchToken) return;
    const saved = useImageStore.getState().imageViewStates[id];
    const prepared = await prepareImageLoad(id, m, saved);
    if (token !== switchToken) return;
    saveOutgoingIfStillCurrent(outgoing);
    presentPreparedImage(id, m, prepared);

    // Refresh list
    await refreshImageList();
    if (token !== switchToken) return;
    showRememberedOrDefaultView(id, m.num_z);
  } catch (e) {
    if (token === switchToken) {
      if (useImageStore.getState().activeImageId === previousImageId) {
        await reconcileBackendActive(previousImageId);
        useViewStore.getState().setViewMode(previousViewMode);
      }
      store.setLoadError(describeError(e, 'Failed to open image'));
    }
  } finally {
    if (token === switchToken) store.setLoading(false);
  }
}

export function switchToImage(id: string): Promise<void> {
  if (threeDSaveIsBusy()) return Promise.resolve();
  return runImageOperation(() => switchToImageNow(id), undefined);
}

/** Close an image by ID. */
async function closeImageByIdNow(id: string) {
  const store = useImageStore.getState();
  const wasActive = id === store.activeImageId;
  const stayOn = wasActive ? null : store.activeImageId;

  const token = ++switchToken;
  store.setLoading(true);
  store.setLoadError(null);
  try {
    // Persist the current image's channel setup before anything reshuffles;
    // closing a tab used to discard it and then re-init from defaults.
    rememberActiveViewMode();
    store.saveViewState();
    await flushSettings(id);

    const result = await closeImage(id);
    if (token !== switchToken) return;
    store.removeImageState(id);
    rememberedViewModes.delete(id);
    presentedViewIds.delete(id);
    clearImageCache(id);
    appliedSettings.delete(id);
    discardSettingsWork(id);

    if (stayOn) {
      // Closing a background tab must not move the user. The server picked its
      // own next active image when we deleted one, so put ours back.
      await activateImage(stayOn);
      if (token !== switchToken) return;
    } else if (result.active_id) {
      // The active image went away — follow the server's choice.
      useViewStore.getState().setViewMode('2d');
      const m = await fetchMetadata(result.active_id);
      if (token !== switchToken) return;
      const saved = useImageStore.getState().imageViewStates[result.active_id];
      const prepared = await prepareImageLoad(result.active_id, m, saved);
      if (token !== switchToken) return;
      presentPreparedImage(result.active_id, m, prepared);
      showRememberedOrDefaultView(result.active_id, m.num_z);
    } else {
      // No images left
      store.setActiveImageId(null);
      store.setMetadata(null);
      store.initChannels(0);
      useViewStore.getState().setViewMode('2d');
    }

    await refreshImageList();
  } catch (e) {
    if (token === switchToken) store.setLoadError(describeError(e, 'Failed to close image'));
  } finally {
    if (token === switchToken) store.setLoading(false);
  }
}


export function closeImageById(id: string): Promise<void> {
  if (threeDSaveIsBusy()) return Promise.resolve();
  return runImageOperation(() => closeImageByIdNow(id), undefined);
}

/**
 * Open a file by path, add to image list.
 *
 * Rethrows so a caller can still react, but records the failure in the store on
 * the way out. Callers used to own that entirely, and the toolbar's Open button
 * put its message somewhere that was not on screen — a failed open then looked
 * exactly like nothing happening at all. The store's toast is always mounted,
 * so routing through it means no open can fail silently again.
 */
async function openAndReloadNow(
  path: string,
  options: { showDefaultView?: boolean } = {},
): Promise<string | null> {
  const store = useImageStore.getState();
  const outgoing = captureOutgoingSource();
  const previousImageId = store.activeImageId;
  const previousViewMode = useViewStore.getState().viewMode;
  const token = ++switchToken;
  rememberActiveViewMode();
  store.saveViewState();
  store.setLoading(true);
  store.setLoadError(null);
  // An exact same-path Open is commonly a double click. Keep its live 3D/2D
  // mode mounted; the backend will report `reused` and no presentation work is
  // needed. Unknown paths still release the outgoing WebGL volume before decode.
  const keptLiveMode = previousImageId !== null
    && store.metadata?.source_path === path;
  if (!keptLiveMode) useViewStore.getState().setViewMode('2d');
  try {
    const m = await openFile(path);
    if (token !== switchToken) return null;
    const id = m.id!;

    if (m.reused) {
      const known = id === previousImageId
        ? useImageStore.getState().metadata
        : store.imageList.find((item) => item.id === id);
      if (known && (known.source_identity !== m.source_identity
          || known.source_revision !== m.source_revision)) {
        throw new Error('再利用されたタブの元画像が、現在の表示状態と一致しません');
      }
    }

    if (m.reused && id === previousImageId) {
      // The source, pixels and controls are already the authoritative live view.
      // In particular, do not let durable settings overwrite newer unsaved edits.
      saveOutgoingIfStillCurrent(outgoing);
      await refreshImageList();
      if (token !== switchToken) return null;
      if (!keptLiveMode) useViewStore.getState().setViewMode(previousViewMode);
      return id;
    }

    const sessionState = m.reused
      ? useImageStore.getState().imageViewStates[id]
      : undefined;
    if (m.reused && appliedSettings.has(id) && !sessionState) {
      throw new Error('既存タブの表示状態が見つからないため、安全に再表示できません');
    }
    const prepared = await prepareImageLoad(id, m, sessionState);
    if (token !== switchToken) return null;
    saveOutgoingIfStillCurrent(outgoing);
    presentPreparedImage(id, m, prepared);
    await refreshImageList();
    if (token !== switchToken) return null;
    if (options.showDefaultView !== false) {
      if (m.reused) showRememberedOrDefaultView(id, m.num_z);
      else applyDefaultViewForActiveImage(id);
    }
    return id;
  } catch (e) {
    if (token === switchToken) {
      if (useImageStore.getState().activeImageId === previousImageId) {
        await reconcileBackendActive(previousImageId);
        useViewStore.getState().setViewMode(previousViewMode);
      }
      store.setLoadError(describeError(e, `${basename(path)} を開けません`));
    }
    throw e;
  } finally {
    if (token === switchToken) store.setLoading(false);
  }
}

export function openAndReload(
  path: string,
  options: { showDefaultView?: boolean } = {},
): Promise<string | null> {
  if (threeDSaveIsBusy()) return Promise.resolve(null);
  return runImageOperation(() => openAndReloadNow(path, options), null);
}

/** Upload a File object, add to image list. */
async function uploadAndReloadNow(
  file: File,
  options: { showDefaultView?: boolean } = {},
): Promise<string | null> {
  const store = useImageStore.getState();
  const outgoing = captureOutgoingSource();
  const previousImageId = store.activeImageId;
  const previousViewMode = useViewStore.getState().viewMode;
  const token = ++switchToken;
  rememberActiveViewMode();
  store.saveViewState();
  store.setLoading(true);
  store.setLoadError(null);
  useViewStore.getState().setViewMode('2d');
  try {
    const m = await uploadFile(file);
    if (token !== switchToken) return null;
    const id = m.id!;
    const prepared = await prepareImageLoad(id, m);
    if (token !== switchToken) return null;
    saveOutgoingIfStillCurrent(outgoing);
    presentPreparedImage(id, m, prepared);
    await refreshImageList();
    if (token !== switchToken) return null;
    if (options.showDefaultView !== false) applyDefaultViewForActiveImage(id);
    return id;
  } catch (e) {
    if (token === switchToken) {
      if (useImageStore.getState().activeImageId === previousImageId) {
        await reconcileBackendActive(previousImageId);
        useViewStore.getState().setViewMode(previousViewMode);
      }
      store.setLoadError(describeError(e, `${file.name} を読み込めません`));
    }
    throw e;
  } finally {
    if (token === switchToken) store.setLoading(false);
  }
}


export function uploadAndReload(
  file: File,
  options: { showDefaultView?: boolean } = {},
): Promise<string | null> {
  if (threeDSaveIsBusy()) return Promise.resolve(null);
  return runImageOperation(() => uploadAndReloadNow(file, options), null);
}

export function useImageLoader() {
  const metadata = useImageStore((s) => s.metadata);
  const activeImageId = useImageStore((s) => s.activeImageId);
  const currentZ = useImageStore((s) => s.currentZ);
  const currentT = useImageStore((s) => s.currentT);
  const showMIP = useImageStore((s) => s.showMIP);
  const projection = useImageStore((s) => s.projection);

  const loadIdRef = useRef(0);

  // A debounced Min/Max edit must not disappear when the user closes the app
  // during its 400 ms quiet period. putViewSettings uses fetch keepalive, and
  // the backend sequence makes this final request win over an older in-flight
  // snapshot from the same renderer.
  useEffect(() => {
    const flush = () => flushPendingSettingsForUnload();
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, []);

  // Load initial state on mount
  useEffect(() => {
    let cancelled = false;
    let operationToken: number | null = null;
    void runImageOperation(async () => {
      if (cancelled) return;
      const token = ++switchToken;
      operationToken = token;
      const store = useImageStore.getState();
      store.setLoading(true);
      try {
        const list = await refreshImageList();
        if (token !== switchToken) return;
        const active = list.find(i => i.active);
        if (active) {
          useViewStore.getState().setViewMode('2d');
          const m = await fetchMetadata(active.id);
          if (token !== switchToken) return;
          const saved = useImageStore.getState().imageViewStates[active.id];
          const prepared = await prepareImageLoad(active.id, m, saved);
          if (token !== switchToken) return;
          presentPreparedImage(active.id, m, prepared);
          applyDefaultViewForActiveImage(active.id);
        }
      } catch (e) {
        if (token === switchToken) {
          store.setLoadError(describeError(e, 'Failed to restore the previous session'));
        }
      } finally {
        if (token === switchToken) store.setLoading(false);
      }
    }, undefined);
    return () => {
      cancelled = true;
      if (operationToken === switchToken) switchToken += 1;
    };
  }, []);

  // Load channel data when Z/T/MIP/projection changes
  useEffect(() => {
    if (!metadata || !activeImageId) return;
    const loadId = ++loadIdRef.current;
    const store = useImageStore.getState();
    const request = captureChannelRequest(activeImageId);
    if (!request) return;
    store.setLoading(true);

    (async () => {
      try {
        const resp = await fetchAllChannelsCached({
          z: request.currentZ,
          t: request.currentT,
          mip: request.showMIP && !request.projection.active,
          proj: request.projection.active,
          projMethod: request.projection.method,
          projZFrom: request.projection.zFrom,
          projZTo: request.projection.zTo,
          id: request.id,
        });
        if (loadId !== loadIdRef.current) return;
        if (!applyChannelResponseIfCurrent(request, resp)) return;

        // Warm neighbouring slices so scrubbing / playback feels instant.
        if (metadata && !request.showMIP && !request.projection.active) {
          const nZ = metadata.num_z;
          const nT = metadata.num_t;
          for (const dz of [1, -1]) {
            const z = request.currentZ + dz;
            if (z >= 0 && z < nZ) {
              prefetchSlice({ z, t: request.currentT, id: request.id });
            }
          }
          for (const dt of [1, -1]) {
            const tt = request.currentT + dt;
            if (tt >= 0 && tt < nT) {
              prefetchSlice({ z: request.currentZ, t: tt, id: request.id });
            }
          }
        }
      } catch (e) {
        // Previously an unhandled rejection: the canvas kept the old plane and
        // the user got no indication that this Z/T never loaded.
        if (loadId === loadIdRef.current) {
          store.setLoadError(describeError(e, 'Failed to load image data'));
        }
      } finally {
        if (loadId === loadIdRef.current) store.setLoading(false);
      }
    })();
  }, [metadata, activeImageId, currentZ, currentT, showMIP, projection]);

  // Persist settings (debounced) whenever the active image's view changes.
  const channels = useImageStore((s) => s.channels);
  useEffect(() => {
    if (!metadata || !activeImageId) return;
    if (!metadata.source_identity || !metadata.source_revision) return;
    // Don't persist until this image's saved settings have been applied,
    // otherwise the freshly-loaded auto levels would overwrite the saved ones.
    if (!appliedSettings.has(activeImageId)) return;

    // Snapshot from THIS render rather than reading the store when the timer
    // fires. By then the live store may hold another image; persisting that under
    // this server id is how the last edits before a switch get mis-attributed.
    const snapshot = {
      channels: channels.map((ch) => ({
        color: ch.color,
        min: ch.min,
        max: ch.max,
        visible: ch.visible,
      })),
      currentZ,
      currentT,
      showMIP,
    };
    const sourceIdentity = metadata.source_identity;
    const sourceRevision = metadata.source_revision;
    scheduleSettingsSave(activeImageId, snapshot, (e) => {
      const current = useImageStore.getState();
      if (current.activeImageId === activeImageId
          && current.metadata?.source_identity === sourceIdentity
          && current.metadata?.source_revision === sourceRevision) {
        current.setLoadError(describeError(e, 'Failed to save view settings'));
      }
    });
  }, [metadata, activeImageId, channels, currentZ, currentT, showMIP]);
}
