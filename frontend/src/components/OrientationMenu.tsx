import { useEffect, useRef, useState } from 'react';
import { useImageStore } from '../stores/imageStore';
import { useOperationStore } from '../stores/operationStore';
import { applyOrientation } from '../hooks/useImageLoader';
import {
  IDENTITY_ORIENTATION, ORIENTATION_ROTATIONS, isIdentityOrientation,
  normalizeOrientation, orientationLabel, type Orientation,
} from '../utils/orientation';

/**
 * Rotate / flip the active image. The change is applied by the backend to
 * every plane it serves, so 2D, 3D, saves and plate exports all follow, and
 * it is persisted with the file's other display settings.
 */
export function OrientationMenu() {
  const metadata = useImageStore((s) => s.metadata);
  const activeImageId = useImageStore((s) => s.activeImageId);
  const loading = useImageStore((s) => s.loading);
  const setLoadError = useImageStore((s) => s.setLoadError);
  const threeDSave = useOperationStore((s) => s.threeDSave);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = normalizeOrientation(metadata?.orientation);
  const label = orientationLabel(current);
  const disabled = !metadata || !activeImageId || loading || busy || !!threeDSave;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const change = async (next: Orientation) => {
    if (!activeImageId || busy) return;
    setBusy(true);
    try {
      await applyOrientation(activeImageId, next);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`px-2 py-1 rounded text-xs transition disabled:opacity-40 ${
          label
            ? 'bg-[var(--accent)] text-white'
            : 'bg-[var(--border)] text-[var(--text-secondary)] enabled:hover:text-white'
        }`}
        title="回転・反転。2D/3D/保存/Plate PDF に共通で、ファイルごとに保存されます"
      >
        向き{label ? `: ${label}` : ''}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="表示の向き"
          className="absolute left-0 top-full z-50 mt-1 w-60 rounded-lg border border-[var(--border)]
                     bg-[var(--bg-panel)] p-3 text-xs text-[var(--text-primary)] shadow-2xl"
        >
          <div className="mb-1 text-[10px] text-[var(--text-secondary)]">回転（時計回り）</div>
          <div className="mb-3 flex gap-1">
            {ORIENTATION_ROTATIONS.map((rotation) => (
              <button
                key={rotation}
                type="button"
                onClick={() => change({ ...current, rotation })}
                disabled={busy}
                aria-pressed={current.rotation === rotation}
                className={`flex-1 rounded px-1 py-1 transition disabled:opacity-40 ${
                  current.rotation === rotation
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-white/10 hover:bg-white/20'
                }`}
              >
                {rotation}°
              </button>
            ))}
          </div>
          <label className="mb-1 flex items-center gap-2">
            <input
              type="checkbox"
              checked={current.flipV}
              disabled={busy}
              onChange={(e) => change({ ...current, flipV: e.target.checked })}
            />
            上下反転
          </label>
          <label className="mb-3 flex items-center gap-2">
            <input
              type="checkbox"
              checked={current.flipH}
              disabled={busy}
              onChange={(e) => change({ ...current, flipH: e.target.checked })}
            />
            左右反転
          </label>
          <button
            type="button"
            onClick={() => change(IDENTITY_ORIENTATION)}
            disabled={busy || isIdentityOrientation(current)}
            className="mb-2 w-full rounded bg-white/10 px-2 py-1 hover:bg-white/20 disabled:opacity-40"
          >
            元の向きに戻す
          </button>
          <p className="text-[10px] leading-relaxed text-[var(--text-secondary)]">
            2D・3D・保存・Plate PDF すべてに同じ向きが適用され、このファイルの
            表示設定として保存されます。変更するとクロップとROIは解除されます。
          </p>
        </div>
      )}
    </div>
  );
}
