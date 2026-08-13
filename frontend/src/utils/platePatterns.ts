import { filenameProblem } from './paths';

/**
 * Channel patterns for Plate Save: named channel sets, each producing its own
 * PDF in one export run.
 *
 * The point is comparison figures. A researcher routinely wants the same plate
 * as "all channels" and as "CH1+2 only"; before this, that meant re-tuning
 * visibility on every well and running the export twice. A pattern names the
 * channel set once and applies it to every well, while colours and Min/Max stay
 * per-well — the pattern decides *which* channels are drawn, never how.
 *
 * Kept as pure data and functions so the export loop and the tests exercise the
 * same rules.
 */

export interface PlatePattern {
  /** Stable identity; selection and dedup key. */
  key: string;
  /** User-facing name; also the filename suffix, so it is filename-validated. */
  name: string;
  /**
   * 0-based channel indices, sorted, within the interactive-3D limit of 4.
   * Null is the built-in pattern: each well's currently visible channels,
   * which is the behaviour Plate Save always had.
   */
  channels: number[] | null;
}

/** The built-in pattern. Not stored, not deletable, selected by default. */
export const VISIBLE_PATTERN: PlatePattern = {
  key: 'visible',
  name: '表示中のチャンネル',
  channels: null,
};

/** The shader samples at most four channels; patterns cannot name a fifth. */
export const PATTERN_MAX_CHANNELS = 4;

/** Enough for real use; a bound so a corrupt store cannot flood the dialog. */
export const PATTERN_LIMIT = 20;

const STORAGE_KEY = 'oir-viewer.plate-save-patterns.v1';

/** Why this new pattern cannot be added, or '' when it can. */
export function patternProblem(
  name: string,
  channels: number[],
  existing: PlatePattern[],
): string {
  const trimmed = name.trim();
  if (!trimmed) return 'パターン名を入力してください。';
  // The name becomes part of the PDF filename, so it obeys filename rules.
  const nameIssue = filenameProblem(trimmed);
  if (nameIssue) return nameIssue;
  if (trimmed.length > 24) return 'パターン名は24文字以内にしてください。';
  const clash = existing.some(
    (p) => p.name.toLowerCase() === trimmed.toLowerCase(),
  ) || VISIBLE_PATTERN.name === trimmed;
  if (clash) return '同じ名前のパターンがあります。';
  if (channels.length === 0) return 'チャンネルを1つ以上選んでください。';
  if (channels.some((c) => !Number.isInteger(c) || c < 0 || c >= PATTERN_MAX_CHANNELS)) {
    return `チャンネルは CH1–CH${PATTERN_MAX_CHANNELS} から選んでください。`;
  }
  if (new Set(channels).size !== channels.length) return 'チャンネルが重複しています。';
  if (existing.length >= PATTERN_LIMIT) {
    return `パターンは最大 ${PATTERN_LIMIT} 件までです。`;
  }
  return '';
}

/** Parse a persisted pattern list, dropping anything that fails today's rules. */
export function sanitizePatterns(raw: unknown): PlatePattern[] {
  if (!Array.isArray(raw)) return [];
  const out: PlatePattern[] = [];
  for (const item of raw) {
    if (out.length >= PATTERN_LIMIT) break;
    if (typeof item !== 'object' || item === null) continue;
    const { key, name, channels } = item as Record<string, unknown>;
    if (typeof key !== 'string' || !key || key === VISIBLE_PATTERN.key) continue;
    if (typeof name !== 'string') continue;
    if (!Array.isArray(channels)) continue;
    const chs = [...new Set(channels)]
      .filter((c): c is number => Number.isInteger(c) && (c as number) >= 0
        && (c as number) < PATTERN_MAX_CHANNELS)
      .sort((a, b) => a - b);
    // Validated against the already-accepted list so duplicates collapse to the
    // first occurrence instead of both surviving.
    if (patternProblem(name, chs, out)) continue;
    if (out.some((p) => p.key === key)) continue;
    out.push({ key, name: name.trim(), channels: chs });
  }
  return out;
}

export function loadPatterns(storage: Pick<Storage, 'getItem'>): PlatePattern[] {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return sanitizePatterns(JSON.parse(raw));
  } catch {
    // A corrupt store yields no patterns rather than a broken dialog; the
    // built-in pattern keeps Plate Save usable regardless.
    return [];
  }
}

export function savePatterns(
  storage: Pick<Storage, 'setItem'>,
  patterns: PlatePattern[],
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(sanitizePatterns(patterns)));
  } catch {
    // Quota or private-mode failure loses persistence, not the running dialog.
  }
}

/** The shape of a well the pattern rules need — a subset of OpenWell. */
export interface PatternWell {
  wellId: string;
  /** Channels available to the 3D view (already capped at 4 upstream). */
  numChannels: number;
  /** The well's currently visible channels. */
  channelIdx: number[];
}

/** The channels this pattern draws for this well, in ascending order. */
export function patternChannelsFor(pattern: PlatePattern, well: PatternWell): number[] {
  if (pattern.channels === null) return [...well.channelIdx].sort((a, b) => a - b);
  return pattern.channels;
}

/**
 * Wells that cannot honour a fixed pattern because a named channel does not
 * exist there. Rendering those anyway would silently produce a different figure
 * from the one the pattern names, so the export refuses instead.
 */
export function wellsMissingPatternChannels(
  pattern: PlatePattern,
  wells: PatternWell[],
): string[] {
  if (pattern.channels === null) return [];
  return wells
    .filter((w) => pattern.channels!.some((c) => c >= w.numChannels))
    .map((w) => w.wellId);
}

/**
 * One fetch per well serves every selected pattern: the union of their channel
 * sets is requested, and each pattern is rendered from it with a visibility
 * mask. Refetching per pattern would multiply the slowest step (about two
 * minutes per well on real data at Maximum) by the number of patterns.
 */
export function unionChannelsFor(patterns: PlatePattern[], well: PatternWell): number[] {
  const union = new Set<number>();
  for (const p of patterns) {
    for (const c of patternChannelsFor(p, well)) union.add(c);
  }
  return [...union].sort((a, b) => a - b);
}

/** The per-fetched-channel visibility mask that renders exactly this pattern. */
export function patternMask(
  pattern: PlatePattern,
  well: PatternWell,
  fetchedChannels: number[],
): boolean[] {
  const wanted = new Set(patternChannelsFor(pattern, well));
  return fetchedChannels.map((c) => wanted.has(c));
}

/**
 * The stem each pattern's PDF is saved under.
 *
 * A single selected pattern keeps the typed name untouched — the long-standing
 * behaviour. Multiple patterns suffix the pattern name, because two PDFs cannot
 * share one file, and the suffix is the only part of the name that says which
 * is which.
 */
export function patternFileStem(
  base: string,
  pattern: PlatePattern,
  selectedCount: number,
): string {
  return selectedCount <= 1 ? base : `${base}_${pattern.name}`;
}

/** `CH1+CH3` — how a drawn channel set is written in tables and footers. */
export function channelSetLabel(channels: number[]): string {
  return channels.map((c) => `CH${c + 1}`).join('+') || '（なし）';
}
