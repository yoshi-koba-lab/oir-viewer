# OIR Viewer

Viewer for Olympus `.oir` microscopy stacks (and `.oib` / `.oif` / `.tif` / `.nd2` / `.lif` / `.czi`),
built for looking at multi-channel Z-stacks quickly and exporting figure-ready images.

- **2D** — per-channel LUT and contrast, and a cursor readout showing the pixel
  coordinate plus every channel's raw intensity at that point.
- **Z** — vertical slider on the left edge (top = first slice), arrow keys, MIP.
- **Split** — one panel per channel plus a merge.
- **Compare** — several files side by side with synced or per-panel pan/zoom, a
  shared Z/MIP selection clamped per file, and drag-to-reorder.
- **3D** — ray-marched volume with typed orbit angles, a Z sub-range, XY/YZ/XZ
  presets, and "save the current view" to PNG/TIFF
  (merged and/or per channel).
- **Export** — per-channel and merged TIFF/PNG/JPEG, Z-projection to OME-TIFF,
  ROI line profiles and area measurements.
- **Scale bar** — starts at the image's bottom-left corner in every view and
  follows the pan and zoom; drag it anywhere, double-click to send it back.
  Length (or auto), colour and on/off are one shared setting, so a figure set
  keeps one bar. Labels are set in Arial.

Two behaviours worth knowing about:

- **Contrast opens as acquired.** The display range recorded by the microscope
  (the LUT's shadow/highlight points) is read from the file and rescaled to the
  data's bit depth, so an image looks like it did on the scope rather than
  auto-stretched. `Auto` / `Auto All` switch to percentile auto-contrast. Note
  that a file whose LUT covers the whole bit depth — what gets recorded when
  nobody adjusted it — opens flat by definition; `Auto` is the quick fix.
  The Min/Max sliders and the histogram span each channel's own scale rather
  than the declared bit depth, so the useful range is not squeezed into a
  fraction of the track.
- **Split `.oir` files are detected.** Olympus splits a dataset over ~1 GB into
  `<name>.oir` plus extensionless `<name>_00001`, `_00002`, … Opening only the
  `.oir` still "works" but silently exposes just part of the stack (e.g. Z 13 of
  50). The viewer notices and warns. Use **Open** and pick the file in its
  original folder so the companions are found — drag & drop cannot carry them.

## Install

Download the installer for your platform from
[Releases](../../releases) — nothing else is required. Python and Java are
bundled; there is no separate setup.

- macOS: `OIR Viewer-<version>-arm64.dmg` (Apple silicon) or `-x64.dmg` (Intel)
- Windows: `OIR Viewer Setup <version>.exe`

### First launch

The builds are not code-signed, so each OS warns once about an unidentified
developer. This is expected; it says nothing about the app itself.

- **macOS** — double-clicking shows *"cannot be opened because it is from an
  unidentified developer."* Instead **right-click (or Control-click) the app →
  Open → Open**. Only needed the first time. On recent macOS the button may
  appear under System Settings → Privacy & Security → *Open Anyway*.
- **Windows** — SmartScreen shows *"Windows protected your PC."* Click
  **More info → Run anyway**.

First start also takes a few seconds longer than later ones: the bundled Java
runtime is initialised on demand.

## Running from source

```bash
# backend
python3 -m pip install -r backend/requirements.txt
python3 backend/main.py --no-webview        # prints the port it chose

# frontend (separate terminal)
cd frontend && npm install && npm run dev
```

The backend picks a free port (8765 upwards) and writes it to
`frontend/.backend-port`, which the Vite dev proxy reads — so nothing needs
editing when 8765 is already taken.

Alternatively build the bundle once and let the backend serve it, which is how
the packaged app runs — one process, one port, no proxy:

```bash
cd frontend && npm run build
python3 backend/main.py --no-webview        # then open the printed URL
```

## Building the desktop app

Java is needed to read `.oir` (Bio-Formats), so a JRE and the Bio-Formats jars
are staged into the build. `stage_runtime.py` gets them by running the normal
code path once and copying what it resolved:

```bash
python3 scripts/stage_runtime.py            # → backend/runtime (~155 MB)
(cd frontend && npm ci && npm run build)
pyinstaller backend/oir-viewer-backend.spec --noconfirm --distpath dist --workpath build
(cd desktop && npm install && npx electron-builder)
```

Installers land in `release/`. `backend/runtime/` is generated and git-ignored.

A Mac app cannot be built on Windows or vice versa, so
[`.github/workflows/build.yml`](.github/workflows/build.yml) builds each on its
own runner; pushing a `v*` tag attaches the installers to a Release.

## Layout

```
backend/     FastAPI: reads images, serves slices as raw binary, writes exports
             main.py      API + static hosting + port selection
             reader.py    Bio-Formats/TIFF loading, JVM bootstrap, metadata
             processor.py contrast, histograms
             roi.py       line profiles, ROI statistics
frontend/    React + Vite + Tailwind + zustand; Canvas2D, three.js for 3D
desktop/     Electron shell: spawns the backend, opens the window
scripts/     stage_runtime.py
```

Data the app writes lives in `~/.oir-viewer/` (`session.json` remembers which
files were open; `uploads/` holds dropped files).

## License

MIT
