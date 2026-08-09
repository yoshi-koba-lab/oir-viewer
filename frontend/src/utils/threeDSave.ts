/** Progress for completed save tasks, clamped to an honest 0..100 scale. */
export function completedSavePercent(completed: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
}

export interface ThreeDSaveSnapshot {
  token: number;
  viewRevision: number;
}

/** Synchronous guard that keeps every frame in one save on one visual snapshot. */
export class ThreeDSaveGuard {
  private token = 0;
  private locked = false;

  get isLocked(): boolean { return this.locked; }

  begin(viewRevision: number): ThreeDSaveSnapshot | null {
    if (this.locked) return null;
    this.locked = true;
    return { token: ++this.token, viewRevision };
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
