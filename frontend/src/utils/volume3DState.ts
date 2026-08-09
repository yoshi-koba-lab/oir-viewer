/** Per-image camera and slab state shared by the 3D viewer and plate export. */
export interface Volume3DState {
  az: number;
  el: number;
  radius: number;
  /** 100 = fit the physically-scaled volume to the current viewport. */
  zoomPercent: number;
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
  az: 0, el: 0, radius: 2.5, zoomPercent: 100, zStart: 1, zEnd: 1, zTotal: 1,
};

export type Volume3DCameraState = Pick<
  Volume3DState,
  'az' | 'el' | 'radius' | 'zoomPercent'
>;

/**
 * Snapshot the camera that a newly-mounted viewer must use for its first render.
 *
 * The viewer writes its resolved fit radius back to the image store. Taking this
 * snapshot before the Three.js scene effect runs prevents that first write from
 * replacing a restored tab's angle and zoom with component-local placeholders.
 */
export function volume3DCameraForMount(state: Volume3DState): Volume3DCameraState {
  return {
    az: Number.isFinite(state.az) ? state.az : DEFAULT_VOLUME_3D.az,
    el: Number.isFinite(state.el) ? state.el : DEFAULT_VOLUME_3D.el,
    radius: Number.isFinite(state.radius) && state.radius > 0
      ? state.radius
      : DEFAULT_VOLUME_3D.radius,
    zoomPercent: Number.isFinite(state.zoomPercent) && state.zoomPercent > 0
      ? state.zoomPercent
      : DEFAULT_VOLUME_3D.zoomPercent,
  };
}

function withValidZoom(state: Volume3DState): Volume3DState {
  const value = Number(state.zoomPercent);
  return {
    ...state,
    zoomPercent: Number.isFinite(value) && value > 0 ? value : 100,
  };
}

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
  // A new image starts fitted even if the previous well was inspected zoomed in.
  return { ...withValidZoom(current), zoomPercent: 100, zStart: 1, zEnd: zTotal, zTotal };
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

  const migrated = withValidZoom(saved);

  const uninitialised = numZ > 1
    && migrated.zStart === 1
    && migrated.zEnd === 1
    && migrated.zTotal === 1;
  return uninitialised
    ? { ...migrated, zStart: 1, zEnd: numZ, zTotal: numZ }
    : migrated;
}

/** Preserve the same physical slab fraction when volume sampling changes. */
export function volume3DForResampledVolume(
  current: Volume3DState,
  newTotal: number,
): Volume3DState {
  const oldTotal = Math.max(1, Math.trunc(current.zTotal || 1));
  const targetTotal = Math.max(1, Math.trunc(newTotal || 1));
  const oldStart = Math.max(1, Math.min(oldTotal, Math.trunc(current.zStart || 1)));
  const oldEnd = Math.max(oldStart, Math.min(oldTotal, Math.trunc(current.zEnd || oldTotal)));
  const zStart = Math.max(
    1,
    Math.min(targetTotal, Math.floor(((oldStart - 1) / oldTotal) * targetTotal) + 1),
  );
  const zEnd = Math.max(
    zStart,
    Math.min(targetTotal, Math.ceil((oldEnd / oldTotal) * targetTotal)),
  );
  return { ...current, zStart, zEnd, zTotal: targetTotal };
}
