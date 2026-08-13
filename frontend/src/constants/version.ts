// OIR Viewer version.
//
// Format: vX.Y.Z
// Update history (latest first):
//   1.5.16 — 2026-08-14 — Plate PDF pages keep full colour resolution. A 3D
//     crop that is not yet applied refuses to save instead of saving the wrong
//     area, and camera controls stay fixed while editing a crop. Oversized
//     conditions tables are refused before rendering, and source-resolution
//     plate exports use less memory.
//   1.5.15 — 2026-08-13 — Plate Save can export several named channel patterns
//     (for example all channels and CH1+2 only) as separate PDFs in one run.
//   1.5.14 — 2026-08-13 — Crop selections stay aligned between the display and
//     saved output in 2D and 3D. Browser Open accepts selected files, and Plate
//     dialogs stay usable inside the window.
//   1.5.13 — 2026-08-12 — macOS packages follow the standard first-run approval flow.
//   1.5.12 — 2026-08-12 — Crop selects a source-pixel rectangle by mouse or coordinates for
//     2D, projection and 3D export; drag editing is enabled by default and completion fits it.
//     New launches show an empty Welcome screen; explicit Open/Close, per-file settings;
//     checked-tab File Manager close and full-height 3D remain.
//   1.5.11 — 2026-08-11 — The application window and browser tab use the product
//     title consistently.
//   1.5.10 — 2026-08-11 — Image opening reports progress, Plate Save controls stay
//     visible before focus, and the public guide describes the current workflow.
//   1.5.9 — 2026-08-09 — Plate conditions are shown in a separate band above each
//     image and are included in the conditions page.
//   1.5.8 — 2026-08-09 — Sources on exFAT volumes can be opened reliably.
//   1.5.7 — 2026-08-10 — New 3D views use Maximum quality, 0° elevation and a
//     fitted view; scale-bar and Plate Save defaults follow the displayed image.
//   1.5.6 — 2026-08-09 — 3D and Plate Save preserve source/view state and provide
//     clearer output progress and validation.
//   1.5.5 — 2026-08-09 — 3D planning and export use the source dimensions and
//     reject output that cannot be represented safely.
//   1.5.4 — 2026-08-09 — Plate PDF and Z-projection exports validate their targets
//     and preserve the selected image settings.
//   1.5.3 — 2026-08-08 — 3D brightness and downsampling now match the 2D display
//     more closely across quality choices.
//   1.5.2 — 2026-08-08 — 3D rendering is more stable under concurrent loads and
//     retries failed image reads without losing the tab.
//   1.5.1 — 2026-08-07 — 3D Min/Max controls now affect the rendered volume.
//   1.5.0 — 2026-08-07 — All save dialogs accept an explicit filename and refuse
//     existing targets before any output is written.
//   1.4.1 — 2026-08-07 — Large previous sessions load lazily to reduce startup
//     memory use; the current startup behavior is defined by 1.5.12 above.
//   1.4.0 — 2026-08-07 — Plate Save uses each well's displayed settings and offers
//     an editable conditions table.
//   1.3.0 — 2026-08-07 — Plate-to-PDF export supports selectable resolutions,
//     correct plate positions and consistent image proportions.
//   1.2.9 — 2026-08-06 — Plate wells are streamed and memory use is bounded during
//     export.
//   1.2.8 — 2026-08-06 — MATL plate acquisitions can be opened, browsed by well
//     and sent to ordinary image tabs.
//   1.2.7 — 2026-08-06 — Packaged builds include the metadata needed to open .oir
//     files.
//   1.2.6 — 2026-08-06 — Open failures are shown in the main interface with a
//     readable error message.
//   1.2.5 — 2026-08-06 — Backend errors are written to rotating logs accessible
//     from the Help menu.
//   1.2.4 — 2026-08-06 — The app can notify users about newer releases without
//     interrupting image viewing.
//   1.2.3 — 2026-08-06 — The Open picker works in packaged Windows builds and
//     supports companion files without extensions.
//   1.2.2 — 2026-08-06 — Histogram work is reused while adjusting contrast for a
//     more responsive display.
//   1.2.1 — 2026-08-05 — Min/Max sliders keep a stable scale while being dragged.
//   1.2.0 — 2026-08-05 — Contrast controls fit each channel's data range and the
//     shared scale-bar overlay follows the image.
//   1.1.0 — 2026-08-05 — Scale bars are available consistently across 2D, Split,
//     Compare and 3D views, with selectable colour and position.
//   1.0.2 — 2026-08-05 — API failures report the backend response instead of a
//     generic JSON parsing error.
//   1.0.1 — 2026-08-05 — The OS file picker, empty-state Open action and first-run
//     packaging are available across supported platforms.
//   1.0.0 — 2026-08-04 — First numbered release: 2D, Split, Compare and 3D views
//     for common microscopy stacks, channel controls, Z/T navigation, ROI tools,
//     and TIFF/PNG/JPEG plus OME-TIFF export.
//   0.x — pre-release development (unversioned)

export const VERSION = '1.5.16';
