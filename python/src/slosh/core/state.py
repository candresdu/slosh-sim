"""Index constants for the 23-element continuous state vector.

Frames: world NED, body FRD, gravity ``g`` along +D.

======  ======  ==================================================================
slice   size    meaning
======  ======  ==================================================================
P       3       quad position p_q, NED [m]
V       3       quad velocity v_q, NED [m/s]
Q       4       attitude quaternion body->NED, (w, x, y, z)
WB      3       body angular velocity omega_b, FRD [rad/s]
N       3       unit vector from quad CG to the mass, NED
WP      3       pendulum angular velocity omega_p, NED, kept perpendicular to n
OM      4       rotor speeds Omega_i [rad/s]
======  ======  ==================================================================
"""

NX = 23

P = 0
V = 3
Q = 6
WB = 10
N = 13
WP = 16
OM = 19

# Individual component indices (handy for tests and the TS mirror)
PN, PE, PD = 0, 1, 2
VN, VE, VD = 3, 4, 5
QW, QX, QY, QZ = 6, 7, 8, 9
WBX, WBY, WBZ = 10, 11, 12
NN, NE, ND = 13, 14, 15
WPN, WPE, WPD = 16, 17, 18
OM0 = 19
