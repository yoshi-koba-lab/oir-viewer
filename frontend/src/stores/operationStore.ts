import { create } from 'zustand';

export interface GlobalSaveProgress {
  percent: number;
  label: string;
}

export interface ThreeDSaveOperation extends GlobalSaveProgress {
  token: number;
}

interface OperationStore {
  /** A 3D save owns navigation until its backend request has definitively ended. */
  threeDSave: ThreeDSaveOperation | null;
  beginThreeDSave: (progress: GlobalSaveProgress) => number | null;
  updateThreeDSave: (token: number, progress: GlobalSaveProgress) => void;
  finishThreeDSave: (token: number) => void;
}

let nextThreeDSaveToken = 0;

const normaliseProgress = (progress: GlobalSaveProgress): GlobalSaveProgress => ({
  percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
  label: progress.label,
});

/**
 * App-lifetime ownership for 3D saving.
 *
 * Keeping this outside Volume3DViewer matters: that component is keyed by image
 * and is unmounted by view changes. A component-local lock disappeared while
 * the backend was still writing, allowing a second save to target the same files.
 */
export const useOperationStore = create<OperationStore>((set, get) => ({
  threeDSave: null,

  beginThreeDSave: (progress) => {
    if (get().threeDSave) return null;
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
}));

/** Synchronous, non-React guard for stores and async entry points. */
export const threeDSaveIsBusy = (): boolean => !!useOperationStore.getState().threeDSave;
