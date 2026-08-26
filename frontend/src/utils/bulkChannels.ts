/**
 * Bulk Min/Max application across open files.
 *
 * The point is comparability: figures from different wells or acquisitions are
 * only comparable when every file renders the same channel through the same
 * display window. Tuning N files by hand meant N trips through the channel
 * panel; this applies one window set to every checked file at once.
 *
 * Pure data and functions so the dialog and the tests exercise the same rules.
 */

/** One editable channel row in the dialog. */
export interface BulkChannelValue {
  /** Unchecked rows leave that channel untouched in every file. */
  enabled: boolean;
  min: number;
  max: number;
}

/** One open file as the bulk dialog sees it. */
export interface BulkTarget {
  id: string;
  filename: string;
  numChannels: number;
  /**
   * Whether this tab's channel state exists client-side. A tab that has never
   * been displayed has no established state to edit, so it cannot be a target
   * until it is shown once — refusing is honest; fabricating defaults for it
   * could persist wrong Z/T/visibility under that file's name.
   */
  hasState: boolean;
}

/** Why the entered values cannot be applied, or '' when they can. */
export function bulkValueProblem(values: BulkChannelValue[]): string {
  const enabled = values.filter((v) => v.enabled);
  if (enabled.length === 0) return '変更するチャンネルを1つ以上有効にしてください。';
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!v.enabled) continue;
    if (!Number.isFinite(v.min) || !Number.isFinite(v.max)
        || !Number.isInteger(v.min) || !Number.isInteger(v.max)) {
      return `CH${i + 1}: Min/Max は整数で入力してください。`;
    }
    if (v.min < 0) return `CH${i + 1}: Min は 0 以上にしてください。`;
    if (v.max <= v.min) return `CH${i + 1}: Max は Min より大きくしてください。`;
  }
  return '';
}

/** The per-channel updates one file will receive. */
export interface BulkFilePlan {
  id: string;
  filename: string;
  /** Channel indices with their new window, all < numChannels. */
  updates: { channel: number; min: number; max: number }[];
  /** Enabled channel indices this file does not have, so they are not applied. */
  missing: number[];
}

/**
 * What applying `values` to `targets` will do, file by file.
 *
 * A file with fewer channels than an enabled row skips just that row — the
 * remaining channels still apply, and the skip is reported rather than silent,
 * so a 3-channel file among 5-channel wells never blocks the whole run.
 */
export function buildBulkPlan(
  targets: BulkTarget[],
  values: BulkChannelValue[],
): BulkFilePlan[] {
  return targets.filter((t) => t.hasState).map((t) => {
    const updates: BulkFilePlan['updates'] = [];
    const missing: number[] = [];
    values.forEach((v, channel) => {
      if (!v.enabled) return;
      if (channel < t.numChannels) {
        updates.push({ channel, min: v.min, max: v.max });
      } else {
        missing.push(channel);
      }
    });
    return { id: t.id, filename: t.filename, updates, missing };
  });
}

/** One-line Japanese summary of an executed plan. */
export function describeBulkResult(plans: BulkFilePlan[]): string {
  const applied = plans.filter((p) => p.updates.length > 0);
  if (applied.length === 0) return '適用できるファイルがありませんでした。';
  const skips = new Map<number, number>();
  for (const p of plans) {
    for (const ch of p.missing) skips.set(ch, (skips.get(ch) ?? 0) + 1);
  }
  const skipNote = [...skips.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ch, n]) => `CH${ch + 1} は ${n} ファイルでCH数不足のためスキップ`)
    .join('、');
  return `${applied.length} ファイルに適用しました。${skipNote ? `${skipNote}。` : ''}`;
}
