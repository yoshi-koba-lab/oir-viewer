/**
 * What this GPU will actually accept as a 3D texture.
 *
 * Plate export has no server-side resolution ceiling, so this is where a volume
 * that cannot be rendered gets caught. MAX_3D_TEXTURE_SIZE is 2048 on some GPUs
 * and 16384 on others, so the answer is per-machine and can only be asked here —
 * and it must be asked, because exceeding it makes texImage3D fail with a bare
 * INVALID_VALUE that says nothing about which dimension was too large.
 *
 * Electron is Chromium, so this applies to the desktop build exactly as it does
 * in a browser.
 */

export interface GpuLimits {
  max3D: number;
  /** Bytes of texture the run would need, for reporting rather than enforcement. */
  vendor: string;
}

let cached: GpuLimits | null = null;

export function gpuLimits(): GpuLimits {
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  if (!gl) {
    // No WebGL2 means no volume rendering at all; report a limit of 0 so the
    // caller explains that rather than failing at upload.
    cached = { max3D: 0, vendor: 'WebGL2 未対応' };
    return cached;
  }
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  cached = {
    max3D: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number,
    vendor: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown',
  };
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return cached;
}

/**
 * Why a volume of this shape cannot be rendered here, or null if it can.
 *
 * Checks each dimension separately: the failure is almost always one axis of a
 * stitched image being wider than the limit while Z is nowhere near it, and
 * saying which one is the difference between a fixable message and a shrug.
 */
export function volumeTooLarge(
  w: number,
  h: number,
  z: number,
  channels: number,
): string | null {
  const { max3D, vendor } = gpuLimits();
  if (max3D === 0) return 'この環境では WebGL2 が使えないため 3D 表示ができません。';
  const over = ([['幅', w], ['高さ', h], ['Z', z]] as const).filter(([, v]) => v > max3D);
  if (over.length === 0) return null;
  const mb = Math.round((w * h * z * channels) / 1048576);
  return (
    `この GPU が扱える 3D テクスチャの上限は ${max3D} です。` +
    over.map(([n, v]) => `${n} ${v}`).join('、') +
    ` が超えています（${vendor}）。\n` +
    `解像度を下げてください。この設定では 1 ウェルあたり約 ${mb} MB になります。`
  );
}
