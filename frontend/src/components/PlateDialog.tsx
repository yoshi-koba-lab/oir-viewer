import { useState } from 'react';
import { chooseFolder, scanPlate, type PlateScan } from '../utils/api';
import { openAndReload } from '../hooks/useImageLoader';

/**
 * Reads an Olympus MATL acquisition and shows what it contains, in the plate's
 * own shape.
 *
 * This is the entry point for the plate workflow, and deliberately does nothing
 * but read: no volume is opened, so scanning eight 1 GB wells costs milliseconds.
 * Seeing the grid — which wells were acquired, which have a stitched file — is
 * what tells the user the folder was understood before anything expensive runs.
 *
 * The grid is the full plate from the XML, empty wells included, because that is
 * the layout the PDF will use. What is on screen here is what will be exported.
 */
export function PlateDialog({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [plate, setPlate] = useState<PlateScan | null>(null);
  /** Which wells the next action applies to. Selected = has a stitched file. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState('');

  const pick = async () => {
    setError('');
    setBusy(true);
    try {
      const picked = await chooseFolder();
      if (picked.cancelled || !picked.path) return;
      const p = await scanPlate(picked.path);
      setPlate(p);
      // Everything that can be loaded, pre-selected: that is what the user came
      // for, and unticking is easier than ticking eight boxes.
      setSelected(new Set(p.wells.filter((w) => w.enabled && w.stitch_path).map((w) => w.well_id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPlate(null);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  /**
   * Open the selected wells as ordinary image tabs, in plate order.
   *
   * One at a time and awaited: these are ~1 GB stitched volumes, and firing
   * eight opens at once is how the tab ran out of memory. Failures are collected
   * rather than aborting the run — one unreadable well should not hide the seven
   * that worked.
   */
  const openSelected = async () => {
    if (!plate) return;
    const targets = plate.wells.filter((w) => selected.has(w.well_id) && w.stitch_path);
    if (targets.length === 0) return;
    setError('');
    const failures: string[] = [];
    for (const [i, w] of targets.entries()) {
      setLoading(`${w.well_id} を読み込み中… (${i + 1}/${targets.length})`);
      try {
        await openAndReload(w.stitch_path!);
      } catch (e) {
        failures.push(`${w.well_id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    setLoading('');
    if (failures.length) setError(failures.join('\n'));
    else onClose();
  };

  const byPos = new Map(plate?.wells.map((w) => [`${w.row},${w.col}`, w]) ?? []);
  const rowLabel = (r: number) => String.fromCharCode(65 + r);
  const acquired = plate?.wells.filter((w) => w.enabled).length ?? 0;
  const ready = plate?.wells.filter((w) => w.enabled && w.stitch_path).length ?? 0;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
         onClick={onClose}>
      <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-xl shadow-2xl
                      p-5 max-w-3xl w-full max-h-[85vh] overflow-y-auto"
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">プレート（MATL 撮影）を読み込む</h2>
          <button onClick={onClose} className="text-[var(--text-secondary)] hover:text-white">✕</button>
        </div>

        {!plate && (
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed mb-4">
            MATL 撮影のフォルダを選んでください。<code>matl.omp2info</code> と
            <code>.oir</code> が入っているフォルダです。読み取りのみで、画像は開きません。
          </p>
        )}

        <button
          onClick={pick}
          disabled={busy}
          className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-xs font-medium
                     hover:opacity-90 disabled:opacity-50 transition"
        >
          {busy ? '読み込み中…' : plate ? '別のフォルダを選ぶ' : '撮影フォルダを選ぶ'}
        </button>

        {error && (
          <p className="text-xs text-red-400 mt-3 whitespace-pre-wrap select-text">{error}</p>
        )}

        {plate && (
          <div className="mt-4">
            <div className="text-xs mb-1">
              <span className="font-semibold">{plate.name}</span>
              <span className="text-[var(--text-secondary)]">
                {' '}— {plate.rows} 行 × {plate.cols} 列 / 取得 {acquired} ウェル
                （Stitch 済み {ready}）
              </span>
            </div>
            <div className="text-[10px] font-mono text-[var(--text-secondary)] mb-3 truncate"
                 title={plate.source}>
              {plate.source}
            </div>

            {plate.warnings.map((w, i) => (
              <p key={i} className="text-[11px] text-amber-400 mb-1 whitespace-pre-wrap select-text">
                ⚠ {w}
              </p>
            ))}

            {/* The plate's own shape, empty wells included — this is the PDF layout. */}
            <div className="inline-block mt-2">
              <div className="flex">
                <div className="w-6" />
                {Array.from({ length: plate.cols }, (_, c) => (
                  <div key={c} className="w-16 text-center text-[10px] text-[var(--text-secondary)]">
                    {String(c + 1).padStart(2, '0')}
                  </div>
                ))}
              </div>
              {Array.from({ length: plate.rows }, (_, r) => (
                <div key={r} className="flex">
                  <div className="w-6 flex items-center justify-center text-[10px] text-[var(--text-secondary)]">
                    {rowLabel(r)}
                  </div>
                  {Array.from({ length: plate.cols }, (_, c) => {
                    const w = byPos.get(`${r},${c}`);
                    const bad = w && w.enabled && !w.stitch_path;
                    const on = w ? selected.has(w.well_id) : false;
                    const selectable = !!w && w.enabled && !!w.stitch_path;
                    return (
                      <button
                        key={c}
                        type="button"
                        disabled={!selectable}
                        onClick={() => w && toggle(w.well_id)}
                        title={
                          w
                            ? `${w.well_id}\n${w.tile_grid} = ${w.tiles} タイル\n` +
                              (w.stitch_path
                                ? `Stitch: ${Math.round(w.stitch_bytes / 1048576)} MB` +
                                  (w.chunk_count ? ` + 続き ${w.chunk_count} 個` : '')
                                : 'Stitch ファイルなし') +
                              (w.position_warning ? `\n⚠ ${w.position_warning}` : '')
                            : '未取得'
                        }
                        className={`w-16 h-14 m-0.5 rounded border flex flex-col items-center justify-center
                          text-[10px] leading-tight transition ${
                            selectable ? 'cursor-pointer hover:brightness-125' : 'cursor-default'
                          } ${
                            !w
                              ? 'border-[var(--border)] text-[var(--text-secondary)]/40'
                              : bad
                              ? 'border-red-500 bg-red-500/15 text-red-300'
                              : !w.enabled
                              ? 'border-[var(--border)] text-[var(--text-secondary)]'
                              : on
                              ? 'border-[var(--accent)] bg-[var(--accent)]/30 ring-1 ring-[var(--accent)]'
                              : 'border-[var(--border)] text-[var(--text-secondary)]'
                          }`}
                      >
                        <span className="font-mono">{w ? w.well_id : `${rowLabel(r)}${String(c + 1).padStart(2, '0')}`}</span>
                        {w && (
                          <span className="text-[9px] opacity-70">
                            {!w.enabled ? '無効' : bad ? 'Stitch なし' : on ? '選択' : w.tile_grid}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="mt-4 pt-3 border-t border-[var(--border)]">
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  onClick={openSelected}
                  disabled={!!loading || selected.size === 0}
                  className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-xs font-medium
                             hover:opacity-90 disabled:opacity-40 transition"
                >
                  {loading || `選択した ${selected.size} ウェルを開く`}
                </button>
                <button
                  onClick={() =>
                    setSelected(
                      selected.size
                        ? new Set()
                        : new Set(plate.wells.filter((w) => w.enabled && w.stitch_path).map((w) => w.well_id)),
                    )
                  }
                  disabled={!!loading}
                  className="text-[11px] underline text-[var(--text-secondary)] hover:text-white disabled:opacity-40"
                >
                  {selected.size ? 'すべて解除' : 'すべて選択'}
                </button>
              </div>
              <p className="text-[10px] text-[var(--text-secondary)] mt-2 leading-relaxed">
                ウェルをクリックして選択します。1 ウェルずつ順番に開きます
                （Stitch は 1 ウェル約 1 GB のため、同時には開きません）。<br />
                空欄は未取得で、PDF でも空セルとしてこの位置に残ります。
                <span className="text-amber-400/80">3D → PDF の一括出力は次の実装です。</span>
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
