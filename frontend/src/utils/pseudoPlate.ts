/**
 * Pseudo Plate: arrange the currently open files in a culture-plate layout.
 *
 * Nothing here reads pixels or the stores — every function is pure over plain
 * data, so the assignment rules (formats, prefill, move-on-reassign, duplicate
 * detection) are testable without a browser. The dialog owns all state.
 */

/** The culture-plate geometries offered. 96 is excluded on purpose: cells of a
 * 96-position page would be too small to carry a readable microscopy image. */
export const PSEUDO_FORMATS: { key: string; label: string; rows: number; cols: number }[] = [
  { key: '6', label: '6 well (2×3)', rows: 2, cols: 3 },
  { key: '12', label: '12 well (3×4)', rows: 3, cols: 4 },
  { key: '24', label: '24 well (4×6)', rows: 4, cols: 6 },
  { key: '48', label: '48 well (6×8)', rows: 6, cols: 8 },
];

/** Row/column to the backend's canonical zero-padded well ID (`A01`). */
export function pseudoWellId(row: number, col: number): string {
  return `${String.fromCharCode(65 + row)}${String(col + 1).padStart(2, '0')}`;
}

/** Every position of a format, row-major, as canonical well IDs. */
export function pseudoPositions(rows: number, cols: number): string[] {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push(pseudoWellId(r, c));
  return out;
}

/** wellId -> imageId. Positions without a file are simply absent. */
export type PseudoAssignments = Record<string, string>;

/** Open files in tab order dropped into positions in row-major plate order. */
export function prefillAssignments(
  rows: number,
  cols: number,
  imageIds: string[],
): PseudoAssignments {
  const positions = pseudoPositions(rows, cols);
  const out: PseudoAssignments = {};
  imageIds.slice(0, positions.length).forEach((id, i) => { out[positions[i]] = id; });
  return out;
}

/**
 * Carry assignments across a format change.
 *
 * Positions that exist in the new grid keep their file; positions outside it
 * are dropped. The grid is fully visible on screen, so a drop is immediately
 * apparent rather than silent state.
 */
export function remapAssignments(
  prev: PseudoAssignments,
  rows: number,
  cols: number,
  openIds: string[],
): PseudoAssignments {
  const valid = new Set(pseudoPositions(rows, cols));
  const open = new Set(openIds);
  const out: PseudoAssignments = {};
  for (const [wellId, imageId] of Object.entries(prev)) {
    if (valid.has(wellId) && open.has(imageId)) out[wellId] = imageId;
  }
  return out;
}

/**
 * Assign a file to a position, moving it if it already sits elsewhere.
 *
 * One file can occupy one position: the backend refuses a PDF in which two
 * frames share a source, so the dialog never lets that state exist at all.
 * An empty imageId clears the position.
 */
export function assignWithMove(
  prev: PseudoAssignments,
  wellId: string,
  imageId: string,
): PseudoAssignments {
  const out: PseudoAssignments = {};
  for (const [pos, id] of Object.entries(prev)) {
    if (pos === wellId) continue;          // being reassigned or cleared
    if (imageId && id === imageId) continue; // moved away from its old position
    out[pos] = id;
  }
  if (imageId) out[wellId] = imageId;
  return out;
}

/**
 * Positions, in plate order, whose assigned tabs are DIFFERENT tabs of the
 * SAME source bytes. The PDF endpoint rejects duplicate source identities, so
 * this is surfaced before any volume is fetched.
 */
export function duplicateSourcePositions(
  assignments: PseudoAssignments,
  identityOf: (imageId: string) => string | undefined,
): string[][] {
  const byIdentity = new Map<string, string[]>();
  for (const [wellId, imageId] of Object.entries(assignments)) {
    const identity = identityOf(imageId);
    if (!identity) continue;
    const list = byIdentity.get(identity) ?? [];
    list.push(wellId);
    byIdentity.set(identity, list);
  }
  return [...byIdentity.values()]
    .filter((list) => list.length > 1)
    .map((list) => list.sort());
}

/**
 * Dropdown labels, disambiguated only when two open files share a filename —
 * then the parent folder is appended, because the name alone no longer says
 * which file the position will render.
 */
export function tabLabels(
  items: { id: string; filename: string; source_path: string }[],
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.filename, (counts.get(item.filename) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const item of items) {
    if ((counts.get(item.filename) ?? 0) <= 1) {
      out.set(item.id, item.filename);
      continue;
    }
    const normalized = item.source_path.replace(/[\\/]+$/, '');
    const cut = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
    const parent = cut > 0
      ? normalized.slice(0, cut).split(/[\\/]/).filter(Boolean).pop() ?? ''
      : '';
    out.set(item.id, parent ? `${item.filename} — ${parent}` : item.filename);
  }
  return out;
}
