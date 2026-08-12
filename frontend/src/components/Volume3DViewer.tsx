import { useRef, useEffect, useCallback, useState } from 'react';
import * as THREE from 'three';
import { useImageStore } from '../stores/imageStore';
import { useOperationStore } from '../stores/operationStore';
import {
  cropOwnerForMetadata,
  sameCropOwner,
  useViewStore,
} from '../stores/viewStore';
import { cropRectForCapture } from '../utils/crop';
import {
  fetchVolumeBin, fetchVolumeMemoryPlan,
  chooseFolder, saveRender, OverwriteConflict,
  VolumeMemoryEpochChangedError,
  type RenderImagePayload,
} from '../utils/api';
import { imageOperationIsBusy, reloadActiveChannelData } from '../hooks/useImageLoader';
import { resetSettings } from '../utils/settingsStore';
import { stemOf, filenameProblem } from '../utils/paths';
import { OverwriteConfirm } from './SaveDialog';
import {
  SCALEBAR_BLOCK_H,
  drawScalebarAt,
  formatUm,
  niceScaleLength,
  planCroppedScalebar,
  scalebarLabelWidth,
  scalebarPlacement,
  type ScalebarPos,
} from '../utils/scalebar';
import { ScalebarOverlay } from './ScalebarOverlay';
import { ScalebarSettings } from './ScalebarSettings';
import { CropOverlay } from './CropOverlay';
import {
  VOLUME_CAMERA_FOV_DEG, vertexShader, fragmentShader,
} from '../utils/volumeShader';
import {
  volume3DCameraForMount,
  volume3DForResampledVolume,
} from '../utils/volume3DState';
import {
  MIN_VOLUME_ZOOM_PERCENT,
  resolveVolumeCameraZoom,
  volumeCameraCropFit,
  volumePhysicalGeometry,
} from '../utils/threeDCamera';
import {
  completedSavePercent,
  ownsThreeDSaveCrop,
  ThreeDSaveGuard,
  type ThreeDSaveCropOwner,
  type ThreeDSaveCropRect,
  type ThreeDSaveSnapshot,
} from '../utils/threeDSave';

/** Vertex shader (GLSL3): pass position to fragment for ray-marching. */

const DEG = Math.PI / 180;
/** The volume box is built to span 0..1 and is kept centred here. */
const CENTER = 0.5;
/** Fixed ray-march sample count. Exposing it as a slider changed nothing a user
 *  could see on these stacks, so it is no longer a control. */
const RAY_STEPS = 200;
/** Sentinel for the "Maximum" quality option — resolved against the GPU's limit. */
const MAX_QUALITY = -1;
/** The shader samples at most four channels, so only four are ever uploaded. */
const MAX_TEX_CHANNELS = 4;

/** Read every queued WebGL error without risking an infinite driver loop. */
function drainWebGLErrors(gl: WebGL2RenderingContext): number[] {
  const errors: number[] = [];
  for (let i = 0; i < 32; i++) {
    const error = gl.getError();
    if (error === gl.NO_ERROR) break;
    errors.push(error);
  }
  return errors;
}

/** Read the active source and crop as one synchronous save provenance record. */
function currentThreeDSaveCrop(): {
  cropRect: ThreeDSaveCropRect | null;
  cropOwner: ThreeDSaveCropOwner;
} {
  const image = useImageStore.getState();
  const metadata = image.metadata;
  const view = useViewStore.getState();
  const metadataOwner = cropOwnerForMetadata(image.activeImageId, metadata);
  if (view.cropRect && !sameCropOwner(view.cropOwner, metadataOwner)) {
    throw new Error(
      'クロップ範囲が現在の画像ソースに紐付いていないため、3D保存を中止しました。'
      + '「全体に戻す」で解除してから再実行してください。',
    );
  }
  const owner = metadataOwner;
  return {
    cropRect: view.cropRect ? { ...view.cropRect } : null,
    cropOwner: {
      imageId: owner?.imageId ?? null,
      sourceIdentity: owner?.sourceIdentity ?? null,
      sourceRevision: owner?.sourceRevision ?? null,
      width: owner?.width ?? 0,
      height: owner?.height ?? 0,
    },
  };
}

function assertThreeDSaveCrop(snapshot: ThreeDSaveSnapshot): void {
  const current = currentThreeDSaveCrop();
  if (!ownsThreeDSaveCrop(snapshot, current.cropRect, current.cropOwner)) {
    throw new Error(
      '保存中に画像ソースまたはクロップ範囲が変更されたため、3D保存を中止しました。'
      + '何も保存していません。',
    );
  }
}

interface LoadedVolumeProvenance {
  runId: number;
  imageId: string;
  sourceIdentity: string;
  sourceRevision: string;
  currentT: number;
  selectedResolution: number;
  planKey: string;
  numChannels: number;
  numZ: number;
}

interface SaveProgress {
  percent: number;
  label: string;
}

interface DisplayCropFit {
  ownerKey: string;
  rect: ThreeDSaveCropRect;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  target: [number, number, number];
  scaleX: number;
  scaleY: number;
  scaleZ: number;
}

function sameThreeDSaveCropRect(
  a: ThreeDSaveCropRect | null,
  b: ThreeDSaveCropRect | null,
): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y
    && a.width === b.width && a.height === b.height;
}

/** A fitted canvas already contains the selected source area. */
function displayCropMatchesSnapshot(
  fit: DisplayCropFit | null,
  snapshot: ThreeDSaveSnapshot,
): boolean {
  const owner = snapshot.cropOwner;
  const ownerKey = [
    owner.imageId, owner.sourceIdentity, owner.sourceRevision,
    owner.width, owner.height,
  ].join('|');
  return !!fit && !!snapshot.cropRect
    && fit.ownerKey === ownerKey
    && sameThreeDSaveCropRect(fit.rect, snapshot.cropRect);
}

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

/** Let React paint a completed save phase before starting the next one. */
const nextPaint = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

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
    rect,
    pos,
    canvasW,
    canvasH,
    Math.max(bar.px * scale, scalebarLabelWidth(bar.um, scale)),
    SCALEBAR_BLOCK_H * scale,
    14 * scale,
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
  const metadataRef = useRef(metadata);
  metadataRef.current = metadata;
  const channels = useImageStore((s) => s.channels);
  const currentT = useImageStore((s) => s.currentT);
  const activeImageId = useImageStore((s) => s.activeImageId);
  const sourceViewDefaults = useImageStore((s) => s.sourceViewDefaults);
  const resetActiveImageToSource = useImageStore((s) => s.resetActiveImageToSource);
  const setGlobalLoadError = useImageStore((s) => s.setLoadError);
  const hasPhysicalScale = !!metadata
    && [metadata.pixel_size_x, metadata.pixel_size_y, metadata.pixel_size_z]
      .every((value) => Number.isFinite(value) && value > 0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [resolution, setResolution] = useState(MAX_QUALITY);
  const [volInfo, setVolInfo] = useState('');
  // maxDimUm is how many µm one world unit spans, which is what turns the
  // perspective projection into a physical scale bar.
  const volumeInfoRef = useRef({ scaleX: 1, scaleY: 1, scaleZ: 1, maxDimUm: 0 });
  /**
   * Per channel, the raw [low, high] the backend normalised the uint8 volume
   * over. The user's Min/Max is in raw units and the texture is in 0..1, so this
   * is what converts between them. Empty until a volume has loaded.
   */
  const bakedLevelsRef = useRef<[number, number][]>([]);
  /** Bumped when a volume finishes loading, to re-push the contrast uniforms. */
  const [volumeEpoch, setVolumeEpoch] = useState(0);

  // Scale bar. Length/visibility/colour are shared with the other views; only
  // the pixel width is local, since it comes from this camera's distance.
  const [scalebar, setScalebar] = useState<{ um: number; px: number } | null>(null);
  const showScalebar = useViewStore((s) => s.showScalebar);
  const scalebarUm = useViewStore((s) => s.scalebarUm);
  const scalebarColor = useViewStore((s) => s.scalebarColor);
  const scalebarPos = useViewStore((s) => s.scalebarPos);
  const cropRect = useViewStore((s) => s.cropRect);
  const cropOwner = useViewStore((s) => s.cropOwner);
  const cropPanelOpen = useViewStore((s) => s.cropPanelOpen);
  const cropFitRequest = useViewStore((s) => s.cropFitRequest);
  const consumeCropFit = useViewStore((s) => s.consumeCropFit);

  // Save options
  const [saveFormat, setSaveFormat] = useState<'png' | 'tiff'>('png');
  const [saveMerge, setSaveMerge] = useState(true);
  const [savePerChannel, setSavePerChannel] = useState(false);
  const [saveIncludeScalebar, setSaveIncludeScalebar] = useState(true);
  // null = follow whatever is currently visible; a Set = explicit override.
  const [saveChannels, setSaveChannels] = useState<Set<number> | null>(null);
  const [saveDir, setSaveDir] = useState('');
  /** Name to save under; seeded from the image, always editable. */
  const [saveName, setSaveName] = useState('');
  const [conflict, setConflict] = useState<
    { files: string[]; count: number; more: number; revisions: Record<string, string> } | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState<SaveProgress | null>(null);
  const [saveMsg, setSaveMsg] = useState('');
  const [saveErr, setSaveErr] = useState('');
  // Z planes present in the loaded volume, and the sub-range being shown.
  const [volZ, setVolZ] = useState(0);
  const [zRange, setZRange] = useState({ start: 1, end: 1 });
  const [retryNonce, setRetryNonce] = useState(0);
  const [resetting, setResetting] = useState(false);
  const volumeRunRef = useRef(0);
  const loadedVolumeRef = useRef<LoadedVolumeProvenance | null>(null);
  const viewRevisionRef = useRef(0);
  const saveGuardRef = useRef(new ThreeDSaveGuard());

  // Mouse interaction state
  const isDragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  // App keys this component by image id. Snapshot the store during that mount,
  // before the scene effect can resolve fit and write the camera back. Initialising
  // with hard-coded angles here erased the per-image state that tab restore had
  // installed immediately before React mounted us.
  const initialCameraRef = useRef(
    volume3DCameraForMount(useImageStore.getState().volume3D),
  );
  // Orbit state in degrees. az spins around the image's vertical axis, el lifts
  // the camera above the image plane.
  const orbit = useRef({ ...initialCameraRef.current });
  // A completed crop is a display transform, not a second export crop. The
  // shader clips samples to this source rectangle while the camera fits the
  // corresponding physical sub-box. Keeping it in a ref avoids a React render
  // race between panel completion and a save snapshot.
  const displayCropFitRef = useRef<DisplayCropFit | null>(null);
  const previousCropPanelOpenRef = useRef(false);
  // Mirror of the orbit angles, so they can also be typed in.
  const [angles, setAngles] = useState({
    az: initialCameraRef.current.az,
    el: initialCameraRef.current.el,
  });
  const [zoomPercent, setZoomPercent] = useState(initialCameraRef.current.zoomPercent);
  const [zoomDraft, setZoomDraft] = useState<string | null>(null);
  const [maxZoomPercent, setMaxZoomPercent] = useState(1000);

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
    const fullGeometry = volumeInfoRef.current;
    const fitted = displayCropFitRef.current;
    // Physical spacing may arrive after the crop panel was completed. Rebuild
    // the fitted sub-box from the source rect on every camera update so an
    // anisotropic volume never keeps a stale unit-cube target/radius.
    let fittedGeometry: ReturnType<typeof volumeCameraCropFit> | null = null;
    const currentMetadata = metadataRef.current;
    if (fitted && currentMetadata) {
      try {
        fittedGeometry = volumeCameraCropFit(
          fullGeometry,
          fitted.rect,
          currentMetadata.width,
          currentMetadata.height,
        );
      } catch {
        fittedGeometry = null;
      }
    }
    const { scaleX, scaleY, scaleZ } = fittedGeometry ?? fitted ?? fullGeometry;
    const resolved = resolveVolumeCameraZoom({
      scaleX,
      scaleY,
      scaleZ,
      azDeg: orbit.current.az,
      elDeg: orbit.current.el,
      fovDeg: cam.fov,
      aspect: cam.aspect,
      near: cam.near,
    }, orbit.current.zoomPercent);
    orbit.current.radius = resolved.radius;
    orbit.current.zoomPercent = resolved.zoomPercent;
    const displayedMaximum = Math.floor(resolved.maxZoomPercent * 10) / 10;
    setZoomPercent(Math.min(
      displayedMaximum,
      Math.round(resolved.zoomPercent * 10) / 10,
    ));
    setMaxZoomPercent(displayedMaximum);

    const { az, el, radius } = orbit.current;
    const a = az * DEG;
    const e = el * DEG;
    const target: [number, number, number] = fittedGeometry?.target
      ?? fitted?.target
      ?? [CENTER, CENTER, CENTER];
    // az=0, el=0 looks straight down the optical axis, i.e. the familiar XY face
    // from the 2D view. Anchoring the angles to the image planes rather than to
    // three.js's Y-up makes "0°/0°" mean something to a microscopist.
    // Orbiting the centre also matters: pivoting on the world origin put the
    // pivot on a corner of the box and swung the sample out of frame.
    cam.position.set(
      target[0] + radius * Math.cos(e) * Math.sin(a),
      target[1] + radius * Math.sin(e),
      target[2] + radius * Math.cos(e) * Math.cos(a)
    );
    cam.lookAt(target[0], target[1], target[2]);
    cam.updateMatrixWorld();

    const cropMin = materialRef.current?.uniforms.uCropMin?.value as THREE.Vector2 | undefined;
    const cropMax = materialRef.current?.uniforms.uCropMax?.value as THREE.Vector2 | undefined;
    if (cropMin && cropMax) {
      cropMin.set(fitted?.minX ?? 0, fitted?.minY ?? 0);
      cropMax.set(fitted?.maxX ?? 1, fitted?.maxY ?? 1);
    }

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
    useImageStore.getState().setVolume3D({
      az,
      el,
      radius,
      zoomPercent: orbit.current.zoomPercent,
    });
    viewRevisionRef.current += 1;
    recomputeScalebar(); // depends on the camera distance
  }, [recomputeScalebar]);

  /** Apply one verified source crop to the live 3D camera and shader. */
  const fitCropSelection = useCallback((rect: ThreeDSaveCropRect, owner: ReturnType<typeof cropOwnerForMetadata>) => {
    if (!owner || !metadata || saveGuardRef.current.isLocked) return false;
    if (!sameCropOwner(owner, cropOwnerForMetadata(activeImageId, metadata))) return false;
    let fit;
    try {
      fit = volumeCameraCropFit(
        volumeInfoRef.current,
        rect,
        metadata.width,
        metadata.height,
      );
    } catch {
      return false;
    }
    displayCropFitRef.current = {
      ownerKey: owner.key,
      rect: { ...rect },
      minX: rect.x / metadata.width,
      minY: rect.y / metadata.height,
      maxX: (rect.x + rect.width) / metadata.width,
      maxY: (rect.y + rect.height) / metadata.height,
      target: fit.target,
      scaleX: fit.scaleX,
      scaleY: fit.scaleY,
      scaleZ: fit.scaleZ,
    };
    // Crop editing always starts from the unambiguous XY face. Completion can
    // then fit the selected region without carrying an old tilt into the crop.
    orbit.current.az = 0;
    orbit.current.el = 0;
    orbit.current.zoomPercent = 100;
    setAngles({ az: 0, el: 0 });
    setZoomDraft(null);
    updateCamera();
    return true;
  }, [activeImageId, metadata, updateCamera]);

  // Opening the crop panel resets the 3D orientation and temporarily restores
  // the full volume. Otherwise the source-pixel overlay would be drawn over a
  // previously fitted/cropped camera and pointer coordinates would be wrong.
  useEffect(() => {
    const wasOpen = previousCropPanelOpenRef.current;
    previousCropPanelOpenRef.current = cropPanelOpen;
    if (wasOpen || !cropPanelOpen || saveGuardRef.current.isLocked) return;
    displayCropFitRef.current = null;
    orbit.current.az = 0;
    orbit.current.el = 0;
    orbit.current.zoomPercent = 100;
    setAngles({ az: 0, el: 0 });
    setZoomDraft(null);
    updateCamera();
  }, [cropPanelOpen, updateCamera]);

  // A completed crop may arrive through the panel's one-shot request, or by
  // mounting this viewer after a crop was already completed in another view.
  // In both cases, owner validation happens before camera/shader mutation.
  useEffect(() => {
    if (cropPanelOpen || !cropRect || !cropOwner || !metadata || !activeImageId) return;
    const currentOwner = cropOwnerForMetadata(activeImageId, metadata);
    if (!sameCropOwner(cropOwner, currentOwner)) return;
    const current = displayCropFitRef.current;
    if (current && currentOwner && current.ownerKey === currentOwner.key
        && sameThreeDSaveCropRect(current.rect, cropRect)) return;
    fitCropSelection(cropRect, currentOwner);
  }, [activeImageId, cropOwner, cropPanelOpen, cropRect, fitCropSelection, metadata]);

  useEffect(() => {
    const request = cropFitRequest;
    if (!request) return;
    if (!cropRect || !cropOwner || !metadata || !activeImageId) {
      consumeCropFit(request.sequence);
      return;
    }
    const currentOwner = cropOwnerForMetadata(activeImageId, metadata);
    if (!sameCropOwner(cropOwner, currentOwner) || request.ownerKey !== currentOwner?.key) {
      consumeCropFit(request.sequence);
      return;
    }
    // The panel freezes the exact rectangle at completion. If the live crop
    // changed before this keyed viewer observed the request, consume and reject
    // it rather than fitting a different selection under the old request.
    if (!sameThreeDSaveCropRect(request.rect, cropRect)) {
      consumeCropFit(request.sequence);
      return;
    }
    if (cropPanelOpen || saveGuardRef.current.isLocked) return;
    // A malformed/stale request fails closed inside fitCropSelection. Consume
    // it either way so React cannot retry the same invalid geometry forever;
    // the live crop remains available for the user to correct in the panel.
    fitCropSelection(request.rect, currentOwner);
    consumeCropFit(request.sequence);
  }, [activeImageId, consumeCropFit, cropFitRequest, cropOwner, cropPanelOpen, cropRect, fitCropSelection, metadata]);

  // Resetting to the source (or switching to a different source owner) must
  // clear the display transform before a stale crop can affect a new volume.
  useEffect(() => {
    const currentOwner = cropOwnerForMetadata(activeImageId, metadata);
    const fitted = displayCropFitRef.current;
    if (fitted && (!currentOwner || fitted.ownerKey !== currentOwner.key
      || !cropRect || !sameThreeDSaveCropRect(fitted.rect, cropRect))) {
      displayCropFitRef.current = null;
      updateCamera();
    }
  }, [activeImageId, cropRect, metadata, updateCamera]);

  /** Apply a typed zoom percentage; 100% always means fit for the live geometry. */
  const applyZoomPercent = useCallback((requested: number) => {
    if (saveGuardRef.current.isLocked) return;
    if (!Number.isFinite(requested) || requested <= 0) {
      setZoomDraft(null);
      return;
    }
    orbit.current.zoomPercent = requested;
    setZoomDraft(null);
    updateCamera();
  }, [updateCamera]);

  const invalidateLoadedVolume = useCallback((message: string) => {
    // Invalidate the async run as well as the save provenance. A context-loss
    // event does not necessarily make Three.js throw, so relying on catch would
    // leave a black/stale preserveDrawingBuffer canvas looking saveable.
    volumeRunRef.current += 1;
    loadedVolumeRef.current = null;
    texturesRef.current.forEach((texture) => texture.dispose());
    texturesRef.current = [];
    if (materialRef.current) materialRef.current.uniforms.uNumChannels.value = 0;
    setVolInfo('');
    setVolZ(0);
    setLoading(false);
    setLoadError(message);
    setVolumeEpoch((value) => value + 1);
  }, []);

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

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      invalidateLoadedVolume(
        'WebGLコンテキストが失われたため3D表示と保存を停止しました。復旧後にボリュームを再読み込みします',
      );
    };
    const handleContextRestored = () => {
      setLoadError('');
      setRetryNonce((value) => value + 1);
    };
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', handleContextRestored);

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(VOLUME_CAMERA_FOV_DEG, 1, 0.01, 100);
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
        uCropMin: { value: new THREE.Vector2(0, 0) },
        uCropMax: { value: new THREE.Vector2(1, 1) },
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
      // A percentage is relative to fit, so resize changes the radius while the
      // displayed percentage stays fixed.
      updateCamera();
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
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', handleContextRestored);
      renderer.dispose();
      geometry.dispose();
      material.dispose();
      container.removeChild(renderer.domElement);
      // Clean up textures
      texturesRef.current.forEach(t => t.dispose());
      texturesRef.current = [];
    };
  }, [updateCamera, invalidateLoadedVolume]);

  // Load volume data when image or resolution changes
  useEffect(() => {
    if (!metadata || !activeImageId) return;
    if (metadata.num_z <= 1) return;

    const runId = ++volumeRunRef.current;
    const controller = new AbortController();
    let cancelled = false;
    const isCurrent = () => !cancelled && runId === volumeRunRef.current;

    // Never leave pixels from a previous image/T/quality visible under the new
    // filename while the exact backend request is being planned.
    texturesRef.current.forEach((texture) => texture.dispose());
    texturesRef.current = [];
    loadedVolumeRef.current = null;
    bakedLevelsRef.current = [];
    if (materialRef.current) materialRef.current.uniforms.uNumChannels.value = 0;
    setVolInfo('');
    setVolZ(0);
    setZRange({ start: 1, end: 1 });
    volumeInfoRef.current = { scaleX: 1, scaleY: 1, scaleZ: 1, maxDimUm: 0 };
    setScalebar(null);
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
        const biggestSourceDimension = Math.max(
          metadata.width, metadata.height, metadata.num_z,
        );
        if (requested === MAX_QUALITY) {
          requested = biggestSourceDimension > glMax3D ? glMax3D : 0;
        }

        // Keep the exact plan/token handshake even though opening no longer asks
        // for a local-RAM confirmation. It prevents a stale source/T/shape from
        // being silently paired with the returned bytes.
        const plan = await fetchVolumeMemoryPlan(
          currentT, activeImageId, requested, MAX_TEX_CHANNELS,
        );
        if (!isCurrent()) return;

        const vol = await fetchVolumeBin(
          currentT, activeImageId, requested, MAX_TEX_CHANNELS,
          plan.planKey, controller.signal,
        );
        if (!isCurrent()) return;

        const { numZ: num_z, height, width, channels: volChannels, originalShape: original_shape } = vol;
        const shapeMismatch = vol.numChannels !== plan.numChannels
          || num_z !== plan.numZ || height !== plan.height || width !== plan.width
          || original_shape.some((value, index) => value !== plan.originalShape[index]);
        if (shapeMismatch) {
          throw new Error('3D表示を中止しました: メモリ計算と受信画像の形状が一致しません');
        }

        const mat = materialRef.current;
        if (!mat) return;

        // Create 3D textures for each channel (up to 4) — uint8 data
        const numCh = Math.min(volChannels.length, MAX_TEX_CHANNELS);
        // The window the backend already applied when it packed the volume into
        // uint8. Kept because the shader has to express the user's Min/Max in
        // texture units, not raw ones: without it the contrast controls did
        // nothing at all in this view.
        bakedLevelsRef.current = volChannels
          .slice(0, MAX_TEX_CHANNELS)
          .map((c) => [c.autoMin, c.autoMax] as [number, number]);
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
        const physical = volumePhysicalGeometry(
          origW,
          origH,
          origZ,
          metadata.pixel_size_x,
          metadata.pixel_size_y,
          metadata.pixel_size_z,
        );
        const { scaleX, scaleY, scaleZ } = physical;

        volumeInfoRef.current = {
          scaleX,
          scaleY,
          scaleZ,
          maxDimUm: physical.maxDimUm,
        };

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
        // Preserve the selected physical fraction when quality/T changes the
        // sampled Z count. Clamping the old slice numbers would silently turn
        // the back half of 128 planes into the middle third of 200 planes.
        {
          const store = useImageStore.getState();
          // Camera/slab controls remain live while a slow volume is built. Use
          // their current values at completion: writing the request-start
          // snapshot here made Plate Save export an old angle even though the
          // WebGL camera visibly showed the user's newer drag position.
          const resampled = volume3DForResampledVolume(store.volume3D, num_z);
          const range = { start: resampled.zStart, end: resampled.zEnd };
          setZRange(range);
          store.setVolume3D(resampled);
        }

        // Info string
        const mb = ((numCh * num_z * height * width) / 1048576).toFixed(1);
        const sizeNote = width >= original_shape[3] && height >= original_shape[2]
          ? ' 原寸'
          : resolution === MAX_QUALITY ? ' GPU上限' : '';
        // needsUpdate only queues a Data3DTexture upload. Force one render and
        // verify the driver before publishing save provenance; GPU OOM/context
        // loss otherwise produces a valid-looking black capture without throw.
        const renderer = rendererRef.current;
        const scene = sceneRef.current;
        const camera = cameraRef.current;
        if (!renderer || !scene || !camera) {
          throw new Error('3D描画コンテキストを確認できません');
        }
        const uploadGl = renderer.getContext() as WebGL2RenderingContext;
        drainWebGLErrors(uploadGl);
        renderer.render(scene, camera);
        const glErrors = drainWebGLErrors(uploadGl);
        if (uploadGl.isContextLost() || glErrors.length > 0) {
          throw new Error(
            uploadGl.isContextLost()
              ? 'WebGLコンテキストが失われ、3Dテクスチャを作成できませんでした'
              : `GPUへの3Dテクスチャ転送に失敗しました (WebGL ${glErrors.map((e) => `0x${e.toString(16)}`).join(', ')})`,
          );
        }
        loadedVolumeRef.current = {
          runId,
          imageId: activeImageId,
          sourceIdentity: metadata.source_identity,
          sourceRevision: metadata.source_revision,
          currentT,
          selectedResolution: resolution,
          planKey: plan.planKey,
          numChannels: numCh,
          numZ: num_z,
        };
        // Publish readiness only after textures, shader channel count, physical
        // scale and provenance all describe the same completed request.
        setVolumeEpoch((n) => n + 1);
        setVolInfo(`${width}x${height}x${num_z} (${mb} MB)${sizeNote}`);
        if (isCurrent()) setLoading(false);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof VolumeMemoryEpochChangedError) {
          // Another source decode/Plate volume completed after this plan was
          // measured. Re-read the exact plan instead of executing stale source,
          // T or shape provenance.
          if (isCurrent()) setRetryNonce((value) => value + 1);
          return;
        }
        console.error('Failed to load volume:', err);
        if (isCurrent()) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load volume');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [metadata, activeImageId, currentT, resolution, retryNonce, updateCamera]);

  // Update channel colors/visibility uniforms. This can also be forced at the
  // save boundary so a just-edited React state cannot lag one frame behind.
  const syncChannelUniforms = useCallback(() => {
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
        // Map the user's window into the texture's own scale. The volume was
        // packed as (raw - low) / (high - low), so the same transform applied to
        // ch.min/ch.max is what the shader needs. These used to be hardcoded to
        // 0 and 1, which made the shader a pass-through and the Min/Max controls
        // inert in this view — the sliders moved and nothing happened.
        const baked = bakedLevelsRef.current[i];
        if (baked) {
          const span = Math.max(baked[1] - baked[0], 1);
          mins.push((ch.min - baked[0]) / span);
          maxs.push((ch.max - baked[0]) / span);
        } else {
          mins.push(0);
          maxs.push(1);
        }
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
    viewRevisionRef.current += 1;
  }, [channels]);

  // Note: volume data is pre-contrasted to uint8 on backend, so min=0 max=1.
  useEffect(() => {
    // ChannelPanel sits outside this component's overlay. Keep its edits in the
    // store, but do not let them split one MERGE+CH save across visual states.
    if (saving || saveGuardRef.current.isLocked) return;
    syncChannelUniforms();
    // volumeEpoch: a freshly loaded volume brings new baked levels, and the
    // uniforms have to be recomputed against them even if `channels` did not
    // change.
  }, [saving, syncChannelUniforms, volumeEpoch]);

  // Push the visible Z slab to the shader. Plane n covers [n-1, n]/volZ in
  // normalised texture Z, so the selected 1-based inclusive range maps to
  // (start-1)/volZ .. end/volZ.
  const syncZUniforms = useCallback(() => {
    const mat = materialRef.current;
    if (!mat || volZ <= 0) return;
    mat.uniforms.uZMin.value = Math.max(0, (zRange.start - 1) / volZ);
    mat.uniforms.uZMax.value = Math.min(1, zRange.end / volZ);
    viewRevisionRef.current += 1;
  }, [zRange, volZ]);

  useEffect(() => {
    if (saving || saveGuardRef.current.isLocked) return;
    syncZUniforms();
  }, [saving, syncZUniforms]);

  // Mouse handlers for orbit control
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (saveGuardRef.current.isLocked) return;
    isDragging.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
  }, []);

  // Keep the slab non-empty: moving one end past the other drags the other with it.
  const setZStart = useCallback((v: number) => {
    if (saveGuardRef.current.isLocked) return;
    if (Number.isNaN(v)) return;
    setZRange((r) => {
      const start = Math.max(1, Math.min(volZ, Math.round(v)));
      const next = { start, end: Math.max(start, r.end) };
      useImageStore.getState().setVolume3D({ zStart: next.start, zEnd: next.end, zTotal: volZ });
      return next;
    });
  }, [volZ]);

  const setZEnd = useCallback((v: number) => {
    if (saveGuardRef.current.isLocked) return;
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
    if (saveGuardRef.current.isLocked) return;
    const a = wrapAz(az);
    const e = clampEl(el);
    orbit.current.az = a;
    orbit.current.el = e;
    setAngles({ az: Math.round(a * 10) / 10, el: Math.round(e * 10) / 10 });
    // updateCamera records the angle, fit-relative zoom and resolved radius as
    // one coherent camera state for tab restore and Plate Save.
    updateCamera();
  }, [updateCamera]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (saveGuardRef.current.isLocked) return;
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

  /** The canvas may be saved only when it names the currently requested volume. */
  const loadedVolumeIsCurrent = useCallback((): boolean => {
    const loaded = loadedVolumeRef.current;
    const state = useImageStore.getState();
    const renderer = rendererRef.current;
    const mat = materialRef.current;
    const gl = renderer?.getContext() as WebGL2RenderingContext | undefined;
    return !loading
      && !!loaded
      && loaded.runId === volumeRunRef.current
      && loaded.imageId === activeImageId
      && loaded.sourceIdentity === metadata?.source_identity
      && loaded.sourceRevision === metadata?.source_revision
      && loaded.currentT === currentT
      && loaded.selectedResolution === resolution
      && state.activeImageId === loaded.imageId
      && state.metadata?.source_revision === loaded.sourceRevision
      && !!gl && !gl.isContextLost()
      && texturesRef.current.length === loaded.numChannels
      && (mat?.uniforms.uNumChannels.value as number) === loaded.numChannels
      && volZ === loaded.numZ;
  }, [activeImageId, currentT, loading, metadata, resolution, volZ]);

  /**
   * Grab one frame as raw RGBA at the canvas's device resolution.
   *
   * Renders synchronously with the requested channel mask so the capture is not
   * at the mercy of the animation loop, optionally burns in the exact scale bar,
   * then restores the mask and re-renders so the live view is untouched.
   */
  const captureFrame = useCallback((
    name: string,
    mask: boolean[] | null,
    saveSnapshot: ThreeDSaveSnapshot,
  ): RenderImagePayload | null => {
    if (!saveGuardRef.current.owns(saveSnapshot, viewRevisionRef.current)
        || !loadedVolumeIsCurrent()) return null;
    assertThreeDSaveCrop(saveSnapshot);
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const cam = cameraRef.current;
    const mat = materialRef.current;
    if (!renderer || !scene || !cam || !mat) return null;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (gl.isContextLost()) return null;

    const uVisible = mat.uniforms.uVisible.value as boolean[];
    const prev = uVisible.slice();
    if (mask) mat.uniforms.uVisible.value = mask;
    try {
      renderer.render(scene, cam);
      const glErrors = drainWebGLErrors(gl);
      if (!saveGuardRef.current.owns(saveSnapshot, viewRevisionRef.current)
          || gl.isContextLost() || glErrors.length > 0) return null;
      // The crop is part of the same snapshot as the WebGL frame. A direct
      // store mutation during a multi-image save fails closed rather than
      // publishing MERGE and channel images with different rectangles.
      assertThreeDSaveCrop(saveSnapshot);
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

      // Crop after the verified WebGL frame has been copied.  The crop tool
      // stores source-image pixel corners; 3D uses the same normalized fraction
      // of its rendered framebuffer for this trial implementation.  Draw the
      // scale bar on the cropped canvas so it remains inside the saved image
      // even when the selected area does not contain the on-screen bar.
      // When the live viewer has already clipped the shader and fitted the
      // camera to this exact owner/rectangle, read back the full canvas. A
      // second normalized crop would double-crop the user's selection. If a
      // crop exists but has not been completed/fitted, preserve the trial
      // export's original post-crop behavior.
      const crop = cropRectForCapture(
        saveSnapshot.cropRect,
        saveSnapshot.cropOwner.width || w,
        saveSnapshot.cropOwner.height || h,
        w,
        h,
        displayCropMatchesSnapshot(displayCropFitRef.current, saveSnapshot),
      );
      const output = document.createElement('canvas');
      output.width = crop.width;
      output.height = crop.height;
      const outputCtx = output.getContext('2d');
      if (!outputCtx) return null;
      outputCtx.fillStyle = '#000000';
      outputCtx.fillRect(0, 0, crop.width, crop.height);
      outputCtx.drawImage(
        flat,
        crop.x, crop.y, crop.width, crop.height,
        0, 0, crop.width, crop.height,
      );
      if (saveIncludeScalebar && hasPhysicalScale && scalebar) {
        const exportScale = src.clientWidth > 0 ? w / src.clientWidth : 1;
        // Re-plan against the cropped canvas. Automatic lengths can become a
        // shorter nice value; an explicit user length throws here if its bar or
        // label cannot fit, so the save never publishes a clipped annotation.
        const croppedBar = planCroppedScalebar(
          scalebar,
          crop.width,
          crop.height,
          exportScale,
          scalebarUm,
        );
        // A manually dragged bar is stored as a fraction of the full frame.
        // Rebase it into the crop when it remains inside the selected area;
        // otherwise fall back to the documented lower-left default.
        const fullFx = scalebarPos?.fx ?? -1;
        const fullFy = scalebarPos?.fy ?? -1;
        const cropFx = crop.width > 0
          ? (fullFx * w - crop.x) / crop.width
          : -1;
        const cropFy = crop.height > 0
          ? (fullFy * h - crop.y) / crop.height
          : -1;
        const croppedScalebarPos = scalebarPos
          && cropFx >= 0 && cropFx <= 1 && cropFy >= 0 && cropFy <= 1
          ? { fx: cropFx, fy: cropFy }
          : null;
        drawScalebar(
          outputCtx,
          croppedBar,
          crop.width,
          crop.height,
          scalebarColor,
          // The selected image is the output coordinate system.  A saved bar
          // position outside it cannot be represented safely, so use the
          // documented default inside the crop in that case.
          croppedScalebarPos,
          exportScale,
        );
      }
      const bytes = new Uint8Array(outputCtx.getImageData(0, 0, crop.width, crop.height).data.buffer);
      return { name, width: crop.width, height: crop.height, data_b64: bytesToBase64(bytes) };
    } finally {
      mat.uniforms.uVisible.value = prev;
      renderer.render(scene, cam);
    }
  }, [
    hasPhysicalScale, loadedVolumeIsCurrent, saveIncludeScalebar,
    scalebar, scalebarColor, scalebarPos, scalebarUm,
  ]);

  /** Channels the save will use: an explicit pick, else whatever is visible now. */
  const saveChannelIndices = (() => {
    const mat = materialRef.current;
    const limit = Math.min(channels.length, (mat?.uniforms.uNumChannels.value as number) || channels.length, 4);
    const pool = Array.from({ length: limit }, (_, i) => i);
    if (saveChannels) return pool.filter((i) => saveChannels.has(i));
    return pool.filter((i) => channels[i]?.visible);
  })();

  const handleSave = useCallback(async (overwrite = false) => {
    const expectedRevisions = overwrite ? conflict?.revisions ?? {} : {};
    setSaveErr('');
    setSaveMsg('');
    setSaveProgress(null);
    if (overwrite) setConflict(null);
    if (!metadata) return;
    if (!loadedVolumeIsCurrent()) {
      setSaveErr('現在の画像・T・Qualityの3Dボリュームが読み込み完了するまで保存できません');
      return;
    }
    // Refused here, not silently sanitised by the backend: a name the user did
    // not type is the exact failure 1.5.0 exists to prevent.
    const nameProblem = filenameProblem(saveName.trim() || stemOf(metadata.filename));
    if (nameProblem) {
      setSaveErr(nameProblem);
      return;
    }
    if (!saveMerge && !savePerChannel) {
      setSaveErr('MERGE か CH別 のどちらかを選んでください');
      return;
    }
    const picks = saveChannelIndices;
    if (picks.length === 0) {
      setSaveErr('保存するチャンネルがありません');
      return;
    }
    if (imageOperationIsBusy()) {
      setSaveErr('画像を開く・切り替える処理が完了してから保存してください');
      return;
    }

    // Freeze the actual shader state synchronously before the first await. The
    // ChannelPanel and Toolbar live outside this component, and the App overlay
    // is painted asynchronously, so React state alone is not a save lock.
    if (saveGuardRef.current.isLocked) return;
    syncChannelUniforms();
    syncZUniforms();
    let frozenCrop: ReturnType<typeof currentThreeDSaveCrop>;
    try {
      frozenCrop = currentThreeDSaveCrop();
    } catch (error) {
      setSaveErr(error instanceof Error ? error.message : 'クロップ範囲を確認できないため保存を中止しました');
      return;
    }
    const saveSnapshot = saveGuardRef.current.begin(
      viewRevisionRef.current,
      frozenCrop.cropRect,
      frozenCrop.cropOwner,
    );
    if (!saveSnapshot) return;

    const firstProgress = {
      percent: 0,
      label: saveDir ? '保存を準備中…' : '保存先を選択中…',
    };
    // This owner outlives the keyed viewer. It prevents navigation from
    // unmounting our local guard while /api/save-render is still writing.
    const operationStore = useOperationStore.getState();
    const globalSaveToken = operationStore.beginThreeDSave(firstProgress);
    if (globalSaveToken === null) {
      saveGuardRef.current.finish(saveSnapshot);
      setSaveErr('別の3D保存が完了するまでお待ちください');
      return;
    }
    const reportProgress = (progress: SaveProgress | null) => {
      setSaveProgress(progress);
      if (progress) {
        useOperationStore.getState().updateThreeDSave(globalSaveToken, progress);
      }
    };

    setSaving(true);
    reportProgress(firstProgress);
    try {
      await nextPaint();
      let dir = saveDir;
      if (!dir) {
        const chosen = await chooseFolder();
        if (chosen.cancelled || !chosen.path) {
          reportProgress(null);
          return;
        }
        dir = chosen.path;
        setSaveDir(dir);
      }
      // The folder picker and overwrite dialog can stay open while T/Quality is
      // changed. Recheck immediately before touching the canvas.
      if (!saveGuardRef.current.owns(saveSnapshot, viewRevisionRef.current)
          || !loadedVolumeIsCurrent()) {
        throw new Error('3Dボリュームが変更されたため保存を中止しました。読み込み完了後に再実行してください');
      }
      assertThreeDSaveCrop(saveSnapshot);

      const limit = 4;
      const images: RenderImagePayload[] = [];
      const expectedImages = (saveMerge ? 1 : 0) + (savePerChannel ? picks.length : 0);
      const totalTasks = expectedImages + 1;
      const captured = async (label: string) => {
        reportProgress({
          percent: completedSavePercent(images.length, totalTasks),
          label: `${label}を取得しました（${images.length}/${expectedImages}画像）`,
        });
        await nextPaint();
      };
      reportProgress({ percent: 0, label: `保存画像を取得中（0/${expectedImages}画像）` });
      await nextPaint();
      if (saveMerge) {
        const mask = Array.from({ length: limit }, (_, i) => picks.includes(i));
        const f = captureFrame('merge', mask, saveSnapshot);
        if (!f) throw new Error('MERGE画面の取得に失敗したため、何も保存していません');
        images.push(f);
        await captured('MERGE画像');
      }
      if (savePerChannel) {
        for (const i of picks) {
          const mask = Array.from({ length: limit }, (_, k) => k === i);
          const label = metadata.channel_names[i] || `Ch${i + 1}`;
          const f = captureFrame(label, mask, saveSnapshot);
          if (!f) {
            throw new Error(`${label}画面の取得に失敗したため、何も保存していません`);
          }
          images.push(f);
          await captured(`${label}画像`);
        }
      }
      if (images.length !== expectedImages) {
        throw new Error(
          `保存画像数が一致しないため中止しました（予定 ${expectedImages}、取得 ${images.length}）`,
        );
      }
      if (!saveGuardRef.current.owns(saveSnapshot, viewRevisionRef.current)
          || !loadedVolumeIsCurrent()) {
        throw new Error('保存中に3D表示が変更されたため、何も保存していません');
      }
      assertThreeDSaveCrop(saveSnapshot);

      reportProgress({
        percent: completedSavePercent(expectedImages, totalTasks),
        label: 'ファイルに保存中…',
      });
      await nextPaint();
      if (!saveGuardRef.current.owns(saveSnapshot, viewRevisionRef.current)
          || !loadedVolumeIsCurrent()) {
        throw new Error('ファイル保存の直前に3D表示が変更されたため、何も保存していません');
      }
      assertThreeDSaveCrop(saveSnapshot);
      const res = await saveRender({
        output_dir: dir,
        basename: saveName.trim() || stemOf(metadata.filename),
        format: saveFormat,
        images,
        overwrite,
        expected_revisions: expectedRevisions,
      });
      reportProgress({ percent: 100, label: '保存完了' });
      setSaveMsg(`${res.saved.length} 件保存: ${res.output_dir}`);
      await nextPaint();
    } catch (e) {
      reportProgress(null);
      // Nothing was written; this is a question about replacing files.
      if (e instanceof OverwriteConflict) {
        setConflict({
          files: e.files, count: e.count, more: e.more, revisions: e.revisions,
        });
      } else {
        setSaveErr(e instanceof Error ? e.message : '保存に失敗しました');
      }
    } finally {
      saveGuardRef.current.finish(saveSnapshot);
      useOperationStore.getState().finishThreeDSave(globalSaveToken);
      setSaving(false);
    }
    // saveName belongs here: without it this closure keeps the name from the
    // render it was created in, so typing one and pressing save wrote the old
    // one — the exact thing the field exists to control.
  }, [metadata, saveMerge, savePerChannel, saveChannelIndices, saveDir, saveFormat,
      saveName, conflict, captureFrame, loadedVolumeIsCurrent,
      syncChannelUniforms, syncZUniforms]);

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
      if (saveGuardRef.current.isLocked) {
        e.preventDefault();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-saving-overlay]')) {
        e.preventDefault();
        return;
      }
      if (target?.closest('[data-3d-controls]')) return;
      e.preventDefault();
      orbit.current.zoomPercent *= e.deltaY > 0 ? 1 / 1.1 : 1 / 0.9;
      setZoomDraft(null);
      updateCamera();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [updateCamera]);

  const resetToSource = useCallback(async () => {
    if (saveGuardRef.current.isLocked) return;
    if (!activeImageId || !metadata || !sourceViewDefaults[activeImageId]) return;
    const resetId = activeImageId;
    const resetIdentity = metadata.source_identity;
    const resetRevision = metadata.source_revision;
    if (!window.confirm(
      'このファイルの色・表示チャンネル・Min/Max・Z/T・MIP/投影・3Dカメラ・Z範囲・Qualityを、元ファイルを開いた直後の設定に戻します。\n保存済みの調整内容は元に戻せません。続行しますか？',
    )) return;

    setResetting(true);
    setGlobalLoadError(null);
    try {
      if (!resetActiveImageToSource(true)) {
        throw new Error('元ファイルの初期設定を取得できません');
      }
      const store = useImageStore.getState();
      const restored = store.volume3D;
      const fullZ = Math.max(1, volZ || metadata.num_z);
      store.setVolume3D({ zStart: 1, zEnd: fullZ, zTotal: fullZ });
      setZRange({ start: 1, end: fullZ });
      orbit.current.az = restored.az;
      orbit.current.el = restored.el;
      orbit.current.zoomPercent = restored.zoomPercent;
      setAngles({
        az: Math.round(restored.az * 10) / 10,
        el: Math.round(restored.el * 10) / 10,
      });
      updateCamera();
      setResolution(MAX_QUALITY);
      await Promise.all([
        resetSettings(activeImageId),
        reloadActiveChannelData(activeImageId),
      ]);
    } catch (error) {
      const current = useImageStore.getState();
      if (current.activeImageId === resetId
          && current.metadata?.source_identity === resetIdentity
          && current.metadata?.source_revision === resetRevision) {
        setGlobalLoadError(
          `表示設定をリセットできません: ${error instanceof Error ? error.message : error}`,
        );
      }
    } finally {
      setResetting(false);
    }
  }, [
    activeImageId, metadata, resetActiveImageToSource, setGlobalLoadError,
    sourceViewDefaults, updateCamera, volZ,
  ]);

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
    orbit.current.zoomPercent = Number.isFinite(v.zoomPercent) && v.zoomPercent > 0
      ? v.zoomPercent
      : 100;
    setZoomDraft(null);
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

  const retryResolution = resolution === MAX_QUALITY
    ? 512
    : resolution > 384 ? 384 : resolution > 256 ? 256 : 128;
  const canSaveVolume = loadedVolumeIsCurrent();

  return (
    <div ref={rootRef} className="relative flex-1 overflow-hidden bg-black">
      {/* Keep the render viewport beside the controls. Fitting against the full
          root would put the volume's right edge underneath the 230 px panel. */}
      {/* This viewport must remain absolutely pinned to the available area. Do
          not add `relative` here: Tailwind's utility order can make the later
          relative rule win, returning this wrapper to normal flow and leaving
          the WebGL canvas with only its content-sized (roughly 20%) height. The
          absolute element is already a containing block for its overlays. */}
      <div className="absolute inset-y-0 left-0 right-[238px] min-w-0 overflow-hidden">
        <div
          ref={containerRef}
          className="w-full h-full cursor-grab active:cursor-grabbing"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        />

        {/* The overlay shares the exact unobscured viewport used by the camera
            and export, so its default is genuinely inside the image at left-bottom. */}
        <ScalebarOverlay metrics={scalebar} pad={14} />
        {cropPanelOpen && (
          <CropOverlay
            width={metadata.width}
            height={metadata.height}
            zoom={1}
            panX={0}
            panY={0}
            containerRef={containerRef}
            fitToCanvas
          />
        )}
      </div>

      {/* Loading overlay */}
      {loading && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60"
          role="status"
          aria-live="polite"
          aria-label="3D画像を読み込み中"
        >
          <div className="w-56 rounded-lg bg-neutral-950/90 px-4 py-3 text-white shadow-lg">
            <div className="mb-2 text-center text-sm">3D画像を読み込み中…</div>
            <progress
              max={100}
              aria-label="Maximum 3Dボリュームの読込待ち"
              className="h-2 w-full accent-[var(--accent)]"
            />
          </div>
        </div>
      )}

      {/* Error overlay */}
      {loadError && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="bg-red-900/80 rounded-lg p-4 max-w-md text-center">
            <p className="text-white text-sm font-bold mb-2">3D Loading Error</p>
            <p className="text-white/80 text-xs mb-3">{loadError}</p>
            <button
              onClick={() => {
                setLoadError('');
                setResolution(retryResolution);
                setRetryNonce((value) => value + 1);
              }}
              className="px-3 py-1 rounded bg-[var(--accent)] text-white text-xs hover:opacity-90"
            >
              Retry with lower resolution ({retryResolution}px)
            </button>
          </div>
        </div>
      )}

      {/* 3D Controls Panel */}
      <div data-3d-controls className="absolute top-12 right-2 max-h-[calc(100%-3.5rem)] overflow-y-auto bg-black/70 rounded-lg p-3 flex flex-col gap-2 text-xs text-white/80 w-[230px]">
        <div className="font-bold text-white text-center mb-1">3D Controls</div>

        {/* Resolution */}
        <div className="flex items-center gap-2">
          <span className="w-16">Quality:</span>
          <select
            value={resolution}
            onChange={(e) => {
              if (saveGuardRef.current.isLocked) return;
              setResolution(Number(e.target.value));
            }}
            className="flex-1 bg-black/60 border border-white/20 rounded px-1 py-0.5 text-xs"
          >
            <option value={128}>Low (128)</option>
            <option value={256}>Medium (256)</option>
            <option value={384}>High (384)</option>
            <option value={512}>Ultra (512)</option>
            <option value={MAX_QUALITY}>Maximum (利用可能な最大)</option>
          </select>
        </div>

        {metadata.num_channels > MAX_TEX_CHANNELS && (
          <p className="rounded border border-amber-500/50 bg-amber-500/10 p-2 text-[10px] leading-relaxed text-amber-200">
            3D表示は先頭4チャンネルまでです。5番目以降は3Dに表示されないため、2Dに切り替えて確認してください。
          </p>
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
                if (saveGuardRef.current.isLocked) return;
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
            <span className="w-16">拡大率:</span>
            <input
              type="number"
              min={MIN_VOLUME_ZOOM_PERCENT}
              max={maxZoomPercent}
              step={5}
              value={zoomDraft ?? zoomPercent}
              onFocus={() => setZoomDraft(String(zoomPercent))}
              onChange={(e) => setZoomDraft(e.target.value)}
              onBlur={(e) => applyZoomPercent(Number(e.currentTarget.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  setZoomDraft(null);
                  e.currentTarget.value = String(zoomPercent);
                  e.currentTarget.blur();
                }
              }}
              aria-label="3D拡大率"
              className="w-16 bg-black/60 border border-white/20 rounded px-1 py-0.5 text-xs text-right tabular-nums"
              title={`100%で画面に合わせます（最大 ${maxZoomPercent}%）`}
            />
            <span className="text-white/40">%</span>
            <button
              onClick={() => applyZoomPercent(100)}
              className="ml-auto rounded bg-white/10 px-1.5 py-0.5 text-[10px] hover:bg-white/20 transition"
              title="画像全体を画面に合わせる"
            >
              全体
            </button>
          </div>
          <div className="text-right text-[9px] text-white/40">
            入力範囲: {MIN_VOLUME_ZOOM_PERCENT}–{maxZoomPercent}%（100%=全体表示）
          </div>
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
          {!hasPhysicalScale && (
            <div className="mt-1 rounded border border-amber-500/50 bg-amber-500/10 p-1.5 text-[10px] leading-relaxed text-amber-200">
              物理サイズ情報がないためスケールバーを表示できません
            </div>
          )}
          {showScalebar && hasPhysicalScale && (
            <div className="text-right text-white/40 text-[10px] mt-1">
              現在: <span className="font-mono">{scalebar ? formatUm(scalebar.um) : '—'}</span>
              （中心深度換算）
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

          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={saveIncludeScalebar && hasPhysicalScale}
              onChange={(e) => setSaveIncludeScalebar(e.target.checked)}
              disabled={!hasPhysicalScale}
              className="accent-[var(--accent)]"
            />
            <span className={!hasPhysicalScale ? 'text-white/40' : ''}>
              保存画像にスケールバーを入れる（中心深度換算）
            </span>
          </label>
          {!hasPhysicalScale && (
            <div className="text-[10px] leading-relaxed text-amber-300">
              物理サイズ情報がないためスケールバーを入れられません
            </div>
          )}

          {cropRect && (
            <div className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-1 text-[10px] leading-relaxed text-emerald-200">
              クロップ範囲を保存画像に適用: x={Math.round(cropRect.x)}, y={Math.round(cropRect.y)},
              {' '}{Math.round(cropRect.width)}×{Math.round(cropRect.height)} px
            </div>
          )}

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
            disabled={saving || !!conflict || !canSaveVolume}
            title={canSaveVolume
              ? '現在の3D表示を保存'
              : '現在の画像・T・Qualityの3D読込が完了するまで保存できません'}
            className="w-full px-2 py-1 rounded bg-[var(--accent)] text-white text-xs hover:opacity-90 disabled:opacity-50 transition"
          >
            {saving ? '保存中…' : canSaveVolume ? '名前を付けて保存' : '3D読込完了後に保存できます'}
          </button>
          {saveProgress && (
            <div className="space-y-0.5" aria-live="polite">
              <div className="flex justify-between text-[10px] text-white/60">
                <span>{saveProgress.label}</span>
                <span className="font-mono tabular-nums">{saveProgress.percent}%</span>
              </div>
              <progress
                value={saveProgress.percent}
                max={100}
                aria-label={`保存進捗 ${saveProgress.percent}%`}
                className="h-1.5 w-full accent-[var(--accent)]"
              />
            </div>
          )}
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

        {/* Reset every per-file display choice, including the 3D camera/slab. */}
        <button
          onClick={resetToSource}
          disabled={resetting || !activeImageId || !sourceViewDefaults[activeImageId]}
          aria-busy={resetting}
          className="mt-1 px-2 py-1 rounded bg-[var(--accent)] text-white text-xs hover:opacity-90 disabled:opacity-40 transition"
        >
          {resetting ? (
            <span className="flex w-full flex-col items-center gap-1">
              <span>戻しています…</span>
              <progress
                max={100}
                aria-label="3D表示設定のリセット待ち"
                className="h-1 w-full accent-white"
              />
            </span>
          ) : '元ファイルの設定に全て戻す'}
        </button>
      </div>

      {/* Info overlay */}
      <div className="absolute top-2 left-2 text-xs font-mono text-white/60 bg-black/40 px-2 py-1 rounded pointer-events-none">
        {metadata.filename} | 3D Volume | {metadata.width}&times;{metadata.height}&times;{metadata.num_z}
        {metadata.pixel_size_z > 0 && ` | Z step: ${metadata.pixel_size_z.toFixed(2)} µm`}
      </div>

      {/* Help */}
      <div className="absolute bottom-2 right-[240px] text-[10px] text-white/40 pointer-events-none">
        Drag: rotate | Scroll: zoom
      </div>

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
