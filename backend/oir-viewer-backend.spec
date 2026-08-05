# PyInstaller spec for the OIR Viewer backend.
#
# Produces dist/backend/oir-viewer-backend (onedir), which the Electron shell
# spawns. Everything the app needs at runtime travels with it:
#   runtime/         the JRE + Bio-Formats jars staged by scripts/stage_runtime.py
#   frontend_dist/   the built UI, which the backend serves itself
#
# Build with:
#   python3 scripts/stage_runtime.py
#   (cd frontend && npm ci && npm run build)
#   pyinstaller backend/oir-viewer-backend.spec --noconfirm --distpath dist --workpath build
import os

BACKEND = os.path.abspath(os.path.join(SPECPATH))          # noqa: F821 (PyInstaller global)
ROOT = os.path.dirname(BACKEND)

datas = []

runtime = os.path.join(BACKEND, "runtime")
if os.path.isdir(runtime):
    datas.append((runtime, "runtime"))
else:
    raise SystemExit(
        "backend/runtime is missing — run `python3 scripts/stage_runtime.py` first.\n"
        "Without it the packaged app would try to download a JDK on first use."
    )

dist = os.path.join(ROOT, "frontend", "dist")
if os.path.isdir(dist):
    datas.append((dist, "frontend_dist"))
else:
    raise SystemExit("frontend/dist is missing — run `npm run build` in frontend/ first.")

# scyjava/jgo and uvicorn resolve pieces dynamically, so name them explicitly.
hiddenimports = [
    "scyjava", "jpype", "jpype._core", "jgo",
    "uvicorn.logging", "uvicorn.loops.auto", "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto", "uvicorn.lifespan.on",
    "tifffile", "PIL.Image", "scipy.ndimage",
    # The file picker on Windows/Linux runs through tkinter.
    "tkinter", "tkinter.filedialog",
]

a = Analysis(                                              # noqa: F821
    [os.path.join(BACKEND, "main.py")],
    pathex=[BACKEND],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["matplotlib", "pytest", "IPython", "notebook"],
    noarchive=False,
)
pyz = PYZ(a.pure)                                          # noqa: F821

exe = EXE(                                                 # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="oir-viewer-backend",
    debug=False,
    strip=False,
    upx=False,        # UPX corrupts the JRE's dylibs
    console=True,     # Electron reads the startup line from stdout
)
coll = COLLECT(                                            # noqa: F821
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="backend",
)
