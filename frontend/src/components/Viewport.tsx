import { useRef, useEffect, useCallback, useState } from 'react';
import { useCanvasRenderer } from '../hooks/useCanvasRenderer';
import { useViewStore } from '../stores/viewStore';
import { useImageStore } from '../stores/imageStore';
import { ROIOverlay } from './ROIOverlay';
import {
  SCALEBAR_BLOCK_H,
  SCALEBAR_FONT,
  formatUm,
  imageRect,
  scalebarAnchor,
  scalebarMetrics,
  scalebarOutline,
} from '../utils/scalebar';

/** Pixel under the cursor plus each visible channel's raw value there. */
interface ReadoutInfo {
  x: number;
  y: number;
  values: { name: string; color: string; value: number }[];
}

type ReadoutSetter = (info: ReadoutInfo | null) => void;

export function Viewport() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { render } = useCanvasRenderer();
  const { zoom, panX, panY, setZoom, setPan, roiTool, showScalebar } = useViewStore();
  const metadata = useImageStore((s) => s.metadata);
  // Snapshot, used only to detect "the pixels changed" below. The readout itself
  // always reads the live store. Viewport already re-renders on channel changes
  // (useCanvasRenderer subscribes to them), so this adds no extra renders.
  const channelSnapshot = useImageStore((s) => s.channels);
  const isPanning = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  // Push readout updates straight into the overlay so a mousemove never
  // re-renders the viewport (and with it the ROI layer / scale bar).
  const readoutRef = useRef<ReadoutSetter | null>(null);
  const lastCursor = useRef<{ x: number; y: number } | null>(null);

  // Render whenever dependencies change
  useEffect(() => {
    if (canvasRef.current) render(canvasRef.current);
  }, [render]);

  // Resize observer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => {
      render(canvas);
    });
    observer.observe(canvas.parentElement!);
    return () => observer.disconnect();
  }, [render]);

  // React 19 binds wheel passively at the root, so preventDefault() from a JSX
  // onWheel handler is ignored — bind it non-passively on the canvas instead.
  // Zoom anchors at the cursor, matching CompareView.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left - rect.width / 2;
      const sy = e.clientY - rect.top - rect.height / 2;
      const v = useViewStore.getState();
      const newZoom = Math.max(0.1, Math.min(50, v.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
      const k = newZoom / v.zoom;
      setZoom(newZoom);
      setPan(sx - (sx - v.panX) * k, sy - (sy - v.panY) * k);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [setZoom, setPan]);

  /** Screen -> image pixel, using the same transform as useCanvasRenderer. */
  const updateReadout = useCallback((clientX: number, clientY: number) => {
    const setReadout = readoutRef.current;
    const canvas = canvasRef.current;
    if (!setReadout || !canvas) return;
    const { metadata: meta, channels } = useImageStore.getState();
    if (!meta) {
      setReadout(null);
      return;
    }
    // Read the live view state: during a pan the pan has already advanced past
    // this component's last render.
    const v = useViewStore.getState();
    const rect = canvas.getBoundingClientRect();
    const dx = rect.width / 2 - (meta.width * v.zoom) / 2 + v.panX;
    const dy = rect.height / 2 - (meta.height * v.zoom) / 2 + v.panY;
    const ix = Math.floor((clientX - rect.left - dx) / v.zoom);
    const iy = Math.floor((clientY - rect.top - dy) / v.zoom);
    if (ix < 0 || iy < 0 || ix >= meta.width || iy >= meta.height) {
      setReadout(null);
      return;
    }
    const idx = iy * meta.width + ix;
    const values: ReadoutInfo['values'] = [];
    channels.forEach((ch, i) => {
      if (!ch.visible || !ch.data) return;
      values.push({
        name: meta.channel_names[i] ?? `Ch${i}`,
        color: `rgb(${ch.color.join(',')})`,
        value: ch.data[idx],
      });
    });
    setReadout(values.length > 0 ? { x: ix, y: iy, values } : null);
  }, []);

  // A Z step, a projection change or closing the image replaces the pixels under
  // a stationary cursor, so the displayed value would otherwise stay stale (and
  // wrong) until the next mousemove. Recompute from the last cursor position.
  useEffect(() => {
    const c = lastCursor.current;
    if (c) updateReadout(c.x, c.y);
  }, [channelSnapshot, metadata, updateReadout]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (roiTool !== 'none') return; // ROI drawing handled by overlay
      if (e.button === 0 || e.button === 1) {
        isPanning.current = true;
        lastMouse.current = { x: e.clientX, y: e.clientY };
      }
    },
    [roiTool]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isPanning.current) {
        const dx = e.clientX - lastMouse.current.x;
        const dy = e.clientY - lastMouse.current.y;
        setPan(panX + dx, panY + dy);
        lastMouse.current = { x: e.clientX, y: e.clientY };
      }
      lastCursor.current = { x: e.clientX, y: e.clientY };
      updateReadout(e.clientX, e.clientY);
    },
    [panX, panY, setPan, updateReadout]
  );

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  const handleMouseLeave = useCallback(() => {
    isPanning.current = false;
    lastCursor.current = null;
    readoutRef.current?.(null);
  }, []);

  const handleDoubleClick = useCallback(() => {
    useViewStore.getState().resetView();
  }, []);

  return (
    <div ref={containerRef} className="relative flex-1 overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-crosshair"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onDoubleClick={handleDoubleClick}
      />
      {metadata && (
        <ROIOverlay
          width={metadata.width}
          height={metadata.height}
          zoom={zoom}
          panX={panX}
          panY={panY}
          containerRef={containerRef}
        />
      )}
      {/* Scale bar */}
      {metadata && metadata.pixel_size_x > 0 && showScalebar && (
        <ScaleBar
          zoom={zoom}
          panX={panX}
          panY={panY}
          pixelSize={metadata.pixel_size_x}
          imgW={metadata.width}
          imgH={metadata.height}
        />
      )}
      {/* Coordinate display */}
      <CoordinateDisplay />
      {/* Cursor pixel / intensity readout */}
      <PixelReadout apiRef={readoutRef} />
    </div>
  );
}

/** Cursor position + per-channel raw values, updated imperatively. */
function PixelReadout({ apiRef }: { apiRef: React.RefObject<ReadoutSetter | null> }) {
  const [info, setInfo] = useState<ReadoutInfo | null>(null);

  useEffect(() => {
    apiRef.current = setInfo;
    return () => {
      apiRef.current = null;
    };
  }, [apiRef]);

  if (!info) return null;
  return (
    <div className="absolute top-2 right-2 text-[10px] font-mono leading-tight bg-black/50 px-2 py-1 rounded pointer-events-none">
      <div className="text-white/60">
        x: {info.x} y: {info.y}
      </div>
      {info.values.map((v, i) => (
        <div key={i} className="flex justify-between gap-3" style={{ color: v.color }}>
          <span className="truncate max-w-[8rem]">{v.name}</span>
          <span>{v.value}</span>
        </div>
      ))}
    </div>
  );
}

function ScaleBar({
  zoom,
  panX,
  panY,
  pixelSize,
  imgW,
  imgH,
}: {
  zoom: number;
  panX: number;
  panY: number;
  pixelSize: number;
  imgW: number;
  imgH: number;
}) {
  // An explicit length from the shared setting wins over the auto-chosen one.
  const requestedUm = useViewStore((s) => s.scalebarUm);
  const color = useViewStore((s) => s.scalebarColor);
  // Cap at 70% of the image on screen so the bar never spans the whole field.
  const metrics = scalebarMetrics(pixelSize, zoom, requestedUm, 120, imgW * zoom * 0.7);
  const barPx = metrics?.px ?? 0;
  const label = metrics ? formatUm(metrics.um) : '';
  const visible = metrics !== null;

  const posRef = useRef({ x: -1, y: -1 });
  const [pos, setPos] = useState({ x: -1, y: -1 });
  const ref = useRef<HTMLDivElement>(null);
  const dragStart = useRef({ x: 0, y: 0 });
  const userMoved = useRef(false);
  const [sizeTick, setSizeTick] = useState(0);

  // Keep the bar fully inside the container so it can never become unreachable.
  const applyPos = useCallback((p: { x: number; y: number }) => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const pr = parent.getBoundingClientRect();
    const margin = 4;
    const maxX = Math.max(margin, pr.width - el.offsetWidth - margin);
    const maxY = Math.max(margin, pr.height - el.offsetHeight - margin);
    const clamped = {
      x: Math.min(Math.max(margin, p.x), maxX),
      y: Math.min(Math.max(margin, p.y), maxY),
    };
    const prev = posRef.current;
    posRef.current = clamped;
    if (prev.x !== clamped.x || prev.y !== clamped.y) setPos(clamped);
  }, []);

  // Until the user drags it, the bar sits at the image's own bottom-left corner —
  // it belongs to the image, so it has to follow the pan and zoom rather than sit
  // in a corner of the panel. Re-deriving the anchor (rather than re-clamping the
  // old value) keeps it flush as the bar width changes with zoom. Once dragged,
  // keep the user's spot but clamp it, since a wider bar or a smaller container
  // can push it out of view.
  useEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    if (userMoved.current && posRef.current.x >= 0) {
      applyPos(posRef.current);
    } else {
      const pr = parent.getBoundingClientRect();
      const rect = imageRect(pr.width, pr.height, imgW, imgH, zoom, panX, panY);
      applyPos(
        scalebarAnchor(rect, pr.width, pr.height, el.offsetWidth || barPx, el.offsetHeight || SCALEBAR_BLOCK_H),
      );
    }
  }, [barPx, sizeTick, applyPos, imgW, imgH, zoom, panX, panY]);

  // Recompute on container resize (window resize, panel collapse/expand) through
  // the effect above so it sees the current bar width. Keyed on `visible`, not []:
  // the parent is reached through this component's own ref, so a first render with
  // no bar would otherwise leave the observer permanently unattached and the bar
  // stuck at a stale offset once it came back.
  useEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(() => setSizeTick((t) => t + 1));
    observer.observe(parent);
    return () => observer.disconnect();
  }, [visible]);

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragStart.current = { x: e.clientX, y: e.clientY };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!(e.target as HTMLElement).hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    dragStart.current = { x: e.clientX, y: e.clientY };
    userMoved.current = true;
    applyPos({ x: posRef.current.x + dx, y: posRef.current.y + dy });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  };

  if (!metrics) return null;

  // The halo follows the bar's own luminance, so a black bar gets a light one
  // and stays visible against dark signal.
  const outline = scalebarOutline(color);

  return (
    <div
      ref={ref}
      className="absolute flex flex-col items-start gap-1 cursor-grab active:cursor-grabbing select-none touch-none"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <span
        className="text-xs pointer-events-none"
        style={{
          color,
          fontFamily: SCALEBAR_FONT,
          textShadow: `0 0 3px ${outline}, 0 1px 2px ${outline}`,
        }}
      >
        {label}
      </span>
      <div
        className="h-[3px] rounded pointer-events-none"
        style={{ width: `${barPx}px`, backgroundColor: color, boxShadow: `0 0 0 1px ${outline}` }}
      />
    </div>
  );
}

function CoordinateDisplay() {
  const metadata = useImageStore((s) => s.metadata);
  const z = useImageStore((s) => s.currentZ);
  const t = useImageStore((s) => s.currentT);
  const projection = useImageStore((s) => s.projection);
  if (!metadata) return null;
  const projLabel = projection.active
    ? `${projection.method.toUpperCase()} Proj Z${projection.zFrom + 1}-${projection.zTo + 1}`
    : `Z: ${z}/${metadata.num_z - 1}`;
  return (
    <div className="absolute top-2 left-2 text-xs font-mono text-white/60 bg-black/40 px-2 py-1 rounded">
      {metadata.filename} | {projLabel} | T: {t}/{metadata.num_t - 1} |{' '}
      {metadata.width}&times;{metadata.height}
    </div>
  );
}
