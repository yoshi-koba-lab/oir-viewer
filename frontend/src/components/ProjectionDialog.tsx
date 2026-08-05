import { useState, useEffect } from 'react';
import { useImageStore, type ProjectionMethod } from '../stores/imageStore';
import { applyProjection, chooseFolder } from '../utils/api';
import { switchToImage, refreshImageList } from '../hooks/useImageLoader';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ProjectionDialog({ open, onClose }: Props) {
  const metadata = useImageStore((s) => s.metadata);
  const channels = useImageStore((s) => s.channels);
  const imageList = useImageStore((s) => s.imageList);
  const activeImageId = useImageStore((s) => s.activeImageId);
  const currentT = useImageStore((s) => s.currentT);

  const [method, setMethod] = useState<ProjectionMethod>('max');
  const [zFrom, setZFrom] = useState(1);
  const [zTo, setZTo] = useState(1);
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());
  const [outputDir, setOutputDir] = useState('~/Desktop');
  const [browsing, setBrowsing] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Init when dialog opens
  useEffect(() => {
    if (!open || !metadata) return;
    setMethod('max');
    setZFrom(1);
    setZTo(metadata.num_z);
    const id = activeImageId || imageList.find((img) => img.active)?.id;
    setSelectedImages(new Set(id ? [id] : []));
    // Default output dir to the source file's directory
    if (metadata.source_path) {
      const dir = metadata.source_path.replace(/\/[^/]+$/, '');
      if (dir && !dir.startsWith('/tmp') && !dir.startsWith('/private/var') && !dir.startsWith('/private/tmp')) {
        setOutputDir(dir);
      }
    }
    setError('');
    setSuccessMsg('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleBrowse = async () => {
    setBrowsing(true);
    try {
      const result = await chooseFolder();
      if (result.path && !result.cancelled) setOutputDir(result.path);
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

  const maxZ = metadata.num_z;
  const sliceCount = Math.max(0, zTo - zFrom + 1);

  const toggleImage = (id: string) => {
    const next = new Set(selectedImages);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedImages(next);
  };

  const selectAll = () => setSelectedImages(new Set(eligibleImages.map((img) => img.id)));

  const handleApply = async () => {
    if (selectedImages.size === 0) {
      setError('画像を1つ以上選択してください');
      return;
    }
    setError('');
    setSuccessMsg('');
    setProcessing(true);

    // Save current channel colors/visibility to apply to all projected files
    const savedColors = channels.map((ch) => [...ch.color] as [number, number, number]);
    const savedVisible = channels.map((ch) => ch.visible);
    const savedMins = channels.map((ch) => ch.min);
    const savedMaxs = channels.map((ch) => ch.max);

    try {
      const result = await applyProjection({
        image_ids: Array.from(selectedImages),
        method,
        z_from: zFrom - 1,
        z_to: zTo - 1,
        t: currentT,
        output_dir: outputDir.trim(),
      });

      // Refresh image list
      await refreshImageList();

      // Apply saved colors to ALL projected files, then switch to the last one
      for (const r of result.results) {
        // Switch to each projected image to initialize its channels
        await switchToImage(r.id);

        // Restore channel colors, visibility, and contrast from the source image
        const store = useImageStore.getState();
        const newChannels = [...store.channels];
        for (let i = 0; i < newChannels.length && i < savedColors.length; i++) {
          newChannels[i] = { ...newChannels[i], color: savedColors[i], visible: savedVisible[i], min: savedMins[i], max: savedMaxs[i] };
        }
        useImageStore.setState({ channels: newChannels });

        // Save this view state so it persists when switching tabs
        useImageStore.getState().saveViewState();
      }

      const names = result.results.map((r) => r.filename).join(', ');
      setSuccessMsg(`保存完了: ${names}`);
      setTimeout(() => onClose(), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Projection failed');
    } finally {
      setProcessing(false);
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
              <button onClick={selectAll} className="text-[10px] text-[var(--accent)] hover:underline">
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
                  onChange={() => setMethod(m.id)}
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
              onChange={(e) => setZFrom(Math.max(1, Math.min(maxZ, Number(e.target.value))))}
              className="w-16 px-2 py-1.5 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-primary)] text-center text-xs focus:outline-none focus:border-[var(--accent)]"
            />
            <span className="text-xs text-[var(--text-secondary)]">to</span>
            <input
              type="number"
              min={1}
              max={maxZ}
              value={zTo}
              onChange={(e) => setZTo(Math.max(1, Math.min(maxZ, Number(e.target.value))))}
              className="w-16 px-2 py-1.5 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-primary)] text-center text-xs focus:outline-none focus:border-[var(--accent)]"
            />
            <span className="text-xs text-[var(--text-secondary)]">({sliceCount} slices)</span>
          </div>
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => { setZFrom(1); setZTo(maxZ); }}
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
              className="text-[10px] px-2 py-1 rounded bg-[var(--border)] text-[var(--text-secondary)] hover:text-white transition"
            >
              Center 50%
            </button>
          </div>
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
              onChange={(e) => setOutputDir(e.target.value)}
              placeholder="/path/to/output/folder"
              className="flex-1 px-3 py-2 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)]"
            />
            <button
              onClick={handleBrowse}
              disabled={browsing}
              className="px-3 py-2 rounded text-xs bg-[var(--border)] text-[var(--text-secondary)] hover:text-white transition shrink-0 disabled:opacity-50"
            >
              {browsing ? '...' : 'Browse'}
            </button>
          </div>
        </div>

        {/* Summary */}
        <div className="mb-4 p-3 rounded bg-[var(--bg-primary)] text-xs text-[var(--text-secondary)]">
          {selectedImages.size}枚の画像に対し、{sliceCount} slices (Z{zFrom}–Z{zTo}) を
          <strong className="text-[var(--text-primary)]">
            {method === 'max' ? ' Maximum' : method === 'min' ? ' Minimum' : ' Average'}
          </strong>
          {' '}Projectionで投影し、OME-TIFFとして保存します。
        </div>

        {/* Error / Success */}
        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
        {successMsg && <p className="text-xs text-green-400 mb-3">{successMsg}</p>}

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded text-xs bg-[var(--border)] text-[var(--text-secondary)] hover:text-white transition"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={processing || sliceCount < 1 || selectedImages.size === 0}
            className="px-4 py-2 rounded text-xs bg-[var(--accent)] text-white hover:opacity-90 transition disabled:opacity-50"
          >
            {processing ? 'Processing...' : 'Apply & Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
