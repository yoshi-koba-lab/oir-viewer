"""OIR file reader with dummy data fallback."""

from __future__ import annotations

import os
import re
import sys
import threading

import numpy as np
from pathlib import Path
from dataclasses import dataclass, field


@dataclass
class ImageMetadata:
    filename: str = ""
    source_path: str = ""  # full path to original file
    num_channels: int = 0
    num_z: int = 0
    num_t: int = 0
    width: int = 0
    height: int = 0
    pixel_size_x: float = 0.0  # µm
    pixel_size_y: float = 0.0
    pixel_size_z: float = 0.0
    channel_names: list[str] = field(default_factory=list)
    channel_types: list[str] = field(default_factory=list)  # "fluorescence" or "transmitted"
    channel_colors: list[list[int]] = field(default_factory=list)  # [[R,G,B], ...] from file metadata
    # Display range recorded by the acquisition software, per channel, already
    # scaled to this image's pixel values: [[min, max], ...]. Empty when the file
    # carries none, in which case the viewer falls back to auto-contrast.
    channel_ranges: list[list[float]] = field(default_factory=list)
    bit_depth: int = 16
    # Non-fatal problem found while opening (e.g. a split .oir missing its
    # companion chunks). Empty when the file loaded cleanly.
    warning: str = ""

    def to_dict(self) -> dict:
        return {
            "filename": self.filename,
            "source_path": self.source_path,
            "num_channels": self.num_channels,
            "num_z": self.num_z,
            "num_t": self.num_t,
            "width": self.width,
            "height": self.height,
            "pixel_size_x": self.pixel_size_x,
            "pixel_size_y": self.pixel_size_y,
            "pixel_size_z": self.pixel_size_z,
            "channel_names": self.channel_names,
            "channel_types": self.channel_types,
            "channel_colors": self.channel_colors,
            "channel_ranges": self.channel_ranges,
            "bit_depth": self.bit_depth,
            "warning": self.warning,
        }


def _runtime_dir() -> Path | None:
    """Locate the bundled Java runtime shipped with a packaged build.

    Layout (see scripts/stage_runtime.py):
        runtime/jre/...      a platform JRE
        runtime/jars/*.jar   Bio-Formats and its dependencies

    Searched next to the frozen executable first (PyInstaller unpacks to
    sys._MEIPASS), then beside this source tree so a staged runtime can be
    exercised in development.
    """
    candidates: list[Path] = []
    env = os.environ.get("OIR_RUNTIME_DIR")
    if env:
        candidates.append(Path(env))
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(Path(meipass) / "runtime")
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).parent / "runtime")
    here = Path(__file__).resolve().parent
    candidates += [here / "runtime", here.parent / "runtime"]

    for c in candidates:
        if (c / "jars").is_dir() and (c / "jre").is_dir():
            return c
    return None


def _jre_home(jre_root: Path) -> Path:
    """macOS JREs nest the real home under Contents/Home."""
    inner = jre_root / "Contents" / "Home"
    return inner if inner.is_dir() else jre_root


def _libjvm(jre_home: Path) -> Path | None:
    for pattern in ("lib/server/libjvm.dylib", "lib/server/libjvm.so",
                    "bin/server/jvm.dll", "lib/server/jvm.dll"):
        p = jre_home / pattern
        if p.is_file():
            return p
    found = list(jre_home.rglob("libjvm.*")) + list(jre_home.rglob("jvm.dll"))
    return found[0] if found else None


def _prepare_windows_dll_search(jre_home: Path) -> None:
    """Let Windows resolve jvm.dll's own dependencies.

    JPype loads the JVM with a plain LoadLibraryW on the full path (see
    native/common/jp_platform.cpp), and that does NOT put the library's own
    directory on the search path for the DLLs it in turn imports. jvm.dll needs
    msvcp140.dll, vcruntime140.dll and vcruntime140_1.dll, which Zulu ships in
    <jre>/bin — so on a machine without the Visual C++ redistributable in
    System32 the load fails with error 126, "the specified module could not be
    found", naming jvm.dll rather than the DLL that was actually missing.

    macOS and Linux resolve a dylib/so's dependencies relative to the library
    itself, which is why this only ever bites the Windows build.
    """
    if sys.platform != "win32":
        return
    for d in (jre_home / "bin", jre_home / "bin" / "server"):
        if not d.is_dir():
            continue
        try:
            os.add_dll_directory(str(d))
        except (AttributeError, OSError):
            pass
        # Belt and braces: the JVM also spawns helpers that read PATH.
        os.environ["PATH"] = f"{d}{os.pathsep}{os.environ.get('PATH', '')}"


def prewarm_jvm() -> None:
    """Start the JVM ahead of the first file, and log the outcome either way.

    Two reasons. A JVM that will not start is otherwise invisible until someone
    opens a file, and then it surfaces as "this file will not open" — the wrong
    diagnosis entirely. And the cold start costs several seconds, which the user
    would otherwise pay while staring at their first image not appearing.

    Never raises: this runs on a background thread at startup, where a failure
    must not stop the server. The open path starts the JVM itself if this did
    not manage it, and reports properly from there.
    """
    try:
        import scyjava
        _start_jvm(scyjava)
    except Exception as e:
        print(f"JVM prewarm failed ({type(e).__name__}): {e}", flush=True)


def describe_runtime() -> str:
    """One line naming the Java runtime this process will use, for the log."""
    runtime = _runtime_dir()
    if not runtime:
        return "no bundled runtime found (development fallback: Maven/cjdk)"
    jre = _jre_home(runtime / "jre")
    libjvm = _libjvm(jre)
    jars = list((runtime / "jars").glob("*.jar"))
    return (f"{runtime} | jvm={libjvm or 'MISSING'} | {len(jars)} jars"
            f" | formats-gpl={'yes' if any(j.name.startswith('formats-gpl') for j in jars) else 'NO'}")


#: JVM heap ceiling, MB.
#:
#: Generous on purpose. Left with no ceiling the JVM sizes its maximum from
#: physical RAM and grows into it rather than collecting, so resident memory
#: tracked the size of the file being read — untidy, and alarming to watch. But
#: the target machine has 192 GB, so this exists only to stop that drift, not to
#: ration anything: Bio-Formats needs a plane or two, a plane here is 17 MB, and
#: this must never be the reason a file fails to open. Override with
#: OIR_JVM_MAX_HEAP if one ever does.
try:
    _JVM_MAX_HEAP_MB = max(256, int(os.environ.get("OIR_JVM_MAX_HEAP", "4096")))
except ValueError:
    _JVM_MAX_HEAP_MB = 4096

_JVM_LOCK = threading.Lock()


def _start_jvm(scyjava) -> None:
    """Start the JVM for Bio-Formats, offline when a bundled runtime is present.

    A packaged build must not reach for Maven or download a JDK on first use, so
    the bundled JRE and jars are handed straight to JPype. scyjava then sees a
    running JVM and its jimport works unchanged. Without a bundle (development)
    it falls back to scyjava's own Maven-backed startup.

    Serialised: FastAPI runs the sync open endpoint on a thread pool, so two
    files opened at once both saw a stopped JVM and both called startJVM. The
    loser got `OSError: JVM is already started` and its file failed for a reason
    that had nothing to do with the file.
    """
    with _JVM_LOCK:
        _start_jvm_locked(scyjava)


def _start_jvm_locked(scyjava) -> None:
    if scyjava.jvm_started():
        return

    runtime = _runtime_dir()
    if runtime:
        import jpype
        jre = _jre_home(runtime / "jre")
        jars = sorted(str(p) for p in (runtime / "jars").glob("*.jar"))
        libjvm = _libjvm(jre)
        if jars and libjvm:
            os.environ.setdefault("JAVA_HOME", str(jre))
            _prepare_windows_dll_search(jre)
            try:
                # See _JVM_MAX_HEAP_MB: a ceiling to stop the heap drifting up
                # with file size, set high enough that it is never the limit.
                jpype.startJVM(str(libjvm), f"-Xmx{_JVM_MAX_HEAP_MB}m",
                               classpath=jars, convertStrings=False)
            except Exception as e:
                # Without this the caller reports a bare OSError with a Windows
                # error number, which says nothing about Java being the problem.
                raise RuntimeError(
                    "Java（Bio-Formats）を起動できませんでした。\n"
                    f"{type(e).__name__}: {e}\n"
                    f"JVM: {libjvm}"
                ) from e
            print(f"JVM started from bundled runtime ({len(jars)} jars)", flush=True)
            return
        missing = "jvm library" if not libjvm else "jars"
        print(f"Bundled runtime at {runtime} is incomplete ({missing} missing)", flush=True)
        if getattr(sys, "frozen", False):
            # In a packaged build there is nothing to fall back TO: the Maven
            # path below needs a network and a JDK the user was promised they
            # would not need. Say so instead of failing later with a download
            # error that looks like a connectivity problem.
            raise RuntimeError(
                f"同梱の Java ランタイムが不完全です（{missing} が見つかりません）。\n"
                f"場所: {runtime}\n"
                "アプリを再インストールしてください。"
            )

    scyjava.config.endpoints.append("ome:formats-gpl:8.0.1")
    scyjava.start_jvm()


def _to_uint16(data: np.ndarray) -> np.ndarray:
    """Convert any pixel array to uint16 without silently wrapping or truncating.

    A bare astype(uint16) wraps negatives (int16) and truncates floats, which
    corrupts the pixel values the whole viewer then displays and measures.
    """
    if data.dtype == np.uint16:
        return data

    if np.issubdtype(data.dtype, np.floating):
        arr = np.asarray(data, dtype=np.float32)
        arr = np.where(np.isfinite(arr), arr, 0.0)
        lo = float(arr.min()) if arr.size else 0.0
        hi = float(arr.max()) if arr.size else 0.0
        if 0.0 <= lo and hi <= 1.0:
            arr = arr * 65535.0  # normalised [0,1] float image
        elif lo < 0.0 or hi > 65535.0:
            # Out of uint16 range: rescale the real data range instead of clipping
            # everything interesting away.
            span = hi - lo
            arr = (arr - lo) * (65535.0 / span) if span > 0 else np.zeros_like(arr)
        return np.clip(np.rint(arr), 0, 65535).astype(np.uint16)

    if np.issubdtype(data.dtype, np.integer):
        info = np.iinfo(data.dtype)
        if info.min >= 0 and info.max <= 65535:
            return data.astype(np.uint16)  # uint8 etc: exact
        return np.clip(data.astype(np.int64), 0, 65535).astype(np.uint16)

    return np.clip(np.rint(np.asarray(data, dtype=np.float64)), 0, 65535).astype(np.uint16)


# tifffile axis letters → position in (T, C, Z, Y, X). 'S' (samples, i.e. RGB-like
# planes) counts as channels; 'I'/'Q' (generic page sequence) as Z, which matches
# the historical ndim guess for plain multi-page TIFFs.
_AXIS_SLOT = {"T": 0, "C": 1, "S": 1, "Z": 2, "I": 2, "Q": 2, "Y": 3, "X": 4}


def _axes_to_5d(data: np.ndarray, axes: str) -> np.ndarray | None:
    """Reorder an array described by a tifffile axes string into (T, C, Z, Y, X).

    Returns None when the axes string cannot be mapped unambiguously so the
    caller can fall back to its ndim heuristics.
    """
    if len(axes) != data.ndim or "Y" not in axes or "X" not in axes:
        return None
    slots: dict[int, int] = {}
    for pos, letter in enumerate(axes):
        slot = _AXIS_SLOT.get(letter)
        if slot is None or slot in slots:
            return None
        slots[slot] = pos
    arr = data.transpose([slots[s] for s in sorted(slots)])
    for slot in range(5):
        if slot not in slots:
            arr = np.expand_dims(arr, slot)
    return arr


class ImageReader:
    """Reads OIR files via bioio, or generates dummy data for development."""

    def __init__(self):
        self.data: np.ndarray | None = None  # shape: (T, C, Z, Y, X)
        self.metadata = ImageMetadata()
        # Serialises loading and unloading. FastAPI runs sync endpoints on a
        # thread pool, and the Compare view requests several images by id
        # without activating them first — so two requests racing into the same
        # deferred reader both saw data=None and both read the whole file.
        # Measured: 4 concurrent accesses, 4 full loads, which on real data is
        # 4 x 4.25 GB of transient memory for one image. RLock, because
        # ensure_loaded runs inside the accessors' snapshot section.
        self._pixels_lock = threading.RLock()
        #: Set when this reader stands for a file whose pixels have not been read.
        #: A restored session registers one of these per remembered file, so
        #: startup costs nothing regardless of how much was open last time.
        self.deferred_path: str | None = None

    @property
    def loaded_bytes(self) -> int:
        """Resident pixel bytes, for the budget that decides what to evict."""
        d = self.data          # snapshot: unload() can null the field mid-read
        return int(d.nbytes) if d is not None else 0

    def defer(self, path: str, metadata: ImageMetadata) -> None:
        """Stand for a file without reading it. Pixels arrive on first use."""
        self.data = None
        self.deferred_path = path
        self.metadata = metadata

    def unload(self) -> int:
        """Drop the pixels, keeping the file re-openable. Returns bytes freed.

        Only meaningful for a reader that knows where its file is — dummy data
        and uploads that have since been deleted cannot be read back, so those
        keep their pixels rather than becoming permanently empty tabs.
        """
        with self._pixels_lock:
            if self.data is None:
                return 0
            path = self.deferred_path or self.metadata.source_path
            if not path or not os.path.exists(path):
                return 0
            freed = self.loaded_bytes
            self.deferred_path = path
            self.data = None
            return freed

    def ensure_loaded(self) -> None:
        """Read the pixels if this reader is only standing for a file so far.

        `deferred_path` survives a failure on purpose. It used to be cleared
        before the load, so one unsuccessful attempt turned the tab into a
        permanent "No image loaded" — with the real reason shown once and never
        again. That is the wrong trade when the data lives on an external drive:
        a disk that had spun down, or a moment's disconnect, bricked the tab
        until the app was restarted. Every attempt now either loads it or reports
        why, and the next attempt can still succeed.
        """
        with self._pixels_lock:
            if self.data is not None:
                return
            path = self.deferred_path
            if not path:
                raise RuntimeError("No image loaded")
            self.load_file(path)
            # Only on success: from here the pixels are the source of truth.
            self.deferred_path = None

    def _pixels(self) -> np.ndarray:
        """The pixel array, loaded if need be — as a snapshot.

        Callers hold the returned array, not self.data: an eviction that runs
        after this returns only drops the reader's reference, and numpy keeps
        the memory alive for the caller until it is done. Taken under the lock
        so eviction cannot interleave between the load and the snapshot.
        """
        with self._pixels_lock:
            self.ensure_loaded()
            assert self.data is not None
            return self.data

    def load_file(self, path: str) -> ImageMetadata:
        """Load an image file. Dispatches by extension."""
        p = Path(path)
        ext = p.suffix.lower()

        # A split .oir's continuation chunks (`<name>_00001`, no extension) hold
        # raw pixels with no header. Opened on their own they either fail oddly or
        # decode into a black, mis-dimensioned image — so say what they are.
        if not ext and re.fullmatch(r".+_\d{5}", p.name):
            base = re.sub(r"_\d{5}$", "", p.name)
            raise RuntimeError(
                f"{p.name} は分割保存された .oir の続きのデータで、単体では開けません。\n"
                f"同じフォルダの {base}.oir を開いてください（続きのファイルは自動的に読まれます）。"
            )
        if ext in (".oir", ".oib", ".oif", ".nd2", ".lif", ".czi"):
            return self._load_bioformats(path)
        elif ext in (".tif", ".tiff"):
            return self._load_tiff(path)
        else:
            # Try tifffile first, fall back to bioformats
            try:
                return self._load_tiff(path)
            except Exception:
                return self._load_bioformats(path)

    # Keep old name as alias
    def load_oir(self, path: str) -> ImageMetadata:
        return self.load_file(path)

    def _load_tiff(self, path: str) -> ImageMetadata:
        """Load TIFF/OME-TIFF using tifffile."""
        import tifffile

        try:
            with tifffile.TiffFile(path) as tif:
                data = tif.asarray()  # various shapes possible
                # Try to get OME metadata for pixel sizes
                px_x, px_y, px_z = 0.0, 0.0, 0.0
                channel_names: list[str] = []
                if tif.ome_metadata:
                    try:
                        import xml.etree.ElementTree as ET
                        root = ET.fromstring(tif.ome_metadata)
                        ns = root.tag.split("}")[0] + "}" if "}" in root.tag else ""
                        pixels = root.find(f".//{ns}Pixels")
                        if pixels is not None:
                            px_x = float(pixels.get("PhysicalSizeX", 0))
                            px_y = float(pixels.get("PhysicalSizeY", 0))
                            px_z = float(pixels.get("PhysicalSizeZ", 0))
                            for ch_el in pixels.findall(f"{ns}Channel"):
                                name = ch_el.get("Name", "")
                                if name:
                                    channel_names.append(name)
                    except Exception:
                        pass

                # Normalize to 5D: TCZYX
                data = self._normalize_5d(data, tif)

                # Contiguous: axis reordering leaves a view, and the raw-bytes
                # endpoints assume a plain C-ordered buffer.
                self.data = np.ascontiguousarray(_to_uint16(data))
                n_t, n_c, n_z, h, w = self.data.shape

                if not channel_names:
                    channel_names = [f"Ch{i}" for i in range(n_c)]

                channel_types = _detect_channel_types_by_name(channel_names[:n_c])
                self.metadata = ImageMetadata(
                    filename=Path(path).name,
                    source_path=str(Path(path).resolve()),
                    num_channels=n_c,
                    num_z=n_z,
                    num_t=n_t,
                    width=w,
                    height=h,
                    pixel_size_x=px_x,
                    pixel_size_y=px_y,
                    pixel_size_z=px_z,
                    channel_names=channel_names[:n_c],
                    channel_types=channel_types,
                    channel_colors=[],  # TIFF: no embedded colors
                    bit_depth=16,
                )
        except Exception as e:
            raise RuntimeError(f"Failed to load TIFF: {e}") from e
        return self.metadata

    def _normalize_5d(self, data: np.ndarray, tif) -> np.ndarray:
        """Reshape arbitrary TIFF data to (T, C, Z, Y, X)."""
        ndim = data.ndim

        # If tifffile provides series with axes info, use it. This covers TCZYX,
        # CZYX, ZYX, YX, CYX, ZCYX, TCYX, TZCYX, TZYX and RGB-like YXS/SYX.
        if tif.series and hasattr(tif.series[0], "axes"):
            mapped = _axes_to_5d(data, tif.series[0].axes.upper())
            if mapped is not None:
                return mapped

        # Fallback by ndim
        if ndim == 2:
            return data[np.newaxis, np.newaxis, np.newaxis]
        elif ndim == 3:
            # Assume ZYX or CYX — treat as ZYX
            return data[np.newaxis, np.newaxis]
        elif ndim == 4:
            # Assume CZYX
            return data[np.newaxis]
        elif ndim == 5:
            return data
        else:
            # 6D+ — just take first dims
            while data.ndim > 5:
                data = data[0]
            return data

    def _load_bioformats(self, path: str) -> ImageMetadata:
        """Load using scyjava + Bio-Formats Java directly (no bioio needed)."""
        ext = Path(path).suffix.lower()

        # Never translate this failure into advice. It used to say "scyjava is
        # needed, pip install scyjava jpype1" for ANY ImportError — and scyjava's
        # __init__ reads its own .dist-info, which PyInstaller does not collect,
        # so `import scyjava` raised PackageNotFoundError (an ImportError
        # subclass) in every packaged build. The real fault was missing metadata
        # for a package that was present, and the guess about a missing install
        # hid it for a whole release. Report the type and text, and in a frozen
        # build say what it actually is: a broken bundle, not the user's setup.
        try:
            import scyjava
        except Exception as e:
            detail = f"{type(e).__name__}: {e}"
            if getattr(sys, "frozen", False):
                raise RuntimeError(
                    f"{ext} の読み込みに必要な Java 連携（scyjava）を初期化できませんでした。\n"
                    f"{detail}\n"
                    "同梱物の不足です。この画面の文言とログを添えて報告してください。"
                ) from e
            raise RuntimeError(
                f"{ext} の読み込みには scyjava が必要です。\n"
                f"{detail}\n"
                "pip install -r backend/requirements.txt"
            ) from e

        _start_jvm(scyjava)

        try:
            ImageReader_j = scyjava.jimport("loci.formats.ImageReader")
            MetadataStore = scyjava.jimport("loci.formats.MetadataTools")
            OMEXMLServiceFactory = scyjava.jimport("loci.common.services.ServiceFactory")

            reader_j = ImageReader_j()
            meta = MetadataStore.createOMEXMLMetadata()
            reader_j.setMetadataStore(meta)
            reader_j.setId(str(path))

            n_c = reader_j.getSizeC()
            n_z = reader_j.getSizeZ()
            n_t = reader_j.getSizeT()
            h = reader_j.getSizeY()
            w = reader_j.getSizeX()
            bpp = reader_j.getBitsPerPixel()
            is_little = reader_j.isLittleEndian()
            pixel_type = reader_j.getPixelType()  # 0=int8,1=uint8,2=int16,3=uint16,...

            # Read pixel sizes from OME metadata
            px_x, px_y, px_z = 0.0, 0.0, 0.0
            channel_names: list[str] = []
            try:
                ps_x = meta.getPixelsPhysicalSizeX(0)
                if ps_x is not None:
                    px_x = ps_x.value().doubleValue()
                ps_y = meta.getPixelsPhysicalSizeY(0)
                if ps_y is not None:
                    px_y = ps_y.value().doubleValue()
                ps_z = meta.getPixelsPhysicalSizeZ(0)
                if ps_z is not None:
                    px_z = ps_z.value().doubleValue()
            except Exception:
                pass

            try:
                for c in range(n_c):
                    name = meta.getChannelName(0, c)
                    channel_names.append(str(name) if name else f"Ch{c}")
            except Exception:
                channel_names = [f"Ch{i}" for i in range(n_c)]

            # Detect channel types (fluorescence vs transmitted/DIC)
            channel_types = _detect_channel_types(meta, n_c, channel_names)

            # Read channel colors from OME metadata
            channel_colors = _read_channel_colors(meta, n_c)

            # Display range as set on the microscope at acquisition time
            channel_ranges = _read_channel_ranges(reader_j, n_c, channel_names, bpp)

            # Catch a split .oir opened without its companion chunk files
            warning = _detect_incomplete_oir(reader_j, str(path))
            if warning:
                print(f"WARNING {Path(path).name}: {warning}")

            # Determine numpy dtype
            FormatTools = scyjava.jimport("loci.formats.FormatTools")
            if pixel_type == FormatTools.UINT16:
                dtype = np.uint16
            elif pixel_type == FormatTools.UINT8:
                dtype = np.uint8
            elif pixel_type == FormatTools.INT16:
                dtype = np.int16
            elif pixel_type == FormatTools.FLOAT:
                dtype = np.float32
            else:
                dtype = np.uint16

            # Read all planes into 5D array
            data = np.zeros((n_t, n_c, n_z, h, w), dtype=dtype)
            for t in range(n_t):
                for c in range(n_c):
                    for z in range(n_z):
                        idx = reader_j.getIndex(z, c, t)
                        raw_bytes = reader_j.openBytes(idx)
                        plane = np.frombuffer(bytes(raw_bytes), dtype=dtype).reshape(h, w)
                        if not is_little and dtype != np.uint8:
                            plane = plane.byteswap()
                        data[t, c, z] = plane

            reader_j.close()

            self.data = _to_uint16(data)
            self.metadata = ImageMetadata(
                filename=Path(path).name,
                source_path=str(Path(path).resolve()),
                num_channels=n_c,
                num_z=n_z,
                num_t=n_t,
                width=w,
                height=h,
                pixel_size_x=px_x,
                pixel_size_y=px_y,
                pixel_size_z=px_z,
                channel_names=channel_names,
                channel_types=channel_types,
                channel_colors=channel_colors,
                channel_ranges=channel_ranges,
                bit_depth=bpp,
                warning=warning,
            )
        except RuntimeError:
            raise
        except Exception as e:
            raise RuntimeError(f"{ext} ファイルを開けませんでした: {e}") from e
        return self.metadata

    def load_dummy(self) -> ImageMetadata:
        """Generate synthetic 5D microscopy data for development."""
        n_t, n_c, n_z, h, w = 5, 4, 20, 512, 512
        rng = np.random.default_rng(42)
        data = np.zeros((n_t, n_c, n_z, h, w), dtype=np.uint16)

        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)

        # Ch0: DAPI-like nuclei (blue) - scattered gaussian spots
        for t in range(n_t):
            base = np.zeros((h, w), dtype=np.float32)
            n_spots = 30
            cx = rng.integers(50, w - 50, n_spots)
            cy = rng.integers(50, h - 50, n_spots)
            for i in range(n_spots):
                r2 = (xx - cx[i]) ** 2 + (yy - cy[i]) ** 2
                base += 40000 * np.exp(-r2 / (2 * 15**2))
            for z in range(n_z):
                z_factor = np.exp(-((z - n_z // 2) ** 2) / (2 * 4**2))
                noise = rng.integers(0, 500, (h, w), dtype=np.uint16)
                data[t, 0, z] = np.clip(base * z_factor + noise, 0, 65535).astype(
                    np.uint16
                )

        # Ch1: GFP-like structures (green) - filamentous pattern
        for t in range(n_t):
            phase = t * 0.3
            for z in range(n_z):
                z_factor = np.exp(-((z - n_z // 2 + 2) ** 2) / (2 * 5**2))
                pattern = np.sin(xx * 0.03 + phase) * np.cos(yy * 0.02 + phase * 0.5)
                pattern = ((pattern + 1) / 2 * 30000 * z_factor).astype(np.float32)
                noise = rng.integers(0, 300, (h, w), dtype=np.uint16)
                data[t, 1, z] = np.clip(pattern + noise, 0, 65535).astype(np.uint16)

        # Ch2: RFP-like (red/magenta) - mitochondria-like tubular network
        for t in range(n_t):
            base = np.zeros((h, w), dtype=np.float32)
            n_tubes = 15
            for _ in range(n_tubes):
                x0, y0 = rng.integers(0, w), rng.integers(0, h)
                angle = rng.uniform(0, np.pi)
                length = rng.integers(80, 200)
                for s in range(length):
                    px = int(x0 + s * np.cos(angle))
                    py = int(y0 + s * np.sin(angle))
                    if 0 <= px < w and 0 <= py < h:
                        r2 = (xx - px) ** 2 + (yy - py) ** 2
                        base += 800 * np.exp(-r2 / (2 * 3**2))
            base = np.clip(base, 0, 50000)
            for z in range(n_z):
                z_factor = np.exp(-((z - n_z // 2 - 1) ** 2) / (2 * 3**2))
                noise = rng.integers(0, 400, (h, w), dtype=np.uint16)
                data[t, 2, z] = np.clip(base * z_factor + noise, 0, 65535).astype(
                    np.uint16
                )

        # Ch3: Cy5-like (cyan) - membrane staining, ring-like
        for t in range(n_t):
            base = np.zeros((h, w), dtype=np.float32)
            n_cells = 20
            cx = rng.integers(40, w - 40, n_cells)
            cy = rng.integers(40, h - 40, n_cells)
            radii = rng.integers(15, 35, n_cells)
            for i in range(n_cells):
                dist = np.sqrt((xx - cx[i]) ** 2 + (yy - cy[i]) ** 2)
                ring = np.exp(-((dist - radii[i]) ** 2) / (2 * 2.5**2))
                base += ring * 25000
            for z in range(n_z):
                z_factor = np.exp(-((z - n_z // 2) ** 2) / (2 * 4**2))
                noise = rng.integers(0, 350, (h, w), dtype=np.uint16)
                data[t, 3, z] = np.clip(base * z_factor + noise, 0, 65535).astype(
                    np.uint16
                )

        self.data = data
        self.metadata = ImageMetadata(
            filename="dummy_data.oir",
            num_channels=n_c,
            num_z=n_z,
            num_t=n_t,
            width=w,
            height=h,
            pixel_size_x=0.124,
            pixel_size_y=0.124,
            pixel_size_z=0.5,
            channel_names=["DAPI", "GFP", "RFP", "Cy5"],
            channel_types=["fluorescence", "fluorescence", "fluorescence", "fluorescence"],
            channel_colors=[],  # dummy: no embedded colors
            bit_depth=16,
        )
        return self.metadata

    def get_slice(self, c: int, z: int, t: int) -> np.ndarray:
        """Get a single 2D slice. Returns uint16 array (H, W)."""
        data = self._pixels()
        # Clamp on both sides: a negative index would wrap and quietly return a
        # completely different slice.
        t = max(0, min(t, data.shape[0] - 1))
        c = max(0, min(c, data.shape[1] - 1))
        z = max(0, min(z, data.shape[2] - 1))
        return data[t, c, z]

    def get_mip(self, c: int, t: int) -> np.ndarray:
        """Maximum Intensity Projection along Z for a given channel and time."""
        data = self._pixels()
        t = max(0, min(t, data.shape[0] - 1))
        c = max(0, min(c, data.shape[1] - 1))
        return np.max(data[t, c], axis=0)

    def get_projection(self, c: int, t: int, z_from: int, z_to: int, method: str = "max") -> np.ndarray:
        """Z-projection over a specified range.

        Args:
            c: channel index
            t: time index
            z_from: start Z index (inclusive, 0-based)
            z_to: end Z index (inclusive, 0-based)
            method: "max", "min", or "avg"
        """
        data = self._pixels()
        t = max(0, min(t, data.shape[0] - 1))
        c = max(0, min(c, data.shape[1] - 1))
        z_from = max(0, min(z_from, data.shape[2] - 1))
        z_to = max(z_from, min(z_to, data.shape[2] - 1))
        stack = data[t, c, z_from:z_to + 1]  # (Z_range, Y, X)
        if method == "min":
            return np.min(stack, axis=0)
        elif method == "avg":
            # Round, not truncate — truncation biases every avg projection low.
            return np.rint(np.mean(stack, axis=0)).astype(data.dtype)
        else:  # "max"
            return np.max(stack, axis=0)

    def get_volume(self, t: int) -> np.ndarray:
        """Get full volume data (C, Z, Y, X) for a given time point."""
        data = self._pixels()
        t = max(0, min(t, data.shape[0] - 1))
        return data[t]


# Transmitted-light / DIC channel name patterns
_TRANSMITTED_PATTERNS = {"dic", "td", "bf", "brightfield", "bright field", "phase", "transmitted"}


def _is_transmitted_name(name: str) -> bool:
    """Check if a channel name suggests transmitted light (DIC, brightfield, etc.)."""
    lower = name.lower().strip()
    for pat in _TRANSMITTED_PATTERNS:
        if pat in lower:
            return True
    return False


def _detect_channel_types_by_name(channel_names: list[str]) -> list[str]:
    """Detect channel types from names only (used for TIFF files)."""
    return ["transmitted" if _is_transmitted_name(n) else "fluorescence" for n in channel_names]


def _detect_channel_types(meta, n_c: int, channel_names: list[str]) -> list[str]:
    """Detect channel types using OME metadata and name heuristics."""
    types: list[str] = []
    for c in range(n_c):
        ch_type = "fluorescence"
        # Try OME metadata first
        try:
            acq_mode = meta.getChannelAcquisitionMode(0, c)
            if acq_mode is not None:
                mode_str = str(acq_mode).lower()
                if any(k in mode_str for k in ("brightfield", "transmittedlight", "other")):
                    ch_type = "transmitted"
        except Exception:
            pass
        try:
            illum = meta.getChannelIlluminationType(0, c)
            if illum is not None:
                illum_str = str(illum).lower()
                if "transmitted" in illum_str:
                    ch_type = "transmitted"
        except Exception:
            pass
        # Fall back to name heuristics
        if ch_type == "fluorescence" and c < len(channel_names):
            if _is_transmitted_name(channel_names[c]):
                ch_type = "transmitted"
        types.append(ch_type)
    return types


def declared_z_length(reader_j) -> int:
    """The Z length the vendor metadata says was acquired, or 0 if it does not say.

    Olympus records each acquisition axis in the series metadata as an
    `axis axis #N` / `axis maxSize #N` pair, and a copy that is missing its
    continuation chunks keeps those values intact — which is exactly what makes
    them worth comparing against the Z the reader can actually expose.

    Shared with the plate export path (plate.py), so both decide "this file is
    only part of itself" by the same measure. Returns 0 rather than raising: a
    file whose metadata does not name a Z axis is not evidence of a problem.
    """
    try:
        table = reader_j.getSeriesMetadata()
        if table is None:
            return 0
        found = 0
        for i in range(1, 17):
            axis = table.get(f"axis axis #{i}")
            size = table.get(f"axis maxSize #{i}")
            if axis is None or size is None:
                continue
            if str(axis).strip().upper() != "ZSTACK":
                continue
            try:
                found = max(found, int(float(str(size))))
            except ValueError:
                continue
        return found
    except Exception:
        return 0


def _detect_incomplete_oir(reader_j, path: str) -> str:
    """Warn when an OIR is missing the companion files that hold most of its pixels.

    Olympus splits a dataset larger than ~1 GB across `<name>.oir` plus extensionless
    `<name>_00001`, `_00002`, … siblings. Copying or drag-and-dropping only the .oir
    yields a file that still opens and still reports the full XY size, but exposes
    just the planes in that first chunk — e.g. Z 13 of 50 — with no error anywhere.

    The vendor metadata keeps the acquired axis length even in the truncated copy,
    so comparing it against what the reader actually exposes catches the case.
    """
    try:
        declared_z = declared_z_length(reader_j)
        actual_z = int(reader_j.getSizeZ())
        if declared_z <= actual_z:
            return ""

        # Distinguish "chunks are missing" from an odd-but-complete acquisition.
        base = path[:-4] if path.lower().endswith(".oir") else path
        first_chunk = f"{base}_00001"
        found = len([u for u in reader_j.getUsedFiles()])
        if os.path.exists(first_chunk):
            return ""  # companions are present; the reader is using them

        return (
            f"このファイルは分割保存された .oir の一部だけです（Zスライス {actual_z}/{declared_z} のみ読み込み、"
            f"参照できたファイル {found} 個）。同じフォルダにある "
            f"{os.path.basename(base)}_00001, _00002, … も必要です。"
            "元の保存場所のパスを Open で直接指定して開いてください。"
        )
    except Exception:
        return ""


def _read_channel_ranges(reader_j, n_c: int, channel_names: list[str], bit_depth: int) -> list[list[float]]:
    """Read the acquisition display range (LUT black/white points) per channel.

    Olympus OIR records it in the vendor metadata as `all shadow #NN` /
    `all highlight #NN`, expressed in the LUT's own space (`LUT resolution #NN`,
    typically 65536) rather than in pixel values. A 12-bit image left at the
    default 0..65535 therefore means "the full 0..4095 sensor range", so the
    values are rescaled here to the image's own bit depth before being handed to
    the viewer.

    Entries are matched to channels by `channel name #NN` when present (the table
    repeats each channel once per acquisition phase), otherwise positionally.
    Returns [] when the file carries nothing usable.
    """
    try:
        table = reader_j.getSeriesMetadata()
        if table is None:
            return []

        def get(key: str):
            v = table.get(key)
            return None if v is None else str(v)

        full_scale = float((1 << max(1, int(bit_depth))) - 1)
        by_name: dict[str, list[float]] = {}
        positional: list[list[float]] = []

        for i in range(1, 33):
            idx = f"{i:02d}"
            shadow, highlight = get(f"all shadow #{idx}"), get(f"all highlight #{idx}")
            if shadow is None or highlight is None:
                continue
            try:
                lo, hi = float(shadow), float(highlight)
            except ValueError:
                continue
            # LUT resolution is a count of entries (65536), so the last index is one less.
            res = get(f"LUT resolution #{idx}")
            try:
                lut_max = float(res) - 1.0 if res else 65535.0
            except ValueError:
                lut_max = 65535.0
            if lut_max <= 0 or hi <= lo:
                continue
            rng = [lo / lut_max * full_scale, hi / lut_max * full_scale]

            name = get(f"channel name #{idx}")
            if name and name not in by_name:
                by_name[name] = rng
            positional.append(rng)

        if not positional:
            return []

        ranges: list[list[float]] = []
        for c in range(n_c):
            name = channel_names[c] if c < len(channel_names) else None
            if name and name in by_name:
                ranges.append(by_name[name])
            elif c < len(positional):
                ranges.append(positional[c])
            else:
                ranges.append([])
        return ranges
    except Exception:
        return []


def _read_channel_colors(meta, n_c: int) -> list[list[int]]:
    """Read channel colors from OME metadata. Returns [[R,G,B], ...] or empty list."""
    colors: list[list[int]] = []
    try:
        for c in range(n_c):
            color_obj = meta.getChannelColor(0, c)
            if color_obj is not None:
                r = int(color_obj.getRed())
                g = int(color_obj.getGreen())
                b = int(color_obj.getBlue())
                # Skip black (0,0,0) and white (255,255,255) as they're often defaults
                if (r, g, b) != (0, 0, 0):
                    colors.append([r, g, b])
                else:
                    colors.append([])  # empty = use default
            else:
                colors.append([])  # empty = use default
    except Exception:
        return []
    return colors

def selftest() -> int:
    """Prove this build can actually reach Bio-Formats. Returns an exit code.

    The CI smoke test only checked that the server answered /api/images, which a
    build with no working Java at all passes — and one shipped. This walks the
    real path instead: import scyjava (the step that PackageNotFoundError broke),
    start the bundled JVM, and jimport every class the reader needs. Anything
    that fails here would have failed on the user's first .oir.
    """
    print(f"selftest: {describe_runtime()}", flush=True)
    try:
        import scyjava
    except Exception as e:
        print(f"selftest FAILED: import scyjava -> {type(e).__name__}: {e}", flush=True)
        return 1
    print(f"selftest: scyjava {getattr(scyjava, '__version__', '?')} imported", flush=True)
    try:
        _start_jvm(scyjava)
    except Exception as e:
        print(f"selftest FAILED: JVM -> {type(e).__name__}: {e}", flush=True)
        return 2
    for cls in ("loci.formats.ImageReader", "loci.formats.MetadataTools",
                "loci.common.services.ServiceFactory", "loci.formats.FormatTools"):
        try:
            scyjava.jimport(cls)
        except Exception as e:
            print(f"selftest FAILED: jimport {cls} -> {type(e).__name__}: {e}", flush=True)
            return 3
        print(f"selftest: {cls} OK", flush=True)
    print("selftest : OK", flush=True)
    return 0
