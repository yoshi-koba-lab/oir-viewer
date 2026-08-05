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


# The runtime the app is developed against. A JRE (not a full JDK) is enough:
# Bio-Formats only needs to run, and it halves the bundle.
JRE_VENDOR = os.environ.get("OIR_JRE_VENDOR", "zulu-jre")
JRE_VERSION = os.environ.get("OIR_JRE_VERSION", "11")


def fetch_jre() -> Path | None:
    """Provision the JRE explicitly with cjdk, downloading it if needed.

    Deliberately does NOT go looking for whatever Java happens to be installed:
    CI runners ship a system JDK, so scyjava starts the JVM from that and cjdk
    is never invoked — leaving nothing to copy. Asking cjdk directly makes the
    staged runtime the same on a developer's Mac and on a fresh runner.
    """
    try:
        import cjdk
    except ImportError:
        print("ERROR: cjdk is not installed (pip install -r backend/requirements.txt)",
              file=sys.stderr)
        return None
    try:
        home = Path(cjdk.java_home(vendor=JRE_VENDOR, version=JRE_VERSION))
    except Exception as e:
        print(f"ERROR: cjdk could not provide {JRE_VENDOR} {JRE_VERSION}: {e}", file=sys.stderr)
        return None
    if not home.is_dir():
        print(f"ERROR: cjdk returned a missing path: {home}", file=sys.stderr)
        return None
    return home


def find_cached_jars() -> list[Path]:
    m2 = Path(os.environ.get("M2_REPO", Path.home() / ".m2" / "repository"))
    return sorted(Path(p) for p in glob.glob(str(m2 / "**" / "*.jar"), recursive=True))


def resolve_jars() -> None:
    """Populate the Maven repository with Bio-Formats and its dependencies.

    Done by starting the JVM the way the reader does, which makes scyjava/jgo
    resolve the whole dependency tree into ~/.m2 — the set we then copy.
    """
    print("resolving Bio-Formats jars via scyjava…", flush=True)
    code = (
        "import scyjava;"
        "scyjava.config.endpoints.append('ome:formats-gpl:8.0.1');"
        "scyjava.start_jvm();"
        "scyjava.jimport('loci.formats.ImageReader');"
        "print('jars resolved')"
    )
    env = {**os.environ}
    env.pop("OIR_RUNTIME_DIR", None)  # must not short-circuit to a staged runtime
    subprocess.run([sys.executable, "-c", code], check=True, env=env)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--clean", action="store_true", help="remove backend/runtime and exit")
    args = ap.parse_args()

    if args.clean:
        shutil.rmtree(RUNTIME, ignore_errors=True)
        print(f"removed {RUNTIME}")
        return 0

    jre = fetch_jre()
    if not jre:
        return 1

    jars = find_cached_jars()
    if not jars:
        resolve_jars()
        jars = find_cached_jars()
    if not jars:
        print("ERROR: no jars found in the Maven repository after resolving",
              file=sys.stderr)
        return 1
    # Sanity-check that we got the reader itself, not just transitive noise.
    if not any(j.name.startswith("formats-gpl") for j in jars):
        print(f"ERROR: formats-gpl jar missing from the {len(jars)} jars found",
              file=sys.stderr)
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
