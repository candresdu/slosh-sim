"""Initial conditions from pendulum spherical coordinates."""

from __future__ import annotations

import math

from ..params import Params
from .state import NX


def pendulum_vectors(
    theta: float, theta_dot: float, phi: float, phi_dot: float
) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    """Return ``(n, w_p)`` (NED) for the angles ``(theta, theta_dot, phi, phi_dot)``.

    ``n = (sin t cos p, sin t sin p, cos t)``, ``n_dot = t_dot * t_hat + sin t * p_dot * p_hat``
    with ``t_hat = (cos t cos p, cos t sin p, -sin t)`` and ``p_hat = (-sin p, cos p, 0)``;
    ``w_p = n x n_dot``. ``theta = 0`` is hanging straight down (+D).
    """
    st, ct = math.sin(theta), math.cos(theta)
    sp, cp = math.sin(phi), math.cos(phi)
    n = (st * cp, st * sp, ct)
    thx, thy, thz = ct * cp, ct * sp, -st
    phx, phy = -sp, cp
    ndx = theta_dot * thx + st * phi_dot * phx
    ndy = theta_dot * thy + st * phi_dot * phy
    ndz = theta_dot * thz
    w = (
        n[1] * ndz - n[2] * ndy,
        n[2] * ndx - n[0] * ndz,
        n[0] * ndy - n[1] * ndx,
    )
    return n, w


def hover_omega(p: Params) -> float:
    """Rotor speed [rad/s] at which total thrust balances the weight of quad + mass."""
    m_T = p.vehicle.m_q + p.pendulum.m_p
    return math.sqrt(m_T * p.sim.g / (4.0 * p.vehicle.k_f))


def initial_state(
    p: Params,
    theta: float = 0.0,
    theta_dot: float = 0.0,
    phi: float = 0.0,
    phi_dot: float = 0.0,
    p_q: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> list[float]:
    """Level, at-rest quad at ``p_q`` with hover rotor speeds and the given pendulum state."""
    n, w = pendulum_vectors(theta, theta_dot, phi, phi_dot)
    x = [0.0] * NX
    x[0:3] = p_q
    x[6] = 1.0  # identity attitude (level, heading north)
    x[13:16] = n
    x[16:19] = w
    om = hover_omega(p)
    x[19:23] = [om, om, om, om]
    return x
