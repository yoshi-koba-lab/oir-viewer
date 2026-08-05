"""OIR Viewer Backend - FastAPI server with pywebview integration."""

from __future__ import annotations

import sys
import os
import tempfile
import threading
import base64
import uuid

import numpy as np
import uvicorn
from contextlib import asynccontextmanager
from fastapi import FastAPI, Query, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from reader import ImageReader
from processor import adjust_contrast, auto_contrast, compute_histogram, to_png_bytes
from roi import line_profile, measure_roi

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
        entries = [
            {"source_path": r.metadata.source_path, "filename": r.metadata.filename}
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
    """Re-open files recorded in the last session. Returns how many were restored."""
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
            r = ImageReader()
            r.load_file(path)
            add_image(r)
            restored += 1
        except Exception as e:
            print(f"Session restore skipped {path}: {e}")
    return restored


@asynccontextmanager
async def lifespan(app: FastAPI):
    """App lifespan: restore the previous session, or load dummy data for dev."""
    restored = _restore_session()
    if restored:
        print(f"Restored {restored} image(s) from previous session")
    else:
        r = ImageReader()
        r.load_dummy()
        add_image(r)
        print("No session to restore — loaded dummy data")
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


def get_reader(image_id: str | None = None) -> ImageReader:
    """Get the reader for a given image ID, or the active one."""
    rid = image_id or active_id
    if rid is None or rid not in images:
        raise RuntimeError("No image loaded")
    return images[rid]


def add_image(reader: ImageReader) -> str:
    """Register a reader and return its ID."""
    global active_id
    img_id = uuid.uuid4().hex[:8]
    images[img_id] = reader
    active_id = img_id
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
async def activate_image(image_id: str):
    """Set an image as active."""
    global active_id
    if image_id not in images:
        return JSONResponse(status_code=404, content={"error": "Image not found"})
    active_id = image_id
    return images[image_id].metadata.to_dict()


@app.delete("/api/images/{image_id}")
async def close_image(image_id: str):
    """Close and remove an image."""
    global active_id
    if image_id not in images:
        return JSONResponse(status_code=404, content={"error": "Image not found"})
    del images[image_id]
    if active_id == image_id:
        active_id = next(iter(images), None)
    _save_session()
    return {"closed": image_id, "active_id": active_id}


@app.get("/api/open")
def open_file(path: str = Query(...)):
    """Open an image file by path."""
    try:
        r = ImageReader()
        r.load_file(path)
        img_id = add_image(r)
        return {**r.metadata.to_dict(), "id": img_id}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


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
        return JSONResponse(status_code=400, content={"error": str(e)})


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
            xy_max = max(h, w)
            max_dim = max(32, min(max_dim, 2048))
            scale_xy = max_dim / xy_max if xy_max > max_dim else 1.0
            scale_z = 128 / n_z if n_z > 128 else 1.0

        out_h = int(round(h * scale_xy))
        out_w = int(round(w * scale_xy))
        out_z = int(round(n_z * scale_z))
        send_c = max(1, min(n_c, max_ch))

        levels: list[tuple[int, int]] = []
        planes: list[bytes] = []
        for c in range(send_c):
            ch_vol = vol[c]  # (Z, Y, X) uint16
            if scale_xy != 1.0 or scale_z != 1.0:
                ch_vol = ndzoom(ch_vol.astype(np.float32),
                                (scale_z, scale_xy, scale_xy),
                                order=1).clip(0, 65535).astype(np.uint16)

            low, high = auto_contrast(ch_vol.ravel())
            rng = max(float(high - low), 1.0)
            normed = ((ch_vol.astype(np.float32) - low) / rng).clip(0, 1)
            planes.append(np.ascontiguousarray((normed * 255).astype(np.uint8)).tobytes())
            levels.append((int(low), int(high)))

        header = np.array([send_c, out_z, out_h, out_w,
                           n_c, n_z, h, w], dtype="<u4").tobytes()
        meta = np.array(levels, dtype="<i4").tobytes()
        return Response(content=header + meta + b"".join(planes),
                        media_type="application/octet-stream")
    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse(status_code=400, content={"error": str(e)})


@app.get("/api/choose-folder")
def choose_folder():
    """Open native macOS folder picker dialog."""
    import subprocess
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

        # tkinter runs in this process, and a GUI toolkit must own the main
        # thread on some platforms — so do it in a child process.
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


def _free_path(filepath: str) -> str:
    """filepath, or its next free _NN variant so an existing export survives."""
    if not os.path.exists(filepath):
        return filepath
    stem, ext = os.path.splitext(filepath)
    if stem.endswith(".ome"):
        stem, ext = stem[:-4], ".ome" + ext
    idx = 1
    while True:
        candidate = f"{stem}_{idx:02d}{ext}"
        if not os.path.exists(candidate):
            return candidate
        idx += 1


def _safe_name_part(name: str) -> str:
    """Filename-safe fragment (channel names come straight from file metadata)."""
    cleaned = "".join(ch for ch in name if ch not in '/\\:\0').strip()
    return cleaned or "Ch"


def _save_image_file(img_rgb: np.ndarray, fmt: str, filepath: str) -> str:
    """Save RGB array to a file, auto-suffixing rather than overwriting.

    Returns the path actually written, which the caller reports to the UI.
    """
    from PIL import Image as PILImage
    filepath = _free_path(filepath)
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

        saved: list[str] = []
        for img in req.images:
            if img.width <= 0 or img.height <= 0:
                continue
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
        renamed: list[dict[str, str]] = []
        skipped: list[str] = []
        for img_id in image_ids:
            # A stale id (image closed while the dialog was open) must not abort
            # the batch after some files have already been written.
            if img_id not in images:
                skipped.append(f"{img_id}: image is no longer open")
                continue
            r = get_reader(img_id)
            meta = r.metadata
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

            def write(img_rgb: np.ndarray, name: str, _dir: str = img_dir) -> None:
                """Save into this image's folder, never clobbering an earlier export."""
                wanted = os.path.join(_dir, name)
                written = _save_image_file(img_rgb, req.format, wanted)
                saved_files.append(written)
                if written != wanted:
                    renamed.append({"requested": wanted, "written": written})

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

            for t_val in t_list:
                for z_val in z_list:
                    is_proj = z_val == "proj"
                    z_idx = 0 if is_proj else z_val

                    # Build suffix for Z/T
                    parts = []
                    if is_proj:
                        method_label = {"max": "MaxProj", "min": "MinProj", "avg": "AvgProj"}
                        parts.append(method_label.get(req.projection_method, "Proj"))
                    elif len(z_list) > 1:
                        parts.append(f"Z{z_val:03d}")
                    if len(t_list) > 1:
                        parts.append(f"T{t_val:03d}")
                    zt_suffix = "_".join(parts)
                    if zt_suffix:
                        zt_suffix = "_" + zt_suffix

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
            "renamed": renamed,
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


def main():
    """Launch as desktop app with pywebview, or standalone server.

    A packaged build is always server-only: the Electron shell owns the window
    and spawns this executable with no arguments, so it must not try to open a
    pywebview window of its own.
    """
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
