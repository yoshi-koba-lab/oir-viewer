import { useEffect, useRef } from 'react';
import { useImageStore } from '../stores/imageStore';
import {
  fetchMetadata, openFile, uploadFile,
  listImages, activateImage, closeImage,
} from '../utils/api';
import { fetchAllChannelsCached, prefetchSlice, clearImageCache } from '../utils/sliceCache';
import { loadSettings, saveSettings } from '../utils/settingsStore';

/** Apply persisted per-source_path settings after channel data has loaded. */
function applySavedSettings(sourcePath: string) {
  const saved = loadSettings(sourcePath);
  if (!saved) return;
  const store = useImageStore.getState();
  saved.channels.forEach((s, c) => {
    const ch = store.channels[c];
    if (!ch) return;
    store.setChannelColor(c, s.color);
    store.setChannelRange(c, s.min, s.max);
    if (ch.visible !== s.visible) store.toggleChannel(c);
  });
  if (typeof saved.showMIP === 'boolean') store.setShowMIP(saved.showMIP);
  // setCurrentZ/setCurrentT clamp against the freshly loaded metadata, so a
  // saved index from a deeper version of this path cannot land out of range.
  if (Number.isInteger(saved.currentZ)) store.setCurrentZ(saved.currentZ);
  if (Number.isInteger(saved.currentT)) store.setCurrentT(saved.currentT);
}

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
 * Image ids whose persisted settings have already been applied this session.
 * Keyed by id rather than source_path: keying by path meant re-opening the same
 * file skipped the restore and then persisted its auto levels over the user's
 * saved window, and it re-applied stale localStorage on every switch back.
 */
const appliedSettings = new Set<string>();

/** Refresh the image list from the server. */
export async function refreshImageList() {
  const list = await listImages();
  useImageStore.getState().setImageList(list);
  return list;
}

/** Load channel data for the currently active image. */
async function loadChannelData(id?: string) {
  const store = useImageStore.getState();
  const { currentZ, currentT, showMIP, projection } = store;
  const resp = await fetchAllChannelsCached({
    z: currentZ,
    t: currentT,
    mip: showMIP && !projection.active,
    proj: projection.active,
    projMethod: projection.method,
    projZFrom: projection.zFrom,
    projZTo: projection.zTo,
    id,
  });
  for (const ch of resp.channels) {
    store.setChannelData(ch.channel, ch.data, ch.auto_min, ch.auto_max);
  }
}

/** Switch to a different image by ID. */
export async function switchToImage(id: string) {
  const store = useImageStore.getState();
  if (id === store.activeImageId) return;

  const token = ++switchToken;
  store.setLoading(true);
  store.setLoadError(null);
  try {
    // Save current view state
    store.saveViewState();

    // Activate on server
    await activateImage(id);
    if (token !== switchToken) return;

    // Load metadata
    const m = await fetchMetadata(id);
    if (token !== switchToken) return;
    store.setActiveImageId(id);
    store.setMetadata(m);

    // Restore saved view state or init fresh
    const saved = store.imageViewStates[id];
    if (saved) {
      store.restoreViewState(id);
    } else {
      store.initChannels(m.num_channels);
      store.setCurrentZ(0);
      store.setCurrentT(0);
      store.setShowMIP(false);
      store.setProjection({ active: false, method: 'max', zFrom: 0, zTo: m.num_z - 1 });
    }

    // Load channel data
    await loadChannelData(id);
    if (token !== switchToken) return;

    // Refresh list
    await refreshImageList();
  } catch (e) {
    if (token === switchToken) store.setLoadError(describeError(e, 'Failed to open image'));
  } finally {
    if (token === switchToken) store.setLoading(false);
  }
}

/** Close an image by ID. */
export async function closeImageById(id: string) {
  const store = useImageStore.getState();
  const wasActive = id === store.activeImageId;
  const stayOn = wasActive ? null : store.activeImageId;

  const token = ++switchToken;
  store.setLoading(true);
  store.setLoadError(null);
  try {
    // Persist the current image's channel setup before anything reshuffles;
    // closing a tab used to discard it and then re-init from defaults.
    store.saveViewState();

    const result = await closeImage(id);
    if (token !== switchToken) return;
    store.removeImageState(id);
    clearImageCache(id);
    appliedSettings.delete(id);

    if (stayOn) {
      // Closing a background tab must not move the user. The server picked its
      // own next active image when we deleted one, so put ours back.
      await activateImage(stayOn);
      if (token !== switchToken) return;
    } else if (result.active_id) {
      // The active image went away — follow the server's choice.
      const m = await fetchMetadata(result.active_id);
      if (token !== switchToken) return;
      store.setActiveImageId(result.active_id);
      store.setMetadata(m);

      const saved = store.imageViewStates[result.active_id];
      if (saved) {
        store.restoreViewState(result.active_id);
      } else {
        store.initChannels(m.num_channels);
        store.setCurrentZ(0);
        store.setCurrentT(0);
        store.setShowMIP(false);
        store.setProjection({ active: false, method: 'max', zFrom: 0, zTo: m.num_z - 1 });
      }
      await loadChannelData(result.active_id);
      if (token !== switchToken) return;
    } else {
      // No images left
      store.setActiveImageId(null);
      store.setMetadata(null);
      store.initChannels(0);
    }

    await refreshImageList();
  } catch (e) {
    if (token === switchToken) store.setLoadError(describeError(e, 'Failed to close image'));
  } finally {
    if (token === switchToken) store.setLoading(false);
  }
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
export async function openAndReload(path: string) {
  const store = useImageStore.getState();
  store.saveViewState();
  store.setLoading(true);
  store.setLoadError(null);
  try {
    const m = await openFile(path);
    const id = m.id!;
    store.setActiveImageId(id);
    store.setMetadata(m);
    store.initChannels(m.num_channels);
    store.setCurrentZ(0);
    store.setCurrentT(0);
    store.setShowMIP(false);
    store.setProjection({ active: false, method: 'max', zFrom: 0, zTo: m.num_z - 1 });

    await loadChannelData(id);
    await refreshImageList();
  } catch (e) {
    store.setLoadError(describeError(e, `${basename(path)} を開けません`));
    throw e;
  } finally {
    store.setLoading(false);
  }
}

/** Upload a File object, add to image list. */
export async function uploadAndReload(file: File) {
  const store = useImageStore.getState();
  store.saveViewState();
  store.setLoading(true);
  store.setLoadError(null);
  try {
    const m = await uploadFile(file);
    const id = m.id!;
    store.setActiveImageId(id);
    store.setMetadata(m);
    store.initChannels(m.num_channels);
    store.setCurrentZ(0);
    store.setCurrentT(0);
    store.setShowMIP(false);
    store.setProjection({ active: false, method: 'max', zFrom: 0, zTo: m.num_z - 1 });

    await loadChannelData(id);
    await refreshImageList();
  } catch (e) {
    store.setLoadError(describeError(e, `${file.name} を読み込めません`));
    throw e;
  } finally {
    store.setLoading(false);
  }
}

export function useImageLoader() {
  const metadata = useImageStore((s) => s.metadata);
  const activeImageId = useImageStore((s) => s.activeImageId);
  const currentZ = useImageStore((s) => s.currentZ);
  const currentT = useImageStore((s) => s.currentT);
  const showMIP = useImageStore((s) => s.showMIP);
  const projection = useImageStore((s) => s.projection);

  const loadIdRef = useRef(0);

  // Load initial state on mount
  useEffect(() => {
    (async () => {
      const store = useImageStore.getState();
      const list = await refreshImageList();
      const active = list.find(i => i.active);
      if (active) {
        const m = await fetchMetadata(active.id);
        store.setActiveImageId(active.id);
        store.setMetadata(m);
        store.initChannels(m.num_channels);
      }
    })();
  }, []);

  // Load channel data when Z/T/MIP/projection changes
  useEffect(() => {
    if (!metadata || !activeImageId) return;
    const loadId = ++loadIdRef.current;
    const store = useImageStore.getState();
    store.setLoading(true);

    (async () => {
      try {
        const p = store.projection;
        const resp = await fetchAllChannelsCached({
          z: currentZ,
          t: currentT,
          mip: showMIP && !p.active,
          proj: p.active,
          projMethod: p.method,
          projZFrom: p.zFrom,
          projZTo: p.zTo,
          id: activeImageId,
        });
        if (loadId !== loadIdRef.current) return;
        for (const ch of resp.channels) {
          store.setChannelData(ch.channel, ch.data, ch.auto_min, ch.auto_max);
        }

        // Apply persisted settings once per image, after the first data load
        // (so saved contrast overrides the auto levels set by setChannelData).
        if (metadata.source_path && !appliedSettings.has(activeImageId)) {
          appliedSettings.add(activeImageId);
          applySavedSettings(metadata.source_path);
        }

        // Warm neighbouring slices so scrubbing / playback feels instant.
        if (metadata && !showMIP && !p.active) {
          const nZ = metadata.num_z;
          const nT = metadata.num_t;
          for (const dz of [1, -1]) {
            const z = currentZ + dz;
            if (z >= 0 && z < nZ) prefetchSlice({ z, t: currentT, id: activeImageId });
          }
          for (const dt of [1, -1]) {
            const tt = currentT + dt;
            if (tt >= 0 && tt < nT) prefetchSlice({ z: currentZ, t: tt, id: activeImageId });
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
    if (!metadata?.source_path || !activeImageId) return;
    // Don't persist until this image's saved settings have been applied,
    // otherwise the freshly-loaded auto levels would overwrite the saved ones.
    if (!appliedSettings.has(activeImageId)) return;

    const sourcePath = metadata.source_path;
    // Snapshot from THIS render rather than reading the store when the timer
    // fires. Switching images cancels the pending timer, and by then the store
    // already holds the next image — writing that under this path is how the
    // last edits before a switch used to be lost or mis-attributed.
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

    let saved = false;
    const handle = setTimeout(() => {
      saved = true;
      saveSettings(sourcePath, snapshot);
    }, 400);
    return () => {
      clearTimeout(handle);
      // Flush on the way out so a switch/unmount keeps the pending edit.
      if (!saved) saveSettings(sourcePath, snapshot);
    };
  }, [metadata, activeImageId, channels, currentZ, currentT, showMIP]);
}
