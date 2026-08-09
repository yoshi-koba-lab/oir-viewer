import { useState, useEffect, useRef } from 'react';
import { useImageStore, type ProjectionMethod } from '../stores/imageStore';
import {
  applyProjection, chooseFolder, OverwriteConflict, type ExportJobProgress,
} from '../utils/api';
import { switchToImage, refreshImageList } from '../hooks/useImageLoader';
import { dirnameOf, filenameProblem, stemOf } from '../utils/paths';
import { OverwriteConfirm } from './SaveDialog';

interface Props {
  open: boolean;
  onClose: () => void;
}

const PROJECTION_LABEL: Record<ProjectionMethod, string> = {
  max: 'MaxProj', min: 'MinProj', avg: 'AvgProj',
};

function defaultProjectionName(filename: string, method: ProjectionMethod): string {
  return `${stemOf(filename)}_${PROJECTION_LABEL[method]}`;
}

function projectionInputStem(name: string): string {
  return name.trim().replace(/\.ome\.tiff?$/i, '');
}

export function ProjectionDialog({ open, onClose }: Props) {
  const metadata = useImageStore((s) => s.metadata);
  const imageList = useImageStore((s) => s.imageList);
  const activeImageId = useImageStore((s) => s.activeImageId);
  const currentT = useImageStore((s) => s.currentT);

  const [method, setMethod] = useState<ProjectionMethod>('max');
  const [zFrom, setZFrom] = useState(1);
  const [zTo, setZTo] = useState(1);
  const [tPoint, setTPoint] = useState(1);
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());
  const [outputDir, setOutputDir] = useState('~/Desktop');
  const [baseName, setBaseName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [conflict, setConflict] = useState<
    { files: string[]; count: number; more: number; revisions: Record<string, string> } | null
  >(null);
  const [browsing, setBrowsing] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<ExportJobProgress | null>(null);
  const projectionRun = useRef(0);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Init when dialog opens
  useEffect(() => {
    if (!open || !metadata) return;
    setMethod('max');
    setZFrom(1);
    setZTo(metadata.num_z);
    const preferredId = activeImageId || imageList.find((img) => img.active)?.id;
    const selected = imageList.find((img) => img.id === preferredId && img.num_z > 1)
      ?? imageList.find((img) => img.num_z > 1);
    setSelectedImages(new Set(selected ? [selected.id] : []));
    setZTo(selected?.num_z ?? 1);
    setTPoint(Math.min(
      selected?.num_t ?? 1,
      selected?.id === activeImageId ? currentT + 1 : 1,
    ));
    // Default to the selected source, which may differ from the active Z=1 tab.
    const selectedSource = selected?.source_path ?? metadata.source_path;
    if (selectedSource) {
      const dir = dirnameOf(selectedSource);
      if (dir && !dir.startsWith('/tmp') && !dir.startsWith('/private/var') && !dir.startsWith('/private/tmp')) {
        setOutputDir(dir);
      }
    }
    setBaseName(defaultProjectionName(selected?.filename ?? metadata.filename, 'max'));
    setNameEdited(false);
    setConflict(null);
    setError('');
    setSuccessMsg('');
    setProgress(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleBrowse = async () => {
    if (processing) return;
    setBrowsing(true);
    try {
      const result = await chooseFolder();
      if (result.path && !result.cancelled) {
        setOutputDir(result.path);
        setConflict(null);
      }
    } catch { /* cancelled */ } finally {
      setBrowsing(false);
    }
  };

  if (!open || !metadata) return null;

  // Filter to images with Z > 1
  const eligibleImages = imageList.filter((img) => img.num_z > 1);

  if (eligibleImages.length === 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-5 w-[400px] shadow-xl">
          <h3 className="text-sm font-bold mb-3 text-[var(--text-primary)]">Z Projection</h3>
          <p className="text-xs text-[var(--text-secondary)] mb-4">
            Zスライスが2枚以上の画像がありません。
          </p>
          <div className="flex justify-end">
            <button onClick={onClose} className="px-4 py-2 rounded text-xs bg-[var(--border)] text-[var(--text-secondary)] hover:text-white transition">
              OK
            </button>
          </div>
        </div>
      </div>
    );
  }

  const selectedEligible = eligibleImages.filter((img) => selectedImages.has(img.id));
  // One visible range is applied to every selected image. Limit it to the
  // common Z/T extent so the summary cannot promise slices the backend then
  // silently clamps away for a shorter image.
  const maxZ = selectedEligible.length
    ? Math.min(...selectedEligible.map((img) => img.num_z))
    : 1;
  const maxT = selectedEligible.length
    ? Math.min(...selectedEligible.map((img) => img.num_t))
    : 1;
  const sliceCount = Math.max(0, zTo - zFrom + 1);

  const toggleImage = (id: string) => {
    const next = new Set(selectedImages);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedImages(next);
    const nextItems = eligibleImages.filter((img) => next.has(img.id));
    const nextMaxZ = nextItems.length ? Math.min(...nextItems.map((img) => img.num_z)) : 1;
    const nextMaxT = nextItems.length ? Math.min(...nextItems.map((img) => img.num_t)) : 1;
    if (next.size === 1) {
      const only = nextItems[0];
      setZFrom(1);
      setZTo(only?.num_z ?? 1);
      setTPoint(Math.min(only?.num_t ?? 1, only?.id === activeImageId ? currentT + 1 : 1));
      if (!nameEdited && only) setBaseName(defaultProjectionName(only.filename, method));
    } else {
      setZFrom((v) => Math.min(v, nextMaxZ));
      setZTo((v) => Math.min(v, nextMaxZ));
      setTPoint((v) => Math.min(v, nextMaxT));
    }
    setConflict(null);
  };

  const selectAll = () => {
    const next = new Set(eligibleImages.map((img) => img.id));
    setSelectedImages(next);
    const commonZ = eligibleImages.length ? Math.min(...eligibleImages.map((img) => img.num_z)) : 1;
    const commonT = eligibleImages.length ? Math.min(...eligibleImages.map((img) => img.num_t)) : 1;
    setZFrom(1);
    setZTo(commonZ);
    setTPoint((v) => Math.min(v, commonT));
    setConflict(null);
  };

  const handleApply = async (overwrite = false) => {
    if (projectionRun.current) return;
    if (selectedImages.size === 0) {
      setError('画像を1つ以上選択してください');
      return;
    }
    if (!outputDir.trim()) {
      setError('保存先フォルダを入力してください');
      return;
    }
    if (selectedImages.size === 1) {
      const bad = filenameProblem(projectionInputStem(baseName));
      if (bad) {
        setError(bad);
        return;
      }
    }
    const expectedRevisions = overwrite ? (conflict?.revisions ?? {}) : {};
    const runId = Date.now() || 1;
    projectionRun.current = runId;
    setError('');
    setSuccessMsg('');
    // A confirmed overwrite should expose the progress/result state, not leave
    // the stale confirmation sheet covering a save that is already running.
    setConflict(null);
    setProcessing(true);
    setProgress({
      phase: 'planning', completed: 0, total: 0, percent: 0,
      label: '保存内容を確認中…',
    });

    try {
      // Freeze each source tab's own view. Reusing the active tab's LUT for a
      // different image can make a numerically correct projection look wrong and
      // then persist that wrong view state into later figure exports.
      useImageStore.getState().saveViewState();
      const sourceViews = { ...useImageStore.getState().imageViewStates };
      const result = await applyProjection({
        image_ids: Array.from(selectedImages),
        method,
        z_from: zFrom - 1,
        z_to: zTo - 1,
        t: tPoint - 1,
        output_dir: outputDir.trim(),
        filename: selectedImages.size === 1 ? projectionInputStem(baseName) : '',
        overwrite,
        expected_revisions: expectedRevisions,
      }, setProgress);

      // Refresh image list
      setProgress({
        phase: 'result-check', completed: 1, total: 1, percent: 100,
        label: '保存完了。保存結果を確認中…',
      });
      await refreshImageList();

      // Restore only the matching source's view, then switch to the last output.
      for (const r of result.results) {
        // Switch to each projected image to initialize its channels
        await switchToImage(r.id);

        // Restore channel colors, visibility, and contrast from this source.
        const store = useImageStore.getState();
        const newChannels = [...store.channels];
        const sourceChannels = sourceViews[r.source_image_id]?.channels;
        if (sourceChannels?.length === newChannels.length) {
          for (let i = 0; i < newChannels.length; i++) {
            const source = sourceChannels[i];
            newChannels[i] = {
              ...newChannels[i], color: [...source.color], visible: source.visible,
              min: source.min, max: source.max,
            };
          }
          useImageStore.setState({ channels: newChannels });
        }

        // Save this view state so it persists when switching tabs
        useImageStore.getState().saveViewState();
      }

      const names = result.results.map((r) => r.filename).join(', ');
      setSuccessMsg(`保存完了: ${names}`);
      setTimeout(() => onClose(), 1500);
    } catch (e) {
      if (e instanceof OverwriteConflict) {
        setConflict({
          files: e.files, count: e.count, more: e.more, revisions: e.revisions,
        });
      } else {
        setError(e instanceof Error ? e.message : 'Projection failed');
      }
    } finally {
      if (projectionRun.current === runId) {
        projectionRun.current = 0;
        setProcessing(false);
      }
    }
  };

  const methods: { id: ProjectionMethod; label: string; desc: string }[] = [
    { id: 'max', label: 'Max', desc: '各ピクセルの最大値 (蛍光に最適)' },
    { id: 'min', label: 'Min', desc: '各ピクセルの最小値 (透過光に最適)' },
    { id: 'avg', label: 'Average', desc: '各ピクセルの平均値' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-5 w-[480px] max-h-[90vh] overflow-y-auto shadow-xl">
        <h3 className="text-sm font-bold mb-4 text-[var(--text-primary)]">Z Projection</h3>

        {/* Target images */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
              Target Images
            </h4>
            {eligibleImages.length > 1 && (
              <button
                onClick={selectAll}
                disabled={processing}
                className="text-[10px] text-[var(--accent)] hover:underline disabled:opacity-40"
              >
                Select All
              </button>
            )}
          </div>
          <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
            {eligibleImages.map((img) => (
              <label
                key={img.id}
                className="flex items-center gap-2 px-2 py-1 rounded hover:bg-[var(--border)]/30 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selectedImages.has(img.id)}
                  disabled={processing}
                  onChange={() => toggleImage(img.id)}
                  className="accent-[var(--accent)]"
                />
                <span className="text-xs text-[var(--text-primary)] truncate flex-1">{img.filename}</span>
                <span className="text-[10px] text-[var(--text-secondary)]">
                  Z:{img.num_z} {img.width}x{img.height}
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* Method */}
        <div className="mb-4">
          <h4 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">
            Method
          </h4>
          <div className="flex flex-col gap-1.5">
            {methods.map((m) => (
              <label
                key={m.id}
                className={`flex items-center gap-3 px-3 py-2 rounded cursor-pointer transition ${
                  method === m.id
                    ? 'bg-[var(--accent)]/15 border border-[var(--accent)]/40'
                    : 'bg-[var(--bg-primary)] border border-transparent hover:border-[var(--border)]'
                }`}
              >
                <input
                  type="radio"
                  name="projMethod"
                  checked={method === m.id}
                  disabled={processing}
                  onChange={() => {
                    setMethod(m.id);
                    if (!nameEdited && selectedImages.size === 1) {
                      const only = imageList.find((img) => selectedImages.has(img.id));
                      if (only) setBaseName(defaultProjectionName(only.filename, m.id));
                    }
                    setConflict(null);
                  }}
                  className="accent-[var(--accent)]"
                />
                <div>
                  <span className="text-xs font-medium text-[var(--text-primary)]">{m.label}</span>
                  <span className="text-[10px] text-[var(--text-secondary)] ml-2">{m.desc}</span>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Filename */}
        <div className="mb-4">
          <h4 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">
            ファイル名
          </h4>
          {selectedImages.size > 1 ? (
            <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
              {selectedImages.size} 枚を選択中のため、各画像は元のファイル名に
              投影方法を付けて保存します。
            </p>
          ) : (
            <>
              <input
                type="text"
                value={baseName}
                disabled={processing}
                onChange={(e) => {
                  setBaseName(e.target.value);
                  setNameEdited(true);
                  setConflict(null);
                }}
                placeholder="ファイル名（拡張子なし）"
                className="w-full px-3 py-2 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)]"
              />
              {filenameProblem(projectionInputStem(baseName)) ? (
                <p className="text-[11px] text-red-400 mt-1">
                  {filenameProblem(projectionInputStem(baseName))}
                </p>
              ) : (
                <p className="text-[10px] text-[var(--text-secondary)] mt-1">
                  保存名: <code>{projectionInputStem(baseName)}.ome.tif</code>
                </p>
              )}
            </>
          )}
        </div>

        {/* Z Range */}
        <div className="mb-4">
          <h4 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">
            Z Range (1–{maxZ})
          </h4>
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--text-secondary)]">From</span>
            <input
              type="number"
              min={1}
              max={maxZ}
              value={zFrom}
              disabled={processing}
              onChange={(e) => setZFrom(Math.max(1, Math.min(maxZ, Number(e.target.value))))}
              className="w-16 px-2 py-1.5 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-primary)] text-center text-xs focus:outline-none focus:border-[var(--accent)]"
            />
            <span className="text-xs text-[var(--text-secondary)]">to</span>
            <input
              type="number"
              min={1}
              max={maxZ}
              value={zTo}
              disabled={processing}
              onChange={(e) => setZTo(Math.max(1, Math.min(maxZ, Number(e.target.value))))}
              className="w-16 px-2 py-1.5 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-primary)] text-center text-xs focus:outline-none focus:border-[var(--accent)]"
            />
            <span className="text-xs text-[var(--text-secondary)]">({sliceCount} slices)</span>
          </div>
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => { setZFrom(1); setZTo(maxZ); }}
              disabled={processing}
              className="text-[10px] px-2 py-1 rounded bg-[var(--border)] text-[var(--text-secondary)] hover:text-white transition"
            >
              All
            </button>
            <button
              onClick={() => {
                const mid = Math.floor(maxZ / 2);
                const half = Math.floor(maxZ / 4);
                setZFrom(Math.max(1, mid - half));
                setZTo(Math.min(maxZ, mid + half));
              }}
              disabled={processing}
              className="text-[10px] px-2 py-1 rounded bg-[var(--border)] text-[var(--text-secondary)] hover:text-white transition"
            >
              Center 50%
            </button>
          </div>
        </div>

        {/* Time point */}
        <div className="mb-4">
          <h4 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">
            Time point (1–{maxT})
          </h4>
          <input
            type="number"
            min={1}
            max={maxT}
            value={tPoint}
            disabled={processing}
            onChange={(e) => setTPoint(Math.max(1, Math.min(maxT, Number(e.target.value))))}
            className="w-16 px-2 py-1.5 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-primary)] text-center text-xs focus:outline-none focus:border-[var(--accent)]"
          />
          <p className="text-[10px] text-[var(--text-secondary)] mt-1">
            選択した全画像に同じ T を使います。
          </p>
        </div>

        {/* Save to */}
        <div className="mb-4">
          <h4 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">
            Save to
          </h4>
          <div className="flex gap-2">
            <input
              type="text"
              value={outputDir}
              disabled={processing}
              onChange={(e) => { setOutputDir(e.target.value); setConflict(null); }}
              placeholder="/path/to/output/folder"
              className="flex-1 px-3 py-2 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)]"
            />
            <button
              onClick={handleBrowse}
              disabled={browsing || processing}
              className="px-3 py-2 rounded text-xs bg-[var(--border)] text-[var(--text-secondary)] hover:text-white transition shrink-0 disabled:opacity-50"
            >
              {browsing ? '...' : 'Browse'}
            </button>
          </div>
        </div>

        {/* Summary */}
        <div className="mb-4 p-3 rounded bg-[var(--bg-primary)] text-xs text-[var(--text-secondary)]">
          {selectedImages.size}枚の画像に対し、T{tPoint} の {sliceCount} slices
          {' '}(Z{zFrom}–Z{zTo}) を
          <strong className="text-[var(--text-primary)]">
            {method === 'max' ? ' Maximum' : method === 'min' ? ' Minimum' : ' Average'}
          </strong>
          {' '}Projectionで投影し、OME-TIFFとして保存します。
        </div>

        {/* Error / Success */}
        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
        {successMsg && <p className="text-xs text-green-400 mb-3">{successMsg}</p>}

        {processing && progress && (
          <div className="mb-3 rounded border border-[var(--border)] bg-[var(--bg-primary)] p-3" aria-live="polite">
            <div className="mb-1 flex justify-between gap-3 text-xs">
              <span>{progress.label}</span>
              <span className="font-mono tabular-nums">{progress.percent}%</span>
            </div>
            <progress
              value={progress.percent}
              max={100}
              aria-label={`Z投影保存進捗 ${progress.percent}%`}
              className="h-2 w-full accent-[var(--accent)]"
            />
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={processing}
            className="px-4 py-2 rounded text-xs bg-[var(--border)] text-[var(--text-secondary)] hover:text-white transition"
          >
            {processing ? '保存中…' : 'Cancel'}
          </button>
          <button
            onClick={() => handleApply(false)}
            disabled={processing || !!conflict || sliceCount < 1 || selectedImages.size === 0
                      || (selectedImages.size === 1
                        && !!filenameProblem(projectionInputStem(baseName)))}
            className="px-4 py-2 rounded text-xs bg-[var(--accent)] text-white hover:opacity-90 transition disabled:opacity-50"
          >
            {processing ? `保存中 ${progress?.percent ?? 0}%` : 'Apply & Save'}
          </button>
        </div>

        {conflict && (
          <OverwriteConfirm
            conflict={conflict}
            busy={processing}
            onCancel={() => setConflict(null)}
            onConfirm={() => handleApply(true)}
          />
        )}
      </div>
    </div>
  );
}
