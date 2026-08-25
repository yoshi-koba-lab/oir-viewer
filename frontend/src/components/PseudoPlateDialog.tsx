import { useEffect, useMemo, useRef, useState } from 'react';
import {
  chooseFolder, fetchPlateVolume, composePlatePdf, checkPlatePdfTarget,
  OverwriteConflict, PLATE_XY_CHOICES, PDF_CELL_CHOICES,
} from '../utils/api';
import { useImageStore } from '../stores/imageStore';
import { useViewStore } from '../stores/viewStore';
import { PlateRenderer, parseVolume } from '../utils/plateRender';
import { collectOpenImages, type OpenImage } from '../utils/plateWells';
import {
  PSEUDO_FORMATS, type PseudoAssignments, assignWithMove,
  duplicateSourcePositions, prefillAssignments, pseudoPositions, pseudoWellId,
  remapAssignments, tabLabels,
} from '../utils/pseudoPlate';
import { gpuLimits } from '../utils/gpuLimits';
import { filenameProblem } from '../utils/paths';
import { plateExportPercent, plateZoomProblem } from '../utils/plateExport';
import {
  MAX_VOLUME_ZOOM_PERCENT,
  MIN_VOLUME_ZOOM_PERCENT,
} from '../utils/threeDCamera';
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

interface PdfProgress {
  percent: number;
  label: string;
}

type PdfJob = { outputDir: string; filename: string; expectedRevision?: string };

/**
 * Arrange the open files in a culture-plate layout and export one PDF.
 *
 * The rendering pipeline is Plate Save's, applied to arbitrary open tabs: each
 * assigned file is re-read at export resolution with its tab's own channels,
 * windows, colours, camera and Z slab, rendered off-screen, and composed by the
 * same backend endpoint. Cells keep the image's own rectangular shape — nothing
 * is masked into a circular well.
 */
export function PseudoPlateDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (details: string) => void;
}) {
  const [error, setError] = useState('');
  const [formatKey, setFormatKey] = useState('6');
  const format = PSEUDO_FORMATS.find((f) => f.key === formatKey) ?? PSEUDO_FORMATS[0];
  const [plateName, setPlateName] = useState('Pseudo Plate');
  const [volKey, setVolKey] = useState('max');
  const [cellKey, setCellKey] = useState('max');
  const [unifyZoom, setUnifyZoom] = useState(true);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [zoomPercentInput, setZoomPercentInput] = useState('100');
  const [includeScalebar, setIncludeScalebar] = useState(true);
  const [progress, setProgress] = useState<PdfProgress | null>(null);
  const [result, setResult] = useState('');
  const cancelRef = useRef(false);
  /** Aborts the in-flight volume read; a real file takes minutes at Maximum. */
  const abortRef = useRef<AbortController | null>(null);
  const [exporting, setExporting] = useState(false);
  /** The final POST cannot be cancelled once the backend starts publishing. */
  const [finalizingPdf, setFinalizingPdf] = useState(false);
  const finalizingPdfRef = useRef(false);
  /** Synchronous guard: React state alone cannot stop a same-tick double click. */
  const activePdfRun = useRef(0);
  const pdfRunSeq = useRef(0);
  const [pdfName, setPdfName] = useState('');
  const [pdfOutputDir, setPdfOutputDir] = useState('');
  const [pdfBrowsing, setPdfBrowsing] = useState(false);
  const [checkingPdfName, setCheckingPdfName] = useState(false);
  const [nameConflict, setNameConflict] = useState<
    { files: string[]; count: number; more: number } | null
  >(null);
  const [pendingJob, setPendingJob] = useState<PdfJob | null>(null);
  const pdfCheckSeq = useRef(0);
  const [conflict, setConflict] = useState<
    { files: string[]; count: number; more: number } | null
  >(null);
  const uiLocked = exporting || conflict !== null;

  const imageList = useImageStore((s) => s.imageList);
  const activeImageId = useImageStore((s) => s.activeImageId);
  const cropRect = useViewStore((s) => s.cropRect);

  /** wellId -> imageId. Prefilled once from the open tabs, then user-owned. */
  const [assign, setAssign] = useState<PseudoAssignments>(() => prefillAssignments(
    PSEUDO_FORMATS[0].rows, PSEUDO_FORMATS[0].cols,
    useImageStore.getState().imageList.map((item) => item.id),
  ));

  // A tab closed while the dialog is open must not survive as a stale
  // assignment: the export would refuse late, and the grid would show a
  // filename that no longer exists.
  useEffect(() => {
    setAssign((prev) => remapAssignments(
      prev, format.rows, format.cols, imageList.map((item) => item.id),
    ));
  }, [imageList, format.rows, format.cols]);

  const labels = useMemo(() => tabLabels(imageList), [imageList]);
  const positions = useMemo(
    () => pseudoPositions(format.rows, format.cols),
    [format.rows, format.cols],
  );
  const assignedCount = useMemo(
    () => positions.filter((p) => assign[p]).length,
    [positions, assign],
  );

  const changeFormat = (key: string) => {
    const next = PSEUDO_FORMATS.find((f) => f.key === key);
    if (!next) return;
    setFormatKey(key);
    setAssign((prev) => remapAssignments(
      prev, next.rows, next.cols, imageList.map((item) => item.id),
    ));
    invalidatePdfTarget();
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
    const name = pdfInputStem(pdfName);
    if (!dir.trim() || !pdfName.trim() || pdfInputProblem(pdfName)) return;
    const seq = ++pdfCheckSeq.current;
    setCheckingPdfName(true);
    try {
      try {
        await checkPlatePdfTarget({
          plate_name: plateName, output_dir: dir.trim(), filename: name,
        });
        if (seq !== pdfCheckSeq.current) return;
        setNameConflict(null);
      } catch (e) {
        if (!(e instanceof OverwriteConflict)) throw e;
        if (seq !== pdfCheckSeq.current) return;
        setNameConflict({ files: e.files, count: e.count, more: e.more });
      }
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

  const commitPlateZoom = () => {
    const problem = plateZoomProblem(zoomPercentInput);
    if (problem) {
      setError(problem);
      setZoomPercentInput(displayPercent(zoomPercent));
      return;
    }
    const next = Math.round(Number(zoomPercentInput) * 10) / 10;
    setZoomPercent(next);
    setZoomPercentInput(displayPercent(next));
    setError((current) => (
      current === '拡大率を数値で入力してください。' || current.startsWith('拡大率は ')
        ? ''
        : current
    ));
  };

  /**
   * Render every assigned file and write one PDF.
   *
   * All or nothing, exactly like Plate Save: a file that was assigned but could
   * not be rendered would appear as an empty cell — indistinguishable from a
   * position the user left blank — so the first failure aborts the whole run.
   */
  const exportPdf = async (overwrite = false, approvedJob: PdfJob | null = null) => {
    // Flush the tab being looked at; its live settings are what the user just
    // adjusted, and inactive tabs are read from their saved view states.
    useImageStore.getState().saveViewState();
    const byId = new Map(collectOpenImages().map((im) => [im.imageId, im]));

    const placed: { wellId: string; row: number; col: number; image: OpenImage }[] = [];
    const closedTabs: string[] = [];
    for (let r = 0; r < format.rows; r++) {
      for (let c = 0; c < format.cols; c++) {
        const wellId = pseudoWellId(r, c);
        const imageId = assign[wellId];
        if (!imageId) continue;
        const image = byId.get(imageId);
        if (!image) { closedTabs.push(wellId); continue; }
        placed.push({ wellId, row: r, col: c, image });
      }
    }
    if (closedTabs.length) {
      setError(
        `閉じられたタブが配置に残っています: ${closedTabs.join(', ')}\n`
        + '該当の位置を選び直してください。PDF は作成していません。',
      );
      return;
    }
    if (placed.length === 0) {
      setError('ファイルが 1 つも配置されていません。各位置のプルダウンでファイルを選んでください。');
      return;
    }
    const noCh = placed.filter(({ image }) => image.channelIdx.length === 0);
    if (noCh.length) {
      setError(
        `表示中のチャンネルがないファイルがあります: ${
          noCh.map((p) => `${p.wellId} ${p.image.filename}`).join('、')}\n`
        + '各ファイルのタブを一度開き、チャンネルを 1 つ以上表示してください。',
      );
      return;
    }
    const outsideInteractive3D = placed.filter(
      ({ image }) => image.channelIdx.some((channel) => channel >= 4),
    );
    if (outsideInteractive3D.length) {
      setError(
        `3D 画面に読み込まれていない5番目以降のチャンネルが選ばれています: ${
          outsideInteractive3D.map((p) => p.wellId).join(', ')}\n`
        + 'PDF と画面が異なる図になるため作成しません。先頭4チャンネル内で表示を調整してください。',
      );
      return;
    }
    // The backend refuses duplicate sources; surface it before any fetch.
    const placedAssign: PseudoAssignments = {};
    for (const p of placed) placedAssign[p.wellId] = p.image.imageId;
    const duplicated = duplicateSourcePositions(
      placedAssign, (id) => byId.get(id)?.sourceIdentity,
    );
    if (duplicated.length) {
      setError(
        `同じ元ファイルが複数の位置に配置されています: ${
          duplicated.map((group) => group.join(' と ')).join('、')}\n`
        + '同一画像を複数ウェルとして示す図になるため作成しません。片方を外してください。',
      );
      return;
    }

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
    const typedName = pdfInputStem(pdfName);
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

    // Claim the run synchronously before the first await.
    if (activePdfRun.current) return;
    const runId = ++pdfRunSeq.current;
    activePdfRun.current = runId;
    cancelRef.current = false;
    setError('');
    setResult('');
    setExporting(true);
    setProgress({ percent: 0, label: '保存先を確認中…' });

    // Freeze figure-wide settings so later edits cannot leak into a slow run.
    const runFormat = format;
    const runPlateName = plateName;
    const runUnifyZoom = unifyZoom;
    const runZoomPercent = runUnifyZoom
      ? Math.round(Number(zoomPercentInput) * 10) / 10
      : 100;
    const runIncludeScalebar = includeScalebar;
    const viewSettings = useViewStore.getState();
    const runScalebar = {
      enabled: runIncludeScalebar,
      requestedUm: viewSettings.scalebarUm,
      color: viewSettings.scalebarColor,
    };
    let completedUnits = 0;
    const completedPercent = () => plateExportPercent(completedUnits, placed.length, 1);
    let publishCompleted = false;
    let completionMessage = '';

    const releaseRun = (keepCompletedProgress = false) => {
      if (activePdfRun.current !== runId) return;
      activePdfRun.current = 0;
      if (!keepCompletedProgress) setProgress(null);
      setExporting(false);
    };
    const runCancelled = () => cancelRef.current || pdfRunSeq.current !== runId;

    if (!job) {
      try {
        const checked = await checkPlatePdfTarget({
          plate_name: runPlateName, output_dir: outputDir, filename: typedName,
        });
        job = {
          outputDir, filename: checked.filename, expectedRevision: checked.revision,
        };
      } catch (e) {
        if (e instanceof OverwriteConflict && pdfRunSeq.current === runId) {
          const summary = { files: e.files, count: e.count, more: e.more };
          setPendingJob({
            outputDir,
            filename: typedName
              || (e.files[0]?.split(/[\\/]/).pop()?.replace(/\.pdf$/i, '') ?? 'plate'),
            expectedRevision: Object.values(e.revisions)[0],
          });
          setNameConflict(summary);
          setConflict(summary);
        } else if (pdfRunSeq.current === runId && !cancelRef.current) {
          setError(e instanceof Error ? e.message : String(e));
        }
        releaseRun();
        return;
      }
      if (runCancelled()) {
        if (pdfRunSeq.current === runId && cancelRef.current) {
          setResult('中止しました。PDF は作成していません。');
        }
        releaseRun();
        return;
      }
      setNameConflict(null);
    }
    if (approvedJob) {
      setConflict(null);
      setPendingJob(null);
      setNameConflict(null);
    }

    const cellPx = PDF_CELL_CHOICES.find((c) => c.key === cellKey)!.px;
    if (runFormat.rows * runFormat.cols * cellPx * cellPx > 250_000_000) {
      setError('このプレートサイズではセル解像度が大きすぎます。1段階下げてください。');
      releaseRun();
      return;
    }
    completedUnits += 1;
    setProgress({ percent: completedPercent(), label: '保存処理を準備中…' });

    // Free the interactive 3D textures before the export needs its own.
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
    const frames: PdfFrame[] = [];
    let renderer: PlateRenderer | null = null;

    try {
      renderer = new PlateRenderer(cellPx);

      for (const [i, p] of placed.entries()) {
        if (runCancelled()) { setResult('中止しました。PDF は作成していません。'); return; }
        const { wellId, image } = p;
        setProgress({
          percent: completedPercent(),
          label: `${wellId} ${image.filename} (${i + 1}/${placed.length}) 保存用データを取得中…`,
        });
        abortRef.current = new AbortController();
        let buf;
        try {
          buf = await fetchPlateVolume({
            path: image.path,
            source_identity: image.sourceIdentity,
            source_revision: image.sourceRevision,
            channels: image.channelIdx,
            levels: image.channelIdx.map((c) => image.channelWindows[c]),
            t: image.t,
            max_xy: maxXy,
          }, abortRef.current.signal);
        } catch (e) {
          // Name the position and file; the shared fetch error does not.
          if (e instanceof DOMException && e.name === 'AbortError') throw e;
          throw new Error(
            `${wellId} ${image.filename}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        if (runCancelled()) { setResult('中止しました。PDF は作成していません。'); return; }
        completedUnits += 1;
        const vol = parseVolume(buf.data, buf.info);
        const requestedZoom = runUnifyZoom
          ? runZoomPercent
          : Number.isFinite(image.view.zoomPercent) && image.view.zoomPercent > 0
            ? image.view.zoomPercent
            : 100;
        setProgress({
          percent: completedPercent(),
          label: `${wellId} ${image.filename} (${i + 1}/${placed.length}) 3D描画中…`,
        });
        const shot = await renderer.render(
          wellId, vol,
          image.channelIdx.map((c) => image.channelColors[c]),
          image.channelIdx.map(() => true),
          image.view.az, image.view.el, requestedZoom, image.zFrac, runScalebar,
        );
        if (runCancelled()) { setResult('中止しました。PDF は作成していません。'); return; }
        let bin = '';
        for (let k = 0; k < shot.png.length; k += 0x8000) {
          bin += String.fromCharCode(...shot.png.subarray(k, k + 0x8000));
        }
        frames.push({
          well_id: wellId, row: p.row, col: p.col, png_b64: btoa(bin),
          source_path: image.path,
          source_identity: buf.info.source_identity,
          source_revision: buf.info.source_revision,
          caption: [image.filename].concat(image.numT > 1 ? [`T${image.t + 1}`] : []),
        });
        completedUnits += 1;
      }

      if (runCancelled()) { setResult('中止しました。PDF は作成していません。'); return; }
      finalizingPdfRef.current = true;
      setFinalizingPdf(true);
      // Every unassigned position is honestly "Empty" — a pseudo plate makes no
      // claim that anything was ever acquired there.
      const states: Record<string, string> = {};
      const placedIds = new Set(placed.map((p) => p.wellId));
      for (const wellId of pseudoPositions(runFormat.rows, runFormat.cols)) {
        if (!placedIds.has(wellId)) states[wellId] = 'empty';
      }
      setProgress({
        percent: completedPercent(),
        label: 'PDFファイルを保存中…（この段階は中止できません）',
      });
      const res = await composePlatePdf({
        plate_name: runPlateName, rows: runFormat.rows, cols: runFormat.cols,
        frames,
        well_states: states, cell_px: cellPx, output_dir: job.outputDir,
        hide_empty_wells: false,
        filename: job.filename,
        overwrite,
        expected_revision: job.expectedRevision,
        table_headers: [],
        table_rows: [],
        // The resolution actually applied, never the one requested.
        footer: `pseudo plate ${runFormat.rows}x${runFormat.cols}`
          + ` | vol ${volKey}(${maxXy})${clamped ? ` GPU上限${max3D}に制限` : ''}`
          + `${placed.some((p) => p.image.numT > 1)
            ? ` | T ${placed.filter((p) => p.image.numT > 1)
              .map((p) => `${p.wellId}:${p.image.t + 1}`).join(',')}` : ''}`
          + ` | zoom ${runUnifyZoom ? `${displayPercent(runZoomPercent)}% unified` : 'per-tab'}`
          + ` | scalebar ${runIncludeScalebar ? 'on(center-depth)' : 'off'}`
          + ` | cell ${cellPx}px | ${placed.length} files | ${new Date().toISOString()}`,
      });
      if (res.wells !== placed.length || !(res.bytes > 0) || !res.path) {
        throw new Error('保存したPDFのウェル数またはファイル情報を検証できません。');
      }
      // The verified publish is the final unit; only now may the bar reach 100%.
      completedUnits += 1;
      publishCompleted = true;
      setProgress({ percent: completedPercent(), label: 'PDF保存完了' });
      completionMessage = `${res.wells} ファイルを ${runFormat.rows}×${runFormat.cols} 配置で`
        + `書き出しました（${Math.round(res.bytes / 1024)} KB）\n${res.path}`
        + (clamped
          ? `\n※ 解像度は この GPU の上限 ${max3D} px に制限しました（${vendor}）。`
          : '');
    } catch (e) {
      if (runCancelled()) setResult('中止しました。PDF は作成していません。');
      else if (e instanceof OverwriteConflict) {
        // Nothing was written; ask before replacing. Confirming re-renders — the
        // honest trade documented in Plate Save: keeping every frame in memory
        // to avoid it is what runs a large export out of room.
        setPendingJob({
          outputDir: job?.outputDir ?? outputDir,
          filename: job?.filename ?? typedName,
          expectedRevision: Object.values(e.revisions)[0],
        });
        setNameConflict({ files: e.files, count: e.count, more: e.more });
        setConflict({ files: e.files, count: e.count, more: e.more });
      } else {
        setError(e instanceof Error ? e.message : String(e));
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

  /** Stop the run: the flag ends the loop, the abort ends the current fetch. */
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
        aria-labelledby="pseudo-plate-dialog-title"
        onClick={requestClose}
      >
        <div
          className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-xl shadow-2xl
                     p-5 max-w-4xl w-full max-h-[calc(100vh-3rem)] overflow-y-auto"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-3">
            <h2 id="pseudo-plate-dialog-title" className="text-sm font-semibold">
              Pseudo Plate（開いているファイル → プレート配置 PDF）
            </h2>
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

          {imageList.length === 0 ? (
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              開いているファイルがありません。先にツールバーの <strong>Open</strong> で
              ファイルを開き、各タブの表示（チャンネル・Min/Max・角度・Z 範囲）を
              調整してから戻ってきてください。
            </p>
          ) : (
            <div>
              <p className="text-[10px] text-[var(--text-secondary)] mb-3 leading-relaxed">
                開いているファイルを選んだプレート形式の位置に並べ、1 つの PDF に書き出します。
                各セルは<strong>画像そのままの矩形</strong>で描画します（円形のウェル型には切り抜きません）。
              </p>

              {cropRect && (
                <p className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] leading-relaxed text-amber-200">
                  クロップ範囲は Pseudo Plate には適用されません。PDF は各ファイル全体を出力します。
                </p>
              )}

              <div className="flex items-end gap-3 flex-wrap mb-3">
                <label className="text-[10px] text-[var(--text-secondary)]">
                  Plate format
                  <select
                    value={formatKey}
                    onChange={(e) => changeFormat(e.target.value)}
                    disabled={uiLocked}
                    className="block mt-1 bg-[var(--bg-primary)] border border-[var(--border)]
                               rounded px-2 py-1 text-xs text-[var(--text-primary)]"
                  >
                    {PSEUDO_FORMATS.map((f) => (
                      <option key={f.key} value={f.key}>{f.label}</option>
                    ))}
                  </select>
                </label>
                <label className="text-[10px] text-[var(--text-secondary)] flex-1 min-w-[12rem]">
                  図のタイトル
                  <input
                    type="text"
                    value={plateName}
                    onChange={(e) => { setPlateName(e.target.value); invalidatePdfTarget(); }}
                    disabled={uiLocked}
                    className="block w-full mt-1 bg-white/10 border border-[var(--text-secondary)]/60
                               rounded px-2 py-1 text-xs text-[var(--text-primary)]
                               focus:outline-none focus:border-[var(--accent)] disabled:opacity-40"
                  />
                </label>
                <div className="text-[10px] text-[var(--text-secondary)] pb-1">
                  配置済み {assignedCount} / {format.rows * format.cols}
                  （開いているファイル {imageList.length}）
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setAssign(prefillAssignments(
                      format.rows, format.cols, imageList.map((item) => item.id),
                    ));
                  }}
                  disabled={uiLocked}
                  className="px-2 py-1 rounded bg-white/10 text-[10px] hover:bg-white/20
                             disabled:opacity-40 transition"
                  title="開いているタブの順に、左上から詰めて配置し直します"
                >
                  開いている順に自動配置
                </button>
                <button
                  type="button"
                  onClick={() => setAssign({})}
                  disabled={uiLocked}
                  className="px-2 py-1 rounded bg-white/10 text-[10px] hover:bg-white/20
                             disabled:opacity-40 transition"
                >
                  全て解除
                </button>
              </div>

              <div className="overflow-x-auto">
                <div
                  className="grid gap-1 items-center min-w-[36rem]"
                  style={{
                    gridTemplateColumns: `1.25rem repeat(${format.cols}, minmax(0, 1fr))`,
                  }}
                >
                  <div />
                  {Array.from({ length: format.cols }, (_, c) => (
                    <div
                      key={`col-${c}`}
                      className="text-center text-[10px] text-[var(--text-secondary)]"
                    >
                      {c + 1}
                    </div>
                  ))}
                  {Array.from({ length: format.rows }, (_, r) => (
                    [
                      <div
                        key={`row-${r}`}
                        className="text-center text-[10px] text-[var(--text-secondary)]"
                      >
                        {String.fromCharCode(65 + r)}
                      </div>,
                      ...Array.from({ length: format.cols }, (_, c) => {
                        const wellId = pseudoWellId(r, c);
                        const value = assign[wellId] ?? '';
                        return (
                          <select
                            key={wellId}
                            value={value}
                            onChange={(e) => {
                              setAssign((prev) => assignWithMove(prev, wellId, e.target.value));
                            }}
                            disabled={uiLocked}
                            aria-label={`${wellId} のファイル`}
                            title={value ? labels.get(value) ?? '' : `${wellId}（空）`}
                            className={`w-full min-w-0 truncate rounded border px-1 py-1 text-[10px]
                                       bg-[var(--bg-primary)] text-[var(--text-primary)]
                                       disabled:opacity-40 ${value
                              ? 'border-emerald-600/70'
                              : 'border-[var(--border)] text-[var(--text-secondary)]'}`}
                          >
                            <option value="">（空）</option>
                            {imageList.map((item) => (
                              <option key={item.id} value={item.id}>
                                {(labels.get(item.id) ?? item.filename)
                                  + (item.id === activeImageId ? '（表示中）' : '')}
                              </option>
                            ))}
                          </select>
                        );
                      }),
                    ]
                  ))}
                </div>
              </div>
              <p className="text-[10px] text-[var(--text-secondary)] mt-1 leading-relaxed">
                同じファイルは 1 か所にだけ置けます（別の位置で選ぶと移動します）。
              </p>

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
                        aria-label="Pseudo Plate PDFの統一拡大率"
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
                    ファイル名（省略時はタイトル＋日時）
                    <input
                      type="text"
                      value={pdfName}
                      onChange={(e) => {
                        setPdfName(e.target.value);
                        invalidatePdfTarget();
                      }}
                      onBlur={() => { void probePdfTarget(); }}
                      disabled={uiLocked}
                      placeholder={plateName}
                      className="block w-full mt-1 bg-white/10 border border-[var(--text-secondary)]/60
                                 rounded px-2 py-1 text-xs text-[var(--text-primary)]
                                 placeholder:text-[var(--text-primary)] placeholder:opacity-70
                                 focus:outline-none focus:border-[var(--accent)]
                                 disabled:opacity-40 disabled:cursor-not-allowed"
                    />
                  </label>
                  <button
                    onClick={() => exportPdf(false)}
                    disabled={exporting || assignedCount === 0 || !!conflict
                              || checkingPdfName || pdfBrowsing || !pdfOutputDir.trim()
                              || !!pdfInputProblem(pdfName)
                              || (unifyZoom && !!plateZoomProblem(zoomPercentInput))}
                    className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-medium
                               hover:opacity-90 disabled:opacity-40 transition"
                  >
                    {exporting
                      ? `PDF 保存中 ${progress?.percent ?? 0}%`
                      : `Pseudo Plate PDF を作成（${assignedCount} ファイル）`}
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
                      aria-label="Pseudo Plate PDF保存の進行状況"
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
                  各ファイルは<strong>タブの現在の状態</strong>（表示チャンネル・Min/Max・色・
                  カメラ角度・Z 範囲・T）で 3D パイプラインから描き直します（自動調整はしません）。
                  空にした位置は「Empty」と表示されます。<br />
                  1 ファイルでも描画に失敗したら PDF は作りません
                  （配置したファイルが空セルに見えるのを避けるため）。
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
