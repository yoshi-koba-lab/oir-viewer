// oir-viewer version.
//
// Format: vX.Y.Z
// - Z (patch): auto-incremented by Claude on every source-code update.
// - X.Y (major.minor): only bumped when the user explicitly requests it.
//
// Update history (latest first):
//   1.5.1 — 2026-08-07 — Min/Max had no effect at all in the 3D view. The shader has
//     uMins/uMaxs and applies them correctly; what it was handed was 0 and 1 for
//     every channel, hardcoded, so it was a pass-through. Moving the sliders did
//     nothing, in the app and in the browser alike.
//     What 3D therefore showed was not the user's window but the auto-contrast
//     the backend applies when it packs the volume into uint8 — which is computed
//     over the whole stack, while 2D windows the current plane from raw uint16.
//     Those disagree, so "3D looks darker than 2D" was the same defect seen from
//     the other side rather than a separate one.
//     /api/volume-bin already reports the [low, high] it normalised each channel
//     over, and the client already parsed it, so the fix needs no refetch: the
//     user's window is mapped into the texture's own scale and the shader does
//     the rest on the GPU, so dragging a slider is immediate.
//     Verified on real acquisition data (2910x2924x50, 5 channels): Max 199 -> 40
//     turns a dim mottled volume fully bright, and Min 0 -> 120 leaves only the
//     brightest voxels. Both directions, so it is the window and not a gamma.
//     One limitation this does not remove: the volume is uint8, clipped to that
//     auto range, so widening the window past it cannot recover what was clipped.
//     Narrowing — the common case — is exact.
//   1.5.0 — 2026-08-07 — Saving names the file, and never replaces one silently.
//     Every export used to name its own files and, on a collision, quietly slide
//     to `_01`, `_02`. Nothing was ever destroyed — the report of "it overwrites
//     without asking" turned out to be the opposite, and reading every write path
//     is what established that — but the result is a folder of near-identical
//     files that cannot be told apart afterwards, from a name nobody chose.
//     There is now a filename field, filled in from the image and always
//     editable, on all three paths: channel/merge export, the 3D view, and the
//     plate PDF. Auto-suffixing is gone. Instead the backend computes every
//     destination before decoding a single plane, and if any of them exists it
//     answers 409 with the list and writes nothing at all — so cancelling really
//     does leave the folder as it was, and confirming replaces exactly what the
//     dialog named. Verified through the UI: 25 files, cancel leaves every mtime
//     and checksum untouched, confirm updates them and creates no `_01`.
//     A batch of several images keeps each image's own name, because one typed
//     name across a batch would collapse them onto the same set of files.
//     Names are checked while they can still be corrected — the Windows reserved
//     set (\ / : * ? " < > |, trailing dot or space, CON/PRN/NUL/COM1…) is
//     refused in the field rather than sanitised after the work is done.
//     Also a Windows-only defect found on the way: the default output folder was
//     computed by stripping everything after the last "/", and a Windows path has
//     none — so it kept the filename and offered a folder that does not exist.
//     Path handling now understands both separators.
//   1.4.1 — 2026-08-07 — The app would not start after a plate session. Restoring the
//     previous session called load_file() on every remembered path, inside the
//     startup lifespan, so it decoded them all before the server answered
//     anything. One real well is 2911x2923x50x5 uint16 = 4.25 GB; eight of them
//     is 34 GB, which is what the user watched it take before it died. Reported
//     from Windows as "33 GB and then an error", and the guess in the report —
//     that it was reopening the previous files — was exactly right.
//     Restore now registers each file without reading it, using the dimensions
//     recorded in session.json so the tabs are right with no disk access at all.
//     Pixels arrive when a tab is actually opened. Measured: eight wells restore
//     with 0 pixel bytes and no measurable RSS change.
//     Lazily loading is not enough on its own, because opening all eight tabs
//     then reaches the same 34 GB. Loaded pixels are now held against a budget
//     of 40% of physical RAM — a fraction, not a constant, since the same number
//     means opposite things on a 192 GB workstation and a 16 GB laptop — and the
//     least recently used image gives its pixels back when the budget is
//     exceeded. The tab stays; it reloads when looked at again.
//     --selftest covers it, and the check was verified by reintroducing the bug:
//     the old behaviour fails it. This class of defect is invisible in
//     development, where the session holds one small file, because the size of
//     the failure is a property of the user's data rather than of the code.
//   1.4.0 — 2026-08-07 — Plate export now takes each well as you left it, and carries
//     a conditions table. The old flow read every well straight off disk with one
//     global contrast and one fixed angle, so the figure could only ever show a
//     setting nobody had looked at. Now the wells are opened as ordinary tabs,
//     tuned one at a time in the viewer, and the export reads what each tab is
//     actually set to — channels, colours, Min/Max, angle, Z slab, per well.
//     That required the 3D view to stop being local state. Orbit and Z range
//     lived inside Volume3DViewer, so switching wells reset them: setting up
//     eight wells was impossible, because checking the first one again undid it.
//     They are per-image now. A well seen for the first time keeps the current
//     angle rather than snapping back — a plate figure wants one direction — while
//     its Z slab starts at the full stack, which is per-volume.
//     The table is seeded from what each well is set to and is then yours: edit
//     any cell, add and delete columns, rename headers. A hand-edited cell is not
//     overwritten by re-seeding — "CH1, CH2" is what the app knows, "GFP, DAPI" is
//     what the figure needs to say — and only the explicit refill button overrules
//     that. Columns marked 図 print over the top-left of their well's image; every
//     column appears on a second PDF page, in the same file, because a figure and
//     the conditions behind it get separated the moment they are two downloads.
//     Another glyph hole, found by looking at the output: Hiragino Sans GB has
//     every Japanese character and no U+00B5, so "10 µM" printed with a box in it
//     while the font passed the check added yesterday — that check probed one
//     kanji. Fonts are now scored across the characters this figure actually
//     prints (µ ° β ± × ℃ Å, kana, kanji), and µ is folded to the identical-
//     looking U+03BC before drawing, which fixes it in every font rather than one.
//   1.3.0 — 2026-08-07 — Plate-to-PDF export, wired end to end, then audited before
//     going to Windows for testing on real data. The audit found 24 real defects in
//     this feature and every blocker was silent — each one produced a finished PDF
//     that looked right and was wrong. The interesting ones:
//     Downscaling was point-sampling. scipy's zoom(order=1) reads the source at the
//     output sample positions, so 2911 -> 128 consulted about one pixel in 23 and
//     ignored the rest. Measured on 2 px lines 97 px apart: 26 of 31 lines vanished
//     completely, and the mean came out 115.9 / 250.0 / 90.3 at the three
//     resolutions against a true 83.8 — wrong, and erratically so. Planes are now
//     low-pass filtered by the reduction factor first, which is what an
//     anti-aliased resample means: 43 columns keep signal instead of 5, and the
//     mean lands at 86.6. Thin epithelial structure is the subject here, so the
//     old behaviour was not a quality setting, it was data loss.
//     matl.omp2info was decoded as ASCII, so a Japanese plate name was already
//     U+FFFD before anything tried to draw it. And what drew it had no Japanese
//     glyphs either — Helvetica and Arial render CJK as .notdef boxes rather than
//     failing. Fonts are now chosen CJK-first and probed by rendering, because a
//     missing glyph still has a bounding box: the only honest test is to draw the
//     character and compare it against a codepoint no font defines.
//     The export rendered every well as a cube. The interactive view scales by
//     physical voxel size and this did not, so a 0.2/0.2/2.0 µm stack came out with
//     Z stretched 1.33x — the PDF being the one view of the data with the wrong
//     proportions, which is worse than no PDF because it still looks like a result.
//     Both now read the same voxel size from the file.
//     Pixel type was hardcoded to 16-bit, so an 8-bit well was reinterpreted in
//     pairs: half the width, values glued from two unrelated pixels, rendering as
//     noise rather than failing.
//     Choosing wells and
//     pressing "PDF を作成" now walks them one at a time — fetch the volume, render
//     it offscreen, capture the frame, release the textures — and posts the frames
//     to be composed. Verified on 8 synthetic wells: 9.9 s, every well in its own
//     row and column, and the images distinguishable from one another (the fixtures
//     grow monotonically from B02 to C05 and the PDF shows that order), so the
//     labels are checked against the pictures and not just against the parser.
//     NOT yet verified on real acquisition data — the fixtures are 320x320x24x3 and
//     a real well is 2911x2923x50x5, two orders of magnitude larger.
//     CI could not publish a Release. `release` needs `build`, and the Intel-Mac
//     leg targeted macos-13, which is retired — no runner is ever assigned, so the
//     job sat queued for hours and the tag produced nothing. Eight runs had piled up
//     that way, and v1.2.7's installers had to be attached by hand (its Mac DMG
//     never was). The leg moves to macos-15-intel, `release` runs on `!cancelled()`
//     so one dead platform cannot withhold the installers that did build, each job
//     has a timeout, and a concurrency group stops runs stacking up again.
//     Output resolution is
//     chosen, not fixed, because a figure sometimes has to keep the original
//     detail: the volume fed to the renderer is Low/Medium/High/Ultra/Max (Max =
//     source resolution, no downscale and no Z decimation) and the raster of each
//     well in the PDF is 300/600/1200/2000 px. Raising the raster grows the page
//     rather than upscaling the image, which would add no detail and quadruple the
//     file. Cells never stretch; they letterbox.
//     There is no server-side resolution ceiling. The real limit is the GPU's
//     MAX_3D_TEXTURE_SIZE, which is 2048 on this machine and 16384 on others, so
//     it can only be asked at render time — and it is, naming the axis that
//     overflowed. Untested, texImage3D just fails with a bare INVALID_VALUE. On an
//     M5 Pro the real 2911x2923 data exceeds 2048 in both X and Y, so Ultra (1024)
//     is the practical maximum there; Max stays selectable and explains itself.
//     PDF pages are composed with Pillow at 300 dpi in the plate's own grid, every
//     position present, unacquired and disabled cells distinguished, each cell
//     carrying its well ID so a mislabelled figure is visible rather than
//     plausible. Repeat exports never overwrite an earlier one.
//     The ray-marching shaders moved to utils/volumeShader so the export and the
//     interactive view cannot drift — a PDF shaded differently from the inspection
//     it came from would be worse than no PDF. The export renderer owns its own
//     context and disposes textures between wells.
//   1.2.9 — 2026-08-06 — Plate wells can be read without building the whole volume,
//     and the JVM's heap is bounded. A well's stitched OIR is now streamed plane by
//     plane: read one plane, resize it, apply the window the user set, write the
//     bytes. The existing volume route instead loads (T,C,Z,Y,X) eagerly, resizes a
//     whole channel at once and calls auto_contrast — 3.96 GiB per well to produce
//     the 3.1 MiB a Low render needs, and it would auto-stretch, which plate export
//     must never do.
//     Streaming alone did NOT fix the memory, and measuring caught it: peak RSS
//     still tracked the source, +73/+641/+1349 MB for 34/240/586 MB sources. The
//     JVM sizes its maximum heap from physical RAM and grows into it rather than
//     collecting, so resident memory followed the file — about 9 GB extrapolated to
//     a real well. With the heap capped the same reads peak at +90/+479/+407 MB:
//     bounded, and no longer a function of well size. Bio-Formats only ever needs a
//     plane or two; the growth was slack.
//     The ceiling is 4 GB, not tight: the machine this runs on has 192 GB, so it
//     exists only to stop the heap drifting up with file size, never to ration.
//     Also: this route never registers the image in the global map (which is what
//     pinned a volume per well), closes the Java reader in a finally, admits one
//     well at a time, and refuses anything but Low — the cap is enforced server
//     side, not just in the UI.
//   1.2.8 — 2026-08-06 — Reads an Olympus MATL plate acquisition. A Plate button
//     opens a folder, parses matl.omp2info (plain XML, no Bio-Formats), and shows
//     the acquisition in the plate's own shape — unacquired wells kept as empty
//     cells in their real positions, which is also the layout a PDF export will
//     use. Click wells to choose them, then open them as ordinary image tabs.
//     Where a well sits is checked twice, against two independent sources: the
//     label (B02 -> row B, column 2) and the stage coordinates in areaInfo. A
//     transposed or shifted grid would otherwise produce a correctly rendered
//     figure with the wrong labels, which nothing downstream could catch. All 8
//     wells of the real acquisition agree.
//     The XML names only per-tile files, never the stitched one the microscope
//     also wrote, so that is derived (<prefix>_B02_G001_0001.oir ->
//     Stitch_B02_G001.oir) and checked on disk. A well whose stitched file is
//     missing is marked in red, never left looking unacquired.
//     Wells open one at a time and awaited: these are ~1 GB volumes and eight
//     concurrent opens is how the tab ran out of memory. One failure does not
//     abort the run.
//     3D-to-PDF batch export is not implemented; the dialog says so.
//   1.2.7 — 2026-08-06 — Packaged builds could not open a .oir at all, on any
//     platform. scyjava's __init__ ends with `__version__ = get_version("scyjava")`,
//     which reads its own .dist-info at import time; PyInstaller collects modules
//     but not .dist-info, so `import scyjava` raised PackageNotFoundError in every
//     packaged build. That is an ImportError subclass, and reader.py caught it and
//     reported "scyjava is needed. pip install scyjava jpype1" — about a package
//     sitting right there in the bundle. .tif kept working because TIFF never goes
//     through Java, which is what made it look like a file-format problem.
//     Reproduced against the shipped 1.2.2 DMG before fixing: opening a .oir
//     returned exactly that message; opening a .tif returned a correct
//     FileNotFoundError. The Mac release was equally broken and nobody noticed,
//     because running from source sees site-packages metadata.
//     copy_metadata now ships the metadata for scyjava, jgo and JPype1, and the
//     import failure reports the real exception type and text — in a frozen build
//     as a broken bundle rather than as advice to pip install. Guessing at the
//     cause is what let missing metadata masquerade as a missing dependency for a
//     whole release.
//     A --selftest flag walks the actual path (import scyjava, start the bundled
//     JVM, jimport the four Bio-Formats classes the reader uses) and CI runs it on
//     every platform before building an installer. The old smoke test only asked
//     whether the server answered /api/images, which a build that cannot reach
//     Java passes.
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

export const VERSION = '1.5.1';
