import { useImageStore } from '../stores/imageStore';

export function MetadataPanel() {
  const metadata = useImageStore((s) => s.metadata);
  if (!metadata) return null;

  const items = [
    ['File', metadata.filename],
    ['Size', `${metadata.width} \u00d7 ${metadata.height}`],
    ['Channels', `${metadata.num_channels}`],
    ['Z slices', `${metadata.num_z}`],
    ['Time points', `${metadata.num_t}`],
    ['Pixel size', `${metadata.pixel_size_x} \u00d7 ${metadata.pixel_size_y} \u00b5m`],
    ['Z step', `${metadata.pixel_size_z} \u00b5m`],
    ['Bit depth', `${metadata.bit_depth}-bit`],
  ];

  return (
    <div className="bg-[var(--bg-panel)] border-t border-[var(--border)] p-3">
      <h3 className="text-xs font-semibold text-[var(--text-secondary)] mb-2">Metadata</h3>
      <div className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-xs">
        {items.map(([label, value]) => (
          <div key={label} className="contents">
            <span className="text-[var(--text-secondary)]">{label}</span>
            <span className="font-mono">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
