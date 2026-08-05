/**
 * One definition of the scale bar, shared by the 2D, Split, Compare and 3D views.
 *
 * These used to be four independent copies that disagreed: different rounding
 * tables, different target widths (80 px vs 120 px) and different label
 * formatting, so the same image could show "20 µm" in one view and "10 µm" in
 * another. A figure set needs one bar, so the length rule, the label, the font
 * and the colour all live here.
 */

/** Labels are set in Arial so exported figures match the usual journal body font. */
export const SCALEBAR_FONT = 'Arial, Helvetica, sans-serif';

/** Bar colour choices. Hex, because these end up in CSS and in canvas alike. */
export const SCALEBAR_COLORS: { name: string; hex: string }[] = [
  { name: 'White', hex: '#ffffff' },
  { name: 'Black', hex: '#000000' },
  { name: 'Yellow', hex: '#ffff00' },
  { name: 'Orange', hex: '#ffa500' },
  { name: 'Red', hex: '#ff0000' },
  { name: 'Magenta', hex: '#ff00ff' },
  { name: 'Green', hex: '#00ff00' },
  { name: 'Cyan', hex: '#00ffff' },
  { name: 'Blue', hex: '#0064ff' },
  { name: 'Gray', hex: '#b4b4b4' },
];

export const DEFAULT_SCALEBAR_COLOR = '#ffffff';

/** Round to 1, 2 or 5 times a power of ten — the lengths people expect on a figure. */
export function niceScaleLength(targetUm: number): number {
  if (!(targetUm > 0)) return 0;
  const pow = Math.pow(10, Math.floor(Math.log10(targetUm)));
  const frac = targetUm / pow;
  return (frac >= 5 ? 5 : frac >= 2 ? 2 : 1) * pow;
}

/** mm above 1000 µm, nm below 1 µm, so the number stays readable at any zoom. */
export function formatUm(um: number): string {
  if (!(um > 0)) return '';
  if (um >= 1000) return `${(um / 1000).toFixed(um % 1000 === 0 ? 0 : 1)} mm`;
  if (um >= 1) return `${um % 1 === 0 ? um : um.toFixed(1)} µm`;
  return `${(um * 1000).toFixed(0)} nm`;
}

/**
 * Bar length for the current zoom: an explicit request wins, otherwise the
 * nearest nice length to `targetPx` on screen. Returns null only when there is
 * no pixel size, so no physical length can be claimed at all.
 *
 * `maxPx` caps the auto length — zoomed out, a bar aimed at 120 px can end up
 * as wide as the whole image, which reads as a border rather than a scale.
 *
 * Both limits apply to the *auto* length only. An explicit length is the user's
 * own number: shrinking it would be a lie, and dropping the bar when it gets
 * short would make it vanish on zoom-out while the checkbox is still ticked and
 * the field still shows the value they typed. A stubby bar is honest; nothing
 * at all is not.
 */
export function scalebarMetrics(
  pixelSizeUm: number,
  zoom: number,
  requestedUm: number | null,
  targetPx = 120,
  maxPx = Infinity,
): { um: number; px: number } | null {
  if (!(pixelSizeUm > 0) || !(zoom > 0)) return null;
  const umPerScreenPx = pixelSizeUm / zoom;
  if (requestedUm && requestedUm > 0) {
    return { um: requestedUm, px: requestedUm / umPerScreenPx };
  }
  let um = niceScaleLength(Math.min(targetPx, maxPx) * umPerScreenPx);
  // niceScaleLength rounds up as often as down, so one step down may still be
  // needed to get under the cap.
  while (um > 0 && um / umPerScreenPx > maxPx) {
    const next = niceScaleLength(um * 0.99);
    if (!(next > 0) || next >= um) break;
    um = next;
  }
  if (!(um > 0)) return null;
  const px = um / umPerScreenPx;
  return px >= 8 ? { um, px } : null;
}

/**
 * Outline colour for the bar and its label — opposite the bar's own luminance,
 * so a black bar gets a light edge and stays visible on dark signal.
 *
 * Opaque on purpose. A translucent outline reads as a smear rather than an edge,
 * and it is drawn as a hard stroke (never a blurred glow): a soft halo around a
 * dark glyph is a bright cloud that eats the thin strokes and looks out of focus.
 */
export function scalebarOutline(hex: string): string {
  return luminance(hex) > 0.45 ? '#000000' : '#ffffff';
}

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 1; // unparseable → treat as light, i.e. keep the dark outline
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Where the image itself sits inside a viewport, in CSS pixels. Every view
 * centres the image and then applies pan, so the bar can be pinned to the
 * image's own bottom-left corner rather than to the panel's.
 */
export function imageRect(
  viewW: number,
  viewH: number,
  imgW: number,
  imgH: number,
  zoom: number,
  panX: number,
  panY: number,
): { x: number; y: number; w: number; h: number } {
  const w = imgW * zoom;
  const h = imgH * zoom;
  return { x: viewW / 2 - w / 2 + panX, y: viewH / 2 - h / 2 + panY, w, h };
}

/**
 * Bottom-left corner of the image, kept on screen. Zoomed in, the image's real
 * corner is off-panel; pinning the bar there would hide it, so it slides along
 * to the visible edge instead of disappearing.
 */
export function scalebarAnchor(
  rect: { x: number; y: number; w: number; h: number },
  viewW: number,
  viewH: number,
  barW: number,
  barH: number,
  pad = 12,
): { x: number; y: number } {
  const x = clamp(rect.x + pad, pad, Math.max(pad, viewW - barW - pad));
  const y = clamp(rect.y + rect.h - barH - pad, pad, Math.max(pad, viewH - barH - pad));
  return { x, y };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}


/**
 * Where the user dragged the bar to, as a fraction of the image: (0,1) is the
 * bottom-left corner. Fractions rather than pixels so the bar stays on the same
 * part of the sample when the view is panned or zoomed.
 *
 * `fx` is the bar's left end, `fy` its baseline.
 */
export interface ScalebarPos {
  fx: number;
  fy: number;
}

/**
 * Screen position of the bar's left end and baseline. Without a user position
 * it sits `pad` inside the image's bottom-left corner; either way it is kept
 * inside the viewport, since zoomed in the image's own corner is off-screen and
 * a bar pinned there would simply be invisible.
 */
export function scalebarPlacement(
  rect: { x: number; y: number; w: number; h: number },
  pos: ScalebarPos | null,
  viewW: number,
  viewH: number,
  barW: number,
  blockH: number,
  pad = 12,
): { x: number; baseline: number } {
  const x = pos
    ? rect.x + pos.fx * rect.w
    : rect.x + pad;
  const baseline = pos
    ? rect.y + pos.fy * rect.h
    : rect.y + rect.h - pad;
  return {
    x: clamp(x, pad, Math.max(pad, viewW - barW - pad)),
    baseline: clamp(baseline, pad + blockH, Math.max(pad + blockH, viewH - pad)),
  };
}

/** Inverse of scalebarPlacement: a screen point back to image fractions. */
export function scalebarPosFromScreen(
  rect: { x: number; y: number; w: number; h: number },
  x: number,
  baseline: number,
  blockH: number,
): ScalebarPos {
  const w = rect.w > 0 ? rect.w : 1;
  const h = rect.h > 0 ? rect.h : 1;
  // Keep the whole block on the image: the label sits above the baseline, so the
  // baseline cannot go higher than one block from the top.
  return {
    fx: clamp((x - rect.x) / w, 0, 1),
    fy: clamp((baseline - rect.y) / h, Math.min(1, blockH / h), 1),
  };
}

/**
 * Draw the bar and its label into a 2D context with its baseline at (x, y),
 * i.e. (x, y) is the bar's left end. `scale` lets an export render it at the
 * export's resolution rather than the preview's.
 */
export function drawScalebarAt(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  barPx: number,
  um: number,
  color: string,
  scale = 1,
): void {
  const outline = scalebarOutline(color);
  ctx.save();
  ctx.lineCap = 'butt';
  ctx.strokeStyle = outline;
  ctx.lineWidth = 6 * scale;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + barPx, y);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3 * scale;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + barPx, y);
  ctx.stroke();

  const label = formatUm(um);
  ctx.font = `${12 * scale}px ${SCALEBAR_FONT}`;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  // Stroke then fill, with round joins: a hard outline. A blurred shadow behind
  // a dark glyph is a bright cloud that eats the thin strokes and reads as
  // out of focus, which is exactly what a black bar looked like.
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = 3 * scale;
  ctx.strokeStyle = outline;
  ctx.strokeText(label, x, y - 5 * scale);
  ctx.fillStyle = color;
  ctx.fillText(label, x, y - 5 * scale);
  ctx.restore();
}

/**
 * Height of the bar plus its label, in CSS pixels: 12 (label, leading-none) + 4
 * (gap) + 3 (bar). The overlay pins this as an explicit height so the rendered
 * block and this constant cannot drift apart — they are the same number in the
 * drag maths, in the viewport clamp and in the burned-in export, and a mismatch
 * showed up as the bar creeping upward a few pixels on every grab.
 */
export const SCALEBAR_BLOCK_H = 19;
