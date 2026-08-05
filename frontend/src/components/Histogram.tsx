import { useEffect, useRef } from 'react';
import { useImageStore } from '../stores/imageStore';
import { effectiveScale } from '../utils/intensity';

interface Props {
  channelIndex: number;
}

export function Histogram({ channelIndex }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ch = useImageStore((s) => s.channels[channelIndex]);
  // Same axis as the Min/Max sliders, so the handles line up with the data.
  // Spanning the declared bit depth instead squeezed the whole distribution
  // into the leftmost few pixels of the plot.
  const bitDepth = useImageStore((s) => s.metadata?.bit_depth ?? 16);
  const maxIntensity = effectiveScale(ch?.controlMax, bitDepth);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ch?.data) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Compute histogram from raw data
    const bins = w;
    const counts = new Float64Array(bins);
    const data = ch.data;
    const binSize = (maxIntensity + 1) / bins;

    for (let i = 0; i < data.length; i++) {
      const val = Math.min(data[i], maxIntensity);
      const bin = Math.min(bins - 1, Math.floor(val / binSize));
      counts[bin]++;
    }

    // Use log scale for better visualization
    const logCounts = new Float64Array(bins);
    for (let i = 0; i < bins; i++) {
      logCounts[i] = counts[i] > 0 ? Math.log(counts[i]) : 0;
    }
    const maxLog = Math.max(...logCounts);
    if (maxLog === 0) return;

    // Draw histogram
    const [r, g, b] = ch.color;
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.3)`;
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.7)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < bins; i++) {
      const barH = (logCounts[i] / maxLog) * h;
      ctx.lineTo(i, h - barH);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Draw min/max markers
    const minX = (ch.min / maxIntensity) * w;
    const maxX = (ch.max / maxIntensity) * w;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(minX, 0);
    ctx.lineTo(minX, h);
    ctx.moveTo(maxX, 0);
    ctx.lineTo(maxX, h);
    ctx.stroke();
    ctx.setLineDash([]);
  }, [ch, maxIntensity]);

  return (
    <canvas
      ref={canvasRef}
      width={200}
      height={40}
      className="w-full h-10 rounded bg-black/30"
    />
  );
}
