import { create } from 'zustand';

export interface GlobalSaveProgress {
  percent: number;
  label: string;
}

export interface ThreeDSaveOperation extends GlobalSaveProgress {
  token: number;
}

export interface ImageLoadOperation {
  token: number;
  /** Verified milestones, never elapsed-time estimates. */
  completedUnits: number;
  totalUnits: number;
  percent: number;
  label: string;
  itemIndex: number;
  totalItems: number;
}

export interface ImageLoadStart {
  totalUnits: number;
  totalItems: number;
  label: string;
}

export interface ImageLoadUpdate {
  completedUnits: number;
  itemIndex: number;
  label: string;
}

interface OperationStore {
  /** A 3D save owns navigation until its backend request has definitively ended. */
  threeDSave: ThreeDSaveOperation | null;
  beginThreeDSave: (progress: GlobalSaveProgress) => number | null;
  updateThreeDSave: (token: number, progress: GlobalSaveProgress) => void;
  finishThreeDSave: (token: number) => void;
  /** App-lifetime progress for whole-image open/activate operations. */
  imageLoad: ImageLoadOperation | null;
  beginImageLoad: (start: ImageLoadStart) => number | null;
  updateImageLoad: (token: number, update: ImageLoadUpdate) => void;
  finishImageLoad: (token: number) => void;
}

let nextThreeDSaveToken = 0;
let nextImageLoadToken = 0;

const normaliseProgress = (progress: GlobalSaveProgress): GlobalSaveProgress => ({
  percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
  label: progress.label,
});

function imageLoadPercent(completedUnits: number, totalUnits: number): number {
  if (!Number.isFinite(totalUnits) || totalUnits <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((completedUnits / totalUnits) * 100)));
}

/**
 * App-lifetime ownership for 3D saving.
 *
 * Keeping this outside Volume3DViewer matters: that component is keyed by image
 * and is unmounted by view changes. A component-local lock disappeared while
 * the backend was still writing, allowing a second save to target the same files.
 */
export const useOperationStore = create<OperationStore>((set, get) => ({
  threeDSave: null,
  imageLoad: null,

  beginThreeDSave: (progress) => {
    if (get().threeDSave || get().imageLoad) return null;
    const token = ++nextThreeDSaveToken;
    set({ threeDSave: { token, ...normaliseProgress(progress) } });
    return token;
  },

  updateThreeDSave: (token, progress) => {
    if (get().threeDSave?.token !== token) return;
    set({ threeDSave: { token, ...normaliseProgress(progress) } });
  },

  finishThreeDSave: (token) => {
    if (get().threeDSave?.token === token) set({ threeDSave: null });
  },

  beginImageLoad: (start) => {
    if (get().imageLoad || get().threeDSave) return null;
    const totalUnits = Number.isFinite(start.totalUnits)
      ? Math.max(1, Math.trunc(start.totalUnits)) : 1;
    const totalItems = Number.isFinite(start.totalItems)
      ? Math.max(1, Math.trunc(start.totalItems)) : 1;
    const token = ++nextImageLoadToken;
    set({
      imageLoad: {
        token,
        completedUnits: 0,
        totalUnits,
        percent: 0,
        label: start.label,
        itemIndex: 0,
        totalItems,
      },
    });
    return token;
  },

  updateImageLoad: (token, update) => {
    const current = get().imageLoad;
    if (!current || current.token !== token) return;
    // Do not let duplicate/out-of-order async completions move the bar back.
    const requestedUnits = Number.isFinite(update.completedUnits)
      ? Math.min(current.totalUnits, Math.max(0, Math.trunc(update.completedUnits)))
      : current.completedUnits;
    if (requestedUnits < current.completedUnits) return;
    const completedUnits = requestedUnits;
    const requestedItem = Number.isFinite(update.itemIndex)
      ? Math.min(current.totalItems - 1, Math.max(0, Math.trunc(update.itemIndex)))
      : current.itemIndex;
    const itemIndex = Math.max(current.itemIndex, requestedItem);
    set({
      imageLoad: {
        ...current,
        completedUnits,
        percent: imageLoadPercent(completedUnits, current.totalUnits),
        label: update.label,
        itemIndex,
      },
    });
  },

  finishImageLoad: (token) => {
    if (get().imageLoad?.token === token) set({ imageLoad: null });
  },
}));

/** Synchronous, non-React guard for stores and async entry points. */
export const threeDSaveIsBusy = (): boolean => !!useOperationStore.getState().threeDSave;
