import { useRef, useEffect, useCallback, useState } from 'react';
import { useImageStore, type ChannelState } from '../stores/imageStore';
import { useViewStore } from '../stores/viewStore';
import { fetchAllChannelsBin, fetchMetadata, type ImageMetadata } from '../utils/api';

/** Per-image data loaded independently for comparison. */
interface CompareImageData {
  id: string;
  metadata: ImageMetadata;
  channels: ChannelState[];
  /** Which plane these pixels came from (see loadKeyFor). */
  loadKey: string;
}

/** Per-panel view state (zoom + pan). */
interface PanelView {
  zoom: number;
  panX: number;
  panY: number;
}

/** Which plane a panel shows: one Z index, or the whole stack projected. */
interface PanelZState {
  z: number;
  mip: boolean;
}

/** A failed load, tagged with the plane that failed so Retry can re-attempt it. */
interface LoadError {
  key: string;
  message: string;
}

const DEFAULT_VIEW: PanelView = { zoom: 1, panX: 0, panY: 0 };
const DEFAULT_Z: PanelZState = { z: 0, mip: false };
const Z_LOAD_DEBOUNCE_MS = 100;

/** "MIP" / "Z3/5" for a load key; null when the image has only one plane. */
function planeLabel(loadKey: string, numZ: number): string | null {
  if (loadKey === 'mip') return 'MIP';
  if (numZ <= 1) return null;
  return `Z${Number(loadKey.slice(1)) + 1}/${numZ}`;
}

/** Drop keys that are no longer compared, returning `prev` when nothing changed. */
function pruneByIds<T>(prev: Record<string, T>, keep: Set<string>): Record<string, T> {
  const stale = Object.keys(prev).filter((k) => !keep.has(k));
  if (stale.length === 0) return prev;
  const next = { ...prev };
  for (const k of stale) delete next[k];
  return next;
}

export function CompareView() {
  const imageList = useImageStore((s) => s.imageList);
  const activeChannels = useImageStore((s) => s.channels);
  const { compareImageIds, setCompareImageIds } = useViewStore();

  const [imageDataMap, setImageDataMap] = useState<Record<string, CompareImageData>>({});
  const [showPicker, setShowPicker] = useState(false);
  // Panels whose pixels are currently in flight, and panels whose load failed.
  const [pendingIds, setPendingIds] = useState<Record<string, true>>({});
  const [loadErrors, setLoadErrors] = useState<Record<string, LoadError>>({});
  // Compared plane, kept per image id so Individual mode can move one panel alone.
  const [zStates, setZStates] = useState<Record<string, PanelZState>>({});

  // Sync mode: true = changes affect all images, false = individual
  const [syncMode, setSyncMode] = useState(true);
  // When syncMode=false, which panel is selected for individual editing
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);

  // Per-panel view states (always used — never reset on mode switch)
  const [panelViews, setPanelViews] = useState<Record<string, PanelView>>({});
  // View lock: when true, pan/zoom is locked (won't respond to drag/scroll)
  const [viewLocked, setViewLocked] = useState(false);
  // Scale bar overlay; its length is a shared setting (null = auto).
  const [showScalebar, setShowScalebar] = useState(true);
  const scalebarUm = useViewStore((s) => s.scalebarUm);
  const setScalebarUm = useViewStore((s) => s.setScalebarUm);

  // Auto-select images once, on first entry into Compare. Firing on every empty
  // selection would make clearing the list in Edit mode instantly undo itself.
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (autoSelectedRef.current || imageList.length === 0) return;
    autoSelectedRef.current = true;
    if (compareImageIds.length === 0) {
      setCompareImageIds(imageList.slice(0, Math.min(4, imageList.length)).map(i => i.id));
    }
  }, [imageList, compareImageIds.length, setCompareImageIds]);

  // closeImageById() knows nothing about compareImageIds, so a closed file would
  // otherwise leave a panel stuck on "Loading..." forever (and pin its buffers).
  useEffect(() => {
    const live = new Set(imageList.map(i => i.id));
    if (compareImageIds.every(id => live.has(id))) return;
    setCompareImageIds(compareImageIds.filter(id => live.has(id)));
  }, [imageList, compareImageIds, setCompareImageIds]);

  // Auto-select first panel when switching to individual mode
  useEffect(() => {
    if (!syncMode && !selectedPanelId && compareImageIds.length > 0) {
      setSelectedPanelId(compareImageIds[0]);
    }
  }, [syncMode, selectedPanelId, compareImageIds]);

  // Planes already fetched (or in flight) per id. A ref, not derived state, so an
  // unrelated imageDataMap update (e.g. a channel toggle) can't restart a load.
  const requestedKeysRef = useRef<Record<string, string>>({});

  // Keep per-image state in step with the compared set: initialise state for new
  // panels, and drop everything belonging to panels that are gone — their decoded
  // Uint16Array planes are megabytes each, so keeping them would leak.
  useEffect(() => {
    const compared = new Set(compareImageIds);
    setPanelViews(prev => {
      const pruned = pruneByIds(prev, compared);
      const missing = compareImageIds.filter(id => !pruned[id]);
      if (missing.length === 0) return pruned;
      const next = { ...pruned };
      for (const id of missing) next[id] = { ...DEFAULT_VIEW };
      return next;
    });
    setZStates(prev => {
      const pruned = pruneByIds(prev, compared);
      const missing = compareImageIds.filter(id => !pruned[id]);
      if (missing.length === 0) return pruned;
      // A panel added while Sync is on should join at the plane everyone else shows.
      const seed = syncMode ? pruned[compareImageIds[0]] ?? DEFAULT_Z : DEFAULT_Z;
      const next = { ...pruned };
      for (const id of missing) next[id] = { ...seed };
      return next;
    });
    setImageDataMap(prev => pruneByIds(prev, compared));
    setLoadErrors(prev => pruneByIds(prev, compared));
    setPendingIds(prev => pruneByIds(prev, compared));
    requestedKeysRef.current = pruneByIds(requestedKeysRef.current, compared);
    if (selectedPanelId && !compared.has(selectedPanelId)) setSelectedPanelId(null);
  }, [compareImageIds, syncMode, selectedPanelId]);

  // Get view for a panel (always from panelViews)
  const getViewForPanel = useCallback((id: string): PanelView => {
    return panelViews[id] ?? DEFAULT_VIEW;
  }, [panelViews]);

  // Zoom: in sync mode, apply same zoom ratio to all panels
  const handlePanelZoom = useCallback((id: string, newZoom: number) => {
    if (viewLocked) return;
    const clamped = Math.max(0.1, Math.min(50, newZoom));
    if (syncMode) {
      const currentZoom = panelViews[id]?.zoom ?? 1;
      const ratio = currentZoom > 0 ? clamped / currentZoom : 1;
      setPanelViews(prev => {
        const next = { ...prev };
        for (const pid of compareImageIds) {
          const pv = next[pid] ?? { ...DEFAULT_VIEW };
          next[pid] = { ...pv, zoom: Math.max(0.1, Math.min(50, pv.zoom * ratio)) };
        }
        return next;
      });
    } else {
      setPanelViews(prev => ({
        ...prev,
        [id]: { ...(prev[id] ?? DEFAULT_VIEW), zoom: clamped },
      }));
    }
  }, [syncMode, viewLocked, panelViews, compareImageIds]);

  // Pan: in sync mode, apply same delta to all panels
  const handlePanelPan = useCallback((id: string, newX: number, newY: number) => {
    if (viewLocked) return;
    if (syncMode) {
      const cur = panelViews[id] ?? DEFAULT_VIEW;
      const dx = newX - cur.panX;
      const dy = newY - cur.panY;
      setPanelViews(prev => {
        const next = { ...prev };
        for (const pid of compareImageIds) {
          const pv = next[pid] ?? { ...DEFAULT_VIEW };
          next[pid] = { ...pv, panX: pv.panX + dx, panY: pv.panY + dy };
        }
        return next;
      });
    } else {
      setPanelViews(prev => ({
        ...prev,
        [id]: { ...(prev[id] ?? DEFAULT_VIEW), panX: newX, panY: newY },
      }));
    }
  }, [syncMode, viewLocked, panelViews, compareImageIds]);

  // Depth of an image, from the image list (known before its metadata loads).
  const numZFor = useCallback((id: string): number => {
    return Math.max(1, imageList.find(i => i.id === id)?.num_z ?? 1);
  }, [imageList]);

  const zStateFor = useCallback((id: string): PanelZState => {
    return zStates[id] ?? DEFAULT_Z;
  }, [zStates]);

  // The seven files have different depths (5..7), so every request is clamped to
  // the image's own stack — a shallow image simply shows its last plane.
  const effectiveZFor = useCallback((id: string): number => {
    return Math.max(0, Math.min(numZFor(id) - 1, zStateFor(id).z));
  }, [numZFor, zStateFor]);

  const loadKeyFor = useCallback((id: string): string => {
    return zStateFor(id).mip ? 'mip' : `z${effectiveZFor(id)}`;
  }, [zStateFor, effectiveZFor]);

  // Move the compared plane: Sync writes every panel, Individual only the selected
  // one. The requested z is stored unclamped so deeper stacks stay reachable.
  const applyZ = useCallback((patch: Partial<PanelZState>) => {
    const targets = syncMode ? compareImageIds : selectedPanelId ? [selectedPanelId] : [];
    if (targets.length === 0) return;
    setZStates(prev => {
      const next = { ...prev };
      for (const id of targets) next[id] = { ...(prev[id] ?? DEFAULT_Z), ...patch };
      return next;
    });
  }, [syncMode, selectedPanelId, compareImageIds]);

  // Clearing an id's error re-arms the loader effect for it — which is exactly what
  // the panel's Retry button needs to do.
  const clearLoadError = useCallback((id: string) => {
    setLoadErrors(prev => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  // Load channel data for panels whose requested plane isn't loaded yet.
  useEffect(() => {
    const idsToLoad = compareImageIds.filter(id => {
      const key = loadKeyFor(id);
      // A failed plane stays failed until the user hits Retry, so the effect can't
      // spin on a server that keeps rejecting the request.
      if (loadErrors[id]?.key === key) return false;
      return requestedKeysRef.current[id] !== key;
    });
    if (idsToLoad.length === 0) return;

    let cancelled = false;
    const done = new Set<string>();
    const keys: Record<string, string> = {};
    for (const id of idsToLoad) keys[id] = loadKeyFor(id);

    // Short delay before hitting the network: a plane is ~2 MB per channel, so
    // dragging the Z slider must not fire a fetch per intermediate plane.
    const timer = setTimeout(() => {
      for (const id of idsToLoad) requestedKeysRef.current[id] = keys[id];
      setPendingIds(prev => {
        const next = { ...prev };
        for (const id of idsToLoad) next[id] = true;
        return next;
      });
      void loadPass();
    }, Z_LOAD_DEBOUNCE_MS);

    async function loadPass() {
      for (const id of idsToLoad) {
        // A superseded pass must not keep fetching planes nobody is waiting for.
        if (cancelled) return;
        const key = keys[id];
        const zState = zStateFor(id);
        try {
          const meta = await fetchMetadata(id);
          const resp = await fetchAllChannelsBin({
            z: Math.max(0, Math.min(meta.num_z - 1, zState.z)),
            t: 0,
            mip: zState.mip,
            id,
          });
          if (cancelled) return;
          setImageDataMap(prev => {
            const prevImg = prev[id];
            const channels: ChannelState[] = [];
            for (let c = 0; c < meta.num_channels; c++) {
              const chData = resp.channels.find(ch => ch.channel === c);
              // Carry the panel's own channel setup across a Z change; only pixels
              // and auto levels come from the new plane.
              const ref = prevImg?.channels[c] ?? activeChannels[c];
              channels.push({
                visible: ref?.visible ?? true,
                color: ref?.color ?? [255, 255, 255],
                min: chData?.auto_min ?? 0,
                max: chData?.auto_max ?? 65535,
                autoMin: chData?.auto_min ?? 0,
                autoMax: chData?.auto_max ?? 65535,
                data: chData ? chData.data : null,
                hasLevels: !!chData,
              });
            }
            return { ...prev, [id]: { id, metadata: meta, channels, loadKey: key } };
          });
          clearLoadError(id);
        } catch (err) {
          if (cancelled) return;
          // Drop the requested key so Retry can re-issue this exact fetch.
          delete requestedKeysRef.current[id];
          setLoadErrors(prev => ({
            ...prev,
            [id]: { key, message: err instanceof Error ? err.message : 'Load failed' },
          }));
        } finally {
          if (!cancelled) {
            done.add(id);
            setPendingIds(prev => {
              const next = { ...prev };
              delete next[id];
              return next;
            });
          }
        }
      }
    }

    return () => {
      cancelled = true;
      clearTimeout(timer);
      const unfinished = idsToLoad.filter(id => !done.has(id));
      if (unfinished.length === 0) return;
      // Roll back planes this pass abandoned, so the next pass re-requests them.
      for (const id of unfinished) delete requestedKeysRef.current[id];
      setPendingIds(prev => {
        const stillPending = unfinished.filter(id => prev[id]);
        if (stillPending.length === 0) return prev;
        const next = { ...prev };
        for (const id of stillPending) delete next[id];
        return next;
      });
    };
  }, [compareImageIds, zStates, loadErrors]); // eslint-disable-line react-hooks/exhaustive-deps

  // Toggle channel visibility (respects sync/individual mode)
  const toggleChannel = useCallback((channelIdx: number) => {
    setImageDataMap(prev => {
      const next = { ...prev };
      if (syncMode) {
        // Get current state from first image
        const firstKey = compareImageIds.find(id => next[id]);
        if (!firstKey) return prev;
        const currentVisible = next[firstKey].channels[channelIdx]?.visible ?? true;
        const newVisible = !currentVisible;
        for (const key of Object.keys(next)) {
          const img = next[key];
          if (channelIdx < img.channels.length) {
            const newCh = [...img.channels];
            newCh[channelIdx] = { ...newCh[channelIdx], visible: newVisible };
            next[key] = { ...img, channels: newCh };
          }
        }
      } else {
        // Individual mode: only affect selected panel
        const targetId = selectedPanelId;
        if (!targetId || !next[targetId]) return prev;
        const img = next[targetId];
        if (channelIdx < img.channels.length) {
          const newCh = [...img.channels];
          newCh[channelIdx] = { ...newCh[channelIdx], visible: !newCh[channelIdx].visible };
          next[targetId] = { ...img, channels: newCh };
        }
      }
      return next;
    });
  }, [syncMode, selectedPanelId, compareImageIds]);

  // All channels on/off (respects sync/individual mode)
  const setAllVisible = useCallback((visible: boolean) => {
    setImageDataMap(prev => {
      const next = { ...prev };
      if (syncMode) {
        for (const key of Object.keys(next)) {
          const img = next[key];
          const newCh = img.channels.map(ch => ({ ...ch, visible }));
          next[key] = { ...img, channels: newCh };
        }
      } else {
        const targetId = selectedPanelId;
        if (!targetId || !next[targetId]) return prev;
        const img = next[targetId];
        const newCh = img.channels.map(ch => ({ ...ch, visible }));
        next[targetId] = { ...img, channels: newCh };
      }
      return next;
    });
  }, [syncMode, selectedPanelId]);

  // Drag & drop reorder state
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  // stopPropagation: these events otherwise reach App's root drag handlers,
  // flashing the "Drop image file to open" overlay mid-reorder. Only swallow our
  // own reorder drag (dragIdx set) — a file dragged in from outside must still
  // reach App, which is what opens it.
  const handleDragStart = useCallback((e: React.DragEvent, idx: number) => {
    e.stopPropagation();
    setDragIdx(idx);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    if (dragIdx === null) return;
    e.preventDefault();
    e.stopPropagation();
    setDropIdx(idx);
  }, [dragIdx]);

  const handleDrop = useCallback((e: React.DragEvent, targetIdx: number) => {
    if (dragIdx === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (dragIdx === targetIdx) {
      setDragIdx(null);
      setDropIdx(null);
      return;
    }
    const newIds = [...compareImageIds];
    const [moved] = newIds.splice(dragIdx, 1);
    newIds.splice(targetIdx, 0, moved);
    setCompareImageIds(newIds);
    setDragIdx(null);
    setDropIdx(null);
  }, [dragIdx, compareImageIds, setCompareImageIds]);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    e.stopPropagation();
    setDragIdx(null);
    setDropIdx(null);
  }, []);

  // Reset a single panel's view to default
  const resetPanelView = useCallback((id: string) => {
    setPanelViews(prev => ({ ...prev, [id]: { ...DEFAULT_VIEW } }));
  }, []);

  // Compute grid layout: keep small counts in a single row for easier comparison
  const n = compareImageIds.length;
  const cols = n <= 1 ? 1 : n <= 3 ? n : n === 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);

  // Channel info: from selected panel (individual) or first image (sync)
  const referenceId = syncMode
    ? compareImageIds[0]
    : selectedPanelId;
  const refImg = referenceId ? imageDataMap[referenceId] : null;
  const channelNames = refImg ? refImg.metadata.channel_names : [];
  const channelStates = refImg ? refImg.channels : [];

  // Z control scope: the panels applyZ will write (all in sync, one in individual).
  const zScopeIds = syncMode ? compareImageIds : referenceId ? [referenceId] : compareImageIds;
  const maxNumZ = zScopeIds.reduce((m, id) => Math.max(m, numZFor(id)), 1);
  const zRef = referenceId ? zStateFor(referenceId) : DEFAULT_Z;
  const zValue = Math.min(zRef.z, maxNumZ - 1);
  const depthsDiffer = zScopeIds.some(id => numZFor(id) !== maxNumZ);
  const zStepBtn =
    'text-[10px] w-5 h-5 flex items-center justify-center rounded bg-[var(--border)] text-[var(--text-secondary)] hover:text-white disabled:opacity-30 transition shrink-0';

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Compare grid */}
      <div
        className="flex-1 grid gap-1 bg-black p-1"
        style={{
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows: `repeat(${rows}, 1fr)`,
        }}
      >
        {compareImageIds.map(id => {
          const imgData = imageDataMap[id];
          const err = loadErrors[id];
          const filename = imageList.find(i => i.id === id)?.filename ?? id;
          // Label the plane whose pixels are on screen, not the requested one —
          // during a Z refetch the canvas still shows the previous plane.
          const zLabel = imgData ? planeLabel(imgData.loadKey, numZFor(id)) : null;
          if (!imgData) {
            return (
              <div key={id} className="bg-gray-900 rounded flex items-center justify-center p-3 text-center">
                {err ? (
                  <div className="max-w-full">
                    <p className="text-[11px] font-medium text-red-400">Failed to load</p>
                    <p className="text-[10px] text-white/60 truncate mt-0.5" title={filename}>
                      {filename}
                    </p>
                    <p className="text-[9px] text-white/40 mt-0.5 break-words" title={err.message}>
                      {err.message}
                    </p>
                    <button
                      onClick={() => clearLoadError(id)}
                      className="mt-2 text-[10px] px-2 py-0.5 rounded bg-[var(--accent)] text-white hover:opacity-90 transition"
                    >
                      Retry
                    </button>
                  </div>
                ) : (
                  <span className="text-white/40 text-xs">Loading...</span>
                )}
              </div>
            );
          }
          const pv = getViewForPanel(id);
          return (
            <ComparePanel
              key={id}
              imageData={imgData}
              zoom={pv.zoom}
              panX={pv.panX}
              panY={pv.panY}
              onZoom={(z) => handlePanelZoom(id, z)}
              onPan={(x, y) => handlePanelPan(id, x, y)}
              onResetView={() => resetPanelView(id)}
              selected={!syncMode && selectedPanelId === id}
              onSelect={() => { if (!syncMode) setSelectedPanelId(id); }}
              showScalebar={showScalebar}
              scalebarUm={scalebarUm}
              zLabel={zLabel}
              busy={!!pendingIds[id]}
              error={err?.message}
              onRetry={() => clearLoadError(id)}
            />
          );
        })}
      </div>

      {/* Right sidebar */}
      <div className="w-56 shrink-0 border-l border-[var(--border)] bg-[var(--bg-panel)] overflow-y-auto flex flex-col">

        {/* Sync / Individual toggle */}
        <div className="p-3 border-b border-[var(--border)]">
          <div className="flex rounded overflow-hidden border border-[var(--border)]">
            <button
              onClick={() => setSyncMode(true)}
              className={`flex-1 text-[10px] py-1.5 font-medium transition ${
                syncMode
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:text-white'
              }`}
            >
              All Sync
            </button>
            <button
              onClick={() => setSyncMode(false)}
              className={`flex-1 text-[10px] py-1.5 font-medium transition ${
                !syncMode
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:text-white'
              }`}
            >
              Individual
            </button>
          </div>

          {/* View Lock + Scale bar toggles */}
          <div className="flex gap-1.5 mt-2">
            <button
              onClick={() => setViewLocked(v => !v)}
              className={`flex-1 flex items-center justify-center gap-1 text-[10px] py-1.5 rounded border transition ${
                viewLocked
                  ? 'bg-amber-600/20 border-amber-500 text-amber-400'
                  : 'bg-[var(--bg-primary)] border-[var(--border)] text-[var(--text-secondary)] hover:text-white'
              }`}
              title="Lock pan & zoom"
            >
              <span>{viewLocked ? '🔒' : '🔓'}</span>
              <span>{viewLocked ? 'Locked' : 'Unlocked'}</span>
            </button>
            <button
              onClick={() => setShowScalebar(v => !v)}
              className={`flex-1 flex items-center justify-center gap-1 text-[10px] py-1.5 rounded border transition ${
                showScalebar
                  ? 'bg-[var(--accent)]/20 border-[var(--accent)] text-[var(--accent)]'
                  : 'bg-[var(--bg-primary)] border-[var(--border)] text-[var(--text-secondary)] hover:text-white'
              }`}
              title="Toggle scale bar"
            >
              <span>📏</span>
              <span>Scale</span>
            </button>
          </div>

          {showScalebar && (
            <div className="flex items-center gap-1.5 mt-1.5">
              <span className="text-[10px] text-[var(--text-secondary)]">長さ</span>
              <input
                type="number"
                min={0}
                step={10}
                value={scalebarUm ?? ''}
                placeholder="自動"
                onChange={(e) => {
                  const v = e.target.value.trim();
                  setScalebarUm(v === '' ? null : Number(v));
                }}
                className="w-16 bg-[var(--bg-primary)] border border-[var(--border)] rounded px-1 py-0.5 text-[10px] text-right tabular-nums focus:outline-none focus:border-[var(--accent)]"
                title="空欄で自動。数値を入れるとその長さ（µm）で固定します"
              />
              <span className="text-[10px] text-[var(--text-secondary)]">µm</span>
              {scalebarUm !== null && (
                <button
                  onClick={() => setScalebarUm(null)}
                  className="ml-auto text-[9px] underline text-[var(--text-secondary)] hover:text-white"
                >
                  自動
                </button>
              )}
            </div>
          )}

          {!syncMode && (
            <p className="text-[9px] text-[var(--text-secondary)] mt-1.5 leading-tight">
              Click a panel to select, then change channels or Z for that image only.
            </p>
          )}
          <p className="text-[9px] text-[var(--text-secondary)] mt-1.5 leading-tight">
            Scroll to zoom at cursor · Drag to pan · Double-click to reset.
          </p>
        </div>

        {/* Compared Z plane (or whole-stack MIP) */}
        {maxNumZ > 1 && (
          <div className="p-3 border-b border-[var(--border)]">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h3 className="text-xs font-bold text-[var(--text-primary)] truncate">
                Z Plane
                {!syncMode && refImg && (
                  <span className="font-normal text-[var(--text-secondary)]">
                    {' '}({refImg.metadata.filename.slice(0, 12)}...)
                  </span>
                )}
              </h3>
              <div className="flex items-center gap-1.5 shrink-0">
                {/* Reading sits here, not on the control row: four items in a
                    224px sidebar overflowed and clipped the panel's labels. */}
                <span className="text-[10px] font-mono text-[var(--text-secondary)]">
                  {zRef.mip ? 'MIP' : `${zValue + 1}/${maxNumZ}`}
                </span>
                <button
                  onClick={() => applyZ({ mip: !zRef.mip })}
                  className={`text-[10px] px-1.5 py-0.5 rounded transition ${
                    zRef.mip
                      ? 'bg-[var(--accent)] text-white'
                      : 'bg-[var(--border)] text-[var(--text-secondary)] hover:text-white'
                  }`}
                  title="Maximum intensity projection over the whole stack"
                >
                  MIP
                </button>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => applyZ({ z: Math.max(0, zValue - 1) })}
                disabled={zRef.mip || zValue === 0}
                className={zStepBtn}
                title="Previous Z"
              >
                &#9664;
              </button>
              <input
                type="range"
                min={0}
                max={maxNumZ - 1}
                value={zValue}
                onChange={(e) => applyZ({ z: Number(e.target.value) })}
                disabled={zRef.mip}
                className="flex-1 accent-[var(--accent)] disabled:opacity-40"
              />
              <button
                onClick={() => applyZ({ z: Math.min(maxNumZ - 1, zValue + 1) })}
                disabled={zRef.mip || zValue === maxNumZ - 1}
                className={zStepBtn}
                title="Next Z"
              >
                &#9654;
              </button>
            </div>
            {!zRef.mip && depthsDiffer && (
              <p className="text-[9px] text-[var(--text-secondary)] mt-1.5 leading-tight">
                Stacks differ in depth — shallower images show their last plane.
              </p>
            )}
          </div>
        )}

        {/* Channel toggles */}
        <div className="p-3 border-b border-[var(--border)]">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-bold text-[var(--text-primary)]">
              Channels
              {!syncMode && refImg && (
                <span className="font-normal text-[var(--text-secondary)]">
                  {' '}({refImg.metadata.filename.slice(0, 12)}...)
                </span>
              )}
            </h3>
            <div className="flex gap-1">
              <button
                onClick={() => setAllVisible(true)}
                className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent)] text-white hover:opacity-90"
              >
                ON
              </button>
              <button
                onClick={() => setAllVisible(false)}
                className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--border)] text-[var(--text-secondary)] hover:text-white"
              >
                OFF
              </button>
            </div>
          </div>
          {channelStates.map((ch, i) => (
            <div
              key={i}
              className="flex items-center gap-2 py-1 cursor-pointer select-none"
              onClick={() => toggleChannel(i)}
            >
              <div
                className="w-4 h-4 rounded border-2 flex items-center justify-center shrink-0"
                style={{
                  borderColor: `rgb(${ch.color.join(',')})`,
                  backgroundColor: ch.visible ? `rgb(${ch.color.join(',')})` : 'transparent',
                }}
              >
                {ch.visible && (
                  <svg className="w-2.5 h-2.5 text-black" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M2 6l3 3 5-5" />
                  </svg>
                )}
              </div>
              <span className="text-xs">{channelNames[i] || `Ch${i}`}</span>
            </div>
          ))}
        </div>

        {/* Image list with reorder + select */}
        <div className="p-3 border-b border-[var(--border)]">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-bold text-[var(--text-primary)]">Images</h3>
            <button
              onClick={() => setShowPicker(!showPicker)}
              className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--border)] text-[var(--text-secondary)] hover:text-white"
            >
              {showPicker ? 'Done' : 'Edit'}
            </button>
          </div>

          {showPicker ? (
            <div className="flex flex-col gap-1">
              {imageList.map(img => {
                const selected = compareImageIds.includes(img.id);
                return (
                  <label key={img.id} className="flex items-center gap-2 py-1 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => {
                        if (selected) {
                          setCompareImageIds(compareImageIds.filter(id => id !== img.id));
                        } else {
                          setCompareImageIds([...compareImageIds, img.id]);
                        }
                      }}
                      className="accent-[var(--accent)]"
                    />
                    <span className="text-[10px] truncate" title={img.filename}>
                      {img.filename}
                    </span>
                  </label>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {compareImageIds.map((id, idx) => {
                const img = imageList.find(i => i.id === id);
                const isSelected = !syncMode && selectedPanelId === id;
                const isDragging = dragIdx === idx;
                const isDropTarget = dropIdx === idx && dragIdx !== idx;
                return (
                  <div
                    key={id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, idx)}
                    onDragOver={(e) => handleDragOver(e, idx)}
                    onDrop={(e) => handleDrop(e, idx)}
                    onDragEnd={handleDragEnd}
                    className={`flex items-center gap-1.5 rounded px-1.5 py-1.5 transition cursor-grab active:cursor-grabbing select-none ${
                      isDragging
                        ? 'opacity-30'
                        : isDropTarget
                          ? 'border-t-2 border-t-[var(--accent)] border border-transparent'
                          : isSelected
                            ? 'bg-[var(--accent)]/20 border border-[var(--accent)]'
                            : 'hover:bg-white/5 border border-transparent'
                    }`}
                    onClick={() => { if (!syncMode) setSelectedPanelId(id); }}
                  >
                    {/* Drag handle */}
                    <span className="text-[10px] text-[var(--text-secondary)] shrink-0 leading-none" title="Drag to reorder">⠿</span>
                    {/* Index badge */}
                    <span className="text-[9px] font-mono text-[var(--text-secondary)] w-3 text-center shrink-0">
                      {idx + 1}
                    </span>
                    {/* Filename */}
                    <span className="text-[10px] truncate flex-1" title={img?.filename}>
                      {img?.filename || id}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Zoom reset */}
        <div className="p-3 border-t border-[var(--border)] mt-auto">
          <button
            onClick={() => {
              setPanelViews(prev => {
                const next = { ...prev };
                for (const id of compareImageIds) {
                  next[id] = { ...DEFAULT_VIEW };
                }
                return next;
              });
            }}
            className="w-full px-2 py-1 rounded bg-[var(--accent)] text-white text-xs hover:opacity-90 transition"
          >
            Reset Zoom
          </button>
        </div>
      </div>
    </div>
  );
}

/** Pick a "nice" scale-bar length (1/2/5 × 10ⁿ) close to a target pixel width. */
function niceScaleLength(targetUm: number): number {
  if (!(targetUm > 0)) return 0;
  const pow = Math.pow(10, Math.floor(Math.log10(targetUm)));
  const frac = targetUm / pow;
  const nice = frac >= 5 ? 5 : frac >= 2 ? 2 : 1;
  return nice * pow;
}

/** Format a micron length for the scale-bar label. */
function formatUm(um: number): string {
  if (um >= 1000) return `${(um / 1000).toFixed(um % 1000 === 0 ? 0 : 1)} mm`;
  if (um >= 1) return `${um % 1 === 0 ? um : um.toFixed(1)} µm`;
  return `${(um * 1000).toFixed(0)} nm`;
}

/** Single image panel in the compare grid. */
function ComparePanel({
  imageData,
  zoom,
  panX,
  panY,
  onZoom,
  onPan,
  onResetView,
  selected,
  onSelect,
  showScalebar,
  scalebarUm,
  zLabel,
  busy,
  error,
  onRetry,
}: {
  imageData: CompareImageData;
  zoom: number;
  panX: number;
  panY: number;
  onZoom: (z: number) => void;
  onPan: (x: number, y: number) => void;
  onResetView: () => void;
  selected: boolean;
  onSelect: () => void;
  showScalebar: boolean;
  scalebarUm: number | null;
  zLabel: string | null;
  busy: boolean;
  error?: string;
  onRetry: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compositeRef = useRef<OffscreenCanvas | null>(null);
  const isPanning = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  // Bumped to trigger a redraw when the composite or canvas size changes.
  const [drawTick, setDrawTick] = useState(0);

  const { metadata, channels } = imageData;

  // Composite pixels → offscreen canvas. Runs only when pixel data/levels change,
  // NOT on every pan/zoom — keeps interaction smooth for large images.
  useEffect(() => {
    const { width, height } = metadata;
    const offscreen = new OffscreenCanvas(width, height);
    const offCtx = offscreen.getContext('2d')!;
    const imageDataObj = offCtx.createImageData(width, height);
    const pixels = imageDataObj.data;

    for (const ch of channels) {
      if (!ch.visible || !ch.data) continue;
      const [r, g, b] = ch.color;
      const range = ch.max - ch.min;
      const invRange = range > 0 ? 1 / range : 0;

      for (let i = 0; i < width * height; i++) {
        const norm = Math.min(1, Math.max(0, (ch.data[i] - ch.min) * invRange));
        const idx = i * 4;
        pixels[idx] = Math.min(255, pixels[idx] + norm * r);
        pixels[idx + 1] = Math.min(255, pixels[idx + 1] + norm * g);
        pixels[idx + 2] = Math.min(255, pixels[idx + 2] + norm * b);
        pixels[idx + 3] = 255;
      }
    }

    offCtx.putImageData(imageDataObj, 0, 0);
    compositeRef.current = offscreen;
    setDrawTick(t => t + 1);
  }, [channels, metadata]);

  // Draw offscreen → visible canvas. Cheap; runs on pan/zoom/resize.
  useEffect(() => {
    const canvas = canvasRef.current;
    const offscreen = compositeRef.current;
    if (!canvas || !offscreen) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio;
    const cw = canvas.clientWidth;
    const chh = canvas.clientHeight;
    canvas.width = cw * dpr;
    canvas.height = chh * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = zoom < 4;
    ctx.clearRect(0, 0, cw, chh);

    const { width, height } = metadata;
    const drawW = width * zoom;
    const drawH = height * zoom;
    const dx = cw / 2 - drawW / 2 + panX;
    const dy = chh / 2 - drawH / 2 + panY;
    ctx.drawImage(offscreen, dx, dy, drawW, drawH);

    // Scale bar (bottom-left), sized from physical pixel size.
    if (showScalebar && metadata.pixel_size_x > 0) {
      const umPerScreenPx = metadata.pixel_size_x / zoom;
      // An explicit length from the shared setting wins over the auto-chosen one.
      const barUm = scalebarUm && scalebarUm > 0 ? scalebarUm : niceScaleLength(umPerScreenPx * 80);
      const barPx = barUm / umPerScreenPx;
      if (barPx > 8 && barPx < cw * 0.9) {
        const bx = 10;
        const by = chh - 14;
        ctx.save();
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + barPx, by);
        ctx.stroke();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + barPx, by);
        ctx.stroke();
        ctx.font = '11px ui-monospace, monospace';
        ctx.textBaseline = 'bottom';
        const label = formatUm(barUm);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.strokeText(label, bx, by - 3);
        ctx.fillStyle = 'white';
        ctx.fillText(label, bx, by - 3);
        ctx.restore();
      }
    }
  }, [zoom, panX, panY, metadata, showScalebar, scalebarUm, drawTick]);

  // Redraw on container resize.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas?.parentElement) return;
    const observer = new ResizeObserver(() => setDrawTick(t => t + 1));
    observer.observe(canvas.parentElement);
    return () => observer.disconnect();
  }, []);

  // Zoom toward the cursor so the point under the mouse stays fixed.
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left - rect.width / 2;
      const sy = e.clientY - rect.top - rect.height / 2;
      const newZoom = Math.max(0.1, Math.min(50, zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
      const k = newZoom / zoom;
      onZoom(newZoom);
      onPan(sx - (sx - panX) * k, sy - (sy - panY) * k);
    },
    [zoom, panX, panY, onZoom, onPan]
  );

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    onSelect();
    isPanning.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
  }, [onSelect]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isPanning.current) {
        onPan(panX + e.clientX - lastMouse.current.x, panY + e.clientY - lastMouse.current.y);
        lastMouse.current = { x: e.clientX, y: e.clientY };
      }
    },
    [panX, panY, onPan]
  );

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  return (
    <div
      className={`relative overflow-hidden bg-black rounded-lg transition-shadow ${
        selected ? 'ring-2 ring-[var(--accent)] shadow-lg shadow-[var(--accent)]/20' : ''
      }`}
      onClick={onSelect}
    >
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-crosshair"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={(e) => { e.stopPropagation(); onResetView(); }}
      />
      {/* Filename label */}
      <div className={`absolute top-1 left-1 text-[10px] font-mono px-1.5 py-0.5 rounded max-w-[90%] truncate ${
        selected ? 'bg-[var(--accent)]/80 text-white' : 'bg-black/60 text-white/80'
      }`}>
        {metadata.filename}
      </div>
      {/* Refetch state for the plane currently being shown */}
      {error ? (
        <div
          className="absolute top-1 right-1 flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded bg-red-600/80 text-white"
          title={error}
        >
          <span>Load failed</span>
          <button
            onClick={(e) => { e.stopPropagation(); onRetry(); }}
            className="underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      ) : busy ? (
        <div className="absolute top-1 right-1 text-[9px] px-1.5 py-0.5 rounded bg-black/60 text-white/70 animate-pulse">
          Loading...
        </div>
      ) : null}
      {/* Plane + zoom + dimensions */}
      <div className="absolute bottom-1 right-1 text-[9px] font-mono px-1 py-0.5 rounded bg-black/50 text-white/50">
        {zLabel ? `${zLabel} · ` : ''}{(zoom * 100).toFixed(0)}% · {metadata.width}&times;{metadata.height}
      </div>
    </div>
  );
}
