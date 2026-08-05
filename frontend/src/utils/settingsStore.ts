/**
 * Per-image view settings persisted in localStorage, keyed by the image's
 * source_path (stable across reloads, unlike the server-assigned id).
 * Restores channel LUT/contrast/visibility and the Z/T position so reopening
 * the app (or a file) comes back exactly as it was left.
 */

const KEY = 'oir-viewer:settings';

export interface SavedChannel {
  color: [number, number, number];
  min: number;
  max: number;
  visible: boolean;
}

export interface SavedSettings {
  channels: SavedChannel[];
  currentZ: number;
  currentT: number;
  showMIP: boolean;
}

type Store = Record<string, SavedSettings>;

function readAll(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

export function loadSettings(sourcePath: string): SavedSettings | null {
  if (!sourcePath) return null;
  return readAll()[sourcePath] ?? null;
}

export function saveSettings(sourcePath: string, settings: SavedSettings): void {
  if (!sourcePath) return;
  try {
    const all = readAll();
    all[sourcePath] = settings;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* quota/serialization errors are non-fatal */
  }
}
