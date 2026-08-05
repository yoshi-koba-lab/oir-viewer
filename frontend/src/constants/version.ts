// oir-viewer version.
//
// Format: vX.Y.Z
// - Z (patch): auto-incremented by Claude on every source-code update.
// - X.Y (major.minor): only bumped when the user explicitly requests it.
//
// Update history (latest first):
//   1.0.1 — 2026-08-05 — Distribution + first-run fixes. Open now shows the OS file picker
//     (Finder on macOS, tkinter elsewhere, multi-select) instead of only accepting a typed path;
//     the path box moved behind the small "…" button. The empty-state screen replaced the
//     full-window overlay that dimmed the toolbar along with everything else, making the Open
//     button it pointed at look disabled — it now sits in the viewport area and carries its own
//     open button. Scale bar length is typeable (blank = auto) and shared by 2D/Compare/3D.
//     Opening a bare `_00001` chunk of a split .oir is refused with an explanation rather than
//     loading as a black image, and an upload that collides with an existing name goes into a new
//     subfolder instead of being renamed (renaming severed the .oir↔chunk link). Packaging:
//     scripts/stage_runtime.py stages a JRE + the Bio-Formats jars so a distributed build never
//     downloads a JDK or hits Maven (verified with ~/.m2 and the cjdk cache hidden); the backend
//     serves the built frontend itself, so the app is one process on one port with no CORS
//     surface; Electron shell in desktop/ spawns it, waits for the port to actually answer, and
//     owns the window; GitHub Actions builds mac-arm64/mac-x64/win-x64 installers.
//     requirements.txt gained the deps the code always used (scyjava, JPype1, tifffile,
//     python-multipart, cjdk) — a CI build could not have worked without them.
//   1.0.0 — 2026-08-04 — First numbered release. Viewer for Olympus .oir (plus TIFF/ND2/LIF/CZI) 5D
//     stacks: 2D view with per-channel LUT/contrast and a cursor coordinate + per-channel intensity
//     readout, vertical Z strip on the left edge (top = first slice), Split (per-channel + merge),
//     Compare (up to 6 images side by side with synced or per-panel pan/zoom, shared Z/MIP selection
//     clamped per file, drag reorder), and a 3D ray-marched volume view (typed orbit angles, Z
//     sub-range, XY/YZ/XZ presets). Reads the acquisition display range (LUT shadow/highlight) from
//     the file and rescales it to the data's bit depth, so an image opens as it looked on the
//     microscope rather than auto-stretched. Detects a split .oir opened without its `_00001…`
//     companion chunks — that silently exposed only part of the stack (Z 13 of 50) — and warns.
//     Export to TIFF/PNG/JPEG per channel and merged, Z-projection to OME-TIFF, ROI line profiles
//     and measurements. Session (open files) and per-file display settings persist across restarts.
//     Backend transfers slices as raw binary with a 300 MB LRU cache and neighbour prefetch; it
//     auto-selects a free port and publishes it to the frontend.
//   0.x — pre-release development (unversioned)

export const VERSION = '1.0.1';
