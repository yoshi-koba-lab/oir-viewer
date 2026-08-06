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
                    "stitch_path": w.stitch_path, "stitch_bytes": w.stitch_bytes,
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


def _derive_stitch(tile_name: str) -> str | None:
    """`<prefix>_B02_G001_0001.oir` -> `Stitch_B02_G001.oir`."""
    m = re.fullmatch(r".+_(?P<well>[A-Za-z]\d{1,2})_(?P<grp>G\d+)_\d+\.oir", tile_name)
    return f"Stitch_{m['well']}_{m['grp']}.oir" if m else None


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
        if not ai or "wellId" not in d:
            continue
        a = _leaf_children(ai[0])
        try:
            stage[d["wellId"]] = (float(a["areaLeft"]), float(a["areaTop"]))
        except (KeyError, ValueError):
            pass

    wells: list[Well] = []
    for g in groups:
        d = _leaf_children(g)
        wid = d.get("wellId", "").strip()
        rc = _well_id_to_rc(wid)
        if rc is None:
            warnings.append(f"ウェル名を解釈できません: {wid!r}（このウェルは除外します）")
            continue
        row, col = rc
        if not (0 <= row < rows and 0 <= col < cols):
            warnings.append(f"{wid} はプレート（{rows}行×{cols}列）の外を指しています")

        areas = [a for a in g if _tag(a) == "area"]
        ai = [c for c in g if _tag(c) == "areaInfo"]
        a = _leaf_children(ai[0]) if ai else {}
        grid = f"{a.get('numOfXAreas', '?')}x{a.get('numOfYAreas', '?')}"

        tile_names = [_leaf_children(x).get("image", "") for x in areas]
        stitch_name = next((s for s in (_derive_stitch(t) for t in tile_names) if s), None)
        stitch = folder / stitch_name if stitch_name else None
        exists = bool(stitch and stitch.is_file())
        chunks = 0
        if exists and stitch is not None:
            stem = stitch.name[: -len(".oir")]
            chunks = len([p for p in folder.glob(f"{stem}_*") if p.suffix == ""])

        # Compare the label against the stage grid.
        warn = ""
        if pitch_x and pitch_y and wid in stage and len(stage) >= 2:
            xs = [v[0] for v in stage.values()]
            ys = [v[1] for v in stage.values()]
            ref_col = min(_well_id_to_rc(k)[1] for k in stage if _well_id_to_rc(k))
            ref_row = min(_well_id_to_rc(k)[0] for k in stage if _well_id_to_rc(k))
            c_stage = ref_col + round((stage[wid][0] - min(xs)) / pitch_x)
            r_stage = ref_row + round((stage[wid][1] - min(ys)) / pitch_y)
            if (r_stage, c_stage) != (row, col):
                warn = (f"ラベル {wid} は行{row}列{col}ですが、"
                        f"ステージ座標では行{r_stage}列{c_stage}です")

        wells.append(Well(
            well_id=wid, row=row, col=col,
            enabled=(d.get("enable", "true").lower() != "false"),
            tiles=len(areas), tile_grid=grid,
            stitch_path=str(stitch) if exists else None,
            stitch_bytes=(stitch.stat().st_size if exists and stitch else 0),
            chunk_count=chunks, position_warning=warn,
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


@dataclass
class VolumeSpec:
    """What to read, and the contrast to bake in. Nothing here is inferred."""
    path: str
    channels: list[int]
    #: Per entry in `channels`, the display window to apply. Never computed here:
    #: plate export must not auto-stretch, so the caller passes what the user set.
    levels: list[tuple[float, float]]
    t: int = 0
    #: Max XY of the returned volume; 0 for the source resolution unchanged.
    max_xy: int = PLATE_MAX_XY


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
            reader_j.setId(str(p))
            n_c, n_z = reader_j.getSizeC(), reader_j.getSizeZ()
            h, w = reader_j.getSizeY(), reader_j.getSizeX()
            # The pixel type comes from the file, as reader.py already does it.
            # Hardcoding 16-bit here reinterpreted an 8-bit well's bytes in pairs:
            # half the width, and values that are two unrelated pixels glued
            # together. It renders as noise rather than failing.
            little = reader_j.isLittleEndian()
            FormatTools = scyjava.jimport("loci.formats.FormatTools")
            pt = reader_j.getPixelType()
            end = "<" if little else ">"
            if pt == FormatTools.UINT8:
                dtype = np.dtype("u1")
            elif pt == FormatTools.INT8:
                dtype = np.dtype("i1")
            elif pt == FormatTools.UINT16:
                dtype = np.dtype(end + "u2")
            elif pt == FormatTools.INT16:
                dtype = np.dtype(end + "i2")
            elif pt == FormatTools.UINT32:
                dtype = np.dtype(end + "u4")
            elif pt == FormatTools.INT32:
                dtype = np.dtype(end + "i4")
            elif pt == FormatTools.FLOAT:
                dtype = np.dtype(end + "f4")
            elif pt == FormatTools.DOUBLE:
                dtype = np.dtype(end + "f8")
            else:
                raise ValueError(f"未対応の画素型です (pixelType={pt})")

            want = [c for c in spec.channels if 0 <= c < n_c][:PLATE_MAX_CH]
            if not want:
                raise ValueError("読み込むチャンネルがありません")
            if len(spec.levels) < len(want):
                raise ValueError("チャンネル数と Min/Max の数が一致しません")

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
            def _phys(get) -> float:
                try:
                    v = get(0)
                    return float(v.value().doubleValue()) if v is not None else 0.0
                except Exception:
                    return 0.0

            info = {
                "channels": want, "out": [out_z, out_h, out_w], "max_xy": cap,
                "source": [n_c, n_z, h, w], "bytes": len(header) + len(meta) + sum(map(len, planes)),
                # µm per voxel. 0 means the file did not say, and the renderer
                # then treats the volume as isotropic — the same fallback the
                # interactive view uses.
                "voxel": [_phys(ome.getPixelsPhysicalSizeX),
                          _phys(ome.getPixelsPhysicalSizeY),
                          _phys(ome.getPixelsPhysicalSizeZ)],
            }
            return info, header + meta + b"".join(planes)
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
    "Hiragino Sans GB.ttc", "Arial Unicode.ttf",              # macOS
    "meiryo.ttc", "YuGothM.ttc", "YuGothR.ttc", "msgothic.ttc",  # Windows
    "NotoSansCJK-Regular.ttc", "NotoSansJP-Regular.otf",      # Linux
    "Helvetica.ttc", "Arial.ttf", "DejaVuSans.ttf",           # Latin-only
)


def _covers_japanese(font) -> bool:
    """Whether a font has real Japanese glyphs, not .notdef boxes.

    A missing glyph still renders — as a box, with its own bounding box — so
    asking whether the glyph "exists" the obvious ways all answer yes. The only
    honest test is to draw it and compare against a codepoint no font defines.
    """
    from PIL import Image, ImageDraw

    def bits(ch: str) -> bytes:
        im = Image.new("L", (40, 40), 0)
        ImageDraw.Draw(im).text((2, 2), ch, fill=255, font=font)
        return im.tobytes()

    try:
        return bits("状") != bits("￾")
    except Exception:
        return False


def resolve_font_name() -> tuple[str | None, bool]:
    """Pick the font file to draw with. Returns (name or None, covers_japanese)."""
    from PIL import ImageFont

    latin: str | None = None
    for name in _FONT_CANDIDATES:
        try:
            probe = ImageFont.truetype(name, 24)
        except OSError:
            continue
        if _covers_japanese(probe):
            return name, True
        if latin is None:
            latin = name
    return latin, False


@dataclass
class WellFrame:
    """One rendered well, ready to place."""
    well_id: str
    row: int
    col: int
    #: RGB or RGBA pixels, any size; resized into the cell preserving aspect.
    png: bytes


def compose_pdf(
    out_path: Path,
    plate_name: str,
    rows: int,
    cols: int,
    frames: list[WellFrame],
    well_states: dict[str, str],
    cell_px: int,
    footer: str,
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
    from PIL import Image, ImageDraw, ImageFont

    pad = max(2, int(cell_px * _PAD_F))
    label_h = max(10, int(cell_px * _LABEL_F))
    title_h = max(16, int(cell_px * _TITLE_F))
    margin = max(8, int(cell_px * _MARGIN_F))
    gutter = label_h * 2

    page_w = margin * 2 + gutter + cols * (cell_px + pad)
    page_h = margin * 2 + title_h + label_h + rows * (cell_px + pad)
    page = Image.new("RGB", (page_w, page_h), "white")
    draw = ImageDraw.Draw(page)

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

    draw.text((margin, margin), f"{plate_name}  —  {rows}x{cols}", fill="black", font=f_title)

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
                draw.text((x + pad, y + pad), f.well_id, fill="white", font=f_cell)
            else:
                draw.rectangle(box, outline="#c8c8c8", width=1)
                state = EMPTY_CELL_LABELS.get(well_states.get(wid, ""), "Not acquired")
                draw.text((x + cell_px // 2, y + cell_px // 2 - label_h), wid,
                          fill="#909090", font=f_cell, anchor="mm")
                draw.text((x + cell_px // 2, y + cell_px // 2 + label_h), state,
                          fill="#b0b0b0", font=f_cell, anchor="mm")

    draw.text((margin, page_h - margin // 2), footer, fill="#808080", font=f_cell, anchor="ls")

    # Never overwrite an earlier figure.
    final = out_path
    n = 1
    while final.exists():
        final = out_path.with_name(f"{out_path.stem}_{n:02d}{out_path.suffix}")
        n += 1
    page.save(final, "PDF", resolution=300.0)
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
        name, ja = resolve_font_name()
        print(f"selftest: font {name or 'PIL default'}"
              f" (日本語 {'OK' if ja else 'NG — 日本語のプレート名は豆腐になります'})", flush=True)
    except Exception as e:
        print(f"selftest: font probe failed -> {type(e).__name__}: {e}", flush=True)

    # A frame in a cell and an empty cell, so both branches of the layout run.
    # The plate name is Japanese on purpose: it is the path that broke.
    frames = [WellFrame(well_id="B02", row=1, col=1, png=png)]
    try:
        with tempfile.TemporaryDirectory() as tmp:
            out = compose_pdf(
                Path(tmp) / "selftest.pdf", "セルフテスト", 2, 2, frames,
                {"B03": "disabled"}, PDF_CELL_CHOICES["draft"], "selftest",
            )
            head, size = out.read_bytes()[:5], out.stat().st_size
    except Exception as e:
        print(f"selftest FAILED: compose_pdf -> {type(e).__name__}: {e}", flush=True)
        return 12

    if head != b"%PDF-":
        print(f"selftest FAILED: output is not a PDF (starts {head!r})", flush=True)
        return 13
    print(f"selftest: plate PDF OK ({size} bytes)", flush=True)
    return 0
