/** Progress for completed save tasks, clamped to an honest 0..100 scale. */
export function completedSavePercent(completed: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
}

/** Source-pixel crop frozen at the start of one 3D save. */
export interface ThreeDSaveCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Provenance of the active image whose rendered frame is being saved. */
export interface ThreeDSaveCropOwner {
  imageId: string | null;
  sourceIdentity: string | null;
  sourceRevision: string | null;
  width: number;
  height: number;
}

export interface ThreeDSaveSnapshot {
  token: number;
  viewRevision: number;
  /** A copied rect; null means the full frame. */
  cropRect: ThreeDSaveCropRect | null;
  /** The source and geometry against which that rect was selected. */
  cropOwner: ThreeDSaveCropOwner;
}

function sameCropRect(
  a: ThreeDSaveCropRect | null,
  b: ThreeDSaveCropRect | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function sameCropOwner(a: ThreeDSaveCropOwner, b: ThreeDSaveCropOwner): boolean {
  return a.imageId === b.imageId
    && a.sourceIdentity === b.sourceIdentity
    && a.sourceRevision === b.sourceRevision
    && a.width === b.width
    && a.height === b.height;
}

/**
 * Verify that a frame is still from the source/crop captured at save start.
 * Keeping this pure makes the fail-closed boundary testable without WebGL.
 */
export function ownsThreeDSaveCrop(
  snapshot: ThreeDSaveSnapshot,
  cropRect: ThreeDSaveCropRect | null,
  cropOwner: ThreeDSaveCropOwner,
): boolean {
  return sameCropRect(snapshot.cropRect, cropRect)
    && sameCropOwner(snapshot.cropOwner, cropOwner);
}

/** Synchronous guard that keeps every frame in one save on one visual snapshot. */
export class ThreeDSaveGuard {
  private token = 0;
  private locked = false;

  get isLocked(): boolean { return this.locked; }

  begin(
    viewRevision: number,
    cropRect: ThreeDSaveCropRect | null = null,
    cropOwner: ThreeDSaveCropOwner = {
      imageId: null,
      sourceIdentity: null,
      sourceRevision: null,
      width: 0,
      height: 0,
    },
  ): ThreeDSaveSnapshot | null {
    if (this.locked) return null;
    this.locked = true;
    return {
      token: ++this.token,
      viewRevision,
      cropRect: cropRect ? { ...cropRect } : null,
      cropOwner: { ...cropOwner },
    };
  }

  owns(snapshot: ThreeDSaveSnapshot, currentViewRevision: number): boolean {
    return this.locked
      && snapshot.token === this.token
      && snapshot.viewRevision === currentViewRevision;
  }

  finish(snapshot: ThreeDSaveSnapshot): void {
    if (snapshot.token === this.token) this.locked = false;
  }
}
