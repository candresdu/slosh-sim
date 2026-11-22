// Frame conversion between the simulation frames and the Three.js scene frame. Pure maths, no WebGL.
//
//   World:  NED (x North, y East, z Down).     Body: FRD (x Forward, y Right, z Down).
//   Three.js: Y-up, X right, Z toward the viewer.
//
// The conversion happens only at render time:  three = M * ned  with
//   N -> -Z,  E -> +X,  D -> -Y,   i.e. three = (e, -d, -n).
// M is a proper rotation (det = +1): (-Z) x (+X) = -Y matches N x E = D.
// Attitudes convert by conjugation: R_three = M R_ned M^T, i.e. q_three = Q_M q_ned Q_M^-1.
// A body-frame (FRD) point converts with the same map, because the body frame is drawn
// attached to the quad group whose orientation already carries the conjugated attitude.

export type Vec3 = readonly [number, number, number];
/** Quaternion as [x, y, z, w] (Three.js component order). */
export type QuatXyzw = [number, number, number, number];

/** Constant basis matrix M (row-major): three = M * ned. */
export const NED_TO_THREE_MATRIX: readonly (readonly [number, number, number])[] = [
  [0, 1, 0],
  [0, 0, -1],
  [-1, 0, 0],
];

export function basisDeterminant(): number {
  const m = NED_TO_THREE_MATRIX;
  const r0 = m[0]!;
  const r1 = m[1]!;
  const r2 = m[2]!;
  return (
    r0[0] * (r1[1] * r2[2] - r1[2] * r2[1]) -
    r0[1] * (r1[0] * r2[2] - r1[2] * r2[0]) +
    r0[2] * (r1[0] * r2[1] - r1[1] * r2[0])
  );
}

/** Position / vector: [n, e, d] -> [x, y, z] of Three.js = [e, -d, -n]. */
export function nedToThree(v: Vec3): [number, number, number] {
  return [v[1], -v[2], -v[0]];
}

/** Same map written into an existing array (no allocation). */
export function nedToThreeInto(out: number[] | Float32Array | Float64Array, o: number, n: number, e: number, d: number): void {
  out[o] = e;
  out[o + 1] = -d;
  out[o + 2] = -n;
}

function quatMul(a: QuatXyzw, b: QuatXyzw): QuatXyzw {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function quatConj(q: QuatXyzw): QuatXyzw {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** Rotation matrix -> unit quaternion (Shepperd's method). */
function quatFromMatrix(m: readonly (readonly number[])[]): QuatXyzw {
  const m00 = m[0]![0]!, m01 = m[0]![1]!, m02 = m[0]![2]!;
  const m10 = m[1]![0]!, m11 = m[1]![1]!, m12 = m[1]![2]!;
  const m20 = m[2]![0]!, m21 = m[2]![1]!, m22 = m[2]![2]!;
  const tr = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  return [x, y, z, w];
}

/** Constant basis quaternion Q_M of the matrix M. */
export const NED_TO_THREE_QUAT: Readonly<QuatXyzw> = quatFromMatrix(NED_TO_THREE_MATRIX);

/**
 * Attitude conversion: quaternion of R_ned (body -> NED) to the quaternion of
 * R_three = M R_ned M^T (body -> Three.js), by conjugation with Q_M. Input and output [x, y, z, w].
 */
export function quatNedToThree(q: Readonly<QuatXyzw>): QuatXyzw {
  const qm = NED_TO_THREE_QUAT as QuatXyzw;
  return quatMul(quatMul(qm, q as QuatXyzw), quatConj(qm));
}

/** ZYX (yaw-pitch-roll) Euler angles to the quaternion of body -> NED, [x, y, z, w]. */
export function eulerZyxToQuat(roll: number, pitch: number, yaw: number): QuatXyzw {
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  return [
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
    cr * cp * cy + sr * sp * sy,
  ];
}

/** Rotate vector v by unit quaternion q ([x, y, z, w]). */
export function rotateByQuat(q: Readonly<QuatXyzw>, v: Vec3): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + qy * tz - qz * ty,
    v[1] + qw * ty + qz * tx - qx * tz,
    v[2] + qw * tz + qx * ty - qy * tx,
  ];
}
