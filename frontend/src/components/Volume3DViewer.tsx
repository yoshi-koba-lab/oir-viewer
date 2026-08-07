import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import * as THREE from 'three';
import { useImageStore } from '../stores/imageStore';
import { useViewStore } from '../stores/viewStore';
import {
  fetchVolumeBin, chooseFolder, saveRender, OverwriteConflict,
  type RenderImagePayload,
} from '../utils/api';
import { stemOf, filenameProblem } from '../utils/paths';
import { OverwriteConfirm } from './SaveDialog';
import {
  SCALEBAR_BLOCK_H,
  drawScalebarAt,
  formatUm,
  niceScaleLength,
  scalebarPlacement,
  type ScalebarPos,
} from '../utils/scalebar';
import { ScalebarOverlay } from './ScalebarOverlay';
import { ScalebarSettings } from './ScalebarSettings';
import { vertexShader, fragmentShader } from '../utils/volumeShader';

/** Vertex shader (GLSL3): pass position to fragment for ray-marching. */

const DEG = Math.PI / 180;
/** The volume box is built to span 0..1 and is kept centred here. */
const CENTER = 0.5;
/** Fixed ray-march sample count. Exposing it as a slider changed nothing a user
 *  could see on these stacks, so it is no longer a control. */
const RAY_STEPS = 200;
// Open looking straight down the optical axis — the same orientation as the 2D
// view, so switching to 3D starts from something the user already recognises.
const DEFAULT_AZ = 0;    // horizontal orbit angle, degrees
const DEFAULT_EL = 0;    // vertical angle above the equator, degrees
/** Sentinel for the "Maximum" quality option — resolved against the GPU's limit. */
const MAX_QUALITY = -1;
/** Ask before loading a volume bigger than this; a GB-scale 3D texture can wedge the tab. */
const HEAVY_VOLUME_MB = 400;
/** The shader samples at most four channels, so only four are ever uploaded. */
const MAX_TEX_CHANNELS = 4;

/** Wrap an azimuth into 0..360 for display. */
const wrapAz = (deg: number) => ((deg % 360) + 360) % 360;
/** Elevation is clamped just short of the poles, where the orbit degenerates. */
const clampEl = (deg: number) => Math.max(-89, Math.min(89, deg));

/** btoa() on a large buffer overflows the argument list, so feed it in chunks. */
function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunk) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunk)));
  }
  return btoa(parts.join(''));
}

/** Round to a 1/2/5 × 10ⁿ length so the bar reads as a round number. */
/**
 * Draw the scale bar into a 2D context, used for both export and preview.
 * The volume fills the canvas, so bottom-left of the canvas *is* bottom-left
 * of the rendered image here.
 */
function drawScalebar(
  ctx: CanvasRenderingContext2D,
  bar: { um: number; px: number },
  canvasW: number,
  canvasH: number,
  color: string,
  pos: ScalebarPos | null,
  scale = 1,
) {
  // Same placement rule as the on-screen overlay, at export resolution, so what
  // was dragged into place is what gets saved.
  const rect = { x: 0, y: 0, w: canvasW, h: canvasH };
  const p = scalebarPlacement(
    rect, pos, canvasW, canvasH, bar.px * scale, SCALEBAR_BLOCK_H * scale, 14 * scale,
  );
  drawScalebarAt(ctx, p.x, p.baseline, bar.px * scale, bar.um, color, scale);
}

export function Volume3DViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  const texturesRef = useRef<THREE.Data3DTexture[]>([]);
  const animIdRef = useRef<number>(0);

  const metadata = useImageStore((s) => s.metadata);
  const channels = useImageStore((s) => s.channels);
  const currentT = useImageStore((s) => s.currentT);
  const activeImageId = useImageStore((s) => s.activeImageId);

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [resolution, setResolution] = useState(512); // max XY dim; 0 = original size
  const [volInfo, setVolInfo] = useState('');
  // maxDimUm is how many µm one world unit spans, which is what turns the
  // perspective projection into a physical scale bar.
  const volumeInfoRef = useRef({ scaleX: 1, scaleY: 1, scaleZ: 1, maxDimUm: 0 });

  // Scale bar. Length/visibility/colour are shared with the other views; only
  // the pixel width is local, since it comes from this camera's distance.
  const [scalebar, setScalebar] = useState<{ um: number; px: number } | null>(null);
  const showScalebar = useViewStore((s) => s.showScalebar);
  const scalebarUm = useViewStore((s) => s.scalebarUm);
  const scalebarColor = useViewStore((s) => s.scalebarColor);
  const scalebarPos = useViewStore((s) => s.scalebarPos);

  // Save options
  const [saveFormat, setSaveFormat] = useState<'png' | 'tiff'>('png');
  const [saveMerge, setSaveMerge] = useState(true);
  const [savePerChannel, setSavePerChannel] = useState(false);
  // null = follow whatever is currently visible; a Set = explicit override.
  const [saveChannels, setSaveChannels] = useState<Set<number> | null>(null);
  const [saveDir, setSaveDir] = useState('');
  /** Name to save under; seeded from the image, always editable. */
  const [saveName, setSaveName] = useState('');
  const [conflict, setConflict] = useState<
    { files: string[]; count: number; more: number } | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [saveErr, setSaveErr] = useState('');
  // Z planes present in the loaded volume, and the sub-range being shown.
  const [volZ, setVolZ] = useState(0);
  const [zRange, setZRange] = useState({ start: 1, end: 1 });
  // A very large request waits for an explicit OK instead of loading straight away.
  const [pendingHeavy, setPendingHeavy] = useState<{ mb: number; dim: number } | null>(null);
  const [approvedRes, setApprovedRes] = useState<number | null>(null);

  // Mouse interaction state
  const isDragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  // Orbit state in degrees. az spins around the image's vertical axis, el lifts
  // the camera above the image plane.
  const orbit = useRef({ az: DEFAULT_AZ, el: DEFAULT_EL, radius: 2.5 });
  // Mirror of the orbit angles, so they can also be typed in.
  const [angles, setAngles] = useState({ az: DEFAULT_AZ, el: DEFAULT_EL });

  /**
   * Size the scale bar for the current camera distance.
   *
   * The bar is only exact at the depth of the volume centre — under perspective
   * anything nearer reads larger — which is the usual convention for a 3D scale
   * bar. Visible height at that depth is 2·d·tan(fov/2) world units, and one
   * world unit spans maxDimUm micrometres.
   */
  const recomputeScalebar = useCallback(() => {
    const cam = cameraRef.current;
    const container = containerRef.current;
    const { maxDimUm } = volumeInfoRef.current;
    if (!cam || !container || !(maxDimUm > 0)) { setScalebar(null); return; }
    const h = container.clientHeight;
    if (h <= 0) { setScalebar(null); return; }
    const worldH = 2 * orbit.current.radius * Math.tan((cam.fov * DEG) / 2);
    const umPerPx = (worldH / h) * maxDimUm;
    // An explicit length wins; otherwise pick a round one near 120 px.
    const requested = useViewStore.getState().scalebarUm;
    const um = requested && requested > 0 ? requested : niceScaleLength(umPerPx * 120);
    const px = um / umPerPx;
    setScalebar(um > 0 && px > 2 ? { um, px } : null);
  }, []);

  const updateCamera = useCallback(() => {
    const cam = cameraRef.current;
    const mesh = meshRef.current;
    if (!cam) return;
    const { az, el, radius } = orbit.current;
    const a = az * DEG;
    const e = el * DEG;
    // az=0, el=0 looks straight down the optical axis, i.e. the familiar XY face
    // from the 2D view. Anchoring the angles to the image planes rather than to
    // three.js's Y-up makes "0°/0°" mean something to a microscopist.
    // Orbiting the centre also matters: pivoting on the world origin put the
    // pivot on a corner of the box and swung the sample out of frame.
    cam.position.set(
      CENTER + radius * Math.cos(e) * Math.sin(a),
      CENTER + radius * Math.sin(e),
      CENTER + radius * Math.cos(e) * Math.cos(a)
    );
    cam.lookAt(CENTER, CENTER, CENTER);
    cam.updateMatrixWorld();

    // Camera position in model space for correct ray-box intersection
    if (materialRef.current) {
      const camLocal = cam.position.clone();
      if (mesh) {
        mesh.updateMatrixWorld();
        const invWorld = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
        camLocal.applyMatrix4(invWorld);
      }
      materialRef.current.uniforms.cameraPos.value.copy(camLocal);
    }
    recomputeScalebar(); // depends on the camera distance
  }, [recomputeScalebar]);

  // A typed-in bar length must take effect without waiting for a camera move.
  useEffect(() => { recomputeScalebar(); }, [scalebarUm, recomputeScalebar]);

  // Initialize Three.js scene
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // preserveDrawingBuffer keeps the last frame readable, which is what lets the
    // save option capture exactly what is on screen.
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000, 1);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100);
    cameraRef.current = camera;

    // Create shader material
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      side: THREE.BackSide, // Render back faces so rays march front-to-back
      transparent: true,
      glslVersion: THREE.GLSL3,
      uniforms: {
        cameraPos: { value: new THREE.Vector3() },
        uVolume0: { value: null },
        uVolume1: { value: null },
        uVolume2: { value: null },
        uVolume3: { value: null },
        uNumChannels: { value: 0 },
        uColors: { value: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 1, 0)] },
        uMins: { value: [0, 0, 0, 0] },
        uMaxs: { value: [1, 1, 1, 1] },
        uVisible: { value: [true, true, true, true] },
        uSteps: { value: RAY_STEPS },
        uZMin: { value: 0.0 },
        uZMax: { value: 1.0 },
        uVolumeScale: { value: new THREE.Vector3(1, 1, 1) },
      },
    });
    materialRef.current = material;

    // Create box geometry as ray-marching bounding volume
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    // Shift geometry so it goes from (0,0,0) to (1,1,1)
    geometry.translate(0.5, 0.5, 0.5);
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    meshRef.current = mesh;

    // Resize handler
    const handleResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      recomputeScalebar(); // px-per-µm depends on the viewport height
    };
    const observer = new ResizeObserver(handleResize);
    observer.observe(container);
    handleResize();

    // Initial camera position
    updateCamera();

    // Animation loop
    const animate = () => {
      animIdRef.current = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animIdRef.current);
      observer.disconnect();
      renderer.dispose();
      geometry.dispose();
      material.dispose();
      container.removeChild(renderer.domElement);
      // Clean up textures
      texturesRef.current.forEach(t => t.dispose());
      texturesRef.current = [];
    };
  }, [updateCamera, recomputeScalebar]);

  // Load volume data when image or resolution changes
  useEffect(() => {
    if (!metadata || !activeImageId) return;
    if (metadata.num_z <= 1) return;

    let cancelled = false;
    setLoading(true);
    setLoadError('');

    (async () => {
      try {
        // "Maximum" asks the server for the original size, but a 3D texture is
        // hard-capped by the driver (commonly 2048) and by VRAM, so clamp the
        // request to what this GPU can actually hold rather than failing later.
        let requested = resolution;
        const gl = rendererRef.current?.getContext() as WebGL2RenderingContext | undefined;
        const glMax3D = gl ? gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number : 2048;
        const biggestXY = Math.max(metadata.width, metadata.height);
        if (requested === MAX_QUALITY) {
          requested = biggestXY > glMax3D ? glMax3D : 0; // 0 = no downsampling
        }

        // Estimate the upload before committing to it.
        const outXY = requested === 0 ? biggestXY : Math.min(requested, biggestXY);
        const shrink = outXY / biggestXY;
        const outZ = requested === 0 ? metadata.num_z : Math.min(metadata.num_z, 128);
        const chCount = Math.min(metadata.num_channels, MAX_TEX_CHANNELS);
        const estMB = (metadata.width * shrink) * (metadata.height * shrink) * outZ * chCount / 1048576;

        if (estMB > HEAVY_VOLUME_MB && approvedRes !== resolution) {
          setPendingHeavy({ mb: Math.round(estMB), dim: outXY });
          setLoading(false);
          return;
        }
        setPendingHeavy(null);

        const vol = await fetchVolumeBin(currentT, activeImageId, requested, MAX_TEX_CHANNELS);
        if (cancelled) return;

        const { numZ: num_z, height, width, channels: volChannels, originalShape: original_shape } = vol;

        // Dispose old textures
        texturesRef.current.forEach(t => t.dispose());
        texturesRef.current = [];

        const mat = materialRef.current;
        if (!mat) return;

        // Create 3D textures for each channel (up to 4) — uint8 data
        const numCh = Math.min(volChannels.length, MAX_TEX_CHANNELS);
        for (let c = 0; c < numCh; c++) {
          const u8 = volChannels[c].data;

          const texture = new THREE.Data3DTexture(u8, width, height, num_z);
          texture.format = THREE.RedFormat;
          texture.type = THREE.UnsignedByteType;
          texture.internalFormat = 'R8';
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;
          texture.wrapS = THREE.ClampToEdgeWrapping;
          texture.wrapT = THREE.ClampToEdgeWrapping;
          texture.wrapR = THREE.ClampToEdgeWrapping;
          texture.needsUpdate = true;

          texturesRef.current.push(texture);
          mat.uniforms[`uVolume${c}`].value = texture;
        }

        mat.uniforms.uNumChannels.value = numCh;

        // Compute volume aspect ratio based on ORIGINAL pixel sizes
        const origZ = original_shape[1];
        const origH = original_shape[2];
        const origW = original_shape[3];
        const px = metadata.pixel_size_x || 1;
        const py = metadata.pixel_size_y || 1;
        const pz = metadata.pixel_size_z || 1;
        const physW = origW * px;
        const physH = origH * py;
        const physZ = origZ * pz;
        const maxDim = Math.max(physW, physH, physZ);
        const scaleX = physW / maxDim;
        const scaleY = physH / maxDim;
        const scaleZ = physZ / maxDim;

        volumeInfoRef.current = { scaleX, scaleY, scaleZ, maxDimUm: maxDim };

        // Physical proportions only — the Z exaggeration slider is gone.
        if (meshRef.current) {
          meshRef.current.scale.set(scaleX, scaleY, scaleZ);
          meshRef.current.position.set(
            (1 - scaleX) * 0.5,
            (1 - scaleY) * 0.5,
            (1 - scaleZ) * 0.5
          );
        }
        mat.uniforms.uVolumeScale.value.set(scaleX, scaleY, scaleZ);
        updateCamera(); // model-space camera depends on the mesh matrix

        setVolZ(num_z);
        // A slab this image was already set up with wins over the default; only
        // an image being seen for the first time gets the whole stack. Without
        // this, coming back to a well to check it silently widened its Z range
        // and the export no longer matched what had been decided.
        {
          const store = useImageStore.getState();
          const saved = store.activeImageId
            ? store.imageViewStates[store.activeImageId]?.volume3D
            : undefined;
          const range = saved
            ? {
                start: Math.max(1, Math.min(num_z, saved.zStart)),
                end: Math.max(1, Math.min(num_z, saved.zEnd)),
              }
            : { start: 1, end: num_z };
          if (range.end < range.start) range.end = range.start;
          setZRange(range);
          store.setVolume3D({ zStart: range.start, zEnd: range.end, zTotal: num_z });
        }

        // Info string
        const mb = ((numCh * num_z * height * width) / 1048576).toFixed(1);
        const full = width >= original_shape[3] ? ' 原寸' : '';
        setVolInfo(`${width}x${height}x${num_z} (${mb} MB)${full}`);
        setLoading(false);
      } catch (err) {
        console.error('Failed to load volume:', err);
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load volume');
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [metadata, activeImageId, currentT, resolution, approvedRes]);

  // Update channel colors/visibility uniforms
  // Note: volume data is pre-contrasted to uint8 on backend, so min=0 max=1
  useEffect(() => {
    const mat = materialRef.current;
    if (!mat) return;

    const colors: THREE.Vector3[] = [];
    const mins: number[] = [];
    const maxs: number[] = [];
    const visible: boolean[] = [];

    for (let i = 0; i < 4; i++) {
      if (i < channels.length) {
        const ch = channels[i];
        colors.push(new THREE.Vector3(ch.color[0] / 255, ch.color[1] / 255, ch.color[2] / 255));
        mins.push(0);
        maxs.push(1);
        visible.push(ch.visible);
      } else {
        colors.push(new THREE.Vector3(1, 1, 1));
        mins.push(0);
        maxs.push(1);
        visible.push(false);
      }
    }

    mat.uniforms.uColors.value = colors;
    mat.uniforms.uMins.value = mins;
    mat.uniforms.uMaxs.value = maxs;
    mat.uniforms.uVisible.value = visible;
  }, [channels]);

  // Push the visible Z slab to the shader. Plane n covers [n-1, n]/volZ in
  // normalised texture Z, so the selected 1-based inclusive range maps to
  // (start-1)/volZ .. end/volZ.
  useEffect(() => {
    const mat = materialRef.current;
    if (!mat || volZ <= 0) return;
    mat.uniforms.uZMin.value = Math.max(0, (zRange.start - 1) / volZ);
    mat.uniforms.uZMax.value = Math.min(1, zRange.end / volZ);
  }, [zRange, volZ]);

  // Mouse handlers for orbit control
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
  }, []);

  // Keep the slab non-empty: moving one end past the other drags the other with it.
  const setZStart = useCallback((v: number) => {
    if (Number.isNaN(v)) return;
    setZRange((r) => {
      const start = Math.max(1, Math.min(volZ, Math.round(v)));
      const next = { start, end: Math.max(start, r.end) };
      useImageStore.getState().setVolume3D({ zStart: next.start, zEnd: next.end, zTotal: volZ });
      return next;
    });
  }, [volZ]);

  const setZEnd = useCallback((v: number) => {
    if (Number.isNaN(v)) return;
    setZRange((r) => {
      const end = Math.max(1, Math.min(volZ, Math.round(v)));
      const next = { start: Math.min(end, r.start), end };
      useImageStore.getState().setVolume3D({ zStart: next.start, zEnd: next.end, zTotal: volZ });
      return next;
    });
  }, [volZ]);

  /** Point the camera at the given angles (degrees) and keep the inputs in step. */
  const applyAngles = useCallback((az: number, el: number) => {
    const a = wrapAz(az);
    const e = clampEl(el);
    orbit.current.az = a;
    orbit.current.el = e;
    setAngles({ az: Math.round(a * 10) / 10, el: Math.round(e * 10) / 10 });
    // Recorded per image, so the angle survives switching wells and the plate
    // export renders the view that was actually set up. Written on every change
    // rather than on gesture end: a zustand set is cheap next to the re-render
    // this already does, and there is no "gesture end" for a typed angle.
    useImageStore.getState().setVolume3D({ az: a, el: e, radius: orbit.current.radius });
    updateCamera();
  }, [updateCamera]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging.current) return;
      // End the gesture when the button is no longer held, not on mouseleave:
      // the scale bar overlays the canvas, so crossing it fires mouseleave and
      // used to abort a pan that was still in progress. This also covers a
      // release that happens outside the canvas, which is what mouseleave was
      // really there for.
      if (e.buttons === 0) { isDragging.current = false; return; }
    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    applyAngles(orbit.current.az - dx * 0.5, orbit.current.el + dy * 0.5);
  }, [applyAngles]);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  /**
   * Grab one frame as raw RGBA at the canvas's device resolution.
   *
   * Renders synchronously with the requested channel mask so the capture is not
   * at the mercy of the animation loop, burns in the scale bar when it is shown,
   * then restores the mask and re-renders so the live view is untouched.
   */
  const captureFrame = useCallback((name: string, mask: boolean[] | null): RenderImagePayload | null => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const cam = cameraRef.current;
    const mat = materialRef.current;
    if (!renderer || !scene || !cam || !mat) return null;

    const uVisible = mat.uniforms.uVisible.value as boolean[];
    const prev = uVisible.slice();
    if (mask) mat.uniforms.uVisible.value = mask;
    try {
      renderer.render(scene, cam);
      const src = renderer.domElement;
      const w = src.width;
      const h = src.height;
      if (w <= 0 || h <= 0) return null;

      const flat = document.createElement('canvas');
      flat.width = w;
      flat.height = h;
      const ctx = flat.getContext('2d');
      if (!ctx) return null;
      // The volume is composited over black; keep that as the export background.
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(src, 0, 0);
      if (showScalebar && scalebar) {
        drawScalebar(ctx, scalebar, w, h, scalebarColor, scalebarPos, src.clientWidth > 0 ? w / src.clientWidth : 1);
      }
      const bytes = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer);
      return { name, width: w, height: h, data_b64: bytesToBase64(bytes) };
    } finally {
      mat.uniforms.uVisible.value = prev;
      renderer.render(scene, cam);
    }
  }, [showScalebar, scalebar, scalebarColor, scalebarPos]);

  /** Channels the save will use: an explicit pick, else whatever is visible now. */
  const saveChannelIndices = useMemo(() => {
    const mat = materialRef.current;
    const limit = Math.min(channels.length, (mat?.uniforms.uNumChannels.value as number) || channels.length, 4);
    const pool = Array.from({ length: limit }, (_, i) => i);
    if (saveChannels) return pool.filter((i) => saveChannels.has(i));
    return pool.filter((i) => channels[i]?.visible);
  }, [channels, saveChannels, volInfo]); // volInfo changes when a volume finishes loading

  const handleSave = useCallback(async (overwrite = false) => {
    setSaveErr('');
    setSaveMsg('');
    if (!metadata) return;
    if (!saveMerge && !savePerChannel) {
      setSaveErr('MERGE か CH別 のどちらかを選んでください');
      return;
    }
    const picks = saveChannelIndices;
    if (picks.length === 0) {
      setSaveErr('保存するチャンネルがありません');
      return;
    }

    setSaving(true);
    try {
      let dir = saveDir;
      if (!dir) {
        const chosen = await chooseFolder();
        if (chosen.cancelled || !chosen.path) { setSaving(false); return; }
        dir = chosen.path;
        setSaveDir(dir);
      }

      const limit = 4;
      const images: RenderImagePayload[] = [];
      if (saveMerge) {
        const mask = Array.from({ length: limit }, (_, i) => picks.includes(i));
        const f = captureFrame('merge', mask);
        if (f) images.push(f);
      }
      if (savePerChannel) {
        for (const i of picks) {
          const mask = Array.from({ length: limit }, (_, k) => k === i);
          const label = metadata.channel_names[i] || `Ch${i + 1}`;
          const f = captureFrame(label, mask);
          if (f) images.push(f);
        }
      }
      if (images.length === 0) throw new Error('画面の取得に失敗しました');

      const res = await saveRender({
        output_dir: dir,
        basename: saveName.trim() || stemOf(metadata.filename),
        format: saveFormat,
        images,
        overwrite,
      });
      setSaveMsg(`${res.saved.length} 件保存: ${res.output_dir}`);
    } catch (e) {
      // Nothing was written; this is a question about replacing files.
      if (e instanceof OverwriteConflict) {
        setConflict({ files: e.files, count: e.count, more: e.more });
      } else {
        setSaveErr(e instanceof Error ? e.message : '保存に失敗しました');
      }
    } finally {
      setSaving(false);
    }
    // saveName belongs here: without it this closure keeps the name from the
    // render it was created in, so typing one and pressing save wrote the old
    // one — the exact thing the field exists to control.
  }, [metadata, saveMerge, savePerChannel, saveChannelIndices, saveDir, saveFormat,
      saveName, captureFrame]);

  // Wheel zoom is bound natively with { passive: false }: React routes onWheel
  // through a passive root listener, so preventDefault() there is ignored and the
  // scroll leaks to the page instead of zooming the volume.
  //
  // Bound on the whole viewer rather than the canvas host, so a wheel over the
  // scale bar still zooms; the controls panel is excluded because scrolling it
  // must scroll it, not the volume.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement | null)?.closest('[data-3d-controls]')) return;
      e.preventDefault();
      const r = orbit.current.radius * (e.deltaY > 0 ? 1.1 : 0.9);
      orbit.current.radius = Math.max(0.5, Math.min(10, r));
      useImageStore.getState().setVolume3D({ radius: orbit.current.radius });
      updateCamera();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [updateCamera]);

  const resetCamera = useCallback(() => {
    orbit.current.radius = 2.5;
    applyAngles(DEFAULT_AZ, DEFAULT_EL);   // also records the reset radius
  }, [applyAngles]);

  /**
   * Adopt this image's stored angle when the active image changes.
   *
   * An image with no stored state keeps whatever angle is set rather than
   * snapping back: a plate figure wants every well seen from the same
   * direction, so carrying the angle to the next well is the useful default.
   * The Z slab is per-volume and is handled where the volume loads.
   */
  useEffect(() => {
    if (!activeImageId) return;
    const v = useImageStore.getState().volume3D;
    orbit.current.az = v.az;
    orbit.current.el = v.el;
    orbit.current.radius = v.radius;
    setAngles({ az: Math.round(v.az * 10) / 10, el: Math.round(v.el * 10) / 10 });
    updateCamera();
    // updateCamera is intentionally not a dependency: including it re-runs this
    // on every camera change and fights the drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeImageId]);

  if (!metadata || metadata.num_z <= 1) {
    return (
      <div className="flex-1 flex items-center justify-center bg-black text-[var(--text-secondary)]">
        <p>3D view requires Z-stack data (num_z &gt; 1)</p>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative flex-1 overflow-hidden bg-black">
      {/* 3D Canvas */}
      <div
        ref={containerRef}
        className="w-full h-full cursor-grab active:cursor-grabbing"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      />

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 pointer-events-none">
          <div className="text-white text-sm animate-pulse">Loading 3D volume...</div>
        </div>
      )}

      {/* Error overlay */}
      {loadError && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="bg-red-900/80 rounded-lg p-4 max-w-md text-center">
            <p className="text-white text-sm font-bold mb-2">3D Loading Error</p>
            <p className="text-white/80 text-xs mb-3">{loadError}</p>
            <button
              onClick={() => { setLoadError(''); setResolution(Math.max(64, resolution - 64)); }}
              className="px-3 py-1 rounded bg-[var(--accent)] text-white text-xs hover:opacity-90"
            >
              Retry with lower resolution ({Math.max(64, resolution - 64)}px)
            </button>
          </div>
        </div>
      )}

      {/* 3D Controls Panel */}
      <div data-3d-controls className="absolute top-12 right-2 bg-black/70 rounded-lg p-3 flex flex-col gap-2 text-xs text-white/80 w-[230px]">
        <div className="font-bold text-white text-center mb-1">3D Controls</div>

        {/* Resolution */}
        <div className="flex items-center gap-2">
          <span className="w-16">Quality:</span>
          <select
            value={resolution}
            onChange={(e) => setResolution(Number(e.target.value))}
            className="flex-1 bg-black/60 border border-white/20 rounded px-1 py-0.5 text-xs"
          >
            <option value={128}>Low (128)</option>
            <option value={256}>Medium (256)</option>
            <option value={384}>High (384)</option>
            <option value={512}>Ultra (512)</option>
            <option value={MAX_QUALITY}>Maximum (原寸)</option>
          </select>
        </div>

        {/* Guard for GB-scale volumes: confirm before uploading to the GPU */}
        {pendingHeavy && (
          <div className="rounded border border-amber-500/60 bg-amber-500/10 p-2 space-y-1.5">
            <p className="text-[10px] leading-relaxed text-amber-200">
              約 {pendingHeavy.mb} MB（{pendingHeavy.dim}px 相当）になります。
              GPU の 3D テクスチャ上限に合わせて縮小済みですが、読み込みに時間がかかります。
            </p>
            <button
              onClick={() => setApprovedRes(resolution)}
              className="w-full px-2 py-1 rounded bg-amber-500 text-black text-[10px] font-bold hover:opacity-90 transition"
            >
              この容量で読み込む
            </button>
          </div>
        )}

        {/* Z sub-range: clipped in the shader, so it applies instantly with no refetch */}
        {volZ > 1 && (
          <div className="pt-1 border-t border-white/10 space-y-1.5">
            <div className="flex items-center justify-between">
              <span>Z範囲:</span>
              <span className="text-white/50">
                {zRange.end - zRange.start + 1} / {volZ} 枚
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-10 text-white/60">開始</span>
              <input
                type="number"
                min={1}
                max={volZ}
                value={zRange.start}
                onChange={(e) => setZStart(Number(e.target.value))}
                className="w-14 bg-black/60 border border-white/20 rounded px-1 py-0.5 text-xs text-right tabular-nums"
              />
              <input
                type="range"
                min={1}
                max={volZ}
                value={zRange.start}
                onChange={(e) => setZStart(Number(e.target.value))}
                className="flex-1 min-w-0"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-10 text-white/60">終了</span>
              <input
                type="number"
                min={1}
                max={volZ}
                value={zRange.end}
                onChange={(e) => setZEnd(Number(e.target.value))}
                className="w-14 bg-black/60 border border-white/20 rounded px-1 py-0.5 text-xs text-right tabular-nums"
              />
              <input
                type="range"
                min={1}
                max={volZ}
                value={zRange.end}
                onChange={(e) => setZEnd(Number(e.target.value))}
                className="flex-1 min-w-0"
              />
            </div>
            <button
              onClick={() => {
                setZRange({ start: 1, end: volZ });
                useImageStore.getState().setVolume3D({ zStart: 1, zEnd: volZ, zTotal: volZ });
              }}
              className="w-full px-1 py-0.5 rounded bg-white/10 hover:bg-white/20 text-[10px] transition"
            >
              全範囲
            </button>
          </div>
        )}

        {/* Orbit angles — typeable, and kept in step with mouse dragging */}
        <div className="pt-1 border-t border-white/10 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="w-16">横 (Y軸):</span>
            <input
              type="number"
              step={5}
              value={angles.az}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isNaN(v)) applyAngles(v, angles.el);
              }}
              className="w-16 bg-black/60 border border-white/20 rounded px-1 py-0.5 text-xs text-right tabular-nums"
              title="水平方向の回転角（0–360°）"
            />
            <span className="text-white/40">°</span>
            <input
              type="range"
              min={0}
              max={360}
              step={1}
              value={angles.az}
              onChange={(e) => applyAngles(Number(e.target.value), angles.el)}
              className="flex-1 min-w-0"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-16">縦 (仰角):</span>
            <input
              type="number"
              step={5}
              value={angles.el}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isNaN(v)) applyAngles(angles.az, v);
              }}
              className="w-16 bg-black/60 border border-white/20 rounded px-1 py-0.5 text-xs text-right tabular-nums"
              title="上下方向の角度（-89–89°、0=真横、90=真上）"
            />
            <span className="text-white/40">°</span>
            <input
              type="range"
              min={-89}
              max={89}
              step={1}
              value={angles.el}
              onChange={(e) => applyAngles(angles.az, Number(e.target.value))}
              className="flex-1 min-w-0"
            />
          </div>
          <div className="flex gap-1">
            {[
              // Named after the plane you end up facing, which is unambiguous
              // for a stack: XY is the familiar 2D view down the optical axis.
              { label: 'XY面', az: 0, el: 0, title: '光軸方向（2D表示と同じ向き）' },
              { label: 'YZ面', az: 90, el: 0, title: '横から見た断面' },
              { label: 'XZ面', az: 0, el: 89, title: '上から見た断面' },
            ].map((p) => (
              <button
                key={p.label}
                onClick={() => applyAngles(p.az, p.el)}
                title={p.title}
                className="flex-1 px-1 py-0.5 rounded bg-white/10 hover:bg-white/20 text-[10px] transition"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Scale bar: on/off, length, colour — the same controls as the 2D view */}
        <div className="pt-1 border-t border-white/10">
          <ScalebarSettings compact />
          {showScalebar && (
            <div className="text-right text-white/40 font-mono text-[10px] mt-1">
              現在: {scalebar ? formatUm(scalebar.um) : '—'}
            </div>
          )}
        </div>

        {/* Save the current view */}
        <div className="pt-1 border-t border-white/10 space-y-1.5">
          <div className="font-bold text-white/90">保存</div>

          <div className="flex items-center gap-2">
            <span className="w-16">形式:</span>
            <select
              value={saveFormat}
              onChange={(e) => setSaveFormat(e.target.value as 'png' | 'tiff')}
              className="flex-1 bg-black/60 border border-white/20 rounded px-1 py-0.5 text-xs"
            >
              <option value="png">PNG</option>
              <option value="tiff">TIFF</option>
            </select>
          </div>

          <div className="flex gap-3">
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={saveMerge}
                onChange={(e) => setSaveMerge(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              <span>MERGE</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={savePerChannel}
                onChange={(e) => setSavePerChannel(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              <span>CH別</span>
            </label>
          </div>

          {/* Channel picker. Untouched, it follows the channels currently shown. */}
          <div className="space-y-0.5">
            <div className="flex items-center justify-between text-white/50 text-[10px]">
              <span>CH{saveChannels ? '（指定中）' : '（表示中に追従）'}</span>
              {saveChannels && (
                <button
                  onClick={() => setSaveChannels(null)}
                  className="underline hover:text-white/80"
                >
                  解除
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              {channels.slice(0, 4).map((ch, i) => {
                const on = saveChannelIndices.includes(i);
                return (
                  <button
                    key={i}
                    onClick={() => {
                      const next = new Set(saveChannelIndices);
                      if (next.has(i)) next.delete(i); else next.add(i);
                      setSaveChannels(next);
                    }}
                    title={metadata.channel_names[i] || `Ch${i + 1}`}
                    className={`px-1.5 py-0.5 rounded text-[10px] border transition ${
                      on ? 'text-black font-bold' : 'text-white/50 border-white/20'
                    }`}
                    style={on ? { backgroundColor: `rgb(${ch.color.join(',')})`, borderColor: `rgb(${ch.color.join(',')})` } : undefined}
                  >
                    {metadata.channel_names[i] || `CH${i + 1}`}
                  </button>
                );
              })}
            </div>
          </div>

          {saveDir && (
            <div className="text-[10px] text-white/40 truncate" title={saveDir}>
              保存先: {saveDir}
            </div>
          )}

          <div>
            <input
              type="text"
              value={saveName}
              onChange={(e) => { setSaveName(e.target.value); setConflict(null); }}
              placeholder={stemOf(metadata.filename)}
              className="w-full px-2 py-1 rounded bg-black/40 border border-white/20
                         text-[11px] text-white placeholder:text-white/30
                         focus:outline-none focus:border-[var(--accent)]"
            />
            {filenameProblem(saveName || stemOf(metadata.filename)) && (
              <div className="text-[10px] text-red-400 mt-0.5">
                {filenameProblem(saveName || stemOf(metadata.filename))}
              </div>
            )}
          </div>

          <button
            onClick={() => handleSave(false)}
            disabled={saving || !!conflict}
            className="w-full px-2 py-1 rounded bg-[var(--accent)] text-white text-xs hover:opacity-90 disabled:opacity-50 transition"
          >
            {saving ? '保存中…' : '名前を付けて保存'}
          </button>
          {saveDir && (
            <button
              onClick={() => setSaveDir('')}
              className="w-full px-2 py-0.5 rounded bg-white/10 text-[10px] hover:bg-white/20 transition"
            >
              保存先を選び直す
            </button>
          )}
          {saveMsg && <div className="text-[10px] text-green-400 break-all">{saveMsg}</div>}
          {saveErr && <div className="text-[10px] text-red-400 break-all">{saveErr}</div>}
        </div>

        {/* Volume info */}
        {volInfo && (
          <div className="text-[10px] text-white/40 text-center">{volInfo}</div>
        )}

        {/* Reset Camera */}
        <button
          onClick={resetCamera}
          className="mt-1 px-2 py-1 rounded bg-[var(--accent)] text-white text-xs hover:opacity-90 transition"
        >
          Reset View
        </button>
      </div>

      {/* Info overlay */}
      <div className="absolute top-2 left-2 text-xs font-mono text-white/60 bg-black/40 px-2 py-1 rounded pointer-events-none">
        {metadata.filename} | 3D Volume | {metadata.width}&times;{metadata.height}&times;{metadata.num_z}
        {metadata.pixel_size_z > 0 && ` | Z step: ${metadata.pixel_size_z.toFixed(2)} um`}
      </div>

      {/* Help */}
      <div className="absolute bottom-2 left-2 text-[10px] text-white/40 pointer-events-none">
        Drag: rotate | Scroll: zoom | Double-click: reset
      </div>

      {/* Scale bar (burned into saved images by captureFrame at the same spot).
          No geometry: the volume render fills the canvas, so the canvas is the
          image here. Rendered after the readouts so a bar dragged into a corner
          stays visible and grabbable instead of disappearing under them. */}
      <ScalebarOverlay metrics={scalebar} pad={14} />

      {conflict && (
        <OverwriteConfirm
          conflict={conflict}
          busy={saving}
          onCancel={() => setConflict(null)}
          onConfirm={() => handleSave(true)}
        />
      )}
    </div>
  );
}
