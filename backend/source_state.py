"""Stable, opaque identity and revision tokens for microscopy source files."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path


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


def _stat_record(path: Path, label: str) -> dict[str, int | str]:
    st = os.stat(path)
    if not stat.S_ISREG(st.st_mode):
        raise OSError(f"Source is not a regular file: {path}")
    return {
        "name": label,
        "dev": int(st.st_dev),
        "ino": int(st.st_ino),
        "mode": int(st.st_mode),
        "nlink": int(st.st_nlink),
        "size": int(st.st_size),
        "mtime_ns": int(st.st_mtime_ns),
        "ctime_ns": int(st.st_ctime_ns),
    }


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
    main_record = _stat_record(main, main.name)
    inode = int(main_record["ino"])
    # The resolved path is part of the identity even when an inode is available.
    # A hardlinked main OIR in another acquisition folder can have a different
    # companion-chunk family, so it is conservatively treated as another source.
    identity_basis: object = {
        "path": canonical, "dev": main_record["dev"], "ino": inode,
    }

    records = [_stat_record(member, member.name) for member in members]
    return SourceState(
        identity=_digest("source-id:v1", identity_basis),
        revision=_digest("source-rev:v1", records),
        size=int(main_record["size"]),
        members=len(records),
    )
