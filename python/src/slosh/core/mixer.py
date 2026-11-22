"""X-configuration mixer (plain scalar floats, ``math`` only).

Layout (FRD body frame, x forward, y right) is inferred from the R-1 sign rules (best effort, not
a replica of R-1 Fig 3): M4 front-left, M3 front-right, M1 rear-left, M2 rear-right, each at
body position ``(+-d, +-d)`` with ``d = arm / sqrt(2)``. Sign rules:

* +thrust raises all four motors;
* +roll raises motors 1 and 4 and lowers 2 and 3;
* +pitch raises 3 and 4 and lowers 1 and 2;
* +yaw raises 1 and 3 and lowers 2 and 4.

With ``T_i = k_f Omega_i^2`` and ``kappa = k_tau / k_f``::

    f   = sum T_i
    tau_x = d (T1 + T4 - T2 - T3)
    tau_y = d (T3 + T4 - T1 - T2)
    tau_z = kappa (T1 - T2 + T3 - T4)

Motor lag is applied in the dynamics state, not here.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

from ..params import Params

# Single layout table, one row per motor (index 0..3 = M1..M4):
# (name, body x [forward, in units of d], body y [right, in units of d], s_roll, s_pitch, s_yaw)
MOTOR_LAYOUT: tuple[tuple[str, int, int, int, int, int], ...] = (
    ("M1 rear-left", -1, -1, +1, -1, +1),
    ("M2 rear-right", -1, +1, -1, -1, -1),
    ("M3 front-right", +1, +1, -1, +1, +1),
    ("M4 front-left", +1, -1, +1, +1, -1),
)

S_ROLL = tuple(float(m[3]) for m in MOTOR_LAYOUT)
S_PITCH = tuple(float(m[4]) for m in MOTOR_LAYOUT)
S_YAW = tuple(float(m[5]) for m in MOTOR_LAYOUT)


def moment_arm(p: Params) -> float:
    """Body-axis moment arm ``d = arm / sqrt(2)`` [m]."""
    return p.vehicle.arm / math.sqrt(2.0)


def forces_torques(omega: Sequence[float], p: Params) -> tuple[float, float, float, float]:
    """Total thrust and body torques ``(f, tau_x, tau_y, tau_z)`` from rotor speeds [rad/s]."""
    k_f = p.vehicle.k_f
    kappa = p.vehicle.k_tau / k_f
    d = moment_arm(p)
    t1, t2, t3, t4 = (k_f * w * w for w in omega)
    f = t1 + t2 + t3 + t4
    tau_x = d * (t1 + t4 - t2 - t3)
    tau_y = d * (t3 + t4 - t1 - t2)
    tau_z = kappa * (t1 - t2 + t3 - t4)
    return f, tau_x, tau_y, tau_z


def mix(
    f: float, tau_x: float, tau_y: float, tau_z: float, p: Params
) -> tuple[float, float, float, float]:
    """Rotor speed commands [rad/s] for thrust ``f`` and torques; thrust is clamped per motor."""
    k_f = p.vehicle.k_f
    kappa = p.vehicle.k_tau / k_f
    d = moment_arm(p)
    t_lo = k_f * p.motor.omegaMin * p.motor.omegaMin
    t_hi = k_f * p.motor.omegaMax * p.motor.omegaMax
    base = f / 4.0
    a_r = tau_x / (4.0 * d)
    a_p = tau_y / (4.0 * d)
    a_y = tau_z / (4.0 * kappa)
    out = []
    for i in range(4):
        t = base + S_ROLL[i] * a_r + S_PITCH[i] * a_p + S_YAW[i] * a_y
        t = min(max(t, t_lo), t_hi)
        out.append(math.sqrt(t / k_f))
    return out[0], out[1], out[2], out[3]


def motor_saturated(f: float, tau_x: float, tau_y: float, tau_z: float, p: Params) -> bool:
    """Debug only: True if :func:`mix` clamps any motor thrust at omegaMin or omegaMax."""
    k_f = p.vehicle.k_f
    kappa = p.vehicle.k_tau / k_f
    d = moment_arm(p)
    t_lo = k_f * p.motor.omegaMin * p.motor.omegaMin
    t_hi = k_f * p.motor.omegaMax * p.motor.omegaMax
    base = f / 4.0
    a_r = tau_x / (4.0 * d)
    a_p = tau_y / (4.0 * d)
    a_y = tau_z / (4.0 * kappa)
    for i in range(4):
        t = base + S_ROLL[i] * a_r + S_PITCH[i] * a_p + S_YAW[i] * a_y
        if t < t_lo or t > t_hi:
            return True
    return False
