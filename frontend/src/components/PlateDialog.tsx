import { useState } from 'react';
import { chooseFolder, scanPlate } from '../utils/api';
import { openAndReload, showDefaultViewForActiveImage } from '../hooks/useImageLoader';
import { usePlateStore } from '../stores/plateStore';

/**
 * Select and inspect an Olympus MATL acquisition, then open chosen wells.
 *
 * This dialog deliberately stops before figure editing or export. Scanning the
 * manifest is cheap and opens no volume; the separate Plate Save dialog owns the
 * long-running PDF transaction and the conditions table.
 */
export function PlateDialog({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState('');
  const plate = usePlateStore((s) => s.scan);
  const setScan = usePlateStore((s) => s.setScan);

  const pick = async () => {
    if (loading) return;
    setError('');
    setBusy(true);
    try {
      const picked = await chooseFolder();
      if (picked.cancelled || !picked.path) return;
      const scanned = await scanPlate(picked.path);
      setScan(scanned, picked.path);
      // Everything that can be loaded starts selected. Unticking a few wells is
      // faster and less error-prone than manually finding every stitched well.
      setSelected(new Set(
        scanned.wells
          .filter((well) => well.enabled && well.stitch_path)
          .map((well) => well.well_id),
      ));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setScan(null, '');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => {
    if (busy || loading) return;
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  /** Open large stitched wells serially so their initial loads never overlap. */
  const openSelected = async () => {
    if (!plate || busy || loading) return;
    const targets = plate.wells.filter(
      (well) => selected.has(well.well_id) && well.stitch_path,
    );
    if (targets.length === 0) return;
    setError('');
    const failures: string[] = [];
    let lastOpenedId: string | null = null;
    for (const [index, well] of targets.entries()) {
      setLoading(`${well.well_id} を読み込み中… (${index + 1}/${targets.length})`);
      try {
        const id = await openAndReload(well.stitch_path!, { showDefaultView: false });
        if (id) lastOpenedId = id;
      } catch (e) {
        failures.push(`${well.well_id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    setLoading('');
    if (lastOpenedId) showDefaultViewForActiveImage(lastOpenedId);
    if (failures.length) setError(failures.join('\n'));
    else onClose();
  };

  const byPosition = new Map(
    plate?.wells.map((well) => [`${well.row},${well.col}`, well]) ?? [],
  );
  const rowLabel = (row: number) => String.fromCharCode(65 + row);
  const acquired = plate?.wells.filter((well) => well.enabled).length ?? 0;
  const ready = plate?.wells.filter((well) => well.enabled && well.stitch_path).length ?? 0;
  const requestClose = () => {
    if (!busy && !loading) onClose();
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={requestClose}
    >
      <div
        className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-xl shadow-2xl
                   p-5 max-w-3xl w-full max-h-[85vh] overflow-y-auto"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">プレート（MATL 撮影）を読み込む</h2>
          <button
            onClick={requestClose}
            disabled={busy || !!loading}
            className="text-[var(--text-secondary)] hover:text-white disabled:opacity-40"
            title={busy || loading ? '処理中は閉じられません' : '閉じる'}
          >
            ✕
          </button>
        </div>

        {!plate && (
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed mb-4">
            MATL 撮影のフォルダを選んでください。<code>matl.omp2info</code> と
            <code>.oir</code> が入っているフォルダです。読み取りのみで、画像は開きません。
          </p>
        )}

        <button
          onClick={pick}
          disabled={busy || !!loading}
          className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-xs font-medium
                     hover:opacity-90 disabled:opacity-50 transition"
        >
          {busy ? '読み込み中…' : plate ? '別のフォルダを選ぶ' : '撮影フォルダを選ぶ'}
        </button>

        {error && (
          <p className="text-xs text-red-400 mt-3 whitespace-pre-wrap select-text">{error}</p>
        )}

        {plate && (
          <div className="mt-4">
            <div className="text-xs mb-1">
              <span className="font-semibold">{plate.name}</span>
              <span className="text-[var(--text-secondary)]">
                {' '}— {plate.rows} 行 × {plate.cols} 列 / 取得 {acquired} ウェル
                （Stitch 済み {ready}）
              </span>
            </div>
            <div
              className="text-[10px] font-mono text-[var(--text-secondary)] mb-3 truncate"
              title={plate.source}
            >
              {plate.source}
            </div>

            {plate.warnings.map((warning, index) => (
              <p
                key={index}
                className="text-[11px] text-amber-400 mb-1 whitespace-pre-wrap select-text"
              >
                ⚠ {warning}
              </p>
            ))}

            {/* Keep the complete acquisition shape visible, including empty wells. */}
            <div className="inline-block mt-2">
              <div className="flex">
                <div className="w-6" />
                {Array.from({ length: plate.cols }, (_, column) => (
                  <div
                    key={column}
                    className="w-16 text-center text-[10px] text-[var(--text-secondary)]"
                  >
                    {String(column + 1).padStart(2, '0')}
                  </div>
                ))}
              </div>
              {Array.from({ length: plate.rows }, (_, row) => (
                <div key={row} className="flex">
                  <div className="w-6 flex items-center justify-center text-[10px] text-[var(--text-secondary)]">
                    {rowLabel(row)}
                  </div>
                  {Array.from({ length: plate.cols }, (_, column) => {
                    const well = byPosition.get(`${row},${column}`);
                    const missing = well && well.enabled && !well.stitch_path;
                    const on = well ? selected.has(well.well_id) : false;
                    const selectable = !!well && well.enabled && !!well.stitch_path;
                    return (
                      <button
                        key={column}
                        type="button"
                        disabled={!selectable || busy || !!loading}
                        onClick={() => well && toggle(well.well_id)}
                        title={
                          well
                            ? `${well.well_id}\n${well.tile_grid} = ${well.tiles} タイル\n`
                              + (well.stitch_path
                                ? `Stitch: ${Math.round(well.stitch_bytes / 1048576)} MB`
                                  + (well.chunk_count ? ` + 続き ${well.chunk_count} 個` : '')
                                : 'Stitch ファイルなし')
                              + (well.position_warning ? `\n⚠ ${well.position_warning}` : '')
                            : '未取得'
                        }
                        className={`w-16 h-14 m-0.5 rounded border flex flex-col items-center justify-center
                          text-[10px] leading-tight transition disabled:cursor-default ${
                            selectable && !busy && !loading
                              ? 'cursor-pointer hover:brightness-125'
                              : 'cursor-default'
                          } ${
                            !well
                              ? 'border-[var(--border)] text-[var(--text-secondary)]/40'
                              : missing
                              ? 'border-red-500 bg-red-500/15 text-red-300'
                              : !well.enabled
                              ? 'border-[var(--border)] text-[var(--text-secondary)]'
                              : on
                              ? 'border-[var(--accent)] bg-[var(--accent)]/30 ring-1 ring-[var(--accent)]'
                              : 'border-[var(--border)] text-[var(--text-secondary)]'
                          }`}
                      >
                        <span className="font-mono">
                          {well ? well.well_id : `${rowLabel(row)}${String(column + 1).padStart(2, '0')}`}
                        </span>
                        {well && (
                          <span className="text-[9px] opacity-70">
                            {!well.enabled ? '無効' : missing ? 'Stitch なし' : on ? '選択' : well.tile_grid}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="mt-4 pt-3 border-t border-[var(--border)]">
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  onClick={openSelected}
                  disabled={busy || !!loading || selected.size === 0}
                  className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-xs font-medium
                             hover:opacity-90 disabled:opacity-40 transition"
                >
                  {loading || `選択した ${selected.size} ウェルを開く`}
                </button>
                <button
                  onClick={() => setSelected(
                    selected.size
                      ? new Set()
                      : new Set(
                        plate.wells
                          .filter((well) => well.enabled && well.stitch_path)
                          .map((well) => well.well_id),
                      ),
                  )}
                  disabled={busy || !!loading}
                  className="text-[11px] underline text-[var(--text-secondary)]
                             hover:text-white disabled:opacity-40"
                >
                  {selected.size ? 'すべて解除' : 'すべて選択'}
                </button>
              </div>
              <p className="text-[10px] text-[var(--text-secondary)] mt-2 leading-relaxed">
                ウェルをクリックして選択します。Stitch は 1 ウェル約 1 GB のため、
                選択したウェルも 1 つずつ順番に開きます。調整後の図と条件表は
                ツールバーの <strong>Plate Save</strong> から保存します。
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
