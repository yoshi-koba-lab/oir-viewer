"""OIR Viewer Backend - FastAPI server with pywebview integration."""

from __future__ import annotations

import sys
import os
import tempfile
import threading
import base64
import traceback
import uuid


def _force_utf8_stdio() -> None:
    """Make logging incapable of killing the server.

    stdout and stderr here are pipes the Electron shell reads, so Python picks
    the OS locale encoding for them: cp1252 on an English Windows, cp932 on a
    Japanese one. Neither can encode an em dash or a 'µ', both of which appear
    in this app's own log lines — and print() raises UnicodeEncodeError rather
    than dropping the character. Raised during startup that kills the process
    before it ever listens; raised inside a handler it turns an unrelated
    request into a 400. macOS and Linux never see it because their streams are
    UTF-8 already, which is exactly why it survived to a Windows install.

    Must run before anything prints, i.e. before the first import that might.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass  # already gone, or not a text stream — nothing to protect


_force_utf8_stdio()

from pathlib import Path

import numpy as np
import uvicorn
from contextlib import asynccontextmanager
import json
import re
import time
from fastapi import FastAPI, Query, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from reader import (
    ImageMetadata, ImageReader, describe_runtime, prewarm_jvm as _prewarm_jvm, selftest,
)
from processor import (
    adjust_contrast, auto_contrast, auto_contrast_from_counts, compute_histogram,
    to_png_bytes,
)
from roi import line_profile, measure_roi
import plate

# Multi-image state: id -> ImageReader
images: dict[str, ImageReader] = {}
active_id: str | None = None

# Persistent app data (uploads survive restarts; session records open files).
APP_DIR = os.path.join(os.path.expanduser("~"), ".oir-viewer")
UPLOADS_DIR = os.path.join(APP_DIR, "uploads")
SESSION_FILE = os.path.join(APP_DIR, "session.json")


def _save_session() -> None:
    """Persist the list of open files (with real paths) so they can be restored."""
    import json
    tmp_path = ""
    try:
        os.makedirs(APP_DIR, exist_ok=True)
        # Dimensions travel with the path so the next startup can show the tabs
        # without opening anything.
        entries = [
            {
                "source_path": r.metadata.source_path, "filename": r.metadata.filename,
                "num_channels": r.metadata.num_channels, "num_z": r.metadata.num_z,
                "num_t": r.metadata.num_t,
                "width": r.metadata.width, "height": r.metadata.height,
            }
            for r in images.values()
            if r.metadata.source_path and os.path.exists(r.metadata.source_path)
        ]
        # Write-then-rename: truncating session.json in place leaves a corrupt file
        # if the write is interrupted, which then kills the next restore.
        with tempfile.NamedTemporaryFile(
            "w", dir=APP_DIR, prefix=".session-", suffix=".tmp", delete=False
        ) as f:
            tmp_path = f.name
            json.dump({"images": entries}, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, SESSION_FILE)
    except OSError:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def _restore_session() -> int:
    """Re-list the files from the last session. Returns how many were restored.

    Nothing is read here. The previous version called load_file() on every
    remembered path inside the startup lifespan, which for eight plate wells of
    real data is 34 GB of pixels before the server answers its first request —
    the app could not start at all, and the failure looked like a crash rather
    than like "the last session was too big". Each file becomes a deferred
    reader instead: the tab is there, and the pixels arrive when it is opened.

    Dimensions come from the session file so the tab list is right without
    touching the disk. They are only a cache — the first real load re-reads the
    file and overwrites them — so a file edited between sessions corrects itself
    rather than being trusted forever.
    """
    import json
    if not os.path.exists(SESSION_FILE):
        return 0
    try:
        with open(SESSION_FILE) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return 0
    if not isinstance(data, dict):
        return 0
    entries = data.get("images")
    if not isinstance(entries, list):
        return 0
    restored = 0
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        path = entry.get("source_path")
        if not path or not os.path.exists(path):
            continue
        try:
            meta = ImageMetadata(
                filename=entry.get("filename") or os.path.basename(path),
                source_path=path,
                num_channels=int(entry.get("num_channels") or 1),
                num_z=int(entry.get("num_z") or 1),
                num_t=int(entry.get("num_t") or 1),
                width=int(entry.get("width") or 0),
                height=int(entry.get("height") or 0),
            )
            r = ImageReader()
            r.defer(path, meta)
            add_image(r)
            restored += 1
        except Exception as e:
            print(f"Session restore skipped {path}: {e}")
    return restored


def _selftest_session() -> int:
    """Prove restoring a session reads no pixels. Returns an exit code.

    This is the bug that shipped in 1.4.0: restore called load_file() on every
    remembered path inside the startup lifespan, so a session holding eight
    plate wells tried to decode 34 GB before the server answered anything and
    the app could not start. It is invisible in development, where the session
    holds one small file — the size of the failure is a property of the user's
    data, not of the code — so it is checked here rather than by trying it.
    """
    global images, active_id
    import json
    import tempfile

    saved_images, saved_active, saved_file = images, active_id, SESSION_FILE
    try:
        with tempfile.TemporaryDirectory() as tmp:
            # A path that exists and could be opened, so restore has no excuse
            # to skip it: the point is that it declines to read it anyway.
            target = os.path.join(tmp, "well.tif")
            import tifffile
            tifffile.imwrite(target, np.zeros((4, 32, 32), dtype=np.uint16))
            globals()["SESSION_FILE"] = os.path.join(tmp, "session.json")
            with open(SESSION_FILE, "w") as f:
                json.dump({"images": [{
                    "source_path": target, "filename": "well.tif",
                    "num_channels": 1, "num_z": 4, "num_t": 1,
                    "width": 32, "height": 32,
                }]}, f)
            images, active_id = {}, None
            n = _restore_session()
            resident = sum(r.loaded_bytes for r in images.values())
            listed = [r.metadata.num_z for r in images.values()]
    except Exception as e:
        print(f"selftest FAILED: session restore -> {type(e).__name__}: {e}", flush=True)
        return 20
    finally:
        images, active_id = saved_images, saved_active
        globals()["SESSION_FILE"] = saved_file

    if n != 1:
        print(f"selftest FAILED: restored {n} images, expected 1", flush=True)
        return 21
    if resident:
        print(f"selftest FAILED: restore read {resident} bytes of pixels; "
              "startup must not decode last session's files", flush=True)
        return 22
    if listed != [4]:
        print(f"selftest FAILED: restored tab lost its dimensions ({listed})", flush=True)
        return 23
    print(f"selftest: session restore OK (0 pixel bytes, budget "
          f"{IMAGE_BUDGET_BYTES / 1024 ** 3:.1f} GB)", flush=True)
    return 0


@asynccontextmanager
async def lifespan(app: FastAPI):
    """App lifespan: restore the previous session, or load dummy data for dev."""
    # Daemon thread: the JVM's cold start is seconds long and must not delay the
    # port line the shell is waiting on, nor keep the process alive at exit.
    threading.Thread(target=_prewarm_jvm, name="jvm-prewarm", daemon=True).start()
    restored = _restore_session()
    if restored:
        print(f"Restored {restored} image(s) from previous session")
    else:
        r = ImageReader()
        r.load_dummy()
        add_image(r)
        print("No session to restore - loaded dummy data")
    yield
    # (no shutdown cleanup needed — session is persisted incrementally)


app = FastAPI(title="OIR Viewer", lifespan=lifespan)

# This server reads and writes arbitrary local paths, so it must not be drivable
# from any page the user happens to visit. Only our own UI origins are allowed:
# the Vite dev server (5173, plus the ports it falls back to when 5173 is taken),
# `vite preview` (4173), and the pywebview window, which loads localhost:5173.
ALLOWED_ORIGINS = [
    f"http://{host}:{port}"
    for host in ("localhost", "127.0.0.1")
    for port in (5173, 5174, 5175, 4173)
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _physical_ram_bytes() -> int:
    """Total RAM, or 0 when it cannot be determined."""
    try:
        if sys.platform == "win32":
            import ctypes

            class _MemStatus(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong),
                            ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong),
                            ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong),
                            ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong),
                            ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

            st = _MemStatus()
            st.dwLength = ctypes.sizeof(_MemStatus)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
                return int(st.ullTotalPhys)
            return 0
        return int(os.sysconf("SC_PAGE_SIZE")) * int(os.sysconf("SC_PHYS_PAGES"))
    except Exception:
        return 0


#: How many bytes of decoded pixels all open images may hold between them.
#:
#: A fraction of the machine rather than a fixed number, because the same figure
#: means opposite things on a 192 GB workstation and a 16 GB laptop. One real
#: plate well is 2911x2923x50x5 uint16 = 4.25 GB, so eight of them is 34 GB:
#: fine on the workstation, fatal anywhere else. 40% leaves room for the JVM,
#: the slice cache, Electron and the OS.
_RAM = _physical_ram_bytes()
try:
    _budget_env = os.environ.get("OIR_PIXEL_BUDGET_MB", "")
    IMAGE_BUDGET_BYTES = (int(_budget_env) * 1024 * 1024 if _budget_env
                          else (int(_RAM * 0.40) if _RAM else 4 * 1024 ** 3))
except ValueError:
    IMAGE_BUDGET_BYTES = int(_RAM * 0.40) if _RAM else 4 * 1024 ** 3

#: Image ids in the order they were last used, oldest first.
_lru: list[str] = []

#: Guards `images`, `active_id` and `_lru` as one unit. Sync endpoints run on a
#: thread pool while async ones run on the event loop, so a close could delete
#: an id between _enforce_budget's membership check and its unload() — a
#: KeyError-shaped 500 with no wrongdoing anywhere. RLock, because add_image
#: calls _touch and _enforce_budget while already holding it.
_state_lock = threading.RLock()


def _touch(image_id: str) -> None:
    with _state_lock:
        if image_id in _lru:
            _lru.remove(image_id)
        _lru.append(image_id)


def _enforce_budget(keep: str | None = None) -> None:
    """Drop the pixels of least-recently-used images until under budget.

    Every open image used to hold its full (T,C,Z,Y,X) array for as long as the
    tab existed, so the plate workflow — open eight wells, tune each — added up
    to 34 GB of real data and took the app down with it. Tabs stay; their pixels
    do not, and come back when the tab is looked at again.
    """
    with _state_lock:
        total = sum(r.loaded_bytes for r in images.values())
        if total <= IMAGE_BUDGET_BYTES:
            return
        for img_id in list(_lru):
            if total <= IMAGE_BUDGET_BYTES:
                break
            if img_id == keep or img_id == active_id or img_id not in images:
                continue
            freed = images[img_id].unload()
            if freed:
                total -= freed
                print(f"Unloaded {images[img_id].metadata.filename} "
                      f"({freed / 1048576:.0f} MB) to stay within the pixel budget",
                      flush=True)


def get_reader(image_id: str | None = None) -> ImageReader:
    """Get the reader for a given image ID, or the active one."""
    rid = image_id or active_id
    if rid is None or rid not in images:
        raise RuntimeError("No image loaded")
    _touch(rid)
    return images[rid]


def add_image(reader: ImageReader) -> str:
    """Register a reader and return its ID."""
    global active_id
    img_id = uuid.uuid4().hex[:8]
    with _state_lock:
        images[img_id] = reader
        active_id = img_id
        _touch(img_id)
    # A newly opened well is the one being looked at, so older ones give up
    # their pixels rather than this one being refused.
    _enforce_budget(keep=img_id)
    _save_session()
    return img_id


@app.get("/api/images")
async def list_images():
    """List all loaded images."""
    result = []
    for img_id, r in images.items():
        result.append({
            "id": img_id,
            "filename": r.metadata.filename,
            "num_channels": r.metadata.num_channels,
            "num_z": r.metadata.num_z,
            "num_t": r.metadata.num_t,
            "width": r.metadata.width,
            "height": r.metadata.height,
            "active": img_id == active_id,
        })
    return result


@app.post("/api/images/{image_id}/activate")
def activate_image(image_id: str):
    """Set an image as active, reading its pixels if this is the first look.

    Sync rather than async on purpose: reading a well is seconds of blocking I/O
    and CPU, and on the event loop that would freeze every other request,
    including the ones the UI makes to show that it is loading. FastAPI runs a
    `def` endpoint in its thread pool.
    """
    global active_id
    if image_id not in images:
        return JSONResponse(status_code=404, content={"error": "Image not found"})
    active_id = image_id
    _touch(image_id)
    try:
        images[image_id].ensure_loaded()
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(status_code=400, content={"error": _describe(e)})
    # After loading, not before: the well just read is the one to keep.
    _enforce_budget(keep=image_id)
    return images[image_id].metadata.to_dict()


@app.delete("/api/images/{image_id}")
async def close_image(image_id: str):
    """Close and remove an image."""
    global active_id
    with _state_lock:
        if image_id in _lru:
            _lru.remove(image_id)
        if image_id not in images:
            return JSONResponse(status_code=404, content={"error": "Image not found"})
        del images[image_id]
        if active_id == image_id:
            active_id = next(iter(images), None)
    _save_session()
    return {"closed": image_id, "active_id": active_id}


def _describe(e: BaseException) -> str:
    """A message that always says something.

    Several failures on the way into a file carry no text at all — an empty
    OSError, a Java exception whose toString() is just its class name. Those
    reached the UI as an empty red bar, so the exception type is included
    whenever the message alone would not identify it.
    """
    msg = str(e).strip()
    name = type(e).__name__
    if not msg:
        return f"{name}（詳細なし）"
    if name in ("RuntimeError", "ValueError") or name in msg:
        return msg
    return f"{msg}（{name}）"


@app.get("/api/open")
def open_file(path: str = Query(...)):
    """Open an image file by path."""
    try:
        print(f"Opening {path}", flush=True)
        r = ImageReader()
        r.load_file(path)
        img_id = add_image(r)
        return {**r.metadata.to_dict(), "id": img_id}
    except Exception as e:
        # str(e) alone is what the UI shows, and for a JVM or Bio-Formats
        # failure that is often a bare class name. The traceback goes to the
        # log file so the cause is recoverable without reproducing it.
        traceback.print_exc()
        return JSONResponse(status_code=400, content={"error": _describe(e)})


def _safe_upload_name(raw: str | None) -> str:
    """Reduce a client-supplied filename to a plain basename.

    The name is joined onto UPLOADS_DIR and later reused to build export
    filenames, so '../', absolute paths and separators must not survive.
    """
    name = os.path.basename((raw or "").replace("\\", "/")).replace("\0", "").strip()
    if not name.strip("."):  # "", ".", ".." → no usable name
        name = f"upload_{uuid.uuid4().hex[:8]}"
    return name


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    """Upload an image file, save to the persistent uploads dir, and open it."""
    try:
        content = await file.read()
        # Save under a stable app dir (not /tmp) so the file survives restarts and
        # the session can be restored. On a name clash use a fresh SUBFOLDER rather
        # than renaming the file: a split .oir finds its `<base>_00001` siblings by
        # name, so renaming the .oir would silently sever that link.
        base = _safe_upload_name(file.filename)
        dest_dir = UPLOADS_DIR
        if os.path.exists(os.path.join(UPLOADS_DIR, base)):
            dest_dir = os.path.join(UPLOADS_DIR, uuid.uuid4().hex[:8])
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, base)

        uploads_root = os.path.realpath(UPLOADS_DIR)
        if not os.path.realpath(dest).startswith(uploads_root + os.sep):
            raise RuntimeError("Invalid upload filename")

        with open(dest, "wb") as out:
            out.write(content)

        r = ImageReader()
        r.load_file(dest)
        r.metadata.filename = base
        img_id = add_image(r)
        return {**r.metadata.to_dict(), "id": img_id}
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(status_code=400, content={"error": _describe(e)})


@app.get("/api/metadata")
async def get_metadata(id: str | None = Query(None)):
    """Get current image metadata."""
    try:
        r = get_reader(id)
        return {**r.metadata.to_dict(), "id": id or active_id}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@app.get("/api/image")
def get_image(
    c: int = Query(0),
    z: int = Query(0),
    t: int = Query(0),
    format: str = Query("raw"),
    id: str | None = Query(None),
):
    """Get a single 2D slice."""
    try:
        r = get_reader(id)
        img = r.get_slice(c, z, t)
        if format == "png":
            png_bytes = to_png_bytes(img)
            return Response(content=png_bytes, media_type="image/png")
        else:
            raw = img.astype(np.uint16).tobytes()
            return Response(
                content=raw,
                media_type="application/octet-stream",
                headers={
                    "X-Width": str(img.shape[1]),
                    "X-Height": str(img.shape[0]),
                    "X-Dtype": "uint16",
                },
            )
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@app.get("/api/image/all-channels")
def get_all_channels(
    z: int = Query(0),
    t: int = Query(0),
    mip: bool = Query(False),
    proj: bool = Query(False),
    proj_method: str = Query("max"),
    proj_z_from: int = Query(0),
    proj_z_to: int = Query(-1),
    id: str | None = Query(None),
):
    """Get all channels as base64-encoded uint16 raw data in a single response."""
    try:
        r = get_reader(id)
        n_c = r.metadata.num_channels
        # Default proj_z_to to last Z slice
        if proj_z_to < 0:
            proj_z_to = r.metadata.num_z - 1
        channels = []
        for c in range(n_c):
            if proj:
                img = r.get_projection(c, t, proj_z_from, proj_z_to, proj_method)
            elif mip:
                img = r.get_mip(c, t)
            else:
                img = r.get_slice(c, z, t)
            raw_b64 = base64.b64encode(img.astype(np.uint16).tobytes()).decode("ascii")
            low, high = auto_contrast(img)
            channels.append({
                "channel": c,
                "data_b64": raw_b64,
                "auto_min": low,
                "auto_max": high,
            })
        return {
            "width": r.metadata.width,
            "height": r.metadata.height,
            "channels": channels,
        }
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@app.get("/api/image/all-channels-bin")
def get_all_channels_bin(
    z: int = Query(0),
    t: int = Query(0),
    mip: bool = Query(False),
    proj: bool = Query(False),
    proj_method: str = Query("max"),
    proj_z_from: int = Query(0),
    proj_z_to: int = Query(-1),
    id: str | None = Query(None),
):
    """All channels as a single self-describing binary buffer (little-endian).

    Layout:
        uint32  width
        uint32  height
        uint32  num_channels
        num_channels × (int32 auto_min, int32 auto_max)   # channel index = position
        num_channels × (width*height × uint16)            # pixel planes, in order

    Avoids base64 (+33% size) and per-byte JS decoding used by the JSON variant.
    """
    try:
        r = get_reader(id)
        n_c = r.metadata.num_channels
        w, h = r.metadata.width, r.metadata.height
        if proj_z_to < 0:
            proj_z_to = r.metadata.num_z - 1

        planes: list[np.ndarray] = []
        levels: list[tuple[int, int]] = []
        for c in range(n_c):
            if proj:
                img = r.get_projection(c, t, proj_z_from, proj_z_to, proj_method)
            elif mip:
                img = r.get_mip(c, t)
            else:
                img = r.get_slice(c, z, t)
            img = np.ascontiguousarray(img, dtype="<u2")
            planes.append(img)
            low, high = auto_contrast(img)
            levels.append((int(low), int(high)))

        header = np.array([w, h, n_c], dtype="<u4").tobytes()
        meta = np.array(levels, dtype="<i4").tobytes() if levels else b""
        body = b"".join(p.tobytes() for p in planes)
        payload = header + meta + body
        return Response(content=payload, media_type="application/octet-stream")
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@app.get("/api/mip")
def get_mip(c: int = Query(0), t: int = Query(0), id: str | None = Query(None)):
    """Get Maximum Intensity Projection."""
    try:
        r = get_reader(id)
        img = r.get_mip(c, t)
        raw = img.astype(np.uint16).tobytes()
        return Response(
            content=raw,
            media_type="application/octet-stream",
            headers={
                "X-Width": str(img.shape[1]),
                "X-Height": str(img.shape[0]),
                "X-Dtype": "uint16",
            },
        )
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@app.get("/api/histogram")
def get_histogram(
    c: int = Query(0),
    z: int = Query(0),
    t: int = Query(0),
    id: str | None = Query(None),
):
    """Get intensity histogram for a slice."""
    try:
        r = get_reader(id)
        img = r.get_slice(c, z, t)
        hist = compute_histogram(img)
        low, high = auto_contrast(img)
        hist["auto_min"] = low
        hist["auto_max"] = high
        return hist
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@app.post("/api/roi/profile")
def roi_profile(body: dict):
    """Compute intensity profile along a line ROI."""
    try:
        r = get_reader(body.get("id"))
        c = body.get("c", 0)
        z = body.get("z", 0)
        t = body.get("t", 0)
        img = r.get_slice(c, z, t)
        result = line_profile(
            img,
            int(body["x0"]), int(body["y0"]),
            int(body["x1"]), int(body["y1"]),
            width=int(body.get("width", 1)),
        )
        px_size = r.metadata.pixel_size_x
        if px_size > 0:
            result["distances"] = [d * px_size for d in result["distances"]]
            result["distance_unit"] = "µm"
        return result
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@app.post("/api/roi/measure")
def roi_measure(body: dict):
    """Measure statistics within an ROI."""
    try:
        r = get_reader(body.get("id"))
        c = body.get("c", 0)
        z = body.get("z", 0)
        t = body.get("t", 0)
        img = r.get_slice(c, z, t)
        result = measure_roi(
            img,
            roi_type=body["roi_type"],
            params=body["params"],
            pixel_size_x=r.metadata.pixel_size_x,
            pixel_size_y=r.metadata.pixel_size_y,
        )
        return result
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@app.get("/api/volume")
def get_volume(
    t: int = Query(0),
    id: str | None = Query(None),
    max_dim: int = Query(256),
):
    """Get volume data for 3D rendering, downsampled to fit in GPU memory.

    Returns uint8 data (auto-contrast per channel) to minimise transfer and GPU memory.
    max_dim caps the XY dimension; max_dim <= 0 means "no downsampling at all",
    which the client only asks for when the GPU can actually hold the result.
    """
    from scipy.ndimage import zoom as ndzoom

    try:
        r = get_reader(id)
        vol = r.get_volume(t)  # (C, Z, Y, X)
        n_c, n_z, h, w = vol.shape

        full_res = max_dim <= 0
        if full_res:
            scale_xy = 1.0
            scale_z = 1.0
        else:
            # Compute downsample factor for XY
            xy_max = max(h, w)
            max_dim = max(32, min(max_dim, 2048))  # GPUs cap 3D textures well below this
            scale_xy = max_dim / xy_max if xy_max > max_dim else 1.0

            # Also limit Z to avoid huge textures (max ~128 slices for 3D)
            max_z = 128
            scale_z = max_z / n_z if n_z > max_z else 1.0

        out_h = int(round(h * scale_xy))
        out_w = int(round(w * scale_xy))
        out_z = int(round(n_z * scale_z))

        channels = []
        for c in range(n_c):
            ch_vol = vol[c]  # (Z, Y, X) uint16

            # Downsample if needed
            if scale_xy != 1.0 or scale_z != 1.0:
                ch_vol = ndzoom(ch_vol.astype(np.float32),
                                (scale_z, scale_xy, scale_xy),
                                order=1).clip(0, 65535).astype(np.uint16)

            # Auto-contrast → uint8
            low, high = auto_contrast(ch_vol.ravel())
            rng = max(float(high - low), 1.0)
            normed = ((ch_vol.astype(np.float32) - low) / rng).clip(0, 1)
            ch_u8 = (normed * 255).astype(np.uint8)

            raw_b64 = base64.b64encode(ch_u8.tobytes()).decode("ascii")
            channels.append({
                "channel": c,
                "data_b64": raw_b64,
                "auto_min": int(low),
                "auto_max": int(high),
            })

        return {
            "num_channels": n_c,
            "num_z": out_z,
            "height": out_h,
            "width": out_w,
            "original_shape": [n_c, n_z, h, w],
            "channels": channels,
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse(status_code=400, content={"error": str(e)})


#: Distinct values a uint16 pixel can take, which is the length of the histogram
#: the streaming volume path accumulates instead of keeping the pixels. Every
#: reader path ends at uint16 (reader._to_uint16), so this covers all of them.
_U16_LEVELS = 65536


@app.get("/api/volume-bin")
def get_volume_bin(
    t: int = Query(0),
    id: str | None = Query(None),
    max_dim: int = Query(256),
    max_ch: int = Query(4),
):
    """Volume for 3D rendering as one binary blob (little-endian).

    Layout:
        uint32  num_channels, num_z, height, width
        uint32  orig_c, orig_z, orig_h, orig_w
        nc × (int32 auto_min, int32 auto_max)
        nc × (num_z*height*width × uint8)

    The JSON/base64 variant inflates the payload by a third and has to be parsed
    as one giant string, which fails outright around a gigabyte — exactly where
    the full-resolution option lands. Only the channels the renderer can actually
    use are sent (max_ch), since the rest would be transferred and discarded.

    Built one plane at a time, the way plate.read_low_volume already does it.
    The previous version expanded a whole channel with
    `ndzoom(ch_vol.astype(np.float32), ...)`, which for one real plate well
    (2910x2924x50, uint16) is a 1.585 GiB temporary per channel — on top of the
    4.25 GB the reader is already holding, and repeated for every channel. On
    2026-08-07 the packaged v1.5.0 backend died with no traceback and no crash
    report immediately after answering this endpoint for a real well with two
    wells open: the log just stops, which is what an out-of-memory kill looks
    like from the inside. Nothing here now allocates more than one plane beyond
    the reply itself.

    The wire layout is unchanged, so the renderer needs no change.
    """
    try:
        r = get_reader(id)
        vol = r.get_volume(t)  # (C, Z, Y, X) uint16, a view — never copied here
        n_c, n_z, h, w = vol.shape

        full_res = max_dim <= 0
        if full_res:
            scale_xy = 1.0
            scale_z = 1.0
        else:
            xy_max = max(h, w)
            max_dim = max(32, min(max_dim, 2048))
            scale_xy = max_dim / xy_max if xy_max > max_dim else 1.0
            scale_z = 128 / n_z if n_z > 128 else 1.0

        out_h = int(round(h * scale_xy))
        out_w = int(round(w * scale_xy))
        out_z = int(round(n_z * scale_z))
        send_c = max(1, min(n_c, max_ch))

        # One buffer for the whole reply, filled in place. Collecting per-channel
        # bytes and joining them holds the entire payload twice at the moment of
        # the join — another 1.7 GB at full resolution, for no reason: every
        # offset is known before the first plane is read.
        head_bytes = 32 + 8 * send_c
        ch_bytes = out_z * out_h * out_w
        body = bytearray(head_bytes + ch_bytes * send_c)
        mv = memoryview(body)
        mv[:32] = np.array([send_c, out_z, out_h, out_w,
                            n_c, n_z, h, w], dtype="<u4").tobytes()

        resize_xy = (out_h, out_w) != (h, w)
        for c in range(send_c):
            src = vol[c]  # (Z, Y, X) view
            if resize_xy or out_z != n_z:
                # Staged at the OUTPUT size, so the biggest thing alive is the
                # answer (26 MB at max_dim=512) rather than the source.
                stage = np.empty((out_z, out_h, out_w), dtype=np.uint16)
                counts = np.zeros(_U16_LEVELS, dtype=np.int64)
                for zi in range(out_z):
                    # Nearest source plane when Z is decimated, as plate.py does
                    # it. The old 3D zoom interpolated across Z, inventing signal
                    # between real optical sections; it also only ever ran when
                    # n_z > 128, which this data (n_z = 50) never hits.
                    src_z = (zi if out_z == n_z else
                             min(n_z - 1, int(round(zi * (n_z - 1) / max(out_z - 1, 1)))))
                    if resize_xy:
                        # plate._resize_plane, not bare ndzoom: order=1 alone is
                        # point sampling, and 1.3.0 measured it erasing 26 of 31
                        # thin 2 px structures at plate resolutions. That fix
                        # only ever landed on the plate path; the interactive
                        # view kept losing exactly the structures being
                        # inspected. Same helper now, so the view, the plate
                        # PDF and the 3D export all shrink the same way.
                        plane = plate._resize_plane(src[src_z], out_h, out_w)
                        np.clip(plane, 0, 65535, out=plane)
                        stage[zi] = plane
                    else:
                        stage[zi] = src[src_z]
                    counts += np.bincount(stage[zi].reshape(-1),
                                          minlength=_U16_LEVELS)
            else:
                # Asked for the source size: the reader's own array is already
                # the staging buffer, so this costs a counting pass and nothing else.
                stage = src
                counts = np.zeros(_U16_LEVELS, dtype=np.int64)
                for zi in range(out_z):
                    counts += np.bincount(stage[zi].reshape(-1),
                                          minlength=_U16_LEVELS)

            # Same window as before, from a histogram of the same values rather
            # than from the values themselves — see auto_contrast_from_counts.
            low, high = auto_contrast_from_counts(counts)
            rng = max(float(high - low), 1.0)
            base = head_bytes + c * ch_bytes
            mv[32 + 8 * c:40 + 8 * c] = np.array([int(low), int(high)],
                                                 dtype="<i4").tobytes()
            dst = np.frombuffer(mv[base:base + ch_bytes],
                                dtype=np.uint8).reshape(out_z, out_h, out_w)
            for zi in range(out_z):
                normed = (stage[zi].astype(np.float32) - low) / rng
                np.clip(normed, 0, 1, out=normed)
                dst[zi] = normed * 255
            del stage, counts

        # memoryview, not bytes(): Response.render passes it straight through,
        # where bytes() would copy the finished payload one more time.
        return Response(content=mv, media_type="application/octet-stream")
    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse(status_code=400, content={"error": str(e)})


def _no_dialog_here() -> JSONResponse:
    """Why this process cannot show a file picker, said once.

    Frozen by PyInstaller, `sys.executable` is this app, not a Python
    interpreter — so the old `subprocess.run([sys.executable, "-c", ...])`
    started a SECOND backend, blocked for its whole timeout and left the UI on
    "Opening…". `_tkinter` is not bundled either, so even a correct interpreter
    would fail. The desktop build asks Electron instead (desktop/preload.js);
    this endpoint only ever runs when there is no shell to ask.
    """
    return JSONResponse(
        status_code=501,
        content={"error": "このビルドではファイル選択ダイアログを開けません。"
                          "「…」ボタンからパスを直接入力してください。"},
    )


@app.get("/api/choose-folder")
def choose_folder():
    """Native folder picker. macOS only; elsewhere the shell owns it."""
    import subprocess
    if sys.platform != "darwin":
        return _no_dialog_here()
    try:
        result = subprocess.run(
            ['osascript', '-e', 'POSIX path of (choose folder with prompt "保存先フォルダを選択")'],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0:
            # User cancelled
            return {"path": None, "cancelled": True}
        path = result.stdout.strip().rstrip('/')
        return {"path": path, "cancelled": False}
    except subprocess.TimeoutExpired:
        return {"path": None, "cancelled": True}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


IMAGE_EXTENSIONS = ["oir", "oib", "oif", "tif", "tiff", "nd2", "lif", "czi"]


@app.get("/api/choose-files")
def choose_files():
    """Open the OS file picker and return the chosen image paths.

    Typing a full path was the only way to open a file, which is unusable for
    data sitting many folders deep on an external drive. macOS gets a real Finder
    dialog via osascript; elsewhere (and in a packaged build on Windows) tkinter
    provides the same thing without adding a dependency.
    """
    import subprocess
    try:
        if sys.platform == "darwin":
            ext_list = ", ".join(f'"{e}"' for e in IMAGE_EXTENSIONS)
            script = (
                'set theFiles to choose file with prompt "画像ファイルを選択"'
                f" of type {{{ext_list}}} with multiple selections allowed\n"
                'set out to ""\n'
                'repeat with f in theFiles\n'
                '  set out to out & POSIX path of f & linefeed\n'
                'end repeat\n'
                'return out'
            )
            result = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True, text=True, timeout=300,
            )
            if result.returncode != 0:
                return {"paths": [], "cancelled": True}  # user cancelled
            paths = [p for p in (line.strip() for line in result.stdout.splitlines()) if p]
            return {"paths": paths, "cancelled": not paths}

        # Below here the picker needs a real Python interpreter to run tkinter
        # in a child process (a GUI toolkit must own the main thread). A frozen
        # build has none — see _no_dialog_here.
        if getattr(sys, "frozen", False):
            return _no_dialog_here()

        code = (
            "import json,sys\n"
            "import tkinter as tk\n"
            "from tkinter import filedialog\n"
            "r = tk.Tk(); r.withdraw()\n"
            f"types = [('Image files', '{' '.join('*.' + e for e in IMAGE_EXTENSIONS)}'), ('All files', '*.*')]\n"
            "p = filedialog.askopenfilenames(title='画像ファイルを選択', filetypes=types)\n"
            "print(json.dumps(list(p)))\n"
        )
        result = subprocess.run(
            [sys.executable, "-c", code], capture_output=True, text=True, timeout=300,
        )
        if result.returncode != 0:
            return {"paths": [], "cancelled": True}
        import json as _json
        paths = _json.loads((result.stdout or "[]").strip() or "[]")
        return {"paths": paths, "cancelled": not paths}
    except subprocess.TimeoutExpired:
        return {"paths": [], "cancelled": True}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


class ProjectionRequest(BaseModel):
    image_ids: list[str]
    method: str = "max"        # "max" | "min" | "avg"
    z_from: int = 0            # 0-based inclusive
    z_to: int = -1             # 0-based inclusive, -1 = last slice
    t: int = 0                 # time point to project
    output_dir: str = ""       # explicit output folder; falls back to source dir or ~/Desktop


def _next_suffix_path(base_dir: str, stem: str, ext: str = ".ome.tif") -> str:
    """Find the next available _XX suffix for a projection file."""
    idx = 1
    while True:
        name = f"{stem}_{idx:02d}{ext}"
        fpath = os.path.join(base_dir, name)
        if not os.path.exists(fpath):
            return fpath
        idx += 1


def _build_ome_xml(meta, n_channels: int, height: int, width: int, method: str,
                   z_from: int, z_to: int) -> str:
    """Build OME-XML metadata string for projected image."""
    from xml.etree.ElementTree import Element, SubElement, tostring

    ome = Element("OME", xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06")
    img = SubElement(ome, "Image", ID="Image:0", Name=f"{meta.filename} ({method.upper()} Proj Z{z_from+1}-{z_to+1})")
    pixels = SubElement(img, "Pixels",
                        ID="Pixels:0",
                        DimensionOrder="XYCZT",
                        Type="uint16",
                        SizeX=str(width),
                        SizeY=str(height),
                        SizeC=str(n_channels),
                        SizeZ="1",
                        SizeT="1")
    if meta.pixel_size_x > 0:
        pixels.set("PhysicalSizeX", f"{meta.pixel_size_x:.6f}")
        pixels.set("PhysicalSizeXUnit", "um")
    if meta.pixel_size_y > 0:
        pixels.set("PhysicalSizeY", f"{meta.pixel_size_y:.6f}")
        pixels.set("PhysicalSizeYUnit", "um")

    for c in range(n_channels):
        ch_name = meta.channel_names[c] if c < len(meta.channel_names) else f"Ch{c}"
        SubElement(pixels, "Channel", ID=f"Channel:0:{c}", Name=ch_name, SamplesPerPixel="1")
    for c in range(n_channels):
        SubElement(pixels, "TiffData", FirstC=str(c), FirstZ="0", FirstT="0", IFD=str(c))

    return '<?xml version="1.0" encoding="UTF-8"?>' + tostring(ome, encoding="unicode")


# ---------------------------------------------------------------- update check

RELEASES_API = "https://api.github.com/repos/yoshi-koba-lab/oir-viewer/releases/latest"
RELEASES_PAGE = "https://github.com/yoshi-koba-lab/oir-viewer/releases/latest"
#: The only outbound request this app ever makes. Cached so that reopening the
#: window, or several windows, cannot turn into a burst against a 60-per-hour
#: unauthenticated rate limit.
_UPDATE_CACHE: dict[str, object] = {"at": 0.0, "payload": None}
_UPDATE_TTL_S = 6 * 3600


def _parse_version(v: str) -> tuple[int, ...]:
    """`v1.2.10` -> (1, 2, 10). Trailing junk (`-rc1`) is dropped, not guessed at."""
    core = re.split(r"[-+]", v.strip().lstrip("vV"), 1)[0]
    parts = []
    for chunk in core.split("."):
        m = re.match(r"\d+", chunk)
        parts.append(int(m.group()) if m else 0)
    return tuple(parts) or (0,)


def _is_newer(latest: str, current: str) -> bool:
    """Compare numerically. "1.2.10" is newer than "1.2.9"; a string compare says otherwise."""
    a, b = _parse_version(latest), _parse_version(current)
    n = max(len(a), len(b))
    return a + (0,) * (n - len(a)) > b + (0,) * (n - len(b))


@app.get("/api/update-check")
def update_check(current: str = Query(...)):
    """Whether a newer release exists, per the GitHub Releases API.

    This is the one place the app talks to the internet. It is called only when
    the UI asks, the answer is cached for six hours, and every failure — offline,
    proxy, rate limit, GitHub down — returns "no update" rather than an error:
    a viewer that cannot reach GitHub is still a working viewer, and a lab
    machine with no route out must not be nagged about it.
    """
    import json as _json
    import time
    import urllib.request

    now = time.time()
    cached = _UPDATE_CACHE.get("payload")
    if cached is not None and now - float(_UPDATE_CACHE["at"]) < _UPDATE_TTL_S:
        latest = str(cached)
    else:
        try:
            req = urllib.request.Request(
                RELEASES_API,
                headers={"Accept": "application/vnd.github+json",
                         "User-Agent": "oir-viewer"},
            )
            with urllib.request.urlopen(req, timeout=6) as r:
                latest = str(_json.loads(r.read().decode("utf-8")).get("tag_name") or "")
            _UPDATE_CACHE.update({"at": now, "payload": latest})
        except Exception:
            # Deliberately silent: see the docstring.
            return {"update_available": False, "latest": None, "url": RELEASES_PAGE,
                    "checked": False}

    if not latest:
        return {"update_available": False, "latest": None, "url": RELEASES_PAGE, "checked": True}
    return {
        "update_available": _is_newer(latest, current),
        "latest": latest.lstrip("vV"),
        "url": RELEASES_PAGE,
        "checked": True,
    }


@app.get("/api/plate/scan")
def plate_scan(path: str = Query(...)):
    """Read a MATL acquisition folder into a plate manifest.

    Read-only: it parses XML and stats files. Nothing is opened through
    Bio-Formats here, so scanning an eight-well acquisition costs milliseconds
    and cannot pin a 4 GiB volume.
    """
    try:
        return plate.scan(path).to_dict()
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(status_code=400, content={"error": _describe(e)})


class PlateVolumeRequest(BaseModel):
    path: str
    channels: list[int]
    #: [[min, max], ...] aligned with `channels`. Required, never inferred: plate
    #: export must not auto-stretch, so the caller sends the window the user set.
    levels: list[list[float]]
    t: int = 0
    #: Longest XY edge of the returned volume; 0 means the source resolution,
    #: with no downscale and no Z decimation. Omitted, it stays at Low.
    #:
    #: This field was missing while the UI already sent it. Pydantic drops unknown
    #: fields, so every choice — Medium, High, Ultra, Max — silently rendered at
    #: Low, and the PDF footer recorded the resolution the user picked rather than
    #: the one used. The response header now reports the cap that was applied.
    max_xy: int = plate.PLATE_MAX_XY


@app.post("/api/plate/volume-bin")
def plate_volume_bin(req: PlateVolumeRequest):
    """One well's stitched OIR as a uint8 volume, streamed plane by plane.

    Deliberately not /api/volume-bin: that one needs the image registered in the
    global `images` map (pinning ~4 GiB per well), resizes whole channels at once,
    and calls auto_contrast — which plate export must never do. This route opens
    the file directly, closes it in `finally`, and bakes in the caller's window.
    """
    try:
        spec = plate.VolumeSpec(
            path=req.path,
            channels=list(req.channels),
            levels=[(float(a), float(b)) for a, b in req.levels],
            t=int(req.t),
            max_xy=int(req.max_xy),
        )
        info, payload = plate.read_low_volume(spec)
        return Response(
            content=payload,
            media_type="application/octet-stream",
            headers={"X-Plate-Volume": json.dumps(info)},
        )
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(status_code=400, content={"error": _describe(e)})


class PlateFrame(BaseModel):
    well_id: str
    row: int
    col: int
    #: base64 PNG of the rendered well.
    png_b64: str
    #: Lines printed over the top-left of this well's image. Empty falls back to
    #: the well ID, so a cell is never unlabelled.
    caption: list[str] = []


class PlatePdfRequest(BaseModel):
    plate_name: str
    rows: int
    cols: int
    frames: list[PlateFrame]
    #: well_id -> why that cell is empty: "disabled", "excluded" (imaged but not
    #: selected) or "missing" (imaged but no stitched file). A well_id that is
    #: absent was never imaged. Only cells with no frame consult this.
    well_states: dict[str, str] = {}
    cell_px: int = 600
    output_dir: str
    footer: str = ""
    #: Conditions table, written as a second page in the same PDF. Empty omits
    #: the page entirely rather than adding a blank one.
    table_headers: list[str] = []
    table_rows: list[list[str]] = []
    #: File to write, without extension. Empty falls back to the plate name plus
    #: a timestamp.
    filename: str = ""
    #: Replace a file that is already there instead of refusing.
    overwrite: bool = False


@app.post("/api/plate/pdf")
def plate_pdf(req: PlatePdfRequest):
    """Compose rendered wells into one PDF in plate order.

    All or nothing by construction: the caller sends frames only for wells it
    rendered successfully, and it is the caller's job to abort rather than send a
    partial set — a PDF missing a well that WAS acquired would look like a plate
    where that well was empty.
    """
    try:
        out_dir = Path(req.output_dir).expanduser()
        if not out_dir.is_dir():
            return JSONResponse(status_code=400,
                                content={"error": f"保存先が見つかりません: {out_dir}"})
        frames = [
            plate.WellFrame(f.well_id, f.row, f.col, base64.b64decode(f.png_b64),
                            list(f.caption))
            for f in req.frames
        ]
        if not frames:
            return JSONResponse(status_code=400, content={"error": "描画されたウェルがありません"})
        # A typed name is used as given. Without one the plate names the file and
        # a timestamp keeps repeats apart, which is the old behaviour.
        if req.filename:
            stem = _safe_name_part(os.path.splitext(req.filename)[0]) or "plate"
        else:
            safe = _safe_name_part(req.plate_name) or "plate"
            stem = f"{safe}_plate3d_{time.strftime('%Y%m%d-%H%M%S')}"
        target = out_dir / f"{stem}.pdf"
        if target.exists() and not req.overwrite:
            return _conflict_response([str(target)], str(out_dir))
        out = plate.compose_pdf(
            target,
            req.plate_name, int(req.rows), int(req.cols),
            frames, dict(req.well_states), int(req.cell_px), req.footer,
            table_headers=list(req.table_headers),
            table_rows=[list(r) for r in req.table_rows],
        )
        return {"path": str(out), "wells": len(frames), "bytes": out.stat().st_size}
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(status_code=400, content={"error": _describe(e)})


@app.post("/api/projection")
def apply_projection(req: ProjectionRequest):
    """Project Z slices, save as OME-TIFF, and open in a new tab."""
    import tifffile

    try:
        results: list[dict] = []

        for img_id in req.image_ids:
            r = get_reader(img_id)
            meta = r.metadata

            # Determine output directory
            if req.output_dir:
                out_dir = os.path.expanduser(req.output_dir)
            elif meta.source_path and not meta.source_path.startswith(("/tmp", "/var", "/private/var", "/private/tmp")):
                out_dir = os.path.dirname(meta.source_path)
            else:
                out_dir = os.path.expanduser("~/Desktop")
            os.makedirs(out_dir, exist_ok=True)

            stem = os.path.splitext(meta.filename)[0]
            # Strip .ome if already present
            if stem.endswith(".ome"):
                stem = stem[:-4]
            z_to = req.z_to if req.z_to >= 0 else meta.num_z - 1
            z_from = max(0, min(req.z_from, meta.num_z - 1))
            z_to = max(z_from, min(z_to, meta.num_z - 1))
            t = min(req.t, meta.num_t - 1)

            # Project all channels: result shape (C, Y, X)
            projected = []
            for c in range(meta.num_channels):
                proj = r.get_projection(c, t, z_from, z_to, req.method)
                projected.append(proj)
            proj_stack = np.stack(projected, axis=0)  # (C, Y, X)
            h, w = proj_stack.shape[1], proj_stack.shape[2]

            # Build OME-XML
            ome_xml = _build_ome_xml(meta, meta.num_channels, h, w, req.method, z_from, z_to)

            # Save as OME-TIFF
            out_path = _next_suffix_path(out_dir, stem)
            tifffile.imwrite(out_path, proj_stack, photometric='minisblack',
                             description=ome_xml, metadata=None)

            # Load the saved file as a new image
            new_reader = ImageReader()
            new_reader.load_file(out_path)
            new_id = add_image(new_reader)

            results.append({
                "id": new_id,
                "path": out_path,
                "filename": os.path.basename(out_path),
                "metadata": new_reader.metadata.to_dict(),
            })

        return {"results": results}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


class ChannelSetting(BaseModel):
    """Per-channel export settings for one image."""
    channel: int                        # channel index in *that* image
    color: list[int] | None = None      # [R,G,B]; None → file colour, else white
    min: float | None = None            # None → auto-contrast this channel
    max: float | None = None


class SaveRequest(BaseModel):
    output_dir: str                # destination folder
    image_ids: list[str]           # which images to save
    # Defaults, used for any image without an image_channels entry.
    channels: list[int] = []       # which channels to include
    channel_colors: list[list[int]] = []  # [[R,G,B], ...] per selected channel
    channel_mins: list[float] = []      # contrast min per selected channel
    channel_maxs: list[float] = []      # contrast max per selected channel
    # Per-image overrides: id -> settings. Batch saves must not apply one image's
    # LUT/contrast (or channel count) to every other image.
    image_channels: dict[str, list[ChannelSetting]] = {}
    format: str = "tiff"           # tiff, png, jpeg
    save_separate: bool = True     # individual channel files
    save_merge: bool = True        # merged composite file
    z_mode: str = "current"        # "current" | "range" | "projection"
    z_from: int = 0                # inclusive (0-based), default for all images
    z_to: int = 0                  # inclusive (0-based), default for all images
    image_z_ranges: dict[str, list[int]] = {}  # per-image override: id -> [z_from, z_to] (0-based)
    projection_method: str = "max" # "max" | "min" | "avg"
    t_from: int = 0                # inclusive (0-based)
    t_to: int = 0                  # inclusive (0-based)
    current_z: int = 0
    current_t: int = 0
    #: Stem to save under, replacing the image's own filename. Only honoured for
    #: a single image; a batch keeps each image's name.
    basename: str = ""
    #: Replace files that are already there. Without it, a collision is reported
    #: with the names involved and nothing at all is written.
    overwrite: bool = False
    bit_depth_output: str = "16"   # "8" or "16" (16 only for TIFF)


def _apply_contrast_u8(data: np.ndarray, cmin: float, cmax: float) -> np.ndarray:
    """Apply contrast and convert to uint8."""
    rng = cmax - cmin
    if rng <= 0:
        rng = 1
    normed = (data.astype(np.float32) - cmin) / rng
    return (np.clip(normed, 0, 1) * 255).astype(np.uint8)


def _apply_contrast_u16(data: np.ndarray, cmin: float, cmax: float) -> np.ndarray:
    """Apply contrast and convert to uint16."""
    rng = cmax - cmin
    if rng <= 0:
        rng = 1
    normed = (data.astype(np.float32) - cmin) / rng
    return (np.clip(normed, 0, 1) * 65535).astype(np.uint16)


def _render_single(data: np.ndarray, color: list[int], cmin: float, cmax: float, as_16: bool) -> np.ndarray:
    """Render a single channel as an RGB image. Returns (H,W,3) uint8 or uint16."""
    rng = cmax - cmin
    if rng <= 0:
        rng = 1
    normed = np.clip((data.astype(np.float32) - cmin) / rng, 0, 1)
    r, g, b = color
    max_val = 65535 if as_16 else 255
    dtype = np.uint16 if as_16 else np.uint8
    h, w = data.shape
    out = np.zeros((h, w, 3), dtype=dtype)
    out[..., 0] = (normed * r / 255 * max_val).astype(dtype)
    out[..., 1] = (normed * g / 255 * max_val).astype(dtype)
    out[..., 2] = (normed * b / 255 * max_val).astype(dtype)
    return out


def _render_merge(slices: list[np.ndarray], colors: list[list[int]],
                  mins: list[float], maxs: list[float], as_16: bool) -> np.ndarray:
    """Additive merge of multiple channels. Returns (H,W,3)."""
    h, w = slices[0].shape
    max_val = 65535 if as_16 else 255
    dtype = np.uint16 if as_16 else np.uint8
    out = np.zeros((h, w, 3), dtype=np.float32)
    for data, color, cmin, cmax in zip(slices, colors, mins, maxs):
        rng = cmax - cmin
        if rng <= 0:
            rng = 1
        normed = np.clip((data.astype(np.float32) - cmin) / rng, 0, 1)
        r, g, b = color
        out[..., 0] += normed * r / 255
        out[..., 1] += normed * g / 255
        out[..., 2] += normed * b / 255
    return (np.clip(out, 0, 1) * max_val).astype(dtype)


_DEFAULT_CHANNEL_COLOR = [255, 255, 255]


def _resolve_channel_settings(req: SaveRequest, img_id: str, meta) -> tuple[list[ChannelSetting], list[int]]:
    """Channel settings for one image, dropping indices it does not have.

    Returns (settings, dropped channel indices). Falls back to the request-level
    defaults when the client sent no per-image entry.
    """
    raw = req.image_channels.get(img_id)
    if raw is None:
        raw = [
            ChannelSetting(
                channel=c,
                color=req.channel_colors[i] if i < len(req.channel_colors) else None,
                min=req.channel_mins[i] if i < len(req.channel_mins) else None,
                max=req.channel_maxs[i] if i < len(req.channel_maxs) else None,
            )
            for i, c in enumerate(req.channels)
        ]
        if not raw:
            # Nothing specified at all → every channel of this image, auto-contrast.
            raw = [ChannelSetting(channel=c) for c in range(meta.num_channels)]

    settings: list[ChannelSetting] = []
    dropped: list[int] = []
    for s in raw:
        if not 0 <= s.channel < meta.num_channels:
            dropped.append(s.channel)
            continue
        color = s.color if s.color and len(s.color) == 3 else None
        if color is None:
            file_color = (meta.channel_colors[s.channel]
                          if s.channel < len(meta.channel_colors) else None)
            color = list(file_color) if file_color and len(file_color) == 3 else _DEFAULT_CHANNEL_COLOR
        settings.append(ChannelSetting(
            channel=s.channel, color=[int(v) for v in color], min=s.min, max=s.max,
        ))
    return settings, dropped


#: How many conflicting names to name in the warning before summarising.
_CONFLICT_SHOWN = 12

_PROJ_LABEL = {"max": "MaxProj", "min": "MinProj", "avg": "AvgProj"}


def _zt_suffix(z_val, t_val, is_proj: bool, z_list: list, t_list: list,
               method: str) -> str:
    """The Z/T part of an export filename.

    Module level, and used by both the collision check and the write, so the
    name the user is warned about is the name that actually gets written. It was
    briefly a closure defined between the two passes, which is worse than
    duplication: the first pass raised UnboundLocalError and every save failed.
    """
    parts = []
    if is_proj:
        parts.append(_PROJ_LABEL.get(method, "Proj"))
    elif len(z_list) > 1:
        parts.append(f"Z{z_val:03d}")
    if len(t_list) > 1:
        parts.append(f"T{t_val:03d}")
    joined = "_".join(parts)
    return f"_{joined}" if joined else ""


def _conflicts(paths: list[str]) -> list[str]:
    """Which of these already exist, in order, without duplicates."""
    seen: set[str] = set()
    out: list[str] = []
    for p in paths:
        if p in seen:
            continue
        seen.add(p)
        if os.path.exists(p):
            out.append(p)
    return out


def _conflict_response(paths: list[str], out_dir: str) -> JSONResponse:
    """Refuse the write and say exactly what would have been replaced.

    Returned before anything is written, so answering "no" costs nothing and
    answering "yes" repeats the request with overwrite set. Earlier versions
    silently renamed a colliding export to `_01`, which loses nothing but is its
    own surprise: you ask for a file, get a differently-named one, and end up
    with a directory of near-duplicates you cannot tell apart.
    """
    shown = [os.path.basename(p) for p in paths[:_CONFLICT_SHOWN]]
    return JSONResponse(status_code=409, content={
        "conflict": True,
        "output_dir": out_dir,
        "count": len(paths),
        "files": shown,
        "more": max(0, len(paths) - len(shown)),
        "error": (f"{len(paths)} 個のファイルが既にあります。"
                  "上書きしてよければ「上書きする」を選んでください。"),
    })


#: Characters Windows rejects in a filename. macOS accepts * ? " < > | happily,
#: so a name built from file metadata or a plate's own title passes here and
#: fails on the user's machine — and for a plate PDF it fails at `save()`, after
#: every well has already been read and rendered. A trailing dot or space is
#: equally illegal there and equally silent here.
_ILLEGAL_NAME_CHARS = set('/\\:*?"<>|') | {chr(c) for c in range(32)}


def _safe_name_part(name: str) -> str:
    """Filename-safe fragment (channel names come straight from file metadata)."""
    cleaned = "".join(ch for ch in name if ch not in _ILLEGAL_NAME_CHARS)
    return cleaned.strip().rstrip(". ") or "Ch"


def _save_image_file(img_rgb: np.ndarray, fmt: str, filepath: str) -> str:
    """Save an RGB array to exactly this path. Returns the path written.

    No auto-suffixing: the caller has already established that overwriting here
    is intended, either because nothing was in the way or because the user said
    so. Renaming behind their back is what produced folders of `_01`, `_02`
    files that nobody could tell apart afterwards.
    """
    from PIL import Image as PILImage
    if fmt == "tiff":
        import tifffile
        tifffile.imwrite(filepath, img_rgb, photometric='rgb')
    elif fmt == "jpeg":
        pil = PILImage.fromarray(img_rgb.astype(np.uint8) if img_rgb.dtype != np.uint8 else img_rgb)
        pil.save(filepath, format="JPEG", quality=95)
    else:  # png
        pil = PILImage.fromarray(img_rgb.astype(np.uint8) if img_rgb.dtype != np.uint8 else img_rgb)
        pil.save(filepath, format="PNG")
    return filepath


class RenderImage(BaseModel):
    name: str          # filename suffix, e.g. "merge" or a channel name
    width: int
    height: int
    data_b64: str      # raw RGBA8, row-major, top row first


class SaveRenderRequest(BaseModel):
    output_dir: str
    basename: str
    format: str = "png"          # "png" | "tiff"
    images: list[RenderImage]
    #: Replace files that are already there. Without it a collision is reported
    #: and nothing is written, so the user gets to decide.
    overwrite: bool = False


@app.post("/api/save-render")
def save_render(req: SaveRenderRequest):
    """Write already-rendered frames (e.g. the 3D view) to the output folder.

    The client sends what it drew, so the file matches the on-screen result
    exactly; the alpha channel is dropped since these are composited on black.
    """
    try:
        if req.format not in ("png", "tiff"):
            raise RuntimeError(f"Unsupported format: {req.format}")
        if not req.images:
            raise RuntimeError("No images to save")

        out_dir = os.path.expanduser(req.output_dir)
        if not out_dir:
            raise RuntimeError("No output folder specified")
        os.makedirs(out_dir, exist_ok=True)

        ext = ".tif" if req.format == "tiff" else ".png"
        stem = _safe_name_part(os.path.splitext(req.basename or "render")[0])

        # Every destination is known from the names alone, so the collision
        # check happens before any pixels are decoded or written — a refusal
        # leaves the folder exactly as it was.
        usable = [i for i in req.images if i.width > 0 and i.height > 0]
        targets = [
            os.path.join(out_dir, f"{stem}_3D_{_safe_name_part(i.name)}{ext}")
            for i in usable
        ]
        if not req.overwrite:
            clash = _conflicts(targets)
            if clash:
                return _conflict_response(clash, out_dir)

        saved: list[str] = []
        for img in usable:
            raw = base64.b64decode(img.data_b64)
            expected = img.width * img.height * 4
            if len(raw) != expected:
                raise RuntimeError(
                    f"{img.name}: expected {expected} bytes of RGBA, got {len(raw)}"
                )
            rgba = np.frombuffer(raw, dtype=np.uint8).reshape(img.height, img.width, 4)
            rgb = np.ascontiguousarray(rgba[..., :3])
            fname = f"{stem}_3D_{_safe_name_part(img.name)}{ext}"
            saved.append(_save_image_file(rgb, req.format, os.path.join(out_dir, fname)))

        if not saved:
            raise RuntimeError("Nothing was written")
        return {"saved": saved, "output_dir": out_dir}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@app.post("/api/save")
def save_images(req: SaveRequest):
    """Save images directly to the specified output folder."""
    try:
        ext = {"tiff": ".tif", "png": ".png", "jpeg": ".jpg"}[req.format]
        as_16 = req.format == "tiff" and req.bit_depth_output == "16"

        # Validate output directory
        out_dir = os.path.expanduser(req.output_dir)
        os.makedirs(out_dir, exist_ok=True)

        # Fallback: if no valid IDs, use active image
        image_ids = req.image_ids
        if not image_ids or all(i not in images for i in image_ids):
            if active_id:
                image_ids = [active_id]
            else:
                raise RuntimeError("No image loaded")

        saved_files: list[str] = []
        skipped: list[str] = []
        #: Every destination this request will write, gathered before any of it
        #: happens so the whole export can be refused as one.
        planned: list[str] = []
        #: Per-image state carried from the planning pass to the writing pass.
        pending: list[tuple] = []
        for img_id in image_ids:
            # A stale id (image closed while the dialog was open) must not abort
            # the batch after some files have already been written.
            if img_id not in images:
                skipped.append(f"{img_id}: image is no longer open")
                continue
            r = get_reader(img_id)
            meta = r.metadata
            # A typed name replaces the file's own, but only when saving one
            # image: across a batch it would collapse every image onto the same
            # set of filenames, and the per-image subfolder is what keeps them
            # apart rather than the name.
            if req.basename and len(image_ids) == 1:
                basename = _safe_name_part(os.path.splitext(req.basename)[0]) or "image"
            else:
                basename = os.path.splitext(os.path.basename(meta.filename))[0] or "image"

            # Each image exports with its own channel set / LUT / contrast.
            settings, dropped = _resolve_channel_settings(req, img_id, meta)
            if dropped:
                skipped.append(
                    f"{meta.filename}: channel(s) {', '.join(str(d) for d in sorted(set(dropped)))} "
                    f"not present (image has {meta.num_channels})"
                )
            if not settings:
                skipped.append(f"{meta.filename}: no matching channel to save")
                continue

            # For batch: create subfolder per image
            if len(image_ids) > 1:
                img_dir = os.path.join(out_dir, basename)
                os.makedirs(img_dir, exist_ok=True)
            else:
                img_dir = out_dir

            # Resolve per-image Z range, tolerating a malformed override entry
            img_z_from, img_z_to = req.z_from, req.z_to
            zr = req.image_z_ranges.get(img_id)
            if zr is not None and len(zr) >= 2:
                img_z_from, img_z_to = zr[0], zr[1]

            # Clamp to this image's extent and tolerate From > To
            n_z = max(1, meta.num_z)
            n_t = max(1, meta.num_t)
            img_z_from, img_z_to = sorted((img_z_from, img_z_to))
            img_z_from = max(0, min(img_z_from, n_z - 1))
            img_z_to = max(img_z_from, min(img_z_to, n_z - 1))

            # Determine Z and T iteration ranges
            if req.z_mode == "projection":
                z_list = ["proj"]  # special marker
            elif req.z_mode == "range":
                z_list = list(range(img_z_from, img_z_to + 1))
            else:  # "current"
                z_list = [max(0, min(req.current_z, n_z - 1))]

            t_from, t_to = sorted((req.t_from, req.t_to))
            t_from = max(0, min(t_from, n_t - 1))
            t_to = max(t_from, min(t_to, n_t - 1))
            t_list = list(range(t_from, t_to + 1))

            # Names depend on nothing but the settings, so every destination for
            # this image is known before a single plane is read. Collected here
            # and checked across all images before anything is written, so a
            # refusal cannot leave a half-finished export behind.
            for t_val in t_list:
                for z_val in z_list:
                    zt = _zt_suffix(z_val, t_val, z_val == "proj",
                                    z_list, t_list, req.projection_method)
                    if req.save_separate:
                        for s in settings:
                            raw = (meta.channel_names[s.channel]
                                   if s.channel < len(meta.channel_names) else f"Ch{s.channel}")
                            planned.append(
                                os.path.join(img_dir, f"{basename}_{_safe_name_part(raw)}{zt}{ext}"))
                    if req.save_merge and settings:
                        planned.append(os.path.join(img_dir, f"{basename}_merge{zt}{ext}"))
            pending.append((img_id, r, meta, settings, basename, img_dir,
                            z_list, t_list, img_z_from, img_z_to))

        if not req.overwrite:
            clash = _conflicts(planned)
            if clash:
                return _conflict_response(clash, out_dir)

        for (img_id, r, meta, settings, basename, img_dir,
             z_list, t_list, img_z_from, img_z_to) in pending:

            def write(img_rgb: np.ndarray, name: str, _dir: str = img_dir) -> None:
                """Save into this image's folder at exactly the planned name."""
                path = os.path.join(_dir, name)
                saved_files.append(_save_image_file(img_rgb, req.format, path))

            for t_val in t_list:
                for z_val in z_list:
                    is_proj = z_val == "proj"
                    z_idx = 0 if is_proj else z_val

                    zt_suffix = _zt_suffix(z_val, t_val, is_proj,
                                           z_list, t_list, req.projection_method)

                    # Get slice data and contrast for each selected channel
                    ch_slices: list[np.ndarray] = []
                    ch_colors: list[list[int]] = []
                    ch_mins: list[float] = []
                    ch_maxs: list[float] = []
                    for s in settings:
                        if is_proj:
                            sl = r.get_projection(s.channel, t_val, img_z_from, img_z_to,
                                                  req.projection_method)
                        else:
                            sl = r.get_slice(s.channel, z_idx, t_val)
                        cmin, cmax = s.min, s.max
                        if cmin is None or cmax is None:
                            auto_lo, auto_hi = auto_contrast(sl)
                            cmin = auto_lo if cmin is None else cmin
                            cmax = auto_hi if cmax is None else cmax
                        ch_slices.append(sl)
                        ch_colors.append(s.color or _DEFAULT_CHANNEL_COLOR)
                        ch_mins.append(float(cmin))
                        ch_maxs.append(float(cmax))

                    # Save separate channel images
                    if req.save_separate:
                        for idx, s in enumerate(settings):
                            c = s.channel
                            raw_name = meta.channel_names[c] if c < len(meta.channel_names) else f"Ch{c}"
                            ch_name = _safe_name_part(raw_name)
                            rgb = _render_single(ch_slices[idx], ch_colors[idx],
                                                 ch_mins[idx], ch_maxs[idx], as_16)
                            write(rgb, f"{basename}_{ch_name}{zt_suffix}{ext}")

                    # Save merged image
                    if req.save_merge and len(ch_slices) > 0:
                        merged = _render_merge(ch_slices, ch_colors, ch_mins, ch_maxs, as_16)
                        write(merged, f"{basename}_merge{zt_suffix}{ext}")

        return {
            "saved": saved_files,
            "output_dir": out_dir,
            "skipped": skipped,
        }
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


def _pick_port(preferred: int) -> int:
    """Return `preferred` if free, otherwise the next available port."""
    import socket
    for port in range(preferred, preferred + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return preferred  # give up; let uvicorn surface the bind error


def _frontend_dist() -> str | None:
    """Locate the built frontend, if this build ships one.

    A packaged app has no Vite dev server, so the backend serves the bundle
    itself: one process on one port, same-origin API calls, and therefore no
    CORS surface at all. In development this returns None (unless the bundle has
    been built) and the Vite proxy keeps doing its job.
    """
    candidates: list[str] = []
    env = os.environ.get("OIR_FRONTEND_DIST")
    if env:
        candidates.append(env)
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(os.path.join(meipass, "frontend_dist"))
    if getattr(sys, "frozen", False):
        candidates.append(os.path.join(os.path.dirname(sys.executable), "frontend_dist"))
    here = os.path.dirname(os.path.abspath(__file__))
    candidates.append(os.path.join(here, "..", "frontend", "dist"))

    for c in candidates:
        index = os.path.join(c, "index.html")
        if os.path.isfile(index):
            return os.path.abspath(c)
    return None


def _mount_frontend() -> None:
    """Serve the built frontend at / — must run after the /api routes exist."""
    dist = _frontend_dist()
    if not dist:
        return
    from fastapi.staticfiles import StaticFiles
    # html=True makes unknown paths fall back to index.html (SPA routing).
    app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
    print(f"Serving frontend from {dist}", flush=True)


def start_server():
    """Start the FastAPI server.

    Port resolution order:
      1. $OIR_BACKEND_PORT if set (hard requirement — no fallback scan)
      2. 8765, or the next free port if 8765 is taken
    The chosen port is written to ../frontend/.backend-port so the Vite dev
    proxy can target it, and printed for any external launcher to read.
    """
    env_port = os.environ.get("OIR_BACKEND_PORT")
    if env_port:
        port = int(env_port)
    else:
        port = _pick_port(8765)

    # Publish the chosen port for the frontend dev proxy.
    try:
        port_file = os.path.join(os.path.dirname(__file__), "..", "frontend", ".backend-port")
        with open(os.path.abspath(port_file), "w") as f:
            f.write(str(port))
    except OSError:
        pass

    _mount_frontend()
    print(f"OIR Viewer backend listening on http://127.0.0.1:{port}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


def _log_environment() -> None:
    """Describe this build at the top of the shell's log file.

    The shell records everything the backend prints (see desktop/main.js), so a
    report can start from the log rather than from a round of questions: which
    encodings the streams ended up with, and whether a Java runtime was found
    at all — a jvm library or a formats-gpl jar missing here is the difference
    between "this file will not open" and "no file will ever open".
    """
    print(f"OIR Viewer backend | {sys.platform} | python {sys.version.split()[0]}"
          f" | frozen={bool(getattr(sys, 'frozen', False))}", flush=True)
    print(f"stdout encoding: {getattr(sys.stdout, 'encoding', '?')}"
          f" | filesystem: {sys.getfilesystemencoding()}", flush=True)
    print(f"java runtime: {describe_runtime()}", flush=True)


def main():
    """Launch as desktop app with pywebview, or standalone server.

    A packaged build is always server-only: the Electron shell owns the window
    and spawns this executable with no arguments, so it must not try to open a
    pywebview window of its own.
    """
    _log_environment()
    # A build that cannot reach Bio-Formats — or cannot write a PDF — must fail
    # the pipeline, not the user. Both walk their real path rather than checking
    # that an import succeeded: Pillow loads its codecs lazily and resolves fonts
    # against the OS, so PDF export can be broken in a frozen build that imports
    # PIL fine. Reported together, so one run names every problem.
    if "--selftest" in sys.argv:
        rc = selftest()
        rc_plate = plate.selftest()
        rc_session = _selftest_session()
        raise SystemExit(rc or rc_plate or rc_session)
    use_webview = "--no-webview" not in sys.argv and not getattr(sys, "frozen", False)
    if use_webview:
        try:
            import webview

            server_thread = threading.Thread(target=start_server, daemon=True)
            server_thread.start()

            webview.create_window(
                "OIR Viewer",
                "http://localhost:5173",
                width=1400,
                height=900,
                min_size=(1000, 700),
            )
            webview.start()
        except ImportError:
            print("pywebview not installed. Starting server only.")
            start_server()
    else:
        start_server()


if __name__ == "__main__":
    main()
