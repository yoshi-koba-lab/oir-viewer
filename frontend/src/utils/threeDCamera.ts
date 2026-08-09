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
