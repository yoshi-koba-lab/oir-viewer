import { useState, useRef, useEffect } from 'react';
import { useImageStore } from '../stores/imageStore';
import { LUTS } from '../utils/colormap';
import { controlScale, fullScaleFor } from '../utils/intensity';
import { Histogram } from './Histogram';

export function ChannelPanel() {
  const metadata = useImageStore((s) => s.metadata);
  const channels = useImageStore((s) => s.channels);
  const toggleChannel = useImageStore((s) => s.toggleChannel);
  const setChannelColor = useImageStore((s) => s.setChannelColor);
  const setChannelRange = useImageStore((s) => s.setChannelRange);
  const autoContrastChannel = useImageStore((s) => s.autoContrastChannel);
  const autoContrastAll = useImageStore((s) => s.autoContrastAll);

  if (!metadata) return null;

  return (
    <div className="bg-[var(--bg-panel)] flex flex-col">
      <div className="p-3 border-b border-[var(--border)] flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Channels</h3>
        <button
          onClick={autoContrastAll}
          className="text-xs px-2 py-1 rounded bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition"
        >
          Auto All
        </button>
      </div>

      {channels.map((ch, i) => {
        // The controls span the channel's own scale, not the declared bit depth:
        // 12-bit data that tops out near 600 gave a 0..4095 slider whose upper
        // 86% did nothing, which is why the contrast read as broken.
        const maxIntensity = controlScale(ch, metadata.bit_depth);
        // The slider's track is the channel's own scale, but a typed number is
        // clamped only by what the format can hold. Clamping the box to the
        // track too would silently rewrite a value the user chose deliberately —
        // e.g. matching a dim channel to a bright one's display range.
        const typedMax = fullScaleFor(metadata.bit_depth);
        return (
        <div key={i} className="p-3 border-b border-[var(--border)]">
          <div className="flex items-center gap-2 mb-2">
            {/* Toggle */}
            <button
              onClick={() => toggleChannel(i)}
              className="w-5 h-5 rounded border-2 flex items-center justify-center shrink-0"
              style={{
                borderColor: `rgb(${ch.color.join(',')})`,
                backgroundColor: ch.visible ? `rgb(${ch.color.join(',')})` : 'transparent',
              }}
            >
              {ch.visible && (
                <svg className="w-3 h-3 text-black" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M2 6l3 3 5-5" />
                </svg>
              )}
            </button>

            {/* Channel name */}
            <span className="text-sm font-medium flex-1">
              {metadata.channel_names[i] || `Ch${i}`}
              {metadata.channel_types?.[i] === 'transmitted' && (
                <span className="ml-1 text-[10px] text-[var(--text-secondary)] font-normal">(DIC)</span>
              )}
            </span>

            {/* Auto contrast */}
            <button
              onClick={() => autoContrastChannel(i)}
              className="text-xs text-[var(--text-secondary)] hover:text-white transition"
              title="Auto contrast"
            >
              Auto
            </button>
          </div>

          {/* LUT selector */}
          <div className="flex gap-1 mb-2">
            {LUTS.map((lut) => (
              <button
                key={lut.name}
                onClick={() => setChannelColor(i, lut.color)}
                className="w-5 h-5 rounded-full border border-white/20 hover:scale-110 transition"
                style={{ backgroundColor: `rgb(${lut.color.join(',')})` }}
                title={lut.name}
              />
            ))}
          </div>

          {/* Histogram */}
          <Histogram channelIndex={i} />

          {/* Min slider */}
          <div className="flex items-center gap-2 mt-2">
            <span className="text-[10px] text-[var(--text-secondary)] w-7">Min</span>
            <input
              type="range"
              min={0}
              max={maxIntensity}
              value={ch.min}
              onChange={(e) => setChannelRange(i, Number(e.target.value), ch.max)}
              className="flex-1"
            />
            <EditableNumber
              value={Math.round(ch.min)}
              min={0}
              max={typedMax}
              onChange={(v) => setChannelRange(i, v, ch.max)}
            />
          </div>

          {/* Max slider */}
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[10px] text-[var(--text-secondary)] w-7">Max</span>
            <input
              type="range"
              min={0}
              max={maxIntensity}
              value={ch.max}
              onChange={(e) => setChannelRange(i, ch.min, Number(e.target.value))}
              className="flex-1"
            />
            <EditableNumber
              value={Math.round(ch.max)}
              min={0}
              max={typedMax}
              onChange={(v) => setChannelRange(i, ch.min, v)}
            />
          </div>
        </div>
        );
      })}
    </div>
  );
}

function EditableNumber({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const [localValue, setLocalValue] = useState(String(value));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setLocalValue(String(value));
    }
  }, [value]);

  const commit = () => {
    const num = parseInt(localValue, 10);
    if (!isNaN(num)) {
      const clamped = Math.max(min, Math.min(max, num));
      onChange(clamped);
      setLocalValue(String(clamped));
    } else {
      setLocalValue(String(value));
    }
  };

  return (
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
          setLocalValue(String(value));
          inputRef.current?.blur();
        }
      }}
      className="w-12 text-[10px] font-mono text-right text-[var(--text-secondary)] bg-[var(--bg-primary)] border border-[var(--border)] rounded px-1 py-0.5 focus:outline-none focus:border-[var(--accent)] focus:text-[var(--text-primary)]"
    />
  );
}
