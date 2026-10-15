/** Small, UI-independent helpers for the file manager's multi-close action. */

export interface FileManagerItem {
  id: string;
}

/** Drop selections for files that have already disappeared from the image list. */
export function pruneFileSelection(
  selected: Iterable<string>,
  items: readonly FileManagerItem[],
): Set<string> {
  const live = new Set(items.map((item) => item.id));
  return new Set(Array.from(selected).filter((id) => live.has(id)));
}

/**
 * Close the active image last when it is part of a batch.
 *
 * The existing close operation prepares the backend's next active image after
 * closing the current one. Closing background files first avoids repeatedly
 * decoding a large next image during a multi-close; the active file is closed
 * only after all other selected files are gone.
 */
export function closeOrder(
  selected: Iterable<string>,
  items: readonly FileManagerItem[],
  activeId: string | null,
): string[] {
  const chosen = new Set(selected);
  const ordered = items.map((item) => item.id).filter((id) => chosen.has(id));
  if (!activeId || !chosen.has(activeId)) return ordered;
  return [...ordered.filter((id) => id !== activeId), activeId];
}

/**
 * The tab order after dropping `draggedId` onto `targetId`.
 *
 * `before` says which side of the target the pointer was on, so a tab can be
 * moved to either end without a separate "drop past the last tab" gesture.
 * Unknown ids and a drop onto itself leave the order unchanged — the caller
 * then has nothing to send.
 */
export function reorderedIds(
  ids: readonly string[],
  draggedId: string,
  targetId: string,
  before: boolean,
): string[] {
  if (draggedId === targetId) return [...ids];
  const from = ids.indexOf(draggedId);
  if (from < 0 || !ids.includes(targetId)) return [...ids];
  const without = ids.filter((id) => id !== draggedId);
  const anchor = without.indexOf(targetId);
  const insertAt = before ? anchor : anchor + 1;
  return [...without.slice(0, insertAt), draggedId, ...without.slice(insertAt)];
}

/** True when `next` is `current` in a different order — the only case worth sending. */
export function isSameSetReordered(current: readonly string[], next: readonly string[]): boolean {
  if (current.length !== next.length) return false;
  const seen = new Set(current);
  if (!next.every((id) => seen.has(id)) || new Set(next).size !== next.length) return false;
  return next.some((id, index) => id !== current[index]);
}
