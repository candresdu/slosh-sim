// Index constants for the 23-element continuous state vector.
// Same order as python/src/slosh/core/state.py. World NED, body FRD, gravity along +D.
//
//   P  (3)  quad position, NED [m]
//   V  (3)  quad velocity, NED [m/s]
//   Q  (4)  attitude quaternion body->NED, (w, x, y, z)
//   WB (3)  body angular velocity, FRD [rad/s]
//   N  (3)  unit vector from quad CG to the mass, NED
//   WP (3)  pendulum angular velocity, NED, kept perpendicular to n [rad/s]
//   OM (4)  rotor speeds [rad/s]

export const NX = 23;

export const P = 0;
export const V = 3;
export const Q = 6;
export const WB = 10;
export const N = 13;
export const WP = 16;
export const OM = 19;

// Individual component indices
export const PN = 0;
export const PE = 1;
export const PD = 2;
export const VN = 3;
export const VE = 4;
export const VD = 5;
export const QW = 6;
export const QX = 7;
export const QY = 8;
export const QZ = 9;
export const WBX = 10;
export const WBY = 11;
export const WBZ = 12;
export const NN = 13;
export const NE = 14;
export const ND = 15;
export const WPN = 16;
export const WPE = 17;
export const WPD = 18;
export const OM0 = 19;
