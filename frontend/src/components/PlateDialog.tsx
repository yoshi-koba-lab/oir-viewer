import { useEffect, useMemo, useState, useRef } from 'react';
import {
  chooseFolder, scanPlate, fetchPlateVolume, composePlatePdf,
  PLATE_XY_CHOICES, PDF_CELL_CHOICES,
} from '../utils/api';
import { openAndReload } from '../hooks/useImageLoader';
import { useImageStore } from '../stores/imageStore';
import { usePlateStore } from '../stores/plateStore';
import { PlateRenderer, parseVolume } from '../utils/plateRender';
import { collectOpenWells, snapshotOf } from '../utils/plateWells';
import { gpuLimits } from '../utils/gpuLimits';
import { OverwriteConflict } from '../utils/api';
import { filenameProblem } from '../utils/paths';
import { PlateTable } from './PlateTable';
import { OverwriteConfirm } from './SaveDialog';

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
  // The scan lives in the store, not here: the workflow is open the wells, close
  // this, tune each one in the viewer, then come back — and re-picking the
  // folder every time would make that unusable.
  const plate = usePlateStore((s) => s.scan);
  const setScan = usePlateStore((s) => s.setScan);
  const seed = usePlateStore((s) => s.seed);
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
  /** Name for the PDF. Empty falls back to the plate name plus a timestamp. */
  const [pdfName, setPdfName] = useState('');
  const [conflict, setConflict] = useState<
    { files: string[]; count: number; more: number } | null
  >(null);
  // Each well's own contrast and angle are what get baked in, so the table and
  // the export both have to re-read when the tabs or the active tab change.
  const imageList = useImageStore((s) => s.imageList);
  const activeImageId = useImageStore((s) => s.activeImageId);

  const pick = async () => {
    setError('');
    setBusy(true);
    try {
      const picked = await chooseFolder();
      if (picked.cancelled || !picked.path) return;
      const p = await scanPlate(picked.path);
      setScan(p, picked.path);
      // Everything that can be loaded, pre-selected: that is what the user came
      // for, and unticking is easier than ticking eight boxes.
      setSelected(new Set(p.wells.filter((w) => w.enabled && w.stitch_path).map((w) => w.well_id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setScan(null, '');
    } finally {
      setBusy(false);
    }
  };

  /**
   * The open wells, and their auto columns kept in step with the viewer.
   *
   * Recomputed on every render of the dialog rather than cached: the whole point
   * is that the table shows what each well is set to *now*, and the user has
   * just spent time changing exactly that. Reading settings is cheap — no pixels
   * are touched.
   */
  const openWells = useMemo(
    () => { useImageStore.getState().saveViewState(); return collectOpenWells(plate); },
    // imageList/activeImageId changing is what makes this stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plate, imageList, activeImageId],
  );

  useEffect(() => {
    if (openWells.length) seed(openWells.map((w) => snapshotOf(w, plate)));
  }, [openWells, plate, seed]);

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
  const exportPdf = async (overwrite = false) => {
    const scan = plate;
    if (!scan) return;
    // Flush the tab being looked at. Its settings live in the live store fields
    // until a switch writes them out, and that tab is the one most likely to
    // have just been adjusted — exporting it from a stale snapshot would drop
    // exactly the change the user came here to capture.
    useImageStore.getState().saveViewState();
    const wells = collectOpenWells(scan);

    if (wells.length === 0) {
      setError(
        '開いているウェルがありません。\n'
        + 'ウェルを選んで「選択したウェルを開く」で読み込み、3D ビューで各ウェルを'
        + '調整してから書き出してください。',
      );
      return;
    }
    const noPath = wells.filter((w) => !w.path);
    if (noPath.length) {
      setError(`このプレートに属さないウェルが開いています: ${noPath.map((w) => w.wellId).join(', ')}`);
      return;
    }
    const noCh = wells.filter((w) => w.channelIdx.length === 0);
    if (noCh.length) {
      setError(
        `表示中のチャンネルがないウェルがあります: ${noCh.map((w) => w.wellId).join(', ')}\n`
        + '各ウェルでチャンネルを 1 つ以上表示してください。',
      );
      return;
    }

    // Clamp to what this GPU can hold BEFORE asking for it. A 3D texture is
    // driver-capped — 2048 under ANGLE, which is every Windows build — and the
    // real data is 2911 wide, so "Max (原寸)" would stream ~1.7 GB per well and
    // only then be refused at texImage3D, throwing away the whole export after
    // minutes of work. Clamping only ever scales down: on a GPU that reports
    // 16384 a 2911 px well still comes back untouched.
    const { max3D, vendor } = gpuLimits();
    if (max3D === 0) {
      setError('この環境では WebGL2 が使えないため、3D の書き出しができません。');
      return;
    }
    const wanted = PLATE_XY_CHOICES.find((c) => c.key === volKey)!.maxXy;
    const maxXy = wanted === 0 ? max3D : Math.min(wanted, max3D);
    const clamped = maxXy !== wanted;

    setError(''); setResult(''); cancelRef.current = false; setExporting(true);
    const cellPx = PDF_CELL_CHOICES.find((c) => c.key === cellKey)!.px;
    const frames: {
      well_id: string; row: number; col: number; png_b64: string; caption: string[];
    }[] = [];
    let renderer: PlateRenderer | null = null;

    const { columns, cells } = usePlateStore.getState();
    const figureCols = columns.filter((c) => c.onFigure);

    try {
      const dir = await chooseFolder();
      if (dir.cancelled || !dir.path) return;

      // Rendered at the cell's own size. Capping it below cell_px would make the
      // larger choices produce a bigger page holding the same image, i.e. Max
      // would letterbox less detail than High — the opposite of what it says.
      // Constructed inside the try so a machine without WebGL2 reports that
      // rather than throwing an unhandled rejection into the console.
      renderer = new PlateRenderer(cellPx);

      for (const [i, w] of wells.entries()) {
        if (cancelRef.current) { setResult('中止しました。PDF は作成していません。'); return; }
        setProgress(`${w.wellId} (${i + 1}/${wells.length}) 読み込み中…`);
        abortRef.current = new AbortController();
        // Each well carries its own contrast and channel choice — that is the
        // point of tuning them one at a time — so the window baked in here is
        // this well's, not a global one.
        const buf = await fetchPlateVolume({
          path: w.path!,
          channels: w.channelIdx,
          levels: w.levels,
          max_xy: maxXy,
        }, abortRef.current.signal);
        setProgress(`${w.wellId} (${i + 1}/${wells.length}) 描画中…`);
        const vol = parseVolume(buf.data, buf.info ?? undefined);
        const shot = await renderer.render(
          w.wellId, vol, w.colors, w.channelIdx.map(() => true),
          w.view.az, w.view.el, w.view.radius, w.zFrac,
        );
        let bin = '';
        for (let k = 0; k < shot.png.length; k += 0x8000) {
          bin += String.fromCharCode(...shot.png.subarray(k, k + 0x8000));
        }
        frames.push({
          well_id: w.wellId, row: w.row, col: w.col, png_b64: btoa(bin),
          caption: figureCols
            .map((c) => (cells[w.wellId]?.[c.key] ?? '').trim())
            .filter(Boolean),
        });
      }

      setProgress('PDF を作成中…');
      // Why each empty cell is empty. Marking them all "not acquired" would print
      // a false statement over a well the microscope did image — a reader of the
      // figure has no way to tell that apart from a genuinely empty position.
      const states: Record<string, string> = {};
      const rendered = new Set(wells.map((w) => w.wellId));
      for (const w of scan.wells) {
        if (rendered.has(w.well_id)) continue;      // has a frame; state unused
        states[w.well_id] = !w.enabled ? 'disabled'
          : !w.stitch_path ? 'missing'
          : 'excluded';
      }
      const res = await composePlatePdf({
        plate_name: scan.name, rows: scan.rows, cols: scan.cols,
        frames, well_states: states, cell_px: cellPx, output_dir: dir.path,
        filename: pdfName.trim(),
        overwrite,
        table_headers: columns.map((c) => c.label),
        table_rows: wells.map((w) => columns.map((c) => cells[w.wellId]?.[c.key] ?? '')),
        // The resolution actually applied, never the one requested. Recording the
        // request is how the footer came to state a resolution that was not used.
        footer: `matl ${scan.matl_sha256.slice(0, 8)} | vol ${volKey}(${maxXy})`
              + `${clamped ? ` GPU上限${max3D}に制限` : ''}`
              + ` | cell ${cellPx}px | ${wells.length} wells | ${new Date().toISOString()}`,
      });
      setResult(
        `${res.wells} ウェルを書き出しました（${Math.round(res.bytes / 1024)} KB）\n${res.path}`
        + (clamped
          ? `\n※ 解像度は この GPU の上限 ${max3D} px に制限しました（${vendor}）。`
          : ''),
      );
    } catch (e) {
      // A cancel aborts the fetch, which surfaces here as an AbortError. That is
      // the user's own action, not a failure to report as one.
      if (cancelRef.current) setResult('中止しました。PDF は作成していません。');
      // Nothing was written; ask before replacing. The wells are already
      // rendered, so confirming does not repeat the expensive part... it does,
      // in fact, and that is the honest trade: keeping every frame in memory to
      // avoid it is what makes a 24-well export run out of room.
      else if (e instanceof OverwriteConflict) {
        setConflict({ files: e.files, count: e.count, more: e.more });
      } else setError(e instanceof Error ? e.message : String(e));
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
    <>
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

              {/* Conditions table, then export */}
              <div className="mt-4 pt-3 border-t border-[var(--border)]">
                <div className="flex items-baseline justify-between mb-2 gap-2 flex-wrap">
                  <h3 className="text-xs font-semibold">
                    条件表（開いている {openWells.length} ウェル）
                  </h3>
                  <button
                    onClick={() => seed(openWells.map((w) => snapshotOf(w, plate)), true)}
                    disabled={openWells.length === 0 || exporting}
                    title="自動列を現在のビューアの設定で埋め直します（手で直した値も上書きします）"
                    className="text-[10px] underline text-[var(--text-secondary)]
                               hover:text-white disabled:opacity-40"
                  >
                    自動列を現在の設定で更新
                  </button>
                </div>
                <PlateTable wells={openWells} />
                <p className="text-[10px] text-[var(--text-secondary)] mt-2 leading-relaxed">
                  各ウェルは <strong>開いたタブの現在の状態</strong>（チャンネル・Min/Max・色・角度・Z 範囲）
                  で書き出します。3D ビューで調整してからここに戻ってきてください。
                  角度と Z 範囲はウェルごとに記憶されます。
                </p>
              </div>

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
                  <label className="text-[10px] text-[var(--text-secondary)] flex-1 min-w-[12rem]">
                    ファイル名（省略時はプレート名＋日時）
                    <input
                      type="text"
                      value={pdfName}
                      onChange={(e) => { setPdfName(e.target.value); setConflict(null); }}
                      disabled={exporting}
                      placeholder={plate.name}
                      className="block w-full mt-1 bg-[var(--bg-primary)] border border-[var(--border)]
                                 rounded px-2 py-1 text-xs text-[var(--text-primary)]
                                 placeholder:text-[var(--text-secondary)]"
                    />
                  </label>
                  <button
                    onClick={() => exportPdf(false)}
                    disabled={exporting || !!loading || openWells.length === 0 || !!conflict
                              || !!(pdfName.trim() && filenameProblem(pdfName))}
                    className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-medium
                               hover:opacity-90 disabled:opacity-40 transition"
                  >
                    {progress || `3D → PDF を作成（${openWells.length} ウェル）`}
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

      {conflict && (
        <OverwriteConfirm
          conflict={conflict}
          busy={exporting}
          onCancel={() => setConflict(null)}
          onConfirm={() => exportPdf(true)}
        />
      )}
    </>
  );
}
