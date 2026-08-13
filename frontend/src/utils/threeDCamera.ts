/** Pure camera-fit math shared by the interactive viewer and Plate Save. */

export const DEFAULT_VOLUME_FIT_FRACTION = 0.94;
export const MIN_VOLUME_ZOOM_PERCENT = 10;
export const MAX_VOLUME_ZOOM_PERCENT = 1000;

export interface VolumeCameraFitInput {
  /** Physical box dimensions normalised so the largest dimension is 1. */
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  azDeg: number;
  elDeg: number;
  fovDeg: number;
  aspect: number;
  /** Fraction of the limiting viewport dimension occupied at 100%. */
  fitFraction?: number;
  near?: number;
}

export interface VolumePhysicalGeometry {
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  /** Physical length of one normalised world unit; zero means uncalibrated. */
  maxDimUm: number;
  calibrated: boolean;
}

/** A crop rectangle in source-image pixel coordinates. */
export interface VolumeCameraCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The box and target used when a source-image crop is fitted in the 3D view.
 *
 * The ray marcher still renders the complete Z stack.  A crop is therefore a
 * camera-space framing operation: X/Y are narrowed to the selected source
 * fraction while Z remains the full physical depth.  `target` is in the same
 * [0, 1] world space as the viewer's translated box, allowing an off-centre
 * rectangle to be centred without moving the mesh or changing ray coordinates.
 */
export interface VolumeCameraCropFit {
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  target: Vec3;
}

export interface VolumeViewportRect {
  /** CSS-pixel bounds of the projected physical volume in its canvas. */
  x: number;
  y: number;
  width: number;
  height: number;
}

type Vec3 = [number, number, number];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalise(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 1e-12
    ? [v[0] / length, v[1] / length, v[2] / length]
    : [1, 0, 0];
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Derive the physical box and camera pivot for a source-pixel crop.
 *
 * Invalid dimensions/rectangles throw rather than silently fitting the full
 * image. This mirrors export's fail-closed crop contract and makes a stale
 * source owner visible to callers before the camera is changed.
 */
export function volumeCameraCropFit(
  input: Pick<VolumeCameraFitInput, 'scaleX' | 'scaleY' | 'scaleZ'>,
  crop: VolumeCameraCropRect,
  sourceWidth: number,
  sourceHeight: number,
): VolumeCameraCropFit {
  const width = Math.trunc(sourceWidth);
  const height = Math.trunc(sourceHeight);
  if (width <= 0 || height <= 0
      || ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)
      || !(crop.width > 0) || !(crop.height > 0)
      || crop.x < 0 || crop.y < 0
      || crop.x + crop.width > width
      || crop.y + crop.height > height) {
    throw new Error('3Dクロップ範囲が画像の範囲外です。クロップ範囲を設定し直してください。');
  }
  const x0 = crop.x / width;
  const y0 = crop.y / height;
  const sx = crop.width / width;
  const sy = crop.height / height;
  const fullX = finitePositive(input.scaleX, 1);
  const fullY = finitePositive(input.scaleY, 1);
  const fullZ = finitePositive(input.scaleZ, 1);
  return {
    scaleX: fullX * sx,
    scaleY: fullY * sy,
    scaleZ: fullZ,
    target: [
      (1 - fullX) * 0.5 + fullX * (x0 + sx * 0.5),
      (1 - fullY) * 0.5 + fullY * (y0 + sy * 0.5),
      (1 - fullZ) * 0.5 + fullZ * 0.5,
    ],
  };
}

/**
 * Build honest display proportions without inventing a physical calibration.
 * If any axis spacing is absent, voxel counts are still useful for framing but
 * maxDimUm stays zero so a scale bar can never be displayed or exported.
 */
export function volumePhysicalGeometry(
  width: number,
  height: number,
  depth: number,
  pixelSizeXUm: number,
  pixelSizeYUm: number,
  pixelSizeZUm: number,
): VolumePhysicalGeometry {
  const dimensions = [width, height, depth].map((value) => finitePositive(value, 1));
  const calibrated = [pixelSizeXUm, pixelSizeYUm, pixelSizeZUm]
    .every((value) => Number.isFinite(value) && value > 0);
  const spacing = calibrated
    ? [pixelSizeXUm, pixelSizeYUm, pixelSizeZUm]
    : [1, 1, 1];
  const physical = dimensions.map((value, index) => value * spacing[index]);
  const maxDim = Math.max(...physical);
  return {
    scaleX: physical[0] / maxDim,
    scaleY: physical[1] / maxDim,
    scaleZ: physical[2] / maxDim,
    maxDimUm: calibrated ? maxDim : 0,
    calibrated,
  };
}

function cameraBasis(azDeg: number, elDeg: number): {
  outward: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
} {
  const az = (Number.isFinite(azDeg) ? azDeg : 0) * Math.PI / 180;
  const el = Math.max(-89.9, Math.min(89.9, Number.isFinite(elDeg) ? elDeg : 0))
    * Math.PI / 180;
  const outward: Vec3 = [
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az),
  ];
  const forward: Vec3 = [-outward[0], -outward[1], -outward[2]];
  let right = cross(forward, [0, 1, 0]);
  if (Math.hypot(...right) < 1e-8) right = cross(forward, [0, 0, 1]);
  right = normalise(right);
  const up = normalise(cross(right, forward));
  return { outward, forward, right, up };
}

function boxCorners(input: VolumeCameraFitInput): Vec3[] {
  const hx = finitePositive(input.scaleX, 1) / 2;
  const hy = finitePositive(input.scaleY, 1) / 2;
  const hz = finitePositive(input.scaleZ, 1) / 2;
  const corners: Vec3[] = [];
  for (const x of [-hx, hx]) {
    for (const y of [-hy, hy]) {
      for (const z of [-hz, hz]) corners.push([x, y, z]);
    }
  }
  return corners;
}

function sourcePlaneCorners(input: VolumeCameraFitInput): Vec3[] {
  const hx = finitePositive(input.scaleX, 1) / 2;
  const hy = finitePositive(input.scaleY, 1) / 2;
  return [[-hx, -hy, 0], [-hx, hy, 0], [hx, -hy, 0], [hx, hy, 0]];
}

/**
 * Project the physical source X/Y plane into a canvas.
 *
 * The 3D crop overlay edits source X/Y coordinates, but the rendered volume is
 * not necessarily canvas-sized: an anisotropic sample is letterboxed whenever
 * the limiting camera dimension is the other axis.  Mapping the overlay to the
 * full canvas makes drags in black margins select arbitrary source pixels.  Use
 * the same perspective basis as camera fitting and project the four corners of
 * the source plane to obtain its projected bounds for the current
 * view. The center plane is intentional: under perspective, the front/back
 * volume corners have different magnification and cannot be mapped back to one
 * source-pixel coordinate system. The crop editor is about source X/Y, not the
 * Z silhouette.
 */
export function volumeViewportRect(
  input: Pick<VolumeCameraFitInput, 'scaleX' | 'scaleY' | 'scaleZ' | 'azDeg' | 'elDeg' | 'fovDeg' | 'aspect'> & {
    radius: number;
    viewportWidth: number;
    viewportHeight: number;
  },
): VolumeViewportRect {
  const viewportWidth = finitePositive(input.viewportWidth, 0);
  const viewportHeight = finitePositive(input.viewportHeight, 0);
  const radius = finitePositive(input.radius, 0);
  if (!(viewportWidth > 0) || !(viewportHeight > 0) || !(radius > 0)) {
    throw new Error('3D表示領域のサイズが不正です。');
  }
  const fov = Math.max(1, Math.min(179, finitePositive(input.fovDeg, 45))) * Math.PI / 180;
  const aspect = finitePositive(input.aspect, viewportWidth / viewportHeight);
  const tanV = Math.tan(fov / 2);
  const tanH = tanV * aspect;
  const { outward, right, up } = cameraBasis(input.azDeg, input.elDeg);
  const points = sourcePlaneCorners(input).map((offset) => {
    // Camera is target + outward*radius and looks back at target.  Positive
    // viewDepth is therefore radius minus the corner's outward projection.
    const viewDepth = radius - dot(offset, outward);
    if (!(viewDepth > 1e-9)) {
      throw new Error('3D表示カメラがボリューム内部にあります。');
    }
    const ndcX = dot(offset, right) / (viewDepth * tanH);
    const ndcY = dot(offset, up) / (viewDepth * tanV);
    return {
      x: viewportWidth * (0.5 + ndcX * 0.5),
      y: viewportHeight * (0.5 - ndcY * 0.5),
    };
  });
  const x0 = Math.min(...points.map((point) => point.x));
  const x1 = Math.max(...points.map((point) => point.x));
  const y0 = Math.min(...points.map((point) => point.y));
  const y1 = Math.max(...points.map((point) => point.y));
  if (!(x1 > x0) || !(y1 > y0)) throw new Error('3D表示領域を計算できません。');
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Distance at which every corner of the physically-scaled box fits in view.
 *
 * Perspective is handled corner by corner, including each corner's depth; a
 * bounding sphere would waste most of the viewport for a thin anisotropic Z
 * stack. The result is deterministic for an angle, aspect ratio and box shape.
 */
export function fitVolumeCameraRadius(input: VolumeCameraFitInput): number {
  const fov = Math.max(1, Math.min(179, finitePositive(input.fovDeg, 45)))
    * Math.PI / 180;
  const aspect = finitePositive(input.aspect, 1);
  const fill = Math.max(0.1, Math.min(1, finitePositive(
    input.fitFraction ?? DEFAULT_VOLUME_FIT_FRACTION,
    DEFAULT_VOLUME_FIT_FRACTION,
  )));
  const near = finitePositive(input.near ?? 0.01, 0.01);
  const tanV = Math.tan(fov / 2) * fill;
  const tanH = tanV * aspect;
  const { outward, right, up } = cameraBasis(input.azDeg, input.elDeg);

  let radius = near;
  for (const corner of boxCorners(input)) {
    const towardCamera = dot(corner, outward);
    radius = Math.max(
      radius,
      towardCamera + Math.abs(dot(corner, right)) / tanH,
      towardCamera + Math.abs(dot(corner, up)) / tanV,
      towardCamera + near,
    );
  }
  return radius;
}

/** Smallest distance that keeps the camera and its near plane outside the box. */
export function minimumVolumeCameraRadius(input: VolumeCameraFitInput): number {
  const near = finitePositive(input.near ?? 0.01, 0.01);
  const { outward } = cameraBasis(input.azDeg, input.elDeg);
  const support = boxCorners(input).reduce(
    (largest, corner) => Math.max(largest, dot(corner, outward)),
    0,
  );
  return support + near * 2;
}

export function volumeZoomPercentForRadius(fitRadius: number, radius: number): number {
  const fit = finitePositive(fitRadius, 1);
  const actual = finitePositive(radius, fit);
  return (fit / actual) * 100;
}

export function volumeRadiusForZoomPercent(
  fitRadius: number,
  zoomPercent: number,
  minimumRadius = 0,
): number {
  const fit = finitePositive(fitRadius, 1);
  const zoom = Math.max(
    MIN_VOLUME_ZOOM_PERCENT,
    Math.min(MAX_VOLUME_ZOOM_PERCENT, finitePositive(zoomPercent, 100)),
  );
  return Math.max(finitePositive(minimumRadius, Number.EPSILON), fit * 100 / zoom);
}

/** Resolve a user zoom to a safe radius and report the effective clamped value. */
export function resolveVolumeCameraZoom(
  input: VolumeCameraFitInput,
  requestedZoomPercent: number,
): { fitRadius: number; radius: number; zoomPercent: number; maxZoomPercent: number } {
  const fitRadius = fitVolumeCameraRadius(input);
  const minimumRadius = minimumVolumeCameraRadius(input);
  const safeMaximum = Math.min(
    MAX_VOLUME_ZOOM_PERCENT,
    volumeZoomPercentForRadius(fitRadius, minimumRadius),
  );
  const maxZoomPercent = Math.max(MIN_VOLUME_ZOOM_PERCENT, safeMaximum);
  const requested = Math.max(
    MIN_VOLUME_ZOOM_PERCENT,
    Math.min(maxZoomPercent, finitePositive(requestedZoomPercent, 100)),
  );
  const radius = volumeRadiusForZoomPercent(fitRadius, requested, minimumRadius);
  return {
    fitRadius,
    radius,
    zoomPercent: volumeZoomPercentForRadius(fitRadius, radius),
    maxZoomPercent,
  };
}
