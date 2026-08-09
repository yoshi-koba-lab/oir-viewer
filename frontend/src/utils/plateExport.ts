/** Deterministic progress allocation for the serial Plate PDF well pipeline. */

import {
  MAX_VOLUME_ZOOM_PERCENT,
  MIN_VOLUME_ZOOM_PERCENT,
} from './threeDCamera';

/** Validate a still-editable Plate zoom field without coercing empty text to 0. */
export function plateZoomProblem(value: string): string {
  const parsed = Number(value);
  if (!value.trim() || !Number.isFinite(parsed)) return '拡大率を数値で入力してください。';
  if (parsed < MIN_VOLUME_ZOOM_PERCENT || parsed > MAX_VOLUME_ZOOM_PERCENT) {
    return `拡大率は ${MIN_VOLUME_ZOOM_PERCENT}–${MAX_VOLUME_ZOOM_PERCENT}% で入力してください。`;
  }
  return '';
}

/**
 * Count only completed, externally-verifiable units: one preflight, two units
 * per well (data acquired, then render/PNG completed), and one final verified
 * publish. Stage starts never advance the percentage.
 */
export function plateExportTotalUnits(totalWells: number): number {
  return 1 + Math.max(0, Math.trunc(totalWells)) * 2 + 1;
}

/** 100% is reachable only when the caller includes the verified publish unit. */
export function plateExportPercent(completedUnits: number, totalWells: number): number {
  const total = plateExportTotalUnits(totalWells);
  const completed = Math.max(0, Math.min(total, Math.trunc(completedUnits)));
  return Math.floor((completed / total) * 100);
}
