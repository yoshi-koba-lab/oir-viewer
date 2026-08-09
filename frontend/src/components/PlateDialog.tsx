import { useEffect, useMemo, useState, useRef } from 'react';
import {
  chooseFolder, scanPlate, fetchPlateVolume, composePlatePdf,
  checkPlatePdfTarget, PLATE_XY_CHOICES, PDF_CELL_CHOICES,
} from '../utils/api';
import { openAndReload } from '../hooks/useImageLoader';
import { useImageStore } from '../stores/imageStore';
import { usePlateStore } from '../stores/plateStore';
import { PlateRenderer, parseVolume } from '../utils/plateRender';
import { collectOpenWells, mismatchedPlateTabs, snapshotOf } from '../utils/plateWells';
import { gpuLimits } from '../utils/gpuLimits';
import { OverwriteConflict } from '../utils/api';
import { basenameOf, filenameProblem } from '../utils/paths';
import { PlateTable } from './PlateTable';
import { OverwriteConfirm } from './SaveDialog';

function pdfInputStem(name: string): string {
  return name.trim().replace(/\.pdf$/i, '');
}

function pdfInputProblem(name: string): string {
  return name.trim() ? filenameProblem(pdfInputStem(name)) : '';
}

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
  /** The final POST cannot be cancelled once the backend starts publishing. */
  const [finalizingPdf, setFinalizingPdf] = useState(false);
  const finalizingPdfRef = useRef(false);
  /** Synchronous guard: React state alone cannot stop a same-tick double click. */
  const activePdfRun = useRef(0);
  /** Invalidates a preflight whose target changed or whose dialog was closed. */
  const pdfRunSeq = useRef(0);
  /** Name for the PDF. Empty falls back to the plate name plus a timestamp. */
  const [pdfName, setPdfName] = useState('');
  /** Kept on screen so the name can be checked before any well is rendered. */
  const [pdfOutputDir, setPdfOutputDir] = useState('');
  const [pdfBrowsing, setPdfBrowsing] = useState(false);
  const [checkingPdfName, setCheckingPdfName] = useState(false);
  const [nameConflict, setNameConflict] = useState<
    { files: string[]; count: number; more: number } | null
  >(null);
  type PdfJob = { outputDir: string; filename: string; expectedRevision?: string };
  /** The exact path the user approved; confirmation never opens a second picker. */
  const [pendingJob, setPendingJob] = useState<PdfJob | null>(null);
  /** Invalidates an older asynchronous name check after the field changes. */
  const pdfCheckSeq = useRef(0);
  const [conflict, setConflict] = useState<
    { files: string[]; count: number; more: number } | null
  >(null);
  // Each well's own contrast and angle are what get baked in, so the table and
  // the export both have to re-read when the tabs or the active tab change.
  const imageList = useImageStore((s) => s.imageList);
  const activeImageId = useImageStore((s) => s.activeImageId);

  const pick = async () => {
    if (activePdfRun.current) return;
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
  // No saveViewState here: collectOpenWells reads the ACTIVE tab from the live
  // store fields, so nothing needs flushing to render the table — and writing
  // to the store during render is the kind of side effect React is allowed to
  // punish at any time. exportPdf still flushes, because the export reads
  // imageViewStates for inactive tabs at a moment of its own choosing.
  const openWells = useMemo(
    () => collectOpenWells(plate),
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

  const invalidatePdfTarget = () => {
    pdfCheckSeq.current += 1;
    pdfRunSeq.current += 1;
    setCheckingPdfName(false);
    setNameConflict(null);
    setConflict(null);
    setPendingJob(null);
  };

  /** Check a typed name when focus leaves it; the export repeats this check. */
  const probePdfTarget = async (dir = pdfOutputDir) => {
    const scan = plate;
    const name = pdfInputStem(pdfName);
    if (!scan || !dir.trim() || !pdfName.trim() || pdfInputProblem(pdfName)) return;
    const seq = ++pdfCheckSeq.current;
    setCheckingPdfName(true);
    try {
      await checkPlatePdfTarget({
        plate_name: scan.name, output_dir: dir.trim(), filename: name,
      });
      if (seq === pdfCheckSeq.current) setNameConflict(null);
    } catch (e) {
      if (seq !== pdfCheckSeq.current) return;
      if (e instanceof OverwriteConflict) {
        setNameConflict({ files: e.files, count: e.count, more: e.more });
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (seq === pdfCheckSeq.current) setCheckingPdfName(false);
    }
  };

  const browsePdfOutput = async () => {
    setPdfBrowsing(true);
    try {
      const picked = await chooseFolder();
      if (picked.cancelled || !picked.path) return;
      invalidatePdfTarget();
      setPdfOutputDir(picked.path);
      await probePdfTarget(picked.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPdfBrowsing(false);
    }
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
  const exportPdf = async (overwrite = false, approvedJob: PdfJob | null = null) => {
    const scan = plate;
    if (!scan) return;
    // Flush the tab being looked at. Its settings live in the live store fields
    // until a switch writes them out, and that tab is the one most likely to
    // have just been adjusted — exporting it from a stale snapshot would drop
    // exactly the change the user came here to capture.
    useImageStore.getState().saveViewState();
    const wells = collectOpenWells(scan);
    const mismatched = mismatchedPlateTabs(scan);

    if (mismatched.length) {
      setError(
        `別のプレート、または変更前のファイルから開いた同名ウェルがあります: ${mismatched.join(', ')}\n`
        + 'そのタブを閉じ、このプレートのウェルを開き直してください。PDF は作成していません。',
      );
      return;
    }

    if (wells.length === 0) {
      setError(
        '開いているウェルがありません。\n'
        + 'ウェルを選んで「選択したウェルを開く」で読み込み、3D ビューで各ウェルを'
        + '調整してから書き出してください。',
      );
      return;
    }
    const wellCounts = new Map<string, number>();
    for (const w of wells) wellCounts.set(w.wellId, (wellCounts.get(w.wellId) ?? 0) + 1);
    const duplicateWells = [...wellCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([wellId]) => wellId);
    if (duplicateWells.length) {
      setError(
        `同じウェルが複数のタブで開かれています: ${duplicateWells.join(', ')}\n`
        + 'どちらを図に使うか曖昧なため、重複するタブを閉じてください。',
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
    const outsideInteractive3D = wells.filter(
      (w) => w.channelIdx.some((channel) => channel >= 4),
    );
    if (outsideInteractive3D.length) {
      setError(
        `3D 画面に読み込まれていない5番目以降のチャンネルが選ばれています: ${
          outsideInteractive3D.map((w) => w.wellId).join(', ')}\n`
        + 'PDF と画面が異なる図になるため作成しません。先頭4チャンネル内で表示を調整してください。',
      );
      return;
    }

    // Freeze the conditions at the same instant as the well views. The table
    // remains useful to inspect while a slow preflight runs, but later edits
    // must not be mixed into the already-snapshotted images.
    const tableState = usePlateStore.getState();
    const columns = tableState.columns.map((column) => ({ ...column }));
    const cells = Object.fromEntries(
      Object.entries(tableState.cells).map(([wellId, row]) => [wellId, { ...row }]),
    );
    if (columns.length > 64
      || columns.some((column) => column.label.length > 1000)
      || wells.some((well) => columns.some((column) => (
        (cells[well.wellId]?.[column.key] ?? '').length > (column.onFigure ? 1000 : 5000)
      )))
      || columns.filter((column) => column.onFigure).length > 20) {
      setError('条件表または図中キャプションが長すぎます。列数・文字数を減らしてください。');
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

    let job = approvedJob;
    const outputDir = job?.outputDir ?? pdfOutputDir.trim();
    const typedName = job?.filename ?? pdfInputStem(pdfName);
    if (!outputDir) {
      setError('PDF の保存先フォルダを選んでください。');
      return;
    }
    if (!job && pdfInputProblem(pdfName)) {
      setError(pdfInputProblem(pdfName));
      return;
    }

    // Claim the run synchronously before the first await. Otherwise a slow
    // external drive leaves a window where a second click can start another
    // eight-well render, or closing the dialog can orphan the first one.
    if (activePdfRun.current) return;
    const runId = ++pdfRunSeq.current;
    activePdfRun.current = runId;
    cancelRef.current = false;
    setError('');
    setResult('');
    setExporting(true);

    const releaseRun = () => {
      if (activePdfRun.current !== runId) return;
      activePdfRun.current = 0;
      setProgress('');
      setExporting(false);
    };

    if (!job) {
      setProgress('PDF 名を確認中…');
      try {
        const checked = await checkPlatePdfTarget({
          plate_name: scan.name, output_dir: outputDir, filename: typedName,
        });
        if (pdfRunSeq.current !== runId || cancelRef.current) {
          releaseRun();
          return;
        }
        job = {
          outputDir, filename: checked.filename, expectedRevision: checked.revision,
        };
        setNameConflict(null);
      } catch (e) {
        if (pdfRunSeq.current === runId && !cancelRef.current) {
          if (e instanceof OverwriteConflict) {
            const resolved = typedName
              || (basenameOf(e.files[0] ?? '').replace(/\.pdf$/i, '') || 'plate');
            const blockedJob = {
              outputDir, filename: resolved,
              expectedRevision: Object.values(e.revisions)[0],
            };
            setPendingJob(blockedJob);
            setNameConflict({ files: e.files, count: e.count, more: e.more });
            setConflict({ files: e.files, count: e.count, more: e.more });
          } else {
            setError(e instanceof Error ? e.message : String(e));
          }
        }
        releaseRun();
        return;
      }
    }

    // A confirmed preflight starts the long render with the progress UI visible,
    // not hidden behind the confirmation dialog for the next several minutes.
    if (approvedJob) {
      setConflict(null);
      setPendingJob(null);
      setNameConflict(null);
    }

    setProgress('');
    const cellPx = PDF_CELL_CHOICES.find((c) => c.key === cellKey)!.px;
    if (scan.rows * scan.cols * cellPx * cellPx > 250_000_000) {
      setError('このプレートサイズではセル解像度が大きすぎます。1段階下げてください。');
      releaseRun();
      return;
    }
    const frames: {
      well_id: string; row: number; col: number; png_b64: string; caption: string[];
      source_path: string; source_identity: string; source_revision: string;
    }[] = [];
    let renderer: PlateRenderer | null = null;

    const figureCols = columns.filter((c) => c.onFigure);
    const runCancelled = () => cancelRef.current || pdfRunSeq.current !== runId;

    try {
      // Rendered at the cell's own size. Capping it below cell_px would make the
      // larger choices produce a bigger page holding the same image, i.e. Max
      // would letterbox less detail than High — the opposite of what it says.
      // Constructed inside the try so a machine without WebGL2 reports that
      // rather than throwing an unhandled rejection into the console.
      renderer = new PlateRenderer(cellPx);

      for (const [i, w] of wells.entries()) {
        if (runCancelled()) { setResult('中止しました。PDF は作成していません。'); return; }
        setProgress(`${w.wellId} (${i + 1}/${wells.length}) 読み込み中…`);
        abortRef.current = new AbortController();
        // Each well carries its own contrast and channel choice — that is the
        // point of tuning them one at a time — so the window baked in here is
        // this well's, not a global one.
        const buf = await fetchPlateVolume({
          path: w.path!,
          source_identity: w.sourceIdentity,
          source_revision: w.sourceRevision,
          channels: w.channelIdx,
          levels: w.levels,
          t: w.t,
          max_xy: maxXy,
        }, abortRef.current.signal);
        if (runCancelled()) { setResult('中止しました。PDF は作成していません。'); return; }
        setProgress(`${w.wellId} (${i + 1}/${wells.length}) 描画中…`);
        const vol = parseVolume(buf.data, buf.info);
        const shot = await renderer.render(
          w.wellId, vol, w.colors, w.channelIdx.map(() => true),
          w.view.az, w.view.el, w.view.radius, w.zFrac,
        );
        if (runCancelled()) { setResult('中止しました。PDF は作成していません。'); return; }
        let bin = '';
        for (let k = 0; k < shot.png.length; k += 0x8000) {
          bin += String.fromCharCode(...shot.png.subarray(k, k + 0x8000));
        }
        frames.push({
          well_id: w.wellId, row: w.row, col: w.col, png_b64: btoa(bin),
          source_path: w.path!,
          source_identity: buf.info.source_identity,
          source_revision: buf.info.source_revision,
          caption: figureCols
            .map((c) => (cells[w.wellId]?.[c.key] ?? '').trim())
            .filter(Boolean)
            .concat(w.numT > 1 ? [`T${w.t + 1}`] : []),
        });
      }

      if (runCancelled()) { setResult('中止しました。PDF は作成していません。'); return; }
      finalizingPdfRef.current = true;
      setFinalizingPdf(true);
      setProgress('PDF を作成中…（この段階は中止できません）');
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
        frames, well_states: states, cell_px: cellPx, output_dir: job.outputDir,
        filename: job.filename,
        overwrite,
        expected_revision: job.expectedRevision,
        table_headers: columns.map((c) => c.label),
        table_rows: columns.length
          ? wells.map((w) => columns.map((c) => cells[w.wellId]?.[c.key] ?? ''))
          : [],
        // The resolution actually applied, never the one requested. Recording the
        // request is how the footer came to state a resolution that was not used.
        footer: `matl ${scan.matl_sha256.slice(0, 8)} | vol ${volKey}(${maxXy})`
              + `${clamped ? ` GPU上限${max3D}に制限` : ''}`
              + `${wells.some((w) => w.numT > 1)
                ? ` | T ${wells.map((w) => `${w.wellId}:${w.t + 1}`).join(',')}` : ''}`
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
      if (runCancelled()) setResult('中止しました。PDF は作成していません。');
      // Nothing was written; ask before replacing. The wells are already
      // rendered, so confirming does not repeat the expensive part... it does,
      // in fact, and that is the honest trade: keeping every frame in memory to
      // avoid it is what makes a 24-well export run out of room.
      else if (e instanceof OverwriteConflict) {
        setPendingJob({ ...job, expectedRevision: Object.values(e.revisions)[0] });
        setNameConflict({ files: e.files, count: e.count, more: e.more });
        setConflict({ files: e.files, count: e.count, more: e.more });
      } else setError(e instanceof Error ? e.message : String(e));
    } finally {
      abortRef.current = null;
      renderer?.dispose();
      finalizingPdfRef.current = false;
      setFinalizingPdf(false);
      releaseRun();
    }
  };

  /** Stop the run: the flag ends the loop, the abort ends the current well. */
  const cancelExport = () => {
    if (finalizingPdfRef.current) return;
    cancelRef.current = true;
    pdfRunSeq.current += 1;
    abortRef.current?.abort();
    setProgress('中止しています…');
  };

  /**
   * Closing mid-export would unmount the dialog while the loop kept running,
   * writing a PDF nothing on screen is waiting for. Stop the run instead.
   */
  const requestClose = () => {
    if (!activePdfRun.current) { onClose(); return; }
    if (finalizingPdfRef.current) return;
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
          disabled={busy || exporting}
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
                  <label className="text-[10px] text-[var(--text-secondary)] flex-1 min-w-[15rem]">
                    PDF の保存先
                    <div className="flex gap-1 mt-1">
                      <input
                        type="text"
                        value={pdfOutputDir}
                        onChange={(e) => {
                          setPdfOutputDir(e.target.value);
                          invalidatePdfTarget();
                        }}
                        onBlur={() => { void probePdfTarget(); }}
                        disabled={exporting}
                        placeholder="保存先フォルダ"
                        className="min-w-0 flex-1 bg-[var(--bg-primary)] border border-[var(--border)]
                                   rounded px-2 py-1 text-xs text-[var(--text-primary)]
                                   placeholder:text-[var(--text-secondary)]"
                      />
                      <button
                        type="button"
                        onClick={browsePdfOutput}
                        disabled={exporting || pdfBrowsing}
                        className="px-2 py-1 rounded bg-[var(--border)] text-[10px]
                                   text-[var(--text-secondary)] hover:text-white disabled:opacity-40"
                      >
                        {pdfBrowsing ? '…' : '選択'}
                      </button>
                    </div>
                  </label>
                  <label className="text-[10px] text-[var(--text-secondary)] flex-1 min-w-[12rem]">
                    ファイル名（省略時はプレート名＋日時）
                    <input
                      type="text"
                      value={pdfName}
                      onChange={(e) => {
                        setPdfName(e.target.value);
                        invalidatePdfTarget();
                      }}
                      onBlur={() => { void probePdfTarget(); }}
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
                              || !pdfOutputDir.trim()
                              || !!pdfInputProblem(pdfName)}
                    className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-medium
                               hover:opacity-90 disabled:opacity-40 transition"
                  >
                    {progress || `3D → PDF を作成（${openWells.length} ウェル）`}
                  </button>
                  {exporting && (
                    <button
                      onClick={cancelExport}
                      disabled={cancelRef.current || finalizingPdf}
                      className="text-[11px] underline text-[var(--text-secondary)]
                                 hover:text-white disabled:opacity-40"
                    >
                      {finalizingPdf ? 'PDF 保存中' : '中止'}
                    </button>
                  )}
                </div>
                {pdfInputProblem(pdfName) ? (
                  <p className="text-[10px] text-red-400 mt-1">{pdfInputProblem(pdfName)}</p>
                ) : checkingPdfName ? (
                  <p className="text-[10px] text-[var(--text-secondary)] mt-1">同名ファイルを確認中…</p>
                ) : nameConflict ? (
                  <p className="text-[10px] text-amber-400 mt-1">
                    {nameConflict.files[0]} は既にあります。作成前に上書きを確認します。
                  </p>
                ) : null}
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
          onCancel={() => { setConflict(null); setPendingJob(null); }}
          onConfirm={() => pendingJob && exportPdf(true, pendingJob)}
        />
      )}
    </>
  );
}
