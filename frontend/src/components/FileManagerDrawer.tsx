import { useEffect, useMemo, useState } from 'react';
import { useImageStore } from '../stores/imageStore';
import { imageOperationIsBusy, closeImageById } from '../hooks/useImageLoader';
import { threeDSaveIsBusy, useOperationStore } from '../stores/operationStore';
import { closeOrder, pruneFileSelection } from '../utils/fileManager';

interface Props {
  onClose: () => void;
}

/** A reversible left-side list for selecting and closing open image files. */
export function FileManagerDrawer({ onClose }: Props) {
  const imageList = useImageStore((state) => state.imageList);
  const activeImageId = useImageStore((state) => state.activeImageId);
  const threeDSave = useOperationStore((state) => state.threeDSave);
  const imageLoad = useOperationStore((state) => state.imageLoad);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [closing, setClosing] = useState(false);

  const operationBusy = !!threeDSave || !!imageLoad || imageOperationIsBusy();
  const selectedLive = useMemo(
    () => pruneFileSelection(selected, imageList),
    [imageList, selected],
  );

  useEffect(() => {
    if (selectedLive.size !== selected.size) setSelected(selectedLive);
  }, [selected, selectedLive]);

  const toggle = (id: string) => {
    if (closing || operationBusy) return;
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (closing || operationBusy) return;
    setSelected((previous) => previous.size === imageList.length
      ? new Set()
      : new Set(imageList.map((image) => image.id)));
  };

  const closeSelected = async () => {
    if (closing || operationBusy || selectedLive.size === 0) return;
    // Recheck at click time: an image load or 3D save can start after this
    // component rendered but before the user pressed the button.
    if (threeDSaveIsBusy() || useOperationStore.getState().imageLoad || imageOperationIsBusy()) return;
    setClosing(true);
    try {
      const order = closeOrder(selectedLive, imageList, activeImageId);
      const remaining = new Set(order);
      for (const id of order) {
        if (threeDSaveIsBusy() || useOperationStore.getState().imageLoad) break;
        await closeImageById(id);
        // closeImageById records failures in the existing store error toast and
        // resolves after its reconciliation attempt. Keep failed and unvisited
        // ids checked so the user can retry instead of losing the selection.
        if (useImageStore.getState().imageList.some((image) => image.id === id)) break;
        remaining.delete(id);
      }
      setSelected(remaining);
    } finally {
      setClosing(false);
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 top-[4.5rem] z-[74] bg-black/20"
        aria-hidden="true"
        onClick={onClose}
      />
      <aside
        className="fixed bottom-0 left-0 top-[4.5rem] z-[75] flex w-80 max-w-[calc(100vw-2rem)] flex-col border-r border-[var(--border)] bg-[var(--bg-secondary)] shadow-2xl"
        aria-label="File Manager"
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">File Manager</h2>
            <p className="mt-0.5 text-[10px] text-[var(--text-secondary)]">開いているファイル {imageList.length} 件</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--border)] hover:text-white"
            aria-label="Close File Manager"
          >
            ×
          </button>
        </div>

        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2 text-[11px]">
          <label className="flex cursor-pointer items-center gap-2 text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={imageList.length > 0 && selectedLive.size === imageList.length}
              onChange={toggleAll}
              disabled={operationBusy || imageList.length === 0}
              className="accent-[var(--accent)]"
              aria-label="Select all files"
            />
            全て選択
          </label>
          <span className="font-mono text-[var(--text-secondary)]">{selectedLive.size} selected</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {imageList.length === 0 ? (
            <p className="px-2 py-4 text-xs text-[var(--text-secondary)]">開いているファイルはありません。</p>
          ) : imageList.map((image) => (
            <label
              key={image.id}
              className={`mb-1 flex cursor-pointer items-start gap-2 rounded px-2 py-2 text-xs hover:bg-[var(--border)]/50 ${
                image.id === activeImageId ? 'bg-[var(--accent)]/15' : ''
              }`}
            >
              <input
                type="checkbox"
                checked={selectedLive.has(image.id)}
                onChange={() => toggle(image.id)}
                disabled={operationBusy}
                className="mt-0.5 accent-[var(--accent)]"
                aria-label={`Select ${image.filename}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block break-all text-[var(--text-primary)]">{image.filename}</span>
                <span className="mt-0.5 block text-[10px] text-[var(--text-secondary)]">
                  {image.width}×{image.height} · {image.num_channels}ch · Z{image.num_z}
                  {image.id === activeImageId && <span className="ml-1 text-[var(--accent)]">active</span>}
                </span>
              </span>
            </label>
          ))}
        </div>

        <div className="border-t border-[var(--border)] p-3">
          <button
            type="button"
            onClick={closeSelected}
            disabled={operationBusy || closing || selectedLive.size === 0}
            className="w-full rounded bg-red-600 px-3 py-2 text-xs font-medium text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {closing ? 'Closing…' : `選択したファイルを閉じる (${selectedLive.size})`}
          </button>
          {operationBusy && (
            <p className="mt-2 text-[10px] text-amber-400">画像の読み込みまたは保存中は操作できません。</p>
          )}
        </div>
      </aside>
    </>
  );
}
