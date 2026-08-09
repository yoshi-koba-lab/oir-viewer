import * as THREE from 'three';
import {
  VOLUME_CAMERA_FOV_DEG, vertexShader, fragmentShader,
} from './volumeShader';
import { volumeTooLarge } from './gpuLimits';
import type { PlateVolumeInfo } from './api';
import {
  SCALEBAR_BLOCK_H,
  drawScalebarAt,
  formatUm,
  scalebarMetrics,
  scalebarPlacement,
} from './scalebar';
import {
  resolveVolumeCameraZoom,
  volumePhysicalGeometry,
  type VolumePhysicalGeometry,
} from './threeDCamera';

/**
 * Renders volumes one at a time, off-screen, for plate export.
 *
 * Its own renderer and its own canvas: the interactive 3D view keeps its state
 * (camera, textures, Z range) while a plate export runs, and neither can disturb
 * the other. The same shaders are used, so a well in the PDF is shaded exactly as
 * the same well would look on screen.
 *
 * Textures are disposed between wells and the renderer is disposed at the end.
 * GPU memory is not garbage collected on a schedule anyone can rely on, and eight
 * undisposed volumes is how a run dies on the last well.
 */
export interface RenderedWell {
  wellId: string;
  /** PNG bytes of the rendered frame. */
  png: Uint8Array;
  /** Fit-relative zoom that was actually used, after safety validation. */
  zoomPercent: number;
  /** Physical scale printed into the frame, or null when it was disabled. */
  scalebarUm: number | null;
}

export interface PlateScalebarOptions {
  enabled: boolean;
  /** Null chooses a round physical length independently for each well. */
  requestedUm: number | null;
  color: string;
}

export interface PlateScalebarPlan {
  um: number;
  px: number;
  x: number;
  baseline: number;
  /** Scale for the label and strokes at the selected PDF cell resolution. */
  visualScale: number;
}

/** Plan a calibrated, uncropped bottom-left scale bar without touching WebGL. */
export function planPlateScalebar(
  wellId: string,
  size: number,
  cameraRadius: number,
  maxDimensionUm: number,
  requestedUm: number | null,
): PlateScalebarPlan {
  if (!(size > 0) || !(cameraRadius > 0) || !(maxDimensionUm > 0)
      || ![size, cameraRadius, maxDimensionUm].every(Number.isFinite)) {
    throw new Error(`${wellId}: voxel sizeからスケールバーを計算できません。PDF は作成していません。`);
  }
  const fovRad = VOLUME_CAMERA_FOV_DEG * Math.PI / 180;
  const worldHeight = 2 * cameraRadius * Math.tan(fovRad / 2);
  const umPerPixel = worldHeight * maxDimensionUm / size;
  // 600 px is the normal PDF cell size. Keep the label and strokes visually
  // proportional at every export resolution, while retaining a readable label
  // at the 300 px compact setting.
  const visualScale = Math.min(4, Math.max(0.75, size / 600));
  const pad = Math.round(15 * visualScale);
  const metrics = scalebarMetrics(
    umPerPixel,
    1,
    requestedUm,
    Math.max(40, size * 0.2),
    Math.max(8, size * 0.55),
  );
  if (!metrics) {
    throw new Error(`${wellId}: voxel sizeからスケールバーを計算できません。PDF は作成していません。`);
  }
  if (metrics.px > size - 2 * pad) {
    throw new Error(
      `${wellId}: 指定したスケールバー ${formatUm(metrics.um)} は画像内に収まりません。`
      + '長さまたは拡大率を変更してください。PDF は作成していません。',
    );
  }
  const place = scalebarPlacement(
    { x: 0, y: 0, w: size, h: size },
    null,
    size,
    size,
    metrics.px,
    SCALEBAR_BLOCK_H * visualScale,
    pad,
  );
  return {
    um: metrics.um,
    px: metrics.px,
    x: place.x,
    baseline: place.baseline,
    visualScale,
  };
}

export interface VolumePayload {
  numChannels: number;
  numZ: number;
  height: number;
  width: number;
  /** One R8 plane stack per channel, already windowed by the backend. */
  channels: Uint8Array[];
  /** Source-sized aspect plus physical calibration for camera fit and scale. */
  geometry: VolumePhysicalGeometry;
}

/**
 * Parse the binary layout /api/plate/volume-bin returns.
 *
 * `info` is the decoded X-Plate-Volume header. Its `voxel` is µm per voxel of
 * the SOURCE, so the physical extent uses the source shape, not the downscaled
 * one — a 23x XY reduction does not make the sample squatter.
 */
export function parseVolume(buf: ArrayBuffer, info: PlateVolumeInfo): VolumePayload {
  const head = new Uint32Array(buf, 0, 8);
  const [nc, nz, h, w] = [head[0], head[1], head[2], head[3]];
  const perCh = nz * h * w;
  let off = 32 + nc * 8; // header + per-channel int32 level pairs
  const channels: Uint8Array[] = [];
  for (let c = 0; c < nc; c++) {
    channels.push(new Uint8Array(buf, off, perCh));
    off += perCh;
  }
  const vx = info.voxel;
  const src = info.source;                       // [n_c, n_z, h, w] of the source
  const geometry = volumePhysicalGeometry(src[3], src[2], src[1], vx[0], vx[1], vx[2]);
  return { numChannels: nc, numZ: nz, height: h, width: w, channels, geometry };
}

export class PlateRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private material: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private textures: THREE.Data3DTexture[] = [];

  constructor(size: number) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        // Needed to read the frame back after render(); without it the buffer may
        // already have been cleared by the time toBlob runs.
        preserveDrawingBuffer: true,
      });
    } catch (e) {
      // three.js throws a bare "Error creating WebGL context", which tells the
      // user nothing they can act on. Most often this is a machine with no GPU
      // acceleration available to the app at all.
      throw new Error(
        '3D 描画を初期化できませんでした（WebGL2 が使えません）。'
        + `GPU ドライバか、ハードウェアアクセラレーションの設定を確認してください。[${
          e instanceof Error ? e.message : String(e)}]`,
      );
    }
    this.renderer.setSize(size, size, false);
    this.renderer.setClearColor(0x000000, 1);

    this.camera = new THREE.PerspectiveCamera(VOLUME_CAMERA_FOV_DEG, 1, 0.01, 100);
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        uVolume0: { value: null }, uVolume1: { value: null },
        uVolume2: { value: null }, uVolume3: { value: null },
        uNumChannels: { value: 0 },
        uColors: { value: Array.from({ length: 4 }, () => new THREE.Vector3(1, 1, 1)) },
        uMins: { value: [0, 0, 0, 0] },
        uMaxs: { value: [1, 1, 1, 1] },
        uVisible: { value: [true, true, true, true] },
        uSteps: { value: 200 },
        uZMin: { value: 0 }, uZMax: { value: 1 },
        cameraPos: { value: new THREE.Vector3() },
      },
      side: THREE.BackSide,
      transparent: false,
    });
    // The shader intersects a box spanning 0..1 in LOCAL space, so the geometry
    // is translated rather than the mesh moved: positioning the mesh instead
    // leaves local coordinates at -0.5..0.5 and the volume renders off-centre and
    // clipped. This matches Volume3DViewer exactly, which is the point.
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.translate(0.5, 0.5, 0.5);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.scene.add(this.mesh);
  }

  /** Free the previous well's textures before the next one is uploaded. */
  private releaseTextures() {
    for (const t of this.textures) t.dispose();
    this.textures = [];
    for (const k of ['uVolume0', 'uVolume1', 'uVolume2', 'uVolume3'] as const) {
      this.material.uniforms[k].value = null;
    }
  }

  /**
   * Render one volume and return its frame as PNG.
   *
   * `colors` and `visible` come from the channel setup the user has on screen;
   * the window was already applied server-side, so the shader's own min/max stay
   * at 0..1 — plate export must not restretch anything.
   */
  async render(
    wellId: string,
    vol: VolumePayload,
    colors: [number, number, number][],
    visible: boolean[],
    az: number,
    el: number,
    requestedZoomPercent: number,
    zRange: [number, number],
    scalebar: PlateScalebarOptions,
  ): Promise<RenderedWell> {
    const tooBig = volumeTooLarge(vol.width, vol.height, vol.numZ, vol.numChannels);
    if (tooBig) throw new Error(tooBig);

    // Shape the box like the sample, exactly as Volume3DViewer does. A confocal
    // stack is normally anisotropic — a 0.2 µm XY, 2 µm Z acquisition is 10:1 —
    // and rendering it as a cube stretches Z tenfold. Without this the PDF is
    // the one view of the data with the wrong proportions, which is worse than
    // no PDF, because it still looks like a result.
    const {
      scaleX: sx,
      scaleY: sy,
      scaleZ: sz,
      maxDimUm,
      calibrated,
    } = vol.geometry;
    this.mesh.scale.set(sx, sy, sz);
    // Keep the box centred on 0.5 so the camera framing does not shift with it.
    this.mesh.position.set((1 - sx) * 0.5, (1 - sy) * 0.5, (1 - sz) * 0.5);

    // Resolve the same fit-relative zoom as the interactive viewer. A Plate
    // export is square, so its fit radius is recomputed for this canvas rather
    // than reusing a radius measured in a differently-shaped app window.
    const cameraZoom = resolveVolumeCameraZoom({
      scaleX: sx,
      scaleY: sy,
      scaleZ: sz,
      azDeg: az,
      elDeg: el,
      fovDeg: VOLUME_CAMERA_FOV_DEG,
      aspect: 1,
      near: this.camera.near,
    }, requestedZoomPercent);
    if (Math.abs(cameraZoom.zoomPercent - requestedZoomPercent) > 0.05) {
      throw new Error(
        `${wellId}: 拡大率 ${requestedZoomPercent.toFixed(1)}% では視点がボリューム内に入ります。`
        + `安全な上限は ${cameraZoom.maxZoomPercent.toFixed(1)}% です。PDF は作成していません。`,
      );
    }

    this.releaseTextures();
    const n = Math.min(vol.numChannels, 4);
    for (let c = 0; c < n; c++) {
      const tex = new THREE.Data3DTexture(vol.channels[c], vol.width, vol.height, vol.numZ);
      tex.format = THREE.RedFormat;
      tex.type = THREE.UnsignedByteType;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      this.textures.push(tex);
      this.material.uniforms[`uVolume${c}` as 'uVolume0'].value = tex;
      (this.material.uniforms.uColors.value as THREE.Vector3[])[c].set(
        colors[c][0] / 255, colors[c][1] / 255, colors[c][2] / 255,
      );
      (this.material.uniforms.uVisible.value as boolean[])[c] = visible[c] ?? true;
      (this.material.uniforms.uMins.value as number[])[c] = 0;
      (this.material.uniforms.uMaxs.value as number[])[c] = 1;
    }
    this.material.uniforms.uNumChannels.value = n;
    this.material.uniforms.uZMin.value = zRange[0];
    this.material.uniforms.uZMax.value = zRange[1];

    // Same convention as the interactive view: az=0, el=0 looks down the optical
    // axis, so a plate figure matches what the user set up there.
    const DEG = Math.PI / 180;
    const a = az * DEG, e = el * DEG;
    const radius = cameraZoom.radius;
    this.camera.position.set(
      0.5 + radius * Math.cos(e) * Math.sin(a),
      0.5 + radius * Math.sin(e),
      0.5 + radius * Math.cos(e) * Math.cos(a),
    );
    this.camera.lookAt(0.5, 0.5, 0.5);
    this.camera.updateMatrixWorld();
    this.mesh.updateMatrixWorld();
    const camLocal = this.camera.position.clone()
      .applyMatrix4(new THREE.Matrix4().copy(this.mesh.matrixWorld).invert());
    (this.material.uniforms.cameraPos.value as THREE.Vector3).copy(camLocal);

    this.renderer.render(this.scene, this.camera);

    // A lost context does not throw. It keeps accepting draw calls and keeps
    // handing back a canvas — a black one. Unchecked, that black frame is
    // indistinguishable from a well with no signal, and it would be written into
    // the PDF as data. A driver reset or GPU memory pressure part-way through a
    // long export is exactly when this happens, so it is checked every well.
    const gl = this.renderer.getContext();
    const glErrors: number[] = [];
    for (let i = 0; i < 16; i++) {
      const code = gl.getError();
      if (code === gl.NO_ERROR) break;
      glErrors.push(code);
    }
    if (gl.isContextLost() || glErrors.length > 0) {
      throw new Error(
        `${wellId}: 3D描画をGPU上で検証できませんでした`
        + `${glErrors.length ? `（WebGL ${glErrors.join(', ')}）` : '（context lost）'}。`
        + '解像度を下げて再実行してください（このウェル以降は描画されていません）。',
      );
    }

    // Copy the verified WebGL frame to a 2D canvas. The physical scale bar must
    // be burned into the PNG itself, inside the lower-left of the well image;
    // drawing it later in the PDF compositor would lose the camera calibration.
    const src = this.renderer.domElement as HTMLCanvasElement;
    const flat = document.createElement('canvas');
    flat.width = src.width;
    flat.height = src.height;
    const ctx = flat.getContext('2d');
    if (!ctx || flat.width <= 0 || flat.height <= 0) {
      throw new Error(`${wellId}: 保存画像のキャンバスを作成できませんでした`);
    }
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, flat.width, flat.height);
    ctx.drawImage(src, 0, 0);

    let scalebarUm: number | null = null;
    if (scalebar.enabled) {
      if (!calibrated) {
        throw new Error(
          `${wellId}: 全軸のvoxel sizeがないため正しいスケールバーを作成できません。`
          + 'PDF は作成していません。',
        );
      }
      // One world unit spans maxDim µm. The pure planner applies the same
      // centre-depth perspective calibration as the interactive 3D viewer.
      const plan = planPlateScalebar(
        wellId, flat.height, radius, maxDimUm, scalebar.requestedUm,
      );
      drawScalebarAt(
        ctx,
        plan.x,
        plan.baseline,
        plan.px,
        plan.um,
        scalebar.color,
        plan.visualScale,
      );
      scalebarUm = plan.um;
    }

    const blob = await new Promise<Blob | null>((res) => flat.toBlob(res, 'image/png'));
    if (!blob) throw new Error(`${wellId}: フレームを取得できませんでした`);
    return {
      wellId,
      png: new Uint8Array(await blob.arrayBuffer()),
      zoomPercent: cameraZoom.zoomPercent,
      scalebarUm,
    };
  }

  dispose() {
    this.releaseTextures();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
    // Chromium keeps a limited number of live WebGL contexts; a run that forgot
    // to give one back would starve the interactive view later in the session.
    this.renderer.forceContextLoss();
  }
}
