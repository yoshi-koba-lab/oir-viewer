import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { useImageStore, type ChannelState } from '../stores/imageStore';
import { useViewStore } from '../stores/viewStore';
import {
  SCALEBAR_BLOCK_H,
  drawScalebarAt,
  scalebarAnchor,
  scalebarMetrics,
} from '../utils/scalebar';

export function SplitView() {
  const metadata = useImageStore((s) => s.metadata);
  const channels = useImageStore((s) => s.channels);
  const { zoom, panX, panY, setZoom, setPan, showMergeInSplit } = useViewStore();

  if (!metadata) return null;

  const visibleChannels = channels
    .map((ch, i) => ({ ch, i }))
    .filter(({ ch }) => ch.visible && ch.data);

  const totalPanels = visibleChannels.length + (showMergeInSplit ? 1 : 0);
  const cols = totalPanels <= 1 ? 1 : totalPanels <= 4 ? 2 : totalPanels <= 9 ? 3 : 4;
  const rows = Math.ceil(totalPanels / cols);

  return (
    <div
      className="flex-1 grid gap-1 bg-black p-1"
      style={{
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
      }}
    >
      {visibleChannels.map(({ ch, i }) => (
        <SplitPanel
          key={`ch-${i}`}
          channelIndex={i}
          channelState={ch}
          metadata={metadata}
          zoom={zoom}
          panX={panX}
          panY={panY}
          onZoom={setZoom}
          onPan={setPan}
        />
      ))}
      {showMergeInSplit && (
        <MergePanel
          channels={channels}
          metadata={metadata}
          zoom={zoom}
          panX={panX}
          panY={panY}
          onZoom={setZoom}
          onPan={setPan}
        />
      )}
    </div>
  );
}

function SplitPanel({
  channelIndex,
  channelState,
  metadata,
  zoom,
  panX,
  panY,
  onZoom,
  onPan,
}: {
  channelIndex: number;
  channelState: ChannelState;
  metadata: { width: number; height: number; pixel_size_x: number; channel_names: string[] };
  zoom: number;
  panX: number;
  panY: number;
  onZoom: (z: number) => void;
  onPan: (x: number, y: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isPanning = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });

  // Colourise this channel once per data/contrast change — not on every pan/zoom.
  const composite = useMemo(() => {
    if (!channelState.data) return null;
    const { width, height } = metadata;
    const offscreen = new OffscreenCanvas(width, height);
    const offCtx = offscreen.getContext('2d');
    if (!offCtx) return null;
    const imageData = offCtx.createImageData(width, height);
    const pixels = imageData.data;
    const [r, g, b] = channelState.color;
    const range = channelState.max - channelState.min;
    const invRange = range > 0 ? 1 / range : 0;

    for (let i = 0; i < width * height; i++) {
      const norm = Math.min(1, Math.max(0, (channelState.data[i] - channelState.min) * invRange));
      const idx = i * 4;
      pixels[idx] = norm * r;
      pixels[idx + 1] = norm * g;
      pixels[idx + 2] = norm * b;
      pixels[idx + 3] = 255;
    }
    offCtx.putImageData(imageData, 0, 0);
    return offscreen;
  }, [channelState, metadata]);

  const drawTick = useRedrawOnResize(canvasRef);

  // blitToCanvas reads the scale bar settings from the store, so subscribe here
  // too — otherwise changing the colour or length would not redraw the panel.
  const scalebarDeps = useScalebarRedrawKey();

  useEffect(() => {
    blitToCanvas(canvasRef.current, composite, metadata, zoom, panX, panY);
  }, [composite, metadata, zoom, panX, panY, drawTick, scalebarDeps]);

  const { handleWheel, handleMouseDown, handleMouseMove, handleMouseUp } = usePanZoom(
    zoom, panX, panY, onZoom, onPan, isPanning, lastMouse
  );

  return (
    <div className="relative overflow-hidden bg-black rounded">
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-crosshair"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      />
      <div
        className="absolute top-1 left-2 text-xs font-mono px-1.5 py-0.5 rounded bg-black/50"
        style={{ color: `rgb(${channelState.color.join(',')})` }}
      >
        {metadata.channel_names[channelIndex] || `Ch${channelIndex}`}
      </div>
    </div>
  );
}

function MergePanel({
  channels,
  metadata,
  zoom,
  panX,
  panY,
  onZoom,
  onPan,
}: {
  channels: ChannelState[];
  metadata: { width: number; height: number; pixel_size_x: number };
  zoom: number;
  panX: number;
  panY: number;
  onZoom: (z: number) => void;
  onPan: (x: number, y: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isPanning = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });

  // Additive merge of all visible channels, cached like the single-channel panels.
  const composite = useMemo(() => {
    const { width, height } = metadata;
    const offscreen = new OffscreenCanvas(width, height);
    const offCtx = offscreen.getContext('2d');
    if (!offCtx) return null;
    const imageData = offCtx.createImageData(width, height);
    const pixels = imageData.data;

    for (const ch of channels) {
      if (!ch.visible || !ch.data) continue;
      const [r, g, b] = ch.color;
      const range = ch.max - ch.min;
      const invRange = range > 0 ? 1 / range : 0;

      for (let i = 0; i < width * height; i++) {
        const norm = Math.min(1, Math.max(0, (ch.data[i] - ch.min) * invRange));
        const idx = i * 4;
        pixels[idx] = Math.min(255, pixels[idx] + norm * r);
        pixels[idx + 1] = Math.min(255, pixels[idx + 1] + norm * g);
        pixels[idx + 2] = Math.min(255, pixels[idx + 2] + norm * b);
        pixels[idx + 3] = 255;
      }
    }
    offCtx.putImageData(imageData, 0, 0);
    return offscreen;
  }, [channels, metadata]);

  const drawTick = useRedrawOnResize(canvasRef);

  // blitToCanvas reads the scale bar settings from the store, so subscribe here
  // too — otherwise changing the colour or length would not redraw the panel.
  const scalebarDeps = useScalebarRedrawKey();

  useEffect(() => {
    blitToCanvas(canvasRef.current, composite, metadata, zoom, panX, panY);
  }, [composite, metadata, zoom, panX, panY, drawTick, scalebarDeps]);

  const { handleWheel, handleMouseDown, handleMouseMove, handleMouseUp } = usePanZoom(
    zoom, panX, panY, onZoom, onPan, isPanning, lastMouse
  );

  return (
    <div className="relative overflow-hidden bg-black rounded">
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-crosshair"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      />
      <div className="absolute top-1 left-2 text-xs font-mono px-1.5 py-0.5 rounded bg-black/50 text-white">
        Merge
      </div>
    </div>
  );
}

/**
 * Bump a counter whenever the canvas's box changes size, so the draw effect
 * re-runs. Without this a panel that was laid out at zero size when it first
 * mounted (as happens when switching into a grid view) stays blank forever.
 */
function useRedrawOnResize(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setTick((t) => t + 1));
    observer.observe(el);
    return () => observer.disconnect();
  }, [canvasRef]);
  return tick;
}

/** One value that changes whenever anything about the scale bar changes. */
function useScalebarRedrawKey(): string {
  const show = useViewStore((s) => s.showScalebar);
  const um = useViewStore((s) => s.scalebarUm);
  const color = useViewStore((s) => s.scalebarColor);
  return `${show}|${um}|${color}`;
}

/** Blit a cached composite onto the visible canvas with the current zoom/pan. */
function blitToCanvas(
  canvas: HTMLCanvasElement | null,
  composite: OffscreenCanvas | null,
  metadata: { width: number; height: number; pixel_size_x: number },
  zoom: number,
  panX: number,
  panY: number,
) {
  if (!canvas) return;
  const cw = canvas.clientWidth;
  const chh = canvas.clientHeight;
  // Nothing to draw into yet — the ResizeObserver will call us again once laid out.
  if (cw === 0 || chh === 0) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio;
  canvas.width = cw * dpr;
  canvas.height = chh * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = zoom < 4;
  ctx.clearRect(0, 0, cw, chh);
  if (!composite) return;

  const { width, height } = metadata;
  const drawW = width * zoom;
  const drawH = height * zoom;
  const dx = cw / 2 - drawW / 2 + panX;
  const dy = chh / 2 - drawH / 2 + panY;
  ctx.drawImage(composite, dx, dy, drawW, drawH);

  // Scale bar at the image's bottom-left, same settings as every other view —
  // the toggle is global, so a panel that ignored it would look broken.
  const { showScalebar, scalebarUm, scalebarColor } = useViewStore.getState();
  if (showScalebar) {
    const bar = scalebarMetrics(metadata.pixel_size_x, zoom, scalebarUm, 120, drawW * 0.7);
    if (bar && bar.px < cw * 0.9) {
      const a = scalebarAnchor({ x: dx, y: dy, w: drawW, h: drawH }, cw, chh, bar.px, SCALEBAR_BLOCK_H, 8);
      drawScalebarAt(ctx, a.x, a.y + SCALEBAR_BLOCK_H, bar.px, bar.um, scalebarColor);
    }
  }
}

/** Shared pan/zoom handlers. */
function usePanZoom(
  zoom: number,
  panX: number,
  panY: number,
  onZoom: (z: number) => void,
  onPan: (x: number, y: number) => void,
  isPanning: React.MutableRefObject<boolean>,
  lastMouse: React.MutableRefObject<{ x: number; y: number }>,
) {
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      onZoom(zoom * (e.deltaY > 0 ? 0.9 : 1.1));
    },
    [zoom, onZoom]
  );

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isPanning.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
  }, [isPanning, lastMouse]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isPanning.current) {
        onPan(panX + e.clientX - lastMouse.current.x, panY + e.clientY - lastMouse.current.y);
        lastMouse.current = { x: e.clientX, y: e.clientY };
      }
    },
    [panX, panY, onPan, isPanning, lastMouse]
  );

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, [isPanning]);

  return { handleWheel, handleMouseDown, handleMouseMove, handleMouseUp };
}
