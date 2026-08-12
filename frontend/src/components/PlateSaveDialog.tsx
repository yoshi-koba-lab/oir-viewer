import { useEffect, useMemo, useState, useRef } from 'react';
import {
  chooseFolder, fetchPlateVolume, composePlatePdf,
  checkPlatePdfTarget, PLATE_XY_CHOICES, PDF_CELL_CHOICES,
} from '../utils/api';
import { useImageStore } from '../stores/imageStore';
import { usePlateStore } from '../stores/plateStore';
import { useViewStore } from '../stores/viewStore';
import { PlateRenderer, parseVolume } from '../utils/plateRender';
import { collectOpenWells, mismatchedPlateTabs, snapshotOf } from '../utils/plateWells';
import { gpuLimits } from '../utils/gpuLimits';
import { OverwriteConflict } from '../utils/api';
import { basenameOf, filenameProblem } from '../utils/paths';
import { plateExportPercent, plateZoomProblem } from '../utils/plateExport';
import { formatUm } from '../utils/scalebar';
import {
  MAX_VOLUME_ZOOM_PERCENT,
  MIN_VOLUME_ZOOM_PERCENT,
} from '../utils/threeDCamera';
import { PlateTable } from './PlateTable';
import { OverwriteConfirm } from './SaveDialog';

function pdfInputStem(name: string): string {
  return name.trim().replace(/\.pdf$/i, '');
}

function pdfInputProblem(name: string): string {
  return name.trim() ? filenameProblem(pdfInputStem(name)) : '';
}

const displayPercent = (value: number) => (
  Number.isInteger(value) ? String(value) : value.toFixed(1)
);

const compactPlateCellCount = (rows: number, cols: number, frameCount: number) => {
  const compactCols = Math.min(
    frameCount,
    Math.max(1, Math.ceil(Math.sqrt(frameCount * cols / Math.max(1, rows)))),
  );
  return Math.ceil(frameCount / compactCols) * compactCols;
};

interface PdfProgress {
  percent: number;
  label: string;
}

/** Edit the conditions table and export every matching open well to one PDF. */
export function PlateSaveDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (details: string) => void;
}) {
  const [error, setError] = useState('');
  // The scan and table outlive both Plate dialogs. Export controls and run
  // ownership stay local so closing this dialog cannot leave a resumable job.
  const plate = usePlateStore((s) => s.scan);
  const seed = usePlateStore((s) => s.seed);
  const [volKey, setVolKey] = useState('max');
  const [cellKey, setCellKey] = useState('max');
  /** Fit-relative zoom is uniform by default; its percentage is editable when enabled. */
  const [unifyZoom, setUnifyZoom] = useState(true);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [zoomPercentInput, setZoomPercentInput] = useState('100');
  /** Plate figures carry calibrated scale bars unless explicitly opted out. */
  const [includeScalebar, setIncludeScalebar] = useState(true);
  /** Compact output is the useful default; the full physical grid remains optional. */
  const [hideEmptyWells, setHideEmptyWells] = useState(true);
  const [progress, setProgress] = useState<PdfProgress | null>(null);
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
  const cropRect = useViewStore((s) => s.cropRect);

  const commitPlateZoom = () => {
    const problem = plateZoomProblem(zoomPercentInput);
    if (problem) {
      setError(problem);
      setZoomPercentInput(displayPercent(zoomPercent));
      return;
    }
    // The interactive viewer and its stored state display tenths of a percent;
    // normalise Plate input to that same precision so the PDF footer never
    // claims a rounded value different from the radius that was rendered.
    const next = Math.round(Number(zoomPercentInput) * 10) / 10;
    setZoomPercent(next);
    setZoomPercentInput(displayPercent(next));
    setError((current) => (
      current === '拡大率を数値で入力してください。'
      || current.startsWith('拡大率は ')
        ? ''
        : current
    ));
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
   * Render every matching open well and write one PDF.
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
        + 'ツールバーの Plate でウェルを開き、3D ビューで各ウェルを'
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
    const requestedHideEmptyWells = hideEmptyWells;
    const figureColumns = columns.filter((column) => column.onFigure);
    const figureLineCount = (well: (typeof wells)[number]) => {
      const lines = figureColumns
        .map((column) => (cells[well.wellId]?.[column.key] ?? '').trim())
        .filter(Boolean);
      const forcedWellLabel = requestedHideEmptyWells && !lines.includes(well.wellId) ? 1 : 0;
      return lines.length + forcedWellLabel + (well.numT > 1 ? 1 : 0);
    };
    // Two verified output columns (zoom and scale bar) are appended below; the
    // backend's hard table limit is 64 including them.
    if (columns.length > 62
      || columns.some((column) => column.label.length > 1000)
      || wells.some((well) => columns.some((column) => (
        (cells[well.wellId]?.[column.key] ?? '').length > (column.onFigure ? 1000 : 5000)
      )))
      || wells.some((well) => figureLineCount(well) > 20)) {
      setError('条件表または図中キャプションが長すぎます。列数・文字数を減らしてください。');
      return;
    }
    if (includeScalebar) {
      // Captions are composited by the PDF backend at top-left after the PNG is
      // decoded, while the calibrated bar is already inside the PNG at
      // bottom-left. Ten lines leave a verified gap at every supported cell
      // size; allowing the former 20-line maximum could cover the bar without
      // either stage knowing it had changed a number-bearing annotation.
      const overlapping = wells.filter((well) => figureLineCount(well) > 10);
      if (overlapping.length) {
        setError(
          `スケールバーと図中キャプションが重なるウェルがあります: ${
            overlapping.map((well) => well.wellId).join(', ')}\n`
          + '図に表示する条件列を10行以下に減らすか、スケールバーを外してください。',
        );
        return;
      }
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
    if (unifyZoom && plateZoomProblem(zoomPercentInput)) {
      setError(plateZoomProblem(zoomPercentInput));
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
    setProgress({ percent: 0, label: '保存先を確認中…' });

    // Freeze figure-wide settings with the well states and conditions table.
    // A global scale-bar edit or a local form update during a slow run must not
    // make later wells differ from the ones already captured.
    const runUnifyZoom = unifyZoom;
    // The field may contain an empty editing draft while unification is off;
    // never freeze NaN/zero/negative input into a job that does not use it.
    const runZoomPercent = runUnifyZoom
      ? Math.round(Number(zoomPercentInput) * 10) / 10
      : 100;
    const runIncludeScalebar = includeScalebar;
    const runHideEmptyWells = requestedHideEmptyWells;
    const viewSettings = useViewStore.getState();
    const runScalebar = {
      enabled: runIncludeScalebar,
      requestedUm: viewSettings.scalebarUm,
      color: viewSettings.scalebarColor,
    };
    let completedUnits = 0;
    const completedPercent = () => plateExportPercent(completedUnits, wells.length);
    let publishCompleted = false;
    let completionMessage = '';

    const releaseRun = (keepCompletedProgress = false) => {
      if (activePdfRun.current !== runId) return;
      activePdfRun.current = 0;
      if (!keepCompletedProgress) setProgress(null);
      setExporting(false);
    };

    if (!job) {
      setProgress({ percent: 0, label: 'PDF名と保存先を確認中…' });
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

    const cellPx = PDF_CELL_CHOICES.find((c) => c.key === cellKey)!.px;
    const layoutCells = runHideEmptyWells
      ? compactPlateCellCount(scan.rows, scan.cols, wells.length)
      : scan.rows * scan.cols;
    if (layoutCells * cellPx * cellPx > 250_000_000) {
      setError('このプレートサイズではセル解像度が大きすぎます。1段階下げてください。');
      releaseRun();
      return;
    }
    // The exact target and all local layout/GPU constraints have passed. This is
    // the sole preflight completion unit; merely starting a check counts as 0.
    completedUnits += 1;
    setProgress({ percent: completedPercent(), label: '保存処理を準備中…' });

    // Maximum 3D can retain ~0.8-1.7 GB of texture/reply data for a real well.
    // The PDF renderer needs its own textures, so unmount the interactive volume
    // only after preflight has succeeded and immediately before the long render.
    // Per-well camera/LUT/slab snapshots above remain unchanged.
    useViewStore.getState().setViewMode('2d');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (runId !== activePdfRun.current || cancelRef.current) {
      releaseRun();
      return;
    }
    const frames: {
      well_id: string; row: number; col: number; png_b64: string; caption: string[];
      source_path: string; source_identity: string; source_revision: string;
    }[] = [];
    const appliedFigureSettings = new Map<
      string,
      { zoomPercent: number; scalebarUm: number | null }
    >();
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
        setProgress({
          percent: completedPercent(),
          label: `${w.wellId} (${i + 1}/${wells.length}) 保存用データを取得中…`,
        });
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
        completedUnits += 1;
        setProgress({
          percent: completedPercent(),
          label: `${w.wellId} (${i + 1}/${wells.length}) 保存画像を3D描画中…`,
        });
        const vol = parseVolume(buf.data, buf.info);
        const requestedZoom = runUnifyZoom
          ? runZoomPercent
          : Number.isFinite(w.view.zoomPercent) && w.view.zoomPercent > 0
            ? w.view.zoomPercent
            : 100;
        const shot = await renderer.render(
          w.wellId, vol, w.colors, w.channelIdx.map(() => true),
          w.view.az, w.view.el, requestedZoom, w.zFrac, runScalebar,
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
        appliedFigureSettings.set(w.wellId, {
          zoomPercent: shot.zoomPercent,
          scalebarUm: shot.scalebarUm,
        });
        completedUnits += 1;
        setProgress({
          percent: completedPercent(),
          label: `${w.wellId} (${i + 1}/${wells.length}) 描画完了`,
        });
      }

      if (runCancelled()) { setResult('中止しました。PDF は作成していません。'); return; }
      finalizingPdfRef.current = true;
      setFinalizingPdf(true);
      setProgress({
        percent: completedPercent(),
        label: 'PDFファイルを保存中…（この段階は中止できません）',
      });
      // Why each empty cell is empty. Marking them all "not acquired" would print
      // a false statement over a well the microscope did image — a reader of the
      // figure has no way to tell that apart from a genuinely empty position.
      const states: Record<string, string> = {};
      const rendered = new Set(wells.map((w) => w.wellId));
      if (!runHideEmptyWells) {
        for (const w of scan.wells) {
          if (rendered.has(w.well_id)) continue;      // has a frame; state unused
          states[w.well_id] = !w.enabled ? 'disabled'
            : !w.stitch_path ? 'missing'
            : 'excluded';
        }
      }
      const res = await composePlatePdf({
        plate_name: scan.name, rows: scan.rows, cols: scan.cols,
        frames, well_states: states, cell_px: cellPx, output_dir: job.outputDir,
        hide_empty_wells: runHideEmptyWells,
        filename: job.filename,
        overwrite,
        expected_revision: job.expectedRevision,
        // These two generated columns prove which figure-wide options were
        // actually applied. Per-well zooms are retained when unification is off,
        // and auto scale-bar lengths may legitimately differ by calibration.
        table_headers: [...columns.map((c) => c.label), 'PDF拡大率', 'スケールバー（中心深度換算）'],
        table_rows: wells.map((w) => {
          const applied = appliedFigureSettings.get(w.wellId);
          if (!applied) throw new Error(`${w.wellId}: PDF設定の記録がありません。`);
          return [
            ...columns.map((c) => cells[w.wellId]?.[c.key] ?? ''),
            `${displayPercent(applied.zoomPercent)}%${runUnifyZoom ? '（統一）' : '（タブ設定）'}`,
            applied.scalebarUm === null
              ? 'なし'
              : `${formatUm(applied.scalebarUm)}（中心深度換算・画像内左下）`,
          ];
        }),
        // The resolution actually applied, never the one requested. Recording the
        // request is how the footer came to state a resolution that was not used.
        footer: `matl ${scan.matl_sha256.slice(0, 8)} | vol ${volKey}(${maxXy})`
              + `${clamped ? ` GPU上限${max3D}に制限` : ''}`
              + `${wells.some((w) => w.numT > 1)
                ? ` | T ${wells.map((w) => `${w.wellId}:${w.t + 1}`).join(',')}` : ''}`
              + ` | zoom ${runUnifyZoom ? `${displayPercent(runZoomPercent)}% unified` : 'per-well'}`
              + ` | scalebar ${runIncludeScalebar ? 'on(center-depth)' : 'off'}`
              + ` | layout ${runHideEmptyWells ? 'compact(empty hidden)' : 'full plate'}`
              + ` | cell ${cellPx}px | ${wells.length} wells | ${new Date().toISOString()}`,
      });
      if (res.wells !== wells.length || !(res.bytes > 0) || !res.path) {
        throw new Error('保存したPDFのウェル数またはファイル情報を検証できません。');
      }
      completedUnits += 1;
      publishCompleted = true;
      setProgress({ percent: completedPercent(), label: 'PDF保存完了' });
      completionMessage = (
        `${res.wells} ウェルを書き出しました（${Math.round(res.bytes / 1024)} KB）\n${res.path}`
        + (clamped
          ? `\n※ 解像度は この GPU の上限 ${max3D} px に制限しました（${vendor}）。`
          : '')
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
      releaseRun(publishCompleted);
      if (publishCompleted && completionMessage) onSaved(completionMessage);
    }
  };

  /** Stop the run: the flag ends the loop, the abort ends the current well. */
  const cancelExport = () => {
    if (finalizingPdfRef.current) return;
    cancelRef.current = true;
    pdfRunSeq.current += 1;
    abortRef.current?.abort();
    setProgress((current) => ({
      percent: current?.percent ?? 0,
      label: '中止処理中…',
    }));
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

  return (
    <>
      <div
        className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
        onClick={requestClose}
      >
        <div
          className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-xl shadow-2xl
                     p-5 max-w-3xl w-full max-h-[85vh] overflow-y-auto"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">Plate Save（3D → PDF）</h2>
            <button
              onClick={requestClose}
              disabled={finalizingPdf}
              className="text-[var(--text-secondary)] hover:text-white disabled:opacity-40"
              title={
                finalizingPdf
                  ? 'PDF 保存中は閉じられません'
                  : exporting ? '書き出しを中止します' : '閉じる'
              }
            >
              ✕
            </button>
          </div>

          {error && (
            <p className="text-xs text-red-400 mb-3 whitespace-pre-wrap select-text">{error}</p>
          )}

          {!plate ? (
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              先にツールバーの <strong>Plate</strong> で MATL 撮影フォルダを読み込んでください。
            </p>
          ) : (
            <div>
              <div className="text-xs mb-1">
                <span className="font-semibold">{plate.name}</span>
                <span className="text-[var(--text-secondary)]">
                  {' '}— 開いている {openWells.length} ウェル / {plate.rows} 行 × {plate.cols} 列
                </span>
              </div>
              <div
                className="text-[10px] font-mono text-[var(--text-secondary)] mb-3 truncate"
                title={plate.source}
              >
                {plate.source}
              </div>

              {cropRect && (
                <p className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] leading-relaxed text-amber-200">
                  クロップ範囲は Plate Save（3D → PDF）にはまだ適用されません。PDF は各ウェル全体を出力します。
                </p>
              )}

              {plate.warnings.map((warning, index) => (
                <p
                  key={index}
                  className="text-[11px] text-amber-400 mb-1 whitespace-pre-wrap select-text"
                >
                  ⚠ {warning}
                </p>
              ))}

              <div className="mt-4 pt-3 border-t border-[var(--border)]">
                <div className="flex items-baseline justify-between mb-2 gap-2 flex-wrap">
                  <h3 className="text-xs font-semibold">
                    条件表（開いている {openWells.length} ウェル）
                  </h3>
                  <button
                    onClick={() => seed(openWells.map((well) => snapshotOf(well, plate)), true)}
                    disabled={openWells.length === 0 || exporting}
                    title="自動列を現在のビューアの設定で埋め直します（手で直した値も上書きします）"
                    className="text-[10px] underline text-[var(--text-secondary)]
                               hover:text-white disabled:opacity-40"
                  >
                    自動列を現在の設定で更新
                  </button>
                </div>
                <PlateTable wells={openWells} disabled={exporting} />
                <p className="text-[10px] text-[var(--text-secondary)] mt-2 leading-relaxed">
                  各ウェルは <strong>開いたタブの現在の状態</strong>
                  （チャンネル・Min/Max・色・角度・Z 範囲）で書き出します。
                  3D ビューで調整してからここに戻ってきてください。
                </p>
              </div>

              <div className="mt-4 pt-3 border-t border-[var(--border)]">
                <div className="flex items-end gap-3 flex-wrap">
                  <label className="text-[10px] text-[var(--text-secondary)]">
                    ボリューム解像度
                    <select
                      value={volKey}
                      onChange={(e) => setVolKey(e.target.value)}
                      disabled={exporting}
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
                      disabled={exporting}
                      className="block mt-1 bg-[var(--bg-primary)] border border-[var(--border)]
                                 rounded px-2 py-1 text-xs text-[var(--text-primary)]"
                    >
                      {PDF_CELL_CHOICES.map((c) => (
                        <option key={c.key} value={c.key}>{c.label}</option>
                      ))}
                    </select>
                  </label>
                  <div className="flex flex-col gap-2 text-[10px] text-[var(--text-secondary)]">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={unifyZoom}
                        onChange={(event) => setUnifyZoom(event.target.checked)}
                        disabled={exporting}
                        className="accent-emerald-500"
                      />
                      <span>拡大率を統一</span>
                      <input
                        type="number"
                        min={MIN_VOLUME_ZOOM_PERCENT}
                        max={MAX_VOLUME_ZOOM_PERCENT}
                        step="1"
                        value={zoomPercentInput}
                        onChange={(event) => setZoomPercentInput(event.target.value)}
                        onBlur={commitPlateZoom}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            commitPlateZoom();
                            event.currentTarget.blur();
                          }
                        }}
                        disabled={exporting || !unifyZoom}
                        aria-label="Plate PDFの統一拡大率"
                        className="w-20 bg-[var(--bg-primary)] border border-[var(--border)]
                                   rounded px-2 py-1 text-xs text-right text-[var(--text-primary)]
                                   disabled:opacity-40"
                      />
                      <span>%</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={includeScalebar}
                        onChange={(event) => setIncludeScalebar(event.target.checked)}
                        disabled={exporting}
                        className="accent-emerald-500"
                      />
                      <span>スケールバーを保存画像に入れる（中心深度換算・画像内左下）</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={hideEmptyWells}
                        onChange={(event) => setHideEmptyWells(event.target.checked)}
                        disabled={exporting}
                        className="accent-emerald-500"
                      />
                      <span>空きウェルは表示しない</span>
                    </label>
                    <span className="pl-6 text-[9px] leading-relaxed opacity-80">
                      開いているウェルをプレート順に詰めて並べます（元の空位置は保持しません）
                    </span>
                  </div>
                  <label className="text-[10px] text-[var(--text-primary)] flex-1 min-w-[15rem]">
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
                        className="min-w-0 flex-1 bg-white/10 border border-[var(--text-secondary)]/60
                                   rounded px-2 py-1 text-xs text-[var(--text-primary)]
                                   placeholder:text-[var(--text-primary)] placeholder:opacity-70
                                   focus:outline-none focus:border-[var(--accent)]
                                   disabled:opacity-40 disabled:cursor-not-allowed"
                      />
                      <button
                        type="button"
                        onClick={browsePdfOutput}
                        disabled={exporting || pdfBrowsing}
                        className="px-2 py-1 rounded bg-white/10 border border-[var(--text-secondary)]/60
                                   text-[10px] text-[var(--text-primary)] hover:bg-white/15
                                   disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {pdfBrowsing ? '…' : '選択'}
                      </button>
                    </div>
                  </label>
                  <label className="text-[10px] text-[var(--text-primary)] flex-1 min-w-[12rem]">
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
                      className="block w-full mt-1 bg-white/10 border border-[var(--text-secondary)]/60
                                 rounded px-2 py-1 text-xs text-[var(--text-primary)]
                                 placeholder:text-[var(--text-primary)] placeholder:opacity-70
                                 focus:outline-none focus:border-[var(--accent)]
                                 disabled:opacity-40 disabled:cursor-not-allowed"
                    />
                  </label>
                  <button
                    onClick={() => exportPdf(false)}
                    disabled={exporting || openWells.length === 0 || !!conflict
                              || checkingPdfName || pdfBrowsing || !pdfOutputDir.trim()
                              || !!pdfInputProblem(pdfName)
                              || (unifyZoom && !!plateZoomProblem(zoomPercentInput))}
                    className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-medium
                               hover:opacity-90 disabled:opacity-40 transition"
                  >
                    {exporting
                      ? `PDF 保存中 ${progress?.percent ?? 0}%`
                      : `3D → PDF を作成（${openWells.length} ウェル）`}
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
                {unifyZoom && plateZoomProblem(zoomPercentInput) && (
                  <p className="text-[10px] text-red-400 mt-1">
                    {plateZoomProblem(zoomPercentInput)}
                  </p>
                )}
                {pdfInputProblem(pdfName) ? (
                  <p className="text-[10px] text-red-400 mt-1">{pdfInputProblem(pdfName)}</p>
                ) : checkingPdfName ? (
                  <p className="text-[10px] text-[var(--text-secondary)] mt-1">同名ファイルを確認中…</p>
                ) : nameConflict ? (
                  <p className="text-[10px] text-amber-400 mt-1">
                    {nameConflict.files[0]} は既にあります。作成前に上書きを確認します。
                  </p>
                ) : null}
                {(exporting || progress?.percent === 100) && progress && (
                  <div className="mt-3" aria-live="polite">
                    <div className="flex items-center justify-between gap-3 text-[10px] mb-1">
                      <span className="text-[var(--text-secondary)]">{progress.label}</span>
                      <span className="font-mono tabular-nums text-[var(--text-primary)]">
                        {progress.percent}%
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-label="Plate PDF保存の進行状況"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={progress.percent}
                      className="h-2 w-full overflow-hidden rounded-full bg-[var(--bg-primary)]
                                 border border-[var(--border)]"
                    >
                      <div
                        className="h-full bg-emerald-500 transition-[width] duration-300"
                        style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }}
                      />
                    </div>
                  </div>
                )}
                <p className="text-[10px] text-[var(--text-secondary)] mt-2 leading-relaxed">
                  コントラストは<strong>いま画面で設定されている Min/Max と色</strong>をそのまま
                  焼き込みます（ウェルごとの自動調整はしません）。表示中のチャンネルのみ、最大 4 つ。<br />
                  拡大率の100%は各ウェルをそれぞれ画像枠に収める倍率です（同じµm/pxに揃える設定ではありません）。
                  統一しない場合は各タブの 3D 拡大率を使います。<br />
                  スケールバーは voxel size と適用したカメラから、ボリューム中心深度でウェルごとに計算します。<br />
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
