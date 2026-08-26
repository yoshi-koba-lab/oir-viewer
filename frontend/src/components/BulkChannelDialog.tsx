import { useMemo, useState } from 'react';
import { useImageStore } from '../stores/imageStore';
import { scheduleSettingsSave } from '../utils/settingsStore';
import {
  buildBulkPlan, bulkValueProblem, describeBulkResult,
  type BulkChannelValue, type BulkTarget,
} from '../utils/bulkChannels';

interface Props {
  onClose: () => void;
}

/**
 * Apply one set of channel Min/Max windows to every checked open file.
 *
 * The rows prefill from the file on screen, so the working flow is: tune one
 * file in the channel panel, open this dialog, check the files that should
 * match it, apply. Background tabs are updated in place and their settings are
 * persisted per file exactly as if each had been edited while active.
 */
export function BulkChannelDialog({ onClose }: Props) {
  const imageList = useImageStore((s) => s.imageList);
  const activeImageId = useImageStore((s) => s.activeImageId);
  const activeChannels = useImageStore((s) => s.channels);
  const imageViewStates = useImageStore((s) => s.imageViewStates);
  const applyChannelRanges = useImageStore((s) => s.applyChannelRanges);

  const targets: BulkTarget[] = useMemo(() => imageList.map((item) => ({
    id: item.id,
    filename: item.filename,
    numChannels: item.num_channels,
    hasState: item.id === activeImageId || !!imageViewStates[item.id],
  })), [imageList, activeImageId, imageViewStates]);

  const maxChannels = useMemo(
    () => Math.max(0, ...targets.filter((t) => t.hasState).map((t) => t.numChannels)),
    [targets],
  );

  // Prefilled once from the file on screen; editing here never touches any
  // file until 適用. Channels the active file lacks start disabled and empty.
  const [values, setValues] = useState<BulkChannelValue[]>(() => (
    Array.from({ length: Math.max(1, maxChannels) }, (_, c) => {
      const ch = activeChannels[c];
      return ch
        ? { enabled: true, min: Math.round(ch.min), max: Math.round(ch.max) }
        : { enabled: false, min: 0, max: 0 };
    })
  ));
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(targets.filter((t) => t.hasState).map((t) => t.id)),
  );
  const [result, setResult] = useState('');
  const [error, setError] = useState('');

  const checkedTargets = targets.filter((t) => checked.has(t.id) && t.hasState);
  const valueProblem = bulkValueProblem(values);

  const setValue = (c: number, patch: Partial<BulkChannelValue>) => {
    setValues((prev) => prev.map((v, i) => (i === c ? { ...v, ...patch } : v)));
    setResult('');
    setError('');
  };

  const toggleFile = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setResult('');
    setError('');
  };

  const apply = () => {
    setError('');
    setResult('');
    if (valueProblem) { setError(valueProblem); return; }
    if (checkedTargets.length === 0) {
      setError('適用するファイルを1つ以上チェックしてください。');
      return;
    }
    const plans = buildBulkPlan(checkedTargets, values);
    const failed: string[] = [];
    for (const plan of plans) {
      if (plan.updates.length === 0) continue;
      if (!applyChannelRanges(plan.id, plan.updates)) {
        failed.push(plan.filename);
        continue;
      }
      // The active image is persisted by its own debounced watcher; background
      // tabs get the same complete-snapshot save the watcher would have sent.
      if (plan.id !== activeImageId) {
        const saved = useImageStore.getState().imageViewStates[plan.id];
        if (saved) {
          scheduleSettingsSave(plan.id, {
            channels: saved.channels.map((ch) => ({
              color: ch.color, min: ch.min, max: ch.max, visible: ch.visible,
            })),
            currentZ: saved.currentZ,
            currentT: saved.currentT,
            showMIP: saved.showMIP,
          }, () => {
            setError((prev) => prev || `${plan.filename}: 表示設定の保存に失敗しました。`);
          });
        }
      }
    }
    setResult(describeBulkResult(plans)
      + (failed.length ? ` ${failed.join('、')} は状態が無く適用できませんでした。` : ''));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-channel-dialog-title"
    >
      <div className="w-full max-w-lg rounded-lg border border-white/10 bg-[var(--bg-primary)] p-4 text-xs text-[var(--text-primary)] shadow-xl">
        <div className="mb-2 flex items-center justify-between">
          <h3 id="bulk-channel-dialog-title" className="text-sm font-semibold">
            CH設定の一括変更
          </h3>
          <button
            onClick={onClose}
            className="rounded px-2 py-0.5 text-[var(--text-secondary)] hover:text-white"
            aria-label="閉じる"
          >
            ×
          </button>
        </div>
        <p className="mb-3 text-[10px] leading-relaxed text-[var(--text-secondary)]">
          表示中のファイルの値を初期値に、チェックしたファイルの各CHの Min / Max
          をまとめて揃えます。色・表示/非表示は変更しません。変更はファイルごとに
          自動保存されます。
        </p>

        <div className="mb-3 space-y-1">
          {values.map((v, c) => (
            <div key={c} className="flex items-center gap-2">
              <label className="flex w-14 items-center gap-1">
                <input
                  type="checkbox"
                  checked={v.enabled}
                  onChange={(e) => setValue(c, { enabled: e.target.checked })}
                />
                <span>CH{c + 1}</span>
              </label>
              <span className="text-[var(--text-secondary)]">Min</span>
              <input
                type="number"
                min={0}
                value={v.min}
                disabled={!v.enabled}
                onChange={(e) => setValue(c, { min: Number(e.target.value) })}
                className="w-20 rounded border border-white/20 bg-black/60 px-1 py-0.5 text-right tabular-nums disabled:opacity-40"
              />
              <span className="text-[var(--text-secondary)]">Max</span>
              <input
                type="number"
                min={1}
                value={v.max}
                disabled={!v.enabled}
                onChange={(e) => setValue(c, { max: Number(e.target.value) })}
                className="w-20 rounded border border-white/20 bg-black/60 px-1 py-0.5 text-right tabular-nums disabled:opacity-40"
              />
            </div>
          ))}
        </div>
        {valueProblem && (
          <p className="mb-2 text-[10px] text-red-400">{valueProblem}</p>
        )}

        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] text-[var(--text-secondary)]">
            適用するファイル（{checkedTargets.length} / {targets.length}）
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setChecked(new Set(targets.filter((t) => t.hasState).map((t) => t.id)))}
              className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] hover:bg-white/20"
            >
              全選択
            </button>
            <button
              onClick={() => setChecked(new Set())}
              className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] hover:bg-white/20"
            >
              解除
            </button>
          </div>
        </div>
        <div className="mb-3 max-h-56 space-y-0.5 overflow-y-auto rounded border border-white/10 p-1.5">
          {targets.length === 0 && (
            <p className="text-[10px] text-[var(--text-secondary)]">開いているファイルがありません。</p>
          )}
          {targets.map((t) => (
            <label
              key={t.id}
              className={`flex items-center gap-2 rounded px-1 py-0.5 ${
                t.hasState ? 'hover:bg-white/5' : 'opacity-40'
              }`}
              title={t.hasState ? undefined : '一度表示したタブだけ選択できます'}
            >
              <input
                type="checkbox"
                checked={checked.has(t.id) && t.hasState}
                disabled={!t.hasState}
                onChange={() => toggleFile(t.id)}
              />
              <span className="min-w-0 flex-1 truncate">{t.filename}</span>
              <span className="shrink-0 text-[10px] text-[var(--text-secondary)]">
                {t.numChannels}ch{t.id === activeImageId ? ' ・表示中' : ''}
                {!t.hasState ? ' ・未表示' : ''}
              </span>
            </label>
          ))}
        </div>

        {error && <p className="mb-2 text-[10px] text-red-400">{error}</p>}
        {result && <p className="mb-2 text-[10px] text-emerald-300">{result}</p>}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded bg-white/10 px-3 py-1 hover:bg-white/20"
          >
            閉じる
          </button>
          <button
            onClick={apply}
            disabled={!!valueProblem || checkedTargets.length === 0}
            className="rounded bg-[var(--accent)] px-3 py-1 text-white hover:opacity-90 disabled:opacity-40"
          >
            チェックした {checkedTargets.length} 件に適用
          </button>
        </div>
      </div>
    </div>
  );
}
