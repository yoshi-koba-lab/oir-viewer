import { useState, useCallback, useEffect } from 'react';
import {
  useImageLoader, uploadAndReload, openAndReload, showDefaultViewForActiveImage,
} from './hooks/useImageLoader';
import { useImageStore } from './stores/imageStore';
import { threeDSaveIsBusy, useOperationStore } from './stores/operationStore';
import { useViewStore } from './stores/viewStore';
import { Viewport } from './components/Viewport';
import { ChannelPanel } from './components/ChannelPanel';
import { ScalebarSettings } from './components/ScalebarSettings';
import { UpdateNotice } from './components/UpdateNotice';
import { DimensionSliders, ZSliderVertical } from './components/DimensionSliders';
import { Toolbar } from './components/Toolbar';
import { FileTabBar } from './components/FileTabBar';
import { IntensityProfile } from './components/IntensityProfile';
import { MeasurementPanel } from './components/MeasurementPanel';
import { MetadataPanel } from './components/MetadataPanel';
import { SplitView } from './components/SplitView';
import { Volume3DViewer } from './components/Volume3DViewer';
import { CompareView } from './components/CompareView';
import { chooseFiles } from './utils/api';
import { VERSION } from './constants/version';
import './index.css';

function App() {
  useImageLoader();
  const loading = useImageStore((s) => s.loading);
  const metadata = useImageStore((s) => s.metadata);
  const activeImageId = useImageStore((s) => s.activeImageId);
  const viewMode = useViewStore((s) => s.viewMode);
  const threeDSave = useOperationStore((s) => s.threeDSave);
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (threeDSaveIsBusy()) return;
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (threeDSaveIsBusy()) return;

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    // uploadAndReload records the reason in the store, which LoadErrorToast
    // renders and keeps on screen. Catching here only stops the rejection from
    // going unhandled — a second local toast would just overlap the first.
    let lastOpenedId: string | null = null;
    for (const file of files) {
      try {
        const id = await uploadAndReload(file, { showDefaultView: false });
        if (id) lastOpenedId = id;
      } catch {
        /* already reported */
      }
    }
    if (lastOpenedId) showDefaultViewForActiveImage(lastOpenedId);
  }, []);

  return (
    <div
      className="flex flex-col h-screen bg-[var(--bg-primary)] text-[var(--text-primary)]"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Top toolbar */}
      <Toolbar />

      {/* File tabs */}
      <FileTabBar />

      {/* Main area. With nothing loaded this REPLACES the viewport rather than
          floating over it: the old full-window overlay dimmed the toolbar too,
          which made the Open button it points at look disabled. */}
      {!metadata ? (
        <WelcomeScreen />
      ) : viewMode === 'compare' ? (
        <CompareView />
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* Vertical Z slider on the left edge (2D / Split) */}
          {(viewMode === '2d' || viewMode === 'split') && <ZSliderVertical />}

          {/* Viewport */}
          {viewMode === '3d'
            ? <Volume3DViewer key={activeImageId ?? 'none'} />
            : viewMode === 'split' ? <SplitView /> : <Viewport />}

          {/* Right panel */}
          <div className="flex flex-col w-64 shrink-0 overflow-y-auto border-l border-[var(--border)]">
            <ChannelPanel />
            <ScalebarSettings />
            <IntensityProfile />
            <MeasurementPanel />
            <MetadataPanel />
          </div>
        </div>
      )}

      {/* Bottom dimension sliders */}
      <DimensionSliders />

      {/* Loading indicator */}
      {loading && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 bg-[var(--accent)] text-white text-xs px-3 py-1 rounded-full animate-pulse">
          Loading...
        </div>
      )}

      {/* Drag & drop overlay */}
      {dragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 border-2 border-dashed border-[var(--accent)] pointer-events-none">
          <div className="text-center">
            <div className="text-4xl mb-3">+</div>
            <p className="text-lg font-semibold">Drop image file to open</p>
            <p className="text-sm text-[var(--text-secondary)] mt-1">.oir, .oif, .oib, .tif, .nd2, ...</p>
          </div>
        </div>
      )}

      {/* New release available on GitHub. Silent when current, when offline,
          and once dismissed for that version. */}
      <UpdateNotice />

      {/* Load/switch error toast — these used to fail silently, leaving the
          previous plane on screen with no hint that anything went wrong. */}
      <LoadErrorToast />

      {/* File-level warning (e.g. a split .oir opened without its chunk files).
          Persistent rather than a toast: the data on screen is incomplete, and
          that must stay visible for as long as the file is open. */}
      <FileWarningBanner />

      {/* This must live above the keyed 3D viewer. If navigation ever unmounts
          that viewer unexpectedly, the backend operation and its progress remain
          visible and the entire app stays interaction-locked until it settles. */}
      {threeDSave && (
        <div
          data-global-3d-save-overlay
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70"
          role="status"
          aria-live="polite"
          aria-label={`3D画像を保存中 ${threeDSave.percent}%`}
          tabIndex={-1}
          autoFocus
        >
          <div className="w-80 rounded-lg border border-white/20 bg-neutral-950/95 p-4 shadow-xl">
            <div className="mb-2 flex items-center justify-between text-sm text-white">
              <span>3D画像を保存中…</span>
              <span className="font-mono tabular-nums">{threeDSave.percent}%</span>
            </div>
            <progress
              value={threeDSave.percent}
              max={100}
              aria-label={`保存進捗 ${threeDSave.percent}%`}
              className="h-2 w-full accent-[var(--accent)]"
            />
            <div className="mt-2 text-[11px] text-white/60">{threeDSave.label}</div>
            <div className="mt-2 text-[10px] text-white/40">
              完了するまで画像や表示モードを変更できません
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

/**
 * Shown in place of the viewport when nothing is loaded. It carries its own
 * open button so the first action never depends on finding the toolbar.
 */
function WelcomeScreen() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const open = async () => {
    if (threeDSaveIsBusy()) return;
    setError('');
    setBusy(true);
    try {
      const picked = await chooseFiles();
      if (threeDSaveIsBusy()) return;
      if (picked.cancelled || picked.paths.length === 0) return;
      let lastOpenedId: string | null = null;
      const failures: string[] = [];
      for (const p of picked.paths) {
        try {
          const id = await openAndReload(p, { showDefaultView: false });
          if (id) lastOpenedId = id;
        } catch (e) {
          failures.push(`${p}: ${e instanceof Error ? e.message : e}`);
        }
      }
      if (lastOpenedId) showDefaultViewForActiveImage(lastOpenedId);
      if (failures.length) setError(failures.join('\n'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center bg-[var(--bg-primary)]">
      <div className="text-center max-w-md px-6">
        <h1 className="text-2xl font-bold mb-1">OIR Viewer</h1>
        <p className="text-xs font-mono text-[var(--text-secondary)] mb-6">v{VERSION}</p>
        <button
          onClick={open}
          disabled={busy}
          className="px-5 py-2.5 rounded-lg bg-[var(--accent)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 transition"
        >
          {busy ? '開いています…' : 'ファイルを開く'}
        </button>
        <p className="text-[var(--text-secondary)] text-sm mt-5 leading-relaxed">
          ここにファイルをドラッグ&amp;ドロップしても開けます。<br />
          <span className="text-xs">.oir / .oib / .oif / .tif / .nd2 / .lif / .czi</span>
        </p>
        <p className="text-[10px] text-[var(--text-secondary)] mt-4 leading-relaxed">
          1 GB を超える分割された .oir は、続きのファイル（_00001 など）を一緒に読む必要があるため、
          ドラッグ&amp;ドロップではなく「ファイルを開く」から元の保存場所を指定してください。
        </p>
        {error && <p className="text-xs text-red-400 mt-4 whitespace-pre-wrap">{error}</p>}
      </div>
    </div>
  );
}

/** Persistent banner for a file that opened but is incomplete or suspect. */
function FileWarningBanner() {
  const warning = useImageStore((s) => s.metadata?.warning);
  const [dismissed, setDismissed] = useState(false);

  // A different file (or a re-open) should surface its own warning again.
  useEffect(() => setDismissed(false), [warning]);

  if (!warning || dismissed) return null;
  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-start gap-3 max-w-[720px] bg-amber-500 text-black text-xs px-4 py-2.5 rounded-lg shadow-xl">
      <span className="shrink-0">⚠</span>
      <span className="leading-relaxed">{warning}</span>
      <button
        onClick={() => setDismissed(true)}
        className="shrink-0 opacity-60 hover:opacity-100 transition"
        aria-label="Dismiss warning"
      >
        ×
      </button>
    </div>
  );
}

/**
 * Dismissible banner for image load / tab switch failures.
 *
 * It does not time out. These messages name the reason a file would not open,
 * which is the one thing the user needs to read carefully and often to pass on;
 * a toast that clears itself after a few seconds left them describing the
 * failure as "nothing happens". It clears on dismissal, or when the next open
 * starts.
 */
function LoadErrorToast() {
  const loadError = useImageStore((s) => s.loadError);
  const setLoadError = useImageStore((s) => s.setLoadError);

  if (!loadError) return null;
  return (
    <div className="absolute top-12 left-1/2 -translate-x-1/2 z-50 flex items-start gap-3 max-w-[640px] max-h-[50vh] overflow-y-auto bg-red-600 text-white text-xs px-4 py-2 rounded-lg shadow-lg">
      <span className="leading-snug whitespace-pre-wrap break-words select-text">{loadError}</span>
      <button
        onClick={() => setLoadError(null)}
        className="shrink-0 opacity-70 hover:opacity-100 transition"
        aria-label="Dismiss error"
      >
        ×
      </button>
    </div>
  );
}

export default App;
