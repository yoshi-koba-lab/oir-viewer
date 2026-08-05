import { useEffect, useState } from 'react';
import { useViewStore } from '../stores/viewStore';
import { useImageStore } from '../stores/imageStore';
import { fetchProfile, type ProfileData } from '../utils/api';

export function IntensityProfile() {
  const activeRoiId = useViewStore((s) => s.activeRoiId);
  const rois = useViewStore((s) => s.rois);
  const channels = useImageStore((s) => s.channels);
  const currentZ = useImageStore((s) => s.currentZ);
  const currentT = useImageStore((s) => s.currentT);
  const [profiles, setProfiles] = useState<{ ch: number; data: ProfileData }[]>([]);

  const activeRoi = rois.find((r) => r.id === activeRoiId);

  useEffect(() => {
    if (!activeRoi || activeRoi.type !== 'line') {
      setProfiles([]);
      return;
    }

    const loadProfiles = async () => {
      const results: { ch: number; data: ProfileData }[] = [];
      for (let c = 0; c < channels.length; c++) {
        if (!channels[c].visible) continue;
        const data = await fetchProfile({
          c,
          z: currentZ,
          t: currentT,
          x0: activeRoi.params.x0,
          y0: activeRoi.params.y0,
          x1: activeRoi.params.x1,
          y1: activeRoi.params.y1,
        });
        results.push({ ch: c, data });
      }
      setProfiles(results);
    };

    loadProfiles();
  }, [activeRoi, channels, currentZ, currentT]);

  if (!activeRoi || activeRoi.type !== 'line' || profiles.length === 0) return null;

  // Find max intensity for scaling
  const allIntensities = profiles.flatMap((p) => p.data.intensities);
  const maxI = Math.max(...allIntensities, 1);
  const maxD = Math.max(...profiles[0].data.distances, 1);

  const w = 300;
  const h = 120;
  const pad = { t: 10, r: 10, b: 25, l: 45 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;

  return (
    <div className="bg-[var(--bg-panel)] border-t border-[var(--border)] p-2">
      <div className="text-xs text-[var(--text-secondary)] mb-1">Intensity Profile</div>
      <svg width={w} height={h} className="w-full" viewBox={`0 0 ${w} ${h}`}>
        {/* Grid */}
        <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + plotH} stroke="#333" strokeWidth="1" />
        <line x1={pad.l} y1={pad.t + plotH} x2={pad.l + plotW} y2={pad.t + plotH} stroke="#333" strokeWidth="1" />
        {/* Y axis label */}
        <text x={5} y={pad.t + plotH / 2} fill="#666" fontSize="9" textAnchor="middle" transform={`rotate(-90, 5, ${pad.t + plotH / 2})`}>
          Intensity
        </text>
        {/* X axis label */}
        <text x={pad.l + plotW / 2} y={h - 3} fill="#666" fontSize="9" textAnchor="middle">
          Distance ({profiles[0].data.distance_unit || 'px'})
        </text>

        {/* Profiles */}
        {profiles.map((p) => {
          const [r, g, b] = channels[p.ch].color;
          const points = p.data.distances
            .map((d, i) => {
              const x = pad.l + (d / maxD) * plotW;
              const y = pad.t + plotH - (p.data.intensities[i] / maxI) * plotH;
              return `${x},${y}`;
            })
            .join(' ');
          return (
            <polyline
              key={p.ch}
              points={points}
              fill="none"
              stroke={`rgb(${r},${g},${b})`}
              strokeWidth="1.5"
            />
          );
        })}
      </svg>
    </div>
  );
}
