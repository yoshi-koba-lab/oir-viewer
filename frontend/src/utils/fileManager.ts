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
