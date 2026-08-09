/** Per-image camera and slab state shared by the 3D viewer and plate export. */
export interface Volume3DState {
  az: number;
  el: number;
  radius: number;
  /** 1-based inclusive slice range, matching the control in the 3D panel. */
  zStart: number;
  zEnd: number;
  /**
   * Slices the range is relative to. The interactive volume may be decimated in
   * Z, and the export re-reads at its own resolution, so a slab recorded as
   * "10..30" means nothing without the total it was chosen against.
   */
  zTotal: number;
}

export const DEFAULT_VOLUME_3D: Volume3DState = {
  az: 0, el: 20, radius: 2.5, zStart: 1, zEnd: 1, zTotal: 1,
};

/**
 * Start a newly opened image at the full Z stack without resetting the camera.
 *
 * Carrying the camera to the next well is intentional for plate setup; carrying
 * the previous well's slab is not. Initialising this as soon as metadata is
 * known also means a tab switched away from before 3D was opened saves an
 * honest full-stack range rather than the process-level 1/1/1 placeholder.
 */
export function volume3DForFreshImage(
  current: Volume3DState,
  numZ: number,
): Volume3DState {
  const zTotal = Number.isFinite(numZ) ? Math.max(1, Math.trunc(numZ)) : 1;
  return { ...current, zStart: 1, zEnd: zTotal, zTotal };
}

/**
 * Restore a real per-image view, migrating the old process placeholder when it
 * was saved before the image had ever entered 3D.
 */
export function volume3DForRestoredImage(
  current: Volume3DState,
  saved: Volume3DState | undefined,
  numZ: number,
): Volume3DState {
  if (!saved) return volume3DForFreshImage(current, numZ);

  const uninitialised = numZ > 1
    && saved.zStart === 1
    && saved.zEnd === 1
    && saved.zTotal === 1;
  return uninitialised
    ? volume3DForFreshImage(saved, numZ)
    : { ...saved };
}
