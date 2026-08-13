import { useCallback, useEffect, useRef, useState } from 'react';
import { useViewStore } from '../stores/viewStore';
import {
  SCALEBAR_BLOCK_H,
  SCALEBAR_FONT,
  formatUm,
  imageRect,
  scalebarOutline,
  scalebarPlacement,
  scalebarPosFromScreen,
} from '../utils/scalebar';

/**
 * The scale bar, as a DOM layer over the image. Every view uses this one, so the
 * bar is draggable everywhere — Split, Compare and 3D used to paint it straight
 * onto the canvas, where there was nothing to grab.
 *
 * DOM rather than canvas also means the label is real text: crisp at any device
 * pixel ratio, and outlined with a hard stroke instead of a blurred shadow.
 *
 * Mount inside a `position: relative` element that the image fills.
 */
export function ScalebarOverlay({
  metrics,
  geometry,
  renderedRect,
  pad = 12,
}: {
  /** Physical length and its on-screen width; null hides the bar. */
  metrics: { um: number; px: number } | null;
  /**
   * Where the image sits in the container. Omit when the render fills the
   * container and there is no separate image rect (the 3D volume).
   */
  geometry?: { imgW: number; imgH: number; zoom: number; panX: number; panY: number };
  /** Explicit rendered-image bounds for a letterboxed 3D source plane. */
  renderedRect?: { x: number; y: number; w: number; h: number };
  pad?: number;
}) {
  const showScalebar = useViewStore((s) => s.showScalebar);
  const color = useViewStore((s) => s.scalebarColor);
  const pos = useViewStore((s) => s.scalebarPos);
  const setPos = useViewStore((s) => s.setScalebarPos);

  // The sizing frame is always rendered, never conditionally. Measuring through
  // the bar's own element instead deadlocks: with no size yet there is no bar,
  // with no bar there is no ref, and so there is never a size.
  const frameRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const dragging = useRef<{ dx: number; dy: number } | null>(null);

  // Track the frame rather than measuring once: collapsing the right panel or
  // resizing the window moves the image without changing zoom or pan.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => setBox({ w: frame.clientWidth, h: frame.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const rectOf = useCallback(() => {
    if (renderedRect) return renderedRect;
    if (!geometry) return { x: 0, y: 0, w: box.w, h: box.h };
    return imageRect(box.w, box.h, geometry.imgW, geometry.imgH, geometry.zoom, geometry.panX, geometry.panY);
  }, [geometry, renderedRect, box.w, box.h]);

  const onPointerDown = (e: React.PointerEvent) => {
    // The panel underneath pans on drag; this one is ours.
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    // Offset from the same reference scalebarPlacement works in (the baseline,
    // i.e. top + block height) rather than from the element's rendered bottom,
    // so the bar cannot drift if the label metrics ever change.
    dragging.current = { dx: e.clientX - r.left, dy: e.clientY - (r.top + SCALEBAR_BLOCK_H) };
    el.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragging.current;
    const frame = frameRef.current;
    if (!drag || !frame) return;
    e.stopPropagation();
    const fr = frame.getBoundingClientRect();
    setPos(
      scalebarPosFromScreen(
        rectOf(),
        e.clientX - fr.left - drag.dx,
        e.clientY - fr.top - drag.dy,
        SCALEBAR_BLOCK_H,
      ),
    );
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  };

  const visible = showScalebar && metrics && box.w > 0 && box.h > 0;
  const place = visible
    ? scalebarPlacement(rectOf(), pos, box.w, box.h, metrics.px, SCALEBAR_BLOCK_H, pad)
    : null;
  const outline = scalebarOutline(color);

  return (
    <div ref={frameRef} className="absolute inset-0 pointer-events-none">
      {visible && place && (
        <div
          className="absolute pointer-events-auto cursor-grab active:cursor-grabbing select-none touch-none"
          style={{
            left: place.x,
            top: place.baseline - SCALEBAR_BLOCK_H,
            width: metrics.px,
            height: SCALEBAR_BLOCK_H,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setPos(null); // back to the image's bottom-left corner
          }}
          title="ドラッグで移動 / ダブルクリックで左下に戻す"
        >
          <div
            className="text-[12px] leading-none whitespace-nowrap pointer-events-none"
            style={{
              color,
              fontFamily: SCALEBAR_FONT,
              // A real stroke painted behind the glyph. text-shadow with a blur
              // radius produces a soft halo that swallows thin dark strokes and
              // reads as out of focus.
              WebkitTextStroke: `2.5px ${outline}`,
              paintOrder: 'stroke fill',
            }}
          >
            {formatUm(metrics.um)}
          </div>
          <div
            className="mt-1 pointer-events-none"
            style={{
              height: 3,
              width: metrics.px,
              backgroundColor: color,
              outline: `1.5px solid ${outline}`,
            }}
          />
        </div>
      )}
    </div>
  );
}
