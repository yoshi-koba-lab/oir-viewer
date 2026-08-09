import { useEffect, useState } from 'react';
import { useViewStore } from '../stores/viewStore';
import { useImageStore } from '../stores/imageStore';
import { fetchMeasure, type MeasureData } from '../utils/api';

interface MeasurementResult {
  imageId: string;
  sourceIdentity: string;
  sourceRevision: string;
  roiId: string;
  z: number;
  t: number;
  values: { ch: number; data: MeasureData }[];
}

export function MeasurementPanel() {
  const activeRoiId = useViewStore((s) => s.activeRoiId);
  const rois = useViewStore((s) => s.rois);
  const channels = useImageStore((s) => s.channels);
  const metadata = useImageStore((s) => s.metadata);
  const activeImageId = useImageStore((s) => s.activeImageId);
  const currentZ = useImageStore((s) => s.currentZ);
  const currentT = useImageStore((s) => s.currentT);
  const showMIP = useImageStore((s) => s.showMIP);
  const projectionActive = useImageStore((s) => s.projection.active);
  const viewMode = useViewStore((s) => s.viewMode);
  const [result, setResult] = useState<MeasurementResult | null>(null);

  const activeRoi = rois.find((r) => r.id === activeRoiId);

  useEffect(() => {
    if (!activeRoi || activeRoi.type === 'line' || !activeImageId || !metadata
        || viewMode !== '2d' || showMIP || projectionActive) {
      setResult(null);
      return;
    }

    let cancelled = false;
    const requestImageId = activeImageId;
    const requestIdentity = metadata.source_identity;
    const requestRevision = metadata.source_revision;
    const requestRoiId = activeRoi.id;
    const stillCurrent = () => {
      const image = useImageStore.getState();
      const view = useViewStore.getState();
      return !cancelled
        && image.activeImageId === requestImageId
        && image.metadata?.source_identity === requestIdentity
        && image.metadata?.source_revision === requestRevision
        && image.currentZ === currentZ
        && image.currentT === currentT
        && view.activeRoiId === requestRoiId;
    };

    const loadMeasurements = async () => {
      const results: { ch: number; data: MeasureData }[] = [];
      try {
        for (let c = 0; c < channels.length; c++) {
          if (!channels[c].visible) continue;
          const data = await fetchMeasure({
            id: requestImageId,
            c,
            z: currentZ,
            t: currentT,
            roi_type: activeRoi.type,
            params: activeRoi.params,
          });
          if (!stillCurrent()) return;
          results.push({ ch: c, data });
        }
        if (stillCurrent()) {
          setResult({
            imageId: requestImageId,
            sourceIdentity: requestIdentity,
            sourceRevision: requestRevision,
            roiId: requestRoiId,
            z: currentZ,
            t: currentT,
            values: results,
          });
        }
      } catch (error) {
        if (stillCurrent()) {
          useImageStore.getState().setLoadError(
            `ROI measurement failed: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    };

    void loadMeasurements();
    return () => { cancelled = true; };
  }, [
    activeRoi, activeImageId, metadata, channels, currentZ, currentT,
    viewMode, showMIP, projectionActive,
  ]);

  const measurements = result
    && result.imageId === activeImageId
    && result.sourceIdentity === metadata?.source_identity
    && result.sourceRevision === metadata?.source_revision
    && result.roiId === activeRoiId
    && result.z === currentZ
    && result.t === currentT && viewMode === '2d' && !showMIP && !projectionActive
    ? result.values : [];

  if (!activeRoi || activeRoi.type === 'line' || measurements.length === 0) return null;

  return (
    <div className="bg-[var(--bg-panel)] border-t border-[var(--border)] p-2">
      <div className="text-xs text-[var(--text-secondary)] mb-2">
        ROI Measurement ({activeRoi.type})
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[var(--text-secondary)]">
            <th className="text-left py-1">Ch</th>
            <th className="text-right py-1">Mean</th>
            <th className="text-right py-1">Std</th>
            <th className="text-right py-1">Min</th>
            <th className="text-right py-1">Max</th>
          </tr>
        </thead>
        <tbody>
          {measurements.map((m) => (
            <tr key={m.ch} className="text-[var(--text-primary)]">
              <td className="py-0.5" style={{ color: `rgb(${channels[m.ch].color.join(',')})` }}>
                {metadata?.channel_names[m.ch] || `Ch${m.ch}`}
              </td>
              <td className="text-right font-mono">{m.data.mean.toFixed(1)}</td>
              <td className="text-right font-mono">{m.data.std.toFixed(1)}</td>
              <td className="text-right font-mono">{m.data.min}</td>
              <td className="text-right font-mono">{m.data.max}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {measurements[0] && (
        <div className="text-[10px] text-[var(--text-secondary)] mt-1">
          {/* JSX text does not process \u escapes \u2014 use the characters directly. */}
          Area: {measurements[0].data.area_pixels} px ({measurements[0].data.area_um2.toFixed(2)} \u00b5m\u00b2)
        </div>
      )}
    </div>
  );
}
