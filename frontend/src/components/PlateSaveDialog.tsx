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
import {
  GENERATED_TABLE_HEADERS, PDF_TABLE_HEADER_LIMIT,
  plateExportPercent, plateZoomProblem,
} from '../utils/plateExport';
import {
  VISIBLE_PATTERN, channelSetLabel, loadPatterns, patternChannelsFor,
  patternFileStem, patternMask, patternProblem, savePatterns,
  unionChannelsFor, wellsMissingPatternChannels,
  type PlatePattern,
} from '../utils/platePatterns';
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
  type PdfJob = {
    patternKey: string; outputDir: string; filename: string; expectedRevision?: string;
  };
  /** The exact paths the user approved; confirmation never opens a second picker. */
  const [pendingJobs, setPendingJobs] = useState<PdfJob[] | null>(null);
  /** Invalidates an older asynchronous name check after the field changes. */
  const pdfCheckSeq = useRef(0);
  const [conflict, setConflict] = useState<
    { files: string[]; count: number; more: number } | null
  >(null);
  // The overwrite modal has no focus trap, so while it is up the form behind it
  // must not accept changes: content controls (resolution, zoom…) do not clear
  // the approved jobs, and editing them there would render different content
  // into the targets the user just approved.
  const uiLocked = exporting || conflict !== null;
  // Each well's own contrast and angle are what get baked in, so the table and
  // the export both have to re-read when the tabs or the active tab change.
  const imageList = useImageStore((s) => s.imageList);
  const activeImageId = useImageStore((s) => s.activeImageId);
  const cropRect = useViewStore((s) => s.cropRect);

  /**
   * Channel patterns: each selected one becomes its own PDF. User-defined
   * patterns persist in localStorage; the built-in "visible channels" pattern
   * is always offered and reproduces the behaviour this dialog always had.
   */
  const [userPatterns, setUserPatterns] = useState<PlatePattern[]>(
    () => loadPatterns(window.localStorage),
  );
  const [selectedPatternKeys, setSelectedPatternKeys] = useState<string[]>(
    [VISIBLE_PATTERN.key],
  );
  const [newPatternName, setNewPatternName] = useState('');
  const [newPatternChannels, setNewPatternChannels] = useState<number[]>([]);
  const allPatterns = useMemo(
    () => [VISIBLE_PATTERN, ...userPatterns],
    [userPatterns],
  );
  const selectedPatterns = useMemo(
    () => allPatterns.filter((p) => selectedPatternKeys.includes(p.key)),
    [allPatterns, selectedPatternKeys],
  );
  useEffect(() => {
    savePatterns(window.localStorage, userPatterns);
  }, [userPatterns]);

  const togglePatternSelected = (key: string) => {
    setSelectedPatternKeys((prev) => (
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    ));
    invalidatePdfTarget();
  };

  const toggleNewPatternChannel = (channel: number) => {
    setNewPatternChannels((prev) => (
      prev.includes(channel)
        ? prev.filter((c) => c !== channel)
        : [...prev, channel].sort((a, b) => a - b)
    ));
  };

  const addPattern = () => {
    const problem = patternProblem(newPatternName, newPatternChannels, userPatterns);
    if (problem) { setError(problem); return; }
    const pattern: PlatePattern = {
      key: `p${Date.now().toString(36)}-${userPatterns.length}`,
      name: newPatternName.trim(),
      channels: [...newPatternChannels].sort((a, b) => a - b),
    };
    setUserPatterns((prev) => [...prev, pattern]);
    // Adding is an expression of intent to use it; selecting it saves a click
    // and makes the effect of 追加 visible immediately.
    setSelectedPatternKeys((prev) => [...prev, pattern.key]);
    setNewPatternName('');
    setNewPatternChannels([]);
    invalidatePdfTarget();
  };

  const removePattern = (key: string) => {
    setUserPatterns((prev) => prev.filter((p) => p.key !== key));
    setSelectedPatternKeys((prev) => prev.filter((k) => k !== key));
    invalidatePdfTarget();
  };

  /** Live feedback for the add form, silent until the user has typed anything. */
  const newPatternProblemText = (newPatternName.trim() || newPatternChannels.length)
    ? patternProblem(newPatternName, newPatternChannels, userPatterns)
    : '';

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
    setPendingJobs(null);
  };

  /** Check a typed name when focus leaves it; the export repeats this check. */
  const probePdfTarget = async (dir = pdfOutputDir) => {
    const scan = plate;
    const name = pdfInputStem(pdfName);
    if (!scan || !dir.trim() || !pdfName.trim() || pdfInputProblem(pdfName)) return;
    // With several patterns selected the run writes one file per pattern, so
    // the hint probes the suffixed names; the base name is never written then,
    // and probing it would both miss real conflicts and claim false ones.
    const stems = selectedPatterns.length > 1
      ? selectedPatterns.map((p) => patternFileStem(name, p, selectedPatterns.length))
      : [name];
    const seq = ++pdfCheckSeq.current;
    setCheckingPdfName(true);
    try {
      const files: string[] = [];
      let count = 0;
      let more = 0;
      for (const stem of stems) {
        try {
          await checkPlatePdfTarget({
            plate_name: scan.name, output_dir: dir.trim(), filename: stem,
          });
        } catch (e) {
          if (!(e instanceof OverwriteConflict)) throw e;
          files.push(...e.files);
          count += e.count;
          more += e.more;
        }
        if (seq !== pdfCheckSeq.current) return;
      }
      setNameConflict(files.length ? { files, count, more } : null);
    } catch (e) {
      if (seq !== pdfCheckSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
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
  const exportPdf = async (overwrite = false, approvedJobs: PdfJob[] | null = null) => {
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
    // Which patterns this run draws. A conflict-approved rerun replays exactly
    // the jobs the user confirmed; deleting a pattern between the dialog and
    // the confirmation must fail rather than silently exporting fewer PDFs.
    const runPatterns = approvedJobs
      ? approvedJobs.map((jobEntry) => allPatterns.find((p) => p.key === jobEntry.patternKey))
      : selectedPatterns;
    if (approvedJobs && runPatterns.some((p) => p === undefined)) {
      setError('確認済みのパターンが見つかりません。パターンを選び直してください。');
      return;
    }
    const patterns = runPatterns as PlatePattern[];
    if (patterns.length === 0) {
      setError('保存する色パターンを 1 つ以上選んでください。');
      return;
    }
    // The visible-channels pattern inherits the checks this dialog always ran;
    // they are meaningless for fixed patterns, which ignore visibility.
    if (patterns.some((p) => p.channels === null)) {
      const noCh = wells.filter((w) => w.channelIdx.length === 0);
      if (noCh.length) {
        setError(
          `表示中のチャンネルがないウェルがあります: ${noCh.map((w) => w.wellId).join(', ')}\n`
          + '各ウェルでチャンネルを 1 つ以上表示するか、固定チャンネルのパターンを選んでください。',
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
    }
    // A fixed pattern naming a channel a well does not have cannot be drawn as
    // named; drawing something else instead would be a silently wrong figure.
    for (const p of patterns) {
      const missing = wellsMissingPatternChannels(p, wells);
      if (missing.length) {
        setError(
          `パターン「${p.name}」（${channelSetLabel(p.channels ?? [])}）に無いチャンネルの`
          + `ウェルがあります: ${missing.join(', ')}\n`
          + 'パターンのチャンネルを減らすか、このパターンの選択を外してください。',
        );
        return;
      }
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
    // The generated columns (zoom, scale bar, saved channels) are appended
    // below; the backend's hard header limit includes them, so the budget for
    // user columns shrinks whenever a generated column is added.
    if (columns.length > PDF_TABLE_HEADER_LIMIT - GENERATED_TABLE_HEADERS.length
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
    // driver-capped — 2048 under ANGLE, which is every Windows build — and
    // stitched wells routinely exceed that, so "Max (原寸)" would stream the
    // full-size volume per well and only then be refused at texImage3D,
    // throwing away the whole export after minutes of work. Clamping only ever
    // scales down: on a GPU whose cap exceeds the source, the volume comes
    // back untouched.
    const { max3D, vendor } = gpuLimits();
    if (max3D === 0) {
      setError('この環境では WebGL2 が使えないため、3D の書き出しができません。');
      return;
    }
    const wanted = PLATE_XY_CHOICES.find((c) => c.key === volKey)!.maxXy;
    const maxXy = wanted === 0 ? max3D : Math.min(wanted, max3D);
    const clamped = maxXy !== wanted;

    let jobs = approvedJobs;
    const outputDir = jobs?.[0]?.outputDir ?? pdfOutputDir.trim();
    const typedName = pdfInputStem(pdfName);
    if (!outputDir) {
      setError('PDF の保存先フォルダを選んでください。');
      return;
    }
    if (!jobs && pdfInputProblem(pdfName)) {
      setError(pdfInputProblem(pdfName));
      return;
    }
    if (!jobs && patterns.length > 1) {
      // With no base name the backend would stamp each PDF its own timestamp,
      // and nothing in the names would say they came from one run.
      if (!typedName) {
        setError('複数のパターンを保存するときは、ファイル名を入力してください。');
        return;
      }
      for (const p of patterns) {
        const stemProblem = filenameProblem(patternFileStem(typedName, p, patterns.length));
        if (stemProblem) {
          setError(`パターン「${p.name}」のファイル名: ${stemProblem}`);
          return;
        }
      }
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
    const completedPercent = () => plateExportPercent(completedUnits, wells.length, patterns.length);
    let publishCompleted = false;
    let completionMessage = '';

    const releaseRun = (keepCompletedProgress = false) => {
      if (activePdfRun.current !== runId) return;
      activePdfRun.current = 0;
      if (!keepCompletedProgress) setProgress(null);
      setExporting(false);
    };

    if (!jobs) {
      setProgress({ percent: 0, label: 'PDF名と保存先を確認中…' });
      const built: PdfJob[] = [];
      const conflictFiles: string[] = [];
      let conflictMore = 0;
      try {
        for (const p of patterns) {
          const stem = patternFileStem(typedName, p, patterns.length);
          try {
            const checked = await checkPlatePdfTarget({
              plate_name: scan.name, output_dir: outputDir, filename: stem,
            });
            built.push({
              patternKey: p.key, outputDir,
              filename: checked.filename, expectedRevision: checked.revision,
            });
          } catch (e) {
            if (!(e instanceof OverwriteConflict)) throw e;
            // Keep checking the rest: the user decides once, over the full list
            // of files the run would replace, not once per pattern.
            built.push({
              patternKey: p.key, outputDir,
              filename: stem
                || (basenameOf(e.files[0] ?? '').replace(/\.pdf$/i, '') || 'plate'),
              expectedRevision: Object.values(e.revisions)[0],
            });
            conflictFiles.push(...e.files);
            conflictMore += e.more;
          }
          if (pdfRunSeq.current !== runId || cancelRef.current) {
            // Same acknowledgement every later cancel point gives; a silent
            // return here looked like the dialog ignoring the button.
            if (pdfRunSeq.current === runId && cancelRef.current) {
              setResult('中止しました。PDF は作成していません。');
            }
            releaseRun();
            return;
          }
        }
      } catch (e) {
        if (pdfRunSeq.current === runId && !cancelRef.current) {
          setError(e instanceof Error ? e.message : String(e));
        }
        releaseRun();
        return;
      }
      if (conflictFiles.length) {
        const summary = {
          files: conflictFiles,
          count: conflictFiles.length + conflictMore,
          more: conflictMore,
        };
        setPendingJobs(built);
        setNameConflict(summary);
        setConflict(summary);
        releaseRun();
        return;
      }
      jobs = built;
      setNameConflict(null);
    }

    // A confirmed preflight starts the long render with the progress UI visible,
    // not hidden behind the confirmation dialog for the next several minutes.
    if (approvedJobs) {
      setConflict(null);
      setPendingJobs(null);
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
    type PdfFrame = {
      well_id: string; row: number; col: number; png_b64: string; caption: string[];
      source_path: string; source_identity: string; source_revision: string;
    };
    const framesByPattern = new Map<string, PdfFrame[]>(
      patterns.map((p) => [p.key, []]),
    );
    const appliedFigureSettings = new Map<
      string,
      { zoomPercent: number; scalebarUm: number | null }
    >();
    // For the catch block: which PDFs were already published when a later
    // compose failed, and which pattern was being composed.
    const writtenPdfs: { pattern: PlatePattern; path: string }[] = [];
    let composing: PlatePattern | null = null;
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
        // One fetch serves every pattern: the union of their channel sets is
        // requested, and each pattern is rendered from it with a visibility
        // mask. Refetching per pattern would multiply the slowest step (about
        // two minutes per well on real data at Maximum) by the pattern count.
        // The window baked in stays this well's own — the union draws windows
        // and colours from the tab's per-channel state, so a pattern decides
        // which channels appear, never how they look.
        const unionChannels = unionChannelsFor(patterns, w);
        const buf = await fetchPlateVolume({
          path: w.path!,
          source_identity: w.sourceIdentity,
          source_revision: w.sourceRevision,
          channels: unionChannels,
          levels: unionChannels.map((c) => w.channelWindows[c]),
          t: w.t,
          max_xy: maxXy,
        }, abortRef.current.signal);
        if (runCancelled()) { setResult('中止しました。PDF は作成していません。'); return; }
        completedUnits += 1;
        const vol = parseVolume(buf.data, buf.info);
        const unionColors = unionChannels.map((c) => w.channelColors[c]);
        const requestedZoom = runUnifyZoom
          ? runZoomPercent
          : Number.isFinite(w.view.zoomPercent) && w.view.zoomPercent > 0
            ? w.view.zoomPercent
            : 100;
        const caption = figureCols
          .map((c) => (cells[w.wellId]?.[c.key] ?? '').trim())
          .filter(Boolean)
          .concat(w.numT > 1 ? [`T${w.t + 1}`] : []);
        for (const p of patterns) {
          if (runCancelled()) { setResult('中止しました。PDF は作成していません。'); return; }
          setProgress({
            percent: completedPercent(),
            label: `${w.wellId} (${i + 1}/${wells.length})`
              + `${patterns.length > 1 ? ` ${p.name} を` : ' 保存画像を'}3D描画中…`,
          });
          const shot = await renderer.render(
            w.wellId, vol, unionColors, patternMask(p, w, unionChannels),
            w.view.az, w.view.el, requestedZoom, w.zFrac, runScalebar,
          );
          if (runCancelled()) { setResult('中止しました。PDF は作成していません。'); return; }
          let bin = '';
          for (let k = 0; k < shot.png.length; k += 0x8000) {
            bin += String.fromCharCode(...shot.png.subarray(k, k + 0x8000));
          }
          framesByPattern.get(p.key)!.push({
            well_id: w.wellId, row: w.row, col: w.col, png_b64: btoa(bin),
            source_path: w.path!,
            source_identity: buf.info.source_identity,
            source_revision: buf.info.source_revision,
            caption,
          });
          // Zoom and scale bar depend on the volume geometry and camera only,
          // never on which channels are lit, so every pattern of one well must
          // agree. A disagreement means that assumption broke — refuse rather
          // than record one pattern's numbers as the truth about all of them.
          const known = appliedFigureSettings.get(w.wellId);
          if (!known) {
            appliedFigureSettings.set(w.wellId, {
              zoomPercent: shot.zoomPercent,
              scalebarUm: shot.scalebarUm,
            });
          } else if (known.zoomPercent !== shot.zoomPercent
            || known.scalebarUm !== shot.scalebarUm) {
            throw new Error(`${w.wellId}: パターン間で拡大率またはスケールバーが一致しません。`);
          }
          completedUnits += 1;
        }
        setProgress({
          percent: completedPercent(),
          label: `${w.wellId} (${i + 1}/${wells.length}) 描画完了`,
        });
      }

      if (runCancelled()) { setResult('中止しました。PDF は作成していません。'); return; }
      finalizingPdfRef.current = true;
      setFinalizingPdf(true);
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
      const completions: string[] = [];
      for (const [patternIndex, p] of patterns.entries()) {
        composing = p;
        const job = jobs.find((j) => j.patternKey === p.key);
        if (!job) throw new Error(`パターン「${p.name}」の保存先が確定していません。`);
        setProgress({
          percent: completedPercent(),
          label: patterns.length > 1
            ? `PDFファイルを保存中…（${patternIndex + 1}/${patterns.length}: ${p.name}・この段階は中止できません）`
            : 'PDFファイルを保存中…（この段階は中止できません）',
        });
        const patternChannelNote = p.channels === null
          ? 'per-well visible'
          : channelSetLabel(p.channels);
        const res = await composePlatePdf({
          plate_name: scan.name, rows: scan.rows, cols: scan.cols,
          frames: framesByPattern.get(p.key)!,
          well_states: states, cell_px: cellPx, output_dir: job.outputDir,
          hide_empty_wells: runHideEmptyWells,
          filename: job.filename,
          overwrite,
          expected_revision: job.expectedRevision,
          // These generated columns prove which figure-wide options were
          // actually applied. Per-well zooms are retained when unification is
          // off, auto scale-bar lengths may differ by calibration, and the
          // channel column records what this PDF actually drew — for the
          // visible pattern that varies per well, for a fixed pattern it does
          // not, and either way the table says so instead of implying that the
          // conditions table's channel column described this figure.
          table_headers: [
            ...columns.map((c) => c.label),
            ...GENERATED_TABLE_HEADERS,
          ],
          table_rows: wells.map((w) => {
            const applied = appliedFigureSettings.get(w.wellId);
            if (!applied) throw new Error(`${w.wellId}: PDF設定の記録がありません。`);
            return [
              ...columns.map((c) => cells[w.wellId]?.[c.key] ?? ''),
              `${displayPercent(applied.zoomPercent)}%${runUnifyZoom ? '（統一）' : '（タブ設定）'}`,
              applied.scalebarUm === null
                ? 'なし'
                : `${formatUm(applied.scalebarUm)}（中心深度換算・画像内左下）`,
              channelSetLabel(patternChannelsFor(p, w)),
            ];
          }),
          // The resolution actually applied, never the one requested. Recording the
          // request is how the footer came to state a resolution that was not used.
          footer: `matl ${scan.matl_sha256.slice(0, 8)} | vol ${volKey}(${maxXy})`
                + `${clamped ? ` GPU上限${max3D}に制限` : ''}`
                + ` | channels ${patternChannelNote}${patterns.length > 1 ? ` (${p.name})` : ''}`
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
        writtenPdfs.push({ pattern: p, path: res.path });
        completedUnits += 1;
        completions.push(
          `${patterns.length > 1 ? `【${p.name}】 ` : ''}`
          + `${res.wells} ウェルを書き出しました（${Math.round(res.bytes / 1024)} KB）\n${res.path}`,
        );
      }
      composing = null;
      publishCompleted = true;
      setProgress({ percent: completedPercent(), label: 'PDF保存完了' });
      completionMessage = completions.join('\n')
        + (clamped
          ? `\n※ 解像度は この GPU の上限 ${max3D} px に制限しました（${vendor}）。`
          : '');
    } catch (e) {
      const writtenNote = writtenPdfs.length
        ? `既に保存できたPDF:\n${writtenPdfs.map((w) => `【${w.pattern.name}】 ${w.path}`).join('\n')}\n\n`
        : '';
      // A cancel aborts the fetch, which surfaces here as an AbortError. That is
      // the user's own action, not a failure to report as one.
      if (runCancelled()) setResult(`${writtenNote}中止しました。残りの PDF は作成していません。`);
      // Nothing was written yet; ask before replacing. The wells are already
      // rendered, so confirming does not repeat the expensive part... it does,
      // in fact, and that is the honest trade: keeping every frame in memory to
      // avoid it is what makes a 24-well export run out of room.
      else if (e instanceof OverwriteConflict && writtenPdfs.length === 0) {
        setPendingJobs((jobs ?? []).map((jobEntry) => (
          jobEntry.patternKey === composing?.key
            ? { ...jobEntry, expectedRevision: Object.values(e.revisions)[0] }
            : jobEntry
        )));
        setNameConflict({ files: e.files, count: e.count, more: e.more });
        setConflict({ files: e.files, count: e.count, more: e.more });
      } else if (e instanceof OverwriteConflict) {
        // Some PDFs are already published. Re-running the whole set would
        // re-render everything and re-ask about files this run just wrote, so
        // report exactly where it stopped instead of pretending to resume.
        setError(
          `${writtenNote}パターン「${composing?.name ?? '?'}」の保存先ファイルが確認後に`
          + '変わりました。残りのパターンは名前を変えるか、確認し直して再実行してください。',
        );
      } else {
        setError(`${writtenNote}${e instanceof Error ? e.message : String(e)}`);
      }
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
        className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plate-save-dialog-title"
        onClick={requestClose}
      >
        <div
          className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-xl shadow-2xl
                     p-5 max-w-3xl w-full max-h-[calc(100vh-3rem)] overflow-y-auto"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-3">
            <h2 id="plate-save-dialog-title" className="text-sm font-semibold">Plate Save（3D → PDF）</h2>
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
                    disabled={openWells.length === 0 || uiLocked}
                    title="自動列を現在のビューアの設定で埋め直します（手で直した値も上書きします）"
                    className="text-[10px] underline text-[var(--text-secondary)]
                               hover:text-white disabled:opacity-40"
                  >
                    自動列を現在の設定で更新
                  </button>
                </div>
                <PlateTable wells={openWells} disabled={uiLocked} />
                <p className="text-[10px] text-[var(--text-secondary)] mt-2 leading-relaxed">
                  各ウェルは <strong>開いたタブの現在の状態</strong>
                  （チャンネル・Min/Max・色・角度・Z 範囲）で書き出します。
                  3D ビューで調整してからここに戻ってきてください。
                </p>
              </div>

              <div className="mt-4 pt-3 border-t border-[var(--border)]">
                <h3 className="text-xs font-semibold mb-1">保存する色パターン</h3>
                <p className="text-[10px] text-[var(--text-secondary)] mb-2 leading-relaxed">
                  チェックしたパターンごとに 1 つの PDF を作ります。パターンが決めるのは
                  <strong>描くチャンネルだけ</strong>で、色と Min/Max は各ウェルの設定のままです。
                  複数選ぶと、ファイル名の後ろにパターン名が付きます。
                </p>
                <div className="flex flex-col gap-1">
                  {allPatterns.map((p) => (
                    <label
                      key={p.key}
                      className="flex items-center gap-2 text-[11px] cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        className="accent-emerald-500"
                        checked={selectedPatternKeys.includes(p.key)}
                        disabled={uiLocked}
                        onChange={() => togglePatternSelected(p.key)}
                      />
                      <span>{p.name}</span>
                      <span className="text-[10px] text-[var(--text-secondary)]">
                        {p.channels === null
                          ? '各ウェルで表示中のチャンネル'
                          : channelSetLabel(p.channels)}
                      </span>
                      {p.key !== VISIBLE_PATTERN.key && (
                        <button
                          type="button"
                          onClick={() => removePattern(p.key)}
                          disabled={uiLocked}
                          title="このパターンを削除"
                          className="px-1 text-[var(--text-secondary)] hover:text-red-400
                                     disabled:opacity-30"
                        >
                          ×
                        </button>
                      )}
                    </label>
                  ))}
                </div>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <input
                    type="text"
                    value={newPatternName}
                    onChange={(e) => setNewPatternName(e.target.value)}
                    disabled={uiLocked}
                    placeholder="新しいパターン名（例: CH1+2）"
                    className="w-44 bg-white/10 border border-[var(--text-secondary)]/60 rounded
                               px-2 py-1 text-[11px] text-[var(--text-primary)]
                               placeholder:opacity-60 focus:outline-none
                               focus:border-[var(--accent)] disabled:opacity-40"
                  />
                  {[0, 1, 2, 3].map((c) => (
                    <button
                      key={c}
                      type="button"
                      disabled={uiLocked}
                      onClick={() => toggleNewPatternChannel(c)}
                      className={`px-2 py-1 rounded text-[10px] border transition ${
                        newPatternChannels.includes(c)
                          ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
                          : 'text-[var(--text-secondary)] border-[var(--border)]'}`}
                    >
                      CH{c + 1}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={addPattern}
                    disabled={uiLocked}
                    className="px-2 py-1 rounded bg-white/10 text-[11px] hover:bg-white/20
                               disabled:opacity-40 transition"
                  >
                    ＋ 追加
                  </button>
                  {newPatternProblemText && (
                    <span className="text-[10px] text-red-400">{newPatternProblemText}</span>
                  )}
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-[var(--border)]">
                <div className="flex items-end gap-3 flex-wrap">
                  <label className="text-[10px] text-[var(--text-secondary)]">
                    ボリューム解像度
                    <select
                      value={volKey}
                      onChange={(e) => setVolKey(e.target.value)}
                      disabled={uiLocked}
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
                      disabled={uiLocked}
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
                        disabled={uiLocked}
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
                        disabled={uiLocked || !unifyZoom}
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
                        disabled={uiLocked}
                        className="accent-emerald-500"
                      />
                      <span>スケールバーを保存画像に入れる（中心深度換算・画像内左下）</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={hideEmptyWells}
                        onChange={(event) => setHideEmptyWells(event.target.checked)}
                        disabled={uiLocked}
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
                        disabled={uiLocked}
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
                        disabled={uiLocked || pdfBrowsing}
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
                      disabled={uiLocked}
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
                              || selectedPatterns.length === 0
                              || (selectedPatterns.length > 1 && !pdfInputStem(pdfName))
                              || (unifyZoom && !!plateZoomProblem(zoomPercentInput))}
                    className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-medium
                               hover:opacity-90 disabled:opacity-40 transition"
                  >
                    {exporting
                      ? `PDF 保存中 ${progress?.percent ?? 0}%`
                      : `3D → PDF を作成（${openWells.length} ウェル${
                        selectedPatterns.length > 1
                          ? ` × ${selectedPatterns.length}パターン` : ''}）`}
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
                {selectedPatterns.length === 0 ? (
                  <p className="text-[10px] text-red-400 mt-1">
                    保存する色パターンを 1 つ以上選んでください。
                  </p>
                ) : null}
                {selectedPatterns.length > 1 && !pdfInputStem(pdfName) ? (
                  <p className="text-[10px] text-amber-400 mt-1">
                    複数パターンの保存にはファイル名が必要です（各 PDF は「ファイル名_パターン名.pdf」になります）。
                  </p>
                ) : null}
                {pdfInputProblem(pdfName) ? (
                  <p className="text-[10px] text-red-400 mt-1">{pdfInputProblem(pdfName)}</p>
                ) : checkingPdfName ? (
                  <p className="text-[10px] text-[var(--text-secondary)] mt-1">同名ファイルを確認中…</p>
                ) : nameConflict ? (
                  <p className="text-[10px] text-amber-400 mt-1">
                    {nameConflict.files.slice(0, 3).join('、')}
                    {nameConflict.count > 3 ? ` 他${nameConflict.count - 3}件` : ''}
                    {' '}は既にあります。作成前に上書きを確認します。
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
                  焼き込みます（ウェルごとの自動調整はしません）。描くチャンネルは上の
                  色パターンで決まります（既定は各ウェルで表示中のチャンネル・最大 4 つ）。<br />
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
          onCancel={() => { setConflict(null); setPendingJobs(null); }}
          onConfirm={() => pendingJobs && exportPdf(true, pendingJobs)}
        />
      )}
    </>
  );
}
