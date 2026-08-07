import { useState } from 'react';
import { usePlateStore, type PlateColumn } from '../stores/plateStore';
import type { OpenWell } from '../utils/plateWells';

/**
 * The conditions table: one row per open well, one column per thing worth
 * recording.
 *
 * Auto columns are seeded from what each well's viewer is actually set to, and
 * then behave like any other cell — typing in one makes it the user's, and
 * re-seeding leaves it alone. That matters because the auto values are a
 * starting point, not the truth: "CH1, CH2" is what the app knows, "GFP, DAPI"
 * is what the figure needs to say.
 *
 * `図` marks a column for printing over the well's image. Kept to a couple of
 * columns by default — at 24 wells anything more is unreadable — while the
 * table page carries every column regardless.
 */
export function PlateTable({ wells }: { wells: OpenWell[] }) {
  const columns = usePlateStore((s) => s.columns);
  const cells = usePlateStore((s) => s.cells);
  const setCell = usePlateStore((s) => s.setCell);
  const addColumn = usePlateStore((s) => s.addColumn);
  const removeColumn = usePlateStore((s) => s.removeColumn);
  const renameColumn = usePlateStore((s) => s.renameColumn);
  const toggleOnFigure = usePlateStore((s) => s.toggleOnFigure);
  const moveColumn = usePlateStore((s) => s.moveColumn);

  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const startRename = (c: PlateColumn) => { setRenaming(c.key); setDraft(c.label); };
  const commitRename = () => {
    if (renaming) renameColumn(renaming, draft.trim() || '列');
    setRenaming(null);
  };

  if (wells.length === 0) {
    return (
      <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
        開いているウェルがありません。上でウェルを選び「選択したウェルを開く」を押してから、
        各ウェルを 3D ビューで調整してください。ここにはその調整結果が表として出ます。
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto border border-[var(--border)] rounded-lg">
        <table className="text-[11px] border-collapse min-w-full">
          <thead>
            <tr className="bg-[var(--bg-primary)]">
              {columns.map((c, i) => (
                <th key={c.key} className="border-b border-r border-[var(--border)] px-1 py-1
                                           text-left font-medium whitespace-nowrap align-top">
                  {renaming === c.key ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); }}
                      className="w-24 bg-[var(--bg-panel)] border border-[var(--accent)] rounded px-1"
                    />
                  ) : (
                    <button onClick={() => startRename(c)} title="クリックで列名を変更"
                            className="hover:underline">
                      {c.label}
                    </button>
                  )}
                  <div className="flex items-center gap-0.5 mt-0.5 font-normal">
                    <button
                      onClick={() => toggleOnFigure(c.key)}
                      title={c.onFigure ? '図から外す' : '各画像の左上に載せる'}
                      className={`px-1 rounded text-[9px] border transition ${
                        c.onFigure
                          ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
                          : 'text-[var(--text-secondary)] border-[var(--border)]'
                      }`}
                    >図</button>
                    <button onClick={() => moveColumn(c.key, -1)} disabled={i === 0}
                            title="左へ"
                            className="px-0.5 text-[var(--text-secondary)] hover:text-white disabled:opacity-25">‹</button>
                    <button onClick={() => moveColumn(c.key, 1)} disabled={i === columns.length - 1}
                            title="右へ"
                            className="px-0.5 text-[var(--text-secondary)] hover:text-white disabled:opacity-25">›</button>
                    <button onClick={() => removeColumn(c.key)} title="この列を削除"
                            className="px-0.5 text-[var(--text-secondary)] hover:text-red-400">×</button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {wells.map((w) => (
              <tr key={w.wellId} className="odd:bg-black/10">
                {columns.map((c) => (
                  <td key={c.key} className="border-b border-r border-[var(--border)] p-0">
                    <input
                      value={cells[w.wellId]?.[c.key] ?? ''}
                      onChange={(e) => setCell(w.wellId, c.key, e.target.value)}
                      className="w-full min-w-[5rem] bg-transparent px-1 py-1 outline-none
                                 focus:bg-[var(--bg-primary)] focus:ring-1 focus:ring-[var(--accent)]"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => addColumn('')}
          className="px-2 py-1 rounded bg-white/10 text-[11px] hover:bg-white/20 transition"
        >
          + 列を追加
        </button>
        <span className="text-[10px] text-[var(--text-secondary)]">
          列名はクリックで変更。<span className="text-[var(--accent)]">図</span> を付けた列が各画像の左上に出ます。
        </span>
      </div>
    </div>
  );
}
