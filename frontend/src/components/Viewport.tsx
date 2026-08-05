import { useRef, useEffect, useCallback, useState } from 'react';
import { useCanvasRenderer } from '../hooks/useCanvasRenderer';
import { useViewStore } from '../stores/viewStore';
import { useImageStore } from '../stores/imageStore';
import { ROIOverlay } from './ROIOverlay';

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
  const { zoom, panX, panY, setZoom, setPan, roiTool } = useViewStore();
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
      {metadata && metadata.pixel_size_x > 0 && (
        <ScaleBar zoom={zoom} pixelSize={metadata.pixel_size_x} />
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

function ScaleBar({ zoom, pixelSize }: { zoom: number; pixelSize: number }) {
  // Target ~100px bar
  const targetPx = 120;
  const umPerPx = pixelSize / zoom;
  // An explicit length from the shared setting wins over the auto-chosen one.
  const requestedUm = useViewStore((s) => s.scalebarUm);
  const targetUm = targetPx * umPerPx;
  // Round to nice number
  const niceValues = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  const autoUm = niceValues.find((v) => v >= targetUm) ?? targetUm;
  const niceUm = requestedUm && requestedUm > 0 ? requestedUm : autoUm;
  const barPx = niceUm / umPerPx;
  const label = niceUm >= 1 ? `${niceUm} \u00b5m` : `${(niceUm * 1000).toFixed(0)} nm`;

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

  // Until the user drags it, the bar stays anchored bottom-right — re-deriving the
  // anchor (rather than re-clamping the old value) keeps it flush to the edge as
  // the bar width changes with zoom. Once dragged, keep the user's spot but clamp
  // it, since a wider bar or a smaller container can push it out of view.
  useEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    if (userMoved.current && posRef.current.x >= 0) {
      applyPos(posRef.current);
    } else {
      const pr = parent.getBoundingClientRect();
      applyPos({ x: pr.width - barPx - 24, y: pr.height - 40 });
    }
  }, [barPx, sizeTick, applyPos]);

  // Recompute on container resize (window resize, panel collapse/expand) through
  // the effect above so it sees the current bar width.
  useEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(() => setSizeTick((t) => t + 1));
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

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

  return (
    <div
      ref={ref}
      className="absolute flex flex-col items-end gap-1 cursor-grab active:cursor-grabbing select-none touch-none"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* Dark outline keeps both readable over saturated signal, not just black bg */}
      <span
        className="text-xs text-white font-mono pointer-events-none"
        style={{ textShadow: '0 0 3px rgba(0,0,0,0.9), 0 1px 2px rgba(0,0,0,0.9)' }}
      >
        {label}
      </span>
      <div
        className="h-[3px] bg-white rounded pointer-events-none"
        style={{ width: `${barPx}px`, boxShadow: '0 0 0 1px rgba(0,0,0,0.75)' }}
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
