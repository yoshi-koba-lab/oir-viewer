import { useRef, useEffect, useCallback, useState } from 'react';
import { useCanvasRenderer } from '../hooks/useCanvasRenderer';
import {
  cropOwnerForMetadata,
  sameCropOwner,
  useViewStore,
} from '../stores/viewStore';
import { useImageStore } from '../stores/imageStore';
import { ROIOverlay } from './ROIOverlay';
import { CropOverlay } from './CropOverlay';
import { scalebarMetrics } from '../utils/scalebar';
import { ScalebarOverlay } from './ScalebarOverlay';
import { fitCropViewport } from '../utils/crop';

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
  const {
    zoom, panX, panY, setZoom, setPan, roiTool, scalebarUm,
    cropRect, cropOwner, cropFitRequest, consumeCropFit,
  } = useViewStore();
  const metadata = useImageStore((s) => s.metadata);
  const showMIP = useImageStore((s) => s.showMIP);
  const projectionActive = useImageStore((s) => s.projection.active);
  const activeImageId = useImageStore((s) => s.activeImageId);
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

  // Completion of the crop panel requests a one-shot 2D fit. Keep the
  // rectangle in source pixels and solve the same transform used by the
  // renderer, so the selected area is centered rather than merely zoomed.
  useEffect(() => {
    const request = cropFitRequest;
    if (!request || !metadata || !cropRect || !cropOwner || !activeImageId) return;
    const currentOwner = cropOwnerForMetadata(activeImageId, metadata);
    if (!sameCropOwner(cropOwner, currentOwner) || request.ownerKey !== currentOwner?.key) {
      consumeCropFit(request.sequence);
      return;
    }
    if (request.rect.x !== cropRect.x || request.rect.y !== cropRect.y
        || request.rect.width !== cropRect.width || request.rect.height !== cropRect.height) {
      consumeCropFit(request.sequence);
      return;
    }
    // The renderer's canvas is the source of truth for the visible CSS frame.
    // During a dock/resize transition the flex wrapper can briefly have the old
    // size; solving fit against it would make the completed crop use a
    // different aspect from the rectangle the user actually drew.
    const viewport = canvasRef.current?.getBoundingClientRect();
    if (!viewport || viewport.width <= 0 || viewport.height <= 0) return;
    const fit = fitCropViewport(
      cropRect,
      metadata.width,
      metadata.height,
      viewport.width,
      viewport.height,
    );
    setZoom(fit.zoom);
    setPan(fit.panX, fit.panY);
    consumeCropFit(request.sequence);
  }, [activeImageId, consumeCropFit, cropFitRequest, cropOwner, cropRect, metadata, setPan, setZoom]);

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
  // onWheel handler is ignored — bind it non-passively here instead. It goes on
  // the container rather than the canvas so the scale bar, which overlays the
  // canvas as a sibling, is not a dead zone for zooming.
  // Zoom anchors at the cursor, matching CompareView.
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
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
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
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
        // End on "no button held" rather than on mouseleave: the scale bar
        // overlays the canvas, so crossing it fired mouseleave and aborted a
        // pan that was still in progress.
        if (e.buttons === 0) {
          isPanning.current = false;
        } else {
          const dx = e.clientX - lastMouse.current.x;
          const dy = e.clientY - lastMouse.current.y;
          setPan(panX + dx, panY + dy);
          lastMouse.current = { x: e.clientX, y: e.clientY };
        }
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
    // The pan deliberately survives leaving the canvas (see handleMouseMove);
    // only the cursor readout is a leave-scoped concern.
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
      {metadata && !showMIP && !projectionActive && (
        <ROIOverlay
          width={metadata.width}
          height={metadata.height}
          zoom={zoom}
          panX={panX}
          panY={panY}
          containerRef={containerRef}
        />
      )}
      {/* Cropping is a geometric display operation, so it remains available for
          2D MIP/Z-projection frames even though ROI measurement is not. */}
      {metadata && (
        <CropOverlay
          width={metadata.width}
          height={metadata.height}
          zoom={zoom}
          panX={panX}
          panY={panY}
          containerRef={containerRef}
          canvasRef={canvasRef}
        />
      )}
      {/* Scale bar. Capped at 70% of the image on screen so an auto length can
          never span the whole field. */}
      {metadata && (
        <ScalebarOverlay
          metrics={scalebarMetrics(
            metadata.pixel_size_x,
            zoom,
            scalebarUm,
            120,
            metadata.width * zoom * 0.7,
          )}
          geometry={{ imgW: metadata.width, imgH: metadata.height, zoom, panX, panY }}
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
