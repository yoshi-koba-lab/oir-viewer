import type { ViewMode } from '../stores/viewStore';

/** Default presentation for a newly activated image. */
export function defaultViewMode(numZ: number): ViewMode {
  return Number.isFinite(numZ) && numZ > 1 ? '3d' : '2d';
}

/** Return a prior single-image choice, or the data-driven default for a fresh visit. */
export function rememberedOrDefaultViewMode(
  remembered: ViewMode | undefined,
  numZ: number,
): ViewMode {
  if (remembered === '2d') return '2d';
  if (remembered === '3d' && Number.isFinite(numZ) && numZ > 1) return '3d';
  return defaultViewMode(numZ);
}

/** Only a view the user has actually been shown can become an explicit choice. */
export function rememberableViewMode(
  wasPresented: boolean,
  mode: ViewMode,
): Extract<ViewMode, '2d' | '3d'> | undefined {
  return wasPresented && (mode === '2d' || mode === '3d') ? mode : undefined;
}
