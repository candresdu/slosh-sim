"""Unit-vector pendulum + 6-DOF quadrotor dynamics (plain scalar floats, ``math`` only).

Frames: world NED, body FRD, gravity ``g`` along +D. State layout: see :mod:`slosh.core.state`.
The pendulum is a unit vector ``n`` (quad CG -> mass, NED) with angular velocity ``w_p``
(perpendicular to ``n``), so nothing is singular at hanging (theta = 0). The pivot is at the quad
CG, so the rod applies no torque on the airframe.

With ``mu = m_q m_p / m_T``, ``k = k_damp`` and ``F = R(q_att) [0, 0, -sum k_f Omega_i^2]``::

    n_dot   = w_p x n
    F_d     = -(k/L) (w_p x n)                      # damping force on the mass
    T_r     = mu (L |w_p|^2 - (n . F)/m_q)          # rod tension
    w_p_dot = (1/L) n x (F_d/mu - F/m_q)
    v_dot   = (F + T_r n - F_d)/m_q + g e_D
    w_b_dot = J^-1 (tau - w_b x J w_b)
    q_dot   = 1/2 q (x) [0, w_b]
    Om_dot  = (Om_cmd - Om)/tau_m

``tau`` (body torque) and ``Om_cmd`` come from the held controller output ``Hold``.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import NamedTuple

from ..params import Params
from .state import NX


class Hold(NamedTuple):
    """Zero-order-held controller output: body torque [N m, FRD], rotor commands [rad/s]."""

    tau: Sequence[float]
    omega_cmd: Sequence[float]


def thrust_force_ned(x: Sequence[float], k_f: float) -> tuple[float, float, float, float]:
    """Return ``(Fn, Fe, Fd, T)``: thrust force in NED and total thrust ``T = sum k_f Omega^2``."""
    T = k_f * (x[19] * x[19] + x[20] * x[20] + x[21] * x[21] + x[22] * x[22])
    w, qx, qy, qz = x[6], x[7], x[8], x[9]
    # F = R [0, 0, -T] = -T * (third column of R)
    return (
        -T * (2.0 * (qx * qz + w * qy)),
        -T * (2.0 * (qy * qz - w * qx)),
        -T * (1.0 - 2.0 * (qx * qx + qy * qy)),
        T,
    )


def deriv(x: Sequence[float], u_hold: Hold, p: Params) -> list[float]:
    """Continuous-state derivative of the 23-element state ``x`` under held input ``u_hold``."""
    m_q = p.vehicle.m_q
    m_p = p.pendulum.m_p
    L = p.pendulum.L
    k = p.pendulum.k_damp
    g = p.sim.g
    Jx, Jy, Jz = p.vehicle.J
    m_T = m_q + m_p
    mu = m_q * m_p / m_T

    vn, ve, vd = x[3], x[4], x[5]
    qw, qx, qy, qz = x[6], x[7], x[8], x[9]
    wx, wy, wz = x[10], x[11], x[12]
    nn, ne, nd = x[13], x[14], x[15]
    pn, pe, pd = x[16], x[17], x[18]

    Fn, Fe, Fd, _T = thrust_force_ned(x, p.vehicle.k_f)

    # n_dot = w_p x n
    ndn = pe * nd - pd * ne
    nde = pd * nn - pn * nd
    ndd = pn * ne - pe * nn

    # damping force on the mass
    kL = k / L
    fdn, fde, fdd = -kL * ndn, -kL * nde, -kL * ndd

    wp2 = pn * pn + pe * pe + pd * pd
    n_dot_F = nn * Fn + ne * Fe + nd * Fd
    Tr = mu * (L * wp2 - n_dot_F / m_q)

    # w_p_dot = (1/L) n x (F_d/mu - F/m_q)
    ax = fdn / mu - Fn / m_q
    ay = fde / mu - Fe / m_q
    az = fdd / mu - Fd / m_q
    wpn = (ne * az - nd * ay) / L
    wpe = (nd * ax - nn * az) / L
    wpd = (nn * ay - ne * ax) / L

    # translational acceleration
    an = (Fn + Tr * nn - fdn) / m_q
    ae = (Fe + Tr * ne - fde) / m_q
    ad = (Fd + Tr * nd - fdd) / m_q + g

    # rigid-body rotation (FRD)
    tx, ty, tz = u_hold.tau
    wbx = (tx - (wy * Jz * wz - wz * Jy * wy)) / Jx
    wby = (ty - (wz * Jx * wx - wx * Jz * wz)) / Jy
    wbz = (tz - (wx * Jy * wy - wy * Jx * wx)) / Jz

    # quaternion kinematics: q_dot = 1/2 q (x) [0, w_b]
    qdw = 0.5 * (-qx * wx - qy * wy - qz * wz)
    qdx = 0.5 * (qw * wx + qy * wz - qz * wy)
    qdy = 0.5 * (qw * wy + qz * wx - qx * wz)
    qdz = 0.5 * (qw * wz + qx * wy - qy * wx)

    inv_tm = 1.0 / p.motor.tau
    cmd = u_hold.omega_cmd

    dx = [0.0] * NX
    dx[0], dx[1], dx[2] = vn, ve, vd
    dx[3], dx[4], dx[5] = an, ae, ad
    dx[6], dx[7], dx[8], dx[9] = qdw, qdx, qdy, qdz
    dx[10], dx[11], dx[12] = wbx, wby, wbz
    dx[13], dx[14], dx[15] = ndn, nde, ndd
    dx[16], dx[17], dx[18] = wpn, wpe, wpd
    dx[19] = (cmd[0] - x[19]) * inv_tm
    dx[20] = (cmd[1] - x[20]) * inv_tm
    dx[21] = (cmd[2] - x[21]) * inv_tm
    dx[22] = (cmd[3] - x[22]) * inv_tm
    return dx


# --- display helpers ---------------------------------------------------------------------------
def theta_phi(x: Sequence[float]) -> tuple[float, float]:
    """Display-only spherical angles: ``theta = acos(clamp(n_D))``, ``phi = atan2(n_E, n_N)``."""
    nd = max(-1.0, min(1.0, x[15]))
    return math.acos(nd), math.atan2(x[14], x[13])


def mass_relative(x: Sequence[float], L: float) -> tuple[float, float, float]:
    """Mass position relative to the quad CG, NED [m]."""
    return (L * x[13], L * x[14], L * x[15])
