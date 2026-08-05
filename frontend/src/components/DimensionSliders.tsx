import { useEffect, useRef, useCallback, useState } from 'react';
import { useImageStore } from '../stores/imageStore';
import { useViewStore } from '../stores/viewStore';

export function DimensionSliders() {
  const metadata = useImageStore((s) => s.metadata);
  const currentT = useImageStore((s) => s.currentT);
  const setCurrentT = useImageStore((s) => s.setCurrentT);
  const { playingT, setPlayingT } = useViewStore();
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keyboard: up/down (and left/right) arrows for Z
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept if user is typing in an input
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      // Only where a Z control is actually on screen. In 3D the whole stack is
      // rendered and in Compare each panel has its own Z, so a global arrow-key
      // Z change there moved hidden state the user could not see.
      const mode = useViewStore.getState().viewMode;
      if (mode !== '2d' && mode !== 'split') return;

      const store = useImageStore.getState();
      const meta = store.metadata;
      if (!meta || meta.num_z <= 1 || store.showMIP) return;

      // Up/Down match the vertical strip's ▲/▼; Left/Right kept for muscle memory.
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        store.setCurrentZ(store.currentZ - 1);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        store.setCurrentZ(store.currentZ + 1);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Time playback
  useEffect(() => {
    if (playingT && metadata && metadata.num_t > 1) {
      timerRef.current = setInterval(() => {
        const store = useImageStore.getState();
        const next = (store.currentT + 1) % store.metadata!.num_t;
        store.setCurrentT(next);
      }, 500);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [playingT, metadata]);

  const togglePlay = useCallback(() => {
    setPlayingT(!playingT);
  }, [playingT, setPlayingT]);

  // Bottom bar now only hosts the T (time) slider; Z lives in the left strip.
  if (!metadata || metadata.num_t <= 1) return null;

  return (
    <div className="bg-[var(--bg-secondary)] border-t border-[var(--border)] px-4 py-2 flex items-center gap-6">
      <div className="flex items-center gap-2 flex-1">
        <span className="text-xs font-mono text-[var(--text-secondary)] w-6">T</span>
        <button
          onClick={togglePlay}
          className="text-xs w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--border)] transition"
        >
          {playingT ? (
            <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor">
              <rect x="2" y="2" width="3" height="8" />
              <rect x="7" y="2" width="3" height="8" />
            </svg>
          ) : (
            <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor">
              <polygon points="2,1 11,6 2,11" />
            </svg>
          )}
        </button>
        <input
          type="range"
          min={0}
          max={metadata.num_t - 1}
          value={currentT}
          onChange={(e) => setCurrentT(Number(e.target.value))}
          className="flex-1"
        />
        <span className="text-xs font-mono text-[var(--text-secondary)] w-12 text-right">
          {currentT}/{metadata.num_t - 1}
        </span>
      </div>
    </div>
  );
}

/** Vertical Z (depth) slider shown on the left edge of the viewport. Top = z0. */
export function ZSliderVertical() {
  const metadata = useImageStore((s) => s.metadata);
  const currentZ = useImageStore((s) => s.currentZ);
  const showMIP = useImageStore((s) => s.showMIP);
  const setCurrentZ = useImageStore((s) => s.setCurrentZ);
  const setShowMIP = useImageStore((s) => s.setShowMIP);

  if (!metadata || metadata.num_z <= 1) return null;

  const stepBtn =
    'text-xs w-6 h-6 flex items-center justify-center rounded bg-[var(--border)] text-[var(--text-secondary)] hover:text-white disabled:opacity-30 transition shrink-0';

  return (
    // min-h-0 + a shrinkable track keep the Z number and MIP toggle on screen at
    // short window heights; without it the flex-1 range pushed them out of view.
    <div className="flex flex-col items-center gap-2 py-3 px-2 bg-[var(--bg-secondary)] border-r border-[var(--border)] shrink-0 min-h-0 overflow-hidden select-none">
      <span className="text-xs font-mono text-[var(--text-secondary)]">Z</span>

      {/* Up = toward z0 (shallower) */}
      <button
        onClick={() => setCurrentZ(currentZ - 1)}
        disabled={showMIP || currentZ === 0}
        className={stepBtn}
        title="Previous Z (↑ / ←)"
      >
        &#9650;
      </button>

      {/* Vertical range: top = min (z0), bottom = max (deepest).
          `direction: rtl` would invert that and fight the ▲/▼ buttons, so keep ltr. */}
      <input
        type="range"
        min={0}
        max={metadata.num_z - 1}
        value={currentZ}
        onChange={(e) => setCurrentZ(Number(e.target.value))}
        disabled={showMIP}
        title={`Z position (${currentZ + 1}/${metadata.num_z}) — top is the first slice`}
        className="flex-1 min-h-0 accent-[var(--accent)] disabled:opacity-40"
        style={{ writingMode: 'vertical-lr', width: '22px', minHeight: '48px' }}
      />

      {/* Down = toward last slice (deeper) */}
      <button
        onClick={() => setCurrentZ(currentZ + 1)}
        disabled={showMIP || currentZ === metadata.num_z - 1}
        className={stepBtn}
        title="Next Z (↓ / →)"
      >
        &#9660;
      </button>

      <ZInputDisplay
        value={currentZ}
        total={metadata.num_z}
        onChange={setCurrentZ}
        disabled={showMIP}
        vertical
      />

      <button
        onClick={() => setShowMIP(!showMIP)}
        className={`text-xs px-2 py-1 rounded transition shrink-0 ${
          showMIP
            ? 'bg-[var(--accent)] text-white'
            : 'bg-[var(--border)] text-[var(--text-secondary)] hover:text-white'
        }`}
        title="Maximum Intensity Projection"
      >
        MIP
      </button>
    </div>
  );
}

/** Editable Z position display: shows 1-based x/n format. Internal value is 0-based. */
function ZInputDisplay({
  value,
  total,
  onChange,
  disabled,
  vertical = false,
}: {
  value: number;
  total: number;
  onChange: (v: number) => void;
  disabled: boolean;
  vertical?: boolean;
}) {
  const display = value + 1; // 0-based -> 1-based
  const [localValue, setLocalValue] = useState(String(display));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setLocalValue(String(value + 1));
    }
  }, [value]);

  const commit = () => {
    const num = parseInt(localValue, 10);
    if (!isNaN(num)) {
      const clamped = Math.max(1, Math.min(total, num));
      onChange(clamped - 1); // 1-based -> 0-based
      setLocalValue(String(clamped));
    } else {
      setLocalValue(String(value + 1));
    }
  };

  return (
    <span
      className={`text-xs font-mono text-[var(--text-secondary)] flex ${
        vertical ? 'flex-col items-center gap-0.5' : 'items-center gap-0.5'
      } ${disabled ? 'opacity-40 pointer-events-none' : ''}`}
    >
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            inputRef.current?.blur();
          }
          if (e.key === 'Escape') {
            setLocalValue(String(value + 1));
            inputRef.current?.blur();
          }
        }}
        disabled={disabled}
        className="w-8 bg-[var(--bg-primary)] border border-[var(--border)] rounded px-1 text-center text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
      />
      <span>{vertical ? `/${total}` : '/'}</span>
      {!vertical && <span>{total}</span>}
    </span>
  );
}
