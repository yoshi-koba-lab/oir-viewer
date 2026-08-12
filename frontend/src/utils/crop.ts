/** Pure crop geometry and pixel helpers shared by preview and export paths. */

/** A crop rectangle in source-image pixel coordinates (left/top + size). */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pixel dimensions of the source image. */
export interface CropBounds {
  width: number;
  height: number;
}

/** A crop rectangle expressed as fractions of the source image. */
export interface NormalizedCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropViewportFit {
  zoom: number;
  panX: number;
  panY: number;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function bound(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}

function dimensions(bounds: CropBounds): CropBounds {
  return {
    width: Math.max(0, Math.trunc(finite(bounds.width, 0))),
    height: Math.max(0, Math.trunc(finite(bounds.height, 0))),
  };
}

/** The complete source image, or an empty rectangle for invalid dimensions. */
export function fullCrop(bounds: CropBounds): CropRect {
  const size = dimensions(bounds);
  return { x: 0, y: 0, width: size.width, height: size.height };
}

/**
 * Clamp a rectangle to the source and convert it to pixel edges.
 *
 * Edges are rounded outwards (floor left/top, ceil right/bottom), so a drag
 * that visibly covers a source pixel never drops that pixel during export.
 * A valid source always yields at least one pixel in each dimension.
 */
export function normalizeCropRect(rect: CropRect, bounds: CropBounds): CropRect {
  const size = dimensions(bounds);
  if (size.width === 0 || size.height === 0) return fullCrop(size);

  const left = finite(rect.x, 0);
  const top = finite(rect.y, 0);
  const right = left + finite(rect.width, size.width);
  const bottom = top + finite(rect.height, size.height);
  const x0 = bound(Math.min(left, right), size.width);
  const y0 = bound(Math.min(top, bottom), size.height);
  const x1 = bound(Math.max(left, right), size.width);
  const y1 = bound(Math.max(top, bottom), size.height);

  // Integer pixel edges are useful for both typed-array slicing and image
  // export dimensions. A tiny/zero drag is represented by one pixel.
  const ix0 = Math.floor(x0);
  const iy0 = Math.floor(y0);
  const ix1 = Math.max(ix0 + 1, Math.ceil(x1));
  const iy1 = Math.max(iy0 + 1, Math.ceil(y1));
  return {
    x: Math.min(ix0, size.width - 1),
    y: Math.min(iy0, size.height - 1),
    width: Math.min(size.width, ix1) - Math.min(ix0, size.width - 1),
    height: Math.min(size.height, iy1) - Math.min(iy0, size.height - 1),
  };
}

/** Build a crop rectangle from two pointer positions in source pixels. */
export function cropRectFromPoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
  bounds: CropBounds,
): CropRect {
  return normalizeCropRect({
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }, bounds);
}

/** Convert a pixel rectangle to stable 0..1 fractions for persisted state. */
export function cropRectToNormalized(
  rect: CropRect,
  bounds: CropBounds,
): NormalizedCropRect {
  const size = dimensions(bounds);
  const normalized = normalizeCropRect(rect, size);
  if (size.width === 0 || size.height === 0) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  return {
    x: normalized.x / size.width,
    y: normalized.y / size.height,
    width: normalized.width / size.width,
    height: normalized.height / size.height,
  };
}

/** Convert persisted 0..1 fractions to a source-pixel rectangle. */
export function cropRectFromNormalized(
  rect: NormalizedCropRect,
  bounds: CropBounds,
): CropRect {
  const size = dimensions(bounds);
  return normalizeCropRect({
    x: finite(rect.x, 0) * size.width,
    y: finite(rect.y, 0) * size.height,
    width: finite(rect.width, 1) * size.width,
    height: finite(rect.height, 1) * size.height,
  }, size);
}

/**
 * Map a source-image crop to the corresponding output framebuffer rectangle.
 *
 * A tilted 3D projection has no one-to-one source-pixel mapping; the trial
 * export therefore uses the same normalized display fraction on its frame.
 * Invalid rectangles throw so an export can fail closed instead of silently
 * writing a full-frame image for a requested crop.
 */
export function cropRectForFrame(
  rect: CropRect | null | undefined,
  sourceWidth: number,
  sourceHeight: number,
  frameWidth: number,
  frameHeight: number,
): CropRect {
  const sourceW = Math.trunc(sourceWidth);
  const sourceH = Math.trunc(sourceHeight);
  const frameW = Math.trunc(frameWidth);
  const frameH = Math.trunc(frameHeight);
  if (!rect) return { x: 0, y: 0, width: frameW, height: frameH };
  if (![sourceW, sourceH, frameW, frameH].every((value) => value > 0)
      || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
      || !(rect.width > 0) || !(rect.height > 0)
      || rect.x < 0 || rect.y < 0
      || rect.x + rect.width > sourceW
      || rect.y + rect.height > sourceH) {
    throw new Error('クロップ範囲が画像の範囲外です。クロップ範囲を設定し直してください。');
  }
  const x = Math.max(0, Math.min(frameW - 1, Math.round((rect.x / sourceW) * frameW)));
  const y = Math.max(0, Math.min(frameH - 1, Math.round((rect.y / sourceH) * frameH)));
  const right = Math.max(x + 1, Math.min(frameW, Math.round(((rect.x + rect.width) / sourceW) * frameW)));
  const bottom = Math.max(y + 1, Math.min(frameH, Math.round(((rect.y + rect.height) / sourceH) * frameH)));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Choose the frame rectangle to read back after rendering.
 *
 * Once the 3D viewer has applied the crop to its shader/camera, the canvas is
 * already the selected image. Cropping that frame a second time would silently
 * remove another fraction of the user's selection. Callers pass
 * `displayAlreadyFitted=true` only after verifying the same source owner and
 * rectangle that were frozen for the save.
 */
export function cropRectForCapture(
  rect: CropRect | null | undefined,
  sourceWidth: number,
  sourceHeight: number,
  frameWidth: number,
  frameHeight: number,
  displayAlreadyFitted = false,
): CropRect {
  const frameW = Math.trunc(frameWidth);
  const frameH = Math.trunc(frameHeight);
  if (displayAlreadyFitted) {
    if (frameW <= 0 || frameH <= 0) {
      throw new Error('3D保存フレームのサイズが不正です。');
    }
    return { x: 0, y: 0, width: frameW, height: frameH };
  }
  return cropRectForFrame(rect, sourceWidth, sourceHeight, frameW, frameH);
}

/** Fit one source-pixel crop into a 2D viewport using the renderer's transform. */
export function fitCropViewport(
  rect: CropRect,
  sourceWidth: number,
  sourceHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  minZoom = 0.1,
  maxZoom = 50,
): CropViewportFit {
  const sourceW = Math.trunc(sourceWidth);
  const sourceH = Math.trunc(sourceHeight);
  if (![sourceW, sourceH, viewportWidth, viewportHeight].every((value) => Number.isFinite(value) && value > 0)
      || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
      || !(rect.width > 0) || !(rect.height > 0)
      || rect.x < 0 || rect.y < 0
      || rect.x + rect.width > sourceW
      || rect.y + rect.height > sourceH) {
    throw new Error('クロップ範囲を表示領域へ合わせられません。範囲を設定し直してください。');
  }
  const lo = Number.isFinite(minZoom) && minZoom > 0 ? minZoom : 0.1;
  const hi = Number.isFinite(maxZoom) && maxZoom >= lo ? maxZoom : Math.max(lo, 50);
  const zoom = Math.max(lo, Math.min(
    hi,
    viewportWidth / rect.width,
    viewportHeight / rect.height,
  ));
  const cropCenterX = rect.x + rect.width / 2;
  const cropCenterY = rect.y + rect.height / 2;
  return {
    zoom,
    panX: (sourceW / 2 - cropCenterX) * zoom,
    panY: (sourceH / 2 - cropCenterY) * zoom,
  };
}

/** Extract one Uint16 image plane using a normalized, integer crop rectangle. */
export function cropPlane(
  data: Uint16Array,
  sourceWidth: number,
  sourceHeight: number,
  rect: CropRect,
): Uint16Array {
  const bounds = { width: sourceWidth, height: sourceHeight };
  const crop = normalizeCropRect(rect, bounds);
  const expected = Math.max(0, Math.trunc(sourceWidth)) * Math.max(0, Math.trunc(sourceHeight));
  if (data.length < expected) {
    throw new Error(`Crop source has ${data.length} pixels; expected at least ${expected}`);
  }
  const output = new Uint16Array(crop.width * crop.height);
  for (let row = 0; row < crop.height; row++) {
    const from = (crop.y + row) * Math.trunc(sourceWidth) + crop.x;
    output.set(data.subarray(from, from + crop.width), row * crop.width);
  }
  return output;
}
