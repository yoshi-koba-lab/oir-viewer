import { useCallback, useRef } from 'react';
import {
  cropOwnerForMetadata,
  sameCropOwner,
  useViewStore,
  type CropRect,
} from '../stores/viewStore';
import {
  clientPointFromSource,
  moveCropRect,
  resizeCropRect,
  cropRectFromDragPoints,
  sourcePointFromClient,
  type CropHandle,
  type CropViewportFitRect,
} from '../utils/crop';
import { useOperationStore } from '../stores/operationStore';
import { useImageStore } from '../stores/imageStore';
import { imageOperationIsBusy } from '../hooks/useImageLoader';

interface Props {
  width: number;
  height: number;
  zoom: number;
  panX: number;
  panY: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** 2D canvas whose CSS frame is used by the renderer. Optional for 3D. */
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  /** 3D uses the unobscured renderer viewport as a simple display fraction. */
  fitToCanvas?: boolean;
  /** Optional projected source-plane bounds inside the renderer viewport. */
  fitRect?: CropViewportFitRect;
}

type Point = { x: number; y: number };
type Drag =
  | { kind: 'draw'; start: Point }
  | { kind: 'move'; start: Point; rect: CropRect }
  | { kind: 'resize'; start: Point; rect: CropRect; handle: CropHandle };

const HANDLE_RADIUS = 7;

/**
 * Interactive crop selection for the 2D viewport. The selection is stored in
 * source pixel coordinates, independent of zoom/pan, so coordinate edits and
 * exports share exactly the same rectangle.
 */
export function CropOverlay({
  width, height, zoom, panX, panY, containerRef, canvasRef, fitToCanvas = false, fitRect,
}: Props) {
  const cropActive = useViewStore((s) => s.cropActive);
  const threeDSaveBusy = useOperationStore((s) => !!s.threeDSave);
  const cropRect = useViewStore((s) => s.cropRect);
  const cropOwner = useViewStore((s) => s.cropOwner);
  const setCropRect = useViewStore((s) => s.setCropRect);
  const activeImageId = useImageStore((s) => s.activeImageId);
  const metadata = useImageStore((s) => s.metadata);
  const currentOwner = cropOwnerForMetadata(activeImageId, metadata);
  const ownerMatches = !cropRect || sameCropOwner(cropOwner, currentOwner);
  const imageLoading = useImageStore((s) => s.loading);
  const canEdit = cropActive && !threeDSaveBusy && !imageLoading
    && !imageOperationIsBusy() && ownerMatches && !!currentOwner;
  const displayRect = ownerMatches ? cropRect : null;
  const dragRef = useRef<Drag | null>(null);

  // The canvas is the renderer's source of truth for CSS geometry. The outer
  // flex wrapper can briefly differ while a settings dock opens; using it for
  // source conversion makes the visible square and exported rectangle diverge.
  const frameRect = useCallback(() => (
    canvasRef?.current?.getBoundingClientRect()
      ?? containerRef.current?.getBoundingClientRect()
      ?? null
  ), [canvasRef, containerRef]);

  const toImage = useCallback((clientX: number, clientY: number): Point | null => {
    const rect = frameRect();
    if (!rect || zoom <= 0) return null;
    return sourcePointFromClient(
      clientX, clientY,
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      width, height, zoom, panX, panY, fitToCanvas,
      fitRect,
    );
  }, [fitRect, fitToCanvas, frameRect, height, panX, panY, width, zoom]);

  const toScreen = useCallback((x: number, y: number): Point | null => {
    const frame = frameRect();
    const overlay = containerRef.current?.getBoundingClientRect();
    if (!frame || !overlay) return null;
    const client = clientPointFromSource(
      x, y,
      { left: frame.left, top: frame.top, width: frame.width, height: frame.height },
      width, height, zoom, panX, panY, fitToCanvas,
      fitRect,
    );
    return client ? { x: client.x - overlay.left, y: client.y - overlay.top } : null;
  }, [containerRef, fitRect, fitToCanvas, frameRect, height, panX, panY, width, zoom]);

  const handlePositions = useCallback((box: CropRect): Record<CropHandle, Point> => ({
    nw: { x: box.x, y: box.y },
    n: { x: box.x + box.width / 2, y: box.y },
    ne: { x: box.x + box.width, y: box.y },
    e: { x: box.x + box.width, y: box.y + box.height / 2 },
    se: { x: box.x + box.width, y: box.y + box.height },
    s: { x: box.x + box.width / 2, y: box.y + box.height },
    sw: { x: box.x, y: box.y + box.height },
    w: { x: box.x, y: box.y + box.height / 2 },
  }), []);

  const hitHandle = useCallback((point: Point, box: CropRect): CropHandle | null => {
    const handles = handlePositions(box);
    // In a fitted 3D viewport one source pixel may occupy far less than one
    // CSS pixel. Convert the handle's visual hit radius back to source units
    // so handles remain grab-able at both 2D zoom and 3D fit scales.
    const frameScale = fitToCanvas && containerRef.current
      ? Math.min(
          (fitRect?.width ?? containerRef.current.clientWidth) / Math.max(width, 1),
          (fitRect?.height ?? containerRef.current.clientHeight) / Math.max(height, 1),
        )
      : zoom;
    const tolerance = HANDLE_RADIUS / Math.max(frameScale, 0.01);
    for (const [name, hp] of Object.entries(handles) as [CropHandle, Point][]) {
      if (Math.hypot(point.x - hp.x, point.y - hp.y) <= tolerance) return name;
    }
    return null;
  }, [containerRef, fitRect, fitToCanvas, handlePositions, height, width, zoom]);

  const pointerDown = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (!canEdit || imageOperationIsBusy() || event.button !== 0) return;
    const point = toImage(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    const box = cropRect;
    const handle = box ? hitHandle(point, box) : null;
    if (box && handle) {
      dragRef.current = { kind: 'resize', start: point, rect: box, handle };
    } else if (box && point.x >= box.x && point.x <= box.x + box.width
      && point.y >= box.y && point.y <= box.y + box.height) {
      dragRef.current = { kind: 'move', start: point, rect: box };
    } else {
      dragRef.current = { kind: 'draw', start: point };
      setCropRect(null);
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [canEdit, cropRect, hitHandle, setCropRect, toImage]);

  const pointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || !canEdit || imageOperationIsBusy()) return;
    const point = toImage(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    const next = drag.kind === 'draw'
      ? cropRectFromDragPoints(drag.start, point, width, height)
      : drag.kind === 'move'
        ? moveCropRect(drag.rect, point.x - drag.start.x, point.y - drag.start.y, width, height)
        : resizeCropRect(drag.rect, drag.handle, point, width, height);
    if (currentOwner) setCropRect(next, currentOwner);
  }, [canEdit, currentOwner, height, setCropRect, toImage, width]);

  const pointerUp = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  // The SVG is positioned over the live container. Reading its current
  // bounding box here keeps the overlay in step with a canvas resize; this is
  // an intentional render-time geometry read, not mutable interaction state.
  /* eslint-disable react-hooks/refs */
  const screenBox = displayRect && toScreen(displayRect.x, displayRect.y);
  const screenBottom = displayRect && toScreen(displayRect.x + displayRect.width, displayRect.y + displayRect.height);
  const screenW = screenBox && screenBottom ? screenBottom.x - screenBox.x : 0;
  const screenH = screenBox && screenBottom ? screenBottom.y - screenBox.y : 0;
  const handles = canEdit && displayRect ? handlePositions(displayRect) : null;
  const cursors: Record<CropHandle, string> = {
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
    ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
  };

  return (
    <svg
      className="absolute inset-0 h-full w-full"
      style={{ pointerEvents: canEdit ? 'all' : 'none' }}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
      aria-label="2D crop selection"
    >
      {canEdit && !displayRect && (
        <text x={12} y={28} fill="white" fontSize={12} opacity={0.85} pointerEvents="none">
          ドラッグして切り出し範囲を指定
        </text>
      )}
      {displayRect && screenBox && (
        <>
          {cropActive && (
            <>
              {/* Four curtains leave the selected pixels unobscured. */}
              <rect x={0} y={0} width="100%" height={screenBox.y} fill="black" fillOpacity={0.48} pointerEvents="none" />
              <rect x={0} y={screenBox.y + screenH} width="100%" height="100%" fill="black" fillOpacity={0.48} pointerEvents="none" />
              <rect x={0} y={screenBox.y} width={screenBox.x} height={screenH} fill="black" fillOpacity={0.48} pointerEvents="none" />
              <rect x={screenBox.x + screenW} y={screenBox.y} width="100%" height={screenH} fill="black" fillOpacity={0.48} pointerEvents="none" />
            </>
          )}
          <rect x={screenBox.x} y={screenBox.y} width={screenW} height={screenH}
            fill="none" stroke="#36d399" strokeOpacity={cropActive ? 1 : 0.75}
            strokeWidth={2} vectorEffect="non-scaling-stroke" pointerEvents="none" />
          {canEdit && handles && (Object.entries(handles) as [CropHandle, Point][]).map(([name, point]) => {
            const screen = toScreen(point.x, point.y);
            if (!screen) return null;
            return (
              <rect
                key={name}
                x={screen.x - HANDLE_RADIUS / 2}
                y={screen.y - HANDLE_RADIUS / 2}
                width={HANDLE_RADIUS}
                height={HANDLE_RADIUS}
                rx={1}
                fill="#36d399"
                stroke="white"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                style={{ cursor: cursors[name] }}
              />
            );
          })}
        </>
      )}
    </svg>
  );
}
