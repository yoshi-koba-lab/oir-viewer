#!/usr/bin/env python3
"""Stage the Java runtime a packaged OIR Viewer needs into backend/runtime/.

A distributed build must open .oir files on a machine with no Java and no
network, so the JRE and the Bio-Formats jars travel with the app instead of
being fetched by cjdk/Maven on first use.

    runtime/jre/          a platform JRE (Zulu 11, via cjdk)
    runtime/jars/*.jar    Bio-Formats + dependencies (via scyjava/Maven)

Both are obtained by simply *using* the normal code path once — cjdk caches the
JRE and Maven caches the jars — and then copying what it resolved. Run this on
each target platform (or in CI) before PyInstaller.

Usage:
    python3 scripts/stage_runtime.py            # stage into backend/runtime
    python3 scripts/stage_runtime.py --clean    # remove it again
"""
from __future__ import annotations

import argparse
import glob
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / "backend" / "runtime"


def find_cached_jre() -> Path | None:
    """The JRE home cjdk downloaded, if any."""
    roots = [
        Path.home() / "Library" / "Caches" / "cjdk",           # macOS
        Path.home() / ".cache" / "cjdk",                        # Linux
        Path(os.environ.get("LOCALAPPDATA", "")) / "cjdk",      # Windows
    ]
    exes = []
    for r in roots:
        if r.is_dir():
            exes += glob.glob(str(r / "**" / "bin" / "java"), recursive=True)
            exes += glob.glob(str(r / "**" / "bin" / "java.exe"), recursive=True)
    if not exes:
        return None
    # .../Home/bin/java -> .../Home
    return Path(sorted(exes)[-1]).parent.parent


def find_cached_jars() -> list[Path]:
    m2 = Path(os.environ.get("M2_REPO", Path.home() / ".m2" / "repository"))
    return sorted(Path(p) for p in glob.glob(str(m2 / "**" / "*.jar"), recursive=True))


def warm_caches() -> None:
    """Run the reader's own Maven/cjdk path once so both caches are populated."""
    print("warming cjdk + Maven caches via scyjava…")
    code = (
        "import scyjava;"
        "scyjava.config.endpoints.append('ome:formats-gpl:8.0.1');"
        "scyjava.start_jvm();"
        "import scyjava as s; s.jimport('loci.formats.ImageReader');"
        "print('caches warm')"
    )
    env = {**os.environ}
    env.pop("OIR_RUNTIME_DIR", None)  # force the download path
    subprocess.run([sys.executable, "-c", code], check=True, env=env)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--clean", action="store_true", help="remove backend/runtime and exit")
    args = ap.parse_args()

    if args.clean:
        shutil.rmtree(RUNTIME, ignore_errors=True)
        print(f"removed {RUNTIME}")
        return 0

    jre = find_cached_jre()
    jars = find_cached_jars()
    if not jre or not jars:
        warm_caches()
        jre = find_cached_jre()
        jars = find_cached_jars()
    if not jre:
        print("ERROR: no cjdk-cached JRE found", file=sys.stderr)
        return 1
    if not jars:
        print("ERROR: no jars found in the Maven repository", file=sys.stderr)
        return 1

    shutil.rmtree(RUNTIME, ignore_errors=True)
    (RUNTIME / "jars").mkdir(parents=True)

    print(f"copying JRE from {jre}")
    shutil.copytree(jre, RUNTIME / "jre", symlinks=True)

    print(f"copying {len(jars)} jars")
    for j in jars:
        shutil.copy2(j, RUNTIME / "jars" / j.name)

    size = sum(f.stat().st_size for f in RUNTIME.rglob("*") if f.is_file())
    print(f"staged {RUNTIME}  ({size / 1024 / 1024:.0f} MB)")
    print("verify with:  OIR_RUNTIME_DIR=backend/runtime python3 -c ...")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
