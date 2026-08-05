import { useViewStore } from '../stores/viewStore';
import { SCALEBAR_COLORS, SCALEBAR_FONT, scalebarOutline } from '../utils/scalebar';

/**
 * Scale bar controls: on/off, length, colour. One component for every view, so
 * a bar set up in 2D looks the same in Split, Compare and 3D.
 */
export function ScalebarSettings({ compact = false }: { compact?: boolean }) {
  const showScalebar = useViewStore((s) => s.showScalebar);
  const setShowScalebar = useViewStore((s) => s.setShowScalebar);
  const scalebarUm = useViewStore((s) => s.scalebarUm);
  const setScalebarUm = useViewStore((s) => s.setScalebarUm);
  const color = useViewStore((s) => s.scalebarColor);
  const setColor = useViewStore((s) => s.setScalebarColor);
  const outline = scalebarOutline(color);

  return (
    <div className={compact ? '' : 'p-3 border-b border-[var(--border)]'}>
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={showScalebar}
          onChange={(e) => setShowScalebar(e.target.checked)}
          className="accent-[var(--accent)]"
        />
        <span className="text-xs font-medium">スケールバー</span>
      </label>

      {showScalebar && (
        <>
          <div className="flex items-center gap-1.5 mt-2">
            <span className="text-[10px] text-[var(--text-secondary)] w-8">長さ</span>
            <input
              type="number"
              min={0}
              step={10}
              value={scalebarUm ?? ''}
              placeholder="自動"
              onChange={(e) => {
                const v = e.target.value.trim();
                setScalebarUm(v === '' ? null : Number(v));
              }}
              className="w-16 bg-[var(--bg-primary)] border border-[var(--border)] rounded px-1 py-0.5 text-[10px] text-right tabular-nums focus:outline-none focus:border-[var(--accent)]"
              title="空欄で自動。数値を入れるとその長さ（µm）で固定します"
            />
            <span className="text-[10px] text-[var(--text-secondary)]">µm</span>
            {scalebarUm !== null && (
              <button
                onClick={() => setScalebarUm(null)}
                className="ml-auto text-[9px] underline text-[var(--text-secondary)] hover:text-white"
              >
                自動
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5 mt-2">
            <span className="text-[10px] text-[var(--text-secondary)] w-8">色</span>
            <div className="flex flex-wrap gap-1">
              {SCALEBAR_COLORS.map((c) => (
                <button
                  key={c.hex}
                  title={c.name}
                  onClick={() => setColor(c.hex)}
                  className={`w-4 h-4 rounded-full border transition hover:scale-110 ${
                    color.toLowerCase() === c.hex
                      ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]'
                      : 'border-white/25'
                  }`}
                  style={{ backgroundColor: c.hex }}
                />
              ))}
              {/* Anything not on the palette — journals sometimes specify a colour. */}
              <label
                className="w-4 h-4 rounded-full border border-white/25 cursor-pointer overflow-hidden relative"
                title="任意の色"
                style={{
                  background:
                    'conic-gradient(#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)',
                }}
              >
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
              </label>
            </div>
          </div>

          {/* Shows the bar as it will actually appear — halo included, so a dark
              colour is still visible here rather than vanishing into the black. */}
          <div className="flex items-center gap-2 mt-2 bg-black rounded px-2 py-1.5">
            <span
              className="text-[10px]"
              style={{
                color,
                fontFamily: SCALEBAR_FONT,
                textShadow: `0 0 3px ${outline}, 0 1px 2px ${outline}`,
              }}
            >
              {scalebarUm !== null ? `${scalebarUm} µm` : '自動'}
            </span>
            <div
              className="h-[3px] flex-1 rounded"
              style={{ backgroundColor: color, boxShadow: `0 0 0 1px ${outline}` }}
            />
          </div>
        </>
      )}
    </div>
  );
}
