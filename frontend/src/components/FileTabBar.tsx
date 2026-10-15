import { useEffect, useRef, useState } from 'react';
import { useImageStore } from '../stores/imageStore';
import { threeDSaveIsBusy, useOperationStore } from '../stores/operationStore';
import { switchToImage, closeImageById, reorderOpenImages } from '../hooks/useImageLoader';
import { isSameSetReordered, reorderedIds } from '../utils/fileManager';

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

/** Where a drag would drop relative to the tab under the pointer. */
interface DropTarget {
  id: string;
  before: boolean;
}

export function FileTabBar() {
  const imageList = useImageStore((s) => s.imageList);
  const activeImageId = useImageStore((s) => s.activeImageId);
  const setLoadError = useImageStore((s) => s.setLoadError);
  const threeDSaveBusy = useOperationStore((s) => !!s.threeDSave);
  const activeRef = useRef<HTMLDivElement>(null);
  // Tab order is a drag: the tab being carried, and the slot it would land in.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  // Keep the active tab visible: with many files open it can otherwise sit
  // off-screen in the scroll container with no indication of which is current.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeImageId, imageList.length]);

  if (imageList.length <= 1) return null;

  const endDrag = () => {
    setDraggingId(null);
    setDropTarget(null);
  };

  const dropOn = async (target: DropTarget) => {
    const dragged = draggingId;
    endDrag();
    if (!dragged) return;
    const current = imageList.map((img) => img.id);
    const next = reorderedIds(current, dragged, target.id, target.before);
    if (!isSameSetReordered(current, next)) return;
    try {
      await reorderOpenImages(next);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      className="bg-[var(--bg-primary)] border-b border-[var(--border)] flex items-center overflow-x-auto scrollbar-thin"
      onDragOver={(e) => {
        // Allow a drop in the bar's empty tail; it means "after the last tab".
        if (draggingId) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!draggingId) return;
        e.preventDefault();
        const last = imageList[imageList.length - 1];
        if (last) void dropOn({ id: last.id, before: false });
      }}
    >
      {imageList.map((img) => {
        const isActive = img.id === activeImageId;
        const isDragging = img.id === draggingId;
        const indicator = dropTarget?.id === img.id && draggingId !== img.id
          ? (dropTarget.before ? 'border-l-2 border-l-[var(--accent)]' : 'border-r-2 border-r-[var(--accent)]')
          : '';
        return (
          <div
            key={img.id}
            ref={isActive ? activeRef : undefined}
            draggable={!threeDSaveBusy}
            onDragStart={(e) => {
              if (threeDSaveIsBusy()) { e.preventDefault(); return; }
              setDraggingId(img.id);
              e.dataTransfer.effectAllowed = 'move';
              // Some browsers need data for the drag to start at all.
              e.dataTransfer.setData('text/plain', img.id);
            }}
            onDragEnd={endDrag}
            onDragOver={(e) => {
              if (!draggingId || draggingId === img.id) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'move';
              const rect = e.currentTarget.getBoundingClientRect();
              const before = e.clientX < rect.left + rect.width / 2;
              if (dropTarget?.id !== img.id || dropTarget.before !== before) {
                setDropTarget({ id: img.id, before });
              }
            }}
            onDrop={(e) => {
              if (!draggingId) return;
              e.preventDefault();
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              void dropOn({ id: img.id, before: e.clientX < rect.left + rect.width / 2 });
            }}
            className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer border-r border-[var(--border)] shrink-0 transition-colors ${
              isActive
                ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] border-b-2 border-b-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
            } ${isDragging ? 'opacity-40' : ''} ${indicator}`}
            onClick={() => { if (!threeDSaveIsBusy()) void switchToImage(img.id); }}
            title={`${img.filename} (${img.width}×${img.height}, ${img.num_channels}ch, Z${img.num_z}${img.num_t > 1 ? `, T${img.num_t}` : ''})\nドラッグで並べ替え`}
          >
            <span className="font-mono whitespace-nowrap">{shortenName(img.filename)}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (!threeDSaveIsBusy()) void closeImageById(img.id);
              }}
              disabled={threeDSaveBusy}
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
