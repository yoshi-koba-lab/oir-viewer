import { useEffect, useRef, useState } from 'react';
import { useImageStore } from '../stores/imageStore';
import { effectiveScale } from '../utils/intensity';

interface Props {
  channelIndex: number;
}

const PLOT_WIDTH = 200;
const PLOT_HEIGHT = 40;

/**
 * One bin per pixel column, as before — but a constant rather than a read of
 * `canvas.width`, because the counts are now computed before any canvas is
 * touched. The `width` attribute below is set from the same constant, so the
 * two cannot drift, and the bin count never waits on layout.
 */
const BINS = PLOT_WIDTH;

/**
 * The counts for one raw plane on one axis. `logCounts`/`maxLog` are the form
 * the plot actually uses; they are cached with the counts so that moving a
 * marker does not redo 200 logarithms and the spread over them.
 */
interface BinnedPlane {
  counts: Float64Array;
  logCounts: Float64Array;
  maxLog: number;
  /** The axis these were binned against — a repaint on a different one is refused. */
  maxIntensity: number;
}

/**
 * Keyed weakly by the plane itself: the planes are views onto one ~81 MiB
 * response buffer, so a superseded Z slice has to be free to go and take its
 * counts with it. `BinnedPlane` deliberately holds no reference back.
 *
 * A plane's identity is taken to determine its contents. That is the assumption
 * the compositor's `channels` memo already makes, and nothing in the pipeline
 * writes into a plane in place.
 */
const binCache = new WeakMap<Uint16Array, Map<string, BinnedPlane>>();

/**
 * The Stage A gate is a scan *count* ("0 raw scans over 100 Min/Max, colour and
 * visibility changes"), which a flame chart can only be squinted at. One User
 * Timing entry per pass makes it something a test can assert on.
 */
const SCAN_MARK = 'histogram-scan-start';
const SCAN_MEASURE = 'histogram-scan';

function binPlane(data: Uint16Array, maxIntensity: number): BinnedPlane {
  performance.mark(SCAN_MARK);

  const counts = new Float64Array(BINS);
  const binSize = (maxIntensity + 1) / BINS;

  for (let i = 0; i < data.length; i++) {
    const val = Math.min(data[i], maxIntensity);
    const bin = Math.min(BINS - 1, Math.floor(val / binSize));
    counts[bin]++;
  }

  // Use log scale for better visualization
  const logCounts = new Float64Array(BINS);
  for (let i = 0; i < BINS; i++) {
    logCounts[i] = counts[i] > 0 ? Math.log(counts[i]) : 0;
  }

  performance.measure(SCAN_MEASURE, SCAN_MARK);
  performance.clearMarks(SCAN_MARK);

  return { counts, logCounts, maxLog: Math.max(...logCounts), maxIntensity };
}

function binnedPlane(data: Uint16Array, maxIntensity: number): BinnedPlane {
  let byAxis = binCache.get(data);
  if (!byAxis) {
    byAxis = new Map();
    binCache.set(data, byAxis);
  }
  // The bin count is in the key as well as the axis: it is fixed today, but a
  // wider plot must not be served another width's counts.
  const key = `${BINS}|${maxIntensity}`;
  let binned = byAxis.get(key);
  if (!binned) {
    binned = binPlane(data, maxIntensity);
    byAxis.set(key, binned);
  }
  return binned;
}

export function Histogram({ channelIndex }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ch = useImageStore((s) => s.channels[channelIndex]);
  // Same axis as the Min/Max sliders, so the handles line up with the data.
  // Spanning the declared bit depth instead squeezed the whole distribution
  // into the leftmost few pixels of the plot.
  const bitDepth = useImageStore((s) => s.metadata?.bit_depth ?? 16);
  const maxIntensity = effectiveScale(ch?.controlMax, bitDepth);

  const [binned, setBinned] = useState<BinnedPlane | null>(null);

  // The scan is the entire cost of this component, and the contrast window is
  // not one of its inputs. Keyed on the channel object it ran again for every
  // slider tick — `setChannelRange` hands back a new object each time — so
  // dragging a dashed line two pixels reread up to 8.5 M raw values. Keyed on
  // the plane and the axis, a drag rescans nothing; new pixels, a re-fitted
  // axis or a different bin count still do, exactly once each.
  const data = ch?.data ?? null;
  useEffect(() => {
    setBinned(data ? binnedPlane(data, maxIntensity) : null);
  }, [data, maxIntensity]);

  // The cheap half: 200 line segments over counts that already exist. It
  // depends on the fields it actually reads rather than on `ch`, so a
  // visibility toggle — which this plot does not show — repaints nothing. The
  // fallbacks are unreachable: with no channel there are no counts to draw.
  const min = ch?.min ?? 0;
  const max = ch?.max ?? 0;
  const [r, g, b] = ch?.color ?? [0, 0, 0];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !binned) return;
    // Counts binned against a different axis would land in the wrong columns.
    // The scan above is already producing the right ones; until they arrive,
    // leave the last good plot up, as this plot has always done while scanning.
    if (binned.maxIntensity !== maxIntensity) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const { logCounts, maxLog } = binned;
    if (maxLog === 0) return;

    // Draw histogram
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.3)`;
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.7)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < logCounts.length; i++) {
      const barH = (logCounts[i] / maxLog) * h;
      ctx.lineTo(i, h - barH);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Draw min/max markers
    const minX = (min / maxIntensity) * w;
    const maxX = (max / maxIntensity) * w;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(minX, 0);
    ctx.lineTo(minX, h);
    ctx.moveTo(maxX, 0);
    ctx.lineTo(maxX, h);
    ctx.stroke();
    ctx.setLineDash([]);
  }, [binned, min, max, r, g, b, maxIntensity]);

  return (
    <canvas
      ref={canvasRef}
      width={PLOT_WIDTH}
      height={PLOT_HEIGHT}
      className="w-full h-10 rounded bg-black/30"
    />
  );
}
