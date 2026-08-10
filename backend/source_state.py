"""Stable, opaque identity and revision tokens for microscopy source files."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import struct
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path


if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    class _ReadFileUsnData(ctypes.Structure):
        _fields_ = [
            ("MinMajorVersion", wintypes.WORD),
            ("MaxMajorVersion", wintypes.WORD),
        ]

    _KERNEL32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _CREATE_FILE_W = _KERNEL32.CreateFileW
    _CREATE_FILE_W.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    ]
    _CREATE_FILE_W.restype = wintypes.HANDLE
    _DEVICE_IO_CONTROL = _KERNEL32.DeviceIoControl
    _DEVICE_IO_CONTROL.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD,
        wintypes.LPVOID, wintypes.DWORD, wintypes.LPDWORD, wintypes.LPVOID,
    ]
    _DEVICE_IO_CONTROL.restype = wintypes.BOOL
    _CLOSE_HANDLE = _KERNEL32.CloseHandle
    _CLOSE_HANDLE.argtypes = [wintypes.HANDLE]
    _CLOSE_HANDLE.restype = wintypes.BOOL

    # A zero/attributes-only desired access is not governed by the data-sharing
    # flags and therefore does not prove that an already-open writer is absent.
    # Request real read access and share only reads: an existing or later
    # writer/delete handle then makes CreateFileW fail, and the snapshot fails
    # closed instead of accepting pixels while their source is being mutated.
    _GENERIC_READ = 0x80000000
    _GENERIC_WRITE = 0x40000000
    _FILE_SHARE_READ = 0x00000001
    _FILE_SHARE_ALL = 0x00000001 | 0x00000002 | 0x00000004
    _OPEN_EXISTING = 3
    _FSCTL_READ_FILE_USN_DATA = 0x000900EB
    _INVALID_HANDLE_VALUE = wintypes.HANDLE(-1).value

    # Errors that mean "this filesystem has no per-file USN", as opposed to
    # "this read failed". exFAT and FAT have no change journal at all, so the
    # FSCTL is rejected by the driver rather than failing on the file. Anything
    # outside this set is a real I/O problem and still fails closed.
    _USN_UNSUPPORTED_ERRORS = frozenset({
        1,     # ERROR_INVALID_FUNCTION — the usual answer from exFAT/FAT
        50,    # ERROR_NOT_SUPPORTED
        87,    # ERROR_INVALID_PARAMETER — some third-party drivers
        1179,  # ERROR_JOURNAL_NOT_ACTIVE
    })


@dataclass(frozen=True)
class SourceState:
    """Identity of one logical image and the exact bytes it currently names."""

    identity: str
    revision: str
    size: int
    members: int


def _resolved(path: str | Path) -> str:
    """Return a usable path without changing its on-disk spelling."""
    return os.path.realpath(os.path.abspath(os.fspath(path)))


def _identity_path(path: str) -> str:
    """Normalize only aliases that the host filesystem treats as equivalent."""
    if sys.platform == "darwin":
        path = unicodedata.normalize("NFC", path)
    if os.name == "nt":
        path = os.path.normcase(path)
    return path


def _entry_key(name: str) -> str:
    """Compare directory entries using the host's filename equivalence rules."""
    if sys.platform == "darwin":
        name = unicodedata.normalize("NFC", name)
    if os.name == "nt":
        name = name.casefold()
    return name


def _actual_entry(main: Path) -> Path:
    """Recover the directory entry spelling hidden by path aliases."""
    wanted = _entry_key(main.name)
    wanted_folded = unicodedata.normalize("NFC", main.name).casefold()
    main_stat = os.stat(main)
    fallback: Path | None = None
    with os.scandir(main.parent) as entries:
        for entry in entries:
            if entry.name == main.name:
                return Path(entry.path)
            try:
                if not os.path.samestat(entry.stat(follow_symlinks=True), main_stat):
                    continue
            except OSError:
                continue
            if (_entry_key(entry.name) == wanted
                    or (sys.platform == "darwin"
                        and unicodedata.normalize("NFC", entry.name).casefold()
                        == wanted_folded)):
                fallback = Path(entry.path)
    return fallback or main


def _split_members(main: Path) -> list[Path]:
    """The main file plus numbered continuation chunks of a split OIR."""
    main = _actual_entry(main)
    members = [main]
    if main.suffix.lower() != ".oir":
        return members
    stem = _entry_key(main.name[:-4])
    pattern = re.compile(rf"{re.escape(stem)}_\d{{5}}$")
    # Do not pass a microscope filename to glob: `[` and `]` are legal filename
    # characters but glob syntax. `sample[1].oir` otherwise loses every chunk
    # from its revision token.
    with os.scandir(main.parent) as entries:
        members.extend(sorted(
            (Path(entry.path) for entry in entries
             if pattern.fullmatch(_entry_key(entry.name))),
            key=lambda p: _entry_key(p.name),
        ))
    return members


def _parse_windows_usn_record(raw: bytes, path: Path) -> str:
    """Parse one V2/V3 FILE_USN_DATA response without platform dependencies."""
    if len(raw) < 8:
        raise OSError(f"Invalid Windows USN record for source: {path}")
    record_length, major, _minor = struct.unpack_from("<IHH", raw, 0)
    usn_offset = 24 if major == 2 else 40 if major == 3 else -1
    if (usn_offset < 0 or record_length < usn_offset + 8
            or record_length > len(raw) or len(raw) < usn_offset + 8):
        raise OSError(f"Unsupported Windows USN record v{major}: {path}")
    usn = struct.unpack_from("<q", raw, usn_offset)[0]
    if usn <= 0:
        raise OSError(
            "このWindowsファイルには有効なUSN change journal記録がありません。"
            "change journalが有効なローカルNTFS/ReFSへデータをコピーしてください: "
            f"{path}"
        )
    return f"v{major}:{usn}"


def _selftest_windows_usn_parser() -> None:
    """Pin the V2/V3 offsets and fail-closed malformed/journal-off cases."""
    samples = ((2, 24, 123), (3, 40, 456))
    for major, offset, usn in samples:
        raw = bytearray(offset + 8)
        struct.pack_into("<IHH", raw, 0, len(raw), major, 0)
        struct.pack_into("<q", raw, offset, usn)
        if _parse_windows_usn_record(bytes(raw), Path("source.oir")) != f"v{major}:{usn}":
            raise AssertionError(f"Windows USN V{major} offset drifted")

    invalid: list[bytes] = [b"\0" * 7]
    zero = bytearray(32)
    struct.pack_into("<IHH", zero, 0, len(zero), 2, 0)
    struct.pack_into("<q", zero, 24, 0)
    invalid.append(bytes(zero))
    unknown = bytearray(48)
    struct.pack_into("<IHH", unknown, 0, len(unknown), 4, 0)
    invalid.append(bytes(unknown))
    truncated = bytearray(32)
    struct.pack_into("<IHH", truncated, 0, 64, 2, 0)
    struct.pack_into("<q", truncated, 24, 1)
    invalid.append(bytes(truncated))
    for raw in invalid:
        try:
            _parse_windows_usn_record(raw, Path("source.oir"))
        except OSError:
            pass
        else:
            raise AssertionError("invalid Windows USN record was accepted")


def _revision_fields(usn: str | None) -> dict[str, str | bool]:
    """The revision fields that record how this file's change is detected.

    Split out so the selftest exercises the same code the snapshot uses, rather
    than a hand-built copy of it: a test that assembles its own dicts cannot
    notice this rule changing.
    """
    if usn is None:
        # A distinct key rather than an empty "usn": a stat-only revision must
        # never digest to the same token as a USN-backed one, and the record
        # should say which guarantee it carries. Present only on filesystems
        # without a journal, so NTFS revisions recorded by earlier versions
        # still compare equal and are not invalidated.
        return {"usn_unavailable": True}
    return {"usn": usn}


def _selftest_usn_fallback() -> None:
    """Pin the exFAT fallback: it must engage, stay distinct, and not invalidate.

    Runs on every platform, because what is checked is how the revision record
    is built rather than a Win32 call. Three properties have to hold at once,
    and the third is the one easy to break by accident: a filesystem without a
    journal must still produce a token, that token must never equal a USN-backed
    one for the same bytes, and an NTFS record must digest exactly as it did
    before the fallback existed — otherwise upgrading would report every source
    on every NTFS drive as changed.
    """
    stat_part = {
        "name": "Stitch_B02_G001.oir", "dev": 3, "ino": 0, "mode": 33206,
        "nlink": 1, "size": 4096, "mtime_ns": 1_700_000_000_000_000_000,
        "ctime_ns": 1_600_000_000_000_000_000,
    }
    # Both records come from the production helper, so a change to its rule is
    # caught here instead of passing because the test rebuilt the old shape.
    journalled = {**stat_part, **_revision_fields("v2:12345")}
    fallback = {**stat_part, **_revision_fields(None)}

    if _digest("source-rev:v2", [journalled]) == _digest("source-rev:v2", [fallback]):
        raise AssertionError("stat-only revision collided with a USN-backed one")
    # Byte-for-byte the record an NTFS host produced before the fallback existed.
    legacy = dict(stat_part); legacy["usn"] = "v2:12345"
    if _digest("source-rev:v2", [journalled]) != _digest("source-rev:v2", [legacy]):
        raise AssertionError("USN-backed revision token changed shape")
    if "usn" in fallback:
        raise AssertionError("stat-only revision still claims a USN")
    # It also has to say that it is stat-only. Recording nothing would leave the
    # record indistinguishable from a plain POSIX one, so a stored revision could
    # no longer tell anyone which guarantee produced it.
    if not _revision_fields(None):
        raise AssertionError("stat-only revision does not record how it was taken")
    # A stat-only revision must still notice everything stat can see.
    for field, value in (("size", 4097), ("mtime_ns", 1), ("ino", 9), ("nlink", 2)):
        if _digest("source-rev:v2", [fallback]) == _digest(
                "source-rev:v2", [{**fallback, field: value}]):
            raise AssertionError(f"stat-only revision ignored a change in {field}")
    if os.name == "nt" and not _USN_UNSUPPORTED_ERRORS:
        raise AssertionError("no error code maps to a journal-less filesystem")


def _open_windows_source_handle(path: Path):
    """Open a read handle that refuses concurrent write/delete access."""
    if os.name != "nt":
        raise RuntimeError("Windows source handle requested on a non-Windows host")

    handle = _CREATE_FILE_W(
        os.fspath(path), _GENERIC_READ, _FILE_SHARE_READ,
        None, _OPEN_EXISTING, 0, None,
    )
    if handle == _INVALID_HANDLE_VALUE:
        error = ctypes.get_last_error()
        if error in (32, 33):  # sharing/lock violation
            raise OSError(
                13,
                "元画像が撮影・コピー・書込み中です。完了してからもう一度開いてください。",
                os.fspath(path),
                error,
            )
        raise ctypes.WinError(error)
    return handle


def _selftest_windows_writer_exclusion(path: Path) -> None:
    """Prove the runtime handle refuses a real Win32 write-access handle."""
    if os.name != "nt":
        return

    writer = _CREATE_FILE_W(
        os.fspath(path), _GENERIC_WRITE, _FILE_SHARE_ALL,
        None, _OPEN_EXISTING, 0, None,
    )
    if writer == _INVALID_HANDLE_VALUE:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        try:
            _stat_record(path, path.name)
        except OSError as exc:
            if getattr(exc, "winerror", None) != 32:
                raise AssertionError(
                    f"active writer returned unexpected Windows error: {exc}"
                ) from exc
        else:
            raise AssertionError("Windows source snapshot accepted an active writer")
    finally:
        _CLOSE_HANDLE(writer)


def _windows_file_usn(handle, path: Path) -> str | None:
    """The last NTFS/ReFS journal sequence number for one open file.

    Windows exposes creation time as ``st_ctime`` and FAT write time can be as
    coarse as two seconds.  A same-size in-place rewrite can therefore leave
    every portable ``stat`` field unchanged.  The per-file USN is advanced when
    a write handle closes and closes that silent-wrong gap.

    Returns ``None`` when the filesystem has no per-file USN — exFAT and FAT have
    no change journal, so the FSCTL is rejected by the driver.  This used to be a
    hard refusal, which made an exFAT drive unusable for reading source images;
    that matters because exFAT is the only filesystem a drive shared between
    macOS and Windows can practically use, and refusing it blocked the ordinary
    workflow to close a narrow gap.  The caller falls back to a stat-only
    revision and marks it as such, so the weaker token can never be mistaken for
    a USN-backed one.  A genuine read failure still raises.
    """
    if os.name != "nt":
        raise RuntimeError("Windows USN requested on a non-Windows host")

    request = _ReadFileUsnData(2, 3)
    # DeviceIoControl requires a DWORD-aligned output buffer.  A uint64 array
    # is explicitly aligned and comfortably larger than one record.
    output = (ctypes.c_uint64 * 128)()
    returned = wintypes.DWORD()
    if not _DEVICE_IO_CONTROL(
        handle, _FSCTL_READ_FILE_USN_DATA,
        ctypes.byref(request), ctypes.sizeof(request),
        output, ctypes.sizeof(output), ctypes.byref(returned), None,
    ):
        error = ctypes.get_last_error()
        if error in _USN_UNSUPPORTED_ERRORS:
            return None
        raise OSError(
            error,
            "元画像の変更履歴を読み取れませんでした。"
            "ドライブの接続を確認してから、もう一度開いてください。",
            os.fspath(path),
        )

    raw = ctypes.string_at(ctypes.addressof(output), returned.value)
    return _parse_windows_usn_record(raw, path)


def _stat_record(path: Path, label: str) -> dict[str, int | str | bool]:
    if os.name == "nt":
        handle = _open_windows_source_handle(path)
        try:
            st = os.stat(path)
            before_usn = _windows_file_usn(handle, path)
            after = os.stat(path)
            after_usn = _windows_file_usn(handle, path)
        finally:
            _CLOSE_HANDLE(handle)
        before_signature = (
            int(st.st_dev), int(st.st_ino), int(st.st_mode), int(st.st_nlink),
            int(st.st_size), int(st.st_mtime_ns), int(st.st_ctime_ns),
        )
        after_signature = (
            int(after.st_dev), int(after.st_ino), int(after.st_mode),
            int(after.st_nlink), int(after.st_size), int(after.st_mtime_ns),
            int(after.st_ctime_ns),
        )
        if before_signature != after_signature or before_usn != after_usn:
            raise OSError(f"Source changed while its revision was captured: {path}")
    else:
        st = os.stat(path)
        after_usn = ""
    if not stat.S_ISREG(st.st_mode):
        raise OSError(f"Source is not a regular file: {path}")
    record: dict[str, int | str | bool] = {
        "name": label,
        "dev": int(st.st_dev),
        "ino": int(st.st_ino),
        "mode": int(st.st_mode),
        "nlink": int(st.st_nlink),
        "size": int(st.st_size),
        "mtime_ns": int(st.st_mtime_ns),
        "ctime_ns": int(st.st_ctime_ns),
    }
    if os.name == "nt":
        record.update(_revision_fields(after_usn))
    return record


def _digest(prefix: str, value: object) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return f"{prefix}:{hashlib.sha256(raw).hexdigest()}"


def snapshot_source(path: str | Path) -> SourceState:
    """Snapshot a source and every split-OIR member without exposing its path.

    Identity answers whether two manifests refer to the same main file. Revision
    additionally freezes every continuation chunk, so a copied or replaced chunk
    cannot be combined with view settings recorded for an earlier stack.
    """
    resolved = _resolved(path)
    members = _split_members(Path(resolved))
    main = members[0]
    canonical = _identity_path(_resolved(main))
    # Capture the main file only once.  Using a first record for identity and a
    # later record for revision could combine two different files if the path
    # were replaced between those calls.
    records = [_stat_record(member, member.name) for member in members]
    main_record = records[0]
    inode = int(main_record["ino"])
    # The resolved path is part of the identity even when an inode is available.
    # A hardlinked main OIR in another acquisition folder can have a different
    # companion-chunk family, so it is conservatively treated as another source.
    identity_basis: object = {
        "path": canonical, "dev": main_record["dev"], "ino": inode,
    }

    return SourceState(
        identity=_digest("source-id:v1", identity_basis),
        revision=_digest("source-rev:v2", records),
        size=int(main_record["size"]),
        members=len(records),
    )
