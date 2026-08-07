/**
 * Path handling that works on both separators.
 *
 * The backend runs wherever the app does, so a path in the UI is a Windows path
 * on Windows and a POSIX one elsewhere. Code that assumed "/" produced a default
 * output folder that still had the filename on the end — a folder that does not
 * exist, on the one platform nobody develops on.
 */

const SEP = /[\\/]/;

/** Everything before the last separator, or '' when there is none. */
export function dirnameOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i > 0 ? path.slice(0, i) : '';
}

/** The last path segment. */
export function basenameOf(path: string): string {
  const parts = path.split(SEP);
  return parts[parts.length - 1] || '';
}

/**
 * A filename without its extension, `.ome.tif` counted as one.
 *
 * Used to seed the "save as" field, so a name the user then extends does not
 * end up carrying a stale extension in the middle of it.
 */
export function stemOf(path: string): string {
  const base = basenameOf(path);
  const lower = base.toLowerCase();
  for (const ext of ['.ome.tif', '.ome.tiff']) {
    if (lower.endsWith(ext)) return base.slice(0, -ext.length);
  }
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Join with the separator the base already uses. */
export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + sep + name;
}

//: Characters Windows rejects in a filename, plus the separators. Checked in the
//: UI so a name is refused while it can still be corrected, rather than after
//: every plane has been rendered.
const ILLEGAL = /[\\/:*?"<>|]/;

/** Why this filename is not usable, or '' when it is fine. */
export function filenameProblem(name: string): string {
  const n = name.trim();
  if (!n) return 'ファイル名を入力してください';
  if (ILLEGAL.test(n)) return '使えない文字が含まれています（ \\ / : * ? " < > | ）';
  if (n.endsWith('.') || n.endsWith(' ')) return '末尾に「.」や空白は使えません';
  // Reserved device names on Windows, with or without an extension.
  const stem = n.split('.')[0].toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    return `${stem} は Windows で予約された名前です`;
  }
  return '';
}
