import { create } from 'zustand';
import type { ImageMetadata, ImageListItem, SavedImageView } from '../utils/api';
import { getLutColor, TRANSMITTED_COLOR } from '../utils/colormap';
import { displayScaleFor, effectiveScale, planeMax } from '../utils/intensity';
import {
  DEFAULT_VOLUME_3D,
  volume3DForFreshImage,
  volume3DForRestoredImage,
  type Volume3DState,
} from '../utils/volume3DState';

export { DEFAULT_VOLUME_3D } from '../utils/volume3DState';
export type { Volume3DState } from '../utils/volume3DState';

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
  /**
   * Upper end of the Min/Max track. Deliberately NOT derived from `max` on every
   * render: doing that rescaled the track mid-drag — pulling Max down past the
   * data's scale shrank the axis, so the thumb jumped right while the pointer
   * kept going left and the value landed nowhere near the cursor. The track is
   * re-fitted when pixels arrive and on Auto, and otherwise only ever widens.
   * 0 = not fitted yet.
   */
  controlMax: number;
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
  volume3D: Volume3DState;
}

/** The exact display state before any persisted user override was applied. */
export interface SourceViewDefaults {
  channels: ChannelState[];
  currentZ: number;
  currentT: number;
  showMIP: boolean;
  projection: ProjectionState;
  volume3D: Volume3DState;
}

/** Decoded pixels plus the auto window that belongs to that exact plane. */
export interface PreparedChannelResponse {
  channels: Array<{
    channel: number;
    data: Uint16Array;
    auto_min: number;
    auto_max: number;
  }>;
}

/** Coordinates whose decoded response was verified before it is presented. */
export interface PreparedImageView {
  currentZ: number;
  currentT: number;
  showMIP: boolean;
  projection: ProjectionState;
}

export interface PreparedImagePresentation {
  id: string;
  metadata: ImageMetadata;
  sourceResponse: PreparedChannelResponse;
  targetResponse: PreparedChannelResponse;
  view: PreparedImageView;
  sessionState?: ImageViewState;
  persistedSettings?: SavedImageView;
}

interface ImageStore {
  // Multi-image
  imageList: ImageListItem[];
  activeImageId: string | null;
  imageViewStates: Record<string, ImageViewState>;
  sourceViewDefaults: Record<string, SourceViewDefaults>;

  // Current image
  metadata: ImageMetadata | null;
  channels: ChannelState[];
  currentZ: number;
  currentT: number;
  showMIP: boolean;
  projection: ProjectionState;
  volume3D: Volume3DState;
  loading: boolean;
  /** Last load/switch failure, surfaced to the user instead of failing silently. */
  loadError: string | null;

  // Multi-image actions
  setImageList: (list: ImageListItem[]) => void;
  setActiveImageId: (id: string | null) => void;
  saveViewState: () => void;
  saveViewStateIfSource: (id: string, sourceIdentity: string, sourceRevision: string) => boolean;
  restoreViewState: (id: string) => void;
  presentPreparedImage: (presentation: PreparedImagePresentation) => void;
  removeImageState: (id: string) => void;
  captureSourceDefaults: () => void;
  resetActiveImageToSource: (includeVolume3D?: boolean) => boolean;

  // Current image actions
  // Accepts null: closing the last image clears it.
  setMetadata: (m: ImageMetadata | null) => void;
  initChannels: (n: number) => void;
  setChannelData: (c: number, data: Uint16Array, autoMin: number, autoMax: number) => void;
  toggleChannel: (c: number) => void;
  setChannelColor: (c: number, color: [number, number, number]) => void;
  setChannelRange: (c: number, min: number, max: number) => void;
  /**
   * Set several channels' windows on one image — the active one or a
   * background tab that has been shown at least once. Returns false when the
   * tab has no established state to edit (never displayed).
   */
  applyChannelRanges: (
    id: string,
    updates: { channel: number; min: number; max: number }[],
  ) => boolean;
  autoContrastChannel: (c: number) => void;
  autoContrastAll: () => void;
  setCurrentZ: (z: number) => void;
  setCurrentT: (t: number) => void;
  setShowMIP: (mip: boolean) => void;
  setProjection: (p: ProjectionState) => void;
  setVolume3D: (v: Partial<Volume3DState>) => void;
  setLoading: (l: boolean) => void;
  setLoadError: (e: string | null) => void;
}

/** One channel with a new window, ordered, established, and track-widened. */
function channelWithRange(
  ch: ChannelState,
  min: number,
  max: number,
  bitDepth: number,
): ChannelState {
  // The Min and Max sliders are independent, so Min can be dragged past Max.
  // An inverted window makes the renderer's range negative and blacks the
  // channel out with no feedback — keep them ordered instead.
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return {
    ...ch,
    min: lo,
    max: hi,
    hasLevels: true,
    // Widen only. A drag must never make the track it is being dragged on
    // smaller; Auto is what re-fits it downward.
    controlMax: Math.max(ch.controlMax, displayScaleFor(hi, bitDepth)),
  };
}

/** Track that fits both the data and the window, used when Auto re-fits it. */
function refitControlMax(ch: ChannelState, windowMax: number, bitDepth: number): number {
  return Math.max(
    effectiveScale(ch.displayMax, bitDepth),
    displayScaleFor(windowMax, bitDepth),
  );
}

/** Build the file-declared channel display before any pixels or saved view. */
function channelsFromMetadata(metadata: ImageMetadata, count = metadata.num_channels): ChannelState[] {
  const channelTypes = metadata.channel_types ?? [];
  const channelColors = metadata.channel_colors ?? [];
  const channelRanges = metadata.channel_ranges ?? [];
  const channels: ChannelState[] = [];
  for (let i = 0; i < count; i++) {
    const isTransmitted = channelTypes[i] === 'transmitted';
    const fileColor = channelColors[i];
    let color: [number, number, number];
    if (fileColor && fileColor.length === 3) {
      color = fileColor as [number, number, number];
    } else if (isTransmitted) {
      color = TRANSMITTED_COLOR;
    } else {
      color = getLutColor(i);
    }
    const fileRange = channelRanges[i];
    const hasFileRange = Array.isArray(fileRange)
      && fileRange.length === 2 && fileRange[1] > fileRange[0];
    channels.push({
      visible: !isTransmitted,
      color,
      min: hasFileRange ? fileRange[0] : 0,
      max: hasFileRange ? fileRange[1] : 65535,
      autoMin: 0,
      autoMax: 65535,
      data: null,
      hasLevels: hasFileRange,
      displayMax: 0,
      controlMax: 0,
    });
  }
  return channels;
}

/** Attach one decoded channel without changing an already-established window. */
function channelWithPixels(
  channel: ChannelState,
  data: Uint16Array,
  autoMin: number,
  autoMax: number,
  bitDepth: number,
): ChannelState {
  const adoptAuto = !channel.hasLevels;
  const pMax = planeMax(data);
  const displayMax = pMax > 0
    ? Math.max(channel.displayMax, displayScaleFor(pMax, bitDepth))
    : channel.displayMax;
  const nextMax = adoptAuto ? autoMax : channel.max;
  return {
    ...channel,
    data,
    autoMin,
    autoMax,
    displayMax,
    controlMax: Math.max(
      channel.controlMax,
      displayMax,
      displayScaleFor(nextMax, bitDepth),
    ),
    ...(adoptAuto ? { min: autoMin, max: autoMax, hasLevels: true } : {}),
  };
}

function channelsWithResponse(
  channels: ChannelState[],
  response: PreparedChannelResponse,
  bitDepth: number,
): ChannelState[] {
  const next = channels.map((channel) => ({ ...channel }));
  for (const item of response.channels) {
    next[item.channel] = channelWithPixels(
      next[item.channel], item.data, item.auto_min, item.auto_max, bitDepth,
    );
  }
  return next;
}

function channelsWithPersistedSettings(
  channels: ChannelState[],
  saved: SavedImageView,
  bitDepth: number,
): ChannelState[] {
  return channels.map((channel, index) => {
    const persisted = saved.channels[index];
    if (!persisted) return { ...channel };
    const min = Math.min(persisted.min, persisted.max);
    const max = Math.max(persisted.min, persisted.max);
    return {
      ...channel,
      color: [...persisted.color] as [number, number, number],
      min,
      max,
      visible: persisted.visible,
      hasLevels: true,
      controlMax: Math.max(channel.controlMax, displayScaleFor(max, bitDepth)),
    };
  });
}

/** Refuse a partial or mis-sized response instead of displaying a plausible wrong image. */
function assertPreparedResponse(
  metadata: ImageMetadata,
  response: PreparedChannelResponse,
  label: string,
): void {
  if (response.channels.length !== metadata.num_channels) {
    throw new Error(`${label}: expected ${metadata.num_channels} channels, got ${response.channels.length}`);
  }
  const planeLength = metadata.width * metadata.height;
  const seen = new Set<number>();
  for (const channel of response.channels) {
    if (!Number.isInteger(channel.channel)
        || channel.channel < 0 || channel.channel >= metadata.num_channels
        || seen.has(channel.channel)) {
      throw new Error(`${label}: invalid channel index ${channel.channel}`);
    }
    if (channel.data.length !== planeLength) {
      throw new Error(
        `${label}: channel ${channel.channel} has ${channel.data.length} pixels; expected ${planeLength}`,
      );
    }
    seen.add(channel.channel);
  }
}

export const useImageStore = create<ImageStore>((set, get) => ({
  imageList: [],
  activeImageId: null,
  imageViewStates: {},
  sourceViewDefaults: {},

  metadata: null,
  channels: [],
  currentZ: 0,
  currentT: 0,
  showMIP: false,
  projection: { active: false, method: 'max', zFrom: 0, zTo: 0 },
  volume3D: { ...DEFAULT_VOLUME_3D },
  loading: false,
  loadError: null,

  setImageList: (list) => set({ imageList: list }),

  setActiveImageId: (id) => set({ activeImageId: id }),

  saveViewState: () => {
    const { activeImageId, channels, currentZ, currentT, showMIP, projection, volume3D } = get();
    if (!activeImageId) return;
    const states = { ...get().imageViewStates };
    states[activeImageId] = {
      volume3D: { ...volume3D },
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

  saveViewStateIfSource: (id, sourceIdentity, sourceRevision) => {
    const state = get();
    if (state.activeImageId !== id
        || state.metadata?.source_identity !== sourceIdentity
        || state.metadata?.source_revision !== sourceRevision) return false;
    state.saveViewState();
    return true;
  },

  restoreViewState: (id) => {
    const saved = get().imageViewStates[id];
    if (saved) {
      // This writes Z/T directly, so clamp here too — the metadata in play may
      // belong to a shallower image than the one the state was saved from.
      const meta = get().metadata;
      const maxZ = (meta?.num_z ?? 1) - 1;
      const maxT = (meta?.num_t ?? 1) - 1;
      const volume3D = volume3DForRestoredImage(
        get().volume3D,
        saved.volume3D,
        meta?.num_z ?? 1,
      );
      // Keep the stored copy in step with a migrated placeholder. The 3D
      // loader deliberately reads imageViewStates to distinguish a returning
      // image, so updating only the live field would let it reapply 1/1/1.
      const imageViewStates = {
        ...get().imageViewStates,
        [id]: { ...saved, volume3D: { ...volume3D } },
      };
      set({
        imageViewStates,
        channels: saved.channels.map(ch => ({ ...ch })),
        currentZ: Math.max(0, Math.min(saved.currentZ, maxZ)),
        currentT: Math.max(0, Math.min(saved.currentT, maxT)),
        showMIP: saved.showMIP,
        projection: saved.projection ? { ...saved.projection } : { active: false, method: 'max', zFrom: 0, zTo: 0 },
        // Older states predate this field, and the old placeholder could also
        // be saved before 3D opened; both restore as an honest full stack.
        volume3D,
      });
    }
  },

  presentPreparedImage: (presentation) => {
    const {
      id, metadata, sourceResponse, targetResponse,
      view, sessionState, persistedSettings,
    } = presentation;
    assertPreparedResponse(metadata, sourceResponse, 'Source baseline');
    assertPreparedResponse(metadata, targetResponse, 'Restored view');
    if (sessionState && sessionState.channels.length !== metadata.num_channels) {
      throw new Error(
        `Restored view: expected ${metadata.num_channels} channel settings, got ${sessionState.channels.length}`,
      );
    }

    // One Zustand publication is the presentation boundary: subscribers can
    // observe either the outgoing coherent image or this fully decoded view,
    // never restored Z/T/MIP labels paired with source-baseline pixels.
    set((state) => {
      const existingDefaults = state.sourceViewDefaults[id];
      const freshVolume = existingDefaults
        ? { ...existingDefaults.volume3D }
        : volume3DForFreshImage(state.volume3D, metadata.num_z);
      const sourceChannels = channelsWithResponse(
        channelsFromMetadata(metadata), sourceResponse, metadata.bit_depth,
      );
      let channels = sourceChannels;
      let volume3D = freshVolume;
      let imageViewStates = state.imageViewStates;

      if (sessionState) {
        volume3D = volume3DForRestoredImage(
          freshVolume, sessionState.volume3D, metadata.num_z,
        );
        channels = sessionState.channels.map((channel) => ({ ...channel, data: null }));
        imageViewStates = {
          ...imageViewStates,
          [id]: { ...sessionState, volume3D: { ...volume3D } },
        };
      } else if (persistedSettings) {
        channels = channelsWithPersistedSettings(
          sourceChannels, persistedSettings, metadata.bit_depth,
        );
      }

      if (sessionState || targetResponse !== sourceResponse) {
        channels = channelsWithResponse(channels, targetResponse, metadata.bit_depth);
      }
      const sourceViewDefaults = existingDefaults
        ? state.sourceViewDefaults
        : {
            ...state.sourceViewDefaults,
            [id]: {
              channels: sourceChannels.map((channel) => ({ ...channel, data: null })),
              currentZ: 0,
              currentT: 0,
              showMIP: false,
              projection: {
                active: false as const,
                method: 'max' as const,
                zFrom: 0,
                zTo: Math.max(0, metadata.num_z - 1),
              },
              volume3D: { ...freshVolume },
            },
          };

      return {
        activeImageId: id,
        metadata,
        channels,
        currentZ: view.currentZ,
        currentT: view.currentT,
        showMIP: view.showMIP,
        projection: { ...view.projection },
        volume3D,
        imageViewStates,
        sourceViewDefaults,
      };
    });
  },

  removeImageState: (id) => {
    const states = { ...get().imageViewStates };
    delete states[id];
    const defaults = { ...get().sourceViewDefaults };
    delete defaults[id];
    set({ imageViewStates: states, sourceViewDefaults: defaults });
  },

  // Called after the first fresh Z0/T0 pixels have established either the file's
  // embedded LUT window or the fallback auto levels, and before a saved user view
  // is applied. Keeping only display state avoids pinning one decoded plane per tab.
  captureSourceDefaults: () => {
    const {
      activeImageId, metadata, channels, sourceViewDefaults,
      currentZ, currentT, showMIP, projection, volume3D,
    } = get();
    if (!activeImageId || !metadata || sourceViewDefaults[activeImageId]
        || channels.length !== metadata.num_channels
        || currentZ !== 0 || currentT !== 0 || showMIP || projection.active) return;
    set({
      sourceViewDefaults: {
        ...sourceViewDefaults,
        [activeImageId]: {
          channels: channels.map((channel) => ({ ...channel, data: null })),
          currentZ: 0,
          currentT: 0,
          showMIP: false,
          projection: {
            active: false, method: 'max', zFrom: 0, zTo: Math.max(0, metadata.num_z - 1),
          },
          volume3D: { ...volume3D },
        },
      },
    });
  },

  // Reset every per-image 2D display choice, but deliberately leave global
  // annotations, scale-bar preferences and the per-image 3D camera/slab alone.
  // The source itself and cached pixels are never written or reinterpreted here.
  resetActiveImageToSource: (includeVolume3D = false) => {
    const {
      activeImageId, sourceViewDefaults, imageViewStates, volume3D,
      channels: liveChannels, currentZ, currentT, showMIP, projection: liveProjection,
    } = get();
    if (!activeImageId) return false;
    const defaults = sourceViewDefaults[activeImageId];
    if (!defaults) return false;
    const samePlane = currentZ === defaults.currentZ && currentT === defaults.currentT
      && showMIP === defaults.showMIP && liveProjection.active === defaults.projection.active;
    const channels = defaults.channels.map((channel, index) => ({
      ...channel,
      // On the usual Z0/T0 path the pixels are already exactly the fresh plane,
      // so keep them and make reset visually atomic. A different plane is blanked
      // until the reset handler explicitly reloads Z0/T0.
      data: samePlane ? (liveChannels[index]?.data ?? null) : null,
    }));
    const projection = { ...defaults.projection };
    const nextVolume3D = includeVolume3D ? { ...defaults.volume3D } : { ...volume3D };
    set({
      channels,
      currentZ: defaults.currentZ,
      currentT: defaults.currentT,
      showMIP: defaults.showMIP,
      projection,
      volume3D: nextVolume3D,
      imageViewStates: {
        ...imageViewStates,
        [activeImageId]: {
          channels: channels.map((channel) => ({ ...channel, data: null })),
          currentZ: defaults.currentZ,
          currentT: defaults.currentT,
          showMIP: defaults.showMIP,
          projection: { ...projection },
          volume3D: { ...nextVolume3D },
        },
      },
    });
    return true;
  },

  // Metadata is the first trustworthy point at which a fresh image's Z range
  // can be initialised. Preserve the current camera (useful across plate wells),
  // but never let the previous or process-default slab become this image's
  // saved state merely because the user switched tabs before opening 3D.
  // A saved image state, when present, is restored immediately after this.
  setMetadata: (m) => set((s) => ({
    metadata: m,
    ...(m ? { volume3D: volume3DForFreshImage(s.volume3D, m.num_z) } : {}),
  })),

  initChannels: (n) => {
    const meta = get().metadata;
    set({ channels: meta ? channelsFromMetadata(meta, n) : [] });
  },

  setChannelData: (c, data, autoMin, autoMax) => {
    const channels = [...get().channels];
    if (channels[c]) {
      const bitDepth = get().metadata?.bit_depth ?? 16;
      channels[c] = channelWithPixels(channels[c], data, autoMin, autoMax, bitDepth);
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
      const bitDepth = get().metadata?.bit_depth ?? 16;
      channels[c] = channelWithRange(channels[c], min, max, bitDepth);
      set({ channels });
    }
  },

  applyChannelRanges: (id, updates) => {
    const state = get();
    if (id === state.activeImageId) {
      const channels = [...state.channels];
      const bitDepth = state.metadata?.bit_depth ?? 16;
      for (const u of updates) {
        if (channels[u.channel]) {
          channels[u.channel] = channelWithRange(channels[u.channel], u.min, u.max, bitDepth);
        }
      }
      set({ channels });
      return true;
    }
    const saved = state.imageViewStates[id];
    if (!saved) return false;
    const channels = [...saved.channels];
    for (const u of updates) {
      if (channels[u.channel]) {
        // No metadata for a background tab, so the slider-track fields are left
        // alone; channelWithPixels re-fits them when the tab is next shown.
        channels[u.channel] = {
          ...channels[u.channel],
          min: Math.min(u.min, u.max),
          max: Math.max(u.min, u.max),
          hasLevels: true,
        };
      }
    }
    set({
      imageViewStates: {
        ...state.imageViewStates,
        [id]: { ...saved, channels },
      },
    });
    return true;
  },

  autoContrastChannel: (c) => {
    const channels = [...get().channels];
    const bitDepth = get().metadata?.bit_depth ?? 16;
    if (channels[c]) {
      channels[c] = {
        ...channels[c],
        min: channels[c].autoMin,
        max: channels[c].autoMax,
        hasLevels: true,
        // Auto is a deliberate press, so it is the one place the track may
        // narrow — back onto the data, where the resolution is wanted.
        controlMax: refitControlMax(channels[c], channels[c].autoMax, bitDepth),
      };
      set({ channels });
    }
  },

  autoContrastAll: () => {
    const bitDepth = get().metadata?.bit_depth ?? 16;
    const channels = get().channels.map(ch => ({
      ...ch,
      min: ch.autoMin,
      max: ch.autoMax,
      hasLevels: true,
      controlMax: refitControlMax(ch, ch.autoMax, bitDepth),
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

  // Merged rather than replaced: the orbit and the Z range are written by two
  // different controls, and a full replace makes whichever fired last clobber
  // the other.
  setVolume3D: (v) => set({ volume3D: { ...get().volume3D, ...v } }),
  setLoading: (l) => set({ loading: l }),
  setLoadError: (e) => set({ loadError: e }),
}));
