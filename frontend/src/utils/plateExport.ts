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
 * Count only completed, externally-verifiable units: one preflight, per well
 * one data acquisition plus one render per selected channel pattern, and one
 * verified publish per pattern. Stage starts never advance the percentage.
 *
 * The pattern count defaults to 1, which reproduces the original two-units-
 * per-well schedule exactly — existing callers and recorded expectations are
 * unchanged.
 */
/** Appended to every conditions table after the user's columns, in this order. */
export const GENERATED_TABLE_HEADERS =
  ['PDF拡大率', 'スケールバー（中心深度換算）', '保存チャンネル'] as const;

/** backend/plate.py's validate_pdf_layout refuses more headers than this. */
export const PDF_TABLE_HEADER_LIMIT = 64;

export function plateExportTotalUnits(totalWells: number, patternCount = 1): number {
  const wells = Math.max(0, Math.trunc(totalWells));
  const patterns = Math.max(1, Math.trunc(patternCount));
  return 1 + wells * (1 + patterns) + patterns;
}

/** 100% is reachable only when the caller includes every verified publish unit. */
export function plateExportPercent(
  completedUnits: number,
  totalWells: number,
  patternCount = 1,
): number {
  const total = plateExportTotalUnits(totalWells, patternCount);
  const completed = Math.max(0, Math.min(total, Math.trunc(completedUnits)));
  return Math.floor((completed / total) * 100);
}
