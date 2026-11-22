"""Tests for the unit-vector pendulum + 6-DOF quad dynamics, RK4 and RNG."""

from __future__ import annotations

import dataclasses
import math

import numpy as np

from slosh import symbolic as S
from slosh.core.dynamics import Hold, deriv, mass_relative, theta_phi
from slosh.core.initial import hover_omega, initial_state, pendulum_vectors
from slosh.core.rk4 import rk4_step
from slosh.core.rng import Rng
from slosh.params import Params, load_params


def _with_damping(p: Params, k: float) -> Params:
    return dataclasses.replace(p, pendulum=dataclasses.replace(p.pendulum, k_damp=k))


def _quat_aligning_z(d: np.ndarray) -> list[float]:
    """Quaternion (w, x, y, z) rotating e_z onto the unit vector ``d`` (shortest arc)."""
    ez = np.array([0.0, 0.0, 1.0])
    axis = np.cross(ez, d)
    q = np.array([1.0 + ez @ d, *axis])
    return list(q / np.linalg.norm(q))


# --- Eq. 5 cross-check ---------------------------------------------------------------------------
def test_unitvector_vs_eq5() -> None:
    base = load_params()
    rng = np.random.default_rng(12345)
    worst = 0.0
    for i in range(500):
        p = _with_damping(base, 0.0 if i % 2 == 0 else 0.05)
        m_T = p.vehicle.m_q + p.pendulum.m_p
        # R-1 (z-up) generalized state
        theta = rng.uniform(0.05, 1.2)
        phi = rng.uniform(-math.pi, math.pi)
        thd, phd = rng.uniform(-1.5, 1.5, 2)
        vel = rng.uniform(-2, 2, 3)
        U = np.array([rng.uniform(-3, 3), rng.uniform(-3, 3), m_T * 9.80665 + rng.uniform(-3, 3)])
        acc = S.eq5_accelerations([0, 0, 0, theta, phi], [*vel, thd, phd], U, p)

        # map to NED: N = x, E = -y, D = -z  (theta unchanged, phi -> -phi)
        phi_n, phd_n = -phi, -phd
        n, wp = pendulum_vectors(theta, thd, phi_n, phd_n)
        F = np.array([U[0], -U[1], -U[2]])
        T = float(np.linalg.norm(F))
        d = -F / T  # body -z axis is along F, i.e. R e_z = -F/|F|
        x = initial_state(p)
        x[3:6] = [vel[0], -vel[1], -vel[2]]
        x[6:10] = _quat_aligning_z(d)
        x[13:16] = n
        x[16:19] = wp
        om = math.sqrt(T / (4 * p.vehicle.k_f))
        x[19:23] = [om] * 4
        dx = deriv(x, Hold((0, 0, 0), (om,) * 4), p)

        # translational
        got_v = np.array(dx[3:6])
        want_v = np.array([acc[0], -acc[1], -acc[2]])
        # angular: recover theta_dd, phi_dd from n_ddot = w_p_dot x n + w_p x n_dot
        nv, wpv, wpd = np.array(n), np.array(wp), np.array(dx[16:19])
        ndot = np.cross(wpv, nv)
        nddot = np.cross(wpd, nv) + np.cross(wpv, ndot)
        st, ct = math.sin(theta), math.cos(theta)
        th_dd = -(nddot[2] + ct * thd**2) / st
        phi_hat = np.array([-math.sin(phi_n), math.cos(phi_n), 0.0])
        phi_dd_n = (phi_hat @ nddot - 2 * ct * thd * phd_n) / st
        worst = max(
            worst,
            float(np.max(np.abs(got_v - want_v))),
            abs(th_dd - acc[3]),
            abs(-phi_dd_n - acc[4]),
        )
    assert worst < 1e-6, worst


# --- energy ----------------------------------------------------------------------------------
def _hover_hold(p: Params) -> Hold:
    om = hover_omega(p)
    return Hold((0.0, 0.0, 0.0), (om,) * 4)


def _energy(x: list[float], p: Params) -> float:
    """E = KE + PE_g - F.p_q with F = -m_T g e_D (exact hover force)."""
    m_q, m_p, L, g = p.vehicle.m_q, p.pendulum.m_p, p.pendulum.L, p.sim.g
    m_T = m_q + m_p
    vq = np.array(x[3:6])
    n = np.array(x[13:16])
    wp = np.array(x[16:19])
    vm = vq + L * np.cross(wp, n)
    ke = 0.5 * m_q * vq @ vq + 0.5 * m_p * vm @ vm
    pe = -g * (m_q * x[2] + m_p * (x[2] + L * n[2]))  # height = -D
    f_dot_p = -m_T * g * x[2]
    return float(ke + pe - f_dot_p)


def test_energy() -> None:
    p = _with_damping(load_params(), 0.0)
    hold = _hover_hold(p)
    x = initial_state(p, theta=0.2, phi_dot=0.6)
    e0 = _energy(x, p)
    e_rest = -p.pendulum.m_p * p.sim.g * p.pendulum.L
    scale = e0 - e_rest
    assert scale > 0
    worst = 0.0
    for i in range(60000):
        x = rk4_step(x, 0.001, hold, p)
        if i % 100 == 0:
            worst = max(worst, abs(_energy(x, p) - e0))
    worst = max(worst, abs(_energy(x, p) - e0))
    assert worst / scale < 1e-3, worst / scale


def test_slosh_frequency() -> None:
    p = _with_damping(load_params(), 0.0)
    hold = _hover_hold(p)
    x = initial_state(p, theta=0.05)
    dt = 0.001
    crossings: list[float] = []
    prev = x[13]
    for i in range(1, 12001):
        x = rk4_step(x, dt, hold, p)
        cur = x[13]
        if prev > 0.0 >= cur or prev < 0.0 <= cur:  # zero crossing, linear interpolation
            crossings.append((i - 1 + prev / (prev - cur)) * dt)
        prev = cur
    assert len(crossings) >= 10
    # successive crossings are half a period apart
    half = (crossings[-1] - crossings[0]) / (len(crossings) - 1)
    freq = 1.0 / (2.0 * half)
    expected = math.sqrt(
        p.sim.g * (p.vehicle.m_q + p.pendulum.m_p) / (p.vehicle.m_q * p.pendulum.L)
    )
    assert abs(expected / (2 * math.pi) - 0.507) < 1e-3
    assert abs(freq - 0.51) < 0.02
    assert abs(freq - expected / (2 * math.pi)) < 1e-3


# --- constraints -----------------------------------------------------------------------------
def test_constraint_maintenance() -> None:
    p = load_params()
    rng = np.random.default_rng(7)
    x = initial_state(p, theta=0.7, theta_dot=1.0, phi=0.4, phi_dot=1.5)
    x[10:13] = rng.uniform(-2, 2, 3)
    x[6:10] = list(rng.normal(size=4) / 2.0)
    q = np.array(x[6:10])
    x[6:10] = list(q / np.linalg.norm(q))
    om0 = hover_omega(p)
    hold = Hold((0, 0, 0), (om0,) * 4)
    for i in range(10000):
        if i % 50 == 0:
            tau = rng.uniform(-0.05, 0.05, 3)
            hold = Hold(tuple(tau), tuple(om0 * rng.uniform(0.8, 1.2, 4)))
        x = rk4_step(x, 0.001, hold, p)
        assert abs(math.sqrt(sum(v * v for v in x[13:16])) - 1) < 1e-12
        assert abs(sum(x[16 + j] * x[13 + j] for j in range(3))) < 1e-12
        assert abs(math.sqrt(sum(v * v for v in x[6:10])) - 1) < 1e-12
    assert all(math.isfinite(v) for v in x)


def test_initial_state_and_display_helpers() -> None:
    p = load_params()
    th, thd, ph, phd = 0.2, 0.3, 0.9, 0.6
    x = initial_state(p, th, thd, ph, phd)
    t2, p2 = theta_phi(x)
    assert abs(t2 - th) < 1e-12 and abs(p2 - ph) < 1e-12
    rel = mass_relative(x, p.pendulum.L)
    assert abs(rel[2] - math.cos(th)) < 1e-12
    n = np.array(x[13:16])
    wp = np.array(x[16:19])
    ndot = np.cross(wp, n)
    # theta_dot = -ndot_D / sin(theta); phi_dot = (n_N ndot_E - n_E ndot_N)/(n_N^2 + n_E^2)
    assert abs(-ndot[2] / math.sin(th) - thd) < 1e-12
    assert abs((n[0] * ndot[1] - n[1] * ndot[0]) / (n[0] ** 2 + n[1] ** 2) - phd) < 1e-12
    assert abs(wp @ n) < 1e-15
    # theta = 0 is well defined
    x0 = initial_state(p, 0.0, 0.0, 0.0, 0.6)
    assert x0[13:16] == [0.0, 0.0, 1.0]
    # hover thrust balances weight
    k_f = p.vehicle.k_f
    T = k_f * sum(v * v for v in x[19:23])
    assert abs(T - (p.vehicle.m_q + p.pendulum.m_p) * p.sim.g) < 1e-9


# --- RNG ---------------------------------------------------------------------------------------
def _reference_xoshiro(seed: int, count: int) -> list[int]:
    """Independent implementation (numpy uint32 arithmetic) of splitmix32 + xoshiro128**."""
    u32 = np.uint32

    def rotl(v: np.uint32, r: int) -> np.uint32:
        return u32((int(v) << r | int(v) >> (32 - r)) & 0xFFFFFFFF)

    with np.errstate(over="ignore"):
        a = u32(seed)
        s = []
        for _ in range(4):
            a = u32(a + u32(0x9E3779B9))
            t = u32(a ^ (a >> u32(16)))
            t = u32(t * u32(0x21F0AAAD))
            t = u32(t ^ (t >> u32(15)))
            t = u32(t * u32(0x735A2D97))
            s.append(u32(t ^ (t >> u32(15))))
        out = []
        for _ in range(count):
            res = u32(rotl(u32(s[1] * u32(5)), 7) * u32(9))
            t = u32(s[1] << u32(9))
            s[2] ^= s[0]
            s[3] ^= s[1]
            s[1] ^= s[2]
            s[0] ^= s[3]
            s[2] ^= t
            s[3] = rotl(s[3], 11)
            out.append(int(res))
    return out


EXPECTED_SEED1 = [
    393288148,
    2174103013,
    3814759091,
    2092745082,
    1865176206,
    2179171167,
    3207394750,
    2858353069,
]


def test_rng() -> None:
    r = Rng(1)
    got = [r.next_u32() for _ in range(8)]
    assert got == _reference_xoshiro(1, 8)
    assert got == EXPECTED_SEED1  # frozen values, to be matched bit for bit by the TS port
    # determinism
    r1 = Rng(1)
    assert [r1.next_u32() for _ in range(3)] == got[:3]
    r2 = Rng(2)
    assert [r2.next_u32() for _ in range(3)] != got[:3]
    # uniform stays strictly inside (0, 1)
    r = Rng(5)
    assert all(0.0 < r.uniform() < 1.0 for _ in range(1000))
    # Box-Muller: second value cached, so two calls consume two uniforms
    a, b = Rng(3), Rng(3)
    z0, z1 = a.normal(), a.normal()
    u1, u2 = b.uniform(), b.uniform()
    rad = math.sqrt(-2 * math.log(u1))
    assert z0 == rad * math.cos(2 * math.pi * u2)
    assert z1 == rad * math.sin(2 * math.pi * u2)
    # statistics
    r = Rng(42)
    zs = np.array([r.normal() for _ in range(20000)])
    assert abs(zs.mean()) < 0.03 and abs(zs.std() - 1) < 0.03
