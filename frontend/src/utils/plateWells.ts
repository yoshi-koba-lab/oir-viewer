import { useImageStore, DEFAULT_VOLUME_3D, type ChannelState, type Volume3DState } from '../stores/imageStore';
import type { WellSnapshot } from '../stores/plateStore';
import type { PlateScan } from './api';

/**
 * What the open tabs currently look like, per well.
 *
 * The plate export renders each well the way the user left it in the ordinary
 * viewer, so this is where "what is on screen" is turned into something the
 * exporter and the table can both read. Nothing here reads pixels — only the
 * settings — so it is cheap enough to call on every render of the dialog.
 */

/** `Stitch_B02_G001.oir` -> `B02`. Anything else is not a well. */
export function wellIdFromFilename(filename: string): string | null {
  const m = /^Stitch_([A-Za-z]\d{1,2})_G\d+\.oir$/i.exec(filename);
  if (!m) return null;
  const rc = rcFromWellId(m[1].toUpperCase());
  return rc ? `${String.fromCharCode(65 + rc.row)}${String(rc.col + 1).padStart(2, '0')}` : null;
}

/** `B02` -> row 1, column 1 (both 0-based). Null when it is not a well label. */
export function rcFromWellId(wellId: string): { row: number; col: number } | null {
  const m = /^([A-Za-z])(\d{1,2})$/.exec(wellId.trim());
  if (!m) return null;
  return { row: m[1].toUpperCase().charCodeAt(0) - 65, col: parseInt(m[2], 10) - 1 };
}

export interface OpenWell {
  imageId: string;
  wellId: string;
  row: number;
  col: number;
  filename: string;
  /** Absolute path from the plate scan; null when this well was not in the scan. */
  path: string | null;
  sourceIdentity: string;
  sourceRevision: string;
  /** Frozen 0-based time point and the source's available T count. */
  t: number;
  numT: number;
  /** Visible channel indices, capped at the four the shader samples. */
  channelIdx: number[];
  levels: [number, number][];
  colors: [number, number, number][];
  view: Volume3DState;
  /**
   * The Z slab as a 0..1 fraction of the stack. The export re-reads the volume
   * at its own resolution, so a slab recorded in slice numbers cannot be
   * applied there directly.
   */
  zFrac: [number, number];
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/**
 * Every open tab that is a plate well, in plate order.
 *
 * Reads each tab's saved view state, so the caller must flush the active tab
 * with `saveViewState()` first — otherwise the well the user is looking at is
 * exported with whatever settings it had when they last switched away from it,
 * which is the one well they are most likely to have just adjusted.
 */
export function collectOpenWells(scan: PlateScan | null): OpenWell[] {
  const st = useImageStore.getState();
  const byWell = new Map(scan?.wells.map((w) => [w.well_id, w]) ?? []);
  const out: OpenWell[] = [];

  for (const item of st.imageList) {
    const wellId = wellIdFromFilename(item.filename);
    if (!wellId) continue;
    const scanned = byWell.get(wellId);
    // A well label is not an identity: every acquisition has its own B02. Only
    // settings from the tab opened from this scan's exact Stitch file may be
    // combined with the pixels read for this PDF.
    if (scan && (!scanned?.stitch_path
      || !item.source_identity || !item.source_revision
      || item.source_identity !== scanned.stitch_identity
      || item.source_revision !== scanned.stitch_revision)) continue;
    const rc = scanned
      ? { row: scanned.row, col: scanned.col }
      : rcFromWellId(wellId);
    if (!rc) continue;

    // The active tab's live state has not been written to imageViewStates yet.
    const isActive = item.id === st.activeImageId;
    const channels: ChannelState[] = isActive
      ? st.channels
      : st.imageViewStates[item.id]?.channels ?? [];
    const view: Volume3DState = (isActive
      ? st.volume3D
      : st.imageViewStates[item.id]?.volume3D) ?? DEFAULT_VOLUME_3D;
    const t = isActive
      ? st.currentT
      : st.imageViewStates[item.id]?.currentT ?? 0;

    const channelIdx = channels.map((_, i) => i).filter((i) => channels[i].visible).slice(0, 4);
    const total = Math.max(1, view.zTotal);
    const zFrac: [number, number] = [
      Math.max(0, Math.min(1, (view.zStart - 1) / total)),
      Math.max(0, Math.min(1, view.zEnd / total)),
    ];
    if (zFrac[1] <= zFrac[0]) { zFrac[0] = 0; zFrac[1] = 1; }

    out.push({
      imageId: item.id,
      wellId,
      row: rc.row,
      col: rc.col,
      filename: item.filename,
      path: scanned?.stitch_path ?? null,
      sourceIdentity: scanned?.stitch_identity ?? item.source_identity,
      sourceRevision: scanned?.stitch_revision ?? item.source_revision,
      t: Math.max(0, Math.min(t, item.num_t - 1)),
      numT: item.num_t,
      channelIdx,
      levels: channelIdx.map((c) => [channels[c].min, channels[c].max] as [number, number]),
      colors: channelIdx.map((c) => channels[c].color),
      view,
      zFrac,
    });
  }

  out.sort((a, b) => a.row - b.row || a.col - b.col);
  return out;
}

/** Open well tabs whose frozen source is not part of the selected acquisition. */
export function mismatchedPlateTabs(scan: PlateScan): string[] {
  const st = useImageStore.getState();
  const byWell = new Map(scan.wells.map((w) => [w.well_id, w]));
  const mismatches = new Set<string>();
  for (const item of st.imageList) {
    const wellId = wellIdFromFilename(item.filename);
    if (!wellId) continue;
    const scanned = byWell.get(wellId);
    if (scanned?.stitch_path && (item.source_identity !== scanned.stitch_identity
      || item.source_revision !== scanned.stitch_revision)) {
      mismatches.add(wellId);
    }
  }
  return [...mismatches].sort();
}

/** The table's auto columns, for one well. */
export function snapshotOf(w: OpenWell, scan: PlateScan | null): WellSnapshot {
  const scanned = scan?.wells.find((s) => s.well_id === w.wellId);
  return {
    wellId: w.wellId,
    row: w.row,
    col: w.col,
    filename: w.filename,
    channels: w.channelIdx.map((c) => `CH${c + 1}`).join(', ') || '（なし）',
    levels: w.channelIdx
      .map((c, i) => `CH${c + 1} ${Math.round(w.levels[i][0])}–${Math.round(w.levels[i][1])}`)
      .join('  ') || '（なし）',
    colors: w.colors.map((c) => `rgb(${c.join(',')})`).join(' '),
    angle: `az ${fmt(w.view.az)}° / el ${fmt(w.view.el)}°`,
    zrange: `T${w.t + 1} | Z ${w.view.zStart}–${w.view.zEnd} / ${w.view.zTotal}`,
    tiles: scanned ? `${scanned.tiles} (${scanned.tile_grid})` : '',
  };
}
