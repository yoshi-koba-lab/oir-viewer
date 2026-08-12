import {
  cropOwnerForMetadata,
  sameCropOwner,
  useViewStore,
  type CropRect,
} from '../stores/viewStore';
import { useOperationStore } from '../stores/operationStore';
import { useImageStore } from '../stores/imageStore';
import { imageOperationIsBusy } from '../hooks/useImageLoader';
import type { ImageMetadata } from '../utils/api';

interface Props {
  metadata: ImageMetadata;
}

const clampNumber = (value: number, min: number, max: number) => (
  Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min
);

/**
 * Main-workspace crop editor. It is a flex sibling of the image viewport, so
 * its coordinates and controls never cover image pixels at any window width.
 */
export function CropSettingsPanel({ metadata }: Props) {
  const cropRect = useViewStore((s) => s.cropRect);
  const cropOwner = useViewStore((s) => s.cropOwner);
  const cropActive = useViewStore((s) => s.cropActive);
  const threeDSaveBusy = useOperationStore((s) => !!s.threeDSave);
  const setCropPanelOpen = useViewStore((s) => s.setCropPanelOpen);
  const setCropActive = useViewStore((s) => s.setCropActive);
  const requestCropFit = useViewStore((s) => s.requestCropFit);
  const setCropRect = useViewStore((s) => s.setCropRect);
  const resetCrop = useViewStore((s) => s.resetCrop);
  const viewMode = useViewStore((s) => s.viewMode);
  const activeImageId = useImageStore((s) => s.activeImageId);
  const imageLoading = useImageStore((s) => s.loading);
  const owner = cropOwnerForMetadata(activeImageId, metadata);
  const ownerMatches = !cropRect || sameCropOwner(cropOwner, owner);
  const canEdit = !!owner && ownerMatches && !threeDSaveBusy
    && !imageLoading && !imageOperationIsBusy();
  const full: CropRect = { x: 0, y: 0, width: metadata.width, height: metadata.height };
  const current = ownerMatches && cropRect ? cropRect : full;

  const update = (field: keyof CropRect, raw: string) => {
    if (!canEdit || imageOperationIsBusy() || !owner) return;
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return;
    const next = { ...current, [field]: numeric };
    const x = clampNumber(next.x, 0, Math.max(0, metadata.width - 1));
    const y = clampNumber(next.y, 0, Math.max(0, metadata.height - 1));
    const width = clampNumber(next.width, 1, Math.max(1, metadata.width - x));
    const height = clampNumber(next.height, 1, Math.max(1, metadata.height - y));
    setCropRect({ x, y, width, height }, owner);
  };

  return (
    <aside
      id="crop-settings-panel"
      data-crop-settings-panel
      className="w-64 shrink-0 overflow-y-auto border-r border-[var(--border)] bg-[var(--bg-secondary)] p-3"
      role="dialog"
      aria-label="Crop settings"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-[var(--text-primary)]">クロップ範囲</div>
        <button
          type="button"
          onClick={() => {
            if (threeDSaveBusy) return;
            if ((viewMode === '2d' || viewMode === '3d') && cropRect && ownerMatches && owner) {
              requestCropFit(owner);
            }
            setCropActive(false);
            setCropPanelOpen(false);
          }}
          disabled={threeDSaveBusy}
          className="rounded bg-[var(--accent)] px-2 py-1 text-[10px] text-white shadow-sm hover:opacity-90"
        >
          完了
        </button>
      </div>
      <button
        type="button"
        onClick={() => {
          if (canEdit && !imageOperationIsBusy()) setCropActive(!cropActive);
        }}
        disabled={!canEdit}
        aria-pressed={cropActive}
        aria-label={`画像上でドラッグして範囲を決定する（${cropActive ? '有効' : '無効'}）`}
        className={`mb-3 w-full rounded border px-2 py-2 text-left text-[11px] leading-relaxed transition ${
          cropActive && canEdit
            ? 'border-emerald-400 bg-emerald-600 text-white shadow-sm'
            : 'border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:text-white'
        }`}
      >
        画像上でドラッグして範囲を決定する
      </button>
      <div
        className={`mb-3 text-[10px] leading-relaxed ${
          cropActive ? 'text-emerald-300' : 'text-[var(--text-secondary)]'
        }`}
        role="status"
        aria-live="polite"
      >
        {cropActive && canEdit
          ? '画像上での範囲選択が有効です。もう一度押すと終了します。'
          : !ownerMatches
            ? '画像ソースが切り替わったため、古いクロップ範囲は無効です。「全体に戻す」で解除してください。'
            : threeDSaveBusy
              ? '保存処理中のため、クロップ範囲を変更できません。'
              : '座標入力だけが有効です。画像上のマウス操作は通常どおり使えます。'}
      </div>
      <div className="mb-3 text-[10px] leading-relaxed text-[var(--text-secondary)]">
        画像上をドラッグして指定、または元画像のピクセル座標で入力します。
        {viewMode === '3d' && ' 3D表示・保存では選択範囲を表示領域にフィットします。'}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
        {([
          ['x', '左 (X)', current.x, 0, metadata.width - 1],
          ['y', '上 (Y)', current.y, 0, metadata.height - 1],
          ['width', '幅', current.width, 1, metadata.width],
          ['height', '高さ', current.height, 1, metadata.height],
        ] as const).map(([field, label, value, min, max]) => (
          <label key={field} className="flex flex-col gap-1 text-[var(--text-secondary)]">
            <span>{label}</span>
            <input
              type="number"
              min={min}
              max={max}
              step={1}
              value={Math.round(value)}
              onChange={(event) => update(field, event.target.value)}
              disabled={!canEdit}
              className="w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-right font-mono text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>
        ))}
      </div>
      <div className="mt-2 text-[10px] font-mono text-[var(--text-secondary)]">
        範囲: {Math.round(current.x)}–{Math.round(current.x + current.width)}, {Math.round(current.y)}–{Math.round(current.y + current.height)}
      </div>
      <button
        type="button"
        onClick={() => {
          if (!threeDSaveBusy) resetCrop();
        }}
        disabled={threeDSaveBusy}
        className="mt-3 w-full rounded bg-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:text-white"
      >
        全体に戻す
      </button>
    </aside>
  );
}
