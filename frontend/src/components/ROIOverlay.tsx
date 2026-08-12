import { useCallback, useEffect, useRef } from 'react';
import { useViewStore, type ROI } from '../stores/viewStore';

interface Props {
  width: number;
  height: number;
  zoom: number;
  panX: number;
  panY: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

type Pt = { x: number; y: number };
type Paint = { stroke: string; strokeWidth: number };

// Screen-space shape plus the anchor (bounding-box top-right) for the delete handle.
type Geom =
  | { type: 'line'; a: Pt; b: Pt; anchor: Pt }
  | { type: 'rect'; x: number; y: number; w: number; h: number; anchor: Pt }
  | { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number; anchor: Pt };

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// Screen-pixel tolerance for clicking an outline, plus the delete badge geometry.
const HIT_TOLERANCE = 6;
const BADGE_R = 8;
const BADGE_OFFSET = 9;

const finite = (...v: number[]) => v.every(Number.isFinite);

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

// Distance from p to the shape's outline in screen space (0 when p sits on it).
const distToOutline = (g: Geom, p: Pt): number => {
  if (g.type === 'line') {
    const vx = g.b.x - g.a.x;
    const vy = g.b.y - g.a.y;
    const len2 = vx * vx + vy * vy;
    const t = len2 === 0 ? 0 : clamp(((p.x - g.a.x) * vx + (p.y - g.a.y) * vy) / len2, 0, 1);
    return dist(p, { x: g.a.x + t * vx, y: g.a.y + t * vy });
  }
  if (g.type === 'rect') {
    const inX = p.x >= g.x && p.x <= g.x + g.w;
    const inY = p.y >= g.y && p.y <= g.y + g.h;
    if (inX && inY) return Math.min(p.x - g.x, g.x + g.w - p.x, p.y - g.y, g.y + g.h - p.y);
    return dist(p, { x: clamp(p.x, g.x, g.x + g.w), y: clamp(p.y, g.y, g.y + g.h) });
  }
  if (g.rx <= 0 || g.ry <= 0) return dist(p, { x: g.cx, y: g.cy });
  // Radial approximation: exact on circles, close enough at usual aspect ratios.
  const k = Math.hypot((p.x - g.cx) / g.rx, (p.y - g.cy) / g.ry);
  return Math.abs(k - 1) * Math.min(g.rx, g.ry);
};

// The backend measures exactly what params say, so a degenerate ROI reports zero
// pixels / NaN rather than erroring. A click with no drag leaves params empty
// (every comparison below is then false), so it is discarded too.
const hasExtent = (type: ROI['type'], p: Record<string, number>): boolean => {
  if (type === 'line') return p.x0 !== p.x1 || p.y0 !== p.y1;
  if (type === 'rect') return p.width >= 1 && p.height >= 1;
  return p.rx > 0 && p.ry > 0;
};

export function ROIOverlay({ width, height, zoom, panX, panY, containerRef }: Props) {
  const { roiTool, cropActive, rois, drawingRoi, activeRoiId, addRoi, removeRoi, setDrawingRoi, setActiveRoi } =
    useViewStore();
  const startRef = useRef<Pt | null>(null);

  // Convert screen coords to image coords
  const toImageCoords = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const el = containerRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const drawW = width * zoom;
      const drawH = height * zoom;
      const dx = cx - drawW / 2 + panX;
      const dy = cy - drawH / 2 + panY;
      const ix = (clientX - rect.left - dx) / zoom;
      const iy = (clientY - rect.top - dy) / zoom;
      return { x: Math.round(ix), y: Math.round(iy) };
    },
    [width, height, zoom, panX, panY, containerRef]
  );

  // Convert image coords to screen coords for SVG rendering
  const toScreenCoords = useCallback(
    (ix: number, iy: number): { x: number; y: number } | null => {
      const el = containerRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const drawW = width * zoom;
      const drawH = height * zoom;
      const dx = cx - drawW / 2 + panX;
      const dy = cy - drawH / 2 + panY;
      return { x: dx + ix * zoom, y: dy + iy * zoom };
    },
    [width, height, zoom, panX, panY, containerRef]
  );

  // Normalised, clamped params so the region the backend measures is exactly the one
  // drawn: no negative extents, nothing outside the image. Areas use pixel-corner
  // space (0..size); a line samples pixel centres (0..size-1).
  const buildParams = useCallback(
    (type: ROI['type'], s: Pt, e: Pt): Record<string, number> => {
      if (type === 'line') {
        return {
          x0: clamp(s.x, 0, width - 1),
          y0: clamp(s.y, 0, height - 1),
          x1: clamp(e.x, 0, width - 1),
          y1: clamp(e.y, 0, height - 1),
        };
      }
      const x0 = clamp(Math.min(s.x, e.x), 0, width);
      const x1 = clamp(Math.max(s.x, e.x), 0, width);
      const y0 = clamp(Math.min(s.y, e.y), 0, height);
      const y1 = clamp(Math.max(s.y, e.y), 0, height);
      if (type === 'rect') return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      // Derived from the clamped bbox, so centre +/- radius also stays inside.
      return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, rx: (x1 - x0) / 2, ry: (y1 - y0) / 2 };
    },
    [width, height]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (roiTool === 'none' || cropActive) return;
      e.stopPropagation();
      const pt = toImageCoords(e.clientX, e.clientY);
      if (!pt) return;
      startRef.current = pt;
      setDrawingRoi({ type: roiTool as ROI['type'], params: {} });
    },
    [cropActive, roiTool, toImageCoords, setDrawingRoi]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (cropActive || !startRef.current || !drawingRoi?.type) return;
      e.stopPropagation();
      const pt = toImageCoords(e.clientX, e.clientY);
      if (!pt) return;
      setDrawingRoi({ ...drawingRoi, params: buildParams(drawingRoi.type, startRef.current, pt) });
    },
    [cropActive, drawingRoi, toImageCoords, buildParams, setDrawingRoi]
  );

  const handleMouseUp = useCallback(() => {
    const type = drawingRoi?.type;
    const params = drawingRoi?.params as Record<string, number> | undefined;
    startRef.current = null;
    setDrawingRoi(null);
    if (!type || !params || !hasExtent(type, params)) return;
    const roi: ROI = { id: `roi_${Date.now()}`, type, params };
    addRoi(roi);
    setActiveRoi(roi.id);
  }, [drawingRoi, addRoi, setActiveRoi, setDrawingRoi]);

  const deleteRoi = useCallback(
    (id: string) => {
      removeRoi(id);
      setActiveRoi(null);
    },
    [removeRoi, setActiveRoi]
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      // Don't intercept if user is typing in an input
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const id = useViewStore.getState().activeRoiId;
      if (!id) return;
      e.preventDefault();
      deleteRoi(id);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [deleteRoi]);

  const toGeom = useCallback(
    (roi: { type: string; params: Record<string, number> }): Geom | null => {
      const p = roi.params;
      if (roi.type === 'line') {
        if (!finite(p.x0, p.y0, p.x1, p.y1)) return null;
        const a = toScreenCoords(p.x0, p.y0);
        const b = toScreenCoords(p.x1, p.y1);
        if (!a || !b) return null;
        return { type: 'line', a, b, anchor: { x: Math.max(a.x, b.x), y: Math.min(a.y, b.y) } };
      }
      if (roi.type === 'rect') {
        if (!finite(p.x, p.y, p.width, p.height)) return null;
        const tl = toScreenCoords(p.x, p.y);
        if (!tl) return null;
        const w = p.width * zoom;
        const h = p.height * zoom;
        return { type: 'rect', x: tl.x, y: tl.y, w, h, anchor: { x: tl.x + w, y: tl.y } };
      }
      if (roi.type === 'ellipse') {
        if (!finite(p.cx, p.cy, p.rx, p.ry)) return null;
        const c = toScreenCoords(p.cx, p.cy);
        if (!c) return null;
        const rx = p.rx * zoom;
        const ry = p.ry * zoom;
        return { type: 'ellipse', cx: c.x, cy: c.y, rx, ry, anchor: { x: c.x + rx, y: c.y - ry } };
      }
      return null;
    },
    [toScreenCoords, zoom]
  );

  const badgeCentre = (g: Geom): Pt => ({ x: g.anchor.x + BADGE_OFFSET, y: g.anchor.y - BADGE_OFFSET });

  // Topmost first: the active ROI's delete badge wins, then the most recently drawn
  // outline under the cursor.
  const pickRoi = useCallback(
    (p: Pt, list: ROI[], activeId: string | null): { id: string; del: boolean } | null => {
      const active = activeId ? list.find((r) => r.id === activeId) : undefined;
      if (active) {
        const g = toGeom(active);
        if (g && dist(p, badgeCentre(g)) <= BADGE_R + 2) return { id: active.id, del: true };
      }
      for (let i = list.length - 1; i >= 0; i--) {
        const g = toGeom(list[i]);
        if (g && distToOutline(g, p) <= HIT_TOLERANCE) return { id: list[i].id, del: false };
      }
      return null;
    },
    [toGeom]
  );

  // Selection is hit-tested here instead of by making the SVG shapes pointer-event
  // targets: the overlay sits on top of (and is a sibling of) the canvas that owns
  // panning, so any hit-testable shape under the cursor makes that canvas fire
  // mouseleave, which cancels an in-flight pan and blanks the pixel readout. This
  // listener neither stops propagation nor preventDefaults, so the canvas still
  // sees every event.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const v = useViewStore.getState();
      if (v.roiTool !== 'none' || v.cropActive || v.rois.length === 0) return;
      const box = el.getBoundingClientRect();
      const hit = pickRoi({ x: e.clientX - box.left, y: e.clientY - box.top }, v.rois, v.activeRoiId);
      if (!hit) return;
      if (hit.del) deleteRoi(hit.id);
      else setActiveRoi(hit.id);
    };
    el.addEventListener('mousedown', onMouseDown);
    return () => el.removeEventListener('mousedown', onMouseDown);
  }, [containerRef, pickRoi, deleteRoi, setActiveRoi]);

  const outlinePaint = (isActive: boolean): Paint => ({
    stroke: isActive ? '#ffff00' : '#ffffff',
    strokeWidth: isActive ? 2 : 1.5,
  });

  const shapeNode = (g: Geom, paint: Paint) => {
    if (g.type === 'line') {
      return <line x1={g.a.x} y1={g.a.y} x2={g.b.x} y2={g.b.y} fill="none" {...paint} />;
    }
    if (g.type === 'rect') {
      return <rect x={g.x} y={g.y} width={g.w} height={g.h} fill="none" {...paint} />;
    }
    return <ellipse cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry} fill="none" {...paint} />;
  };

  // Visual only — the click is caught by the container listener above.
  const deleteHandle = (g: Geom) => {
    const c = badgeCentre(g);
    return (
      <g transform={`translate(${c.x}, ${c.y})`}>
        <circle r={BADGE_R} fill="rgba(0,0,0,0.7)" stroke="#ffff00" strokeWidth={1.5} />
        <path
          d="M-3.5 -3.5 L3.5 3.5 M3.5 -3.5 L-3.5 3.5"
          stroke="#ffff00" strokeWidth={1.5} fill="none"
        />
      </g>
    );
  };

  const renderRoiSvg = (
    roi: { type: string; params: Record<string, number> },
    key: string,
    isActive: boolean,
    persisted: boolean
  ) => {
    const g = toGeom(roi);
    if (!g) return null;
    return (
      <g key={key}>
        {shapeNode(g, outlinePaint(isActive))}
        {persisted && isActive && deleteHandle(g)}
      </g>
    );
  };

  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ pointerEvents: roiTool !== 'none' && !cropActive ? 'auto' : 'none' }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {rois.map((roi) => renderRoiSvg(roi, roi.id, roi.id === activeRoiId, true))}
      {drawingRoi?.params && drawingRoi.type &&
        renderRoiSvg(
          { type: drawingRoi.type, params: drawingRoi.params as Record<string, number> },
          'drawing',
          true,
          false
        )
      }
    </svg>
  );
}
