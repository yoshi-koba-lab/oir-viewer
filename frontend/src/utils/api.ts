const BASE = '';

/**
 * Read a JSON response, turning every failure mode into a message that says what
 * actually went wrong.
 *
 * Calling res.json() directly is a trap: when the backend is not running, the
 * dev proxy answers with an empty-bodied 500 and the user sees
 * "Failed to execute 'json' on 'Response': Unexpected end of JSON input" —
 * which describes the parser, not the problem.
 */
/**
 * Message for a failed response, whatever its body turns out to be.
 * Also used by the binary endpoints, whose error bodies are JSON but whose
 * success bodies are not.
 */
export async function describeHttpError(res: Response, what: string): Promise<string> {
  let text = '';
  try { text = await res.text(); } catch { /* body already consumed or absent */ }

  // FastAPI errors carry {"error": ...} or {"detail": ...}; a dead backend
  // behind the dev proxy carries nothing at all.
  let detail = '';
  if (text) {
    try {
      const body = JSON.parse(text);
      detail = body.error || body.detail || '';
    } catch {
      detail = text.slice(0, 200);
    }
  }
  if (!detail) {
    detail = res.status >= 500
      ? 'バックエンドに接続できません（サーバーが起動しているか確認してください）'
      : `HTTP ${res.status}`;
  }
  return `${what}: ${detail}`;
}

async function readJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(await describeHttpError(res, what));

  const text = await res.text();

  if (!text) throw new Error(`${what}: サーバーが空の応答を返しました`);
  try {
    return JSON.parse(text) as T;
  } catch {
    // Most likely index.html: the request fell through to the static handler,
    // i.e. this build's backend does not have that route.
    throw new Error(`${what}: サーバーの応答が JSON ではありません（API が古い可能性があります）`);
  }
}

/** GET a JSON endpoint with legible failures. */
async function getJson<T>(path: string, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`);
  } catch (e) {
    throw new Error(`${what}: サーバーに到達できません（${e instanceof Error ? e.message : e}）`);
  }
  return readJson<T>(res, what);
}

/** POST JSON and read JSON back, with the same error handling. */
async function postJson<T>(path: string, body: unknown, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`${what}: サーバーに到達できません（${e instanceof Error ? e.message : e}）`);
  }
  return readJson<T>(res, what);
}

export interface ImageMetadata {
  id?: string;
  filename: string;
  source_path: string;
  num_channels: number;
  num_z: number;
  num_t: number;
  width: number;
  height: number;
  pixel_size_x: number;
  pixel_size_y: number;
  pixel_size_z: number;
  channel_names: string[];
  channel_types: string[];  // "fluorescence" | "transmitted"
  channel_colors: number[][];  // [[R,G,B], ...] from file, empty array = use default
  // Display range recorded at acquisition, per channel, in pixel values.
  // Empty when the file carries none — then auto-contrast is used instead.
  channel_ranges?: number[][];
  bit_depth: number;
  // Non-fatal problem detected while opening (e.g. a split .oir missing chunks).
  warning?: string;
}

export interface ImageListItem {
  id: string;
  filename: string;
  num_channels: number;
  num_z: number;
  num_t: number;
  width: number;
  height: number;
  active: boolean;
}

export interface ChannelData {
  channel: number;
  data_b64: string;
  auto_min: number;
  auto_max: number;
}

export interface AllChannelsResponse {
  width: number;
  height: number;
  channels: ChannelData[];
}

export interface HistogramData {
  counts: number[];
  bin_edges: number[];
  auto_min: number;
  auto_max: number;
}

export interface ProfileData {
  distances: number[];
  intensities: number[];
  distance_unit?: string;
}

export interface MeasureData {
  area_pixels: number;
  area_um2: number;
  mean: number;
  std: number;
  min: number;
  max: number;
}

export async function listImages(): Promise<ImageListItem[]> {
  return getJson<ImageListItem[]>('/api/images', '画像一覧の取得に失敗');
}

export async function activateImage(id: string): Promise<ImageMetadata> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/images/${id}/activate`, { method: 'POST' });
  } catch (e) {
    throw new Error(`画像の切り替えに失敗: サーバーに到達できません（${e instanceof Error ? e.message : e}）`);
  }
  return readJson<ImageMetadata>(res, '画像の切り替えに失敗');
}

export async function closeImage(id: string): Promise<{ closed: string; active_id: string | null }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/images/${id}`, { method: 'DELETE' });
  } catch (e) {
    throw new Error(`画像を閉じられません: サーバーに到達できません（${e instanceof Error ? e.message : e}）`);
  }
  return readJson(res, '画像を閉じられません');
}

export async function uploadFile(file: File): Promise<ImageMetadata> {
  const form = new FormData();
  form.append('file', file);
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/upload`, { method: 'POST', body: form });
  } catch (e) {
    throw new Error(`ファイルの読み込みに失敗: サーバーに到達できません（${e instanceof Error ? e.message : e}）`);
  }
  return readJson<ImageMetadata>(res, 'ファイルの読み込みに失敗');
}

export async function openFile(path: string): Promise<ImageMetadata> {
  return getJson<ImageMetadata>(`/api/open?path=${encodeURIComponent(path)}`, 'ファイルを開けません');
}

export async function fetchMetadata(id?: string): Promise<ImageMetadata> {
  const q = id ? `?id=${id}` : '';
  return getJson<ImageMetadata>(`/api/metadata${q}`, 'メタデータの取得に失敗');
}

export interface FetchChannelsOpts {
  z: number;
  t: number;
  mip?: boolean;
  proj?: boolean;
  projMethod?: string;
  projZFrom?: number;
  projZTo?: number;
  id?: string;
}

export async function fetchAllChannels(opts: FetchChannelsOpts): Promise<AllChannelsResponse>;
export async function fetchAllChannels(z: number, t: number, mip: boolean, id?: string): Promise<AllChannelsResponse>;
export async function fetchAllChannels(
  zOrOpts: number | FetchChannelsOpts, t?: number, mip?: boolean, id?: string
): Promise<AllChannelsResponse> {
  let url: string;
  if (typeof zOrOpts === 'object') {
    const o = zOrOpts;
    const params = new URLSearchParams();
    params.set('z', String(o.z));
    params.set('t', String(o.t));
    if (o.mip) params.set('mip', 'true');
    if (o.proj) {
      params.set('proj', 'true');
      if (o.projMethod) params.set('proj_method', o.projMethod);
      if (o.projZFrom !== undefined) params.set('proj_z_from', String(o.projZFrom));
      if (o.projZTo !== undefined) params.set('proj_z_to', String(o.projZTo));
    }
    if (o.id) params.set('id', o.id);
    url = `${BASE}/api/image/all-channels?${params}`;
  } else {
    const idQ = id ? `&id=${id}` : '';
    url = `${BASE}/api/image/all-channels?z=${zOrOpts}&t=${t}&mip=${mip}${idQ}`;
  }
  return readJson<AllChannelsResponse>(await fetch(url), 'チャンネルデータの取得に失敗');
}

/** A channel decoded straight from the binary endpoint (no base64). */
export interface DecodedChannel {
  channel: number;
  data: Uint16Array;
  auto_min: number;
  auto_max: number;
}

export interface AllChannelsBinResponse {
  width: number;
  height: number;
  channels: DecodedChannel[];
}

function buildChannelParams(o: FetchChannelsOpts): URLSearchParams {
  const params = new URLSearchParams();
  params.set('z', String(o.z));
  params.set('t', String(o.t));
  if (o.mip) params.set('mip', 'true');
  if (o.proj) {
    params.set('proj', 'true');
    if (o.projMethod) params.set('proj_method', o.projMethod);
    if (o.projZFrom !== undefined) params.set('proj_z_from', String(o.projZFrom));
    if (o.projZTo !== undefined) params.set('proj_z_to', String(o.projZTo));
  }
  if (o.id) params.set('id', o.id);
  return params;
}

/**
 * Fetch all channels as a single binary buffer and decode without base64.
 * Layout (little-endian): u32 width, u32 height, u32 nc,
 * nc×(i32 min, i32 max), then nc×(width*height u16) pixel planes.
 * Pixel arrays are zero-copy views onto the response buffer.
 */
export async function fetchAllChannelsBin(opts: FetchChannelsOpts): Promise<AllChannelsBinResponse> {
  const res = await fetch(`${BASE}/api/image/all-channels-bin?${buildChannelParams(opts)}`);
  if (!res.ok) {
    throw new Error(await describeHttpError(res, 'チャンネルデータの取得に失敗'));
  }
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);
  const width = dv.getUint32(0, true);
  const height = dv.getUint32(4, true);
  const nc = dv.getUint32(8, true);

  let off = 12;
  const levels: Array<[number, number]> = [];
  for (let c = 0; c < nc; c++) {
    levels.push([dv.getInt32(off, true), dv.getInt32(off + 4, true)]);
    off += 8;
  }

  const planeLen = width * height;
  const channels: DecodedChannel[] = [];
  for (let c = 0; c < nc; c++) {
    // off is always even (header 12 + nc*8, planes 2*planeLen) → valid Uint16 view
    const data = new Uint16Array(buf, off, planeLen);
    off += planeLen * 2;
    channels.push({ channel: c, data, auto_min: levels[c][0], auto_max: levels[c][1] });
  }
  return { width, height, channels };
}

export async function fetchHistogram(c: number, z: number, t: number): Promise<HistogramData> {
  return getJson<HistogramData>(`/api/histogram?c=${c}&z=${z}&t=${t}`, 'ヒストグラムの取得に失敗');
}

export async function fetchProfile(body: {
  c: number; z: number; t: number;
  x0: number; y0: number; x1: number; y1: number; width?: number;
}): Promise<ProfileData> {
  return postJson<ProfileData>('/api/roi/profile', body, 'プロファイルの取得に失敗');
}

export async function fetchMeasure(body: {
  c: number; z: number; t: number;
  roi_type: string; params: Record<string, unknown>;
}): Promise<MeasureData> {
  return postJson<MeasureData>('/api/roi/measure', body, 'ROI の測定に失敗');
}

export interface ChooseFolderResponse {
  path: string | null;
  cancelled: boolean;
}

export interface ChooseFilesResponse {
  paths: string[];
  cancelled: boolean;
}

/**
 * The desktop shell's file pickers, when running inside it (see desktop/preload.js).
 *
 * The packaged backend cannot open a dialog: PyInstaller makes `sys.executable`
 * the app itself, so its subprocess call launched a second backend and blocked
 * for 300 s — the Windows "Opening…" hang. Electron owns a real native dialog on
 * every platform, so ask it first and only fall back to the HTTP endpoint when
 * there is no shell (a plain browser in dev, or --no-webview).
 */
interface ElectronAPI {
  chooseFiles(): Promise<ChooseFilesResponse>;
  chooseFolder(): Promise<ChooseFolderResponse>;
}

function shell(): ElectronAPI | null {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI ?? null;
}

/** Open the OS file picker and return the chosen image paths. */
export async function chooseFiles(): Promise<ChooseFilesResponse> {
  const api = shell();
  if (api) return api.chooseFiles();
  return getJson<ChooseFilesResponse>('/api/choose-files', 'ファイル選択ダイアログを開けません');
}

export async function chooseFolder(): Promise<ChooseFolderResponse> {
  const api = shell();
  if (api) return api.chooseFolder();
  return getJson<ChooseFolderResponse>('/api/choose-folder', 'フォルダ選択ダイアログを開けません');
}

export interface SaveRequest {
  output_dir: string;
  image_ids: string[];
  channels: number[];
  channel_colors: number[][];
  channel_mins: number[];
  channel_maxs: number[];
  format: string;
  save_separate: boolean;
  save_merge: boolean;
  z_mode: 'current' | 'range' | 'projection';
  z_from: number;
  z_to: number;
  image_z_ranges: Record<string, [number, number]>;
  projection_method: 'max' | 'min' | 'avg';
  t_from: number;
  t_to: number;
  current_z: number;
  current_t: number;
  bit_depth_output: string;
}

export interface SaveResponse {
  saved: string[];
  output_dir: string;
}

export async function saveImages(req: SaveRequest): Promise<SaveResponse> {
  return postJson<SaveResponse>('/api/save', req, '保存に失敗');
}

export interface ProjectionRequest {
  image_ids: string[];
  method: string;
  z_from: number;
  z_to: number;
  t: number;
  output_dir: string;
}

export interface ProjectionResultItem {
  id: string;
  path: string;
  filename: string;
  metadata: ImageMetadata;
}

export async function applyProjection(req: ProjectionRequest): Promise<{ results: ProjectionResultItem[] }> {
  return postJson<{ results: ProjectionResultItem[] }>('/api/projection', req, '投影の作成に失敗');
}

export function decodeUint16(b64: string, width: number, height: number): Uint16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Uint16Array(bytes.buffer, 0, width * height);
}

/* ---- Saving already-rendered frames (3D view) ---- */

export interface RenderImagePayload {
  name: string;      // filename suffix, e.g. "merge" or a channel name
  width: number;
  height: number;
  data_b64: string;  // raw RGBA8, row-major, top row first
}

export interface SaveRenderRequest {
  output_dir: string;
  basename: string;
  format: 'png' | 'tiff';
  images: RenderImagePayload[];
}

export async function saveRender(req: SaveRenderRequest): Promise<SaveResponse> {
  return postJson<SaveResponse>('/api/save-render', req, '画像の保存に失敗');
}

/* ---- Volume data for 3D rendering ---- */

export interface VolumeChannel {
  channel: number;
  data_b64: string;
  auto_min: number;
  auto_max: number;
}

export interface VolumeResponse {
  num_channels: number;
  num_z: number;
  height: number;
  width: number;
  original_shape: number[];  // [C, Z, H, W]
  channels: VolumeChannel[];
}

export async function fetchVolume(t: number = 0, id?: string, maxDim: number = 256): Promise<VolumeResponse> {
  const params = new URLSearchParams({ t: String(t), max_dim: String(maxDim) });
  if (id) params.set('id', id);
  return readJson<VolumeResponse>(await fetch(`${BASE}/api/volume?${params}`), 'ボリュームの取得に失敗');
}

export interface VolumeBinResponse {
  numChannels: number;
  numZ: number;
  height: number;
  width: number;
  originalShape: [number, number, number, number]; // [C, Z, H, W]
  channels: Array<{ data: Uint8Array; autoMin: number; autoMax: number }>;
}

/**
 * Fetch the 3D volume as one binary blob. The JSON/base64 route inflates the
 * payload by a third and has to be parsed as a single huge string, which fails
 * outright near a gigabyte — i.e. exactly at full resolution.
 * `maxDim <= 0` asks for the original size; `maxCh` caps how many channels are
 * transferred, since the renderer only samples four.
 */
export async function fetchVolumeBin(
  t: number,
  id: string | undefined,
  maxDim: number,
  maxCh = 4,
): Promise<VolumeBinResponse> {
  const params = new URLSearchParams({ t: String(t), max_dim: String(maxDim), max_ch: String(maxCh) });
  if (id) params.set('id', id);
  const res = await fetch(`${BASE}/api/volume-bin?${params}`);
  if (!res.ok) {
    throw new Error(await describeHttpError(res, 'ボリュームの取得に失敗'));
  }
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);
  const numChannels = dv.getUint32(0, true);
  const numZ = dv.getUint32(4, true);
  const height = dv.getUint32(8, true);
  const width = dv.getUint32(12, true);
  const originalShape: [number, number, number, number] = [
    dv.getUint32(16, true), dv.getUint32(20, true), dv.getUint32(24, true), dv.getUint32(28, true),
  ];

  let off = 32;
  const levels: Array<[number, number]> = [];
  for (let c = 0; c < numChannels; c++) {
    levels.push([dv.getInt32(off, true), dv.getInt32(off + 4, true)]);
    off += 8;
  }

  const planeLen = numZ * height * width;
  const channels = [];
  for (let c = 0; c < numChannels; c++) {
    channels.push({
      data: new Uint8Array(buf, off, planeLen),
      autoMin: levels[c][0],
      autoMax: levels[c][1],
    });
    off += planeLen;
  }
  return { numChannels, numZ, height, width, originalShape, channels };
}

/** Decode base64 to Uint8Array for 3D volume (backend sends uint8). */
export function decodeUint8Volume(b64: string, totalVoxels: number): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.slice(0, totalVoxels);
}

export interface UpdateCheck {
  update_available: boolean;
  latest: string | null;
  url: string;
  /** False when the check could not reach GitHub at all — offline, proxy, rate limit. */
  checked: boolean;
}

/**
 * Ask whether a newer release exists. Never throws: an update check that
 * interrupts the user to say it could not run is worse than one that says
 * nothing, so a failure is reported as "no update".
 */
export async function checkForUpdate(current: string): Promise<UpdateCheck> {
  try {
    return await getJson<UpdateCheck>(
      `/api/update-check?current=${encodeURIComponent(current)}`,
      'アップデート確認',
    );
  } catch {
    return { update_available: false, latest: null, url: '', checked: false };
  }
}

export interface PlateWell {
  well_id: string;
  row: number;
  col: number;
  enabled: boolean;
  tiles: number;
  tile_grid: string;
  /** null when the microscope's stitched file for this well is not on disk. */
  stitch_path: string | null;
  stitch_bytes: number;
  chunk_count: number;
  /** Set when the well label and the stage coordinates disagree. */
  position_warning: string;
}

export interface PlateScan {
  name: string;
  rows: number;
  cols: number;
  source: string;
  matl_sha256: string;
  warnings: string[];
  wells: PlateWell[];
}

/** Volume resolutions for plate export. 0 = source resolution, no downscale. */
export const PLATE_XY_CHOICES: { key: string; label: string; maxXy: number }[] = [
  { key: 'low', label: 'Low (128)', maxXy: 128 },
  { key: 'medium', label: 'Medium (256)', maxXy: 256 },
  { key: 'high', label: 'High (512)', maxXy: 512 },
  { key: 'ultra', label: 'Ultra (1024)', maxXy: 1024 },
  { key: 'max', label: 'Max (原寸)', maxXy: 0 },
];

/** Raster size of one well in the PDF. The page grows with it rather than upscaling. */
export const PDF_CELL_CHOICES: { key: string; label: string; px: number }[] = [
  { key: 'draft', label: 'Draft (300px)', px: 300 },
  { key: 'normal', label: 'Normal (600px)', px: 600 },
  { key: 'high', label: 'High (1200px)', px: 1200 },
  { key: 'max', label: 'Max (2000px)', px: 2000 },
];

/** Read a MATL acquisition folder (or its .omp2info) into a plate manifest. */
export async function scanPlate(path: string): Promise<PlateScan> {
  return getJson<PlateScan>(
    `/api/plate/scan?path=${encodeURIComponent(path)}`,
    'プレート情報を読めません',
  );
}

export interface PlateVolumeRequest {
  path: string;
  channels: number[];
  /** [[min, max], ...] aligned with `channels`. Required: never auto-stretched. */
  levels: [number, number][];
  t?: number;
  /** Max XY; 0 for the source resolution. */
  max_xy?: number;
}

/** One well's volume as the binary layout plateRender.parseVolume expects. */
/** The decoded X-Plate-Volume header: what the backend actually produced. */
export interface PlateVolumeInfo {
  channels: number[];
  /** [z, h, w] of the returned volume. */
  out: [number, number, number];
  /** The XY cap applied; 0 means the source resolution. */
  max_xy: number;
  /** [n_c, n_z, h, w] of the source, before any downscale. */
  source: [number, number, number, number];
  bytes: number;
  /** µm per voxel [x, y, z]; a zero means the file did not record it. */
  voxel: [number, number, number];
}

export interface PlateVolume {
  data: ArrayBuffer;
  info: PlateVolumeInfo | null;
}

export async function fetchPlateVolume(
  req: PlateVolumeRequest,
  signal?: AbortSignal,
): Promise<PlateVolume> {
  let res: Response;
  try {
    res = await fetch('/api/plate/volume-bin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal,
    });
  } catch (e) {
    // An abort is the caller's own doing; let it through as itself so the export
    // can tell "the user stopped this" from "the read failed".
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    // Otherwise this is the backend dying mid-run, which bare fetch reports as
    // "Failed to fetch" — the one message in this file that says nothing.
    throw new Error(
      'ウェルの読み込みに失敗: バックエンドに接続できません。'
      + 'アプリを再起動してください。',
    );
  }
  if (!res.ok) throw new Error(await describeHttpError(res, 'ウェルの読み込みに失敗'));
  let info: PlateVolumeInfo | null = null;
  try {
    const raw = res.headers.get('X-Plate-Volume');
    if (raw) info = JSON.parse(raw) as PlateVolumeInfo;
  } catch {
    // Only carries voxel size and provenance; the volume itself is still usable.
    info = null;
  }
  return { data: await res.arrayBuffer(), info };
}

export interface PlatePdfResult {
  path: string;
  wells: number;
  bytes: number;
}

export async function composePlatePdf(body: {
  plate_name: string;
  rows: number;
  cols: number;
  frames: {
    well_id: string; row: number; col: number; png_b64: string;
    /** Lines printed over the top-left of this well's image. */
    caption?: string[];
  }[];
  /**
   * Why each empty cell is empty: 'disabled', 'excluded' (imaged but not
   * selected) or 'missing' (imaged but no stitched file). A well_id that is
   * absent was never imaged. Consulted only for cells with no frame.
   */
  well_states: Record<string, string>;
  cell_px: number;
  output_dir: string;
  footer: string;
  /** Conditions table, written as a second page of the same PDF. */
  table_headers?: string[];
  table_rows?: string[][];
}): Promise<PlatePdfResult> {
  return postJson<PlatePdfResult>('/api/plate/pdf', body, 'PDF の作成に失敗');
}
