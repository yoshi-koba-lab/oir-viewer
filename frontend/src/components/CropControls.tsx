import { useEffect, useRef } from 'react';
import {
  cropOwnerForMetadata,
  sameCropOwner,
  useViewStore,
} from '../stores/viewStore';
import { useOperationStore } from '../stores/operationStore';
import { useImageStore } from '../stores/imageStore';
import type { ImageMetadata } from '../utils/api';

interface Props {
  metadata: ImageMetadata | null;
  usable: boolean;
}

/** Toolbar button for opening the docked crop settings panel. */
export function CropControls({ metadata, usable }: Props) {
  const cropPanelOpen = useViewStore((s) => s.cropPanelOpen);
  const cropRect = useViewStore((s) => s.cropRect);
  const cropOwner = useViewStore((s) => s.cropOwner);
  const threeDSaveBusy = useOperationStore((s) => !!s.threeDSave);
  const setCropPanelOpen = useViewStore((s) => s.setCropPanelOpen);
  const setCropActive = useViewStore((s) => s.setCropActive);
  const resetCrop = useViewStore((s) => s.resetCrop);
  const activeImageId = useImageStore((s) => s.activeImageId);
  const ownerMatches = !cropRect
    || sameCropOwner(cropOwner, cropOwnerForMetadata(activeImageId, metadata));
  const sourceKey = `${activeImageId ?? ''}|${metadata?.source_path ?? ''}|${metadata?.source_identity ?? ''}|${metadata?.source_revision ?? ''}|${metadata?.width ?? 0}x${metadata?.height ?? 0}`;
  const previousSource = useRef<string | null>(null);

  // Keep this lifecycle guard on the always-mounted toolbar button rather than
  // the docked panel. A closed panel must still release pointer editing when
  // the user switches source; owner checks keep the old selection read-only.
  useEffect(() => {
    if (!metadata) {
      previousSource.current = null;
      resetCrop();
      setCropPanelOpen(false);
      setCropActive(false);
      return;
    }
    const sourceChanged = previousSource.current !== null && previousSource.current !== sourceKey;
    if (sourceChanged) {
      // Keep the old rectangle visible as a read-only, explicitly invalid
      // selection. Owner checks already fail closed in this render; preserving
      // it lets the user open the panel and press "全体に戻す" deliberately.
      setCropActive(false);
    }
    if (!usable) {
      // The overlay is not mounted in other view modes. Close its panel and
      // release edit capture so switching back can never leave an invisible
      // pointer layer active over the image.
      setCropPanelOpen(false);
      return;
    }
    previousSource.current = sourceKey;
  }, [metadata, resetCrop, setCropActive, setCropPanelOpen, sourceKey, usable]);

  if (!metadata) return null;

  const togglePanel = () => {
    if (threeDSaveBusy) return;
    const opening = !cropPanelOpen;
    if (opening) {
      // Opening Crop enters drag-edit mode by default. A stale selection is
      // still recoverable in the panel, but cannot be edited until reset.
      if (ownerMatches) setCropActive(true);
    } else {
      setCropActive(false);
    }
    setCropPanelOpen(opening);
  };

  return (
    <div className="shrink-0">
      <button
        type="button"
        onClick={togglePanel}
        disabled={!usable || threeDSaveBusy}
        className={`px-2 py-1 rounded text-xs transition disabled:opacity-30 disabled:cursor-not-allowed ${
          cropPanelOpen
            ? 'bg-emerald-600 text-white'
            : 'bg-[var(--border)] text-[var(--text-secondary)] enabled:hover:text-white'
        }`}
        title={!usable
          ? '2D/3D画像でのみ使用できます'
          : !ownerMatches
            ? '画像ソースが切り替わりました。設定を開き「全体に戻す」で古い範囲を解除できます'
            : 'クロップ設定を開く（ドラッグ編集は設定パネルで有効化）'}
        aria-label="Crop設定を開く"
        aria-controls="crop-settings-panel"
        aria-expanded={cropPanelOpen}
        aria-pressed={cropPanelOpen}
      >
        Crop
      </button>
    </div>
  );
}
