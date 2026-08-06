import * as THREE from 'three';
import { vertexShader, fragmentShader } from './volumeShader';
import { volumeTooLarge } from './gpuLimits';

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
}

export interface VolumePayload {
  numChannels: number;
  numZ: number;
  height: number;
  width: number;
  /** One R8 plane stack per channel, already windowed by the backend. */
  channels: Uint8Array[];
}

/** Parse the binary layout /api/plate/volume-bin returns. */
export function parseVolume(buf: ArrayBuffer): VolumePayload {
  const head = new Uint32Array(buf, 0, 8);
  const [nc, nz, h, w] = [head[0], head[1], head[2], head[3]];
  const perCh = nz * h * w;
  let off = 32 + nc * 8; // header + per-channel int32 level pairs
  const channels: Uint8Array[] = [];
  for (let c = 0; c < nc; c++) {
    channels.push(new Uint8Array(buf, off, perCh));
    off += perCh;
  }
  return { numChannels: nc, numZ: nz, height: h, width: w, channels };
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

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
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
    radius: number,
    zRange: [number, number],
  ): Promise<RenderedWell> {
    const tooBig = volumeTooLarge(vol.width, vol.height, vol.numZ, vol.numChannels);
    if (tooBig) throw new Error(tooBig);

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
    if (this.renderer.getContext().isContextLost()) {
      throw new Error(
        `${wellId}: 描画中に GPU コンテキストが失われました。`
        + '解像度を下げて再実行してください（このウェル以降は描画されていません）。',
      );
    }

    const blob = await new Promise<Blob | null>((res) =>
      (this.renderer.domElement as HTMLCanvasElement).toBlob(res, 'image/png'),
    );
    if (!blob) throw new Error(`${wellId}: フレームを取得できませんでした`);
    return { wellId, png: new Uint8Array(await blob.arrayBuffer()) };
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
