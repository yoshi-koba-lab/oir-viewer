import { useRef, useState } from 'react';
import { useViewStore, type ROITool, type ViewMode } from '../stores/viewStore';
import { useImageStore } from '../stores/imageStore';
import { openAndReload, basename } from '../hooks/useImageLoader';
import { chooseFiles } from '../utils/api';
import { SaveDialog } from './SaveDialog';
import { ProjectionDialog } from './ProjectionDialog';
import { VERSION } from '../constants/version';

const roiTools: { id: ROITool; label: string; icon: string }[] = [
  { id: 'none', label: 'Pan', icon: 'M' },
  { id: 'line', label: 'Line', icon: '/' },
  { id: 'rect', label: 'Rectangle', icon: '\u25a1' },
  { id: 'ellipse', label: 'Ellipse', icon: '\u25cb' },
];

const viewModes: { id: ViewMode; label: string }[] = [
  { id: '2d', label: '2D' },
  { id: '3d', label: '3D' },
  { id: 'split', label: 'Split' },
  { id: 'compare', label: 'Compare' },
];

export function Toolbar() {
  const { roiTool, setRoiTool, viewMode, setViewMode, rois, clearRois, activeRoiId, showMergeInSplit, setShowMergeInSplit } =
    useViewStore();
  const metadata = useImageStore((s) => s.metadata);
  const [showOpenDialog, setShowOpenDialog] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showProjection, setShowProjection] = useState(false);
  const [filePath, setFilePath] = useState('');
  const [openError, setOpenError] = useState('');
  const [opening, setOpening] = useState(false);
  const setLoadError = useImageStore((s) => s.setLoadError);
  const roiToolsUsable = viewMode === '2d';

  /**
   * Show a failure everywhere it could be looked for.
   *
   * `openError` renders inside the path-entry modal only, but the primary Open
   * button opens the OS picker with that modal closed — so its errors were set
   * into an element that was not mounted and the user saw the button flick back
   * to "Open" with no explanation. The store's toast is always on screen; the
   * modal copy stays for when the path box is the thing being used.
   */
  const report = (msg: string) => {
    setOpenError(msg);
    setLoadError(msg);
  };

  const handleOpen = async () => {
    const path = filePath.trim();
    if (!path) return;
    setOpenError('');
    setOpening(true);
    try {
      await openAndReload(path);
      setShowOpenDialog(false);
      setFilePath('');
    } catch (e: unknown) {
      report(e instanceof Error ? e.message : 'Failed to open file');
    } finally {
      setOpening(false);
    }
  };

  /** Native file picker — the primary way in; the path box is the fallback. */
  const handleBrowse = async () => {
    setOpenError('');
    setOpening(true);
    try {
      const picked = await chooseFiles();
      if (picked.cancelled) return;
      if (picked.paths.length === 0) {
        // Not a cancel, but nothing came back either. Silence here is how a
        // broken picker looks identical to a working one.
        report('ファイルが選択されませんでした（ファイル選択ダイアログから何も返りませんでした）');
        return;
      }
      const failures: string[] = [];
      for (const p of picked.paths) {
        try {
          await openAndReload(p);
        } catch (e) {
          failures.push(`${basename(p)}: ${e instanceof Error ? e.message : e}`);
        }
      }
      if (failures.length) {
        report(failures.join('\n'));
      } else {
        setShowOpenDialog(false);
        setFilePath('');
      }
    } catch (e: unknown) {
      report(e instanceof Error ? e.message : 'Failed to open the file picker');
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="bg-[var(--bg-secondary)] border-b border-[var(--border)] px-4 py-1.5 flex items-center gap-4">
      {/* App name + version */}
      <div className="flex items-baseline gap-1.5 shrink-0 select-none">
        <span className="text-sm font-semibold text-[var(--text-primary)]">OIR Viewer</span>
        <span
          className="text-[11px] font-mono font-normal text-[var(--text-secondary)]"
          title={`OIR Viewer v${VERSION}`}
        >
          v{VERSION}
        </span>
      </div>

      {/* Open goes straight to the OS file picker; the path box is a fallback
          reachable from inside the dialog. */}
      <button
        onClick={handleBrowse}
        disabled={opening}
        className="px-2 py-1 rounded text-xs bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 transition"
        title="ファイルを選択して開く"
      >
        {opening ? 'Opening…' : 'Open'}
      </button>
      <button
        onClick={() => setShowOpenDialog(true)}
        className="px-1.5 py-1 rounded text-xs bg-[var(--border)] text-[var(--text-secondary)] hover:text-white transition"
        title="パスを直接入力して開く"
      >
        …
      </button>
      <button
        onClick={() => setShowSaveDialog(true)}
        className="px-2 py-1 rounded text-xs bg-[var(--accent)] text-white hover:opacity-90 transition"
      >
        Save As
      </button>

      {/* Projection button */}
      {metadata && metadata.num_z > 1 && (
        <button
          onClick={() => setShowProjection(true)}
          className="px-2 py-1 rounded text-xs bg-[var(--border)] text-[var(--text-secondary)] hover:text-white transition"
          title="Z Projection"
        >
          Projection
        </button>
      )}

      {/* Open file dialog */}
      {showOpenDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4 w-[500px] shadow-xl">
            <h3 className="text-sm font-bold mb-3">Open Image File</h3>
            <button
              onClick={handleBrowse}
              disabled={opening}
              className="w-full mb-3 px-3 py-2 rounded text-xs bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 transition"
            >
              ファイルを選択…（Finder）
            </button>
            <div className="text-[10px] text-[var(--text-secondary)] mb-1">またはパスを直接入力</div>
            <input
              type="text"
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleOpen()}
              placeholder="/path/to/image.oir"
              autoFocus
              className="w-full px-3 py-2 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)]"
            />
            {openError && (
              <p className="text-xs text-red-400 mt-2">{openError}</p>
            )}
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => { setShowOpenDialog(false); setOpenError(''); }}
                className="px-3 py-1.5 rounded text-xs bg-[var(--border)] text-[var(--text-secondary)] hover:text-white transition"
              >
                Cancel
              </button>
              <button
                onClick={handleOpen}
                disabled={opening || !filePath.trim()}
                className="px-3 py-1.5 rounded text-xs bg-[var(--accent)] text-white hover:opacity-90 transition disabled:opacity-50"
              >
                {opening ? 'Opening...' : 'Open'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Separator */}
      <div className="w-px h-5 bg-[var(--border)]" />

      {/* ROI tools. ROIOverlay is only mounted in the 2D viewport, so these do
          nothing in 3D/Split/Compare — disable them there instead of leaving a
          lit tool that silently ignores every drag. */}
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-[var(--text-secondary)] mr-1">Tools</span>
        {roiTools.map((tool) => (
          <button
            key={tool.id}
            onClick={() => setRoiTool(tool.id)}
            disabled={!roiToolsUsable}
            className={`w-7 h-7 rounded flex items-center justify-center text-sm transition disabled:opacity-30 disabled:cursor-not-allowed ${
              roiTool === tool.id && roiToolsUsable
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--border)] text-[var(--text-secondary)] enabled:hover:text-white'
            }`}
            title={roiToolsUsable ? tool.label : `${tool.label} — available in 2D view only`}
          >
            {tool.icon}
          </button>
        ))}
      </div>

      {/* Separator */}
      <div className="w-px h-5 bg-[var(--border)]" />

      {/* View modes */}
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-[var(--text-secondary)] mr-1">View</span>
        {viewModes.map((mode) => (
          <button
            key={mode.id}
            onClick={() => setViewMode(mode.id)}
            className={`px-2 py-1 rounded text-xs transition ${
              viewMode === mode.id
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--border)] text-[var(--text-secondary)] hover:text-white'
            }`}
          >
            {mode.label}
          </button>
        ))}
      </div>

      {/* Separator */}
      <div className="w-px h-5 bg-[var(--border)]" />

      {/* Merge toggle (only in split mode) */}
      {viewMode === 'split' && (
        <>
          <div className="w-px h-5 bg-[var(--border)]" />
          <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showMergeInSplit}
              onChange={(e) => setShowMergeInSplit(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            <span className="text-[var(--text-secondary)]">Merge</span>
          </label>
        </>
      )}

      {/* ROI info */}
      {rois.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--text-secondary)]">
            ROIs: {rois.length}
            {activeRoiId && ` (selected: ${rois.find(r => r.id === activeRoiId)?.type})`}
          </span>
          <button
            onClick={clearRois}
            className="text-xs text-red-400 hover:text-red-300 transition"
          >
            Clear
          </button>
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Zoom display — only meaningful where it drives the shared 2D view.
          3D has its own camera and Compare has per-panel zoom, so showing an
          inert control there just invites the user to type into a dead field. */}
      {(viewMode === '2d' || viewMode === 'split') && <ZoomDisplay />}

      {/* Save dialog */}
      <SaveDialog open={showSaveDialog} onClose={() => setShowSaveDialog(false)} />
      {/* Projection dialog */}
      <ProjectionDialog open={showProjection} onClose={() => setShowProjection(false)} />
    </div>
  );
}

function ZoomDisplay() {
  const zoom = useViewStore((s) => s.zoom);
  const setZoom = useViewStore((s) => s.setZoom);
  const resetView = useViewStore((s) => s.resetView);
  // null = the user hasn't typed anything, so the field mirrors the live zoom.
  // Keeping it null until the first keystroke means focusing the field never
  // freezes the display, and blurring it never re-applies a stale number over
  // a zoom the user meanwhile made with the wheel.
  const [draft, setDraft] = useState<string | null>(null);
  const cancelling = useRef(false);

  const finish = (apply: boolean) => {
    if (apply && draft !== null) {
      const v = parseFloat(draft);
      if (!Number.isNaN(v) && v > 0) setZoom(v / 100); // store clamps to 10%..5000%
    }
    setDraft(null);
  };

  return (
    <div className="flex items-center gap-0.5" title="Zoom — type a % and press Enter (10–5000%). Esc cancels.">
      <input
        type="text"
        inputMode="decimal"
        value={draft ?? (zoom * 100).toFixed(0)}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => {
          // Escape blurs the field; don't let that path commit the typed value.
          finish(!cancelling.current);
          cancelling.current = false;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            finish(true);
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            cancelling.current = true;
            e.currentTarget.blur();
          }
        }}
        className="w-11 text-right text-xs font-mono bg-transparent text-[var(--text-secondary)] hover:text-white focus:text-white rounded px-1 py-0.5 border border-transparent focus:border-[var(--accent)] focus:bg-[var(--bg-primary)] focus:outline-none"
      />
      <span className="text-xs font-mono text-[var(--text-secondary)] select-none">%</span>
      <button
        onClick={resetView}
        className="ml-1 text-xs text-[var(--text-secondary)] hover:text-white transition"
        title="Reset view (100%, centered)"
      >
        &#8635;
      </button>
    </div>
  );
}
