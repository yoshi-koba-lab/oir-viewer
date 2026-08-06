// oir-viewer version.
//
// Format: vX.Y.Z
// - Z (patch): auto-incremented by Claude on every source-code update.
// - X.Y (major.minor): only bumped when the user explicitly requests it.
//
// Update history (latest first):
//   1.2.6 — 2026-08-06 — A failed Open says why. On Windows, picking a file and
//     pressing Open did nothing at all: no image, no error. The open WAS failing
//     and the toolbar WAS recording the reason — into `openError`, which is only
//     rendered inside the path-entry modal. The primary Open button opens the OS
//     picker with that modal closed, so the message went into an element that was
//     not mounted, the button flicked back from "Opening…", and the failure was
//     indistinguishable from a dead button. Failures now go through the store's
//     banner, which is always on screen; openAndReload/uploadAndReload record
//     there themselves, so no caller can swallow one again. The banner no longer
//     times out (eight seconds is not long enough to read a Java error, let alone
//     pass it on), wraps multi-line text, and is selectable. Drag-and-drop's own
//     toast is gone — two red boxes at the same coordinates.
//     The reason also reaches the log 1.2.5 started writing: /api/open and
//     /api/upload print a traceback there rather than only a one-line summary,
//     and the backend opens with the stream encodings and the resolved Java
//     runtime — which jvm library, how many jars, whether formats-gpl is among
//     them. The JVM is started on a background thread at launch, so a Java
//     runtime that cannot start is reported as that instead of surfacing later
//     as "this file will not open", and the first file no longer pays the
//     multi-second cold start.
//     Three Windows-only defects found by reading the shipped 1.2.3 installer:
//     stdout is a pipe, so Python encoded it as cp1252/cp932 and print() raised
//     UnicodeEncodeError on the em dash in this app's own startup line — fatal
//     inside lifespan on a Japanese install; both streams are now forced to UTF-8.
//     JPype loads jvm.dll with a bare LoadLibraryW, which does not search the
//     library's own directory for the msvcp140/vcruntime140 DLLs Zulu ships beside
//     it, so <jre>/bin is added to the DLL search path (macOS and Linux resolve
//     these relative to the library, which is why only Windows was exposed).
//     And concurrent opens both saw a stopped JVM and both called startJVM, the
//     loser failing with "JVM is already started" — now serialised.
//   1.2.5 — 2026-08-06 — The backend's output is written to a file. It went to the
//     Electron main process's stdout, and a packaged GUI app on Windows has no
//     console attached — so every Python traceback went nowhere and a failure left
//     no evidence at all. One file per launch under ~/.oir-viewer/logs/, the last
//     ten kept, with the version and platform in the header, plus a Help menu item
//     that opens the folder. Logging can never be the reason startup fails: every
//     step of it is best-effort.
//   1.2.4 — 2026-08-06 — Tells you when a newer release exists. The app asks the
//     GitHub Releases API once per launch — its only outbound request, sending
//     nothing but the running version number — and shows one dismissible line if
//     there is something newer. Dismissing silences that version for good: a
//     notice that returns every launch teaches people to close it unread.
//     Every failure path is silent. Offline, behind a proxy, rate-limited or
//     GitHub down all report "no update" rather than an error, because a viewer
//     that cannot reach GitHub is still a working viewer. The answer is cached
//     for six hours so reopening the window cannot burst against the 60/hour
//     unauthenticated limit. Versions are compared numerically, so 1.2.10 is
//     correctly newer than 1.2.9.
//   1.2.3 — 2026-08-06 — The Open button no longer hangs on Windows. The packaged
//     backend was calling subprocess.run([sys.executable, "-c", tkinter_code]) to
//     show a picker, but PyInstaller makes sys.executable the app itself — so it
//     launched a SECOND backend, blocked for its full 300 s timeout, and left the
//     UI on "Opening…" before reporting the wait as a user cancellation. _tkinter
//     was not bundled either, so the call could not have worked regardless. Only
//     macOS escaped it, via a separate osascript path. Verified against the shipped
//     1.2.2 binary: `oir-viewer-backend -c "print(1)"` prints nothing and starts a
//     server on the port instead.
//     The pickers now belong to the desktop shell, which owns a real native dialog
//     on every platform: a preload script exposes exactly two calls over
//     contextBridge, and the renderer falls back to the HTTP endpoint only when
//     there is no shell. That endpoint now answers 501 with an explanation instead
//     of hanging. The file filter always offers "all files" — Olympus companion
//     chunks have no extension, so an extension filter hides them.
//   1.2.2 — 2026-08-06 — The histogram no longer rescans the raw plane on every
//     contrast tick. It was keyed on the channel object, which setChannelRange
//     replaces on each tick, so dragging a dashed marker two pixels reread up to
//     8.5 M raw values. Counts are now cached per (plane, axis) in a WeakMap, so a
//     drag rescans nothing while new pixels or a re-fitted axis still rescan once.
//     Measured: 0 raw scans across 5 contrast changes, and ~24 ms saved per change.
//     That is far less than the ~178 ms predicted, and the prediction was wrong
//     rather than the fix: the browser composite costs ~319 ms, not the ~170 ms a
//     Node benchmark of the same loop reports, because the benchmark excludes the
//     34 MB createImageData/putImageData round trip. The contrast path is still
//     ~343 ms and remains a full-resolution CPU composite; that is the real target.
//   1.2.1 — 2026-08-05 — Fixed the Min/Max sliders moving the thumb away from the
//     cursor. 1.2.0 derived the track's upper end from the current window on every
//     render, so pulling Max down past the channel's data scale shrank the track
//     mid-drag and the thumb jumped right while the pointer kept going left —
//     measured on the user's file as a release at 21% of the track leaving the
//     handle at 71%, which reads as "changing Min/Max does nothing". The track is
//     now stored per channel: fitted when pixels arrive, re-fitted only by Auto,
//     and otherwise only ever widened. A drag can never rescale the track it is
//     being dragged on.
//   1.2.0 — 2026-08-05 — The contrast controls now span the channel's own scale
//     instead of the declared bit depth. A 12-bit file whose channels top out near
//     600 was given 0..4095 sliders, so 86% of the travel did nothing and the
//     histogram was an invisible sliver at the left edge — the contrast read as
//     broken because, at that resolution, it effectively was. The backend already
//     inferred a data-derived scale for its own histogram; the client now uses the
//     same rule for the sliders and the plot, so the handles line up with the data.
//     A typed number is still bounded only by what the format can hold, and the
//     axis widens to keep it representable.
//     The scale bar became a shared DOM overlay used by all four views, so it can
//     be dragged anywhere (double-click returns it to the bottom-left) and its
//     position follows the sample rather than the panel. Its outline is a hard
//     stroke rather than a blurred glow: a soft halo around a dark glyph is a
//     bright cloud that eats thin strokes, which is why a black bar looked out of
//     focus. Wheel zoom and in-progress pans now survive the cursor crossing it.
//   1.1.0 — 2026-08-05 — The scale bar belongs to the image, not to the panel. It now
//     sits at the image's own bottom-left corner and follows the pan and zoom, instead
//     of floating in a corner of the viewport where it said nothing about what it was
//     measuring. Its colour is selectable from a palette (or any colour), and the halo
//     behind it follows the bar's luminance so black stays readable on dark signal.
//     Labels are set in Arial. The four views had four independent implementations that
//     disagreed on rounding, target width and label format — the same image could read
//     "20 um" in 2D and "10 um" in Compare — so they now share one definition, one
//     length, one colour and one on/off switch, with the controls in every view. Split
//     had no scale bar at all and now has one. Auto lengths are capped at 70% of the
//     image so a zoomed-out bar cannot span the whole field.
//   1.0.2 — 2026-08-05 — Every API call now reports what actually failed. api.ts called
//     res.json() on 28 unguarded paths, so any response without a JSON body surfaced as
//     "Failed to execute 'json' on 'Response': Unexpected end of JSON input" — which describes
//     the parser, not the problem. With the backend down, Vite's proxy answers with an
//     empty-bodied 502 and that is exactly what the Open button showed. A shared reader now
//     distinguishes: an unreachable backend, a FastAPI error/detail body, a non-JSON 200 (the
//     request fell through to the static handler, i.e. a stale API), and an empty 200.
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

export const VERSION = '1.2.6';
