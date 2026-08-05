import { useEffect, useRef } from 'react';
import { useImageStore } from '../stores/imageStore';
import { switchToImage, closeImageById } from '../hooks/useImageLoader';

/**
 * Shorten a filename for a tab, keeping BOTH ends visible.
 * Microscopy filenames share a long stem and differ only in the middle
 * (marker) or the tail (`-1` / `-2`), so a plain end-truncation can make two
 * different files look identical. Eliding the middle keeps the tail — the part
 * that distinguishes repeat acquisitions of the same sample.
 */
function shortenName(name: string, max = 34): string {
  if (name.length <= max) return name;
  const tail = 16; // e.g. "DAPI-b-x20-2.oir"
  const head = Math.max(4, max - tail - 1);
  return `${name.slice(0, head)}…${name.slice(-tail)}`;
}

export function FileTabBar() {
  const imageList = useImageStore((s) => s.imageList);
  const activeImageId = useImageStore((s) => s.activeImageId);
  const activeRef = useRef<HTMLDivElement>(null);

  // Keep the active tab visible: with many files open it can otherwise sit
  // off-screen in the scroll container with no indication of which is current.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeImageId, imageList.length]);

  if (imageList.length <= 1) return null;

  return (
    <div className="bg-[var(--bg-primary)] border-b border-[var(--border)] flex items-center overflow-x-auto scrollbar-thin">
      {imageList.map((img) => {
        const isActive = img.id === activeImageId;
        return (
          <div
            key={img.id}
            ref={isActive ? activeRef : undefined}
            className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer border-r border-[var(--border)] shrink-0 transition-colors ${
              isActive
                ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] border-b-2 border-b-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
            }`}
            onClick={() => switchToImage(img.id)}
            title={`${img.filename} (${img.width}×${img.height}, ${img.num_channels}ch, Z${img.num_z}${img.num_t > 1 ? `, T${img.num_t}` : ''})`}
          >
            <span className="font-mono whitespace-nowrap">{shortenName(img.filename)}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeImageById(img.id);
              }}
              className="w-4 h-4 rounded flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-red-500/30 hover:text-red-300 transition-all"
              title={`Close ${img.filename}`}
              aria-label={`Close ${img.filename}`}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
