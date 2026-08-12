"""OIR Viewer Backend - FastAPI server with pywebview integration."""

from __future__ import annotations

import sys
import os
import tempfile
import threading
import shutil
import hashlib
import base64
import traceback
import uuid
import unicodedata
import operator
from collections.abc import Callable, Iterator


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
from contextlib import asynccontextmanager, contextmanager
import json
import math
import re
import time
from fastapi import FastAPI, Query, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from reader import (
    ImageMetadata, ImageReader, describe_runtime, prewarm_jvm as _prewarm_jvm, selftest,
)
from source_state import snapshot_source
from processor import (
    adjust_contrast, auto_contrast, auto_contrast_from_counts, compute_histogram,
    to_png_bytes,
)
from roi import line_profile, measure_roi
import plate
import view_settings

# Multi-image state: id -> ImageReader
images: dict[str, ImageReader] = {}
active_id: str | None = None

# Persistent app data (uploads and view settings survive restarts; the session
# file is retained for diagnostics, but startup deliberately begins fresh).
APP_DIR = os.path.join(os.path.expanduser("~"), ".oir-viewer")
UPLOADS_DIR = os.path.join(APP_DIR, "uploads")
SESSION_FILE = os.path.join(APP_DIR, "session.json")
VIEW_SETTINGS_FILE = os.path.join(APP_DIR, "view-settings.json")
_view_settings_store = view_settings.ViewSettingsStore(VIEW_SETTINGS_FILE)


def _save_session() -> None:
    """Persist open-file metadata for explicit diagnostics, not auto-startup."""
    import json
    tmp_path = ""
    try:
        os.makedirs(APP_DIR, exist_ok=True)
        # The API can open or close another image while an export registers its
        # results. Freeze the metadata references before doing filesystem I/O;
        # iterating the live dictionary here can otherwise fail after the files
        # have already been published.
        with _state_lock:
            metadata = [reader.metadata for reader in images.values()]
        # Dimensions travel with the path for an explicit legacy/diagnostic
        # restore; normal startup intentionally writes an empty list first.
        entries = [
            {
                "source_path": meta.source_path, "filename": meta.filename,
                "source_identity": meta.source_identity,
                "source_revision": meta.source_revision,
                "num_channels": meta.num_channels, "num_z": meta.num_z,
                "num_t": meta.num_t,
                "width": meta.width, "height": meta.height,
            }
            for meta in metadata
            if meta.source_path and os.path.exists(meta.source_path)
        ]
        # Write-then-rename: truncating session.json in place leaves a corrupt file
        # if the write is interrupted, which then breaks an explicit diagnostic.
        with tempfile.NamedTemporaryFile(
            "w", dir=APP_DIR, prefix=".session-", suffix=".tmp", delete=False
        ) as f:
            tmp_path = f.name
            json.dump({"images": entries}, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, SESSION_FILE)
    except Exception as e:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        print(f"Session save skipped: {type(e).__name__}: {e}", flush=True)


def _restore_session() -> int:
    """Re-list the files from the last session for explicit diagnostics/tests.

    Normal application startup does not call this function. Returns how many
    deferred readers were registered when an explicit caller requests it.

    Nothing is read here. This legacy path remains only for explicit tests or
    diagnostics that need to inspect deferred-reader behavior; the application
    lifespan never calls it.
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
    seen_sources: set[tuple[str, str]] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        path = entry.get("source_path")
        if not path or not os.path.exists(path):
            continue
        try:
            current_source = snapshot_source(path)
            saved_identity = str(entry.get("source_identity") or "")
            saved_revision = str(entry.get("source_revision") or "")
            if ((saved_identity and saved_identity != current_source.identity)
                    or (saved_revision and saved_revision != current_source.revision)):
                print(f"Session restore skipped changed source: {path}")
                continue
            source_key = (current_source.identity, current_source.revision)
            if source_key in seen_sources:
                print(f"Session restore skipped duplicate source: {path}")
                continue
            meta = ImageMetadata(
                filename=entry.get("filename") or os.path.basename(path),
                source_path=path,
                source_identity=current_source.identity,
                source_revision=current_source.revision,
                num_channels=int(entry.get("num_channels") or 1),
                num_z=int(entry.get("num_z") or 1),
                num_t=int(entry.get("num_t") or 1),
                width=int(entry.get("width") or 0),
                height=int(entry.get("height") or 0),
            )
            r = ImageReader()
            r.defer(path, meta)
            add_image(r)
            seen_sources.add(source_key)
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
    global images, active_id, _lru, IMAGE_BUDGET_BYTES
    global APP_DIR, UPLOADS_DIR, SESSION_FILE
    import asyncio
    import json
    import tempfile

    saved_images, saved_active, saved_lru = images, active_id, _lru
    saved_budget = IMAGE_BUDGET_BYTES
    saved_app_dir, saved_uploads, saved_file = APP_DIR, UPLOADS_DIR, SESSION_FILE
    try:
        with tempfile.TemporaryDirectory() as tmp:
            # Paths that exist and could be opened, so restore has no excuse to
            # skip them: the point is that it declines to read either one until
            # its authoritative metadata is requested.
            targets = [os.path.join(tmp, f"well-{i}.ome.tif") for i in range(2)]
            import tifffile
            for i, target in enumerate(targets):
                tifffile.imwrite(
                    target,
                    np.full((4, 32, 32), i, dtype=np.uint16),
                    ome=True,
                    metadata={
                        "axes": "ZYX",
                        "PhysicalSizeX": 0.5 + i * 0.1,
                        "PhysicalSizeY": 0.6 + i * 0.1,
                        "PhysicalSizeZ": 2.7 + i * 0.1,
                    },
                )
            APP_DIR = os.path.join(tmp, "app")
            UPLOADS_DIR = os.path.join(APP_DIR, "uploads")
            SESSION_FILE = os.path.join(APP_DIR, "session.json")
            os.makedirs(UPLOADS_DIR)
            with open(SESSION_FILE, "w") as f:
                entries = [
                    {
                        "source_path": target,
                        "filename": os.path.basename(target),
                        "num_channels": 1, "num_z": 4, "num_t": 1,
                        "width": 32, "height": 32,
                    }
                    for target in targets
                ]
                # A duplicate tab can be left by an older Plate retry. Restoring
                # it would give one source two in-memory settings snapshots, so a
                # reset in one tab could be silently resurrected by the other.
                entries.append(dict(entries[0]))
                json.dump({"images": entries}, f)
            images, active_id, _lru = {}, None, []
            # Exactly one of these small test images. Loading the second through
            # /api/metadata must evict the first under the ordinary pixel budget.
            IMAGE_BUDGET_BYTES = 4 * 32 * 32 * np.dtype(np.uint16).itemsize
            n = _restore_session()
            resident_before = sum(r.loaded_bytes for r in images.values())
            listed = [r.metadata.num_z for r in images.values()]
            api_list = asyncio.run(list_images())
            ids = list(images)
            # Make the placeholder visibly different from the file, including a
            # scalar field, so this catches returning a dimensions-only cache.
            for reader in images.values():
                reader.metadata.bit_depth = 1

            first_meta = get_metadata(ids[0])
            resident_after_first = [images[i].loaded_bytes for i in ids]
            second_meta = get_metadata(ids[1])
            resident_after_second = [images[i].loaded_bytes for i in ids]

            # The first reader now has no pixels but still owns real metadata.
            # Asking for it again must not re-read it or disturb the resident
            # second reader merely to answer channel names and physical sizes.
            repeated_first = get_metadata(ids[0])
            resident_after_repeat = [images[i].loaded_bytes for i in ids]
            reopened = open_file(targets[0])
            dedup_open_ok = (isinstance(reopened, dict)
                             and reopened.get("id") == ids[0]
                             and reopened.get("reused") is True
                             and len(images) == 2)
    except Exception as e:
        print(f"selftest FAILED: session restore -> {type(e).__name__}: {e}", flush=True)
        return 20
    finally:
        images, active_id, _lru = saved_images, saved_active, saved_lru
        IMAGE_BUDGET_BYTES = saved_budget
        APP_DIR, UPLOADS_DIR, SESSION_FILE = saved_app_dir, saved_uploads, saved_file

    if n != 2:
        print(f"selftest FAILED: restored {n} images, expected 2", flush=True)
        return 21
    if not dedup_open_ok:
        print("selftest FAILED: opening an already-open source created a duplicate tab",
              flush=True)
        return 21
    if resident_before:
        print(f"selftest FAILED: restore read {resident_before} bytes of pixels; "
              "startup must not decode last session's files", flush=True)
        return 22
    if listed != [4, 4]:
        print(f"selftest FAILED: restored tab lost its dimensions ({listed})", flush=True)
        return 23
    if (len(api_list) != 2 or any(
            item.get("width") != 32 or item.get("height") != 32
            for item in api_list)):
        print(f"selftest FAILED: /api/images lost restored dimensions ({api_list})",
              flush=True)
        return 23
    if (not isinstance(first_meta, dict) or first_meta.get("channel_names") != ["Ch0"]
            or not np.isclose(first_meta.get("pixel_size_x", 0), 0.5)
            or not np.isclose(first_meta.get("pixel_size_y", 0), 0.6)
            or not np.isclose(first_meta.get("pixel_size_z", 0), 2.7)
            or first_meta.get("bit_depth") != 16):
        print(f"selftest FAILED: /api/metadata returned cached placeholder ({first_meta})",
              flush=True)
        return 24
    if (not isinstance(second_meta, dict) or second_meta.get("channel_names") != ["Ch0"]
            or not np.isclose(second_meta.get("pixel_size_x", 0), 0.6)
            or not np.isclose(second_meta.get("pixel_size_y", 0), 0.7)
            or not np.isclose(second_meta.get("pixel_size_z", 0), 2.8)
            or second_meta.get("bit_depth") != 16):
        print(f"selftest FAILED: second metadata upgrade was wrong ({second_meta})",
              flush=True)
        return 24
    one_image = 4 * 32 * 32 * np.dtype(np.uint16).itemsize
    if (resident_after_first != [one_image, 0]
            or resident_after_second != [0, one_image]
            or resident_after_repeat != resident_after_second):
        print("selftest FAILED: metadata upgrade bypassed the pixel budget "
              f"({resident_after_first}, {resident_after_second}, "
              f"{resident_after_repeat})", flush=True)
        return 25
    if (not isinstance(repeated_first, dict)
            or not np.isclose(repeated_first.get("pixel_size_z", 0), 2.7)):
        print(f"selftest FAILED: evicted reader lost authoritative metadata "
              f"({repeated_first})", flush=True)
        return 24
    print(f"selftest: session restore OK (0 pixel bytes, budget "
          f"{IMAGE_BUDGET_BYTES / 1024 ** 3:.1f} GB; metadata upgraded one at a time)",
          flush=True)
    return (_selftest_export_targets()
            or _selftest_export_job_progress()
            or _selftest_memory_heavy_reservation()
            or _selftest_plate_volume_reservation()
            or _selftest_volume_memory_plan()
            or view_settings.selftest()
            or _selftest_view_settings_api())


def _start_fresh_session() -> int:
    """Start with no open files, never with remembered files.

    The previous startup path called ``_restore_session`` here, which made the
    last set of tabs reappear every time the application launched.  Session
    persistence remains available for view settings and explicit file
    operations, but opening the application itself now starts from a clean
    image list and lets the frontend show its Welcome screen.
    """
    global images, active_id, _lru
    with _state_lock:
        # Drop all references atomically so a re-entrant test or embedded
        # server cannot observe a half-cleared tab list. Releasing the dict
        # also makes any resident pixel arrays eligible for collection.
        images = {}
        active_id = None
        _lru = []
    _save_session()
    return 0


def _selftest_fresh_startup() -> int:
    """Ensure the app lifespan does not call the previous-session restore path."""
    global APP_DIR, SESSION_FILE, images, active_id, _lru
    import asyncio
    import json
    import tempfile

    saved_images, saved_active, saved_lru = images, active_id, _lru
    saved_app_dir, saved_session_file = APP_DIR, SESSION_FILE
    saved_restore = _restore_session
    saved_prewarm = _prewarm_jvm
    restore_called = False

    def forbidden_restore() -> int:
        nonlocal restore_called
        restore_called = True
        raise AssertionError("startup attempted to restore the previous session")

    async def probe() -> None:
        async with lifespan(app):
            return

    try:
        with tempfile.TemporaryDirectory() as tmp:
            APP_DIR = os.path.join(tmp, "app")
            SESSION_FILE = os.path.join(APP_DIR, "session.json")
            os.makedirs(APP_DIR)
            with open(SESSION_FILE, "w") as f:
                json.dump({"images": [{"source_path": "/old/session.oir"}]}, f)

            old_reader = ImageReader()
            old_reader.metadata = ImageMetadata(
                filename="old-session.oir", source_path="/old/session.oir",
                num_channels=1, num_z=1, num_t=1, width=2, height=2,
            )
            old_reader.data = np.ones((1, 1, 1, 2, 2), dtype=np.uint16)
            images, active_id, _lru = {"old": old_reader}, "old", ["old"]

            globals()["_restore_session"] = forbidden_restore
            globals()["_prewarm_jvm"] = lambda: None
            asyncio.run(probe())

            listed = asyncio.run(list_images())
            with open(SESSION_FILE) as f:
                persisted = json.load(f)
            if restore_called:
                raise AssertionError("startup called the previous-session restore path")
            if images or active_id is not None or _lru:
                raise AssertionError(
                    f"fresh startup retained images: {list(images)}, active={active_id}, lru={_lru}"
                )
            if listed:
                raise AssertionError(f"fresh startup exposed images: {listed}")
            if persisted != {"images": []}:
                raise AssertionError(f"fresh startup did not clear session file: {persisted}")
    except Exception as exc:
        print(f"selftest FAILED: fresh startup -> {type(exc).__name__}: {exc}", flush=True)
        return 26
    finally:
        globals()["_restore_session"] = saved_restore
        globals()["_prewarm_jvm"] = saved_prewarm
        APP_DIR, SESSION_FILE = saved_app_dir, saved_session_file
        images, active_id, _lru = saved_images, saved_active, saved_lru

    print("selftest: fresh startup OK (empty image list; previous session is not auto-restored)", flush=True)
    return 0


@asynccontextmanager
async def lifespan(app: FastAPI):
    """App lifespan: start a fresh image list on every application launch."""
    # Daemon thread: the JVM's cold start is seconds long and must not delay the
    # port line the shell is waiting on, nor keep the process alive at exit.
    threading.Thread(target=_prewarm_jvm, name="jvm-prewarm", daemon=True).start()
    _start_fresh_session()
    print("Started with an empty image list; previous session was not restored")
    yield
    # (no shutdown cleanup needed — session is persisted incrementally)


app = FastAPI(title="OIR Viewer", lifespan=lifespan)


# Export jobs expose progress from completed backend work, never from a timer.
# The ordinary synchronous routes remain available for compatibility and tests;
# the desktop UI uses these bounded, short-lived records for long saves.
_EXPORT_JOBS: dict[str, dict] = {}
_EXPORT_JOBS_LOCK = threading.Lock()
_EXPORT_JOB_LOCAL = threading.local()
_EXPORT_JOB_TTL_S = 60 * 60
_EXPORT_JOB_MAX_ACTIVE = 2
_EXPORT_JOB_MAX_RECORDS = 128


def _export_progress(
    phase: str, completed: int, total: int, label: str,
) -> None:
    callback = getattr(_EXPORT_JOB_LOCAL, "progress", None)
    if callback is not None:
        callback(phase, completed, total, label)


def _response_body(value) -> tuple[int, dict]:
    if isinstance(value, JSONResponse):
        try:
            body = json.loads(bytes(value.body).decode("utf-8"))
        except Exception:
            body = {"error": "保存処理の応答を読み取れませんでした。"}
        return int(value.status_code), body if isinstance(body, dict) else {"error": str(body)}
    if isinstance(value, dict):
        return 200, value
    return 500, {"error": "保存処理が不正な応答を返しました。"}


def _purge_export_jobs(now: float) -> None:
    expired = [
        job_id for job_id, job in _EXPORT_JOBS.items()
        if job.get("done") and now - float(job.get("updated_at", now)) > _EXPORT_JOB_TTL_S
    ]
    for job_id in expired:
        _EXPORT_JOBS.pop(job_id, None)

    # Polling clients normally consume completed records immediately, but a
    # crashed/closed renderer must not make the registry grow forever.
    excess = len(_EXPORT_JOBS) - _EXPORT_JOB_MAX_RECORDS
    if excess > 0:
        completed = sorted(
            (
                (float(job.get("updated_at", 0)), job_id)
                for job_id, job in _EXPORT_JOBS.items()
                if job.get("done")
            ),
        )
        for _updated_at, job_id in completed[:excess]:
            _EXPORT_JOBS.pop(job_id, None)


def _start_export_job(kind: str, work: Callable[[], object]) -> str:
    job_id = uuid.uuid4().hex
    now = time.monotonic()
    with _EXPORT_JOBS_LOCK:
        _purge_export_jobs(now)
        active = sum(1 for job in _EXPORT_JOBS.values() if not job.get("done"))
        if active >= _EXPORT_JOB_MAX_ACTIVE:
            raise HTTPException(
                status_code=429,
                detail="別の保存処理が実行中です。完了してからもう一度お試しください。",
            )
        if len(_EXPORT_JOBS) >= _EXPORT_JOB_MAX_RECORDS:
            oldest_completed = sorted(
                (
                    (float(job.get("updated_at", 0)), old_id)
                    for old_id, job in _EXPORT_JOBS.items()
                    if job.get("done")
                ),
            )
            remove_count = len(_EXPORT_JOBS) - _EXPORT_JOB_MAX_RECORDS + 1
            for _updated_at, old_id in oldest_completed[:remove_count]:
                _EXPORT_JOBS.pop(old_id, None)
        # If the configured record bound is ever smaller than the active bound,
        # fail closed instead of creating an untracked worker thread.
        if len(_EXPORT_JOBS) >= _EXPORT_JOB_MAX_RECORDS:
            raise HTTPException(
                status_code=503,
                detail="保存履歴が上限に達しました。少し待ってからもう一度お試しください。",
            )
        _EXPORT_JOBS[job_id] = {
            "job_id": job_id, "kind": kind, "phase": "planning",
            "completed": 0, "total": 0, "percent": 0,
            "label": "保存内容を確認中…", "done": False,
            "status_code": 0, "result": None, "error": "", "updated_at": now,
        }

    def progress(phase: str, completed: int, total: int, label: str) -> None:
        safe_total = max(0, int(total))
        safe_completed = max(0, min(int(completed), safe_total)) if safe_total else 0
        # 100 is reserved for a successful, verified publication response.
        percent = min(99, round(safe_completed * 100 / safe_total)) if safe_total else 0
        with _EXPORT_JOBS_LOCK:
            job = _EXPORT_JOBS.get(job_id)
            if not job or job.get("done"):
                return
            job.update({
                "phase": phase, "completed": safe_completed, "total": safe_total,
                "percent": percent, "label": label, "updated_at": time.monotonic(),
            })

    def run() -> None:
        _EXPORT_JOB_LOCAL.progress = progress
        try:
            status_code, body = _response_body(work())
        except Exception as exc:
            traceback.print_exc()
            status_code, body = 500, {"error": _describe(exc)}
        finally:
            try:
                del _EXPORT_JOB_LOCAL.progress
            except AttributeError:
                pass
        ok = 200 <= status_code < 300
        with _EXPORT_JOBS_LOCK:
            job = _EXPORT_JOBS.get(job_id)
            if job is None:
                return
            job.update({
                "phase": "complete" if ok else "failed",
                "percent": 100 if ok else job.get("percent", 0),
                "label": "保存完了" if ok else "保存を完了できませんでした",
                "done": True, "status_code": status_code,
                "result": body if ok else None,
                "error": "" if ok else str(body.get("error") or "保存に失敗しました"),
                "response": None if ok else body,
                "updated_at": time.monotonic(),
            })

    threading.Thread(target=run, name=f"oir-{kind}-{job_id[:8]}", daemon=True).start()
    return job_id


@app.get("/api/export-jobs/{job_id}")
def export_job_status(job_id: str):
    with _EXPORT_JOBS_LOCK:
        _purge_export_jobs(time.monotonic())
        job = _EXPORT_JOBS.get(job_id)
        if job is None:
            return JSONResponse(status_code=404, content={"error": "保存ジョブが見つかりません。"})
        return {key: value for key, value in job.items() if key != "updated_at"}


def _selftest_export_job_progress() -> int:
    """Prove publication-gated progress and bounded workers/records."""
    def work():
        _export_progress("rendering", 1, 2, "one")
        _export_progress("publishing", 1, 2, "publish")
        return {"saved": ["one"]}

    blockers: list[threading.Event] = []
    job_ids: list[str] = []
    try:
        job_id = _start_export_job("selftest", work)
        job_ids.append(job_id)
        deadline = time.monotonic() + 2
        job = None
        while time.monotonic() < deadline:
            with _EXPORT_JOBS_LOCK:
                job = dict(_EXPORT_JOBS[job_id])
            if job.get("done"):
                break
            time.sleep(0.01)
        if (not job or not job.get("done") or job.get("percent") != 100
                or job.get("result") != {"saved": ["one"]}):
            raise AssertionError(f"completed job state drifted: {job}")

        # Exactly the configured number of workers may run. The next request is
        # refused before it creates another thread.
        for _index in range(_EXPORT_JOB_MAX_ACTIVE):
            blocker = threading.Event()
            blockers.append(blocker)
            job_ids.append(_start_export_job(
                "blocking-selftest", lambda event=blocker: (
                    event.wait(2) and {"saved": ["released"]}
                ),
            ))
        try:
            _start_export_job("excess-selftest", lambda: {"saved": []})
        except HTTPException as exc:
            if exc.status_code != 429:
                raise
        else:
            raise AssertionError("export worker limit accepted an excess job")

        for blocker in blockers:
            blocker.set()
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            with _EXPORT_JOBS_LOCK:
                if all(_EXPORT_JOBS[job].get("done") for job in job_ids[1:]):
                    break
            time.sleep(0.01)

        with _EXPORT_JOBS_LOCK:
            fresh = time.monotonic()
            for index in range(_EXPORT_JOB_MAX_RECORDS + 5):
                old_id = f"old-{index}"
                _EXPORT_JOBS[old_id] = {
                    "done": True, "updated_at": fresh + index / 1000,
                }
            _purge_export_jobs(fresh)
            if len(_EXPORT_JOBS) > _EXPORT_JOB_MAX_RECORDS:
                raise AssertionError("completed export record bound was exceeded")
    except Exception as exc:
        print(f"selftest FAILED: export job progress -> {exc}", flush=True)
        return 35
    finally:
        for blocker in blockers:
            blocker.set()
        with _EXPORT_JOBS_LOCK:
            for job_id in job_ids:
                _EXPORT_JOBS.pop(job_id, None)
            for job_id in list(_EXPORT_JOBS):
                if job_id.startswith("old-"):
                    _EXPORT_JOBS.pop(job_id, None)
    print("selftest: export jobs OK (publish-gated 100%, bounded workers/records)", flush=True)
    return 0

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


#: How many bytes of decoded pixels all open images may hold between them.
#:
#: A fraction of the machine rather than a fixed number, because the same figure
#: means opposite things on a 192 GB workstation and a 16 GB laptop. One real
#: plate well is 2911x2923x50x5 uint16 = 4.25 GB, so eight of them is 34 GB:
#: fine on the workstation, fatal anywhere else. 40% leaves room for the JVM,
#: the slice cache, Electron and the OS.
_RAM = 0
try:
    if sys.platform == "win32":
        # This total is retained solely for the decoded-image cache budget. The
        # removed opening warning's volatile "available RAM" plumbing is not.
        import ctypes

        class _BudgetMemStatus(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong),
                        ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong),
                        ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong),
                        ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong),
                        ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

        _budget_status = _BudgetMemStatus()
        _budget_status.dwLength = ctypes.sizeof(_BudgetMemStatus)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(_budget_status)):
            _RAM = int(_budget_status.ullTotalPhys)
    else:
        _RAM = int(os.sysconf("SC_PAGE_SIZE")) * int(os.sysconf("SC_PHYS_PAGES"))
except Exception:
    _RAM = 0
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

# One operation that can own or create multi-gigabyte pixel state at a time.
#
# This is intentionally process-wide rather than per reader. A real well is
# about 4.25 GB decoded, while a source-resolution 3D reply is another 1.7 GB;
# two individually reasonable requests overlapping are what caused the packaged
# app to disappear without a Python exception. The epoch makes a memory plan a
# single-phase admission decision: any later heavy operation invalidates it.
_MEMORY_HEAVY_LOCK = threading.Semaphore(1)
_MEMORY_EPOCH_LOCK = threading.Lock()
_memory_epoch = 0


def _memory_epoch_snapshot() -> int:
    with _MEMORY_EPOCH_LOCK:
        return _memory_epoch


def _advance_memory_epoch() -> int:
    global _memory_epoch
    with _MEMORY_EPOCH_LOCK:
        _memory_epoch += 1
        return _memory_epoch


@contextmanager
def _memory_heavy_reservation(*, advances_epoch: bool = True):
    """Serialise a memory-heavy phase and invalidate older plans on entry."""
    _MEMORY_HEAVY_LOCK.acquire()
    try:
        if advances_epoch:
            _advance_memory_epoch()
        yield
    finally:
        _MEMORY_HEAVY_LOCK.release()


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


@contextmanager
def _reader_ready_reservation(
    reader: ImageReader, image_id: str, *, metadata_only: bool = False,
) -> Iterator[bool]:
    """Hold the shared gate while making and using one reader ready.

    Yields whether pixels were read. Merely revisiting an already-resident tab
    does not advance the epoch. Keeping the gate through the caller's immediate
    pixel snapshot prevents budget eviction from forcing an unreserved reload in
    the few instructions after the residency check.
    """
    with _memory_heavy_reservation(advances_epoch=False):
        with reader._pixels_lock:
            needs_load = (not reader._metadata_authoritative
                          if metadata_only else reader.data is None)
            if needs_load:
                _advance_memory_epoch()
            if metadata_only:
                loaded = reader.ensure_metadata()
            else:
                reader.ensure_loaded()
                loaded = needs_load
        # Evict before releasing the shared gate. Releasing first permits a
        # second 4.25 GB decode to start while the older source is still resident.
        if needs_load:
            _enforce_budget(keep=image_id)
        yield bool(loaded)


def _ensure_reader_ready_reserved(
    reader: ImageReader, image_id: str, *, metadata_only: bool = False,
) -> bool:
    """Make a reader ready, releasing the shared reservation on return."""
    with _reader_ready_reservation(
        reader, image_id, metadata_only=metadata_only,
    ) as loaded:
        return loaded


def _selftest_memory_heavy_reservation() -> int:
    """Prove heavy phases are exclusive and advance one shared generation."""
    global _memory_epoch
    first_entered = threading.Event()
    release_first = threading.Event()
    second_entered = threading.Event()
    state_lock = threading.Lock()
    state = {"active": 0, "peak": 0}
    errors: list[BaseException] = []

    def worker(entered: threading.Event, wait: bool) -> None:
        try:
            with _memory_heavy_reservation():
                with state_lock:
                    state["active"] += 1
                    state["peak"] = max(state["peak"], state["active"])
                entered.set()
                if wait and not release_first.wait(2):
                    raise RuntimeError("reservation selftest timed out")
                with state_lock:
                    state["active"] -= 1
        except BaseException as e:
            errors.append(e)

    with _MEMORY_EPOCH_LOCK:
        saved_epoch = _memory_epoch
    first = threading.Thread(target=worker, args=(first_entered, True), daemon=True)
    second = threading.Thread(target=worker, args=(second_entered, False), daemon=True)
    try:
        first.start()
        if not first_entered.wait(1):
            raise AssertionError("first reservation did not start")
        second.start()
        if second_entered.wait(0.05):
            raise AssertionError("two memory-heavy reservations overlapped")
        release_first.set()
        first.join(2)
        second.join(2)
        if (first.is_alive() or second.is_alive() or errors
                or not second_entered.is_set() or state["peak"] != 1
                or _memory_epoch_snapshot() != saved_epoch + 2):
            raise AssertionError(
                f"reservation state drifted: peak={state['peak']}, "
                f"epoch={_memory_epoch_snapshot() - saved_epoch}, errors={errors}"
            )
    except Exception as e:
        print(f"selftest FAILED: memory reservation -> {type(e).__name__}: {e}",
              flush=True)
        return 31
    finally:
        release_first.set()
        first.join(2)
        second.join(2)
        with _MEMORY_EPOCH_LOCK:
            _memory_epoch = saved_epoch

    if _VOLUME_BUILD_LOCK is not _MEMORY_HEAVY_LOCK:
        print("selftest FAILED: volume response does not use shared memory gate",
              flush=True)
        return 31
    print("selftest: memory reservation OK (exclusive, shared epoch, response gate)",
          flush=True)
    return 0


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


def _open_image_with_source(
    source_path: str, source_identity: str, source_revision: str,
) -> tuple[str, ImageReader] | None:
    """Return the existing tab for the exact same source bytes, if any.

    Two ids for one canonical source carry independent in-memory view snapshots
    but share one durable settings record. Resetting one could therefore be
    undone later by the other tab. Reusing the existing id removes that
    ambiguity before any pixels are decoded again.
    """
    requested_path = _path_key(source_path)
    with _state_lock:
        for image_id, reader in images.items():
            meta = reader.metadata
            if (meta.source_identity == source_identity
                    and meta.source_revision == source_revision):
                return image_id, reader
            if meta.source_path and _path_key(meta.source_path) == requested_path:
                raise RuntimeError(
                    "The source file changed while an older tab is still open. "
                    "Close the older tab before opening the replacement."
                )
    return None


@app.get("/api/images")
async def list_images():
    """List all loaded images."""
    with _state_lock:
        snapshot = [(img_id, reader.metadata) for img_id, reader in images.items()]
        snapshot_active = active_id
    result = []
    for img_id, meta in snapshot:
        result.append({
            "id": img_id,
            "filename": meta.filename,
            "source_path": meta.source_path,
            "source_identity": meta.source_identity,
            "source_revision": meta.source_revision,
            "num_channels": meta.num_channels,
            "num_z": meta.num_z,
            "num_t": meta.num_t,
            "width": meta.width,
            "height": meta.height,
            "active": img_id == snapshot_active,
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
    with _state_lock:
        reader = images.get(image_id)
        if reader is None:
            return JSONResponse(status_code=404, content={"error": "Image not found"})
        active_id = image_id
        _touch(image_id)
    try:
        _ensure_reader_ready_reserved(reader, image_id)
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(status_code=400, content={"error": _describe(e)})
    # A newly loaded tab was budgeted before the reservation was released.
    return reader.metadata.to_dict()


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


class SavedChannelView(BaseModel):
    color: list[int]
    min: float
    max: float
    visible: bool


class SavedImageView(BaseModel):
    channels: list[SavedChannelView]
    currentZ: int
    currentT: int
    showMIP: bool
    client_session: str = ""
    client_sequence: int = 0


def _validated_view_settings(meta: ImageMetadata, raw: object) -> dict:
    """Return a canonical payload, refusing any state that could mis-map pixels."""
    if not isinstance(raw, dict):
        raise ValueError("View settings are not an object")
    channels = raw.get("channels")
    if not isinstance(channels, list) or len(channels) != meta.num_channels:
        raise ValueError(
            f"View settings have {len(channels) if isinstance(channels, list) else 'invalid'} "
            f"channels; the source has {meta.num_channels}"
        )

    bit_depth = max(1, min(16, int(meta.bit_depth or 16)))
    full_scale = float((1 << bit_depth) - 1)
    clean_channels = []
    for index, channel in enumerate(channels):
        if not isinstance(channel, dict):
            raise ValueError(f"Channel {index + 1} settings are not an object")
        color = channel.get("color")
        if (not isinstance(color, (list, tuple)) or len(color) != 3
                or any(type(v) is not int or v < 0 or v > 255 for v in color)):
            raise ValueError(f"Channel {index + 1} has an invalid RGB colour")
        lo, hi = channel.get("min"), channel.get("max")
        if (isinstance(lo, bool) or isinstance(hi, bool)
                or not isinstance(lo, (int, float)) or not isinstance(hi, (int, float))
                or not math.isfinite(float(lo)) or not math.isfinite(float(hi))
                or float(lo) < 0 or float(hi) < float(lo) or float(hi) > full_scale):
            raise ValueError(f"Channel {index + 1} has an invalid Min/Max window")
        visible = channel.get("visible")
        if type(visible) is not bool:
            raise ValueError(f"Channel {index + 1} has an invalid visibility flag")
        clean_channels.append({
            "color": [int(v) for v in color],
            "min": float(lo),
            "max": float(hi),
            "visible": visible,
        })

    current_z, current_t, show_mip = (
        raw.get("currentZ"), raw.get("currentT"), raw.get("showMIP")
    )
    if type(current_z) is not int or not 0 <= current_z < max(1, meta.num_z):
        raise ValueError("Saved Z position is outside this source")
    if type(current_t) is not int or not 0 <= current_t < max(1, meta.num_t):
        raise ValueError("Saved T position is outside this source")
    if type(show_mip) is not bool:
        raise ValueError("Saved MIP state is invalid")
    return {
        "channels": clean_channels,
        "currentZ": current_z,
        "currentT": current_t,
        "showMIP": show_mip,
    }


def _authoritative_view_source(image_id: str) -> tuple[ImageReader, ImageMetadata] | JSONResponse:
    """Resolve rich metadata and prove the source did not change underneath it."""
    with _state_lock:
        reader = images.get(image_id)
    if reader is None:
        return JSONResponse(status_code=404, content={"error": "Image not found"})
    try:
        _ensure_reader_ready_reserved(reader, image_id, metadata_only=True)
        meta = reader.metadata
        if not meta.source_path or not meta.source_identity or not meta.source_revision:
            raise ValueError("The source has no stable identity for saved view settings")
        current = snapshot_source(meta.source_path)
        if (current.identity != meta.source_identity
                or current.revision != meta.source_revision):
            return JSONResponse(status_code=409, content={
                "error": "元画像が変更されたため、以前の表示設定は適用・保存しません。"
            })
        return reader, meta
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": _describe(e)})


@app.get("/api/images/{image_id}/view-settings")
def get_view_settings(image_id: str):
    """Return settings only when they belong to the exact current source bytes."""
    source = _authoritative_view_source(image_id)
    if isinstance(source, JSONResponse):
        return source
    _reader, meta = source
    try:
        saved, reason = _view_settings_store.get(
            meta.source_path, meta.source_identity, meta.source_revision,
        )
        if saved is None:
            return {"found": False, "reason": reason}
        clean = _validated_view_settings(meta, saved)
        return {
            "found": True,
            "source_identity": meta.source_identity,
            "source_revision": meta.source_revision,
            "settings": clean,
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": _describe(e)})


@app.put("/api/images/{image_id}/view-settings")
def put_view_settings(image_id: str, req: SavedImageView):
    """Atomically save a validated display state for the current source revision."""
    source = _authoritative_view_source(image_id)
    if isinstance(source, JSONResponse):
        return source
    _reader, meta = source
    try:
        raw = req.model_dump() if hasattr(req, "model_dump") else req.dict()
        clean = _validated_view_settings(meta, raw)
        client_session = str(req.client_session or "")
        client_sequence = int(req.client_sequence)
        if client_session:
            if (not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", client_session)
                    or type(req.client_sequence) is not int
                    or not 1 <= client_sequence <= 2 ** 53 - 1):
                raise ValueError("Saved view write sequence is invalid")
        elif client_sequence != 0:
            raise ValueError("Saved view sequence has no renderer session")
        # Recheck after validation: a split companion can change at any time.
        current = snapshot_source(meta.source_path)
        if (current.identity != meta.source_identity
                or current.revision != meta.source_revision):
            return JSONResponse(status_code=409, content={
                "error": "元画像が変更されたため、表示設定を保存しませんでした。"
            })
        saved = _view_settings_store.put(
            meta.source_path, meta.source_identity, meta.source_revision, clean,
            client_session=client_session, client_sequence=client_sequence,
        )
        return {"saved": saved, "source_revision": meta.source_revision}
    except ValueError as e:
        return JSONResponse(status_code=422, content={"error": _describe(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": _describe(e)})


@app.delete("/api/images/{image_id}/view-settings")
def delete_view_settings(image_id: str):
    """Forget every saved revision for this path, even if its drive is absent."""
    with _state_lock:
        reader = images.get(image_id)
    if reader is None:
        return JSONResponse(status_code=404, content={"error": "Image not found"})
    source_path = reader.metadata.source_path
    if not source_path:
        return JSONResponse(status_code=409, content={
            "error": "This image has no source path to reset"
        })
    try:
        return {"deleted": _view_settings_store.delete(source_path)}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": _describe(e)})


def _selftest_view_settings_api() -> int:
    """Prove the API validates, revision-binds and independently resets state."""
    global images, active_id, _lru, _view_settings_store

    saved_images, saved_active, saved_lru = images, active_id, _lru
    saved_store = _view_settings_store
    try:
        with tempfile.TemporaryDirectory() as tmp:
            source_path = os.path.join(tmp, "view-source.oir")
            Path(source_path).write_bytes(b"stable source bytes")
            source = snapshot_source(source_path)
            meta = ImageMetadata(
                filename=os.path.basename(source_path),
                source_path=source_path,
                source_identity=source.identity,
                source_revision=source.revision,
                num_channels=2,
                num_z=4,
                num_t=3,
                width=8,
                height=8,
                bit_depth=12,
            )

            class _MetadataReader:
                def __init__(self, metadata: ImageMetadata):
                    self.metadata = metadata
                    self._pixels_lock = threading.RLock()
                    self._metadata_authoritative = True

                def ensure_metadata(self) -> bool:
                    return False

            images, active_id, _lru = {"view": _MetadataReader(meta)}, "view", []
            _view_settings_store = view_settings.ViewSettingsStore(
                os.path.join(tmp, "view-settings.json")
            )
            payload = {
                "channels": [
                    {"color": [0, 255, 0], "min": 12.0,
                     "max": 2048.0, "visible": True},
                    {"color": [255, 0, 255], "min": 0.0,
                     "max": 4095.0, "visible": False},
                ],
                "currentZ": 3,
                "currentT": 2,
                "showMIP": True,
            }

            request = SavedImageView(**payload)
            saved = put_view_settings("view", request)
            loaded = get_view_settings("view")
            if (saved.get("saved") is not True
                    or loaded.get("found") is not True
                    or loaded.get("source_identity") != source.identity
                    or loaded.get("source_revision") != source.revision
                    or loaded.get("settings") != payload):
                raise AssertionError("validated settings did not round-trip through the API")

            invalid = SavedImageView(
                channels=[SavedChannelView(
                    color=[255, 255, 255], min=0, max=4095, visible=True,
                )],
                currentZ=0,
                currentT=0,
                showMIP=False,
            )
            rejected = put_view_settings("view", invalid)
            if not isinstance(rejected, JSONResponse) or rejected.status_code != 422:
                raise AssertionError("a channel-count mismatch was accepted")

            # The unload keepalive request bypasses the renderer's Promise tail.
            # If it arrives before an older PUT, the endpoint must still retain
            # the larger renderer sequence.
            newer_payload = {**payload, "currentZ": 2}
            older_payload = {**payload, "currentZ": 1}
            newer = put_view_settings("view", SavedImageView(
                **newer_payload, client_session="renderer-test", client_sequence=2,
            ))
            older = put_view_settings("view", SavedImageView(
                **older_payload, client_session="renderer-test", client_sequence=1,
            ))
            ordered = get_view_settings("view")
            if (newer.get("saved") is not True or older.get("saved") is not False
                    or ordered.get("settings", {}).get("currentZ") != 2):
                raise AssertionError("an older renderer PUT replaced unload settings")

            # The reader still names the earlier bytes; a changed source must be
            # refused before an old display state can be applied or overwritten.
            Path(source_path).write_bytes(b"changed source bytes")
            changed = put_view_settings("view", request)
            if not isinstance(changed, JSONResponse) or changed.status_code != 409:
                raise AssertionError("a changed source revision accepted saved settings")

            # Reset is intentionally path-scoped and remains available while the
            # source is changed or temporarily unavailable.
            reset = delete_view_settings("view")
            if reset != {"deleted": True}:
                raise AssertionError("reset did not delete the source's settings")
            if _view_settings_store.get(
                    source_path, source.identity, source.revision) != (None, "none"):
                raise AssertionError("deleted settings came back through the store")
    except Exception as e:
        print(f"selftest FAILED: view settings API -> {type(e).__name__}: {e}", flush=True)
        return 30
    finally:
        images, active_id, _lru = saved_images, saved_active, saved_lru
        _view_settings_store = saved_store

    print("selftest: view settings API OK (validated, revision-bound, resettable)",
          flush=True)
    return 0


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
    global active_id
    locks = _locks_for_targets([path])
    for lock in locks:
        lock.acquire()
    process_locks: list[object] = []
    try:
        process_locks = _acquire_process_target_locks([path])
        print(f"Opening {path}", flush=True)
        source = snapshot_source(path)
        existing = _open_image_with_source(
            path, source.identity, source.revision,
        )
        if existing is not None:
            img_id, r = existing
            with _state_lock:
                active_id = img_id
                _touch(img_id)
            _ensure_reader_ready_reserved(r, img_id)
            _save_session()
            return {**r.metadata.to_dict(), "id": img_id, "reused": True}
        r = ImageReader()
        # Target locks are taken first. No code may acquire a target lock while
        # holding this reservation; projection releases it before publication.
        with _memory_heavy_reservation():
            r.load_file(path)
            img_id = add_image(r)
        return {**r.metadata.to_dict(), "id": img_id, "reused": False}
    except Exception as e:
        # str(e) alone is what the UI shows, and for a JVM or Bio-Formats
        # failure that is often a bare class name. The traceback goes to the
        # log file so the cause is recoverable without reproducing it.
        traceback.print_exc()
        return JSONResponse(status_code=400, content={"error": _describe(e)})
    finally:
        _release_process_target_locks(process_locks)
        for lock in reversed(locks):
            lock.release()


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
def upload_file(file: UploadFile = File(...)):
    """Upload an image file, save to the persistent uploads dir, and open it."""
    try:
        # This endpoint can wait for the process-wide memory reservation below.
        # Keep it synchronous so FastAPI runs it in a worker; blocking the event
        # loop could prevent the volume response holding that reservation from
        # finishing its send and releasing it.
        content = file.file.read()
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

        locks = _locks_for_targets([dest])
        for lock in locks:
            lock.acquire()
        process_locks: list[object] = []
        try:
            process_locks = _acquire_process_target_locks([dest])
            with open(dest, "wb") as out:
                out.write(content)

            r = ImageReader()
            with _memory_heavy_reservation():
                r.load_file(dest)
                r.metadata.filename = base
                img_id = add_image(r)
            return {**r.metadata.to_dict(), "id": img_id}
        finally:
            _release_process_target_locks(process_locks)
            for lock in reversed(locks):
                lock.release()
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(status_code=400, content={"error": _describe(e)})


@app.get("/api/metadata")
def get_metadata(id: str | None = Query(None)):
    """Get authoritative metadata, upgrading one restored placeholder first.

    A session restore deliberately reads zero pixels and therefore only knows
    dimensions. Returning that placeholder made the frontend keep Ch0 labels,
    zero pixel sizes and the default bit depth even after a later volume load
    replaced the reader's metadata. This endpoint is the ordering boundary:
    the frontend receives the real metadata before it can request/display a
    slice or 3D volume. It is synchronous so a large well is read in FastAPI's
    worker pool rather than blocking the event loop.
    """
    try:
        image_id = id or active_id
        r = get_reader(image_id)
        upgraded = _ensure_reader_ready_reserved(r, image_id, metadata_only=True)
        # An old placeholder currently has to open the image to discover its
        # rich metadata. The reserved loader admits exactly this image and evicts
        # older pixels before another multi-GB operation may begin.
        if upgraded:
            # Dimensions in an old session are a cache too. Persist the values
            # the reader just established so even the lightweight tab list is
            # corrected on the next launch.
            _save_session()
        return {**r.metadata.to_dict(), "id": image_id}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": _describe(e)})


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
        image_id = id or active_id
        r = get_reader(image_id)
        assert image_id is not None
        with _reader_ready_reservation(r, image_id):
            img = r.get_slice(c, z, t)
            if format == "png":
                png_bytes = to_png_bytes(img)
                return Response(content=png_bytes, media_type="image/png")
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
        image_id = id or active_id
        r = get_reader(image_id)
        assert image_id is not None
        with _reader_ready_reservation(r, image_id):
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
        image_id = id or active_id
        r = get_reader(image_id)
        assert image_id is not None
        with _reader_ready_reservation(r, image_id):
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
        image_id = id or active_id
        r = get_reader(image_id)
        assert image_id is not None
        with _reader_ready_reservation(r, image_id):
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
        image_id = id or active_id
        r = get_reader(image_id)
        assert image_id is not None
        with _reader_ready_reservation(r, image_id):
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
        image_id = body.get("id") or active_id
        r = get_reader(image_id)
        assert image_id is not None
        c = body.get("c", 0)
        z = body.get("z", 0)
        t = body.get("t", 0)
        with _reader_ready_reservation(r, image_id):
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
        image_id = body.get("id") or active_id
        r = get_reader(image_id)
        assert image_id is not None
        c = body.get("c", 0)
        z = body.get("z", 0)
        t = body.get("t", 0)
        with _reader_ready_reservation(r, image_id):
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

    _MEMORY_HEAVY_LOCK.acquire()
    try:
        # Legacy route retained for compatibility. It has no admission token,
        # but it must still be one exclusive allocation phase and invalidate any
        # newer /api/volume-plan approval made before it began.
        _advance_memory_epoch()
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
    finally:
        _MEMORY_HEAVY_LOCK.release()


#: Distinct values a uint16 pixel can take, which is the length of the histogram
#: the streaming volume path accumulates instead of keeping the pixels. Every
#: reader path ends at uint16 (reader._to_uint16), so this covers all of them.
_U16_LEVELS = 65536

# One response body can be 1.7 GB at the real acquisition's source resolution.
# This alias documents the response-lifetime use while making it the same gate
# as source decode, plate volume and projection work. It is held until the body
# has been sent, not merely until it was built.
_VOLUME_BUILD_LOCK = _MEMORY_HEAVY_LOCK


class _VolumeResponse(Response):
    """Release the build reservation even when the client disconnects mid-send."""

    def __init__(self, *args, build_lock: threading.Semaphore, **kwargs):
        super().__init__(*args, **kwargs)
        self._build_lock = build_lock

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            self._build_lock.release()


def _volume_memory_plan(
    *, image_id: str, source_revision: str, t: int, n_t: int,
    n_c: int, n_z: int, h: int, w: int, max_dim: int, max_ch: int,
    source_resident_bytes: int, memory_epoch: int,
) -> dict:
    """Exact output shape plus conservative allocation sizes for volume-bin."""
    raw_values = (n_t, n_c, n_z, h, w)
    # Bio-Formats returns JPype integer proxies. They deliberately behave like
    # Python ints (including ``isinstance(value, int)``), but ``type(value) is
    # int`` is false. Canonicalise trusted metadata dimensions before hashing or
    # arithmetic so the packaged OIR path and the pure-Python selftest use the
    # same plan contract. Booleans remain invalid even though bool subclasses
    # int.
    try:
        if any(isinstance(value, (bool, np.bool_)) for value in raw_values):
            raise TypeError("boolean dimension")
        n_t, n_c, n_z, h, w = (operator.index(value) for value in raw_values)
    except (TypeError, ValueError, OverflowError) as e:
        raise ValueError(f"Invalid volume shape: {raw_values}") from e
    values = (n_t, n_c, n_z, h, w)
    if any(value <= 0 for value in values):
        raise ValueError(f"Invalid volume shape: {raw_values}")
    if not 0 <= t < n_t:
        raise ValueError(f"T{t + 1} is outside this image (T1-T{n_t})")
    if not 1 <= max_ch <= 4:
        raise ValueError("3D volume channel limit must be between 1 and 4")
    if type(memory_epoch) is not int or memory_epoch < 0:
        raise ValueError("Invalid memory-plan epoch")

    normalised_max_dim = 0
    if max_dim <= 0:
        scale_xy = 1.0
        scale_z = 1.0
    else:
        normalised_max_dim = max(32, min(int(max_dim), 2048))
        xy_max = max(h, w)
        scale_xy = normalised_max_dim / xy_max if xy_max > normalised_max_dim else 1.0
        scale_z = 128 / n_z if n_z > 128 else 1.0

    out_h = int(round(h * scale_xy))
    out_w = int(round(w * scale_xy))
    out_z = int(round(n_z * scale_z))
    send_c = min(n_c, max_ch)
    channel_bytes = out_z * out_h * out_w
    texture_bytes = send_c * channel_bytes
    wire_bytes = 32 + 8 * send_c + texture_bytes
    resized = (out_h, out_w, out_z) != (h, w, n_z)
    # One uint16 output channel plus the uint16 histogram. Channels are processed
    # serially, so this never multiplies by send_c.
    server_stage_bytes = (_U16_LEVELS * np.dtype(np.int64).itemsize
                          + (2 * channel_bytes if resized else 0))
    # `_resize_plane` can hold float32 source/filter/output planes together;
    # packing to uint8 holds one additional float32 output plane at full size.
    plane_work_bytes = ((8 * h * w + 4 * out_h * out_w)
                        if (out_h, out_w) != (h, w)
                        else 4 * out_h * out_w)
    source_bytes = n_t * n_c * n_z * h * w * np.dtype(np.uint16).itemsize
    resident = max(0, min(int(source_resident_bytes), source_bytes))
    key_payload = json.dumps({
        "id": image_id, "revision": source_revision, "t": t,
        "shape": values, "max_dim": normalised_max_dim, "max_ch": max_ch,
        "output": [send_c, out_z, out_h, out_w],
        # A plan approved while the source pixels are resident is not safe after
        # budget eviction: reloading a real well adds another ~4.25 GB before
        # the volume reply can be built. Bind that state into the token so the
        # execution endpoint can refuse the changed plan before it reads pixels.
        "source_resident_bytes": resident,
        # Another source decode, projection, plate volume or interactive volume
        # changes the process-wide allocation phase even if this reader's shape
        # and residency happen to look identical afterward.
        "memory_epoch": memory_epoch,
    }, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(key_payload.encode("utf-8")).hexdigest()
    return {
        # The prefix is deliberately readable by the execution endpoint. The
        # client treats the token as opaque, while the server can distinguish a
        # harmless global allocation-phase drift from a changed source/shape.
        "plan_key": f"{memory_epoch}:{digest}",
        "memory_epoch": memory_epoch,
        "source_bytes": int(source_bytes),
        "source_resident_bytes": resident,
        "source_increment_bytes": int(source_bytes - resident),
        "num_t": n_t,
        "num_channels": send_c,
        "num_z": out_z,
        "height": out_h,
        "width": out_w,
        "original_shape": [n_c, n_z, h, w],
        "texture_bytes": int(texture_bytes),
        "wire_bytes": int(wire_bytes),
        "server_stage_bytes": int(server_stage_bytes),
        "plane_work_bytes": int(plane_work_bytes),
        "max_dim": normalised_max_dim,
    }


@app.get("/api/volume-plan")
def get_volume_plan(
    t: int = Query(0),
    id: str | None = Query(None),
    max_dim: int = Query(256),
    max_ch: int = Query(4),
):
    """Plan one 3D load without allocating its response or touching pixels."""
    try:
        # Wait for any previous heavy response to finish, then freeze residency
        # and epoch together. A later heavy phase advances the epoch and makes
        # this exact token fail at /api/volume-bin before pixels are touched.
        with _memory_heavy_reservation(advances_epoch=False):
            image_id = id or active_id
            if not image_id:
                raise RuntimeError("No image loaded")
            r = get_reader(image_id)
            with r._pixels_lock:
                meta = r.metadata
                return _volume_memory_plan(
                    image_id=image_id, source_revision=meta.source_revision, t=t,
                    n_t=meta.num_t, n_c=meta.num_channels, n_z=meta.num_z,
                    h=meta.height, w=meta.width, max_dim=max_dim, max_ch=max_ch,
                    source_resident_bytes=r.loaded_bytes,
                    memory_epoch=_memory_epoch_snapshot(),
                )
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": _describe(e)})


def _selftest_volume_memory_plan() -> int:
    """Pin the real-data shape and the approval token to the execution plan."""
    global images, active_id, _lru, _memory_epoch
    try:
        plan_epoch = _memory_epoch_snapshot()
        # Bio-Formats dimensions are JPype integer proxies rather than exact
        # built-in ints. A subclass pins that packaged OIR boundary without
        # starting Java merely for this arithmetic test.
        class _BioFormatsDimension(int):
            pass

        common = dict(
            image_id="well", source_revision="source-rev", t=0,
            n_t=_BioFormatsDimension(1), n_c=_BioFormatsDimension(5),
            n_z=_BioFormatsDimension(50), h=_BioFormatsDimension(2929),
            w=_BioFormatsDimension(2909), max_ch=4,
            memory_epoch=plan_epoch,
        )
        capped = _volume_memory_plan(
            **common, max_dim=2048, source_resident_bytes=4_260_230_500,
        )
        if ([capped["num_channels"], capped["num_z"],
             capped["height"], capped["width"]] != [4, 50, 2048, 2034]
                or capped["texture_bytes"] != 833_126_400
                or capped["source_increment_bytes"] != 0):
            raise AssertionError(f"real-well GPU plan drifted: {capped}")
        original = _volume_memory_plan(
            **common, max_dim=0, source_resident_bytes=0,
        )
        if (original["texture_bytes"] != 1_704_092_200
                or original["source_increment_bytes"] != 4_260_230_500):
            raise AssertionError(f"source-resolution plan drifted: {original}")

        # Exercise the HTTP route with non-builtin integer dimensions, as the
        # packaged Bio-Formats reader does. The first v1.5.5 App smoke reached
        # this exact C5/Z50 shape and exposed a strict ``type(x) is int`` check
        # that helper-only tests with Python literals had missed.
        class _PlanReader:
            def __init__(self):
                self.metadata = ImageMetadata(
                    source_revision="source-rev", num_t=np.int64(1),
                    num_channels=np.int64(5), num_z=np.int64(50),
                    height=np.int64(2923), width=np.int64(2900),
                )
                self._pixels_lock = threading.RLock()

            @property
            def loaded_bytes(self):
                return 0

        saved_images, saved_active, saved_lru = images, active_id, _lru
        try:
            images, active_id, _lru = {"jpype-shape": _PlanReader()}, "jpype-shape", ["jpype-shape"]
            route_plan = get_volume_plan(
                t=0, id="jpype-shape", max_dim=2048, max_ch=4,
            )
            if (isinstance(route_plan, JSONResponse)
                    or route_plan.get("original_shape") != [5, 50, 2923, 2900]
                    or [route_plan.get("num_channels"), route_plan.get("num_z"),
                        route_plan.get("height"), route_plan.get("width")]
                    != [4, 50, 2048, 2032]):
                detail = (json.loads(route_plan.body)
                          if isinstance(route_plan, JSONResponse) else route_plan)
                raise AssertionError(f"Bio-Formats route plan drifted: {detail}")
        finally:
            images, active_id, _lru = saved_images, saved_active, saved_lru

        deep = _volume_memory_plan(
            image_id="deep", source_revision="rev", t=1,
            n_t=2, n_c=2, n_z=200, h=100, w=200,
            max_dim=512, max_ch=2, source_resident_bytes=0,
            memory_epoch=plan_epoch,
        )
        if [deep["num_z"], deep["height"], deep["width"]] != [128, 100, 200]:
            raise AssertionError(f"Z cap drifted: {deep}")
        changed = _volume_memory_plan(
            **{**common, "source_revision": "changed"},
            max_dim=2048, source_resident_bytes=4_260_230_500,
        )
        if changed["plan_key"] == capped["plan_key"]:
            raise AssertionError("source revision is not bound to the plan token")
        evicted = _volume_memory_plan(
            **common, max_dim=2048, source_resident_bytes=0,
        )
        if evicted["plan_key"] == capped["plan_key"]:
            raise AssertionError("source residency is not bound to the plan token")
        later_epoch = _volume_memory_plan(
            **{**common, "memory_epoch": plan_epoch + 1},
            max_dim=2048, source_resident_bytes=4_260_230_500,
        )
        if later_epoch["plan_key"] == capped["plan_key"]:
            raise AssertionError("memory-heavy generation is not bound to the plan token")
        invalid = {**common, "max_ch": 0}
        try:
            _volume_memory_plan(**invalid, max_dim=512, source_resident_bytes=0)
            raise AssertionError("zero requested channels were accepted")
        except ValueError:
            pass

        # A plan made while pixels were resident must be refused before an
        # evicted reader is asked to reload them. This is the boundary that
        # makes the displayed estimate an admission check rather than advice.
        class _EvictedReader:
            def __init__(self):
                self.metadata = ImageMetadata(
                    source_revision="source-rev", num_t=1, num_channels=5,
                    num_z=50, height=2929, width=2909,
                )
                self._pixels_lock = threading.RLock()
                self.calls = 0

            @property
            def loaded_bytes(self):
                return 0

            def get_volume(self, _t):
                self.calls += 1
                raise AssertionError("stale plan reached the pixel loader")

        saved_images, saved_active, saved_lru = images, active_id, _lru
        fake = _EvictedReader()
        try:
            images, active_id, _lru = {"well": fake}, "well", ["well"]
            stale = get_volume_bin(
                t=0, id="well", max_dim=2048, max_ch=4,
                plan_key=capped["plan_key"],
            )
            stale_body = json.loads(stale.body)
            if (getattr(stale, "status_code", None) != 409 or fake.calls != 0
                    or stale_body.get("reason") != "source_or_plan_changed"):
                raise AssertionError("stale resident plan was not rejected before pixels")
        finally:
            images, active_id, _lru = saved_images, saved_active, saved_lru

        # Even if the same source is still resident with the same dimensions, a
        # heavy operation that ran after approval starts a new allocation phase.
        # Refuse that old approval before get_volume can retain a source snapshot.
        class _ResidentReader(_EvictedReader):
            @property
            def loaded_bytes(self):
                return 4_260_230_500

        resident = _ResidentReader()
        saved_images, saved_active, saved_lru = images, active_id, _lru
        with _MEMORY_EPOCH_LOCK:
            saved_epoch = _memory_epoch
            _memory_epoch = plan_epoch + 1
        try:
            images, active_id, _lru = {"well": resident}, "well", ["well"]
            stale_epoch = get_volume_bin(
                t=0, id="well", max_dim=2048, max_ch=4,
                plan_key=capped["plan_key"],
            )
            stale_epoch_body = json.loads(stale_epoch.body)
            if (getattr(stale_epoch, "status_code", None) != 409
                    or resident.calls != 0
                    or stale_epoch_body.get("reason") != "memory_epoch_changed"):
                raise AssertionError("stale memory epoch reached the pixel loader")
        finally:
            images, active_id, _lru = saved_images, saved_active, saved_lru
            with _MEMORY_EPOCH_LOCK:
                _memory_epoch = saved_epoch
    except Exception as e:
        print(f"selftest FAILED: volume memory plan -> {type(e).__name__}: {e}", flush=True)
        return 26
    print("selftest: volume memory plan OK (real shape, peak bytes, revision/epoch token)",
          flush=True)
    return 0


@app.get("/api/volume-bin")
def get_volume_bin(
    t: int = Query(0),
    id: str | None = Query(None),
    max_dim: int = Query(256),
    max_ch: int = Query(4),
    plan_key: str = Query(...),
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
    release_lock = True
    _VOLUME_BUILD_LOCK.acquire()
    try:
        image_id = id or active_id
        if not image_id:
            raise RuntimeError("No image loaded")
        r = get_reader(image_id)
        # Keep plan validation and the pixel snapshot under the reader's one
        # residency lock. Otherwise another request could evict the source in
        # the few instructions between them, turning a zero-increment approval
        # into an unapproved multi-gigabyte reload.
        with r._pixels_lock:
            meta = r.metadata
            if not 0 <= t < max(1, meta.num_t):
                raise ValueError(
                    f"T{t + 1} is outside this image (T1-T{max(1, meta.num_t)})"
                )
            # Validate the exact plan before ensure_loaded/get_volume can
            # allocate a previously evicted source. ImageReader then checks the
            # source revision around any necessary disk read.
            current_epoch = _memory_epoch_snapshot()
            try:
                token_epoch = int(plan_key.split(":", 1)[0])
            except (AttributeError, TypeError, ValueError):
                return JSONResponse(status_code=409, content={
                    "error": "3D表示のメモリ計画を確認できません。もう一度確認してください。",
                    "reason": "source_or_plan_changed",
                })
            if token_epoch != current_epoch:
                return JSONResponse(status_code=409, content={
                    "error": "別の画像処理が完了したため、3D表示のメモリをもう一度確認します。",
                    "reason": "memory_epoch_changed",
                })
            plan = _volume_memory_plan(
                image_id=image_id, source_revision=meta.source_revision, t=t,
                n_t=meta.num_t, n_c=meta.num_channels, n_z=meta.num_z,
                h=meta.height, w=meta.width,
                max_dim=max_dim, max_ch=max_ch,
                source_resident_bytes=r.loaded_bytes,
                memory_epoch=current_epoch,
            )
            if plan_key != plan["plan_key"]:
                return JSONResponse(status_code=409, content={
                    "error": "3D表示の元画像またはメモリ計画が変わりました。もう一度確認してください。",
                    "reason": "source_or_plan_changed",
                })
            # Only a validated request advances the phase. Invalid requests did
            # not allocate anything and must not invalidate a fresh plan merely
            # by arriving late.
            _advance_memory_epoch()
            # (C, Z, Y, X) uint16; a numpy snapshot, never copied here.
            vol = r.get_volume(t)
        n_c, n_z, h, w = vol.shape
        if [n_c, n_z, h, w] != plan["original_shape"]:
            raise RuntimeError(
                "3D表示の元画像形状がメモリ計算後に変わりました。再度開いてください。"
            )
        out_h = plan["height"]
        out_w = plan["width"]
        out_z = plan["num_z"]
        send_c = plan["num_channels"]

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

            # Packed over the channel's own data range, NOT an auto-contrast
            # percentile. The 99.9th-percentile window this used to take clips
            # everything above it to a flat 1.0 — and a MIP displays exactly
            # those voxels. These files record a full-scale LUT (0..4095), so 2D
            # opens with that window while 3D showed its brightest structures at
            # the clip level: measured on the real well, 3D rendered CH1 at 0.18x
            # and CH3 at 0.16x of their 2D brightness. It also made brightness a
            # function of the quality setting, because the percentile moves with
            # the downsample. Packing the true range clips nothing, so the
            # shader's window maths reproduces 2D exactly at any resolution.
            #
            # One guard: a lone hot pixel far above the distribution would
            # stretch the packing and quantise the real signal into a few uint8
            # steps. If the max is detached from the 99.999th percentile by more
            # than 2x, it is treated as noise and the percentile wins — that one
            # pixel saturates instead of everything else banding.
            nz = np.nonzero(counts)[0]
            dmin = int(nz[0]) if nz.size else 0
            dmax = int(nz[-1]) if nz.size else 1
            _, p_hi = auto_contrast_from_counts(counts, 0.001)
            high = dmax if dmax <= 2 * max(p_hi, 1.0) else int(p_hi)
            low = dmin
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
        response = _VolumeResponse(
            content=mv,
            media_type="application/octet-stream",
            build_lock=_VOLUME_BUILD_LOCK,
        )
        release_lock = False
        return response
    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse(status_code=400, content={"error": str(e)})
    finally:
        if release_lock:
            _VOLUME_BUILD_LOCK.release()


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


_PROJ_LABEL = {"max": "MaxProj", "min": "MinProj", "avg": "AvgProj"}


class CropRectRequest(BaseModel):
    """Source-image pixel crop, measured from the top-left corner."""
    x: int
    y: int
    width: int
    height: int


class ProjectionRequest(BaseModel):
    image_ids: list[str]
    method: str = "max"        # "max" | "min" | "avg"
    z_from: int = 0            # 0-based inclusive
    z_to: int = -1             # 0-based inclusive, -1 = last slice
    t: int = 0                 # time point to project
    output_dir: str = ""       # explicit output folder; falls back to source dir or ~/Desktop
    #: File to write, without extension. Honoured only for one image; a batch
    #: keeps each source name so several images cannot collapse onto one file.
    filename: str = ""
    #: Replace a file that is already there. The source image itself is never a
    #: legal target, even with this set.
    overwrite: bool = False
    #: Identity of each file the user actually approved replacing. A bare
    #: overwrite flag is not enough when rendering can take minutes.
    expected_revisions: dict[str, str] = {}
    #: Optional source-pixel rectangle. It is validated before any projection
    #: plane is read and applied to the resulting 2D projection.
    crop: CropRectRequest | None = None


@app.post("/api/projection/jobs")
def start_projection_job(req: ProjectionRequest):
    return {"job_id": _start_export_job("projection", lambda: apply_projection(req))}


def _image_stem(name: str) -> str:
    """A plain image stem, treating `.ome.tif` as one extension."""
    base = os.path.basename(name.strip())
    lower = base.lower()
    for ext in (".ome.tiff", ".ome.tif"):
        if lower.endswith(ext):
            return base[:-len(ext)]
    return os.path.splitext(base)[0]


def _projection_request_stem(name: str) -> str:
    """Projection name typed by the user, optionally ending in `.ome.tif`."""
    base = name.strip()
    lower = base.lower()
    for ext in (".ome.tiff", ".ome.tif"):
        if lower.endswith(ext):
            base = base[:-len(ext)]
            break
    # This value is already a stem by API contract. Generic splitext would turn
    # the UI preview `sample.v2.ome.tif` into the unrelated `sample.ome.tif`.
    return _validated_export_stem(base)


def _validated_export_stem(name: str) -> str:
    """Accept one literal user-entered stem or fail instead of renaming it."""
    stem = name.strip()
    if not stem:
        raise ValueError("ファイル名が空です。")
    if any(ch in _ILLEGAL_NAME_CHARS for ch in stem):
        raise ValueError('ファイル名に使えない文字が含まれています。')
    if stem.endswith((".", " ")):
        raise ValueError('ファイル名の末尾に「.」や空白は使えません。')
    if len(stem) > 180 or len(stem.encode("utf-8")) > 200:
        raise ValueError('ファイル名が長すぎます（180文字・UTF-8で200バイト以内）。')
    first = stem.split(".", 1)[0].upper()
    if re.fullmatch(r"CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]", first):
        raise ValueError(f"{first} は Windows で予約された名前です。")
    return stem


def _path_key(path: str) -> str:
    """Conservative key for paths that must never name the same file."""
    exact = os.path.realpath(os.path.abspath(path))
    # HFS+/APFS can expose one directory entry through composed and decomposed
    # Unicode spellings. Treating those as separate planned exports lets the
    # second item overwrite the first without a conflict.
    return unicodedata.normalize("NFC", exact).casefold()


def _file_revision(path: str | Path) -> str | None:
    """Cheap identity token for detecting a changed replacement target."""
    try:
        lst = os.lstat(path)
    except OSError:
        return None
    link = (f"{lst.st_dev}:{lst.st_ino}:{lst.st_mode}:{lst.st_size}:"
            f"{lst.st_mtime_ns}:{lst.st_ctime_ns}")
    try:
        st = os.stat(path)
        followed = (f"{st.st_dev}:{st.st_ino}:{st.st_mode}:{st.st_size}:"
                    f"{st.st_mtime_ns}:{st.st_ctime_ns}")
    except OSError:
        followed = "broken"
    return f"v2:{link}:{followed}"


def _target_path_digest(path: str | Path) -> str:
    """Bind an approval token to one exact destination, not just its folder."""
    exact = os.path.realpath(os.path.abspath(str(path)))
    if sys.platform == "darwin":
        exact = unicodedata.normalize("NFC", exact)
    if os.name == "nt":
        exact = os.path.normcase(exact)
    return hashlib.sha256(exact.encode("utf-8")).hexdigest()


def _target_parent_identity(path: str | Path) -> str:
    parent = os.path.dirname(os.path.abspath(str(path))) or os.curdir
    try:
        st = os.stat(parent)
        if not os.path.isdir(parent):
            return "invalid"
    except OSError:
        return "invalid"
    if os.name == "nt":
        # st_ino is frequently zero on Windows/FAT/network filesystems. Hold a
        # real directory handle long enough to obtain the volume serial and file
        # index that distinguish a replacement drive mounted at the same letter.
        try:
            import ctypes
            from ctypes import wintypes

            class _ByHandleFileInformation(ctypes.Structure):
                _fields_ = [
                    ("dwFileAttributes", wintypes.DWORD),
                    ("ftCreationTime", wintypes.FILETIME),
                    ("ftLastAccessTime", wintypes.FILETIME),
                    ("ftLastWriteTime", wintypes.FILETIME),
                    ("dwVolumeSerialNumber", wintypes.DWORD),
                    ("nFileSizeHigh", wintypes.DWORD),
                    ("nFileSizeLow", wintypes.DWORD),
                    ("nNumberOfLinks", wintypes.DWORD),
                    ("nFileIndexHigh", wintypes.DWORD),
                    ("nFileIndexLow", wintypes.DWORD),
                ]

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            create = kernel32.CreateFileW
            create.argtypes = [
                wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
            ]
            create.restype = wintypes.HANDLE
            get_info = kernel32.GetFileInformationByHandle
            get_info.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ByHandleFileInformation)]
            get_info.restype = wintypes.BOOL
            close = kernel32.CloseHandle
            close.argtypes = [wintypes.HANDLE]
            close.restype = wintypes.BOOL

            handle = create(
                parent, 0, 0x00000001 | 0x00000002 | 0x00000004,
                None, 3, 0x02000000, None,
            )
            invalid_handle = ctypes.c_void_p(-1).value
            if handle in (None, invalid_handle):
                return "invalid"
            try:
                info = _ByHandleFileInformation()
                if not get_info(handle, ctypes.byref(info)):
                    return "invalid"
                file_index = (int(info.nFileIndexHigh) << 32) | int(info.nFileIndexLow)
                if not info.dwVolumeSerialNumber and not file_index:
                    return "invalid"
                return f"win-{int(info.dwVolumeSerialNumber):08x}-{file_index:016x}"
            finally:
                close(handle)
        except Exception:
            return "invalid"
    if not st.st_ino:
        return "invalid"
    return f"{st.st_dev}-{st.st_ino}"


def _target_state(path: str | Path) -> str:
    """Path-bound file state including the destination filesystem identity."""
    path_digest = _target_path_digest(path)
    parent = _target_parent_identity(path)
    if parent == "invalid":
        return f"target:v3:{path_digest}:invalid:invalid"
    revision = _file_revision(path)
    if revision is not None:
        return f"target:v3:{path_digest}:{parent}:file:{revision}"
    # Do not include directory times: creating our same-directory stage changes
    # them. Device + inode still detects an unmounted/replaced external drive.
    return f"target:v3:{path_digest}:{parent}:missing"


def _target_state_parts(state: str) -> tuple[str, str, str]:
    parts = state.split(":", 5)
    if len(parts) < 5 or parts[0:2] != ["target", "v3"]:
        return "", "", "invalid"
    return parts[2], parts[3], parts[4]


def _require_stable_target_parent(path: str | Path) -> None:
    if _target_state_parts(_target_state(path))[2] == "invalid":
        raise ValueError(
            f"保存先の同一性を確認できません: {os.path.dirname(os.path.abspath(str(path)))}。"
            "外付けドライブを確認し、保存先を選び直してください。"
        )


def _existing_output_dir(raw: str) -> tuple[str, str]:
    """Resolve an already-existing destination and pin its filesystem identity.

    Never create the selected base path. If an external drive disappears,
    recursively recreating its mount path would silently save to the system disk.
    """
    if not raw.strip():
        raise ValueError("保存先を指定してください。")
    out_dir = os.path.abspath(os.path.expanduser(raw))
    if not os.path.isdir(out_dir):
        raise ValueError(
            f"保存先が見つかりません: {out_dir}。"
            "外付けドライブを確認し、保存先を選び直してください。"
        )
    identity = _target_parent_identity(os.path.join(out_dir, ".oir-dir-probe"))
    if identity == "invalid":
        raise ValueError(
            f"保存先の同一性を確認できません: {out_dir}。"
            "外付けドライブを確認し、保存先を選び直してください。"
        )
    return out_dir, identity


def _assert_output_dir_identity(out_dir: str, expected: str) -> None:
    current = _target_parent_identity(os.path.join(out_dir, ".oir-dir-probe"))
    if current != expected:
        raise ValueError(
            f"保存先のドライブまたはフォルダが途中で変わりました: {out_dir}。"
            "別の場所への誤保存を防ぐため、保存先を選び直してください。"
        )


_export_locks_guard = threading.Lock()
_export_locks: dict[str, threading.Lock] = {}


def _locks_for_targets(paths: list[str | Path]) -> list[threading.Lock]:
    """Stable per-target locks, ordered so a batch cannot deadlock another."""
    keys = sorted({_path_key(str(p)) for p in paths})
    with _export_locks_guard:
        return [_export_locks.setdefault(key, threading.Lock()) for key in keys]


def _acquire_process_target_locks(paths: list[str | Path]) -> list[object]:
    """Cross-process commit locks shared by packaged and source backends."""
    lock_dir = os.path.join(APP_DIR, "export-locks")
    os.makedirs(lock_dir, exist_ok=True)
    handles: list[object] = []
    try:
        for key in sorted({_path_key(str(path)) for path in paths}):
            digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
            handle = open(os.path.join(lock_dir, f"{digest}.lock"), "a+b")
            if os.name == "nt":
                import msvcrt
                handle.seek(0, os.SEEK_END)
                if handle.tell() == 0:
                    handle.write(b"\0")
                    handle.flush()
                deadline = time.monotonic() + 30
                while True:
                    handle.seek(0)
                    try:
                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                        break
                    except OSError:
                        if time.monotonic() >= deadline:
                            raise TimeoutError("保存先が別の処理で使用中です。")
                        time.sleep(0.02)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            handles.append(handle)
        return handles
    except Exception:
        _release_process_target_locks(handles)
        raise


def _release_process_target_locks(handles: list[object]) -> None:
    for handle in reversed(handles):
        try:
            if os.name == "nt":
                import msvcrt
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


def _target_write_conflicts(
    paths: list[str | Path],
    overwrite: bool,
    expected_revisions: dict[str, str],
) -> list[str]:
    """Targets that appeared, vanished, or changed since user confirmation."""
    conflicts: list[str] = []
    for raw in paths:
        path = os.path.abspath(str(raw))
        current = _target_state(path)
        expected = expected_revisions.get(path, "")
        _digest, _parent, current_kind = _target_state_parts(current)
        if overwrite:
            # Approval is target-specific. `overwrite=True` by itself is never
            # authority to replace a file or to create another batch member.
            if not expected or current != expected:
                conflicts.append(path)
        elif current_kind == "file" or (expected and current != expected):
            # A normal create never overwrites, even if a caller happens to send
            # the correct revision. This keeps the boolean contract meaningful.
            conflicts.append(path)
    return conflicts


def _targets_with_changed_parent(
    paths: list[str | Path], expected_revisions: dict[str, str],
) -> list[str]:
    """Destinations whose selected filesystem disappeared or was replaced."""
    changed: list[str] = []
    for raw in paths:
        path = os.path.abspath(str(raw))
        expected = expected_revisions.get(path, "")
        if not expected:
            continue
        expected_path, expected_parent, _ekind = _target_state_parts(expected)
        current_path, current_parent, _ckind = _target_state_parts(_target_state(path))
        if (not expected_parent or current_parent != expected_parent
                or not expected_path or current_path != expected_path):
            changed.append(path)
    return changed


def _changed_parent_response(paths: list[str]) -> JSONResponse:
    names = ", ".join(os.path.basename(path) for path in paths[:3])
    return JSONResponse(status_code=409, content={
        "conflict": False,
        "error": (f"保存先のドライブまたはフォルダが途中で変わりました: {names}。"
                  "別の場所への誤保存を防ぐため、保存先を選び直してください。"),
    })


def _confirmed_targets_missing(
    paths: list[str | Path], expected_revisions: dict[str, str],
) -> list[str]:
    """Approved existing targets that disappeared before publication."""
    return [
        os.path.abspath(str(path))
        for path in paths
        if _target_state_parts(
            expected_revisions.get(os.path.abspath(str(path)), "")
        )[2] == "file"
        and _target_state_parts(_target_state(path))[2] != "file"
    ]


def _missing_target_response(paths: list[str]) -> JSONResponse:
    names = ", ".join(os.path.basename(path) for path in paths[:3])
    return JSONResponse(status_code=409, content={
        "conflict": False,
        "error": (f"上書きを確認したファイルがなくなりました: {names}。"
                  "保存先を確認して、通常の作成からやり直してください。"),
    })


def _same_existing_file(a: str | Path, b: str | Path) -> bool:
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


def _open_source_conflicts(targets: list[str | Path]) -> list[str]:
    """Export targets that alias any source in an open tab."""
    with _state_lock:
        sources = [
            r.metadata.source_path for r in images.values()
            if r.metadata.source_path
        ]
    out: list[str] = []
    for raw in targets:
        target = os.path.abspath(str(raw))
        if any(
            _path_key(target) == _path_key(source)
            or _same_existing_file(target, source)
            for source in sources
        ):
            out.append(target)
    return out


def _assert_targets_not_open_sources(targets: list[str | Path]) -> None:
    """Refuse replacing source bytes with a derived export."""
    conflicts = _open_source_conflicts(targets)
    if conflicts:
        names = ", ".join(os.path.basename(path) for path in conflicts[:3])
        raise ValueError(
            f"保存先が開いている元画像と同じファイルです: {names}。"
            "元画像の破損を防ぐため、別の名前または保存先を指定してください。"
        )


def _unload_other_projection_sources(keep_id: str) -> None:
    """Keep at most the source currently being projected resident."""
    with _state_lock:
        readers = [(image_id, reader) for image_id, reader in images.items()]
    for image_id, reader in readers:
        if image_id != keep_id:
            reader.unload()


def _fsync_file(path: str | Path) -> None:
    """Flush a completed staged file before publishing its directory entry."""
    # Windows' CRT rejects _commit() on a read-only descriptor with EBADF.
    # Reopen without truncating, but keep the descriptor writable on every OS.
    with open(path, "r+b") as f:
        os.fsync(f.fileno())


class _TargetChangedDuringPublish(Exception):
    def __init__(self, paths: list[str]):
        super().__init__("export targets changed before publication")
        self.paths = paths


class _TargetParentChangedDuringPublish(_TargetChangedDuringPublish):
    """The selected destination filesystem changed while backups were copied."""


def _publish_staged_files(
    staged_paths: list[str], targets: list[str], overwrite: bool,
    expected_revisions: dict[str, str],
    pre_publish: Callable[[], None] | None = None,
    post_publish: Callable[[], None] | None = None,
) -> None:
    """Publish a validated batch and roll it back if final validation fails."""
    if len(staged_paths) != len(targets):
        raise ValueError("投影の一時ファイル数が保存先数と一致しません。")
    # Without a fallible post-publication check, one atomic replace cannot leave
    # a partial batch and needs no potentially expensive copy of the old file.
    if len(targets) == 1 and post_publish is None:
        changed_parent = _targets_with_changed_parent(targets, expected_revisions)
        if changed_parent:
            raise _TargetParentChangedDuringPublish(changed_parent)
        clash = _target_write_conflicts(targets, overwrite, expected_revisions)
        if clash:
            raise _TargetChangedDuringPublish(clash)
        if pre_publish:
            pre_publish()
        os.replace(staged_paths[0], targets[0])
        return

    backups: dict[str, str | None] = {}
    published: list[str] = []
    recovery_backups: set[str] = set()
    try:
        # Preserve every old directory entry before changing the first target.
        # Do not hardlink: creating one changes the source inode's ctime, which
        # would invalidate the very revision token checked immediately below.
        for target in targets:
            if not os.path.lexists(target):
                backups[target] = None
                continue
            fd, backup = tempfile.mkstemp(
                dir=os.path.dirname(target),
                prefix=".oirrollback-", suffix=".bak",
            )
            os.close(fd)
            os.unlink(backup)
            # Register before copy2: a full drive or disconnect can leave a large
            # partial backup, and finally must still know to remove it.
            backups[target] = backup
            shutil.copy2(target, backup, follow_symlinks=False)

        # A fallback copy on a filesystem without hardlinks may itself take
        # seconds. Revalidate after all backups, at the last point before the
        # first public name changes.
        changed_parent = _targets_with_changed_parent(targets, expected_revisions)
        if changed_parent:
            raise _TargetParentChangedDuringPublish(changed_parent)
        clash = _target_write_conflicts(targets, overwrite, expected_revisions)
        if clash:
            raise _TargetChangedDuringPublish(clash)
        # Backups can take seconds on filesystems without hardlinks. Revalidate
        # sources and open-tab aliases at the actual publication boundary too.
        if pre_publish:
            pre_publish()

        try:
            for staged, target in zip(staged_paths, targets):
                os.replace(staged, target)
                published.append(target)
            # Some formats become open tabs immediately after publication and
            # need a final source token under the public path. Keep that
            # fallible validation inside the transaction: a failure must restore
            # every old target instead of returning 400 after changing files.
            if post_publish:
                post_publish()
        except Exception as publish_error:
            rollback_errors: list[str] = []
            for target in reversed(published):
                backup = backups[target]
                try:
                    if backup is None:
                        if os.path.lexists(target):
                            os.unlink(target)
                    else:
                        os.replace(backup, target)
                        backups[target] = None
                except OSError as e:
                    if backup:
                        recovery_backups.add(backup)
                    rollback_errors.append(
                        f"{os.path.basename(target)}: {e}"
                        + (f" (recovery: {backup})" if backup else "")
                    )
            if rollback_errors:
                raise RuntimeError(
                    "投影の公開と旧版への復元に失敗しました: "
                    + "; ".join(rollback_errors)
                ) from publish_error
            raise
    finally:
        for backup in backups.values():
            if backup and backup not in recovery_backups and os.path.lexists(backup):
                try:
                    os.unlink(backup)
                except OSError:
                    pass


def _projection_output_dir(req: ProjectionRequest, meta: ImageMetadata) -> str:
    if req.output_dir:
        out_dir = os.path.abspath(os.path.expanduser(req.output_dir))
    elif (meta.source_path
            and not meta.source_path.startswith(("/tmp", "/var", "/private/var", "/private/tmp"))):
        out_dir = os.path.dirname(meta.source_path)
    else:
        out_dir = os.path.expanduser("~/Desktop")
    if not os.path.isdir(out_dir):
        raise ValueError(
            f"保存先が見つかりません: {out_dir}。"
            "外付けドライブを確認し、保存先を選び直してください。"
        )
    return out_dir


def _projection_target(req: ProjectionRequest, meta: ImageMetadata, batch: bool) -> str:
    """Resolve the exact projection path without reading a pixel."""
    if req.filename.strip() and not batch:
        raw_stem = _projection_request_stem(req.filename)
    else:
        raw_stem = f"{_image_stem(meta.filename)}_{_PROJ_LABEL[req.method]}"
    stem = _validated_export_stem(_safe_name_part(raw_stem) or "projection")
    target = os.path.join(_projection_output_dir(req, meta), f"{stem}.ome.tif")
    _require_stable_target_parent(target)
    return target


def _projection_runtime_plan(
    reader: ImageReader,
    req: ProjectionRequest,
    planned_target: str,
    batch: bool,
) -> tuple[ImageMetadata, int, int, int]:
    """Load a deferred reader, then derive ranges from its authoritative metadata."""
    cached = reader.metadata
    _assert_projection_source_unchanged(cached)
    reader.ensure_loaded()
    meta = reader.metadata
    _assert_projection_source_unchanged(meta)
    if meta.warning:
        raise ValueError(
            f"{meta.filename}: {meta.warning}\n"
            "不完全な Z スタックは投影していません。"
        )

    # Session metadata is intentionally only a lightweight cache. If the source
    # changed on disk, never redirect an already-approved save to a different
    # name or folder; report it and let a retry plan the now-current target.
    current_target = _projection_target(req, meta, batch)
    if _path_key(current_target) != _path_key(planned_target):
        raise ValueError(
            "画像情報が読み込み時に更新され、投影の保存先が変わりました。もう一度実行してください。"
        )
    if meta.source_path and _path_key(planned_target) == _path_key(meta.source_path):
        raise ValueError(
            "投影の保存先を元画像と同じファイルにはできません。別の名前を指定してください。"
        )

    if meta.num_z < 1 or meta.num_t < 1:
        raise ValueError(f"画像の Z/T 次元が不正です: {meta.filename}")
    z_to = req.z_to if req.z_to >= 0 else meta.num_z - 1
    if req.z_from < 0 or req.z_from >= meta.num_z or z_to < req.z_from or z_to >= meta.num_z:
        raise ValueError(
            f"指定した Z 範囲は {meta.filename} の 1–{meta.num_z} を超えています。"
        )
    if req.t < 0 or req.t >= meta.num_t:
        raise ValueError(
            f"指定した T={req.t + 1} は {meta.filename} の 1–{meta.num_t} を超えています。"
        )
    z_from = req.z_from
    t = req.t
    return meta, z_from, z_to, t


def _assert_projection_source_unchanged(meta: ImageMetadata) -> None:
    """Reject a source whose physical file or split chunks no longer match."""
    if not meta.source_path or not (meta.source_identity or meta.source_revision):
        return
    try:
        current = snapshot_source(meta.source_path)
    except OSError as e:
        raise ValueError(
            f"元画像が見つかりません: {meta.source_path}。ドライブを確認してください。"
        ) from e
    if ((meta.source_identity and current.identity != meta.source_identity)
            or (meta.source_revision and current.revision != meta.source_revision)):
        raise ValueError(
            f"{meta.filename}: 元画像または分割 OIR の続きが、表示後に変更されました。"
            "タブを閉じて画像を開き直してください。"
        )


def _build_ome_xml(meta, n_channels: int, height: int, width: int, method: str,
                   z_from: int, z_to: int, t: int) -> str:
    """Build OME-XML metadata string for projected image."""
    from xml.etree.ElementTree import Element, SubElement, tostring

    ome = Element("OME", xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06")
    img = SubElement(
        ome, "Image", ID="Image:0",
        Name=(f"{meta.filename} ({method.upper()} Proj "
              f"T{t + 1} Z{z_from + 1}-{z_to + 1})"),
    )
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
        pixels.set("PhysicalSizeXUnit", "µm")
    if meta.pixel_size_y > 0:
        pixels.set("PhysicalSizeY", f"{meta.pixel_size_y:.6f}")
        pixels.set("PhysicalSizeYUnit", "µm")

    for c in range(n_channels):
        ch_name = meta.channel_names[c] if c < len(meta.channel_names) else f"Ch{c}"
        SubElement(pixels, "Channel", ID=f"Channel:0:{c}", Name=ch_name, SamplesPerPixel="1")
    for c in range(n_channels):
        SubElement(pixels, "TiffData", FirstC=str(c), FirstZ="0", FirstT="0", IFD=str(c))

    # tifffile requires an ASCII TIFF description. ElementTree keeps Unicode
    # channel names losslessly as numeric XML references when encoded as ASCII.
    return tostring(ome, encoding="ascii", xml_declaration=True).decode("ascii")


def _projection_ome_signature(xml: str) -> tuple:
    """Parse and validate the scientific metadata written with a projection."""
    from xml.etree import ElementTree as ET

    namespace = "http://www.openmicroscopy.org/Schemas/OME/2016-06"
    q = lambda tag: f"{{{namespace}}}{tag}"
    try:
        root = ET.fromstring(xml)
    except (ET.ParseError, TypeError) as e:
        raise ValueError("OME-XML を読み戻せません。") from e
    if root.tag != q("OME"):
        raise ValueError("OME-XML のschemaが不正です。")
    images_xml = root.findall(q("Image"))
    if len(images_xml) != 1:
        raise ValueError("OME-XML のImage数が一致しません。")
    image = images_xml[0]
    if image.attrib.get("ID") != "Image:0" or not image.attrib.get("Name"):
        raise ValueError("OME-XML のImage IDまたは由来名が不正です。")
    pixels_xml = image.findall(q("Pixels"))
    if len(pixels_xml) != 1:
        raise ValueError("OME-XML のPixels要素が一致しません。")
    pixels = pixels_xml[0]
    if pixels.attrib.get("ID") != "Pixels:0":
        raise ValueError("OME-XML のPixels IDが不正です。")
    try:
        sizes = tuple(int(pixels.attrib[f"Size{axis}"]) for axis in "XYCZT")
    except (KeyError, TypeError, ValueError) as e:
        raise ValueError("OME-XML の画像サイズが不正です。") from e
    if (any(value <= 0 for value in sizes)
            or pixels.attrib.get("DimensionOrder") != "XYCZT"
            or pixels.attrib.get("Type") != "uint16"
            or sizes[3:] != (1, 1)):
        raise ValueError("OME-XML の投影次元または画素型が不正です。")
    for axis in "XY":
        value = pixels.attrib.get(f"PhysicalSize{axis}")
        unit = pixels.attrib.get(f"PhysicalSize{axis}Unit")
        if (value is None) != (unit is None):
            raise ValueError("OME-XML の物理pixel sizeと単位が一致しません。")
        if value is not None:
            try:
                physical = float(value)
            except ValueError as e:
                raise ValueError("OME-XML の物理pixel sizeが不正です。") from e
            if not np.isfinite(physical) or physical <= 0 or unit != "µm":
                raise ValueError("OME-XML の物理pixel sizeまたは単位が不正です。")
    channels = pixels.findall(q("Channel"))
    tiff_data = pixels.findall(q("TiffData"))
    if len(channels) != sizes[2] or len(tiff_data) != sizes[2]:
        raise ValueError("OME-XML のchannel数が一致しません。")
    channel_signature = tuple(
        (channel.attrib.get("ID"), channel.attrib.get("Name"),
         channel.attrib.get("SamplesPerPixel"))
        for channel in channels
    )
    tiff_signature = tuple(
        (item.attrib.get("FirstC"), item.attrib.get("FirstZ"),
         item.attrib.get("FirstT"), item.attrib.get("IFD"))
        for item in tiff_data
    )
    expected_tiff = tuple((str(i), "0", "0", str(i)) for i in range(sizes[2]))
    if (any(item[0] != f"Channel:0:{i}" or not item[1] or item[2] != "1"
            for i, item in enumerate(channel_signature))
            or tiff_signature != expected_tiff):
        raise ValueError("OME-XML のchannel/IFD対応が不正です。")
    return (
        image.attrib.get("ID"), image.attrib.get("Name"),
        tuple(sorted(pixels.attrib.items())), channel_signature, tiff_signature,
    )


def _assert_projection_ome(saved_xml: str, expected_xml: str) -> None:
    """Require the reopened OME metadata to match every authored field."""
    if _projection_ome_signature(saved_xml) != _projection_ome_signature(expected_xml):
        raise ValueError("OME-XML の内容が書き出し条件と一致しません。")


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
    source_identity: str
    source_revision: str
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
    release_lock = True
    _MEMORY_HEAVY_LOCK.acquire()
    try:
        # Invalidate any interactive 3D approval made before this well started.
        # Keep the same reservation until its possibly source-resolution payload
        # has left uvicorn, just as /api/volume-bin does.
        _advance_memory_epoch()
        spec = plate.VolumeSpec(
            path=req.path,
            source_identity=req.source_identity,
            source_revision=req.source_revision,
            channels=list(req.channels),
            levels=[(float(a), float(b)) for a, b in req.levels],
            t=int(req.t),
            max_xy=int(req.max_xy),
        )
        info, payload = plate.read_low_volume(spec)
        response = _VolumeResponse(
            content=payload,
            media_type="application/octet-stream",
            headers={"X-Plate-Volume": json.dumps(info)},
            build_lock=_MEMORY_HEAVY_LOCK,
        )
        release_lock = False
        return response
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(status_code=400, content={"error": _describe(e)})
    finally:
        if release_lock:
            _MEMORY_HEAVY_LOCK.release()


def _selftest_plate_volume_reservation() -> int:
    """Prove a plate payload owns the shared gate until ASGI sends it."""
    global _memory_epoch
    import asyncio

    saved_reader = plate.read_low_volume
    with _MEMORY_EPOCH_LOCK:
        saved_epoch = _memory_epoch
    gate_probe_owned = False
    try:
        plate.read_low_volume = lambda _spec: ({"test": True}, b"plate-bytes")
        response = plate_volume_bin(PlateVolumeRequest(
            path="unused.oir",
            source_identity="identity",
            source_revision="revision",
            channels=[0],
            levels=[[0.0, 1.0]],
        ))
        if not isinstance(response, _VolumeResponse):
            raise AssertionError(f"plate success did not return reserved response: {response}")
        if _MEMORY_HEAVY_LOCK.acquire(blocking=False):
            gate_probe_owned = True
            raise AssertionError("plate response released reservation before send")

        sent: list[dict] = []

        async def receive() -> dict:
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message: dict) -> None:
            sent.append(message)

        asyncio.run(response(
            {"type": "http", "method": "POST", "path": "/api/plate/volume-bin",
             "headers": []},
            receive,
            send,
        ))
        if (not sent or sent[-1].get("body") != b"plate-bytes"
                or _memory_epoch_snapshot() != saved_epoch + 1):
            raise AssertionError("plate response send or epoch advance drifted")
        if not _MEMORY_HEAVY_LOCK.acquire(blocking=False):
            raise AssertionError("plate response did not release reservation after send")
        gate_probe_owned = True
    except Exception as e:
        print(f"selftest FAILED: plate volume reservation -> {type(e).__name__}: {e}",
              flush=True)
        return 32
    finally:
        plate.read_low_volume = saved_reader
        if gate_probe_owned:
            _MEMORY_HEAVY_LOCK.release()
        with _MEMORY_EPOCH_LOCK:
            _memory_epoch = saved_epoch

    print("selftest: plate volume reservation OK (shared epoch, held through send)",
          flush=True)
    return 0


class PlateFrame(BaseModel):
    well_id: str
    row: int
    col: int
    #: Exact logical source whose verified volume produced this rendered frame.
    source_path: str
    source_identity: str
    source_revision: str
    #: base64 PNG of the rendered well.
    png_b64: str
    #: Lines printed over the top-left of this well's image. Empty falls back to
    #: the well ID, so a cell is never unlabelled.
    caption: list[str] = []


class PlatePdfTargetRequest(BaseModel):
    plate_name: str
    output_dir: str
    #: File to write, without extension. Empty resolves to the plate name plus a
    #: timestamp; the check endpoint returns that resolved name so the client can
    #: freeze it for a long render.
    filename: str = ""


class PlatePdfRequest(PlatePdfTargetRequest):
    rows: int
    cols: int
    frames: list[PlateFrame]
    #: well_id -> why that cell is empty: "disabled", "excluded" (imaged but not
    #: selected) or "missing" (imaged but no stitched file). A well_id that is
    #: absent was never imaged. Only cells with no frame consult this.
    well_states: dict[str, str] = {}
    #: Pack rendered wells in plate order without drawing empty grid positions.
    hide_empty_wells: bool = False
    cell_px: int = 600
    footer: str = ""
    #: Conditions table, written as a second page in the same PDF. Empty omits
    #: the page entirely rather than adding a blank one.
    table_headers: list[str] = []
    table_rows: list[list[str]] = []
    #: Replace a file that is already there instead of refusing.
    overwrite: bool = False
    #: Identity returned with the conflict the user approved. The final write
    #: is refused if another process changes that file during the long render.
    expected_revision: str = ""


def _assert_plate_sources_unchanged(frames: list[PlateFrame]) -> None:
    """Reject a PDF if any already-rendered well now names different bytes."""
    seen: dict[str, str] = {}
    for frame in frames:
        path = frame.source_path.strip()
        if not path or not frame.source_identity or not frame.source_revision:
            raise ValueError(
                f"{frame.well_id}: 元画像の検証情報がないため PDF は作成しません。"
            )
        try:
            current = snapshot_source(path)
        except OSError as e:
            raise ValueError(
                f"{frame.well_id}: 元画像が見つかりません。ドライブを確認してください。"
            ) from e
        if (current.identity != frame.source_identity
                or current.revision != frame.source_revision):
            raise ValueError(
                f"{frame.well_id}: 描画後に元画像または分割 OIR の続きが変更されました。"
                "PDF は作成していません。画像タブを開き直してください。"
            )
        other = seen.get(current.identity)
        if other is not None and other != frame.well_id:
            raise ValueError(
                f"{other} と {frame.well_id} が同じ元画像を参照しています。"
                "ウェル対応を確認してください。"
            )
        seen[current.identity] = frame.well_id


def _plate_pdf_target(req: PlatePdfTargetRequest) -> tuple[Path, Path, str]:
    """Resolve one PDF target before any rendered frame is decoded."""
    out_dir = Path(req.output_dir).expanduser().resolve()
    if not out_dir.is_dir():
        raise ValueError(f"保存先が見つかりません: {out_dir}")
    if req.filename:
        # The API contract is an extension-less stem. Be tolerant of a literal
        # trailing .pdf, but never use splitext(): a checked name such as
        # ``figure.v2.final`` must remain identical when it is posted again
        # after a long render.
        raw = req.filename.strip()
        if raw.lower().endswith(".pdf"):
            raw = raw[:-4]
        stem = _validated_export_stem(raw)
    else:
        safe = _safe_name_part(req.plate_name) or "plate"
        stem = _validated_export_stem(
            f"{safe}_plate3d_{time.strftime('%Y%m%d-%H%M%S')}"
        )
    target = out_dir / f"{stem}.pdf"
    _require_stable_target_parent(target)
    return out_dir, target, stem


@app.post("/api/plate/pdf/check")
def plate_pdf_check(req: PlatePdfTargetRequest):
    """Resolve and check the PDF name without receiving or decoding well frames."""
    try:
        out_dir, target, stem = _plate_pdf_target(req)
        if os.path.lexists(target):
            return _conflict_response([str(target)], str(out_dir))
        return {
            "path": str(target), "filename": stem,
            "revision": _target_state(target),
        }
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": _describe(e)})


@app.post("/api/plate/pdf")
def plate_pdf(req: PlatePdfRequest):
    """Compose rendered wells into one PDF in plate order.

    All or nothing by construction: the caller sends frames only for wells it
    rendered successfully, and it is the caller's job to abort rather than send a
    partial set — a PDF missing a well that WAS acquired would look like a plate
    where that well was empty.
    """
    staged = ""
    try:
        out_dir, target, _stem = _plate_pdf_target(req)
        # This check must precede base64 decoding. In the real workflow those
        # frames cost minutes of volume reads and GPU rendering before this POST.
        expected = ({os.path.abspath(str(target)): req.expected_revision}
                    if req.expected_revision else {})
        changed_parent = _targets_with_changed_parent([target], expected)
        if changed_parent:
            return _changed_parent_response(changed_parent)
        missing = _confirmed_targets_missing([target], expected)
        if req.overwrite and missing:
            return _missing_target_response(missing)
        clash = _target_write_conflicts([target], req.overwrite, expected)
        if clash:
            return _conflict_response(clash, str(out_dir))
        if not expected:
            expected = {os.path.abspath(str(target)): _target_state(target)}
        # Validate placement before decoding even one PNG. Pillow otherwise
        # drops out-of-grid frames and a dict silently replaces duplicate cells.
        plate.validate_pdf_layout(
            int(req.rows), int(req.cols), list(req.frames), dict(req.well_states),
            int(req.cell_px), list(req.table_headers),
            [list(row) for row in req.table_rows],
            bool(req.hide_empty_wells),
        )
        _assert_plate_sources_unchanged(list(req.frames))
        frames = [
            plate.WellFrame(f.well_id, f.row, f.col,
                            base64.b64decode(f.png_b64, validate=True),
                            list(f.caption))
            for f in req.frames
        ]
        with tempfile.NamedTemporaryFile(
            dir=out_dir, prefix=".oirpdf-", suffix=".pdf", delete=False,
        ) as f:
            staged = f.name
        out = plate.compose_pdf(
            Path(staged),
            req.plate_name, int(req.rows), int(req.cols),
            frames, dict(req.well_states), int(req.cell_px), req.footer,
            table_headers=list(req.table_headers),
            table_rows=[list(r) for r in req.table_rows],
            hide_empty_wells=bool(req.hide_empty_wells),
        )
        _fsync_file(out)
        size = out.stat().st_size
        with open(out, "rb") as f:
            head = f.read(5)
            f.seek(max(0, size - 128))
            tail = f.read()
        if head != b"%PDF-" or b"%%EOF" not in tail:
            raise ValueError("作成した PDF の検証に失敗しました。元のファイルは変更していません。")
        _assert_plate_sources_unchanged(list(req.frames))

        locks = _locks_for_targets([target])
        for lock in locks:
            lock.acquire()
        process_locks: list[object] = []
        try:
            process_locks = _acquire_process_target_locks([target])
            # Recheck immediately before atomic publication. Dropbox or another
            # app may have changed the approved file during the long render.
            changed_parent = _targets_with_changed_parent([target], expected)
            if changed_parent:
                return _changed_parent_response(changed_parent)
            missing = _confirmed_targets_missing([target], expected)
            if req.overwrite and missing:
                return _missing_target_response(missing)
            clash = _target_write_conflicts([target], req.overwrite, expected)
            if clash:
                return _conflict_response(clash, str(out_dir))
            try:
                _publish_staged_files(
                    [staged], [str(target)], req.overwrite, expected,
                    pre_publish=lambda: _assert_plate_sources_unchanged(list(req.frames)),
                )
            except _TargetParentChangedDuringPublish as e:
                return _changed_parent_response(e.paths)
            except _TargetChangedDuringPublish as e:
                return _conflict_response(e.paths, str(out_dir))
            staged = ""
        finally:
            _release_process_target_locks(process_locks)
            for lock in reversed(locks):
                lock.release()
        return {"path": str(target), "wells": len(frames), "bytes": size}
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(status_code=400, content={"error": _describe(e)})
    finally:
        if staged and os.path.exists(staged):
            try:
                os.unlink(staged)
            except OSError:
                pass


@app.post("/api/projection")
def apply_projection(req: ProjectionRequest):
    """Project Z slices, save as OME-TIFF, and open in a new tab."""
    import tifffile

    staged_paths: list[str] = []
    staged_readers: list[ImageReader] = []
    staged_ome_xmls: list[str] = []
    try:
        if req.method not in _PROJ_LABEL:
            raise ValueError(f"Unsupported projection method: {req.method}")
        if not req.image_ids:
            raise ValueError("画像を1つ以上選択してください")

        results: list[dict] = []
        pending: list[tuple[str, ImageReader, ImageMetadata, str, tuple[int, int, int, int] | None]] = []
        runtime_sources: list[ImageMetadata] = []
        batch = len(req.image_ids) > 1

        # Resolve every destination before reading a single plane. A collision
        # refusal therefore leaves both the source data and output folder intact.
        for img_id in req.image_ids:
            r = get_reader(img_id)
            # A restored session initially has only cached dimensions. Upgrade
            # metadata without pixels so channel counts — and therefore the
            # progress denominator — are authoritative before work begins.
            if not getattr(r, "_metadata_authoritative", True):
                _ensure_reader_ready_reserved(r, img_id, metadata_only=True)
            meta = r.metadata
            out_path = _projection_target(req, meta, batch)
            crop_rect = _resolve_crop_rect(req.crop, int(meta.width), int(meta.height))
            pending.append((img_id, r, meta, out_path, crop_rect))

        target_keys = [_path_key(item[3]) for item in pending]
        if len(set(target_keys)) != len(target_keys):
            raise ValueError(
                "複数の投影が同じ出力名になります。元ファイル名が重複していないか確認してください。"
            )

        targets = [item[3] for item in pending]
        if _open_source_conflicts(targets):
            raise ValueError(
                "投影の保存先を開いている元画像と同じファイルにはできません。"
                "別の名前を指定するか、その画像タブを閉じてください。"
            )

        changed_parent = _targets_with_changed_parent(targets, dict(req.expected_revisions))
        if changed_parent:
            return _changed_parent_response(changed_parent)
        missing = _confirmed_targets_missing(targets, dict(req.expected_revisions))
        if req.overwrite and missing:
            return _missing_target_response(missing)
        clash = _target_write_conflicts(
            targets, req.overwrite, dict(req.expected_revisions),
        )
        if clash:
            return _conflict_response(
                clash, os.path.dirname(clash[0]), revision_paths=targets,
            )
        commit_expected = dict(req.expected_revisions)
        for target in targets:
            commit_expected.setdefault(os.path.abspath(target), _target_state(target))

        total_units = sum(max(1, item[2].num_channels) for item in pending) + len(pending) + 1
        completed_units = 0
        _export_progress(
            "projecting", completed_units, total_units,
            f"Z投影を保存中（0/{len(pending)}画像）…",
        )

        for image_index, (img_id, r, _cached_meta, out_path, crop_rect) in enumerate(pending):
            # A restored session deliberately carries dimensions only. Loading
            # can replace them with authoritative channel names, pixel sizes,
            # channel count and ranges; use those for both pixels and OME-XML.
            # Real wells are ~4.25 GB decoded. Evict even the active source before
            # loading the next batch item; tabs remain and reload transparently.
            # Reserve only pixel loading/projection. The completed 2D stack no
            # longer references the 5D source, so release the shared gate before
            # staged-file I/O and, critically, before publication target locks.
            # Open takes target locks before this gate; reversing that order here
            # would deadlock an open against projection publication.
            with _memory_heavy_reservation():
                _unload_other_projection_sources(img_id)
                meta, z_from, z_to, t = _projection_runtime_plan(
                    r, req, out_path, batch,
                )
                crop_rect = _resolve_crop_rect(req.crop, int(meta.width), int(meta.height))
                runtime_sources.append(meta)

                # Project all channels: result shape (C, Y, X)
                projected = []
                for c in range(meta.num_channels):
                    proj = r.get_projection(c, t, z_from, z_to, req.method)
                    proj = _crop_plane(proj, crop_rect)
                    projected.append(proj)
                    completed_units += 1
                    _export_progress(
                        "projecting", completed_units, total_units,
                        f"{meta.filename}: チャンネルを投影中（{c + 1}/{meta.num_channels}）…",
                    )
                proj_stack = np.stack(projected, axis=0)  # (C, Y, X)
                h, w = proj_stack.shape[1], proj_stack.shape[2]
                # The copied 2D stack is independent of the multi-GB source.
                r.unload()

            # Build OME-XML
            ome_xml = _build_ome_xml(
                meta, meta.num_channels, h, w, req.method, z_from, z_to, t,
            )

            # Write and numerically reopen a same-directory temporary file. If
            # encoding, validation, or an external drive fails, the approved
            # existing image is still untouched.
            with tempfile.NamedTemporaryFile(
                dir=os.path.dirname(out_path),
                prefix=".oirp-", suffix=".ome.tif",
                delete=False,
            ) as f:
                staged = f.name
            staged_paths.append(staged)
            tifffile.imwrite(staged, proj_stack, photometric='minisblack',
                             description=ome_xml, metadata=None)
            _fsync_file(staged)
            with tifffile.TiffFile(staged) as tif:
                check = np.asarray(tif.asarray())
                saved_ome = tif.ome_metadata
            if check.ndim == 2 and proj_stack.shape[0] == 1:
                check = check[np.newaxis, ...]
            if (check.dtype != proj_stack.dtype or check.shape != proj_stack.shape
                    or not np.array_equal(check, proj_stack) or not saved_ome):
                raise ValueError(
                    "作成した OME-TIFF の数値検証に失敗しました。"
                    "元のファイルは変更していません。"
                )
            try:
                _assert_projection_ome(saved_ome, ome_xml)
            except ValueError as e:
                raise ValueError(
                    "作成した OME-TIFF のmetadata検証に失敗しました。"
                    "元のファイルは変更していません。"
                ) from e
            _assert_projection_source_unchanged(meta)
            # Prove the ordinary viewer can open this exact staged artifact
            # before any public filename changes. These readers already hold the
            # small 2D projections and can be registered after publication,
            # avoiding a post-commit load failure reported as a save failure.
            staged_reader = ImageReader()
            staged_reader.load_file(staged)
            staged_readers.append(staged_reader)
            staged_ome_xmls.append(ome_xml)
            completed_units += 1
            _export_progress(
                "verifying", completed_units, total_units,
                f"{meta.filename}: 保存結果を確認済み（{image_index + 1}/{len(pending)}画像）",
            )

        # Recheck every source after all staged files are complete. A source that
        # changed during another batch member must not acquire valid-looking
        # output provenance under its now-different path.
        for source_meta in runtime_sources:
            _assert_projection_source_unchanged(source_meta)

        # Validate every target together under stable locks, then publish each
        # completed file with an atomic same-filesystem replace.
        _export_progress(
            "publishing", completed_units, total_units,
            "検証済みOME-TIFFを公開中…",
        )
        locks = _locks_for_targets(targets)
        for lock in locks:
            lock.acquire()
        process_locks: list[object] = []
        try:
            process_locks = _acquire_process_target_locks(targets)
            if _open_source_conflicts(targets):
                raise ValueError(
                    "投影中に保存先と同じ元画像が開かれました。"
                    "その画像タブを閉じて、もう一度実行してください。"
                )
            for source_meta in runtime_sources:
                _assert_projection_source_unchanged(source_meta)
            changed_parent = _targets_with_changed_parent(targets, commit_expected)
            if changed_parent:
                return _changed_parent_response(changed_parent)
            missing = _confirmed_targets_missing(targets, commit_expected)
            if req.overwrite and missing:
                return _missing_target_response(missing)
            clash = _target_write_conflicts(
                targets, req.overwrite, commit_expected,
            )
            if clash:
                return _conflict_response(
                    clash, os.path.dirname(clash[0]), revision_paths=targets,
                )
            try:
                def validate_projection_sources() -> None:
                    if _open_source_conflicts(targets):
                        raise ValueError(
                            "投影中に保存先と同じ元画像が開かれました。"
                            "その画像タブを閉じて、もう一度実行してください。"
                        )
                    for source_meta in runtime_sources:
                        _assert_projection_source_unchanged(source_meta)

                def bind_published_projection_sources() -> None:
                    for index, (staged_reader, expected_ome, target) in enumerate(
                        zip(staged_readers, staged_ome_xmls, targets)
                    ):
                        # Reopen the actual public name, not only its stat token.
                        # An external process could replace the target between
                        # os.replace and this callback; binding the old staged
                        # pixels to that newer path would make the tab lie.
                        published_reader = ImageReader()
                        published_reader.load_file(target)
                        if (staged_reader.data is None
                                or published_reader.data is None
                                or staged_reader.data.dtype != published_reader.data.dtype
                                or staged_reader.data.shape != published_reader.data.shape
                                or not np.array_equal(
                                    staged_reader.data, published_reader.data,
                                )):
                            raise ValueError(
                                "公開した OME-TIFF の画素が検証済み投影と一致しません。"
                            )

                        ome_before = snapshot_source(target)
                        with tifffile.TiffFile(target) as published_tif:
                            published_ome = published_tif.ome_metadata
                        ome_after = snapshot_source(target)
                        if (ome_before != ome_after
                                or published_reader.metadata.source_identity
                                != ome_after.identity
                                or published_reader.metadata.source_revision
                                != ome_after.revision
                                or not published_ome):
                            raise ValueError(
                                "公開した OME-TIFF が最終検証中に変更されました。"
                            )
                        _assert_projection_ome(published_ome, expected_ome)
                        staged_readers[index] = published_reader

                _publish_staged_files(
                    staged_paths, targets, req.overwrite, commit_expected,
                    pre_publish=validate_projection_sources,
                    post_publish=bind_published_projection_sources,
                )
            except _TargetParentChangedDuringPublish as e:
                return _changed_parent_response(e.paths)
            except _TargetChangedDuringPublish as e:
                return _conflict_response(
                    e.paths, os.path.dirname(e.paths[0]), revision_paths=targets,
                )
        finally:
            _release_process_target_locks(process_locks)
            for lock in reversed(locks):
                lock.release()

        # Registration may evict an older reader. Do that under the shared gate
        # too, but after all publication locks are gone.
        with _memory_heavy_reservation(advances_epoch=False):
            for ((source_image_id, _reader, _meta, _planned, _crop), out_path,
                 new_reader) in zip(pending, targets, staged_readers):
                new_id = add_image(new_reader)

                results.append({
                    "id": new_id,
                    "source_image_id": source_image_id,
                    "path": out_path,
                    "filename": os.path.basename(out_path),
                    "metadata": new_reader.metadata.to_dict(),
                })

        return {"results": results}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    finally:
        for staged in staged_paths:
            if os.path.exists(staged):
                try:
                    os.unlink(staged)
                except OSError:
                    pass


def _selftest_export_targets() -> int:
    """Prove export refusals happen before pixels are read or files are changed."""
    global images, active_id, _lru, APP_DIR, SESSION_FILE
    import tempfile

    class _NoPixelReader:
        def __init__(self, meta: ImageMetadata):
            self.metadata = meta
            self.calls = 0

        def get_projection(self, *_args, **_kwargs):
            self.calls += 1
            raise AssertionError("projection pixels were read before target validation")

    class _DeferredMetadataReader:
        def __init__(self, cached: ImageMetadata, actual: ImageMetadata):
            self.metadata = cached
            self.actual = actual
            self.loaded = False

        def ensure_loaded(self):
            self.metadata = self.actual
            self.loaded = True

    class _CountingReader(ImageReader):
        def __init__(self, meta: ImageMetadata):
            super().__init__()
            self.metadata = meta
            self.data = np.array([[[[[0, 1], [2, 3]]]]], dtype=np.uint16)
            self._metadata_authoritative = True
            self.slice_calls = 0

        def get_slice(self, c: int, z: int, t: int) -> np.ndarray:
            self.slice_calls += 1
            return super().get_slice(c, z, t)

    saved_images, saved_active, saved_lru = images, active_id, _lru
    saved_app_dir, saved_session_file = APP_DIR, SESSION_FILE
    try:
        with tempfile.TemporaryDirectory() as tmp:
            APP_DIR = os.path.join(tmp, "app")
            os.makedirs(APP_DIR)
            SESSION_FILE = os.path.join(APP_DIR, "session.json")
            crop_tuple = _resolve_crop_rect(CropRectRequest(x=1, y=1, width=2, height=2), 4, 5)
            crop_probe = np.arange(20, dtype=np.uint16).reshape(5, 4)
            crop_result = _crop_plane(crop_probe, crop_tuple)
            if crop_tuple != (1, 1, 2, 2) or not np.array_equal(
                crop_result, np.array([[5, 6], [9, 10]], dtype=np.uint16),
            ):
                raise AssertionError("source crop did not preserve the requested plane")
            try:
                _resolve_crop_rect(CropRectRequest(x=3, y=0, width=2, height=1), 4, 5)
            except ValueError:
                pass
            else:
                raise AssertionError("out-of-bounds crop was accepted")
            plate_source = Path(tmp, "plate-source.oir")
            plate_source.write_bytes(b"plate source")
            plate_source_state = snapshot_source(plate_source)

            def test_plate_frame(well_id: str, row: int, col: int,
                                 png_b64: str) -> PlateFrame:
                return PlateFrame(
                    well_id=well_id, row=row, col=col, png_b64=png_b64,
                    source_path=str(plate_source),
                    source_identity=plate_source_state.identity,
                    source_revision=plate_source_state.revision,
                )

            plate_target = Path(tmp, "same.pdf")
            sentinel = b"do not replace"
            plate_target.write_bytes(sentinel)

            # Save endpoints must not recreate a detached external-drive path.
            absent_2d = os.path.join(tmp, "missing-drive", "2d")
            missing_2d = save_images(SaveRequest(
                output_dir=absent_2d, image_ids=["not-open"],
            ))
            if (not isinstance(missing_2d, JSONResponse)
                    or missing_2d.status_code != 400 or os.path.exists(absent_2d)):
                raise AssertionError("2D save recreated a missing output directory")
            absent_3d = os.path.join(tmp, "missing-drive", "3d")
            missing_3d = save_render(SaveRenderRequest(
                output_dir=absent_3d, basename="missing", format="png",
                images=[RenderImage(name="merge", width=1, height=1, data_b64="bad")],
            ))
            if (not isinstance(missing_3d, JSONResponse)
                    or missing_3d.status_code != 400 or os.path.exists(absent_3d)):
                raise AssertionError("3D save recreated a missing output directory")

            # A format may need one final source-token/readback check under its
            # public filename. If that check fails, even a single confirmed
            # overwrite must restore the old bytes before surfacing the error.
            post_target = Path(tmp, "post-publish.bin")
            post_stage = Path(tmp, ".post-publish-stage.bin")
            post_target.write_bytes(b"old public bytes")
            post_stage.write_bytes(b"new staged bytes")
            post_expected = {
                os.path.abspath(post_target): _target_state(post_target),
            }

            def fail_post_publication_validation() -> None:
                raise RuntimeError("injected post-publication validation failure")

            try:
                _publish_staged_files(
                    [str(post_stage)], [str(post_target)], True, post_expected,
                    post_publish=fail_post_publication_validation,
                )
            except RuntimeError as exc:
                if "post-publication" not in str(exc):
                    raise
            else:
                raise AssertionError("post-publication failure was accepted")
            if (post_target.read_bytes() != b"old public bytes"
                    or post_stage.exists()
                    or list(Path(tmp).glob(".oirrollback-*"))):
                raise AssertionError("post-publication failure did not roll back")

            duplicate_render = save_render(SaveRenderRequest(
                output_dir=tmp, basename="duplicate", format="png",
                images=[
                    RenderImage(name="merge", width=1, height=1, data_b64="bad"),
                    RenderImage(name="merge", width=1, height=1, data_b64="bad"),
                ],
            ))
            if (not isinstance(duplicate_render, JSONResponse)
                    or duplicate_render.status_code != 400
                    or Path(tmp, "duplicate_3D_merge.png").exists()):
                raise AssertionError("duplicate 3D targets reached pixel decoding or publication")

            def source_meta(path: Path, *, channel: str = "signal") -> ImageMetadata:
                state = snapshot_source(path)
                return ImageMetadata(
                    filename=path.name, source_path=str(path),
                    source_identity=state.identity, source_revision=state.revision,
                    num_channels=1, num_z=1, num_t=1, width=2, height=2,
                    channel_names=[channel],
                )

            def sha256_file(path: Path) -> str:
                return hashlib.sha256(path.read_bytes()).hexdigest()

            @contextmanager
            def count_export_io(counter: dict[str, int]):
                original_save_image = globals()["_save_image_file"]
                original_decode = base64.b64decode

                def tracked_save_image(*args, **kwargs):
                    counter["write"] += 1
                    return original_save_image(*args, **kwargs)

                def tracked_decode(*args, **kwargs):
                    counter["decode"] += 1
                    return original_decode(*args, **kwargs)

                globals()["_save_image_file"] = tracked_save_image
                base64.b64decode = tracked_decode
                try:
                    yield
                finally:
                    globals()["_save_image_file"] = original_save_image
                    base64.b64decode = original_decode

            # A non-empty image_ids list is the user's exact selection. If one
            # id was closed before the worker bound its reader, do not substitute
            # the active tab or save the surviving prefix of a batch.
            stale_active_source = Path(tmp, "stale-active.oir")
            stale_active_source.write_bytes(b"active image must not be substituted")
            stale_active_reader = _CountingReader(source_meta(stale_active_source))
            images, active_id, _lru = {
                "active": stale_active_reader,
            }, "active", []
            for requested_ids in (["closed"], ["active", "closed"]):
                stale_io = {"decode": 0, "write": 0}
                with count_export_io(stale_io):
                    stale_refused = save_images(SaveRequest(
                        output_dir=tmp, image_ids=requested_ids, basename="wrong-image",
                        channels=[0], channel_colors=[[255, 255, 255]],
                        channel_mins=[0], channel_maxs=[3], save_separate=False,
                        save_merge=True, z_mode="current", format="png",
                    ))
                stale_error = (
                    json.loads(stale_refused.body).get("error", "")
                    if isinstance(stale_refused, JSONResponse) else ""
                )
                if (not isinstance(stale_refused, JSONResponse)
                        or stale_refused.status_code != 400
                        or "開かれていません" not in stale_error
                        or stale_active_reader.slice_calls or any(stale_io.values())
                        or Path(tmp, "wrong-image_merge.png").exists()
                        or Path(tmp, "stale-active").exists()
                        or list(Path(tmp).glob(".oirimg-*"))):
                    raise AssertionError(
                        "stale explicit image ids fell back or saved a partial batch"
                    )

            # A derived image must never replace the source bytes behind any
            # open tab, even after an explicit overwrite confirmation. Check the
            # selected source itself before a slice is decoded.
            self_source = Path(tmp, "self_merge.tif")
            self_source.write_bytes(b"selected source must survive")
            self_reader = _CountingReader(source_meta(self_source))
            images, active_id, _lru = {"self": self_reader}, "self", []
            self_hash = sha256_file(self_source)
            self_mtime = self_source.stat().st_mtime_ns
            self_io = {"decode": 0, "write": 0}
            with count_export_io(self_io):
                self_refused = save_images(SaveRequest(
                    output_dir=tmp, image_ids=["self"], basename="self",
                    channels=[0], channel_colors=[[255, 255, 255]],
                    channel_mins=[0], channel_maxs=[3], save_separate=False,
                    save_merge=True, z_mode="current", format="tiff", overwrite=True,
                    expected_revisions={
                        os.path.abspath(self_source): _target_state(self_source),
                    },
                ))
            self_error = (
                json.loads(self_refused.body).get("error", "")
                if isinstance(self_refused, JSONResponse) else ""
            )
            if (not isinstance(self_refused, JSONResponse)
                    or self_refused.status_code != 400 or "元画像" not in self_error
                    or self_reader.slice_calls or any(self_io.values())
                    or sha256_file(self_source) != self_hash
                    or self_source.stat().st_mtime_ns != self_mtime
                    or list(Path(tmp).glob(".oirimg-*"))):
                raise AssertionError("2D save replaced or decoded its selected source")

            # Also catch a different open tab reached through a hardlink. Path
            # spelling alone is insufficient: both names address one inode.
            selected_source = Path(tmp, "selected-input.oir")
            selected_source.write_bytes(b"selected input")
            other_source = Path(tmp, "unselected-source.tif")
            other_source.write_bytes(b"unselected source must survive")
            hardlink_target = Path(tmp, "alias_merge.tif")
            os.link(other_source, hardlink_target)
            selected_reader = _CountingReader(source_meta(selected_source))
            other_reader = _CountingReader(source_meta(other_source))
            images, active_id, _lru = {
                "selected": selected_reader, "other": other_reader,
            }, "selected", []
            other_hash = sha256_file(other_source)
            other_mtime = other_source.stat().st_mtime_ns
            hardlink_io = {"decode": 0, "write": 0}
            with count_export_io(hardlink_io):
                hardlink_refused = save_images(SaveRequest(
                    output_dir=tmp, image_ids=["selected"], basename="alias",
                    channels=[0], channel_colors=[[255, 255, 255]],
                    channel_mins=[0], channel_maxs=[3], save_separate=False,
                    save_merge=True, z_mode="current", format="tiff", overwrite=True,
                    expected_revisions={
                        os.path.abspath(hardlink_target): _target_state(hardlink_target),
                    },
                ))
            hardlink_error = (
                json.loads(hardlink_refused.body).get("error", "")
                if isinstance(hardlink_refused, JSONResponse) else ""
            )
            if (not isinstance(hardlink_refused, JSONResponse)
                    or hardlink_refused.status_code != 400
                    or "元画像" not in hardlink_error or selected_reader.slice_calls
                    or any(hardlink_io.values())
                    or sha256_file(other_source) != other_hash
                    or sha256_file(hardlink_target) != other_hash
                    or other_source.stat().st_mtime_ns != other_mtime
                    or hardlink_target.stat().st_mtime_ns != other_mtime
                    or list(Path(tmp).glob(".oirimg-*"))):
                raise AssertionError("2D save replaced an unselected hardlinked source")

            # Save-render receives pixels rather than an image id, but its target
            # still must not replace either the active source or another open
            # source. Invalid base64 proves the refusal happened before decoding.
            render_source = Path(tmp, "render_3D_merge.png")
            render_source.write_bytes(b"3D source must survive")
            images, active_id, _lru = {
                "render": _CountingReader(source_meta(render_source)),
            }, "render", []
            render_hash = sha256_file(render_source)
            render_mtime = render_source.stat().st_mtime_ns
            render_io = {"decode": 0, "write": 0}
            with count_export_io(render_io):
                render_refused = save_render(SaveRenderRequest(
                    output_dir=tmp, basename="render", format="png", overwrite=True,
                    expected_revisions={
                        os.path.abspath(render_source): _target_state(render_source),
                    },
                    images=[RenderImage(
                        name="merge", width=1, height=1, data_b64="not-base64",
                    )],
                ))
            render_error = (
                json.loads(render_refused.body).get("error", "")
                if isinstance(render_refused, JSONResponse) else ""
            )
            if (not isinstance(render_refused, JSONResponse)
                    or render_refused.status_code != 400 or "元画像" not in render_error
                    or any(render_io.values())
                    or sha256_file(render_source) != render_hash
                    or render_source.stat().st_mtime_ns != render_mtime
                    or list(Path(tmp).glob(".oirimg-*"))):
                raise AssertionError("3D save-render decoded or replaced its source")

            render_other = Path(tmp, "render-unselected-source.png")
            render_other.write_bytes(b"3D unselected source must survive")
            render_alias = Path(tmp, "alias3d_3D_merge.png")
            os.link(render_other, render_alias)
            images, active_id, _lru = {
                "render-other": _CountingReader(source_meta(render_other)),
            }, "render-other", []
            render_other_hash = sha256_file(render_other)
            render_other_mtime = render_other.stat().st_mtime_ns
            render_alias_io = {"decode": 0, "write": 0}
            with count_export_io(render_alias_io):
                render_alias_refused = save_render(SaveRenderRequest(
                    output_dir=tmp, basename="alias3d", format="png", overwrite=True,
                    expected_revisions={
                        os.path.abspath(render_alias): _target_state(render_alias),
                    },
                    images=[RenderImage(
                        name="merge", width=1, height=1, data_b64="not-base64",
                    )],
                ))
            render_alias_error = (
                json.loads(render_alias_refused.body).get("error", "")
                if isinstance(render_alias_refused, JSONResponse) else ""
            )
            if (not isinstance(render_alias_refused, JSONResponse)
                    or render_alias_refused.status_code != 400
                    or "元画像" not in render_alias_error
                    or any(render_alias_io.values())
                    or sha256_file(render_other) != render_other_hash
                    or sha256_file(render_alias) != render_other_hash
                    or render_other.stat().st_mtime_ns != render_other_mtime
                    or render_alias.stat().st_mtime_ns != render_other_mtime
                    or list(Path(tmp).glob(".oirimg-*"))):
                raise AssertionError("3D save-render replaced an unselected hardlinked source")

            # A late decode failure leaves every confirmed existing target and
            # all public names untouched; the first valid frame is only staged.
            rgba = base64.b64encode(bytes([1, 2, 3, 255])).decode("ascii")
            staged_targets = [
                Path(tmp, "stage-failure_3D_merge.png"),
                Path(tmp, "stage-failure_3D_signal.png"),
            ]
            for path in staged_targets:
                path.write_bytes(sentinel)
            staged_revisions = {
                os.path.abspath(path): _target_state(path) for path in staged_targets
            }
            stage_failure = save_render(SaveRenderRequest(
                output_dir=tmp, basename="stage-failure", format="png",
                overwrite=True, expected_revisions=staged_revisions,
                images=[
                    RenderImage(name="merge", width=1, height=1, data_b64=rgba),
                    RenderImage(name="signal", width=1, height=1, data_b64="bad"),
                ],
            ))
            if (not isinstance(stage_failure, JSONResponse)
                    or stage_failure.status_code != 400
                    or any(path.read_bytes() != sentinel for path in staged_targets)
                    or list(Path(tmp).glob(".oirimg-*"))):
                raise AssertionError("3D staging failure changed a public target")

            # If publication fails after the first rename, the common publisher
            # restores that target before returning an error.
            rollback_targets = [
                Path(tmp, "rollback_3D_merge.png"),
                Path(tmp, "rollback_3D_signal.png"),
            ]
            originals = [b"old merge", b"old signal"]
            for path, old in zip(rollback_targets, originals):
                path.write_bytes(old)
            rollback_revisions = {
                os.path.abspath(path): _target_state(path) for path in rollback_targets
            }
            original_replace = os.replace

            def fail_second_publication(src, dst):
                if (os.path.basename(str(src)).startswith(".oirimg-")
                        and _path_key(str(dst)) == _path_key(str(rollback_targets[1]))):
                    raise OSError("injected second-target publish failure")
                return original_replace(src, dst)

            os.replace = fail_second_publication
            try:
                rollback = save_render(SaveRenderRequest(
                    output_dir=tmp, basename="rollback", format="png",
                    overwrite=True, expected_revisions=rollback_revisions,
                    images=[
                        RenderImage(name="merge", width=1, height=1, data_b64=rgba),
                        RenderImage(name="signal", width=1, height=1, data_b64=rgba),
                    ],
                ))
            finally:
                os.replace = original_replace
            if (not isinstance(rollback, JSONResponse)
                    or rollback.status_code != 400
                    or [path.read_bytes() for path in rollback_targets] != originals
                    or list(Path(tmp).glob(".oirrollback-*"))
                    or list(Path(tmp).glob(".oirimg-*"))):
                raise AssertionError("multi-target publish failure did not roll back")

            # An overwrite approval is for the exact target revision observed in
            # the conflict. Replacing it before retry must fail before decoding.
            revision_target = Path(tmp, "revision_3D_merge.png")
            revision_target.write_bytes(b"first")
            revision_conflict = save_render(SaveRenderRequest(
                output_dir=tmp, basename="revision", format="png",
                images=[RenderImage(name="merge", width=1, height=1, data_b64="bad")],
            ))
            revision_body = (
                json.loads(revision_conflict.body)
                if isinstance(revision_conflict, JSONResponse) else {}
            )
            revision_target.write_bytes(b"changed")
            stale_overwrite = save_render(SaveRenderRequest(
                output_dir=tmp, basename="revision", format="png", overwrite=True,
                expected_revisions=revision_body.get("revisions", {}),
                images=[RenderImage(name="merge", width=1, height=1, data_b64="bad")],
            ))
            if (not isinstance(stale_overwrite, JSONResponse)
                    or stale_overwrite.status_code != 409
                    or revision_target.read_bytes() != b"changed"):
                raise AssertionError("changed 3D overwrite target was decoded or replaced")

            plate_req = PlatePdfTargetRequest(
                plate_name="test", output_dir=tmp, filename="same",
            )
            plate_conflict = plate_pdf_check(plate_req)
            if (not isinstance(plate_conflict, JSONResponse)
                    or plate_conflict.status_code != 409):
                raise AssertionError("plate preflight did not report the existing PDF")

            # Invalid base64 proves the final endpoint checks the target before it
            # even decodes a frame. The old order returns 400 here instead of 409.
            early = plate_pdf(PlatePdfRequest(
                plate_name="test", rows=1, cols=1, output_dir=tmp, filename="same",
                frames=[test_plate_frame("A01", 0, 0, "a")],
            ))
            if not isinstance(early, JSONResponse) or early.status_code != 409:
                raise AssertionError("plate final check ran after frame decoding")
            if plate_target.read_bytes() != sentinel:
                raise AssertionError("plate conflict changed the existing PDF")

            available = plate_pdf_check(PlatePdfTargetRequest(
                plate_name="test", output_dir=tmp, filename="late",
            ))
            if not isinstance(available, dict):
                raise AssertionError("available plate target was not resolved")
            late_target = Path(available["path"])
            late_target.write_bytes(sentinel)
            late = plate_pdf(PlatePdfRequest(
                plate_name="test", rows=1, cols=1, output_dir=tmp,
                filename=available["filename"],
                frames=[test_plate_frame("A01", 0, 0, "a")],
            ))
            if not isinstance(late, JSONResponse) or late.status_code != 409:
                raise AssertionError("plate final check missed a post-preflight collision")
            if late_target.read_bytes() != sentinel:
                raise AssertionError("late plate conflict changed the target")

            # An empty name is resolved once, then reused exactly after a long
            # render instead of taking a second timestamp.
            generated = plate_pdf_check(PlatePdfTargetRequest(
                plate_name="plate.2026.08", output_dir=tmp,
            ))
            if not isinstance(generated, dict):
                raise AssertionError("timestamped plate target was not resolved")
            _dir, frozen_target, _stem = _plate_pdf_target(PlatePdfTargetRequest(
                plate_name="plate.2026.08", output_dir=tmp,
                filename=generated["filename"],
            ))
            if str(frozen_target) != generated["path"]:
                raise AssertionError("resolved plate filename changed before final save")

            dotted = plate_pdf_check(PlatePdfTargetRequest(
                plate_name="test", output_dir=tmp, filename="figure.v2.final",
            ))
            if (not isinstance(dotted, dict)
                    or dotted["filename"] != "figure.v2.final"
                    or not dotted["path"].endswith("figure.v2.final.pdf")):
                raise AssertionError("dots in a plate PDF stem changed the checked target")
            _dir, dotted_final, dotted_stem = _plate_pdf_target(PlatePdfTargetRequest(
                plate_name="test", output_dir=tmp, filename=dotted["filename"],
            ))
            if str(dotted_final) != dotted["path"] or dotted_stem != dotted["filename"]:
                raise AssertionError("dotted plate target changed before final save")

            # Approval tokens are bound to an exact filename and overwrite=False
            # never replaces an existing target, even with a matching token.
            other_missing = Path(tmp, "other.pdf")
            missing_token = _target_state(Path(tmp, "unused.pdf"))
            if not _target_write_conflicts(
                [other_missing], False,
                {os.path.abspath(other_missing): missing_token},
            ):
                raise AssertionError("missing-target revision was reusable for another name")
            existing_token = _target_state(plate_target)
            if not _target_write_conflicts(
                [plate_target], False,
                {os.path.abspath(plate_target): existing_token},
            ):
                raise AssertionError("overwrite=False accepted an existing target revision")
            if _target_write_conflicts(
                [plate_target], True,
                {os.path.abspath(plate_target): existing_token},
            ):
                raise AssertionError("confirmed existing target revision was rejected")

            fake_parent = (
                f"target:v3:{_target_path_digest(other_missing)}:999-999:missing"
            )
            if not _targets_with_changed_parent(
                [other_missing], {os.path.abspath(other_missing): fake_parent},
            ):
                raise AssertionError("changed destination filesystem was not detected")

            broken = Path(tmp, "broken.pdf")
            broken.symlink_to(Path(tmp, "does-not-exist"))
            if _target_state_parts(_target_state(broken))[2] != "file":
                raise AssertionError("broken symlink was treated as an available target")

            bad_layout_target = Path(tmp, "bad-layout.pdf")
            bad_layout = plate_pdf(PlatePdfRequest(
                plate_name="test", rows=1, cols=1, output_dir=tmp,
                filename="bad-layout", cell_px=300,
                frames=[test_plate_frame("B02", 1, 1, "not-base64")],
            ))
            if (not isinstance(bad_layout, JSONResponse)
                    or bad_layout.status_code != 400
                    or bad_layout_target.exists()):
                raise AssertionError("out-of-grid plate frame reached PDF composition")

            duplicate_layout = plate_pdf(PlatePdfRequest(
                plate_name="test", rows=1, cols=1, output_dir=tmp,
                filename="duplicate-layout", cell_px=300,
                frames=[
                    test_plate_frame("A01", 0, 0, "not-base64"),
                    test_plate_frame("A01", 0, 0, "not-base64"),
                ],
            ))
            if not isinstance(duplicate_layout, JSONResponse) or duplicate_layout.status_code != 400:
                raise AssertionError("duplicate plate frame reached PNG decoding")

            stale_source_target = Path(tmp, "stale-source.pdf")
            plate_source.write_bytes(b"changed before PDF")
            stale_source = plate_pdf(PlatePdfRequest(
                plate_name="test", rows=1, cols=1, output_dir=tmp,
                filename="stale-source", cell_px=300,
                frames=[test_plate_frame("A01", 0, 0, "not-base64")],
            ))
            if (not isinstance(stale_source, JSONResponse)
                    or stale_source.status_code != 400
                    or "描画後" not in json.loads(stale_source.body).get("error", "")
                    or stale_source_target.exists()):
                raise AssertionError("changed plate source reached PNG decoding or publication")

            # Also change the source at the final publication boundary, after a
            # valid PDF has already been composed. The staged PDF must be thrown
            # away rather than attributing its old pixels to the new source.
            import io
            from PIL import Image
            late_source = Path(tmp, "late-source.oir")
            late_source.write_bytes(b"stable")
            late_state = snapshot_source(late_source)
            png_io = io.BytesIO()
            Image.new("RGB", (2, 2), "black").save(png_io, "PNG")
            late_frame = PlateFrame(
                well_id="A01", row=0, col=0,
                png_b64=base64.b64encode(png_io.getvalue()).decode("ascii"),
                source_path=str(late_source),
                source_identity=late_state.identity,
                source_revision=late_state.revision,
            )
            late_target = Path(tmp, "late-source.pdf")
            original_publish = _publish_staged_files

            def change_source_before_publish(*args, **kwargs):
                late_source.write_bytes(b"changed at publish")
                return original_publish(*args, **kwargs)

            globals()["_publish_staged_files"] = change_source_before_publish
            try:
                late_result = plate_pdf(PlatePdfRequest(
                    plate_name="test", rows=1, cols=1, output_dir=tmp,
                    filename="late-source", cell_px=300, frames=[late_frame],
                ))
            finally:
                globals()["_publish_staged_files"] = original_publish
            if (not isinstance(late_result, JSONResponse)
                    or late_result.status_code != 400
                    or "描画後" not in json.loads(late_result.body).get("error", "")
                    or late_target.exists()):
                raise AssertionError("plate source changed at publish but PDF was accepted")

            source = os.path.join(tmp, "source.oir")
            Path(source).write_bytes(b"source")
            meta = ImageMetadata(
                filename="source.oir", source_path=source, num_channels=1,
                num_z=2, num_t=1, width=2, height=2, channel_names=["merge"],
            )
            reader = _NoPixelReader(meta)
            target = os.path.join(tmp, "chosen.ome.tif")
            Path(target).write_bytes(sentinel)
            images, active_id, _lru = {"one": reader}, "one", []

            duplicate_2d = save_images(SaveRequest(
                output_dir=tmp, image_ids=["one"], basename="duplicate-2d",
                channels=[0], channel_colors=[[255, 255, 255]],
                channel_mins=[0], channel_maxs=[1], save_separate=True,
                save_merge=True, z_mode="current", format="png",
            ))
            if (not isinstance(duplicate_2d, JSONResponse)
                    or duplicate_2d.status_code != 400
                    or reader.calls
                    or Path(tmp, "duplicate-2d_merge.png").exists()):
                raise AssertionError("duplicate 2D targets reached pixels or publication")

            # Simulate an external base disappearing after planning but before
            # the first batch child directory is created. The original mount
            # path must stay absent; os.mkdir cannot recreate its ancestors.
            batch_base = Path(tmp, "batch-drive")
            batch_base.mkdir()
            detached_base = Path(tmp, "batch-drive-detached")
            batch_readers = {
                key: _NoPixelReader(ImageMetadata(
                    filename=f"{key}.oir", source_path=os.path.join(tmp, f"{key}.oir"),
                    num_channels=1, num_z=1, num_t=1, width=2, height=2,
                    channel_names=["signal"],
                ))
                for key in ("batch-a", "batch-b")
            }
            images, active_id, _lru = batch_readers, "batch-a", []
            original_assert_output = _assert_output_dir_identity
            detached = False

            def detach_before_child(out_dir: str, expected: str) -> None:
                nonlocal detached
                if not detached:
                    os.rename(batch_base, detached_base)
                    detached = True
                original_assert_output(out_dir, expected)

            globals()["_assert_output_dir_identity"] = detach_before_child
            try:
                detached_batch = save_images(SaveRequest(
                    output_dir=str(batch_base), image_ids=list(batch_readers),
                    channels=[0], channel_colors=[[255, 255, 255]],
                    channel_mins=[0], channel_maxs=[1], save_separate=False,
                    save_merge=True, z_mode="current", format="png",
                ))
            finally:
                globals()["_assert_output_dir_identity"] = original_assert_output
            if (not isinstance(detached_batch, JSONResponse)
                    or detached_batch.status_code != 400 or batch_base.exists()
                    or any(item.calls for item in batch_readers.values())):
                raise AssertionError("batch save recreated or read after detached base")
            os.rename(detached_base, batch_base)

            source_state = snapshot_source(source)
            numeric_meta = ImageMetadata(
                filename="numeric.oir", source_path=source,
                source_identity=source_state.identity,
                source_revision=source_state.revision,
                num_channels=1, num_z=1, num_t=1, width=2, height=2,
                channel_names=["signal"],
            )
            numeric_reader = _CountingReader(numeric_meta)
            images, active_id, _lru = {"numeric": numeric_reader}, "numeric", []
            numeric_target = Path(tmp, "numeric_merge.png")
            numeric_target.write_bytes(b"old numeric")
            numeric_conflict = save_images(SaveRequest(
                output_dir=tmp, image_ids=["numeric"], basename="numeric",
                channels=[0], channel_colors=[[255, 255, 255]],
                channel_mins=[0], channel_maxs=[3], save_separate=False,
                save_merge=True, z_mode="current", format="png",
            ))
            numeric_body = (
                json.loads(numeric_conflict.body)
                if isinstance(numeric_conflict, JSONResponse) else {}
            )
            numeric_target.write_bytes(b"changed numeric")
            numeric_reader.slice_calls = 0
            stale_2d = save_images(SaveRequest(
                output_dir=tmp, image_ids=["numeric"], basename="numeric",
                channels=[0], channel_colors=[[255, 255, 255]],
                channel_mins=[0], channel_maxs=[3], save_separate=False,
                save_merge=True, z_mode="current", format="png", overwrite=True,
                expected_revisions=numeric_body.get("revisions", {}),
            ))
            if (not isinstance(stale_2d, JSONResponse)
                    or stale_2d.status_code != 409 or numeric_reader.slice_calls
                    or numeric_target.read_bytes() != b"changed numeric"):
                raise AssertionError("changed 2D overwrite target reached pixels or publication")

            # Exercise the successful staged/reopened 2D path as a numeric test.
            numeric_target.unlink()
            numeric_reader.slice_calls = 0
            numeric_saved = save_images(SaveRequest(
                output_dir=tmp, image_ids=["numeric"], basename="numeric",
                channels=[0], channel_colors=[[255, 255, 255]],
                channel_mins=[0], channel_maxs=[3], save_separate=False,
                save_merge=True, z_mode="current", format="png",
            ))
            from PIL import Image as PILImage
            with PILImage.open(numeric_target) as saved_image:
                numeric_pixels = np.asarray(saved_image.convert("RGB"))
            if (not isinstance(numeric_saved, dict) or numeric_reader.slice_calls != 1
                    or numeric_pixels.shape != (2, 2, 3)
                    or not np.array_equal(
                        numeric_pixels[..., 0],
                        np.array([[0, 85], [170, 255]], dtype=np.uint8),
                    )):
                raise AssertionError("2D staged save did not preserve verified pixels")

            # End-to-end crop regression: a non-symmetric source pattern must
            # survive Save's crop, staging, reopen, and publication with the
            # requested source-pixel orientation and dimensions intact.
            import tifffile
            crop_source = Path(tmp, "crop-pattern.oir")
            crop_source.write_bytes(b"crop source")
            crop_state = snapshot_source(crop_source)
            crop_meta = ImageMetadata(
                filename=crop_source.name, source_path=str(crop_source),
                source_identity=crop_state.identity, source_revision=crop_state.revision,
                num_channels=1, num_z=1, num_t=1, width=4, height=3,
                channel_names=["signal"],
            )
            crop_reader = _CountingReader(crop_meta)
            crop_reader.data = np.array(
                [[[[[10, 20, 30, 40],
                    [50, 60, 70, 80],
                    [90, 100, 110, 120]]]]],
                dtype=np.uint16,
            )
            images, active_id, _lru = {"crop": crop_reader}, "crop", []
            crop_target = Path(tmp, "crop-2d_merge.tif")
            crop_saved = save_images(SaveRequest(
                output_dir=tmp, image_ids=["crop"], basename="crop-2d",
                channels=[0], channel_colors=[[255, 255, 255]],
                channel_mins=[0], channel_maxs=[120], save_separate=False,
                save_merge=True, z_mode="current", format="tiff",
                bit_depth_output="16",
                crop=CropRectRequest(x=1, y=1, width=2, height=2),
            ))
            crop_expected = _render_merge(
                [np.array([[60, 70], [100, 110]], dtype=np.uint16)],
                [[255, 255, 255]], [0], [120], True,
            )
            with tifffile.TiffFile(crop_target) as tif:
                crop_pixels = np.asarray(tif.asarray())
            if (not isinstance(crop_saved, dict)
                    or crop_reader.slice_calls != 1
                    or crop_pixels.shape != (2, 2, 3)
                    or not np.array_equal(crop_pixels, crop_expected)):
                raise AssertionError(
                    f"2D crop publication mismatch: shape={crop_pixels.shape}, "
                    f"pixels={crop_pixels.tolist()}"
                )

            # The projection path must apply the same source crop before OME
            # publication. Use a second Z plane so max projection cannot pass
            # merely by copying the current plane.
            projection_meta = ImageMetadata(
                filename=crop_source.name, source_path=str(crop_source),
                source_identity=crop_state.identity, source_revision=crop_state.revision,
                num_channels=1, num_z=2, num_t=1, width=4, height=3,
                channel_names=["signal"],
            )
            projection_reader = _CountingReader(projection_meta)
            projection_reader.data = np.array(
                [[[[[1, 2, 3, 4],
                    [5, 6, 7, 8],
                    [9, 10, 11, 12]],
                   [[13, 14, 15, 16],
                    [17, 60, 70, 20],
                    [21, 100, 110, 24]]]]],
                dtype=np.uint16,
            )
            images, active_id, _lru = {"crop-proj": projection_reader}, "crop-proj", []
            projection_target = Path(tmp, "crop-projection.ome.tif")
            projection_saved = apply_projection(ProjectionRequest(
                image_ids=["crop-proj"], output_dir=tmp,
                filename="crop-projection", method="max", z_from=0, z_to=1, t=0,
                crop=CropRectRequest(x=1, y=1, width=2, height=2),
            ))
            with tifffile.TiffFile(projection_target) as tif:
                projection_pixels = np.asarray(tif.asarray())
            if projection_pixels.ndim == 2:
                projection_pixels = projection_pixels[np.newaxis, ...]
            projection_expected = np.array([[[60, 70], [100, 110]]], dtype=np.uint16)
            if (not isinstance(projection_saved, dict)
                    or projection_pixels.shape != projection_expected.shape
                    or not np.array_equal(projection_pixels, projection_expected)):
                raise AssertionError(
                    f"projection crop publication mismatch: shape={projection_pixels.shape}, "
                    f"pixels={projection_pixels.tolist()}"
                )

            images, active_id, _lru = {"one": reader}, "one", []

            conflict = apply_projection(ProjectionRequest(
                image_ids=["one"], output_dir=tmp, filename="chosen",
            ))
            if not isinstance(conflict, JSONResponse) or conflict.status_code != 409:
                raise AssertionError(f"existing projection target returned {conflict!r}")
            if reader.calls or Path(target).read_bytes() != sentinel:
                raise AssertionError("projection conflict read pixels or changed the target")
            if Path(tmp, "chosen_01.ome.tif").exists():
                raise AssertionError("projection silently created a suffixed file")

            dotted_target = Path(tmp, "chosen.v2.final.ome.tif")
            dotted_target.write_bytes(sentinel)
            dotted = apply_projection(ProjectionRequest(
                image_ids=["one"], output_dir=tmp, filename="chosen.v2.final",
            ))
            if not isinstance(dotted, JSONResponse) or dotted.status_code != 409:
                raise AssertionError("dotted projection target was not checked exactly")
            if reader.calls or dotted_target.read_bytes() != sentinel:
                raise AssertionError("dotted projection conflict read pixels or changed target")
            if Path(tmp, "chosen.v2.ome.tif").exists():
                raise AssertionError("dotted projection stem was silently truncated")

            cached_meta = ImageMetadata(
                filename="restored.oir", source_path=os.path.join(tmp, "restored.oir"),
                num_channels=1, num_z=2, num_t=1, width=2, height=2,
            )
            actual_meta = ImageMetadata(
                filename="restored.oir", source_path=cached_meta.source_path,
                num_channels=2, num_z=5, num_t=3, width=8, height=6,
                pixel_size_x=0.123456, pixel_size_y=0.234567,
                channel_names=["DAPI", "proSPC"],
            )
            deferred = _DeferredMetadataReader(cached_meta, actual_meta)
            deferred_req = ProjectionRequest(
                image_ids=["restored"], output_dir=tmp, filename="restored_projection",
                z_from=1, z_to=4, t=2,
            )
            deferred_target = _projection_target(deferred_req, cached_meta, False)
            runtime_meta, runtime_from, runtime_to, runtime_t = _projection_runtime_plan(
                deferred, deferred_req, deferred_target, False,
            )
            runtime_xml = _build_ome_xml(
                runtime_meta, runtime_meta.num_channels, runtime_meta.height,
                runtime_meta.width, deferred_req.method, runtime_from, runtime_to,
                runtime_t,
            )
            _assert_projection_ome(runtime_xml, runtime_xml)
            if (not deferred.loaded or runtime_meta is not actual_meta
                    or (runtime_from, runtime_to, runtime_t) != (1, 4, 2)
                    or 'PhysicalSizeX="0.123456"' not in runtime_xml
                    or 'PhysicalSizeXUnit="&#181;m"' not in runtime_xml
                    or 'Name="proSPC"' not in runtime_xml
                    or 'T3 Z2-5' not in runtime_xml):
                raise AssertionError("deferred projection used cached metadata in its OME output")
            try:
                _projection_ome_signature(runtime_xml.replace("&#181;m", "um"))
            except ValueError:
                pass
            else:
                raise AssertionError("schema-invalid OME length unit was accepted")

            shallow = _DeferredMetadataReader(cached_meta, ImageMetadata(
                filename="restored.oir", source_path=cached_meta.source_path,
                num_channels=1, num_z=2, num_t=1, width=2, height=2,
            ))
            try:
                _projection_runtime_plan(shallow, deferred_req, deferred_target, False)
            except ValueError as e:
                if "Z 範囲" not in str(e):
                    raise
            else:
                raise AssertionError("projection silently clamped a stale Z range")

            incomplete = _DeferredMetadataReader(cached_meta, ImageMetadata(
                filename="restored.oir", source_path=cached_meta.source_path,
                num_channels=1, num_z=2, num_t=1, width=2, height=2,
                warning="Zスライス 2/5 のみ読み込み",
            ))
            try:
                _projection_runtime_plan(incomplete, ProjectionRequest(
                    image_ids=["restored"], output_dir=tmp,
                    filename="incomplete_projection", z_from=0, z_to=1,
                ), os.path.join(tmp, "incomplete_projection.ome.tif"), False)
            except ValueError as e:
                if "不完全な Z スタック" not in str(e):
                    raise
            else:
                raise AssertionError("incomplete split OIR was accepted for projection")

            source_tif = os.path.join(tmp, "source.ome.tif")
            Path(source_tif).write_bytes(sentinel)
            source_reader = _NoPixelReader(ImageMetadata(
                filename="source.ome.tif", source_path=source_tif,
                num_channels=1, num_z=2, num_t=1, width=2, height=2,
            ))
            images, active_id, _lru = {"source": source_reader}, "source", []
            refused = apply_projection(ProjectionRequest(
                image_ids=["source"], output_dir=tmp, filename="source", overwrite=True,
            ))
            if not isinstance(refused, JSONResponse) or refused.status_code != 400:
                raise AssertionError("source image was accepted as its own projection target")
            if source_reader.calls or Path(source_tif).read_bytes() != sentinel:
                raise AssertionError("source-target refusal read or changed the source")

            first = _NoPixelReader(ImageMetadata(
                filename="same.oir", source_path=os.path.join(tmp, "a", "same.oir"),
                num_channels=1, num_z=2, num_t=1, width=2, height=2,
            ))
            second = _NoPixelReader(ImageMetadata(
                filename="same.oir", source_path=os.path.join(tmp, "b", "same.oir"),
                num_channels=1, num_z=2, num_t=1, width=2, height=2,
            ))
            images, active_id, _lru = {"a": first, "b": second}, "a", []
            duplicate = apply_projection(ProjectionRequest(
                image_ids=["a", "b"], output_dir=tmp,
            ))
            if not isinstance(duplicate, JSONResponse) or duplicate.status_code != 400:
                raise AssertionError("duplicate projection targets were accepted")
            if first.calls or second.calls:
                raise AssertionError("duplicate target validation read projection pixels")

            composed_name = "caf\u00e9.oir"
            decomposed_name = unicodedata.normalize("NFD", composed_name)
            composed_target = os.path.join(tmp, "caf\u00e9.ome.tif")
            decomposed_target = unicodedata.normalize("NFD", composed_target)
            if _path_key(composed_target) != _path_key(decomposed_target):
                raise AssertionError("Unicode aliases produced different target keys")
            if (sys.platform == "darwin"
                    and _target_path_digest(composed_target)
                    != _target_path_digest(decomposed_target)):
                raise AssertionError("Unicode aliases produced different approval tokens")
            unicode_first = _NoPixelReader(ImageMetadata(
                filename=composed_name,
                source_path=os.path.join(tmp, "source-a", composed_name),
                num_channels=1, num_z=2, num_t=1, width=2, height=2,
            ))
            unicode_second = _NoPixelReader(ImageMetadata(
                filename=decomposed_name,
                source_path=os.path.join(tmp, "source-b", decomposed_name),
                num_channels=1, num_z=2, num_t=1, width=2, height=2,
            ))
            images, active_id, _lru = {
                "unicode-a": unicode_first, "unicode-b": unicode_second,
            }, "unicode-a", []
            unicode_duplicate = apply_projection(ProjectionRequest(
                image_ids=["unicode-a", "unicode-b"], output_dir=tmp,
            ))
            if (not isinstance(unicode_duplicate, JSONResponse)
                    or unicode_duplicate.status_code != 400):
                raise AssertionError("Unicode-alias projection targets were accepted")
            if unicode_first.calls or unicode_second.calls:
                raise AssertionError("Unicode target validation read projection pixels")

            absent_dir = os.path.join(tmp, "detached-drive", "output")
            try:
                _projection_target(ProjectionRequest(
                    image_ids=["a"], output_dir=absent_dir,
                ), first.metadata, False)
            except ValueError as e:
                if "保存先が見つかりません" not in str(e):
                    raise
            else:
                raise AssertionError("projection created or accepted a missing output folder")
            if os.path.exists(absent_dir):
                raise AssertionError("projection recreated a detached output path")
    except Exception as e:
        print(f"selftest FAILED: export targets -> {type(e).__name__}: {e}", flush=True)
        return 24
    finally:
        images, active_id, _lru = saved_images, saved_active, saved_lru
        APP_DIR, SESSION_FILE = saved_app_dir, saved_session_file

    print("selftest: export targets OK (open sources immutable; conflicts skip pixels)",
          flush=True)
    return 0


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
    #: Exact target states returned by the conflict response the user approved.
    expected_revisions: dict[str, str] = {}
    #: Optional source-pixel rectangle applied to every selected image.
    crop: CropRectRequest | None = None
    bit_depth_output: str = "16"   # "8" or "16" (16 only for TIFF)


@app.post("/api/save/jobs")
def start_save_job(req: SaveRequest):
    return {"job_id": _start_export_job("image-save", lambda: save_images(req))}


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


def _resolve_crop_rect(crop: CropRectRequest | None, width: int, height: int) -> tuple[int, int, int, int] | None:
    """Validate a source crop before reading any pixels.

    A crop is intentionally rejected rather than silently clamped. A rectangle
    selected for one image must not become a different rectangle for another
    image in a batch, and stale coordinates must fail closed before output work.
    """
    if crop is None:
        return None
    x, y, w, h = int(crop.x), int(crop.y), int(crop.width), int(crop.height)
    if width <= 0 or height <= 0 or x < 0 or y < 0 or w <= 0 or h <= 0:
        raise ValueError("クロップ範囲が不正です。画像内の正の範囲を指定してください。")
    if x + w > width or y + h > height:
        raise ValueError(
            f"クロップ範囲 ({x}, {y}, {w}, {h}) が画像サイズ {width}×{height} を超えています。"
        )
    return x, y, w, h


def _crop_plane(data: np.ndarray, crop: tuple[int, int, int, int] | None) -> np.ndarray:
    """Return a contiguous view of one plane cropped to the requested bounds."""
    if crop is None:
        return data
    x, y, w, h = crop
    if data.ndim != 2 or x + w > data.shape[1] or y + h > data.shape[0]:
        raise ValueError("クロップ範囲と読み込んだ画像平面のサイズが一致しません。")
    return np.ascontiguousarray(data[y:y + h, x:x + w])


#: How many conflicting names to name in the warning before summarising.
_CONFLICT_SHOWN = 12

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


def _conflict_response(
    paths: list[str], out_dir: str, revision_paths: list[str] | None = None,
) -> JSONResponse:
    """Refuse the write and say exactly what would have been replaced.

    Returned before anything is written, so answering "no" costs nothing and
    answering "yes" repeats the request with overwrite set. Earlier versions
    silently renamed a colliding export to `_01`, which loses nothing but is its
    own surprise: you ask for a file, get a differently-named one, and end up
    with a directory of near-duplicates you cannot tell apart.
    """
    shown = [os.path.basename(p) for p in paths[:_CONFLICT_SHOWN]]
    revisions = {
        os.path.abspath(p): _target_state(p)
        for p in (revision_paths or paths)
    }
    return JSONResponse(status_code=409, content={
        "conflict": True,
        "output_dir": out_dir,
        "count": len(paths),
        "files": shown,
        "more": max(0, len(paths) - len(shown)),
        "revisions": revisions,
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


def _assert_saved_image(path: str, expected: np.ndarray, fmt: str) -> None:
    """Reopen a staged export before its public filename can change."""
    if fmt == "tiff":
        import tifffile
        actual = np.asarray(tifffile.imread(path))
    else:
        from PIL import Image as PILImage
        with PILImage.open(path) as image:
            image.load()
            actual = np.asarray(image.convert("RGB"))
    if actual.shape != expected.shape:
        raise ValueError(
            f"保存画像の形状検証に失敗しました: {actual.shape} != {expected.shape}"
        )
    if fmt != "jpeg":
        if actual.dtype != expected.dtype or not np.array_equal(actual, expected):
            raise ValueError("保存画像の数値検証に失敗しました。元の保存先は変更していません。")
    elif actual.dtype != np.uint8 or actual.size == 0:
        raise ValueError("JPEG保存画像を再読込できませんでした。元の保存先は変更していません。")


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
    #: Exact target states returned by the conflict response the user approved.
    expected_revisions: dict[str, str] = {}


@app.post("/api/save-render")
def save_render(req: SaveRenderRequest):
    """Write already-rendered frames (e.g. the 3D view) to the output folder.

    The client sends what it drew, so the file matches the on-screen result
    exactly; the alpha channel is dropped since these are composited on black.
    """
    staged_paths: list[str] = []
    try:
        if req.format not in ("png", "tiff"):
            raise RuntimeError(f"Unsupported format: {req.format}")
        if not req.images:
            raise RuntimeError("No images to save")
        if any(img.width <= 0 or img.height <= 0 for img in req.images):
            raise RuntimeError("保存画像の幅または高さが不正です。")

        out_dir, out_dir_identity = _existing_output_dir(req.output_dir)

        ext = ".tif" if req.format == "tiff" else ".png"
        stem = _safe_name_part(os.path.splitext(req.basename or "render")[0])

        # Every destination is known from the names alone, so the collision
        # check happens before any pixels are decoded or written — a refusal
        # leaves the folder exactly as it was.
        targets = [
            os.path.join(out_dir, f"{stem}_3D_{_safe_name_part(i.name)}{ext}")
            for i in req.images
        ]
        target_keys = [_path_key(path) for path in targets]
        if len(set(target_keys)) != len(target_keys):
            raise RuntimeError(
                "MERGEとチャンネル名が同じ保存先になります。"
                "重複しないチャンネル名に変更してください。"
            )
        _assert_targets_not_open_sources(targets)
        expected = dict(req.expected_revisions)
        changed_parent = _targets_with_changed_parent(targets, expected)
        if changed_parent:
            return _changed_parent_response(changed_parent)
        missing = _confirmed_targets_missing(targets, expected)
        if req.overwrite and missing:
            return _missing_target_response(missing)
        clash = _target_write_conflicts(targets, req.overwrite, expected)
        if clash:
            return _conflict_response(clash, out_dir, revision_paths=targets)
        for target in targets:
            expected.setdefault(os.path.abspath(target), _target_state(target))

        # Encode into same-directory temporary files and reopen every one before
        # any public filename changes. A bad frame or a full/detached drive thus
        # cannot leave a partially updated multi-channel export.
        for img, target in zip(req.images, targets):
            _assert_output_dir_identity(out_dir, out_dir_identity)
            raw = base64.b64decode(img.data_b64, validate=True)
            expected_bytes = img.width * img.height * 4
            if len(raw) != expected_bytes:
                raise RuntimeError(
                    f"{img.name}: expected {expected_bytes} bytes of RGBA, got {len(raw)}"
                )
            rgba = np.frombuffer(raw, dtype=np.uint8).reshape(img.height, img.width, 4)
            rgb = np.ascontiguousarray(rgba[..., :3])
            with tempfile.NamedTemporaryFile(
                dir=out_dir, prefix=".oirimg-", suffix=ext, delete=False,
            ) as handle:
                staged = handle.name
            staged_paths.append(staged)
            _save_image_file(rgb, req.format, staged)
            _fsync_file(staged)
            _assert_saved_image(staged, rgb, req.format)

        locks = _locks_for_targets(targets)
        for lock in locks:
            lock.acquire()
        process_locks: list[object] = []
        try:
            process_locks = _acquire_process_target_locks(targets)
            _assert_output_dir_identity(out_dir, out_dir_identity)
            _assert_targets_not_open_sources(targets)
            changed_parent = _targets_with_changed_parent(targets, expected)
            if changed_parent:
                return _changed_parent_response(changed_parent)
            missing = _confirmed_targets_missing(targets, expected)
            if req.overwrite and missing:
                return _missing_target_response(missing)
            clash = _target_write_conflicts(targets, req.overwrite, expected)
            if clash:
                return _conflict_response(clash, out_dir, revision_paths=targets)
            try:
                _publish_staged_files(
                    staged_paths, targets, req.overwrite, expected,
                    pre_publish=lambda: (
                        _assert_output_dir_identity(out_dir, out_dir_identity),
                        _assert_targets_not_open_sources(targets),
                    ),
                )
            except _TargetParentChangedDuringPublish as exc:
                return _changed_parent_response(exc.paths)
            except _TargetChangedDuringPublish as exc:
                return _conflict_response(exc.paths, out_dir, revision_paths=targets)
            staged_paths.clear()
        finally:
            _release_process_target_locks(process_locks)
            for lock in reversed(locks):
                lock.release()

        return {"saved": targets, "output_dir": out_dir}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    finally:
        for staged in staged_paths:
            if os.path.lexists(staged):
                try:
                    os.unlink(staged)
                except OSError:
                    pass


@app.post("/api/save")
def save_images(req: SaveRequest):
    """Stage, verify and atomically publish a 2D image export batch."""
    staged_paths: list[str] = []
    try:
        ext = {"tiff": ".tif", "png": ".png", "jpeg": ".jpg"}[req.format]
        as_16 = req.format == "tiff" and req.bit_depth_output == "16"

        # The selected base must already exist. In particular, never recreate a
        # vanished external-drive mount path on the internal system disk.
        out_dir, out_dir_identity = _existing_output_dir(req.output_dir)

        # An explicit selection is an all-or-nothing identity contract. Falling
        # back to the active tab when those ids were closed can silently save a
        # different image under the requested name. The active fallback exists
        # only for legacy callers that send no ids at all.
        with _state_lock:
            if req.image_ids:
                missing_ids = [
                    image_id for image_id in req.image_ids if image_id not in images
                ]
                if missing_ids:
                    shown = ", ".join(missing_ids[:3])
                    raise ValueError(
                        f"選択した画像が開かれていません: {shown}。"
                        "保存画面を開き直して、画像を選択し直してください。"
                    )
                image_entries = [
                    (image_id, images[image_id]) for image_id in req.image_ids
                ]
            elif active_id and active_id in images:
                image_entries = [(active_id, images[active_id])]
            else:
                raise RuntimeError("No image loaded")
            for image_id, _reader in image_entries:
                _touch(image_id)
        image_ids = [image_id for image_id, _reader in image_entries]

        skipped: list[str] = []
        #: Every destination this request will write, gathered before any of it
        #: happens so the whole export can be refused as one.
        planned: list[str] = []
        #: Per-image state carried from the planning pass to the writing pass.
        pending: list[tuple] = []
        for img_id, r in image_entries:
            # File count and channel names must come from authoritative source
            # metadata. This metadata-only upgrade reads no image plane and
            # keeps both duplicate rejection and progress planning pre-pixel.
            if not getattr(r, "_metadata_authoritative", True):
                _ensure_reader_ready_reserved(r, img_id, metadata_only=True)
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
            crop_rect = _resolve_crop_rect(req.crop, int(meta.width), int(meta.height))

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
                            z_list, t_list, img_z_from, img_z_to, crop_rect))

        if not planned:
            raise ValueError("保存する画像がありません。チャンネルとZ/T範囲を確認してください。")
        planned_keys = [_path_key(path) for path in planned]
        if len(set(planned_keys)) != len(planned_keys):
            raise ValueError(
                "チャンネル名またはMERGE名が同じ保存先になります。"
                "重複しないチャンネル名に変更してから保存してください。"
            )
        _assert_targets_not_open_sources(planned)

        # Batch subfolders are direct children of the selected base. Create
        # them one level at a time only while that exact base directory still
        # exists; recursive makedirs could recreate a detached mount path.
        for img_dir in dict.fromkeys(item[5] for item in pending):
            if _path_key(img_dir) == _path_key(out_dir):
                continue
            _assert_output_dir_identity(out_dir, out_dir_identity)
            try:
                os.mkdir(img_dir)
            except FileExistsError:
                if not os.path.isdir(img_dir):
                    raise ValueError(f"保存先と同名のファイルがあります: {img_dir}")
            _assert_output_dir_identity(out_dir, out_dir_identity)

        expected = dict(req.expected_revisions)
        changed_parent = _targets_with_changed_parent(planned, expected)
        if changed_parent:
            return _changed_parent_response(changed_parent)
        missing = _confirmed_targets_missing(planned, expected)
        if req.overwrite and missing:
            return _missing_target_response(missing)
        clash = _target_write_conflicts(planned, req.overwrite, expected)
        if clash:
            return _conflict_response(clash, out_dir, revision_paths=planned)
        for target in planned:
            expected.setdefault(os.path.abspath(target), _target_state(target))

        def assert_sources_unchanged() -> None:
            for _img_id, _reader, meta, *_rest in pending:
                if not (meta.source_path and meta.source_identity and meta.source_revision):
                    continue
                try:
                    current = snapshot_source(meta.source_path)
                except OSError as exc:
                    raise ValueError(
                        f"{meta.filename}: 保存中に元画像が見つからなくなりました。何も公開していません。"
                    ) from exc
                if (current.identity != meta.source_identity
                        or current.revision != meta.source_revision):
                    raise ValueError(
                        f"{meta.filename}: 保存中に元画像または分割OIRが変更されました。"
                        "何も公開していません。画像を開き直してください。"
                    )

        total_units = len(planned) + 1
        completed_units = 0
        targets: list[str] = []
        _export_progress(
            "rendering", 0, total_units,
            f"画像を保存中（0/{len(planned)}ファイル）…",
        )

        for (img_id, r, meta, settings, basename, img_dir,
             z_list, t_list, img_z_from, img_z_to, crop_rect) in pending:
            # A batch may reach an evicted reader without activating its tab.
            # Keep its decode and every derived frame in one reservation so a
            # concurrent open cannot force another multi-GB source into memory.
            with _reader_ready_reservation(r, img_id):
                def write(img_rgb: np.ndarray, name: str, _dir: str = img_dir) -> None:
                    """Stage and reopen one image; no public target changes here."""
                    nonlocal completed_units
                    target = os.path.join(_dir, name)
                    _assert_output_dir_identity(out_dir, out_dir_identity)
                    with tempfile.NamedTemporaryFile(
                        dir=_dir, prefix=".oirimg-", suffix=ext, delete=False,
                    ) as handle:
                        staged = handle.name
                    # Register before encoding so finally removes a partial file.
                    staged_paths.append(staged)
                    _save_image_file(img_rgb, req.format, staged)
                    _fsync_file(staged)
                    _assert_saved_image(staged, img_rgb, req.format)
                    targets.append(target)
                    completed_units += 1
                    _export_progress(
                        "verifying", completed_units, total_units,
                        f"保存結果を確認済み（{completed_units}/{len(planned)}ファイル）",
                    )

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
                                sl = r.get_projection(
                                    s.channel, t_val, img_z_from, img_z_to,
                                    req.projection_method,
                                )
                            else:
                                sl = r.get_slice(s.channel, z_idx, t_val)
                            sl = _crop_plane(sl, crop_rect)
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
                                raw_name = (meta.channel_names[c]
                                            if c < len(meta.channel_names) else f"Ch{c}")
                                ch_name = _safe_name_part(raw_name)
                                rgb = _render_single(
                                    ch_slices[idx], ch_colors[idx],
                                    ch_mins[idx], ch_maxs[idx], as_16,
                                )
                                write(rgb, f"{basename}_{ch_name}{zt_suffix}{ext}")

                        # Save merged image
                        if req.save_merge and len(ch_slices) > 0:
                            merged = _render_merge(
                                ch_slices, ch_colors, ch_mins, ch_maxs, as_16,
                            )
                            write(merged, f"{basename}_merge{zt_suffix}{ext}")

        if [_path_key(path) for path in targets] != planned_keys:
            raise ValueError("検証済み画像と保存計画の対応が一致しません。何も公開していません。")
        assert_sources_unchanged()
        _assert_output_dir_identity(out_dir, out_dir_identity)

        _export_progress(
            "publishing", completed_units, total_units,
            "検証済み画像をまとめて公開中…",
        )
        locks = _locks_for_targets(targets)
        for lock in locks:
            lock.acquire()
        process_locks: list[object] = []
        try:
            process_locks = _acquire_process_target_locks(targets)
            _assert_targets_not_open_sources(targets)
            changed_parent = _targets_with_changed_parent(targets, expected)
            if changed_parent:
                return _changed_parent_response(changed_parent)
            missing = _confirmed_targets_missing(targets, expected)
            if req.overwrite and missing:
                return _missing_target_response(missing)
            clash = _target_write_conflicts(targets, req.overwrite, expected)
            if clash:
                return _conflict_response(clash, out_dir, revision_paths=targets)
            try:
                _publish_staged_files(
                    staged_paths, targets, req.overwrite, expected,
                    pre_publish=lambda: (
                        _assert_output_dir_identity(out_dir, out_dir_identity),
                        _assert_targets_not_open_sources(targets),
                        assert_sources_unchanged(),
                    ),
                )
            except _TargetParentChangedDuringPublish as e:
                return _changed_parent_response(e.paths)
            except _TargetChangedDuringPublish as e:
                return _conflict_response(e.paths, out_dir, revision_paths=targets)
            staged_paths.clear()
        finally:
            _release_process_target_locks(process_locks)
            for lock in reversed(locks):
                lock.release()

        return {
            "saved": targets,
            "output_dir": out_dir,
            "skipped": skipped,
        }
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    finally:
        for staged in staged_paths:
            if os.path.exists(staged):
                try:
                    os.unlink(staged)
                except OSError:
                    pass


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
        rc_startup = _selftest_fresh_startup()
        raise SystemExit(rc or rc_plate or rc_session or rc_startup)
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
