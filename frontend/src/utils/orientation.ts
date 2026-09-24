/**
 * Display orientation of an image: a clockwise rotation plus flips.
 *
 * The backend applies it to every plane it serves and reports it in the
 * image metadata, so the frontend only mirrors that value; nothing here turns
 * pixels. The identity is the stored order — for .oir files the orientation
 * of the MATL plate map — and these controls exist so a figure can match the
 * acquisition software's own presentation when that is wanted.
 */

export type OrientationRotation = 0 | 90 | 180 | 270;

export interface Orientation {
  /** Clockwise, in degrees. */
  rotation: OrientationRotation;
  /** Mirror left–right, applied in the stored frame before the rotation. */
  flipH: boolean;
  /** Mirror top–bottom, applied in the stored frame before the rotation. */
  flipV: boolean;
}

export const ORIENTATION_ROTATIONS: OrientationRotation[] = [0, 90, 180, 270];

export const IDENTITY_ORIENTATION: Orientation = { rotation: 0, flipH: false, flipV: false };

/** A canonical orientation from anything the API or an old record may hold. */
export function normalizeOrientation(raw: unknown): Orientation {
  if (!raw || typeof raw !== 'object') return { ...IDENTITY_ORIENTATION };
  const o = raw as Partial<Record<keyof Orientation, unknown>>;
  const rotation = ORIENTATION_ROTATIONS.includes(o.rotation as OrientationRotation)
    ? (o.rotation as OrientationRotation)
    : 0;
  return { rotation, flipH: o.flipH === true, flipV: o.flipV === true };
}

export function sameOrientation(a: Orientation, b: Orientation): boolean {
  return a.rotation === b.rotation && a.flipH === b.flipH && a.flipV === b.flipV;
}

export function isIdentityOrientation(o: Orientation): boolean {
  return sameOrientation(o, IDENTITY_ORIENTATION);
}

/** Whether width and height trade places (90° or 270°). */
export function orientationSwapsAxes(o: Orientation): boolean {
  return o.rotation === 90 || o.rotation === 270;
}

/** Short label for the toolbar: '' for the identity, else e.g. '90°・上下'. */
export function orientationLabel(o: Orientation): string {
  const parts: string[] = [];
  if (o.rotation) parts.push(`${o.rotation}°`);
  if (o.flipV) parts.push('上下');
  if (o.flipH) parts.push('左右');
  return parts.join('・');
}
