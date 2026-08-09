"""Read an Olympus MATL acquisition into a validated plate manifest.

`matl.omp2info` is plain XML — no Bio-Formats needed. It describes the physical
plate (`microPlate`) and one `group` per acquired well, each listing the per-tile
`.oir` files it produced.

What the viewer wants is the *stitched* file per well, which the microscope wrote
alongside the tiles but which the XML never names. It is derived from a tile name
(`<prefix>_B02_G001_0001.oir` -> `Stitch_B02_G001.oir`) and then checked on disk.

Two independent sources agree on where a well sits: the label (`B02` -> row B,
column 2) and the stage coordinates in `areaInfo`. Both are computed and compared,
because a transposed or shifted grid would produce a correctly-rendered figure
with the wrong labels — a mistake nothing downstream could catch.
"""

from __future__ import annotations

import hashlib
import re
import threading
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from source_state import snapshot_source

MATL_NAMES = ("matl.omp2info", "matl_forVSIimages.omp2info")

#: Olympus stores stage geometry in nanometres.
NM_PER_MM = 1_000_000.0


def _tag(e: ET.Element) -> str:
    return e.tag.split("}")[-1]


def _leaf_children(e: ET.Element) -> dict[str, str]:
    """Direct children that carry text rather than structure."""
    return {_tag(c): (c.text or "").strip() for c in e if len(c) == 0}


@dataclass
class Well:
    well_id: str
    row: int          # 0-based, A=0
    col: int          # 0-based, column 1 = 0
    enabled: bool
    tiles: int
    tile_grid: str    # "3x3"
    stitch_path: str | None
    stitch_identity: str
    stitch_revision: str
    stitch_bytes: int
    chunk_count: int
    #: Empty when the label and the stage coordinates agree.
    position_warning: str = ""


@dataclass
class Plate:
    name: str
    rows: int
    cols: int
    source: str
    matl_sha256: str
    wells: list[Well] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "rows": self.rows,
            "cols": self.cols,
            "source": self.source,
            "matl_sha256": self.matl_sha256,
            "warnings": self.warnings,
            "wells": [
                {
                    "well_id": w.well_id, "row": w.row, "col": w.col,
                    "enabled": w.enabled, "tiles": w.tiles, "tile_grid": w.tile_grid,
                    "stitch_path": w.stitch_path,
                    "stitch_identity": w.stitch_identity,
                    "stitch_revision": w.stitch_revision,
                    "stitch_bytes": w.stitch_bytes,
                    "chunk_count": w.chunk_count, "position_warning": w.position_warning,
                }
                for w in self.wells
            ],
        }


def find_matl(where: str) -> Path | None:
    """The MATL file for a folder, or the file itself if that is what was given."""
    p = Path(where)
    if p.is_file() and p.suffix.lower() == ".omp2info":
        return p
    if not p.is_dir():
        return None
    # MATL_NAMES is shortest-first on purpose: an acquisition carries both
    # matl.omp2info and matl_forVSIimages.omp2info, and the plain one is the one
    # to use. They are not compared — a difference between them is not a problem
    # the user needs to hear about.
    for name in MATL_NAMES:
        if (p / name).is_file():
            return p / name
    # Some exports name it differently; take any single omp2info rather than guess.
    found = sorted(p.glob("*.omp2info"))
    return found[0] if len(found) == 1 else None


def _well_id_to_rc(well_id: str) -> tuple[int, int] | None:
    m = re.fullmatch(r"([A-Za-z])(\d{1,2})", well_id.strip())
    if not m:
        return None
    return ord(m.group(1).upper()) - ord("A"), int(m.group(2)) - 1


def _require_stage_label_match(
    well_id: str,
    row: int,
    col: int,
    stage: dict[str, tuple[float, float]],
    pitch_x: float | None,
    pitch_y: float | None,
) -> None:
    """Reject a MATL label that disagrees with its independent stage position."""
    if not pitch_x or not pitch_y or well_id not in stage or len(stage) < 2:
        return

    xs = [position[0] for position in stage.values()]
    ys = [position[1] for position in stage.values()]
    positions = [position for name in stage if (position := _well_id_to_rc(name))]
    ref_col = min(position[1] for position in positions)
    ref_row = min(position[0] for position in positions)
    stage_col = ref_col + round((stage[well_id][0] - min(xs)) / pitch_x)
    stage_row = ref_row + round((stage[well_id][1] - min(ys)) / pitch_y)
    if (stage_row, stage_col) == (row, col):
        return

    if 0 <= stage_row < 26 and stage_col >= 0:
        stage_well = f"{chr(65 + stage_row)}{stage_col + 1:02d}"
    else:
        stage_well = f"行 {stage_row + 1}、列 {stage_col + 1}"
    raise ValueError(
        "matl のウェルラベルとステージ座標が一致しません: "
        f"ラベルは {well_id} ですが、ステージ座標からは {stage_well} と判定されました。"
        "誤ったラベルの図を防ぐため、このプレートを開けません。"
    )


def _derive_stitch(tile_name: str) -> str | None:
    """`<prefix>_B02_G001_0001.oir` -> `Stitch_B02_G001.oir`."""
    m = re.fullmatch(r".+_(?P<well>[A-Za-z]\d{1,2})_(?P<grp>G\d+)_\d+\.oir", tile_name)
    return f"Stitch_{m['well']}_{m['grp']}.oir" if m else None


def _well_subject(path: Path) -> str:
    """How to name this file in a message: `Stitch_B02_G001.oir` -> `ウェル B02`.

    The read path is handed a path, not a well, so the label is recovered from
    the name `_derive_stitch` built. A path that is not a stitched well — the
    route accepts any .oir — is named by its filename instead of being called a
    well it is not.
    """
    m = re.fullmatch(r"Stitch_(?P<well>[A-Za-z]\d{1,2})_G\d+", path.stem)
    return f"ウェル {m['well']}" if m else path.name


def _chunk_stem(path: Path) -> str:
    """The prefix a split .oir's continuation files carry: `<name>.oir` -> `<name>`."""
    return path.name[: -len(".oir")] if path.name.lower().endswith(".oir") else path.stem


def count_chunks(path: Path) -> int:
    """Continuation chunks (`<name>_00001`, no extension) sitting next to a .oir.

    Same count `scan` reports as `chunk_count`, kept in one place so the number
    quoted in an error is the number the plate list showed.
    """
    stem = _chunk_stem(path)
    return len([p for p in path.parent.glob(f"{stem}_*") if p.suffix == ""])


def scan(where: str) -> Plate:
    """Parse a MATL acquisition. Raises ValueError with a reason the UI can show."""
    matl = find_matl(where)
    if matl is None:
        raise ValueError(
            "matl.omp2info が見つかりません。\n"
            "MATL 撮影のフォルダ（.oir と matl.omp2info が入っているフォルダ）を選んでください。"
        )
    folder = matl.parent
    raw = matl.read_bytes()
    try:
        # UTF-8, not ASCII. Plate and sample names are routinely Japanese, and
        # "ascii", "replace" turns every one of those bytes into U+FFFD — so the
        # name is already destroyed before it reaches the PDF, whatever font is
        # used to draw it. The BOM Olympus sometimes writes is handled too.
        root = ET.fromstring(raw.decode("utf-8-sig", "replace"))
    except ET.ParseError as e:
        raise ValueError(f"matl の XML を解析できません: {e}") from e

    mp_list = [c for c in root if _tag(c) == "microPlate"]
    if not mp_list:
        raise ValueError("matl に microPlate の記述がありません（MATL 撮影ではない可能性があります）")
    mp = _leaf_children(mp_list[0])
    try:
        rows, cols = int(mp["numOfRows"]), int(mp["numOfColumns"])
    except (KeyError, ValueError) as e:
        raise ValueError(f"プレートの行数・列数を読めません: {e}") from e

    warnings: list[str] = []

    groups = [g for g in root if _tag(g) == "group"]
    if not groups:
        raise ValueError("matl に取得ウェル（group）がありません")

    # Stage coordinates are the independent check on the labels. Derived from the
    # extremes so it needs no absolute origin, only a consistent pitch.
    pitch_x = float(mp.get("columnSpace") or 0) or None
    pitch_y = float(mp.get("rowSpace") or 0) or None
    stage: dict[str, tuple[float, float]] = {}
    for g in groups:
        d = _leaf_children(g)
        ai = [c for c in g if _tag(c) == "areaInfo"]
        rc = _well_id_to_rc(d.get("wellId", ""))
        if not ai or rc is None:
            continue
        a = _leaf_children(ai[0])
        try:
            canonical = f"{chr(65 + rc[0])}{rc[1] + 1:02d}"
            stage[canonical] = (float(a["areaLeft"]), float(a["areaTop"]))
        except (KeyError, ValueError):
            pass

    wells: list[Well] = []
    seen_wells: set[str] = set()
    seen_positions: set[tuple[int, int]] = set()
    for g in groups:
        d = _leaf_children(g)
        raw_wid = d.get("wellId", "").strip()
        rc = _well_id_to_rc(raw_wid)
        if rc is None:
            raise ValueError(f"ウェル名を解釈できません: {raw_wid!r}")
        row, col = rc
        wid = f"{chr(65 + row)}{col + 1:02d}"
        if not (0 <= row < rows and 0 <= col < cols):
            raise ValueError(f"{wid} はプレート（{rows}行×{cols}列）の外を指しています")
        if wid in seen_wells or (row, col) in seen_positions:
            raise ValueError(f"matl に同じウェル位置が複数あります: {wid}")
        seen_wells.add(wid)
        seen_positions.add((row, col))

        areas = [a for a in g if _tag(a) == "area"]
        ai = [c for c in g if _tag(c) == "areaInfo"]
        a = _leaf_children(ai[0]) if ai else {}
        grid = f"{a.get('numOfXAreas', '?')}x{a.get('numOfYAreas', '?')}"

        tile_names = [_leaf_children(x).get("image", "") for x in areas]
        stitch_name = next((s for s in (_derive_stitch(t) for t in tile_names) if s), None)
        stitch = folder / stitch_name if stitch_name else None
        exists = bool(stitch and stitch.is_file())
        chunks = count_chunks(stitch) if exists and stitch is not None else 0
        source = snapshot_source(stitch) if exists and stitch is not None else None

        # A warning is not safe here: the pixels would be rendered correctly but
        # published under the wrong well label. Stop before any well can be opened.
        _require_stage_label_match(wid, row, col, stage, pitch_x, pitch_y)

        wells.append(Well(
            well_id=wid, row=row, col=col,
            enabled=(d.get("enable", "true").lower() != "false"),
            tiles=len(areas), tile_grid=grid,
            stitch_path=str(stitch.resolve()) if exists and stitch else None,
            stitch_identity=(source.identity if source else ""),
            stitch_revision=(source.revision if source else ""),
            stitch_bytes=(source.size if source else 0),
            chunk_count=chunks, position_warning="",
        ))

    wells.sort(key=lambda w: (w.row, w.col))
    missing = [w.well_id for w in wells if w.enabled and not w.stitch_path]
    if missing:
        warnings.append(
            "Stitch 済みファイルが見つからないウェル: " + ", ".join(missing) +
            "。PDF 出力には Stitch ファイルが必要です。"
        )
    return Plate(
        # Not "?": the name reaches a filename, and ? is illegal on Windows.
        name=(mp.get("name") or "plate"), rows=rows, cols=cols,
        source=str(folder), matl_sha256=hashlib.sha256(raw).hexdigest(),
        wells=wells, warnings=warnings,
    )


# --------------------------------------------------------- plate volume reading

#: Volume resolutions offered for plate export, as a max XY dimension.
#:
#: 0 means no downscale at all — the source resolution, whatever it is. Low is
#: the default because it is the quick look; the larger steps exist for a figure
#: that has to preserve detail, and `max` for one that must not lose any.
#:
#: There is no server-side ceiling. The real limit is the renderer's
#: MAX_3D_TEXTURE_SIZE, which is 2048 on some GPUs and 16384 on others, so it
#: cannot be decided here — the client checks its own GPU and says so if the
#: volume will not fit, rather than this route silently shrinking it.
PLATE_XY_CHOICES = {"low": 128, "medium": 256, "high": 512, "ultra": 1024, "max": 0}
PLATE_MAX_XY = 128
PLATE_MAX_Z = 128
#: The renderer's shader samples four channels; more would be transferred and
#: dropped.
PLATE_MAX_CH = 4

#: One well at a time. Each read holds a Java reader and a plane buffer, and two
#: concurrent wells would double both for no gain — the JVM and the disk are the
#: bottleneck, not the request.
_WELL_LOCK = threading.Semaphore(1)


def _resize_plane(plane: np.ndarray, out_h: int, out_w: int) -> np.ndarray:
    """Anti-aliased XY resize of one plane, allocating only plane-sized temporaries.

    The existing volume route resizes a whole (Z,Y,X) channel at once, which for
    this data means a 1.585 GiB float32 copy per channel. Per plane the same work
    peaks at a few megabytes.

    Interpolation alone is not a downscale. `zoom(order=1)` reads the source at
    the output sample positions, so shrinking 2911 -> 128 consults roughly one
    pixel in 23 per axis and ignores the rest: a structure two pixels wide has
    about a 1-in-10 chance of being sampled at all, and otherwise vanishes
    completely rather than dimming. For thin epithelial signal that is the
    difference between a figure and a wrong figure, and it gets worse the lower
    the resolution — i.e. exactly in the Low preview meant for judging what to
    export at full detail.

    So the plane is low-pass filtered first, with sigma tied to the reduction
    factor, which is what an anti-aliased resample means. Thin structures survive
    as dimmer features instead of disappearing, and integrated signal is
    preserved. No filtering is applied when not shrinking.
    """
    from scipy.ndimage import gaussian_filter, zoom as ndzoom
    h, w = plane.shape
    if (h, w) == (out_h, out_w):
        return plane.astype(np.float32, copy=False)
    src = plane.astype(np.float32)
    fy, fx = h / out_h, w / out_w
    if fy > 1 or fx > 1:
        # skimage's convention: sigma = (factor - 1) / 2 per axis, no blur when
        # that axis is not being reduced.
        src = gaussian_filter(src, sigma=(max(fy - 1, 0) / 2, max(fx - 1, 0) / 2))
    return ndzoom(src, (out_h / h, out_w / w), order=1)


def require_complete_split(reader_j, path: Path, actual_z: int) -> None:
    """Refuse a well whose split .oir is missing the chunks holding most of its Z.

    Olympus splits a dataset over ~1 GB across `<name>.oir` plus extensionless
    `<name>_00001`, `_00002`, … siblings. Copy only the .oir and it still opens,
    still reports the full XY size, and exposes just the planes in the part that
    came with it — Z 13 of 50, in the case this was found on. reader.py catches
    that on an ordinary Open (`_detect_incomplete_oir`) and says so; nothing
    checked it here, so such a well was rendered from a truncated Z range and
    placed in the PDF looking like a finished result. A figure that is wrong
    without looking wrong is the worst thing this export can produce, so this
    fails rather than warns — the same all-or-nothing rule the export already
    follows, where one unreadable well means no PDF instead of a gap.

    The measure is reader.py's, shared as `reader.declared_z_length`: the vendor
    metadata keeps the acquired Z even in the truncated copy, so a declared Z
    longer than the reader can expose means the pixels are elsewhere.

    Deliberately stricter than reader.py in one respect: reader.py stops at
    "`_00001` exists" and stays quiet, which passes a partly-copied well — some
    chunks present, Z still short — and that is the likeliest way this arrives,
    a copy interrupted partway. Here any shortfall fails, and the message quotes
    the chunk count so a genuinely truncated acquisition is distinguishable from
    a bad copy by the person reading it.
    """
    from reader import declared_z_length

    declared = declared_z_length(reader_j)
    if declared <= actual_z:
        return
    chunks = count_chunks(path)
    raise ValueError(
        f"{_well_subject(path)} は分割保存された .oir の一部しか読めません"
        f"（Zスライス {actual_z}/{declared}、続きのファイル {chunks} 個）。\n"
        f"同じフォルダに {_chunk_stem(path)}_00001, _00002, … を揃えてから、"
        "もう一度書き出してください。\n"
        "一部が欠けたまま PDF にすると、そのウェルだけ浅い Z 範囲で描画され、"
        "完成した結果と見分けがつきません。PDF は作成していません。"
    )


@dataclass
class VolumeSpec:
    """What to read, and the contrast to bake in. Nothing here is inferred."""
    path: str
    source_identity: str
    source_revision: str
    channels: list[int]
    #: Per entry in `channels`, the display window to apply. Never computed here:
    #: plate export must not auto-stretch, so the caller passes what the user set.
    levels: list[tuple[float, float]]
    t: int = 0
    #: Max XY of the returned volume; 0 for the source resolution unchanged.
    max_xy: int = PLATE_MAX_XY


def _plate_source_dtype(pixel_type: int, format_tools, little: bool,
                        filename: str) -> np.dtype:
    """Use only pixel types whose values match the ordinary viewer exactly."""
    end = "<" if little else ">"
    if pixel_type == format_tools.UINT8:
        return np.dtype("u1")
    if pixel_type == format_tools.UINT16:
        return np.dtype(end + "u2")
    if pixel_type == format_tools.INT16:
        return np.dtype(end + "i2")
    # reader.py converts a whole floating-point volume to uint16 using its
    # global range. Applying the viewer's uint16 levels to one raw float plane
    # here would create a valid-looking but usually black PDF. Wider integers
    # and doubles are likewise not represented by the ordinary viewer path.
    raise ValueError(
        f"{filename}: Plate PDF ではこの画素型を安全に再現できません "
        f"(pixelType={pixel_type})。8-bit unsigned または 16-bit を使用してください。"
    )


def read_low_volume(spec: VolumeSpec) -> tuple[dict, bytes]:
    """Read one well's stitched OIR straight into a Low uint8 volume.

    Streams: for each requested channel and output Z, read the source plane,
    resize it, apply the frozen window, and write the bytes. The full-resolution
    volume is never materialised — for the real data that is 3.96 GiB avoided per
    well, to produce about 3.1 MiB.

    Returns (info, payload) where payload matches /api/volume-bin's layout so the
    existing renderer can consume it unchanged.
    """
    import scyjava
    from reader import _start_jvm

    p = Path(spec.path)
    if not p.is_file():
        raise ValueError(f"ファイルが見つかりません: {p}")

    _start_jvm(scyjava)
    ImageReader_j = scyjava.jimport("loci.formats.ImageReader")
    MetadataTools = scyjava.jimport("loci.formats.MetadataTools")
    reader_j = ImageReader_j()
    # Physical voxel size, so the export can be shaped like the sample rather
    # than like a cube. A confocal stack is almost always anisotropic, and the
    # interactive view already scales by these — without them the PDF is the one
    # picture of this data that is the wrong shape.
    ome = MetadataTools.createOMEXMLMetadata()
    reader_j.setMetadataStore(ome)
    with _WELL_LOCK:
        try:
            before = snapshot_source(p)
            if (before.identity != spec.source_identity
                    or before.revision != spec.source_revision):
                raise ValueError(
                    "ウェル画像または分割 OIR の続きが、表示調整後に変更されました。"
                    "画像タブを開き直し、プレートを再選択してください。"
                )
            reader_j.setId(str(p))
            n_c, n_z, n_t = reader_j.getSizeC(), reader_j.getSizeZ(), reader_j.getSizeT()
            h, w = reader_j.getSizeY(), reader_j.getSizeX()
            # Before a single plane is read: a well missing its continuation
            # chunks reads perfectly and renders a short stack, so the only way
            # to keep it out of the PDF is to refuse it here.
            require_complete_split(reader_j, p, int(n_z))
            # The pixel type comes from the file, as reader.py already does it.
            # Hardcoding 16-bit here reinterpreted an 8-bit well's bytes in pairs:
            # half the width, and values that are two unrelated pixels glued
            # together. It renders as noise rather than failing.
            little = reader_j.isLittleEndian()
            FormatTools = scyjava.jimport("loci.formats.FormatTools")
            pt = reader_j.getPixelType()
            dtype = _plate_source_dtype(pt, FormatTools, little, p.name)

            def _phys(get) -> float:
                try:
                    v = get(0)
                    return float(v.value().doubleValue()) if v is not None else 0.0
                except Exception:
                    return 0.0

            voxel = [_phys(ome.getPixelsPhysicalSizeX),
                     _phys(ome.getPixelsPhysicalSizeY),
                     _phys(ome.getPixelsPhysicalSizeZ)]
            if any(not np.isfinite(v) or v <= 0 for v in voxel):
                raise ValueError(
                    f"{p.name}: voxel size (X/Y/Z) を取得できないため、"
                    "形状を推測した 3D 図は作成しません。"
                )

            want = list(spec.channels)
            if not want:
                raise ValueError("読み込むチャンネルがありません")
            if len(want) > PLATE_MAX_CH:
                raise ValueError(f"一度に描画できるチャンネルは {PLATE_MAX_CH} 個までです")
            if len(set(want)) != len(want) or any(c < 0 or c >= n_c for c in want):
                raise ValueError(
                    f"指定チャンネルが {p.name} の範囲 1–{n_c} と一致しません。"
                    "画像タブを開き直してください。"
                )
            if len(spec.levels) != len(want):
                raise ValueError("チャンネル数と Min/Max の数が一致しません")
            if spec.t < 0 or spec.t >= n_t:
                raise ValueError(
                    f"指定した T={spec.t + 1} は {p.name} の範囲 1–{n_t} を超えています。"
                )
            for lo, hi in spec.levels:
                if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
                    raise ValueError("Min/Max が不正です。各チャンネルで Max を Min より大きくしてください。")

            # 0 = no downscale. Otherwise a floor only, so a typo cannot ask for
            # a 4-pixel volume; there is deliberately no upper bound.
            cap = 0 if int(spec.max_xy) <= 0 else max(32, int(spec.max_xy))
            scale = cap / max(h, w) if cap and max(h, w) > cap else 1.0
            out_h, out_w = int(round(h * scale)), int(round(w * scale))
            # Z follows the same rule: untouched when max_xy asks for the source.
            out_z = n_z if cap == 0 else min(n_z, PLATE_MAX_Z)

            planes: list[bytes] = []
            for i, c in enumerate(want):
                lo, hi = spec.levels[i]
                rng = max(float(hi) - float(lo), 1.0)
                buf = np.empty((out_z, out_h, out_w), dtype=np.uint8)
                for zi in range(out_z):
                    # Nearest source plane when Z is decimated; no interpolation
                    # across Z, which would invent signal between real sections.
                    src_z = zi if out_z == n_z else min(n_z - 1, round(zi * (n_z - 1) / max(out_z - 1, 1)))
                    idx = reader_j.getIndex(int(src_z), int(c), int(spec.t))
                    raw = bytes(reader_j.openBytes(idx))
                    plane = np.frombuffer(raw, dtype=dtype).reshape(h, w)
                    small = _resize_plane(plane, out_h, out_w)
                    np.clip((small - float(lo)) * (255.0 / rng), 0, 255,
                            out=small)
                    buf[zi] = small.astype(np.uint8)
                planes.append(buf.tobytes())
                del buf

            header = np.array([len(want), out_z, out_h, out_w, n_c, n_z, h, w],
                              dtype="<u4").tobytes()
            # The renderer reads these as the window already applied, so report
            # the window that WAS applied rather than anything measured.
            meta = np.array([(int(lo), int(hi)) for lo, hi in spec.levels[:len(want)]],
                            dtype="<i4").tobytes()
            info = {
                "channels": want, "out": [out_z, out_h, out_w], "max_xy": cap,
                "source": [n_c, n_z, h, w], "bytes": len(header) + len(meta) + sum(map(len, planes)),
                "source_identity": before.identity,
                "source_revision": before.revision,
                "t": int(spec.t),
                "levels": [[float(lo), float(hi)] for lo, hi in spec.levels],
                # µm per voxel. All three are required above; Plate PDF never
                # guesses an isotropic shape when acquisition metadata is absent.
                "voxel": voxel,
            }
            payload = header + meta + b"".join(planes)
            after = snapshot_source(p)
            if after.identity != before.identity or after.revision != before.revision:
                raise ValueError(
                    "ウェル画像または分割 OIR の続きが読み込み中に変更されました。"
                    "このウェルの画素は PDF に使用していません。"
                )
            return info, payload
        finally:
            # A Java reader left open holds the file and its memory-mapped chunks.
            try:
                reader_j.close()
            except Exception:
                pass


# ------------------------------------------------------------- PDF composition

#: Raster size of one well's image in the PDF, in pixels. The cell and the page
#: are sized from this, so a bigger choice means a bigger page rather than the
#: same page with an upscaled image — upscaling would add no detail while
#: quadrupling the file.
PDF_CELL_CHOICES = {"draft": 300, "normal": 600, "high": 1200, "max": 2000}

#: Page furniture, as a fraction of the cell so every choice stays proportionate.
_PAD_F, _LABEL_F, _TITLE_F, _MARGIN_F = 0.04, 0.09, 0.16, 0.10

#: What an empty cell says, by the state the caller reports for that well. These
#: are printed on a figure, so they have to be true: "Not acquired" over a well
#: the microscope did image would misdescribe the experiment to anyone reading it.
#: An unknown or absent state falls back to "Not acquired", which is the only
#: correct reading of a well the manifest never mentioned.
EMPTY_CELL_LABELS = {
    "disabled": "Disabled",       # in the manifest, switched off for the run
    "excluded": "Not selected",   # imaged, but the user did not include it here
    "missing": "File missing",    # imaged, but its stitched file is not on disk
}

#: Fonts to try, CJK-capable first. The plate name comes from the acquisition
#: folder, which is routinely Japanese — and Helvetica and Arial both render
#: Japanese as .notdef boxes rather than failing, so a title of tofu is what
#: reaches the figure. Every CJK font here also covers the ASCII furniture, so
#: when one is found it is used for everything.
_FONT_CANDIDATES = (
    "Arial Unicode.ttf", "Hiragino Sans GB.ttc",              # macOS
    "meiryo.ttc", "YuGothM.ttc", "YuGothR.ttc", "msgothic.ttc",  # Windows
    "NotoSansCJK-Regular.ttc", "NotoSansJP-Regular.otf",      # Linux
    "Helvetica.ttc", "Arial.ttf", "DejaVuSans.ttf",           # Latin-only
)

#: Characters this figure actually prints. Probing one kanji is not enough:
#: Hiragino Sans GB has every Japanese glyph and no U+00B5, so a caption reading
#: "10 µM" came out with a box in it while the font reported itself as fine.
#: Microscopy text is mostly µm, °, and Greek, so those are what get checked.
_PROBE_JA = "状ア"
_PROBE_SYM = "µμ°βα±×–℃Å"


def _glyph_gaps(font, text: str) -> str:
    """Which characters this font would draw as .notdef boxes.

    A missing glyph still renders, with its own bounding box, so every cheap way
    of asking "does this font have this character" answers yes. Drawing it and
    comparing against a codepoint no font defines is the only honest test.
    """
    from PIL import Image, ImageDraw

    def bits(ch: str) -> bytes:
        im = Image.new("L", (48, 48), 0)
        ImageDraw.Draw(im).text((2, 2), ch, fill=255, font=font)
        return im.tobytes()

    try:
        undef = bits("￾")
        return "".join(ch for ch in text if bits(ch) == undef)
    except Exception:
        return text


#: Characters replaced before drawing, where an identical-looking one is far
#: more widely present. U+00B5 MICRO SIGN is absent from several fonts that do
#: have U+03BC GREEK SMALL LETTER MU, and no reader can tell the two apart —
#: substituting is strictly better than printing a box.
_GLYPH_SUBS = str.maketrans({"µ": "μ", "Å": "Å"})


def normalize_text(s: str) -> str:
    """Swap characters that are commonly missing for identical-looking ones."""
    return (s or "").translate(_GLYPH_SUBS)


def resolve_font_name() -> tuple[str | None, str]:
    """Pick the font to draw with. Returns (name or None, characters it lacks).

    Scored rather than first-match: several installed fonts cover Japanese, and
    they differ in which symbols they carry. Japanese coverage is the entry
    requirement — a figure with boxed-out plate names is worse than one missing
    a degree sign — and among fonts that pass, the one with the fewest gaps in
    the symbol set wins.
    """
    from PIL import ImageFont

    best: tuple[str, str] | None = None
    latin: str | None = None
    for name in _FONT_CANDIDATES:
        try:
            probe = ImageFont.truetype(name, 24)
        except OSError:
            continue
        if _glyph_gaps(probe, _PROBE_JA):
            if latin is None:
                latin = name
            continue
        gaps = _glyph_gaps(probe, normalize_text(_PROBE_SYM))
        if best is None or len(gaps) < len(best[1]):
            best = (name, gaps)
        if not gaps:
            break
    if best:
        return best
    return latin, "日本語"


@dataclass
class WellFrame:
    """One rendered well, ready to place."""
    well_id: str
    row: int
    col: int
    #: RGB or RGBA pixels, any size; resized into the cell preserving aspect.
    png: bytes
    #: Lines printed over the top-left of this well's image — the columns the
    #: user marked for the figure. Empty draws nothing at all rather than a
    #: blank strip.
    caption: list[str] = field(default_factory=list)


def validate_pdf_layout(
    rows: int,
    cols: int,
    frames: list,
    well_states: dict[str, str],
    cell_px: int,
    table_headers: list[str] | None,
    table_rows: list[list[str]] | None,
) -> None:
    """Reject anything Pillow's grid would otherwise crop or silently replace."""
    if not (1 <= rows <= 26 and 1 <= cols <= 99):
        raise ValueError("プレートの行列数が不正です")
    if cell_px not in PDF_CELL_CHOICES.values():
        raise ValueError("PDF セル解像度が不正です")
    if rows * cols * cell_px * cell_px > 250_000_000:
        raise ValueError("選択したプレートサイズとセル解像度では PDF が大きすぎます")
    if not frames or len(frames) > rows * cols:
        raise ValueError("描画されたウェル数が不正です")

    seen_ids: set[str] = set()
    seen_positions: set[tuple[int, int]] = set()
    for frame in frames:
        row, col = int(frame.row), int(frame.col)
        if not (0 <= row < rows and 0 <= col < cols):
            raise ValueError(f"{frame.well_id}: PDF グリッドの範囲外です")
        expected_id = f"{chr(65 + row)}{col + 1:02d}"
        if frame.well_id != expected_id:
            raise ValueError(
                f"ウェル名 {frame.well_id} と位置 ({row + 1}, {col + 1}) が一致しません"
            )
        if frame.well_id in seen_ids or (row, col) in seen_positions:
            raise ValueError(f"同じウェルが複数のフレームにあります: {frame.well_id}")
        if len(frame.caption) > 20 or any(len(line) > 1000 for line in frame.caption):
            raise ValueError(f"{frame.well_id}: キャプションが長すぎます")
        seen_ids.add(frame.well_id)
        seen_positions.add((row, col))

    for well_id, state in well_states.items():
        rc = _well_id_to_rc(well_id)
        if rc is None or not (0 <= rc[0] < rows and 0 <= rc[1] < cols):
            raise ValueError(f"空ウェル状態の位置が不正です: {well_id}")
        canonical = f"{chr(65 + rc[0])}{rc[1] + 1:02d}"
        if well_id != canonical or state not in EMPTY_CELL_LABELS:
            raise ValueError(f"空ウェル状態が不正です: {well_id}={state}")

    headers = table_headers or []
    body = table_rows or []
    if bool(headers) != bool(body):
        raise ValueError("条件表の見出しと行が一致しません")
    if headers:
        if len(headers) > 64 or len(body) != len(frames):
            raise ValueError("条件表の行数が描画ウェル数と一致しません")
        if any(len(row) != len(headers) for row in body):
            raise ValueError("条件表の列数が一致しません")
        if any(len(header) > 1000 for header in headers):
            raise ValueError("条件表の見出しが長すぎます")
        if any(len(cell) > 5000 for row in body for cell in row):
            raise ValueError("条件表のセルが長すぎます")


def _render_table_page(
    headers: list[str],
    rows: list[list[str]],
    title: str,
    page_w: int,
    font_of,
    cell_px: int,
):
    """The table as its own page, sized to fit the figure page's width.

    Matching the figure's width matters: a PDF whose two pages are different
    sizes opens at different zooms and prints awkwardly, and this is meant to be
    read alongside the plate rather than as a separate document.

    Column widths are proportional to the longest cell in each column, so a
    free-text notes column gets the room and `Well` does not. Text that still
    does not fit is clipped with an ellipsis rather than overrunning its
    neighbour, because a table where columns bleed into each other is worse than
    one that visibly truncates.
    """
    from PIL import Image, ImageDraw

    if not headers or not rows:
        return None
    # Normalised before measuring, not just before drawing: a substituted glyph
    # can be a different width, and a column sized to the original would clip.
    headers = [normalize_text(h) for h in headers]
    rows = [[normalize_text(c) for c in r] for r in rows]

    pad = max(6, cell_px // 60)
    fs = max(11, cell_px // 34)
    f = font_of(fs)
    f_head = font_of(fs)
    line_h = int(fs * 1.9)
    title_h = int(fs * 3.0)
    margin = max(8, int(cell_px * _MARGIN_F))

    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))

    def width_of(s: str) -> int:
        return int(probe.textlength(s, font=f))

    natural = [
        max(width_of(h), *(width_of(r[i]) for r in rows)) + pad * 3
        for i, h in enumerate(headers)
    ]
    avail = page_w - margin * 2
    total = sum(natural)
    # Only ever shrink: a narrow table centred in a wide page reads better than
    # one stretched into columns of whitespace.
    widths = ([int(w * avail / total) for w in natural] if total > avail else natural)

    page_h = margin * 2 + title_h + line_h * (len(rows) + 1)
    page = Image.new("RGB", (page_w, page_h), "white")
    d = ImageDraw.Draw(page)
    d.text((margin, margin), normalize_text(title), fill="black", font=font_of(int(fs * 1.6)))

    def clip(s: str, w: int) -> str:
        if width_of(s) <= w - pad * 2:
            return s
        while s and width_of(s + "…") > w - pad * 2:
            s = s[:-1]
        return s + "…"

    y = margin + title_h
    x = margin
    for i, h in enumerate(headers):
        d.text((x + pad, y + line_h // 2), clip(h, widths[i]), fill="black",
               font=f_head, anchor="lm")
        x += widths[i]
    d.line([(margin, y + line_h), (margin + sum(widths), y + line_h)], fill="#404040", width=2)

    for n, row in enumerate(rows):
        y += line_h
        if n % 2 == 1:
            d.rectangle([(margin, y), (margin + sum(widths), y + line_h)], fill="#f4f4f4")
        x = margin
        for i, cell in enumerate(row):
            d.text((x + pad, y + line_h // 2), clip(cell, widths[i]), fill="#202020",
                   font=f, anchor="lm")
            x += widths[i]
        d.line([(margin, y + line_h), (margin + sum(widths), y + line_h)],
               fill="#d0d0d0", width=1)

    return page


def compose_pdf(
    out_path: Path,
    plate_name: str,
    rows: int,
    cols: int,
    frames: list[WellFrame],
    well_states: dict[str, str],
    cell_px: int,
    footer: str,
    table_headers: list[str] | None = None,
    table_rows: list[list[str]] | None = None,
) -> Path:
    """Lay rendered wells out in the plate's own grid and write one PDF.

    Every position in the plate appears, whether or not it was acquired: a packed
    grid of only the acquired wells would be unreadable as a plate, and a reader
    could not tell B02 from B04.

    `well_states` says why each empty cell is empty, keyed by well_id — a key that
    is absent means the plate never imaged it. The distinction is the whole point:
    an earlier version marked every empty cell "Not acquired", so a well that WAS
    imaged but merely left out of the selection appeared in the figure as one that
    was never imaged. That is a false statement about an experiment, and nothing
    downstream could catch it. A well that was supposed to render and failed never
    reaches here at all — the caller fails the whole export instead.
    """
    validate_pdf_layout(
        rows, cols, frames, well_states, cell_px, table_headers, table_rows,
    )
    from PIL import Image, ImageDraw, ImageFont

    pad = max(2, int(cell_px * _PAD_F))
    label_h = max(10, int(cell_px * _LABEL_F))
    title_h = max(16, int(cell_px * _TITLE_F))
    margin = max(8, int(cell_px * _MARGIN_F))
    gutter = label_h * 2

    page_w = margin * 2 + gutter + cols * (cell_px + pad)

    chosen, _ = resolve_font_name()

    def font(px: int):
        if chosen:
            try:
                return ImageFont.truetype(chosen, px)
            except OSError:
                pass
        # Pillow's own font, so a machine with no usable system font still
        # produces a labelled figure rather than an exception.
        return ImageFont.load_default(px)

    f_title, f_label, f_cell = font(max(12, title_h // 2)), font(max(9, label_h * 2 // 3)), font(max(8, label_h // 2))

    # Provenance must not be ellipsized or clipped. Prefer a separator before
    # falling back to a character boundary, so a long T list remains complete
    # and readable even on a one-column plate. Reserve real page height below
    # the grid for every resulting line.
    footer_text = normalize_text(footer)
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    footer_lines: list[str] = []
    if footer_text:
        available = page_w - margin * 2
        line = ""
        for char in footer_text:
            candidate = line + char
            if line and probe.textlength(candidate, font=f_cell) > available:
                split_at = max(line.rfind(" ") + 1,
                               line.rfind(",") + 1,
                               line.rfind("|") + 1)
                if split_at > 0:
                    footer_lines.append(line[:split_at].rstrip())
                    line = line[split_at:].lstrip() + char
                else:
                    footer_lines.append(line)
                    line = char
            else:
                line = candidate
        if line:
            footer_lines.append(line)
    cell_box = f_cell.getbbox("Ag")
    footer_line_h = max(label_h, cell_box[3] - cell_box[1] + 2)
    grid_bottom = margin + title_h + label_h + rows * (cell_px + pad)
    footer_gap = max(3, margin // 3)
    footer_top = grid_bottom + footer_gap
    page_h = (footer_top + len(footer_lines) * footer_line_h + footer_gap
              if footer_lines else grid_bottom + margin)
    page = Image.new("RGB", (page_w, page_h), "white")
    draw = ImageDraw.Draw(page)

    draw.text((margin, margin), normalize_text(f"{plate_name}  —  {rows}x{cols}"),
              fill="black", font=f_title)

    grid_x = margin + gutter
    grid_y = margin + title_h + label_h
    for c in range(cols):
        x = grid_x + c * (cell_px + pad)
        draw.text((x + cell_px // 2, grid_y - label_h), f"{c + 1:02d}",
                  fill="black", font=f_label, anchor="mb")
    for r in range(rows):
        y = grid_y + r * (cell_px + pad)
        draw.text((grid_x - pad, y + cell_px // 2), chr(65 + r),
                  fill="black", font=f_label, anchor="rm")

    placed = {(f.row, f.col): f for f in frames}
    for r in range(rows):
        for c in range(cols):
            x, y = grid_x + c * (cell_px + pad), grid_y + r * (cell_px + pad)
            box = (x, y, x + cell_px, y + cell_px)
            wid = f"{chr(65 + r)}{c + 1:02d}"
            f = placed.get((r, c))
            if f is not None:
                page.paste(Image.new("RGB", (cell_px, cell_px), "black"), (x, y))
                import io
                im = Image.open(io.BytesIO(f.png)).convert("RGB")
                im.thumbnail((cell_px, cell_px), Image.LANCZOS)   # never stretched
                page.paste(im, (x + (cell_px - im.width) // 2, y + (cell_px - im.height) // 2))
                draw.rectangle(box, outline="black", width=1)
                # Over the image, not beside it, so a cell stays one square and
                # the plate keeps its shape. Stroked rather than shadowed: a
                # blurred glow around light text on bright signal is a smear,
                # which is what made the scale bar unreadable on dark colours.
                lines = f.caption or [f.well_id]
                ty = y + pad
                for line in lines:
                    draw.text((x + pad, ty), normalize_text(line), fill="white", font=f_cell,
                              stroke_width=max(1, cell_px // 300), stroke_fill="black")
                    ty += int(label_h * 0.85)
            else:
                draw.rectangle(box, outline="#c8c8c8", width=1)
                state = EMPTY_CELL_LABELS.get(well_states.get(wid, ""), "Not acquired")
                draw.text((x + cell_px // 2, y + cell_px // 2 - label_h), wid,
                          fill="#909090", font=f_cell, anchor="mm")
                draw.text((x + cell_px // 2, y + cell_px // 2 + label_h), state,
                          fill="#b0b0b0", font=f_cell, anchor="mm")

    for line_no, line in enumerate(footer_lines):
        position = (margin, footer_top + line_no * footer_line_h)
        bounds = draw.textbbox(position, line, font=f_cell, anchor="lt")
        if bounds[2] > page_w - margin + 1 or bounds[3] > page_h:
            raise ValueError("PDF footer の配置検証に失敗しました。")
        draw.text(position, line, fill="#808080", font=f_cell, anchor="lt")

    # Written exactly where asked. Whether replacing something is acceptable was
    # settled before this was called — silently sliding to `_01` produced folders
    # of near-identical figures with no way to tell which was which.
    final = out_path
    extra = []
    if table_headers and table_rows:
        # Same file, not a sidecar: the figure and the conditions it was taken
        # under get separated the moment they are two downloads.
        tbl = _render_table_page(
            table_headers, table_rows, f"{plate_name} — 条件表", page_w, font, cell_px,
        )
        if tbl is not None:
            extra.append(tbl)
    page.save(final, "PDF", resolution=300.0, save_all=bool(extra), append_images=extra)
    return final


def selftest() -> int:
    """Prove this build can actually compose a PDF. Returns an exit code.

    Saving a PDF needs more than `import PIL`: Pillow registers its codecs
    lazily, by importing `PIL.*ImagePlugin` modules by name at first use, and
    PyInstaller resolves imports statically. A frozen build can therefore import
    Pillow perfectly and still fail on `save(..., "PDF")` — the same shape of bug
    as the missing .dist-info that made every packaged build unable to open a
    .oir for a whole release. Fonts have the same property: `truetype("Arial.ttf")`
    resolves against the OS font directories, which differ per platform.

    So this walks the real path — encode a PNG, decode it, resolve the fonts,
    lay out a grid, write the PDF — rather than asserting the imports succeed.

    It then checks the split-chunk guard, which needs no Bio-Formats and no real
    acquisition to exercise, and whose failure mode is a PDF that looks right.
    """
    import io
    import tempfile

    try:
        from PIL import Image
    except Exception as e:
        print(f"selftest FAILED: import PIL -> {type(e).__name__}: {e}", flush=True)
        return 10

    try:
        buf = io.BytesIO()
        Image.new("RGB", (64, 48), (20, 160, 90)).save(buf, "PNG")
        png = buf.getvalue()
    except Exception as e:
        print(f"selftest FAILED: PNG encode -> {type(e).__name__}: {e}", flush=True)
        return 11

    # Which font this platform resolved, and whether it can draw Japanese. Not
    # fatal — a Latin-only font still produces a usable figure — but a plate name
    # from a Japanese folder would come out as boxes, so it must be visible in
    # the build log rather than discovered on a finished PDF.
    try:
        name, gaps = resolve_font_name()
        print(f"selftest: font {name or 'PIL default'}"
              f" ({'全て描画できます' if not gaps else f'描画できない文字: {gaps}'})", flush=True)
    except Exception as e:
        print(f"selftest: font probe failed -> {type(e).__name__}: {e}", flush=True)

    # A frame in a cell and an empty cell, so both branches of the layout run.
    # The plate name is Japanese on purpose: it is the path that broke.
    frames = [WellFrame(well_id="B02", row=1, col=1, png=png)]
    try:
        with tempfile.TemporaryDirectory() as tmp:
            out = compose_pdf(
                Path(tmp) / "selftest.pdf", "セルフテスト", 2, 2, frames,
                {"A02": "disabled"}, PDF_CELL_CHOICES["draft"], "selftest",
            )
            head, size = out.read_bytes()[:5], out.stat().st_size
    except Exception as e:
        print(f"selftest FAILED: compose_pdf -> {type(e).__name__}: {e}", flush=True)
        return 12

    if head != b"%PDF-":
        print(f"selftest FAILED: output is not a PDF (starts {head!r})", flush=True)
        return 13
    print(f"selftest: plate PDF OK ({size} bytes)", flush=True)

    rc = _selftest_split_guard()
    if rc:
        return rc
    return _selftest_source_state()


class _FakeReader:
    """A Bio-Formats reader as `reader.declared_z_length` sees one.

    That function only asks for the series metadata table and calls `.get` on it,
    so a dict stands in exactly — which is what lets the split-chunk rule be
    tested with no JVM, no Bio-Formats and no 4 GiB of real acquisition.
    """

    def __init__(self, table: dict | None, size_z: int = 0,
                 used_files: list[str] | None = None):
        self._table = table
        self._size_z = size_z
        self._used_files = used_files or []

    def getSeriesMetadata(self):
        return self._table

    def getSizeZ(self):
        return self._size_z

    def getUsedFiles(self):
        return self._used_files


def _z_axis(declared: int, *, at: int = 3) -> dict:
    """A metadata table declaring a ZSTACK of `declared`, plus unrelated axes.

    The decoys matter: the real table numbers its axes arbitrarily and mixes in
    XY and LAMBDA entries, so a rule that just read `#1` would pass this test and
    fail on the file it was written for.
    """
    return {
        "axis axis #1": "XY", "axis maxSize #1": "2911",
        "axis axis #2": "LAMBDA", "axis maxSize #2": "3",
        f"axis axis #{at}": "ZSTACK", f"axis maxSize #{at}": str(declared),
    }


def _selftest_split_guard() -> int:
    """Prove an incomplete split .oir stops the export instead of entering the PDF.

    The failure this guards against is silent by construction — the well reads
    without error and only its Z range is wrong — so the check is worth having
    proven on every build rather than the day it next happens.
    """
    import tempfile

    try:
        class _FakeFormatTools:
            INT8, UINT8, INT16, UINT16 = 0, 1, 2, 3
            INT32, UINT32, FLOAT, DOUBLE = 4, 5, 6, 7

        if (_plate_source_dtype(_FakeFormatTools.UINT8, _FakeFormatTools, True,
                                "u8.oir") != np.dtype("u1")
                or _plate_source_dtype(_FakeFormatTools.INT16, _FakeFormatTools,
                                       False, "i16.oir") != np.dtype(">i2")):
            raise AssertionError("supported plate pixel types changed representation")
        for unsafe in (_FakeFormatTools.INT8, _FakeFormatTools.INT32,
                       _FakeFormatTools.UINT32, _FakeFormatTools.FLOAT,
                       _FakeFormatTools.DOUBLE):
            try:
                _plate_source_dtype(unsafe, _FakeFormatTools, True, "unsafe.oir")
            except ValueError:
                pass
            else:
                raise AssertionError(f"unsafe plate pixel type {unsafe} was accepted")

        consistent_stage = {"B02": (0.0, 0.0), "B03": (100.0, 0.0)}
        _require_stage_label_match("B02", 1, 1, consistent_stage, 100.0, 100.0)
        _require_stage_label_match("B03", 1, 2, consistent_stage, 100.0, 100.0)
        transposed_stage = {"B02": (100.0, 0.0), "B03": (0.0, 0.0)}
        try:
            _require_stage_label_match("B02", 1, 1, transposed_stage, 100.0, 100.0)
        except ValueError as e:
            message = str(e)
        else:
            raise AssertionError("a stage position with the wrong well label was accepted")
        if "B02" not in message or "B03" not in message or "開けません" not in message:
            raise AssertionError(f"stage mismatch message was incomplete: {message!r}")

        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            partial = d / "Stitch_B02_G001.oir"
            partial.write_bytes(b"")
            # Two continuation chunks present, and one decoy that has a suffix and
            # so is not one — the same distinction `scan` draws.
            (d / "Stitch_B02_G001_00001").write_bytes(b"")
            (d / "Stitch_B02_G001_00002").write_bytes(b"")
            (d / "Stitch_B02_G001_notes.txt").write_bytes(b"")
            lone = d / "Stitch_C03_G001.oir"
            lone.write_bytes(b"")

            if count_chunks(partial) != 2:
                print(f"selftest FAILED: chunk count {count_chunks(partial)} != 2", flush=True)
                return 14
            if count_chunks(lone) != 0:
                print("selftest FAILED: counted chunks for a file that has none", flush=True)
                return 14

            # Complete: the reader exposes everything the metadata declares.
            require_complete_split(_FakeReader(_z_axis(50)), lone, 50)
            # A file whose metadata names no Z axis is not evidence of a problem.
            require_complete_split(_FakeReader({}), lone, 13)
            require_complete_split(_FakeReader(None), lone, 13)

            # Truncated, nothing else copied: the case reader.py already reports.
            try:
                require_complete_split(_FakeReader(_z_axis(50)), lone, 13)
            except ValueError as e:
                msg = str(e)
            else:
                print("selftest FAILED: a truncated well was accepted", flush=True)
                return 14
            if "C03" not in msg or "13/50" not in msg:
                print(f"selftest FAILED: message names neither well nor Z: {msg!r}", flush=True)
                return 14

            # Partly copied: chunks on disk, Z still short. reader.py stops at
            # "_00001 exists" and stays quiet here; the export must not.
            try:
                require_complete_split(_FakeReader(_z_axis(50, at=7)), partial, 13)
            except ValueError as e:
                msg = str(e)
            else:
                print("selftest FAILED: a partly-copied well was accepted", flush=True)
                return 14
            # "2" alone would pass on "B02" or "_00002"; the count must be stated.
            if "B02" not in msg or "続きのファイル 2 個" not in msg:
                print(f"selftest FAILED: message omits well or chunk count: {msg!r}", flush=True)
                return 14

            # The ordinary reader must warn even when the first continuation is
            # present. A partial copy with `_00001` but no later chunks was once
            # mistaken for a complete stack and could then be projected.
            from reader import _detect_incomplete_oir
            warning = _detect_incomplete_oir(
                _FakeReader(_z_axis(50), size_z=13,
                            used_files=[str(partial), str(d / "Stitch_B02_G001_00001")]),
                str(partial),
            )
            if "13/50" not in warning:
                print("selftest FAILED: partial split OIR with one chunk was not warned", flush=True)
                return 14
    except Exception as e:
        print(f"selftest FAILED: split guard -> {type(e).__name__}: {e}", flush=True)
        return 14

    print("selftest: split-chunk guard OK (truncated wells fail the export)", flush=True)
    return 0


def _selftest_source_state() -> int:
    """Prove logical-source tokens distinguish acquisitions and freeze chunks."""
    import os
    import sys
    import tempfile
    import unicodedata

    try:
        with tempfile.TemporaryDirectory() as tmp:
            left_dir, right_dir = Path(tmp, "left"), Path(tmp, "right")
            left_dir.mkdir()
            right_dir.mkdir()
            left = left_dir / "Stitch_B02_G001.oir"
            right = right_dir / "Stitch_B02_G001.oir"
            left.write_bytes(b"main")
            os.link(left, right)
            chunk = left_dir / "Stitch_B02_G001_00001"
            chunk.write_bytes(b"chunk-a")

            first = snapshot_source(left)
            alias = snapshot_source(right)
            if first.identity == alias.identity:
                raise AssertionError("hardlink in another acquisition shared source identity")

            chunk.write_bytes(b"chunk-b")
            changed_chunk = snapshot_source(left)
            if (changed_chunk.identity != first.identity
                    or changed_chunk.revision == first.revision):
                raise AssertionError("split chunk change did not change only the revision")

            extra = left_dir / "Stitch_B02_G001_00002"
            extra.write_bytes(b"more")
            added_chunk = snapshot_source(left)
            if added_chunk.revision == changed_chunk.revision or added_chunk.members != 3:
                raise AssertionError("added split chunk was absent from the revision")

            bracket = left_dir / "sample[1].oir"
            bracket.write_bytes(b"main")
            bracket_chunk = left_dir / "sample[1]_00001"
            bracket_chunk.write_bytes(b"part-a")
            bracket_before = snapshot_source(bracket)
            bracket_chunk.write_bytes(b"part-b")
            bracket_after = snapshot_source(bracket)
            if (bracket_before.members != 2
                    or bracket_before.revision == bracket_after.revision):
                raise AssertionError("bracketed OIR stem lost its continuation chunk")

            if sys.platform == "darwin":
                composed = left_dir / "caf\u00e9.oir"
                composed.write_bytes(b"main")
                composed_chunk = left_dir / "caf\u00e9_00001"
                composed_chunk.write_bytes(b"part-a")
                decomposed = Path(unicodedata.normalize("NFD", str(composed)))
                unicode_before = snapshot_source(decomposed)
                composed_chunk.write_bytes(b"part-b")
                unicode_after = snapshot_source(decomposed)
                if (unicode_before.members != 2
                        or unicode_before.revision == unicode_after.revision):
                    raise AssertionError("Unicode alias lost its continuation chunk")

                mixed = left_dir / "MixedCase.oir"
                mixed.write_bytes(b"main")
                mixed_chunk = left_dir / "MixedCase_00001"
                mixed_chunk.write_bytes(b"part-a")
                case_before = snapshot_source(left_dir / "mixedcase.oir")
                mixed_chunk.write_bytes(b"part-b")
                case_after = snapshot_source(left_dir / "mixedcase.oir")
                if (case_before.members != 2
                        or case_before.identity != case_after.identity
                        or case_before.revision == case_after.revision):
                    raise AssertionError("macOS case alias lost its continuation chunk")

            if os.name == "nt":
                mixed = left_dir / "MixedCase.oir"
                mixed.write_bytes(b"main")
                mixed_chunk = left_dir / "MixedCase_00001"
                mixed_chunk.write_bytes(b"part-a")
                case_before = snapshot_source(left_dir / "mixedcase.oir")
                mixed_chunk.write_bytes(b"part-b")
                case_after = snapshot_source(left_dir / "mixedcase.oir")
                if (case_before.members != 2
                        or case_before.revision == case_after.revision):
                    raise AssertionError("Windows path case lost its continuation chunk")

            replacement = left_dir / "replacement.oir"
            replacement.write_bytes(b"main")
            os.replace(replacement, left)
            replaced = snapshot_source(left)
            if replaced.identity == added_chunk.identity:
                raise AssertionError("atomic source replacement kept the old identity")
    except Exception as e:
        print(f"selftest FAILED: source state -> {type(e).__name__}: {e}", flush=True)
        return 15

    print("selftest: source state OK (path, inode and split chunks frozen)", flush=True)
    return 0
