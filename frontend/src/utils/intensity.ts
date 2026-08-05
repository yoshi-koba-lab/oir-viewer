/**
 * How wide the contrast controls should be for a channel.
 *
 * The Min/Max sliders and the histogram used to span the declared bit depth,
 * which is not where the data is. A 12-bit file whose channel actually tops out
 * around 600 got a 0..4095 slider: 86% of the travel did nothing, the histogram
 * was an invisible sliver at the left edge, and the controls read as broken.
 *
 * The backend already does this for its own histogram (processor._data_upper_bound);
 * this is the same rule on the client, applied to the sliders as well so the
 * handles and the histogram share one axis.
 */

/** Full-scale values of the bit depths microscopes actually produce. */
const FULL_SCALES = [255, 1023, 4095, 16383, 65535];

/** Full scale of a declared bit depth, guarded against absurd values. */
export function fullScaleFor(bitDepth: number): number {
  const depth = Math.max(1, Math.min(16, Math.round(bitDepth) || 16));
  return (1 << depth) - 1;
}

/**
 * Snap a channel's observed maximum up to the nearest real full scale, never
 * exceeding what the declared bit depth allows.
 *
 * Snapping rather than using the raw maximum keeps the axis steady while the
 * user scrubs through Z: a per-slice maximum would make the slider's scale —
 * and so every handle position — twitch on every step.
 */
export function displayScaleFor(dataMax: number, bitDepth: number): number {
  const cap = fullScaleFor(bitDepth);
  if (!(dataMax > 0)) return cap;
  for (const scale of FULL_SCALES) {
    if (dataMax <= scale) return Math.min(scale, cap);
  }
  return cap;
}

/** Largest value in a plane. Sampled on big planes — an exact max is not needed. */
export function planeMax(data: Uint16Array): number {
  const stride = data.length > 4_000_000 ? 4 : 1;
  let max = 0;
  for (let i = 0; i < data.length; i += stride) {
    if (data[i] > max) max = data[i];
  }
  return max;
}

/**
 * The scale to show a channel at, given what has been measured so far.
 *
 * 0 means "no plane seen yet" — fall back to the declared bit depth. It must
 * start at 0 rather than at the full scale: the measured scale only ever widens
 * (so the slider does not rescale as the user steps through Z), and seeding it
 * with the cap would mean it could never narrow to the data at all.
 */
export function effectiveScale(displayMax: number | undefined, bitDepth: number): number {
  return displayMax && displayMax > 0 ? displayMax : fullScaleFor(bitDepth);
}

/**
 * Upper end of the contrast controls: the data's scale, widened if the current
 * window reaches past it.
 *
 * The window can legitimately sit above the data — a file that recorded a
 * full-range LUT opens at 0..4095 whatever the pixels do — and an axis that
 * could not represent the current value would leave the handle pinned off the
 * end of a track it can never return to. Because both terms are snapped to a
 * full scale, pulling the window down into the data rescales the axis once, at
 * a threshold, rather than sliding under the cursor.
 */
export function controlScale(
  ch: { max: number; displayMax?: number },
  bitDepth: number,
): number {
  return Math.max(
    effectiveScale(ch.displayMax, bitDepth),
    displayScaleFor(ch.max, bitDepth),
  );
}
