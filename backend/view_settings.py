"""Durable, source-revision-bound display settings for OIR Viewer."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unicodedata
from contextlib import contextmanager
from pathlib import Path
from typing import Any


STORE_VERSION = 1


class ViewSettingsError(RuntimeError):
    """The settings file could not be read or published safely."""


class ViewSettingsCorruptError(ViewSettingsError):
    """The settings file exists but is not a complete store we can trust."""


def _path_key(path: str) -> str:
    """Canonicalise only aliases the host filesystem treats as equivalent."""
    resolved = os.path.realpath(os.path.abspath(path))
    if sys.platform == "darwin":
        resolved = unicodedata.normalize("NFC", resolved)
    if os.name == "nt":
        resolved = os.path.normcase(resolved)
    return resolved


def _empty_store() -> dict[str, Any]:
    return {"version": STORE_VERSION, "entries": {}}


class ViewSettingsStore:
    """A small atomic JSON store, shared by every loopback HTTP origin."""

    def __init__(self, path: str | os.PathLike[str]):
        self.path = os.fspath(path)
        self._lock = threading.RLock()

    @contextmanager
    def _process_lock(self):
        """Serialize read-modify-replace across packaged and source backends."""
        directory = os.path.dirname(self.path) or "."
        os.makedirs(directory, exist_ok=True)
        lock_path = f"{self.path}.lock"
        lock_file = open(lock_path, "a+b")
        try:
            if os.name == "nt":
                import msvcrt

                # msvcrt locks a byte range, so ensure byte zero exists.
                lock_file.seek(0, os.SEEK_END)
                if lock_file.tell() == 0:
                    lock_file.write(b"\0")
                    lock_file.flush()
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl

                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                if os.name == "nt":
                    lock_file.seek(0)
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        finally:
            lock_file.close()

    def _read_locked(self) -> dict[str, Any]:
        if not os.path.exists(self.path):
            return _empty_store()
        try:
            with open(self.path, encoding="utf-8") as f:
                value = json.load(f)
        except (OSError, UnicodeError, json.JSONDecodeError) as e:
            raise ViewSettingsCorruptError(
                f"View settings are unreadable: {type(e).__name__}: {e}"
            ) from e

        if (not isinstance(value, dict)
                or value.get("version") != STORE_VERSION
                or not isinstance(value.get("entries"), dict)):
            raise ViewSettingsCorruptError("View settings have an unsupported or invalid schema")
        return value

    def _write_locked(self, value: dict[str, Any]) -> None:
        directory = os.path.dirname(self.path) or "."
        os.makedirs(directory, exist_ok=True)
        tmp_path = ""
        try:
            with tempfile.NamedTemporaryFile(
                "w", encoding="utf-8", dir=directory,
                prefix=".view-settings-", suffix=".tmp", delete=False,
            ) as f:
                tmp_path = f.name
                json.dump(value, f, ensure_ascii=False, separators=(",", ":"))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, self.path)
        except Exception as e:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
            raise ViewSettingsError(
                f"View settings could not be published: {type(e).__name__}: {e}"
            ) from e

    def get(
        self,
        source_path: str,
        source_identity: str,
        source_revision: str,
    ) -> tuple[dict[str, Any] | None, str]:
        """Return settings only for the exact logical source and byte revision."""
        with self._lock:
            with self._process_lock():
                value = self._read_locked()
                entry = value["entries"].get(_path_key(source_path))
                if entry is None:
                    return None, "none"
                if not isinstance(entry, dict):
                    raise ViewSettingsCorruptError("View settings contain a malformed entry")
                if (entry.get("source_identity") != source_identity
                        or entry.get("source_revision") != source_revision):
                    return None, "source_changed"
                settings = entry.get("settings")
                if not isinstance(settings, dict):
                    raise ViewSettingsCorruptError("View settings contain a malformed payload")
                # Detach the caller from the in-memory JSON tree.
                return json.loads(json.dumps(settings)), "found"

    def put(
        self,
        source_path: str,
        source_identity: str,
        source_revision: str,
        settings: dict[str, Any],
        *,
        client_session: str = "",
        client_sequence: int = 0,
    ) -> bool:
        """Replace one source unless a newer write from this renderer won first."""
        with self._lock:
            with self._process_lock():
                value = self._read_locked()
                key = _path_key(source_path)
                existing = value["entries"].get(key)
                if (client_session and isinstance(existing, dict)
                        and existing.get("client_session") == client_session
                        and isinstance(existing.get("client_sequence"), int)
                        and existing["client_sequence"] >= client_sequence):
                    # An unload keepalive PUT deliberately bypasses the renderer
                    # Promise queue. Its larger sequence must remain authoritative
                    # if an older local request reaches this process afterward.
                    return existing["client_sequence"] == client_sequence
                value["entries"][key] = {
                    "source_identity": source_identity,
                    "source_revision": source_revision,
                    "settings": json.loads(json.dumps(settings)),
                    **({
                        "client_session": client_session,
                        "client_sequence": client_sequence,
                    } if client_session else {}),
                }
                self._write_locked(value)
                return True

    def delete(self, source_path: str) -> bool:
        """Delete all saved revisions for one canonical source path."""
        with self._lock:
            with self._process_lock():
                value = self._read_locked()
                existed = value["entries"].pop(_path_key(source_path), None) is not None
                if existed:
                    self._write_locked(value)
                return existed


def selftest() -> int:
    """Exercise atomicity, revision refusal, isolation and corruption handling."""
    try:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "view-settings.json")
            store = ViewSettingsStore(path)
            source_a = os.path.join(tmp, "A.oir")
            source_b = os.path.join(tmp, "B.oir")
            settings_a = {
                "channels": [{"color": [0, 255, 0], "min": 10.0,
                              "max": 200.0, "visible": True}],
                "currentZ": 2, "currentT": 0, "showMIP": False,
            }
            settings_b = {
                "channels": [{"color": [255, 0, 0], "min": 1.0,
                              "max": 99.0, "visible": False}],
                "currentZ": 0, "currentT": 1, "showMIP": True,
            }

            store.put(source_a, "id-a", "rev-a", settings_a)
            store.put(source_b, "id-b", "rev-b", settings_b)
            loaded, reason = store.get(source_a, "id-a", "rev-a")
            if loaded != settings_a or reason != "found":
                raise AssertionError("exact settings did not round-trip")
            loaded, reason = store.get(source_a, "id-a", "rev-new")
            if loaded is not None or reason != "source_changed":
                raise AssertionError("a changed source revision received stale settings")

            if not store.delete(source_a):
                raise AssertionError("existing settings were not deleted")
            if store.get(source_a, "id-a", "rev-a") != (None, "none"):
                raise AssertionError("deleted settings came back")
            if store.get(source_b, "id-b", "rev-b")[0] != settings_b:
                raise AssertionError("resetting one source changed another source")

            # A keepalive unload write can arrive before an older in-flight PUT.
            # The renderer sequence, checked under the same process/file lock as
            # the write, makes arrival order irrelevant.
            newer = {**settings_a, "currentZ": 9}
            older = {**settings_a, "currentZ": 8}
            if not store.put(
                source_a, "id-a", "rev-a", newer,
                client_session="renderer-a", client_sequence=12,
            ):
                raise AssertionError("new renderer sequence was not saved")
            if store.put(
                source_a, "id-a", "rev-a", older,
                client_session="renderer-a", client_sequence=11,
            ):
                raise AssertionError("older renderer sequence was accepted")
            if store.get(source_a, "id-a", "rev-a")[0] != newer:
                raise AssertionError("older renderer PUT replaced unload settings")

            # Several request threads must still leave one complete JSON document.
            failures: list[BaseException] = []

            def writer(index: int) -> None:
                try:
                    for n in range(12):
                        payload = {**settings_a, "currentZ": index * 100 + n}
                        store.put(source_a, "id-a", "rev-a", payload)
                except BaseException as e:  # pragma: no cover - reported below
                    failures.append(e)

            threads = [threading.Thread(target=writer, args=(i,)) for i in range(4)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            if failures:
                raise failures[0]
            with open(path, encoding="utf-8") as f:
                final_json = json.load(f)
            if final_json.get("version") != STORE_VERSION:
                raise AssertionError("concurrent writes left an incomplete store")

            # Separate backend processes have separate ViewSettingsStore
            # instances and thread locks. Two instances on concurrent threads
            # exercise that same sidecar OS-lock boundary without spawning the
            # test runner recursively from a frozen executable.
            stores = [ViewSettingsStore(path), ViewSettingsStore(path)]
            cross_failures: list[BaseException] = []

            def cross_writer(index: int) -> None:
                try:
                    stores[index % 2].put(
                        os.path.join(tmp, f"cross-{index}.oir"),
                        f"id-{index}", f"rev-{index}", settings_a,
                    )
                except BaseException as e:  # pragma: no cover - reported below
                    cross_failures.append(e)

            cross_threads = [threading.Thread(target=cross_writer, args=(i,))
                             for i in range(12)]
            for thread in cross_threads:
                thread.start()
            for thread in cross_threads:
                thread.join()
            if cross_failures:
                raise cross_failures[0]
            with open(path, encoding="utf-8") as f:
                cross_json = json.load(f)
            if sum(key.endswith(f"cross-{i}.oir") for key in cross_json["entries"]
                   for i in range(12)) != 12:
                raise AssertionError("independent stores lost a concurrent update")

            before = Path(path).read_bytes()
            Path(path).write_bytes(b"{truncated")
            corrupt = Path(path).read_bytes()
            try:
                store.put(source_a, "id-a", "rev-a", settings_a)
                raise AssertionError("a corrupt store was silently overwritten")
            except ViewSettingsCorruptError:
                pass
            if Path(path).read_bytes() != corrupt or corrupt == before:
                raise AssertionError("corrupt settings were not preserved for diagnosis")
    except Exception as e:
        print(f"selftest FAILED: view settings -> {type(e).__name__}: {e}", flush=True)
        return 1

    print("selftest: view settings OK (revision-bound, atomic, reset isolated)", flush=True)
    return 0
