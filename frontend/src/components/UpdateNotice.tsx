import { useEffect, useState } from 'react';
import { VERSION } from '../constants/version';
import { checkForUpdate } from '../utils/api';

/** Versions the user has already dismissed, so a notice appears once per release. */
const DISMISSED_KEY = 'oir-viewer:update-dismissed';

/**
 * A one-line notice when a newer release exists on GitHub.
 *
 * Deliberately quiet. It is checked once per launch, it says nothing when the
 * check fails or the app is current, and dismissing it silences that version for
 * good — an update notice that reappears every launch trains people to close it
 * without reading, which is the opposite of the point.
 */
export function UpdateNotice() {
  const [info, setInfo] = useState<{ latest: string; url: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    checkForUpdate(VERSION).then((r) => {
      if (cancelled || !r.update_available || !r.latest) return;
      if (localStorage.getItem(DISMISSED_KEY) === r.latest) return;
      setInfo({ latest: r.latest, url: r.url });
    });
    return () => { cancelled = true; };
  }, []);

  if (!info) return null;

  return (
    <div className="absolute top-14 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3
                    bg-[var(--accent)] text-white text-xs px-3 py-2 rounded-lg shadow-lg">
      <span>
        新しいバージョン <strong>v{info.latest}</strong> があります（使用中: v{VERSION}）
      </span>
      <a
        href={info.url}
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2 hover:no-underline font-medium"
      >
        ダウンロード
      </a>
      <button
        onClick={() => {
          localStorage.setItem(DISMISSED_KEY, info.latest);
          setInfo(null);
        }}
        className="opacity-70 hover:opacity-100 text-sm leading-none"
        title="このバージョンの通知を消す"
      >
        ×
      </button>
    </div>
  );
}
