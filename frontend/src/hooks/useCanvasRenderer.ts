import { useCallback, useMemo } from 'react';
import { useImageStore } from '../stores/imageStore';
import { useViewStore } from '../stores/viewStore';

export function useCanvasRenderer() {
  const channels = useImageStore((s) => s.channels);
  const metadata = useImageStore((s) => s.metadata);
  const { zoom, panX, panY } = useViewStore();

  // Composite all channels into an offscreen canvas. This is the expensive
  // per-pixel work — memoise it so it only re-runs when the pixel data or
  // contrast/color/visibility changes, NOT on every pan/zoom.
  const composite = useMemo(() => {
    if (!metadata) return null;
    const { width, height } = metadata;
    const offscreen = new OffscreenCanvas(width, height);
    const offCtx = offscreen.getContext('2d');
    if (!offCtx) return null;
    const imageData = offCtx.createImageData(width, height);
    const pixels = imageData.data; // RGBA

    for (const ch of channels) {
      if (!ch.visible || !ch.data) continue;
      const [r, g, b] = ch.color;
      const range = ch.max - ch.min;
      const invRange = range > 0 ? 1 / range : 0;

      for (let i = 0; i < width * height; i++) {
        const norm = Math.min(1, Math.max(0, (ch.data[i] - ch.min) * invRange));
        const idx = i * 4;
        // Additive blending
        pixels[idx] = Math.min(255, pixels[idx] + norm * r);
        pixels[idx + 1] = Math.min(255, pixels[idx + 1] + norm * g);
        pixels[idx + 2] = Math.min(255, pixels[idx + 2] + norm * b);
        pixels[idx + 3] = 255;
      }
    }
    offCtx.putImageData(imageData, 0, 0);
    return offscreen;
  }, [channels, metadata]);

  // Cheap: just blit the cached composite with the current zoom/pan.
  const render = useCallback(
    (canvas: HTMLCanvasElement) => {
      if (!metadata || !composite) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const { width, height } = metadata;

      const dpr = window.devicePixelRatio;
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = zoom < 4;
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

      const cx = canvas.clientWidth / 2;
      const cy = canvas.clientHeight / 2;
      const drawW = width * zoom;
      const drawH = height * zoom;
      const dx = cx - drawW / 2 + panX;
      const dy = cy - drawH / 2 + panY;

      ctx.drawImage(composite, dx, dy, drawW, drawH);
    },
    [composite, metadata, zoom, panX, panY]
  );

  return { render };
}
