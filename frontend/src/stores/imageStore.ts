import { create } from 'zustand';
import type { ImageMetadata, ImageListItem } from '../utils/api';
import { getLutColor, TRANSMITTED_COLOR } from '../utils/colormap';
import { displayScaleFor, planeMax } from '../utils/intensity';

export interface ChannelState {
  visible: boolean;
  color: [number, number, number];
  min: number;
  max: number;
  autoMin: number;
  autoMax: number;
  data: Uint16Array | null;
  /**
   * Whether min/max have been established for this channel (by the first auto
   * levels, by the user, or by restored settings). Tracked explicitly so that
   * `data === null` no longer has to double as "never loaded" — that let a
   * restored view state get its contrast overwritten by auto levels as soon as
   * fresh pixels arrived.
   */
  hasLevels: boolean;
  /**
   * Upper end of the contrast controls for this channel — the data's own scale,
   * not the declared bit depth (see utils/intensity). Grows but never shrinks
   * while stepping through Z, so the slider's scale stays put.
   */
  displayMax: number;
}

export type ProjectionMethod = 'max' | 'min' | 'avg';

export interface ProjectionState {
  active: boolean;
  method: ProjectionMethod;
  zFrom: number; // 0-based
  zTo: number;   // 0-based
}

/** Per-image view state saved when switching images. */
export interface ImageViewState {
  channels: ChannelState[];
  currentZ: number;
  currentT: number;
  showMIP: boolean;
  projection: ProjectionState;
}

interface ImageStore {
  // Multi-image
  imageList: ImageListItem[];
  activeImageId: string | null;
  imageViewStates: Record<string, ImageViewState>;

  // Current image
  metadata: ImageMetadata | null;
  channels: ChannelState[];
  currentZ: number;
  currentT: number;
  showMIP: boolean;
  projection: ProjectionState;
  loading: boolean;
  /** Last load/switch failure, surfaced to the user instead of failing silently. */
  loadError: string | null;

  // Multi-image actions
  setImageList: (list: ImageListItem[]) => void;
  setActiveImageId: (id: string | null) => void;
  saveViewState: () => void;
  restoreViewState: (id: string) => void;
  removeImageState: (id: string) => void;

  // Current image actions
  // Accepts null: closing the last image clears it.
  setMetadata: (m: ImageMetadata | null) => void;
  initChannels: (n: number) => void;
  setChannelData: (c: number, data: Uint16Array, autoMin: number, autoMax: number) => void;
  toggleChannel: (c: number) => void;
  setChannelColor: (c: number, color: [number, number, number]) => void;
  setChannelRange: (c: number, min: number, max: number) => void;
  autoContrastChannel: (c: number) => void;
  autoContrastAll: () => void;
  setCurrentZ: (z: number) => void;
  setCurrentT: (t: number) => void;
  setShowMIP: (mip: boolean) => void;
  setProjection: (p: ProjectionState) => void;
  setLoading: (l: boolean) => void;
  setLoadError: (e: string | null) => void;
}

export const useImageStore = create<ImageStore>((set, get) => ({
  imageList: [],
  activeImageId: null,
  imageViewStates: {},

  metadata: null,
  channels: [],
  currentZ: 0,
  currentT: 0,
  showMIP: false,
  projection: { active: false, method: 'max', zFrom: 0, zTo: 0 },
  loading: false,
  loadError: null,

  setImageList: (list) => set({ imageList: list }),

  setActiveImageId: (id) => set({ activeImageId: id }),

  saveViewState: () => {
    const { activeImageId, channels, currentZ, currentT, showMIP, projection } = get();
    if (!activeImageId) return;
    const states = { ...get().imageViewStates };
    states[activeImageId] = {
      // Drop `data`: keeping every tab's decoded slice here pinned hundreds of MB
      // outside the slice cache's budget. Pixels come back from the cache or the
      // server on restore; `hasLevels` preserves the contrast across that round trip.
      channels: channels.map(ch => ({ ...ch, data: null })),
      currentZ,
      currentT,
      showMIP,
      projection: { ...projection },
    };
    set({ imageViewStates: states });
  },

  restoreViewState: (id) => {
    const saved = get().imageViewStates[id];
    if (saved) {
      // This writes Z/T directly, so clamp here too — the metadata in play may
      // belong to a shallower image than the one the state was saved from.
      const meta = get().metadata;
      const maxZ = (meta?.num_z ?? 1) - 1;
      const maxT = (meta?.num_t ?? 1) - 1;
      set({
        channels: saved.channels.map(ch => ({ ...ch })),
        currentZ: Math.max(0, Math.min(saved.currentZ, maxZ)),
        currentT: Math.max(0, Math.min(saved.currentT, maxT)),
        showMIP: saved.showMIP,
        projection: saved.projection ? { ...saved.projection } : { active: false, method: 'max', zFrom: 0, zTo: 0 },
      });
    }
  },

  removeImageState: (id) => {
    const states = { ...get().imageViewStates };
    delete states[id];
    set({ imageViewStates: states });
  },

  setMetadata: (m) => set({ metadata: m }),

  initChannels: (n) => {
    const meta = get().metadata;
    const channelTypes = meta?.channel_types ?? [];
    const channelColors = meta?.channel_colors ?? [];
    const channelRanges = meta?.channel_ranges ?? [];
    const channels: ChannelState[] = [];
    for (let i = 0; i < n; i++) {
      const isTransmitted = channelTypes[i] === 'transmitted';
      // Priority: file-embedded color > transmitted gray > default LUT
      const fileColor = channelColors[i];
      let color: [number, number, number];
      if (fileColor && fileColor.length === 3) {
        color = fileColor as [number, number, number];
      } else if (isTransmitted) {
        color = TRANSMITTED_COLOR;
      } else {
        color = getLutColor(i);
      }
      // Prefer the display range the microscope recorded, so the image opens
      // looking as it did at acquisition instead of auto-stretched. hasLevels
      // marks it as established so incoming pixels don't overwrite it.
      //
      // This is honoured even when the range covers the whole bit depth, which
      // is what a file records when nobody adjusted the LUT. Falling back to
      // auto levels there was tried and is worse: auto-stretching every channel
      // of a 5-channel stack and adding them saturates the merge to white. Flat
      // is at least what the microscope showed, and the contrast controls are
      // there to fix it.
      const fileRange = channelRanges[i];
      const hasFileRange =
        Array.isArray(fileRange) && fileRange.length === 2 && fileRange[1] > fileRange[0];
      channels.push({
        visible: !isTransmitted,  // DIC/brightfield off by default
        color,
        min: hasFileRange ? fileRange[0] : 0,
        max: hasFileRange ? fileRange[1] : 65535,
        autoMin: 0,
        autoMax: 65535,
        data: null,
        hasLevels: hasFileRange,
        // 0 = nothing measured yet; the first plane sets the real scale.
        displayMax: 0,
      });
    }
    set({ channels });
  },

  setChannelData: (c, data, autoMin, autoMax) => {
    const channels = [...get().channels];
    if (channels[c]) {
      // Adopt the auto levels only until this channel has levels of its own,
      // so a restored view state or a hand-tuned window survives new pixels
      // arriving for a different Z/T.
      const adoptAuto = !channels[c].hasLevels;
      // Widen the controls to fit this plane, never narrow them: stepping
      // through Z would otherwise rescale the slider under the user's hand.
      //
      // An all-zero plane is skipped rather than measured. displayScaleFor(0)
      // means "nothing known, assume the full bit depth", and because the widen
      // is monotonic, scrubbing across one empty slice would otherwise blow the
      // axis out to 4095 permanently and undo the whole point of measuring it.
      const bitDepth = get().metadata?.bit_depth ?? 16;
      const pMax = planeMax(data);
      const displayMax = pMax > 0
        ? Math.max(channels[c].displayMax, displayScaleFor(pMax, bitDepth))
        : channels[c].displayMax;
      channels[c] = {
        ...channels[c],
        data,
        autoMin,
        autoMax,
        displayMax,
        ...(adoptAuto ? { min: autoMin, max: autoMax, hasLevels: true } : {}),
      };
      set({ channels });
    }
  },

  toggleChannel: (c) => {
    const channels = [...get().channels];
    if (channels[c]) {
      channels[c] = { ...channels[c], visible: !channels[c].visible };
      set({ channels });
    }
  },

  setChannelColor: (c, color) => {
    const channels = [...get().channels];
    if (channels[c]) {
      channels[c] = { ...channels[c], color };
      set({ channels });
    }
  },

  setChannelRange: (c, min, max) => {
    const channels = [...get().channels];
    if (channels[c]) {
      // The Min and Max sliders are independent, so Min can be dragged past Max.
      // An inverted window makes the renderer's range negative and blacks the
      // channel out with no feedback — keep them ordered instead.
      const lo = Math.min(min, max);
      const hi = Math.max(min, max);
      channels[c] = { ...channels[c], min: lo, max: hi, hasLevels: true };
      set({ channels });
    }
  },

  autoContrastChannel: (c) => {
    const channels = [...get().channels];
    if (channels[c]) {
      channels[c] = {
        ...channels[c],
        min: channels[c].autoMin,
        max: channels[c].autoMax,
        hasLevels: true,
      };
      set({ channels });
    }
  },

  autoContrastAll: () => {
    const channels = get().channels.map(ch => ({
      ...ch,
      min: ch.autoMin,
      max: ch.autoMax,
      hasLevels: true,
    }));
    set({ channels });
  },

  // Clamp Z/T to the loaded image. Restored settings and stale localStorage can
  // otherwise hold an index past the end of a shallower file, which the backend
  // silently serves as the last slice while the UI reports the wrong plane.
  setCurrentZ: (z) => set((s) => ({
    currentZ: Math.max(0, Math.min(Math.trunc(z), (s.metadata?.num_z ?? 1) - 1)),
  })),
  setCurrentT: (t) => set((s) => ({
    currentT: Math.max(0, Math.min(Math.trunc(t), (s.metadata?.num_t ?? 1) - 1)),
  })),
  setShowMIP: (mip) => set({ showMIP: mip }),
  setProjection: (p) => set({ projection: p }),
  setLoading: (l) => set({ loading: l }),
  setLoadError: (e) => set({ loadError: e }),
}));
