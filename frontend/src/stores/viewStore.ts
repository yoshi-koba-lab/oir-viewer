import { create } from 'zustand';

export type ROITool = 'none' | 'line' | 'rect' | 'ellipse';
export type ViewMode = '2d' | 'mip' | '3d' | 'split' | 'compare';

export interface ROI {
  id: string;
  type: 'line' | 'rect' | 'ellipse';
  // line: x0,y0,x1,y1  rect: x,y,w,h  ellipse: cx,cy,rx,ry
  params: Record<string, number>;
}

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

  setZoom: (z) => set({ zoom: Math.max(0.1, Math.min(50, z)) }),
  setPan: (x, y) => set({ panX: x, panY: y }),
  setRoiTool: (t) => set({ roiTool: t }),
  addRoi: (roi) => set((s) => ({ rois: [...s.rois, roi] })),
  removeRoi: (id) => set((s) => ({ rois: s.rois.filter((r) => r.id !== id) })),
  setActiveRoi: (id) => set({ activeRoiId: id }),
  setDrawingRoi: (r) => set({ drawingRoi: r }),
  clearRois: () => set({ rois: [], activeRoiId: null }),
  setViewMode: (m) => set({ viewMode: m }),
  setSplitCount: (n) => set({ splitCount: n }),
  setShowMergeInSplit: (v) => set({ showMergeInSplit: v }),
  setPlayingT: (p) => set({ playingT: p }),
  setCompareImageIds: (ids) => set({ compareImageIds: ids }),
  setScalebarUm: (um) => set({ scalebarUm: um !== null && um > 0 ? um : null }),
  resetView: () => set({ zoom: 1, panX: 0, panY: 0 }),
}));
