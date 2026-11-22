import { describe, expect, it } from 'vitest';
import {
  NED_TO_THREE_MATRIX,
  basisDeterminant,
  eulerZyxToQuat,
  nedToThree,
  quatNedToThree,
  rotateByQuat,
  type Vec3,
} from '../../src/view/frames';

const close = (a: readonly number[], b: readonly number[], tol = 1e-12) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThan(tol));
};

function matVec(m: readonly (readonly number[])[], v: Vec3): number[] {
  return m.map((r) => r[0]! * v[0] + r[1]! * v[1] + r[2]! * v[2]);
}

describe('nedToThree', () => {
  it('maps N, E, D to -Z, +X, -Y', () => {
    close(nedToThree([1, 0, 0]), [0, 0, -1]);
    close(nedToThree([0, 1, 0]), [1, 0, 0]);
    close(nedToThree([0, 0, 1]), [0, -1, 0]);
  });

  it('agrees with the basis matrix', () => {
    const v: Vec3 = [0.3, -1.2, 2.5];
    close(nedToThree(v), matVec(NED_TO_THREE_MATRIX, v));
  });

  it('is a proper rotation: det = +1 and N x E = D is preserved', () => {
    expect(basisDeterminant()).toBeCloseTo(1, 14);
    const n = nedToThree([1, 0, 0]);
    const e = nedToThree([0, 1, 0]);
    const cross = [
      n[1] * e[2] - n[2] * e[1],
      n[2] * e[0] - n[0] * e[2],
      n[0] * e[1] - n[1] * e[0],
    ];
    close(cross, nedToThree([0, 0, 1]));
  });
});

describe('quatNedToThree', () => {
  it('identity attitude stays identity', () => {
    const q = quatNedToThree([0, 0, 0, 1]);
    close(q, [0, 0, 0, 1]);
  });

  it('a 90 degree NED yaw (about D) is a -90 degree rotation about Three.js +Y', () => {
    const q = quatNedToThree(eulerZyxToQuat(0, 0, Math.PI / 2));
    const h = Math.SQRT1_2;
    // -90 deg about +Y: [0, -sin45, 0, cos45] (up to sign of the whole quaternion)
    const s = q[3] < 0 ? -1 : 1;
    close(q.map((c) => c * s), [0, -h, 0, h]);
    // rotating +X (east) by this quaternion gives +Z... check the vectors explicitly:
    // body forward (N) is yawed to East: three(-Z) -> three(+X)
    close(rotateByQuat(q, [0, 0, -1]), [1, 0, 0]);
  });

  it('is equivalent to R_three = M R_ned M^T for a general attitude', () => {
    const roll = 0.3, pitch = -0.2, yaw = 1.1;
    const qn = eulerZyxToQuat(roll, pitch, yaw);
    const qt = quatNedToThree(qn);
    // body-frame point p_b (FRD): NED world = R_ned p_b, then three = M * that.
    // Using the converted attitude on the converted body point must agree.
    for (const pb of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.2, -0.7, 0.4]] as Vec3[]) {
      const viaNed = nedToThree(rotateByQuat(qn, pb));
      const viaThree = rotateByQuat(qt, nedToThree(pb));
      close(viaThree, viaNed);
    }
  });

  it('a pitch up about body y (E) converts to a rotation about Three.js +X', () => {
    const q = quatNedToThree(eulerZyxToQuat(0, 0.4, 0));
    close(q.slice(0, 3), [Math.sin(0.2), 0, 0]);
    expect(q[3]).toBeCloseTo(Math.cos(0.2), 12);
  });
});
