import { create } from 'zustand';
import { DEFAULT_SCALEBAR_COLOR, type ScalebarPos } from '../utils/scalebar';
import type { ImageMetadata } from '../utils/api';
import { threeDSaveIsBusy } from './operationStore';

export type ROITool = 'none' | 'line' | 'rect' | 'ellipse';
export type ViewMode = '2d' | 'mip' | '3d' | 'split' | 'compare';

export interface ROI {
  id: string;
  type: 'line' | 'rect' | 'ellipse';
  // line: x0,y0,x1,y1  rect: x,y,w,h  ellipse: cx,cy,rx,ry
  params: Record<string, number>;
}

/**
 * Crop bounds in source-image pixel-corner coordinates. x/y are the top-left
 * corner and width/height are extents (not the bottom-right point). Keeping
 * source pixels here means 2D exports can crop before resampling and 3D can
 * map the same selection to its capture canvas using the image dimensions.
 */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Provenance of a crop selection. A rectangle is never portable between sources. */
export interface CropOwner {
  imageId: string;
  sourceIdentity: string;
  sourceRevision: string;
  width: number;
  height: number;
  /** Stable comparison key, including the image id and source dimensions. */
  key: string;
}

export interface CropFitRequest {
  sequence: number;
  ownerKey: string;
  rect: CropRect;
}

export function cropOwnerKey(
  imageId: string,
  sourceIdentity: string,
  sourceRevision: string,
  width: number,
  height: number,
): string {
  return [imageId, sourceIdentity, sourceRevision, width, height].join('|');
}

export function cropOwnerForMetadata(
  imageId: string | null,
  metadata: Pick<ImageMetadata, 'source_identity' | 'source_revision' | 'width' | 'height'> | null,
): CropOwner | null {
  if (!imageId || !metadata) return null;
  const width = Math.max(0, Math.trunc(metadata.width));
  const height = Math.max(0, Math.trunc(metadata.height));
  return {
    imageId,
    sourceIdentity: metadata.source_identity,
    sourceRevision: metadata.source_revision,
    width,
    height,
    key: cropOwnerKey(imageId, metadata.source_identity, metadata.source_revision, width, height),
  };
}

export function sameCropOwner(a: CropOwner | null, b: CropOwner | null): boolean {
  return !!a && !!b && a.key === b.key;
}

export function cropOwnerMatchesMetadata(
  owner: CropOwner | null,
  imageId: string | null,
  metadata: Pick<ImageMetadata, 'source_identity' | 'source_revision' | 'width' | 'height'> | null,
): boolean {
  return sameCropOwner(owner, cropOwnerForMetadata(imageId, metadata));
}

/** Reject degenerate/invalid input; the UI clamps to the active metadata size. */
export const normaliseCropRect = (rect: CropRect | null): CropRect | null => {
  if (!rect) return null;
  const x = Number.isFinite(rect.x) ? Math.max(0, Math.round(rect.x)) : 0;
  const y = Number.isFinite(rect.y) ? Math.max(0, Math.round(rect.y)) : 0;
  const width = Number.isFinite(rect.width) ? Math.max(0, Math.round(rect.width)) : 0;
  const height = Number.isFinite(rect.height) ? Math.max(0, Math.round(rect.height)) : 0;
  if (width < 1 || height < 1) return null;
  return { x, y, width, height };
};

interface ViewStore {
  zoom: number;
  panX: number;
  panY: number;
  roiTool: ROITool;
  rois: ROI[];
  activeRoiId: string | null;
  drawingRoi: Partial<ROI> | null;
  viewMode: ViewMode;
  splitCount: number;
  showMergeInSplit: boolean;
  playingT: boolean;
  compareImageIds: string[];
  /**
   * Scale bar length in µm, or null to pick a round value automatically.
   * Shared by the 2D, Compare and 3D views so a figure set keeps one bar length.
   */
  scalebarUm: number | null;
  /** Whether the bar is drawn at all. Shared for the same reason as its length. */
  showScalebar: boolean;
  /** Bar and label colour, as hex. */
  scalebarColor: string;
  /**
   * Where the user dragged the bar, as a fraction of the image; null = the
   * default bottom-left corner. Shared like the other settings, so the bar keeps
   * the same spot across views and across the images in a Compare grid.
   */
  scalebarPos: ScalebarPos | null;
  /** Crop selection in source pixel coordinates; null means the full image. */
  cropRect: CropRect | null;
  /** Source identity and geometry that created cropRect; null means unowned. */
  cropOwner: CropOwner | null;
  /** Whether the crop settings panel is visible beside the image. */
  cropPanelOpen: boolean;
  /** When true the 2D/3D crop overlay captures pointer events for editing. */
  cropActive: boolean;
  /** One-shot request for the 2D viewport to fit the selected crop. */
  cropFitRequest: CropFitRequest | null;

  setZoom: (z: number) => void;
  setPan: (x: number, y: number) => void;
  setRoiTool: (t: ROITool) => void;
  addRoi: (roi: ROI) => void;
  removeRoi: (id: string) => void;
  setActiveRoi: (id: string | null) => void;
  setDrawingRoi: (r: Partial<ROI> | null) => void;
  clearRois: () => void;
  setViewMode: (m: ViewMode) => void;
  setSplitCount: (n: number) => void;
  setShowMergeInSplit: (v: boolean) => void;
  setPlayingT: (p: boolean) => void;
  setCompareImageIds: (ids: string[]) => void;
  setScalebarUm: (um: number | null) => void;
  setShowScalebar: (v: boolean) => void;
  setScalebarColor: (hex: string) => void;
  setScalebarPos: (p: ScalebarPos | null) => void;
  setCropRect: (rect: CropRect | null, owner?: CropOwner | null) => void;
  setCropPanelOpen: (open: boolean) => void;
  setCropActive: (active: boolean) => void;
  requestCropFit: (owner: CropOwner) => void;
  consumeCropFit: (sequence: number) => void;
  resetCrop: () => void;
  resetView: () => void;
}

export const useViewStore = create<ViewStore>((set) => ({
  zoom: 1,
  panX: 0,
  panY: 0,
  roiTool: 'none',
  rois: [],
  activeRoiId: null,
  drawingRoi: null,
  viewMode: '2d',
  splitCount: 2,
  showMergeInSplit: true,
  playingT: false,
  compareImageIds: [],
  scalebarUm: null,
  showScalebar: true,
  scalebarColor: DEFAULT_SCALEBAR_COLOR,
  scalebarPos: null,
  cropRect: null,
  cropOwner: null,
  cropPanelOpen: false,
  cropActive: false,
  cropFitRequest: null,

  setZoom: (z) => set({ zoom: Math.max(0.1, Math.min(50, z)) }),
  setPan: (x, y) => set({ panX: x, panY: y }),
  setRoiTool: (t) => set((state) => state.cropActive ? { roiTool: 'none' } : { roiTool: t }),
  addRoi: (roi) => set((s) => ({ rois: [...s.rois, roi] })),
  removeRoi: (id) => set((s) => ({ rois: s.rois.filter((r) => r.id !== id) })),
  setActiveRoi: (id) => set({ activeRoiId: id }),
  setDrawingRoi: (r) => set({ drawingRoi: r }),
  clearRois: () => set({ rois: [], activeRoiId: null }),
  // A 3D save owns a live WebGL snapshot until the backend write completes.
  // Refuse even non-UI callers: changing mode unmounts the keyed viewer and used
  // to discard its local lock while the request continued in the background.
  setViewMode: (m) => {
    if (!threeDSaveIsBusy()) set({ viewMode: m });
  },
  setSplitCount: (n) => set({ splitCount: n }),
  setShowMergeInSplit: (v) => set({ showMergeInSplit: v }),
  setPlayingT: (p) => set({ playingT: p }),
  setCompareImageIds: (ids) => set({ compareImageIds: ids }),
  setScalebarUm: (um) => set({ scalebarUm: um !== null && um > 0 ? um : null }),
  setShowScalebar: (v) => set({ showScalebar: v }),
  setScalebarColor: (hex) => set({ scalebarColor: hex }),
  setScalebarPos: (p) => set({ scalebarPos: p }),
  setCropRect: (rect, owner = null) => {
    const normalized = normaliseCropRect(rect);
    set({ cropRect: normalized, cropOwner: normalized ? owner : null });
  },
  setCropPanelOpen: (open) => set(open
    ? { cropPanelOpen: true }
    : { cropPanelOpen: false, cropActive: false }),
  setCropActive: (active) => set(active
    ? { cropActive: true, roiTool: 'none', drawingRoi: null }
    : { cropActive: false }),
  requestCropFit: (owner) => set((state) => ({
    cropFitRequest: state.cropRect && sameCropOwner(state.cropOwner, owner) ? {
      sequence: (state.cropFitRequest?.sequence ?? 0) + 1,
      ownerKey: owner.key,
      rect: { ...state.cropRect },
    } : null,
  })),
  consumeCropFit: (sequence) => set((state) => (
    state.cropFitRequest?.sequence === sequence ? { cropFitRequest: null } : {}
  )),
  resetCrop: () => set({ cropRect: null, cropOwner: null, cropFitRequest: null }),
  resetView: () => set({ zoom: 1, panX: 0, panY: 0 }),
}));
