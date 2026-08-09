import { useState, useEffect, useRef } from 'react';
import { useImageStore } from '../stores/imageStore';
import {
  saveImages, chooseFolder, OverwriteConflict,
  type ExportJobProgress, type SaveRequest,
} from '../utils/api';
import { dirnameOf, stemOf, filenameProblem } from '../utils/paths';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Format = 'tiff' | 'png' | 'jpeg';

/** Per-image channel export settings. null = let the backend resolve it. */
interface ChannelSetting {
  channel: number;
  color: [number, number, number] | null;
  min: number | null;
  max: number | null;
}

/** SaveRequest plus the per-image channel settings the backend now accepts. */
type SaveRequestPerImage = SaveRequest & { image_channels: Record<string, ChannelSetting[]> };

/** SaveResponse plus what the backend reports about what it actually wrote. */
interface SaveResult {
  saved: string[];
  output_dir: string;
  skipped?: string[];
}

export function SaveDialog({ open, onClose }: Props) {
  const metadata = useImageStore((s) => s.metadata);
  const channels = useImageStore((s) => s.channels);
  const imageList = useImageStore((s) => s.imageList);
  const activeImageId = useImageStore((s) => s.activeImageId);
  const imageViewStates = useImageStore((s) => s.imageViewStates);
  const currentZ = useImageStore((s) => s.currentZ);
  const currentT = useImageStore((s) => s.currentT);

  const activeId = activeImageId ?? imageList.find((img) => img.active)?.id;

  const [outputDir, setOutputDir] = useState('~/Desktop');
  /**
   * The name to save under. Seeded from the image but always shown and always
   * editable — "save as" is the only mode, because the previous behaviour named
   * the files itself and then quietly renamed them again on a collision.
   */
  const [baseName, setBaseName] = useState('');
  /** Set when the backend refused because files are already there. */
  const [conflict, setConflict] = useState<
    { files: string[]; count: number; more: number; revisions: Record<string, string> } | null
  >(null);
  const [browsing, setBrowsing] = useState(false);
  const [format, setFormat] = useState<Format>('tiff');
  const [bitDepth, setBitDepth] = useState<'8' | '16'>('16');
  const [saveSeparate, setSaveSeparate] = useState(true);
  const [saveMerge, setSaveMerge] = useState(true);
  const [selectedChannels, setSelectedChannels] = useState<Set<number>>(new Set());
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());
  const [zMode, setZMode] = useState<'current' | 'range' | 'projection'>('range');
  const [zFrom, setZFrom] = useState(1);
  const [zTo, setZTo] = useState(1);
  const [imageZRanges, setImageZRanges] = useState<Record<string, [number, number]>>({});
  // Images whose Z range the user set individually; those stop following the
  // main From/To below.
  const [zEdited, setZEdited] = useState<Set<string>>(new Set());
  const [projMethod, setProjMethod] = useState<'max' | 'min' | 'avg'>('max');
  const [tFrom, setTFrom] = useState(1);
  const [tTo, setTTo] = useState(1);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<ExportJobProgress | null>(null);
  const saveRun = useRef(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [warnMsg, setWarnMsg] = useState('');

  // Reset selections when dialog opens
  useEffect(() => {
    if (!open || !metadata) return;
    setSelectedChannels(new Set(Array.from({ length: metadata.num_channels }, (_, i) => i)));
    setSelectedImages(new Set(activeId ? [activeId] : []));
    // Default output dir to source file's directory.
    //
    // Both separators: a Windows path has no forward slash at all, so stripping
    // only after "/" left the whole path including the filename, and the
    // default output folder was a folder that did not exist.
    if (metadata.source_path) {
      const dir = dirnameOf(metadata.source_path);
      if (dir && !dir.startsWith('/tmp') && !dir.startsWith('/private/var') && !dir.startsWith('/private/tmp')) {
        setOutputDir(dir);
      }
    }
    setBaseName(stemOf(metadata.filename));
    setZMode('range');
    setZFrom(1);
    setZTo(metadata.num_z);
    const zRanges: Record<string, [number, number]> = {};
    for (const img of imageList) {
      zRanges[img.id] = [1, img.num_z];
    }
    setImageZRanges(zRanges);
    setZEdited(new Set());
    setTFrom(1);
    setTTo(metadata.num_t);
    setError('');
    setSuccessMsg('');
    setWarnMsg('');
    setProgress(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleBrowse = async () => {
    setBrowsing(true);
    try {
      const result = await chooseFolder();
      if (result.path && !result.cancelled) {
        setOutputDir(result.path);
      }
    } catch {
      // user cancelled or error
    } finally {
      setBrowsing(false);
    }
  };

  if (!open || !metadata) return null;

  const toggleChannel = (i: number) => {
    const next = new Set(selectedChannels);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setSelectedChannels(next);
  };

  const toggleImage = (id: string) => {
    const next = new Set(selectedImages);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedImages(next);
  };

  const selectAllChannels = () => {
    setSelectedChannels(new Set(Array.from({ length: metadata.num_channels }, (_, i) => i)));
  };

  const selectAllImages = () => {
    setSelectedImages(new Set(imageList.map((img) => img.id)));
  };

  const setImageZFrom = (id: string, val: number, maxZ: number) => {
    setZEdited((prev) => new Set(prev).add(id));
    setImageZRanges((prev) => ({ ...prev, [id]: [Math.max(1, Math.min(maxZ, val)), prev[id]?.[1] ?? maxZ] }));
  };
  const setImageZTo = (id: string, val: number, maxZ: number) => {
    setZEdited((prev) => new Set(prev).add(id));
    setImageZRanges((prev) => ({ ...prev, [id]: [prev[id]?.[0] ?? 1, Math.max(1, Math.min(maxZ, val))] }));
  };

  /**
   * Set the main Z range and push it onto every image the user has not
   * overridden individually. The per-image entry wins on the backend, so
   * without this the main From/To is silently ignored.
   */
  const applyGlobalZ = (from: number, to: number) => {
    setZFrom(from);
    setZTo(to);
    setImageZRanges((prev) => {
      const next = { ...prev };
      for (const img of imageList) {
        if (zEdited.has(img.id)) continue;
        next[img.id] = [
          Math.max(1, Math.min(img.num_z, from)),
          Math.max(1, Math.min(img.num_z, to)),
        ];
      }
      return next;
    });
  };

  /** Channel settings for one image: its own view state, or null for the backend to resolve. */
  const channelSettingsFor = (id: string, chIndices: number[]): ChannelSetting[] => {
    const item = imageList.find((img) => img.id === id);
    const numChannels = item?.num_channels ?? metadata?.num_channels ?? 0;
    // The active image's live state lives in `channels`; other images keep theirs
    // in imageViewStates. An image never opened has neither.
    const state = id === activeId ? channels : imageViewStates[id]?.channels;
    return chIndices
      .filter((i) => i < numChannels)
      .map((i) => {
        const ch = state?.[i];
        return ch
          ? { channel: i, color: [...ch.color] as [number, number, number], min: ch.min, max: ch.max }
          : { channel: i, color: null, min: null, max: null };
      });
  };

  const handleSave = async (overwrite = false) => {
    if (saveRun.current) return;
    if (!outputDir.trim()) {
      setError('保存先フォルダを入力してください');
      return;
    }
    // Only meaningful for a single image; a batch keeps each image's own name.
    if (selectedImages.size === 1) {
      const bad = filenameProblem(baseName);
      if (bad) {
        setError(bad);
        return;
      }
    }
    if (!saveSeparate && !saveMerge) {
      setError('SeparateかMergeの少なくとも一つを選択してください');
      return;
    }
    if (selectedChannels.size === 0) {
      setError('チャンネルを1つ以上選択してください');
      return;
    }
    if (selectedImages.size === 0) {
      setError('画像を1つ以上選択してください');
      return;
    }

    saveRun.current = true;
    const expectedRevisions = overwrite ? (conflict?.revisions ?? {}) : {};
    setError('');
    setSuccessMsg('');
    setWarnMsg('');
    setConflict(null);
    setSaving(true);
    setProgress({ phase: 'planning', completed: 0, total: 0, percent: 0, label: '保存内容を確認中…' });

    try {
      const chIndices = Array.from(selectedChannels).sort((a, b) => a - b);
      const ids = Array.from(selectedImages);
      // The flat lists below describe the active image only. Drop indices it no
      // longer has (the active image can change under an open dialog, e.g. by a
      // file drop) so building them cannot throw.
      const activeIndices = chIndices.filter((i) => channels[i]);
      // From > To would otherwise produce an empty range and save nothing.
      const [zLo, zHi] = [Math.min(zFrom, zTo), Math.max(zFrom, zTo)];
      const [tLo, tHi] = [Math.min(tFrom, tTo), Math.max(tFrom, tTo)];

      const req: SaveRequestPerImage = {
        output_dir: outputDir.trim(),
        basename: selectedImages.size === 1 ? baseName.trim() : '',
        overwrite,
        expected_revisions: expectedRevisions,
        image_ids: ids,
        channels: activeIndices,
        channel_colors: activeIndices.map((i) => [...channels[i].color]),
        channel_mins: activeIndices.map((i) => channels[i].min),
        channel_maxs: activeIndices.map((i) => channels[i].max),
        // Each image carries its own channels/LUT/contrast — the active image's
        // settings must not be stamped onto every file in a batch.
        image_channels: Object.fromEntries(ids.map((id) => [id, channelSettingsFor(id, chIndices)])),
        format,
        save_separate: saveSeparate,
        save_merge: saveMerge,
        z_mode: metadata.num_z > 1 ? zMode : 'current',
        z_from: zLo - 1,
        z_to: zHi - 1,
        image_z_ranges: Object.fromEntries(
          Object.entries(imageZRanges).map(([id, [from, to]]) => [
            id,
            [Math.min(from, to) - 1, Math.max(from, to) - 1] as [number, number],
          ])
        ),
        projection_method: projMethod,
        t_from: metadata.num_t > 1 ? tLo - 1 : currentT,
        t_to: metadata.num_t > 1 ? tHi - 1 : currentT,
        current_z: currentZ,
        current_t: currentT,
        bit_depth_output: bitDepth,
      };

      const result: SaveResult = await saveImages(req, setProgress);
      if (result.saved.length === 0) {
        setError(
          result.skipped?.length
            ? `保存されませんでした: ${result.skipped.join(' / ')}`
            : '保存されたファイルは0件です。チャンネル・Z/T範囲の設定を確認してください'
        );
        return;
      }
      setSuccessMsg(`${result.saved.length} files saved to ${result.output_dir}`);
      const notes: string[] = [];
      if (result.skipped?.length) notes.push(result.skipped.join(' / '));
      if (notes.length) {
        setWarnMsg(notes.join(' / '));  // keep the dialog open so the user reads it
      } else {
        setTimeout(() => onClose(), 1500);
      }
    } catch (e) {
      // A refusal is a question, not a failure: nothing was written, and the
      // same request goes through once the user says to replace them.
      if (e instanceof OverwriteConflict) {
        setConflict({
          files: e.files, count: e.count, more: e.more, revisions: e.revisions,
        });
      } else {
        setError(e instanceof Error ? e.message : 'Save failed');
      }
    } finally {
      saveRun.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="relative bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-5 w-[560px] max-h-[90vh] overflow-y-auto shadow-xl">
        <h3 className="text-sm font-bold mb-4 text-[var(--text-primary)]">Save Image As</h3>

        <fieldset disabled={saving} className="contents">

        {/* Output folder */}
        <Section title="Save to">
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
        </Section>

        {/* Filename */}
        <Section title="ファイル名">
          {selectedImages.size > 1 ? (
            <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
              {selectedImages.size} 枚を選択中のため、各画像は元のファイル名で
              画像ごとのサブフォルダに保存されます。
            </p>
          ) : (
            <>
              <input
                type="text"
                value={baseName}
                onChange={(e) => { setBaseName(e.target.value); setConflict(null); }}
                placeholder="ファイル名（拡張子なし）"
                className="w-full px-3 py-2 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)]"
              />
              {filenameProblem(baseName) ? (
                <p className="text-[11px] text-red-400 mt-1">{filenameProblem(baseName)}</p>
              ) : (
                <p className="text-[10px] text-[var(--text-secondary)] mt-1 leading-relaxed">
                  例: <code>{baseName || 'name'}_CH1{metadata.num_z > 1 && zMode === 'range' ? '_Z001' : ''}
                  {format === 'tiff' ? '.tif' : format === 'png' ? '.png' : '.jpg'}</code>
                  {' '}— チャンネル名や Z/T の番号が自動で付きます。
                </p>
              )}
            </>
          )}
        </Section>

        {/* Format */}
        <Section title="Format">
          <div className="flex gap-2">
            {(['tiff', 'png', 'jpeg'] as Format[]).map((f) => (
              <button
                key={f}
                onClick={() => setFormat(f)}
                className={`px-3 py-1.5 rounded text-xs font-medium transition ${
                  format === f
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--border)] text-[var(--text-secondary)] hover:text-white'
                }`}
              >
                {f.toUpperCase()}
              </button>
            ))}
          </div>
          {format === 'tiff' && (
            <div className="flex items-center gap-3 mt-2">
              <span className="text-xs text-[var(--text-secondary)]">Bit Depth:</span>
              {(['16', '8'] as const).map((bd) => (
                <label key={bd} className="flex items-center gap-1 text-xs cursor-pointer">
                  <input
                    type="radio"
                    name="bitDepth"
                    checked={bitDepth === bd}
                    onChange={() => setBitDepth(bd)}
                    className="accent-[var(--accent)]"
                  />
                  <span className="text-[var(--text-secondary)]">{bd}-bit</span>
                </label>
              ))}
            </div>
          )}
        </Section>

        {/* Output Type */}
        <Section title="Output">
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={saveSeparate}
                onChange={(e) => setSaveSeparate(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              <span className="text-[var(--text-primary)]">Separate</span>
              <span className="text-[var(--text-secondary)]">— 各チャンネル個別ファイル</span>
            </label>
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={saveMerge}
                onChange={(e) => setSaveMerge(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              <span className="text-[var(--text-primary)]">Merge</span>
              <span className="text-[var(--text-secondary)]">— 合成画像 (additive blend)</span>
            </label>
          </div>
        </Section>

        {/* Channels */}
        <Section title="Channels">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] text-[var(--text-secondary)]">
              {selectedChannels.size}/{metadata.num_channels} selected
            </span>
            <button onClick={selectAllChannels} className="text-[10px] text-[var(--accent)] hover:underline">
              Select All
            </button>
          </div>
          <div className="flex flex-col gap-1">
            {channels.map((ch, i) => (
              <label
                key={i}
                className="flex items-center gap-2 px-2 py-1 rounded hover:bg-[var(--border)]/30 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selectedChannels.has(i)}
                  onChange={() => toggleChannel(i)}
                  className="accent-[var(--accent)]"
                />
                <div
                  className="w-3 h-3 rounded-full shrink-0"
                  style={{ backgroundColor: `rgb(${ch.color.join(',')})` }}
                />
                <span className="text-xs text-[var(--text-primary)] flex-1">
                  {metadata.channel_names[i] || `Ch${i}`}
                </span>
                <span className="text-[10px] text-[var(--text-secondary)] font-mono">
                  {Math.round(ch.min)}-{Math.round(ch.max)}
                </span>
              </label>
            ))}
          </div>
        </Section>

        {/* Z Range */}
        {metadata.num_z > 1 && (
          <Section title={`Z Slices (1–${metadata.num_z})`}>
            <div className="flex flex-col gap-2">
              <div className="flex gap-2 flex-wrap">
                {(['range', 'current', 'projection'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setZMode(mode)}
                    className={`px-3 py-1.5 rounded text-xs font-medium transition ${
                      zMode === mode
                        ? 'bg-[var(--accent)] text-white'
                        : 'bg-[var(--border)] text-[var(--text-secondary)] hover:text-white'
                    }`}
                  >
                    {mode === 'range' ? 'Range' : mode === 'current' ? `Current (${currentZ + 1})` : 'Projection'}
                  </button>
                ))}
              </div>
              {(zMode === 'range' || zMode === 'projection') && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-[var(--text-secondary)]">From</span>
                  <input
                    type="number"
                    min={1}
                    max={metadata.num_z}
                    value={zFrom}
                    onChange={(e) => applyGlobalZ(Math.max(1, Math.min(metadata.num_z, Number(e.target.value))), zTo)}
                    className="w-16 px-2 py-1 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-primary)] text-center focus:outline-none focus:border-[var(--accent)]"
                  />
                  <span className="text-[var(--text-secondary)]">to</span>
                  <input
                    type="number"
                    min={1}
                    max={metadata.num_z}
                    value={zTo}
                    onChange={(e) => applyGlobalZ(zFrom, Math.max(1, Math.min(metadata.num_z, Number(e.target.value))))}
                    className="w-16 px-2 py-1 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-primary)] text-center focus:outline-none focus:border-[var(--accent)]"
                  />
                  <span className="text-[var(--text-secondary)]">
                    ({Math.abs(zTo - zFrom) + 1} slices{zMode === 'projection' ? ' → 1枚に投影' : ''})
                  </span>
                </div>
              )}
              {zMode === 'projection' && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--text-secondary)]">Method:</span>
                  {(['max', 'min', 'avg'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setProjMethod(m)}
                      className={`px-2.5 py-1 rounded text-xs font-medium transition ${
                        projMethod === m
                          ? 'bg-[var(--accent)] text-white'
                          : 'bg-[var(--border)] text-[var(--text-secondary)] hover:text-white'
                      }`}
                    >
                      {m === 'max' ? 'Max' : m === 'min' ? 'Min' : 'Average'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </Section>
        )}

        {/* T Range */}
        {metadata.num_t > 1 && (
          <Section title={`Time Points (1–${metadata.num_t})`}>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-[var(--text-secondary)]">From</span>
              <input
                type="number"
                min={1}
                max={metadata.num_t}
                value={tFrom}
                onChange={(e) => setTFrom(Math.max(1, Math.min(metadata.num_t, Number(e.target.value))))}
                className="w-16 px-2 py-1 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-primary)] text-center focus:outline-none focus:border-[var(--accent)]"
              />
              <span className="text-[var(--text-secondary)]">to</span>
              <input
                type="number"
                min={1}
                max={metadata.num_t}
                value={tTo}
                onChange={(e) => setTTo(Math.max(1, Math.min(metadata.num_t, Number(e.target.value))))}
                className="w-16 px-2 py-1 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-primary)] text-center focus:outline-none focus:border-[var(--accent)]"
              />
              <span className="text-[var(--text-secondary)]">({Math.abs(tTo - tFrom) + 1} frames)</span>
            </div>
          </Section>
        )}

        {/* Batch: target images */}
        {imageList.length > 1 && (
          <Section title="Batch Save">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] text-[var(--text-secondary)]">
                {selectedImages.size}/{imageList.length} images
              </span>
              <button onClick={selectAllImages} className="text-[10px] text-[var(--accent)] hover:underline">
                Select All
              </button>
            </div>
            <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
              {imageList.map((img) => {
                const zr = imageZRanges[img.id] ?? [1, img.num_z];
                const showZRange = (zMode === 'range' || zMode === 'projection') && img.num_z > 1 && selectedImages.has(img.id);
                const hasOwnSettings = img.id === activeId || !!imageViewStates[img.id];
                return (
                  <div key={img.id} className="px-2 py-1 rounded hover:bg-[var(--border)]/30">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedImages.has(img.id)}
                        onChange={() => toggleImage(img.id)}
                        className="accent-[var(--accent)]"
                      />
                      <span className="text-xs text-[var(--text-primary)] truncate flex-1">{img.filename}</span>
                      {!hasOwnSettings && (
                        <span
                          className="text-[10px] text-amber-400 shrink-0"
                          title="未表示の画像です。この画像自身のチャンネル色とコントラストで保存されます (コントラストは自動)"
                        >
                          auto
                        </span>
                      )}
                      <span className="text-[10px] text-[var(--text-secondary)]">
                        {img.num_z > 1 ? `Z:${img.num_z}` : ''}{img.num_z > 1 && img.num_t > 1 ? ' ' : ''}{img.num_t > 1 ? `T:${img.num_t}` : ''} {img.width}x{img.height}
                      </span>
                    </label>
                    {showZRange && (
                      <div className="flex items-center gap-2 text-[10px] ml-6 mt-1">
                        <span className="text-[var(--text-secondary)]">Z</span>
                        <input
                          type="number"
                          min={1}
                          max={img.num_z}
                          value={zr[0]}
                          onChange={(e) => setImageZFrom(img.id, Number(e.target.value), img.num_z)}
                          className="w-12 px-1 py-0.5 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-primary)] text-center text-[10px] focus:outline-none focus:border-[var(--accent)]"
                        />
                        <span className="text-[var(--text-secondary)]">–</span>
                        <input
                          type="number"
                          min={1}
                          max={img.num_z}
                          value={zr[1]}
                          onChange={(e) => setImageZTo(img.id, Number(e.target.value), img.num_z)}
                          className="w-12 px-1 py-0.5 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-primary)] text-center text-[10px] focus:outline-none focus:border-[var(--accent)]"
                        />
                        <span className="text-[var(--text-secondary)]">/ {img.num_z}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {/* Error / Success */}
        {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
        {successMsg && <p className="text-xs text-green-400 mt-2">{successMsg}</p>}
        {warnMsg && <p className="text-xs text-amber-400 mt-2">{warnMsg}</p>}

        {/* Actions */}
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded text-xs bg-[var(--border)] text-[var(--text-secondary)] hover:text-white transition"
          >
            Cancel
          </button>
          <button
            onClick={() => handleSave(false)}
            disabled={saving || !!conflict}
            className="px-4 py-2 rounded text-xs bg-[var(--accent)] text-white hover:opacity-90 transition disabled:opacity-50"
          >
            {saving ? `保存中 ${progress?.percent ?? 0}%` : '保存'}
          </button>
        </div>
        </fieldset>

        {saving && progress && (
          <div className="sticky bottom-0 z-20 mt-3 rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-3" aria-live="polite">
            <div className="mb-1 flex justify-between gap-3 text-xs">
              <span>{progress.label}</span>
              <span className="font-mono tabular-nums">{progress.percent}%</span>
            </div>
            <progress
              value={progress.percent}
              max={100}
              aria-label={`保存進捗 ${progress.percent}%`}
              className="h-2 w-full accent-[var(--accent)]"
            />
            <p className="mt-1 text-[10px] text-[var(--text-secondary)]">
              保存中は設定変更と画面を閉じる操作を停止しています。
            </p>
          </div>
        )}
      </div>

      {conflict && (
        <OverwriteConfirm
          conflict={conflict}
          busy={saving}
          onCancel={() => setConflict(null)}
          onConfirm={() => handleSave(true)}
        />
      )}
    </div>
  );
}

/**
 * Asks before replacing files. Nothing has been written at this point — the
 * backend checked every destination and stopped — so cancelling really does
 * leave the folder untouched.
 */
export function OverwriteConfirm({
  conflict, busy, onCancel, onConfirm,
}: {
  conflict: { files: string[]; count: number; more: number };
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6"
         onClick={onCancel}>
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg
                      p-5 w-[460px] shadow-2xl"
           onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-bold mb-2">同じ名前のファイルがあります</h3>
        <p className="text-xs text-[var(--text-secondary)] mb-3 leading-relaxed">
          {conflict.count} 個のファイルを<strong className="text-red-400">上書き</strong>します。
          元のファイルは戻せません。
        </p>
        <ul className="text-[11px] font-mono bg-[var(--bg-primary)] border border-[var(--border)]
                       rounded p-2 max-h-40 overflow-y-auto mb-4 space-y-0.5">
          {conflict.files.map((f) => <li key={f} className="truncate">{f}</li>)}
          {conflict.more > 0 && (
            <li className="text-[var(--text-secondary)]">ほか {conflict.more} 個</li>
          )}
        </ul>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded text-xs bg-[var(--border)] text-[var(--text-secondary)]
                       hover:text-white transition"
          >
            キャンセル
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="px-4 py-2 rounded text-xs bg-red-600 text-white hover:opacity-90
                       transition disabled:opacity-50"
          >
            {busy ? '上書き中…' : '上書きする'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h4 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">
        {title}
      </h4>
      {children}
    </div>
  );
}
