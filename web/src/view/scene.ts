// Three.js scene: generic X-quad at R-1 proportions, rotors, rod, hanging mass, trail, orbit camera.
// No glTF, no loaders. NED/FRD -> Three.js Y-up conversion happens here only (see frames.ts).
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  Material,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Telemetry } from '../core/sim';
import { eulerZyxToQuat, nedToThree, quatNedToThree } from './frames';
import type { ScenePalette } from './theme';
import { DEFAULT_LIGHT_PALETTE } from './theme';

/** Thrown by createScene when WebGL2 is not available, so the element can show its fallback. */
export class WebGLUnavailableError extends Error {
  constructor(message = 'WebGL2 is not available') {
    super(message);
    this.name = 'WebGLUnavailableError';
  }
}

export type { ScenePalette } from './theme';
export { DEFAULT_DARK_PALETTE, DEFAULT_LIGHT_PALETTE } from './theme';

export interface SceneOptions {
  palette?: ScenePalette;
  reducedMotion?: boolean;
  /** Pixel ratio cap (default 2). */
  maxPixelRatio?: number;
  /** Trail length in points (default 300). */
  trailPoints?: number;
}

export interface SceneHandle {
  /** Show the given telemetry sample and render a frame. */
  update(t: Telemetry): void;
  resize(width: number, height: number): void;
  dispose(): void;
  setReducedMotion(reduced: boolean): void;
  setTheme(palette: ScenePalette): void;
  /** Current clear colour (#rrggbb) and trail visibility, for E2E tests. */
  debugInfo(): { clearColor: string; trailVisible: boolean };
}

// R-1 Table 2 proportions (metres). Mirrors shared/params/default.json; used for drawing only.
const ARM = 0.241;
const MASS_RADIUS = 0.02; // 4 cm sphere
const BODY = { x: 0.2, y: 0.2, z: 0.06 }; // body box (forward, right, down), drawn
const ROTOR_RADIUS = 0.1;
const GRID_SIZE = 6;
const GRID_PITCH = 0.5;
const GRID_DROP = 1.5; // grid below the hover point
const ROTOR_SPIN_DIV = 40; // visual spin = omega / 40
const TRAIL_DEFAULT = 300;

/**
 * Motors in the FRD body frame, index 0..3 = M1..M4:
 * M1 rear-left, M2 rear-right, M3 front-right, M4 front-left (accepted layout).
 */
const D = ARM / Math.SQRT2;
const MOTOR_POS_FRD: readonly (readonly [number, number, number])[] = [
  [-D, -D, 0], // M1 rear-left
  [-D, +D, 0], // M2 rear-right
  [+D, +D, 0], // M3 front-right
  [+D, -D, 0], // M4 front-left
];
const MOTOR_FRONT: readonly boolean[] = [false, false, true, true];
/** Visual spin direction: yaw-torque sign of each motor (M1, M3 vs M2, M4 counter-rotate). */
const MOTOR_SPIN_SIGN: readonly number[] = [+1, -1, +1, -1];

function probeWebGL2(canvas: HTMLCanvasElement): boolean {
  try {
    const probe = canvas.ownerDocument.createElement('canvas');
    return probe.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

export function createScene(canvas: HTMLCanvasElement, opts: SceneOptions = {}): SceneHandle {
  if (!probeWebGL2(canvas)) throw new WebGLUnavailableError();
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'default' });
  } catch (err) {
    throw new WebGLUnavailableError(err instanceof Error ? err.message : undefined);
  }
  if (!renderer.capabilities.isWebGL2) {
    renderer.dispose();
    throw new WebGLUnavailableError();
  }
  const maxDpr = opts.maxPixelRatio ?? 2;
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, maxDpr));

  let palette = opts.palette ?? DEFAULT_LIGHT_PALETTE;
  let reduced = opts.reducedMotion ?? false;
  const trailN = Math.max(2, opts.trailPoints ?? TRAIL_DEFAULT);

  const scene = new Scene();
  const camera = new PerspectiveCamera(40, 1, 0.05, 100);
  camera.position.set(1.9, 0.4, 2.4);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.enablePan = false;
  controls.minDistance = 1.2;
  controls.maxDistance = 12;
  controls.maxPolarAngle = Math.PI * 0.92;
  controls.target.set(0, -0.5, 0);
  controls.update();

  // --- lights ---
  const hemi = new HemisphereLight(0xffffff, 0x888888, 1);
  scene.add(hemi);
  const sun = new DirectionalLight(0xffffff, 1);
  sun.position.set(2, 4, 3);
  scene.add(sun);

  // --- materials (updated in place on theme change) ---
  const mat = {
    body: new MeshLambertMaterial(),
    arm: new MeshLambertMaterial(),
    armFront: new MeshLambertMaterial(),
    rotor: new MeshLambertMaterial({ transparent: true, opacity: 0.55 }),
    rotorBlade: new MeshLambertMaterial(),
    rod: new MeshLambertMaterial(),
    mass: new MeshLambertMaterial(),
  };
  const trailMat = new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
  const gridMats: Material[] = [];

  // --- grid: 0.5 m pitch, 1.5 m below the hover point (NED origin) ---
  const divisions = Math.round(GRID_SIZE / GRID_PITCH);
  const grid = new GridHelper(GRID_SIZE, divisions, 0xffffff, 0xffffff);
  grid.position.y = -GRID_DROP;
  scene.add(grid);
  const recolorGrid = (): void => {
    const col = grid.geometry.getAttribute('color') as BufferAttribute;
    const major = new Color(palette.gridMajor);
    const minor = new Color(palette.gridMinor);
    // GridHelper: each line is 2 vertices; the centre line and the axes are the "major" colour.
    const half = divisions / 2;
    const perAxis = divisions + 1;
    for (let axis = 0; axis < 2; axis++) {
      for (let i = 0; i < perAxis; i++) {
        const c = i === half ? major : minor;
        const v = (axis * perAxis + i) * 2;
        col.setXYZ(v, c.r, c.g, c.b);
        col.setXYZ(v + 1, c.r, c.g, c.b);
      }
    }
    col.needsUpdate = true;
  };
  gridMats.push(grid.material as Material);

  // --- quad (group orientation = converted attitude; children placed in converted body frame) ---
  const quad = new Group();
  scene.add(quad);
  const bodyGeo = new BoxGeometry(BODY.y, BODY.z, BODY.x); // three axes: x = right, y = down(-), z = fwd(-)
  quad.add(new Mesh(bodyGeo, mat.body));

  const armLen = ARM;
  const armGeo = new CylinderGeometry(0.008, 0.008, armLen, 8);
  armGeo.translate(0, armLen / 2, 0); // base at origin, along +Y
  const rotorGeo = new CylinderGeometry(ROTOR_RADIUS, ROTOR_RADIUS, 0.004, 28);
  const bladeGeo = new BoxGeometry(2 * ROTOR_RADIUS * 0.95, 0.006, 0.014);
  const motorGeo = new CylinderGeometry(0.02, 0.02, 0.03, 12);
  const rotors: Group[] = [];
  const up = new Vector3(0, 1, 0);
  for (let i = 0; i < 4; i++) {
    const p = MOTOR_POS_FRD[i]!;
    const tp = nedToThree(p); // FRD -> three-axes, same map as NED
    const front = MOTOR_FRONT[i]!;
    const arm = new Mesh(armGeo, front ? mat.armFront : mat.arm);
    arm.quaternion.setFromUnitVectors(up, new Vector3(tp[0], tp[1], tp[2]).normalize());
    quad.add(arm);
    const motor = new Mesh(motorGeo, front ? mat.armFront : mat.arm);
    motor.position.set(tp[0], tp[1] + 0.0, tp[2]);
    quad.add(motor);
    const rotor = new Group();
    rotor.position.set(tp[0], tp[1] + 0.025, tp[2]); // above the motor (up = -down)
    rotor.add(new Mesh(rotorGeo, mat.rotor));
    const blade = new Mesh(bladeGeo, mat.rotorBlade);
    blade.position.y = 0.006;
    rotor.add(blade);
    quad.add(rotor);
    rotors.push(rotor);
  }
  const rotorAngle = [0, 0.7, 1.4, 2.1];

  // --- rod and mass (world space; mass position from telemetry massRel) ---
  const rodGeo = new CylinderGeometry(0.005, 0.005, 1, 8);
  const rod = new Mesh(rodGeo, mat.rod);
  scene.add(rod);
  const massGeo = new SphereGeometry(MASS_RADIUS, 20, 14);
  const mass = new Mesh(massGeo, mat.mass);
  scene.add(mass);

  // --- trail: BufferGeometry line, per-vertex RGBA fade ---
  const trailPos = new Float32Array(trailN * 3);
  const trailCol = new Float32Array(trailN * 4);
  const trailGeo = new BufferGeometry();
  trailGeo.setAttribute('position', new BufferAttribute(trailPos, 3));
  trailGeo.setAttribute('color', new BufferAttribute(trailCol, 4));
  const trail = new Line(trailGeo, trailMat);
  trail.frustumCulled = false;
  trail.visible = !reduced;
  scene.add(trail);
  let trailFilled = 0;
  let lastT = Number.NEGATIVE_INFINITY;
  const colorTrail = (): void => {
    const c = new Color(palette.trail);
    for (let i = 0; i < trailN; i++) {
      const a = (i / (trailN - 1)) ** 1.0; // oldest (index 0) is transparent
      trailCol[i * 4] = c.r;
      trailCol[i * 4 + 1] = c.g;
      trailCol[i * 4 + 2] = c.b;
      trailCol[i * 4 + 3] = a;
    }
    (trailGeo.getAttribute('color') as BufferAttribute).needsUpdate = true;
  };

  // --- theme ---
  const applyPalette = (p: ScenePalette): void => {
    palette = p;
    scene.background = new Color(p.background);
    mat.body.color.set(p.body);
    mat.arm.color.set(p.arm);
    mat.armFront.color.set(p.armFront);
    mat.rotor.color.set(p.rotor);
    mat.rotorBlade.color.set(p.rotor);
    mat.rod.color.set(p.rod);
    mat.mass.color.set(p.mass);
    hemi.color.set(p.hemiSky);
    hemi.groundColor.set(p.hemiGround);
    hemi.intensity = p.hemiIntensity;
    sun.intensity = p.dirIntensity;
    recolorGrid();
    colorTrail();
  };
  applyPalette(palette);

  // --- per-frame state ---
  const tmpQ = new Quaternion();
  const tmpV = new Vector3();
  const tmpDir = new Vector3();
  const tmpPrev = new Vector3();
  let lastRender = 0;
  let disposed = false;

  const render = (): void => {
    if (disposed) return;
    controls.update();
    renderer.render(scene, camera);
  };

  const update = (t: Telemetry): void => {
    if (disposed) return;
    const now = globalThis.performance ? globalThis.performance.now() : 0;
    const dtRender = lastRender === 0 ? 0 : Math.min(0.1, (now - lastRender) / 1000);
    lastRender = now;

    const qp = nedToThree(t.quadPos);
    quad.position.set(qp[0], qp[1], qp[2]);
    const qq = quatNedToThree(eulerZyxToQuat(t.roll, t.pitch, t.yaw));
    quad.quaternion.set(qq[0], qq[1], qq[2], qq[3]);

    // camera target follows the quad (keep the user's orbit offset)
    tmpPrev.copy(controls.target);
    tmpV.set(qp[0], qp[1] - 0.5, qp[2]);
    tmpV.sub(tmpPrev);
    controls.target.add(tmpV);
    camera.position.add(tmpV);

    // rod + mass
    const mr = nedToThree(t.massRel);
    const mp = tmpV.set(qp[0] + mr[0], qp[1] + mr[1], qp[2] + mr[2]);
    mass.position.copy(mp);
    tmpDir.set(mr[0], mr[1], mr[2]);
    const len = tmpDir.length();
    if (len > 1e-9) {
      tmpDir.multiplyScalar(1 / len);
      rod.scale.set(1, len, 1);
      rod.position.set(qp[0] + mr[0] / 2, qp[1] + mr[1] / 2, qp[2] + mr[2] / 2);
      tmpQ.setFromUnitVectors(up, tmpDir);
      rod.quaternion.copy(tmpQ);
    }

    // rotors
    if (!reduced) {
      for (let i = 0; i < 4; i++) {
        rotorAngle[i] = (rotorAngle[i] ?? 0) + MOTOR_SPIN_SIGN[i]! * ((t.motorOmega[i] ?? 0) / ROTOR_SPIN_DIV) * dtRender;
        rotors[i]!.rotation.y = rotorAngle[i]!;
      }
    }

    // trail
    if (!reduced) {
      if (t.t < lastT) trailFilled = 0; // reset / preset load
      if (trailFilled === 0 || t.t - lastT >= 0.0099) {
        if (trailFilled === 0) {
          for (let i = 0; i < trailN; i++) trailPos.set([mp.x, mp.y, mp.z], i * 3);
          trailFilled = 1;
        } else {
          trailPos.copyWithin(0, 3);
          trailPos.set([mp.x, mp.y, mp.z], (trailN - 1) * 3);
        }
        (trailGeo.getAttribute('position') as BufferAttribute).needsUpdate = true;
      }
    }
    lastT = t.t;
    render();
  };

  return {
    update,
    resize(width: number, height: number): void {
      const w = Math.max(1, Math.floor(width));
      const h = Math.max(1, Math.floor(height));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      controls.dispose();
      for (const g of [bodyGeo, armGeo, rotorGeo, bladeGeo, motorGeo, rodGeo, massGeo, trailGeo, grid.geometry]) g.dispose();
      for (const m of [...Object.values(mat), trailMat, ...gridMats]) m.dispose();
      renderer.dispose();
    },
    setReducedMotion(b: boolean): void {
      reduced = b;
      trail.visible = !b;
      if (b) {
        trailFilled = 0;
        for (const r of rotors) r.rotation.y = 0;
      }
      render();
    },
    setTheme(p: ScenePalette): void {
      applyPalette(p);
      render();
    },
    debugInfo() {
      return { clearColor: `#${(scene.background as Color).getHexString()}`, trailVisible: trail.visible };
    },
  };
}
