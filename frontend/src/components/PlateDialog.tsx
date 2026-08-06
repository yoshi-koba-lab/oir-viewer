import { useState, useRef } from 'react';
import {
  chooseFolder, scanPlate, fetchPlateVolume, composePlatePdf,
  PLATE_XY_CHOICES, PDF_CELL_CHOICES, type PlateScan,
} from '../utils/api';
import { openAndReload } from '../hooks/useImageLoader';
import { useImageStore } from '../stores/imageStore';
import { PlateRenderer, parseVolume } from '../utils/plateRender';

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
  const [volKey, setVolKey] = useState('low');
  const [cellKey, setCellKey] = useState('normal');
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState('');
  /** Set while a run is going, so it can be stopped between wells. */
  const cancelRef = useRef(false);
  /**
   * Aborts the in-flight well read. Checking a flag between wells is not enough:
   * one well of real data is a multi-minute request, and that is the whole span
   * the stop button exists to interrupt.
   */
  const abortRef = useRef<AbortController | null>(null);
  /** True from the moment an export starts until it has finished or failed. */
  const [exporting, setExporting] = useState(false);
  //  The contrast to bake in comes from the channels the user has on screen.
  //  Plate export never computes its own: that is the whole point of the setting.
  const channels = useImageStore((s) => s.channels);

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

  /**
   * Render every selected well and write one PDF.
   *
   * Strictly one well at a time, and the previous well's textures are disposed
   * before the next upload: eight volumes held at once is how this fails on the
   * last well, and GPU memory is not reclaimed on any schedule worth relying on.
   *
   * All or nothing. A well that was acquired but could not be rendered would
   * appear in the PDF as an empty cell — indistinguishable from a well nobody
   * imaged — so the first failure aborts and nothing is written.
   */
  const exportPdf = async () => {
    if (!plate) return;
    const targets = plate.wells.filter((w) => selected.has(w.well_id) && w.stitch_path);
    if (targets.length === 0) return;

    // The contrast, colours and channel choice are taken from the image on
    // screen, so there has to be one. Without this the run fails later with
    // "no visible channels", which reads as a problem with the plate.
    if (channels.length === 0) {
      setError(
        'コントラストの基準にする画像がありません。\n'
        + 'まず代表的なウェルを 1 つ開き、チャンネルの表示・色・Min/Max を決めてから'
        + '書き出してください。その設定が全ウェルに焼き込まれます。',
      );
      return;
    }
    const visible = channels.map((c) => c.visible);
    const chIdx = channels.map((_, i) => i).filter((i) => visible[i]).slice(0, 4);
    if (chIdx.length === 0) {
      setError('表示中のチャンネルがありません。チャンネルを 1 つ以上表示してください。');
      return;
    }

    setError(''); setResult(''); cancelRef.current = false; setExporting(true);
    const maxXy = PLATE_XY_CHOICES.find((c) => c.key === volKey)!.maxXy;
    const cellPx = PDF_CELL_CHOICES.find((c) => c.key === cellKey)!.px;
    const frames: { well_id: string; row: number; col: number; png_b64: string }[] = [];
    let renderer: PlateRenderer | null = null;

    try {
      const dir = await chooseFolder();
      if (dir.cancelled || !dir.path) return;

      // Rendered at the cell's own size. Capping it below cell_px would make the
      // larger choices produce a bigger page holding the same image, i.e. Max
      // would letterbox less detail than High — the opposite of what it says.
      // Constructed inside the try so a machine without WebGL2 reports that
      // rather than throwing an unhandled rejection into the console.
      renderer = new PlateRenderer(cellPx);

      for (const [i, w] of targets.entries()) {
        if (cancelRef.current) { setResult('中止しました。PDF は作成していません。'); return; }
        setProgress(`${w.well_id} (${i + 1}/${targets.length}) 読み込み中…`);
        abortRef.current = new AbortController();
        const buf = await fetchPlateVolume({
          path: w.stitch_path!,
          channels: chIdx,
          levels: chIdx.map((c) => [channels[c].min, channels[c].max] as [number, number]),
          max_xy: maxXy,
        }, abortRef.current.signal);
        setProgress(`${w.well_id} (${i + 1}/${targets.length}) 描画中…`);
        const vol = parseVolume(buf);
        const shot = await renderer.render(
          w.well_id, vol,
          chIdx.map((c) => channels[c].color),
          chIdx.map(() => true),
          25, 20, 2.5, [0, 1],
        );
        let bin = '';
        for (let k = 0; k < shot.png.length; k += 0x8000) {
          bin += String.fromCharCode(...shot.png.subarray(k, k + 0x8000));
        }
        frames.push({ well_id: w.well_id, row: w.row, col: w.col, png_b64: btoa(bin) });
      }

      setProgress('PDF を作成中…');
      // Why each empty cell is empty. Marking them all "not acquired" would print
      // a false statement over a well the microscope did image — a reader of the
      // figure has no way to tell that apart from a genuinely empty position.
      const states: Record<string, string> = {};
      const rendered = new Set(targets.map((w) => w.well_id));
      for (const w of plate.wells) {
        if (rendered.has(w.well_id)) continue;      // has a frame; state unused
        states[w.well_id] = !w.enabled ? 'disabled'
          : !w.stitch_path ? 'missing'
          : 'excluded';
      }
      const res = await composePlatePdf({
        plate_name: plate.name, rows: plate.rows, cols: plate.cols,
        frames, well_states: states, cell_px: cellPx, output_dir: dir.path,
        footer: `matl ${plate.matl_sha256.slice(0, 8)} | vol ${volKey}(${maxXy || 'src'}) `
              + `| cell ${cellPx}px | ch ${chIdx.join(',')} | ${new Date().toISOString()}`,
      });
      setResult(`${res.wells} ウェルを書き出しました（${Math.round(res.bytes / 1024)} KB）\n${res.path}`);
    } catch (e) {
      // A cancel aborts the fetch, which surfaces here as an AbortError. That is
      // the user's own action, not a failure to report as one.
      if (cancelRef.current) setResult('中止しました。PDF は作成していません。');
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      abortRef.current = null;
      renderer?.dispose();
      setProgress('');
      setExporting(false);
    }
  };

  /** Stop the run: the flag ends the loop, the abort ends the current well. */
  const cancelExport = () => {
    cancelRef.current = true;
    abortRef.current?.abort();
    setProgress('中止しています…');
  };

  /**
   * Closing mid-export would unmount the dialog while the loop kept running,
   * writing a PDF nothing on screen is waiting for. Stop the run instead.
   */
  const requestClose = () => {
    if (!exporting) { onClose(); return; }
    cancelExport();
  };

  const byPos = new Map(plate?.wells.map((w) => [`${w.row},${w.col}`, w]) ?? []);
  const rowLabel = (r: number) => String.fromCharCode(65 + r);
  const acquired = plate?.wells.filter((w) => w.enabled).length ?? 0;
  const ready = plate?.wells.filter((w) => w.enabled && w.stitch_path).length ?? 0;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
         onClick={requestClose}>
      <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-xl shadow-2xl
                      p-5 max-w-3xl w-full max-h-[85vh] overflow-y-auto"
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">プレート（MATL 撮影）を読み込む</h2>
          <button onClick={requestClose} className="text-[var(--text-secondary)] hover:text-white"
                  title={exporting ? '書き出しを中止します' : '閉じる'}>✕</button>
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
                  // Opening closes the dialog on success, which mid-export would
                  // leave the run with nothing to report back to.
                  disabled={!!loading || exporting || selected.size === 0}
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
                ウェルをクリックして選択します。1 ウェルずつ順番に処理します
                （Stitch は 1 ウェル約 1 GB のため、同時には扱いません）。
                空欄は未取得で、PDF でも空セルとしてこの位置に残ります。
              </p>

              {/* 3D -> PDF */}
              <div className="mt-4 pt-3 border-t border-[var(--border)]">
                <div className="flex items-end gap-3 flex-wrap">
                  <label className="text-[10px] text-[var(--text-secondary)]">
                    ボリューム解像度
                    <select
                      value={volKey}
                      onChange={(e) => setVolKey(e.target.value)}
                      disabled={!!progress}
                      className="block mt-1 bg-[var(--bg-primary)] border border-[var(--border)]
                                 rounded px-2 py-1 text-xs text-[var(--text-primary)]"
                    >
                      {PLATE_XY_CHOICES.map((c) => (
                        <option key={c.key} value={c.key}>{c.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-[10px] text-[var(--text-secondary)]">
                    PDF の画像解像度
                    <select
                      value={cellKey}
                      onChange={(e) => setCellKey(e.target.value)}
                      disabled={!!progress}
                      className="block mt-1 bg-[var(--bg-primary)] border border-[var(--border)]
                                 rounded px-2 py-1 text-xs text-[var(--text-primary)]"
                    >
                      {PDF_CELL_CHOICES.map((c) => (
                        <option key={c.key} value={c.key}>{c.label}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    onClick={exportPdf}
                    disabled={exporting || !!loading || selected.size === 0}
                    className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-medium
                               hover:opacity-90 disabled:opacity-40 transition"
                  >
                    {progress || `3D → PDF を作成（${selected.size} ウェル）`}
                  </button>
                  {exporting && (
                    <button
                      onClick={cancelExport}
                      disabled={cancelRef.current}
                      className="text-[11px] underline text-[var(--text-secondary)]
                                 hover:text-white disabled:opacity-40"
                    >
                      中止
                    </button>
                  )}
                </div>
                <p className="text-[10px] text-[var(--text-secondary)] mt-2 leading-relaxed">
                  コントラストは<strong>いま画面で設定されている Min/Max と色</strong>をそのまま
                  焼き込みます（ウェルごとの自動調整はしません）。表示中のチャンネルのみ、最大 4 つ。<br />
                  1 ウェルでも描画に失敗したら PDF は作りません
                  （取得済みのウェルが空セルに見えるのを避けるため）。
                </p>
                {result && (
                  <p className="text-[11px] text-emerald-400 mt-2 whitespace-pre-wrap select-text">
                    {result}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
