// oir-viewer version.
//
// Format: vX.Y.Z
// - Z (patch): auto-incremented by Claude on every source-code update.
// - X.Y (major.minor): only bumped when the user explicitly requests it.
//
// Update history (latest first):
//   1.5.6 — 2026-08-09 — Opening a Z stack no longer performs or displays any
//     local-RAM admission warning, including the low-memory Continue/2D choice
//     introduced in the 1.5.5 candidate. `/api/volume-plan` deliberately remains:
//     it is now only an integrity handshake binding source identity/revision, T,
//     source and output shapes, source residency and the process-wide heavy-work
//     epoch to the following `/api/volume-bin` request. The renderer also checks
//     the binary header, shape and byte count. This contract prevents stale or
//     mismatched voxels from becoming a plausible image; it does not claim that
//     the machine has enough RAM and it never asks the user to override a limit.
//     A fresh Z > 1 image still opens in 3D at Maximum quality. Its initial 100%
//     zoom is now an eight-corner perspective fit of the physically proportioned
//     volume into the unobscured canvas (94% of the limiting dimension, excluding
//     the controls), rather than the old fixed camera radius. Zoom is a numeric
//     10-1000% value, stays synchronised with the wheel, survives tab changes and
//     can return to the exact fit with one action. Missing physical calibration
//     changes framing to voxel proportions but never invents a metric scale.
//     A 3D scale bar is visible by default inside the image at bottom left, and
//     saved 3D images include it by default. Because perspective makes pixel
//     length depth-dependent, the value is explicitly calculated at the volume's
//     centre depth. All X/Y/Z voxel sizes must be positive; otherwise no numeric
//     bar is displayed or exported. Plate Save uses the same camera and scale
//     maths. It defaults to one editable 100% zoom for every well, can instead use
//     each tab's zoom, and defaults to a centre-depth bottom-left scale bar. The
//     applied zoom and bar are recorded in the PDF table and footer.
//     Every export path now reports a determinate percentage and save-specific
//     Japanese status instead of a generic loading message. Percentages advance
//     only when real work finishes: backend 2D and projection jobs count completed
//     output files plus publication; 3D counts each verified framebuffer capture
//     plus the filesystem request; Plate counts preflight, volume and render for
//     each well, then PDF publication (18 units for eight wells). No path reaches
//     100% until staged output has been reopened and validated and the requested
//     destination has been atomically published. A process-wide 3D-save owner
//     blocks tab, mode, open/drop/close and other save transitions until that
//     backend request definitively ends, so unmounting the viewer cannot discard
//     its lock or progress display.
//     2D, 3D and projection output is staged beside its destination, validated and
//     then atomically published. A target that is any currently open source file,
//     including a hard-link or symlink alias, is rejected before pixel/base64 work
//     and checked again at the publication boundary; overwrite confirmation never
//     permits replacing source microscopy data with a rendered RGB image.
//     A non-empty 2D `image_ids` list is likewise an exact, all-or-nothing
//     selection. If any explicit id became stale after the dialog opened, the
//     request fails before pixels rather than falling back to the active tab or
//     publishing the surviving prefix under the requested name. Active-image
//     fallback remains only for legacy callers that supply no ids at all.
//     The final source-build Plate path was then run end to end on the local copy
//     of the real acquisition: 105 files / 73,916,686,439 bytes, with all eight
//     ready wells B02-B05 and C02-C05. Independent scan, inventory and summary
//     manifests matched exactly before and after. Export took 178.459 s, backend
//     peak RSS was 6,758,858,752 bytes and minimum system-available memory was
//     15,649,374,208 bytes. Its `real8-v156-zoom100-scalebar.pdf` was 918,448
//     bytes (SHA-256 prefix c7b43009), two pages, and all eight cell audits had no
//     failures. The eight volume payload hashes were unique; every four-channel
//     volume and its final Z plane contained signal. All cells recorded unified
//     100% zoom and a 500 µm centre-depth bar at bottom left. Rendered pages passed
//     visual inspection for conditions, table and footer. The preceding real
//     Open/Maximum phase took approximately 88.378 s, peaked at 9,346,056,192
//     bytes RSS and observed 12,501,729,280 bytes minimum system-available memory.
//     An existing-PDF preflight invoked zero volume requests, preserved the
//     sentinel SHA-256 and mtime, and used the exact name without a suffix.
//     This proves the source build only. The first frozen r1 app was rejected
//     before its scientific smoke: a v1.5.6 process/backend reused loopback port
//     8768, but Chromium served the cached v1.5.3 index and the backend log showed
//     update-check `current=1.5.3`. Electron's `loadURL` now appends the desktop
//     version and a per-launch UUID as `desktop-version` and `launch` query
//     parameters. The cache key is fresh on every launch while the origin stays
//     unchanged, preserving localStorage and view-setting identity. The refrozen
//     r2 app then passed in that same old-cache environment. Its log proved
//     `frozen=True`, version 1.5.6, a GET for
//     `/?desktop-version=1.5.6&launch=<UUID>`, the current
//     `index-BkMn0YNV.js` / `index-BRXG3J-T.css` assets, and update-check
//     `current=1.5.6`.
//     This package smoke deliberately covered B02 and C05, two of the eight real
//     wells, distinct from the source build's complete eight-well run. Both opened
//     by default in 3D at Maximum, 100% fit, full Z and a bottom-left 500 µm bar,
//     with no RAM modal. B02 was changed to 125%, then Plate Save High 512 / Normal
//     600 overrode both wells to unified 100% with scale bars. The live UI showed
//     save-specific progress at 16, 50 and 100%; the deterministic two-well series
//     is 0,16,33,50,66,83,100, and 100 followed successful PDF publication.
//     `real2-v156-package-r2-zoom100-scalebar.pdf` was 479,631 bytes, two pages,
//     SHA-256 eb7b37447bcaa23277877606837a573425778cb02a4a5e7cd351a73aced3059b.
//     PDF audit rendered B02/C05 with no failures and signal fractions 0.69588458
//     / 0.679710177; their MAE 17.4733 and correlation 0.36095 confirmed distinct
//     non-black cells. Visual inspection passed both lower-left 500 µm bars, B02's
//     Unicode condition, the two table rows at unified 100% / 500 µm centre depth,
//     High-512 / zoom-100 / scale-bar / cell-600 / two-well footer and all clipping.
//     The backend log contained exactly two volume-bin calls and one PDF POST; two
//     target checks were the expected blur and Create preflights. The 105-file,
//     73,916,686,439-byte source scan/inventory/summary remained byte-for-byte
//     identical with all eight wells ready. Package open sampling took 195.584 s
//     (peak RSS 11,164,794,880 bytes; minimum available 30,380,064,768), and export
//     sampling took 78.825 s (peak RSS 10,623,352,832; minimum available
//     32,459,063,296). r1 remains rejected; r2 is the accepted package candidate.
//   1.5.5 — 2026-08-09 — A newly activated image now opens in the view its data
//     supports: Z > 1 enters 3D, Z = 1 stays in 2D, and 3D starts at Maximum
//     quality. Batch and Plate opens deliberately keep intermediate wells in 2D
//     and mount only the last volume, so choosing eight wells cannot start eight
//     overlapping Maximum loads.
//     The old fixed-size 3D warning is gone. Before `/api/volume-bin` allocates
//     its response, a pixel-free plan reports the exact output shape, source
//     residency, wire buffer, server staging, plane work and texture bytes. The
//     renderer estimates the additional peak as source increment plus the larger
//     of the server and delivery phases, plus 300 MiB for the slice cache, then
//     preserves max(2 GiB, 10 percent of physical RAM) as a reserve. It asks only
//     when current available RAM cannot cover that total, or when availability
//     cannot be measured; the choices are 2D or an explicit Continue. Electron's
//     privileged process supplies its cross-platform memory counters, with an
//     OS-specific backend fallback for source builds; swap is never permission
//     for another multi-gigabyte allocation.
//     The boundary is intentionally precise: this admission check precedes 3D
//     volume generation, not the original file's `/api/open` decode. A source
//     already resident contributes zero additional source bytes; an evicted one
//     contributes its full reload. The real C5/Z50/2929x2909 selftest pins that
//     source at 4,260,230,500 bytes. With a 2048 GPU cap and four renderable
//     channels the planned texture is 4x50x2048x2034 = 833,126,400 bytes; four
//     channels at source resolution are 1,704,092,200 bytes.
//     The first frozen v1.5.5 smoke found a package-only boundary behind those
//     same values: Bio-Formats supplies its dimensions as JPype Java integers,
//     while the new planner initially accepted only objects whose exact type was
//     Python `int`. The displayed tuple `(1, 5, 50, 2923, 2900)` was therefore
//     rejected before allocation. Java dimensions are now canonicalised at the
//     reader boundary and again with the integer protocol at the planner; the
//     route selftest uses non-native integer dimensions and the real C5/Z50 shape
//     so pure-Python literals cannot hide the packaged path again.
//     An approval token
//     binds revision, T, shape, output and residency, so a stale plan returns 409
//     before the pixel loader. One process-wide reservation serialises source
//     decode, activate/metadata reload, 2D deferred reads, Save, Projection,
//     interactive 3D and Plate volumes; large binary responses retain it until
//     their final ASGI byte is sent. Every heavy phase advances a memory epoch
//     embedded in the plan token. If another phase intervenes, volume-bin returns
//     a classified 409 and the renderer remeasures shape and free RAM instead of
//     executing a stale single-load estimate. Client and server also cross-check
//     the binary header, shape and byte count before WebGL can display it.
//     Per-file display settings no longer depend on Chromium localStorage, whose
//     origin changes with the packaged backend's loopback port. The backend owns
//     one atomic `~/.oir-viewer/view-settings.json`, and returns an entry only for
//     the exact canonical source path, identity and revision. It preserves a
//     corrupt store rather than silently replacing it. Thread and sidecar OS
//     locks serialize packaged and source backends as well as requests in one
//     process. Per-image PUT and DELETE operations are serialised; reset
//     invalidates an older GET synchronously, so a slow save or load cannot
//     resurrect deleted Min/Max values. A page-unload keepalive carries a
//     renderer-session sequence that the atomic backend store enforces, so an
//     older in-flight PUT cannot overwrite the final sub-400-ms edit. Both views now
//     expose `元ファイルの設定に全て戻す`: 2D restores channel visibility,
//     colours, Min/Max, Z/T, MIP and projection; 3D additionally restores camera,
//     Z slab and Maximum quality. DELETE is queued behind older PUTs; even if the
//     restored baseline is saved afterwards, the previous adjustments cannot
//     overtake reset and return.
//     Late channel replies are similarly bound to image identity/revision and the
//     exact Z/T/projection request, preventing pixels for a previous tab or plane
//     from landing under the current filename. A resampled 3D volume maps the slab
//     by covered fraction (for example 65-128/128 becomes 101-200/200), rather than
//     silently changing the physical depth shown. The reset baseline itself is an
//     explicit Z1/T1, non-MIP source snapshot fetched before a new image is
//     presented or saved settings are applied; the saved Z/T/MIP target pixels,
//     labels and LUT are then staged and published together. A slow first load can
//     no longer capture the old user window as the supposed file default, or show
//     pixels from Z1 under a restored Z50 label. Whole-image Open/Drop/activate/
//     close transitions are FIFO so a late backend completion cannot leave the UI
//     and the persisted session naming different active tabs. Opening an already
//     open source reuses its exact identity/revision tab, and duplicate session
//     entries are discarded, so another in-memory copy cannot resurrect settings
//     that Reset removed.
//     ROI profile and measurement requests carry explicit image and view
//     provenance, and are available only in a plain single-plane 2D view. MIP,
//     Z projection, Split and 3D cannot silently report a raw slice as if it were
//     the displayed image. A 3D render can be saved only after the exact image,
//     revision, T, quality and plan have completed a verified WebGL render. GPU
//     upload errors or context loss invalidate that proof, and MERGE plus
//     per-channel output is published only when every requested frame exists.
//     Finally, Plate is now only the cheap MATL scan, well selection and serial
//     open flow. A separate Plate Save button immediately to its right owns the
//     condition table, PDF options and the existing transactional export. This
//     removes a save dialog from the act of opening wells without weakening any
//     source-revision, preflight-conflict or publication check added in 1.5.4.
//   1.5.4 — 2026-08-09 — Plate PDF and Z projection exports now behave as
//     transactions: the source shown, the target confirmed, and the bytes
//     published must all still be the same things when a long export finishes.
//     Plate checks the chosen name before it reads a well, so an existing PDF is
//     reported in milliseconds instead of after an eight-well render. Cancelling
//     leaves the original checksum, mtime and inode unchanged; confirming writes
//     the exact named file and never creates `_01`. The output directory, resolved
//     filename and target revision are frozen across that confirmation.
//     A well is no longer identified by `B02` or a case-folded path. The main OIR
//     and every split companion are captured as one source identity and revision,
//     checked before and after each read and again before PDF publication. The
//     binary volume contract now proves channels, T, levels, dimensions, voxel
//     size and source provenance before WebGL sees a byte. Missing metadata,
//     dropped channels, incomplete split files, changed sources, label/stage
//     disagreement and a view that asks for channels outside the interactive 3D
//     texture all stop explicitly rather than making a plausible wrong figure.
//     Targets are written to same-directory staging files, reopened and validated,
//     then published under canonical-path thread and process locks. Revision and
//     destination-volume checks protect the confirmation window; batch rollback
//     preserves old results if a later publish fails, and keeps a recovery backup
//     if rollback itself fails. The same machinery covers projection OME-TIFFs.
//     The Windows packaged selftest caught one final portability boundary: CRT
//     `_commit` rejects a read-only descriptor, so completed staged files are
//     reopened writable without truncation before `fsync`.
//     Z projection now has the 1.5.0 save-as contract: an exact editable name,
//     pre-computation conflict confirmation, no suffixing, duplicate/self-source
//     rejection, and fresh decoded metadata at the moment each image is processed.
//     Its OME records channel names, physical XY calibration, projection method,
//     Z range and T. On the real B02 C5/Z50 stack, Max Z1-50/T1 produced an
//     85,206,458-byte OME-TIFF in 12.689 s at 5.012 GiB peak RSS; all five channels
//     and all pixels exactly matched an independent NumPy maximum, with C5/Z1/T1
//     and 1.242961 µm XY calibration on reopen. Conflict cancellation invoked zero
//     projections and preserved the sentinel; confirmed overwrite changed only
//     the exact target.
//     The Plate path was finally run end to end on the real 73.9 GB acquisition:
//     eight C5/Z50 wells, High (512) volumes and 600 px PDF cells, in both source
//     and an arm64 Electron RC containing the same functional code (its bundle
//     metadata still said 1.5.3). All eight packaged volume requests,
//     headers and complete response hashes exactly matched the source-build run.
//     Each packaged PDF cell was pixel-identical to its source-build counterpart
//     (MAE/RMSE 0, correlation 1); the 587,051-byte,
//     two-page PDF was reopened at 300 dpi and visually checked for all eight
//     distinct wells, labels, conditions, footer and table, with no black, missing,
//     duplicate or clipped output. The acquisition's 105 files and all eight
//     source identities/revisions were unchanged afterwards.
//     After that run only version and documentation metadata changed. The exact
//     1.5.4-labelled app was rebuilt from the same backend/frontend, passed the
//     frozen packaged selftest, and was byte-compared with both source builds;
//     the 73.9 GB UI run was not repeated merely for the label change.
//     Finally, a fresh 3D image now starts with its real full Z range while retaining
//     the useful camera angle from the previous well. Session placeholders upgrade
//     to authoritative channel names, physical sizes and bit depth one image at a
//     time before display; pixel-budget eviction does not discard that metadata or
//     reload pixels merely to answer metadata. Eight store-level regression tests
//     cover fresh, saved and legacy placeholder state.
//   1.5.3 — 2026-08-08 — Why 3D was darker than 2D: found, measured, fixed. The
//     texture fed to the 3D view was packed over an auto-contrast window that
//     clips the top 0.1 percent of values — and a maximum-intensity projection
//     displays exactly those values. These acquisitions record a full-scale LUT
//     (0..4095), which is the window 2D opens with, so on the real well the 3D
//     view rendered its brightest structures at 0.18x (CH1) and 0.16x (CH3) of
//     their 2D brightness: five to six times darker, silently. The same clip
//     moving with the downsample is also what made Ultra and Maximum render at
//     different brightnesses — the user's own diagnosis, "does reducing the
//     information also change the brightness?", was the right question.
//     The texture is now packed over the channel's actual data range, so nothing
//     the MIP wants is clipped and the shader's window maths (1.5.1) reproduces
//     the 2D display exactly. Verified on the real well at 512 and at full
//     resolution: brightest-structure agreement 0.994-0.997, the residual being
//     uint8 quantisation. One guard remains: a lone hot pixel detached from the
//     distribution (max > 2x the 99.999th percentile) is treated as noise so it
//     cannot stretch the packing and band everything else.
//     What remains resolution-dependent is real: shrinking averages sub-pixel
//     structures toward their surroundings, in 3D and 2D alike. Maximum quality
//     shows the true brightness, and since 1.5.2 it can no longer kill the app.
//     Getting here took its own fix: the external drive holding the data dropped
//     three times during measurement, so the well is copied to local disk first
//     — loads went from 97 s to 7 s, and the drive stopped being a dependency.
//   1.5.2 — 2026-08-08 — The interactive 3D path stops being able to kill the app,
//     and a whole-tree audit. Two hands worked on this one: a spawned session
//     rebuilt /api/volume-bin to stream plane by plane (the old path expanded
//     each channel to a 1.585 GiB float32 temporary, which is what silently
//     killed the packaged backend on real wells on 2026-08-07), computing the
//     auto window from an accumulated histogram — verified bit-identical to
//     auto_contrast over 300 randomised trials, and the rewritten endpoint was
//     exercised live at 128 and at full resolution before this commit, because
//     it had never actually run in a process.
//     The audit then found and fixed, with reproductions:
//     Concurrent requests double-loaded the same image — measured 4 threads,
//     4 full loads, which on real data is 4 x 4.25 GB for one image. Compare
//     fetches by id without activating, so this was reachable in normal use.
//     A per-reader lock now serialises it: same test, 1 load.
//     Eviction could null the pixels mid-read (intermittent 500s); accessors now
//     take a snapshot — 2.5 million reads raced against 176 unloads, no errors.
//     The images/_lru bookkeeping is under one lock, so a close can no longer
//     disappear an id between the budget's membership check and its unload.
//     A deferred tab that failed to load once was bricked forever ("No image
//     loaded" with no reason) — observed live when the external drive holding
//     the data dropped. Failures now keep the path and every retry reports the
//     real error; remount and it loads.
//     The interactive 3D downsample had no anti-alias prefilter: the 1.3.0 fix
//     (26 of 31 thin 2 px structures vanished at plate resolutions) had only
//     ever been applied to the plate path. The view now shrinks through the
//     same helper as the plate PDF and the export.
//     Smaller: the 3D save refuses Windows-illegal names at entry instead of
//     silently sanitising them; a dead query parameter left over from an
//     abandoned edit is gone; the plate dialog no longer writes to the store
//     during render.
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

export const VERSION = '1.5.6';
