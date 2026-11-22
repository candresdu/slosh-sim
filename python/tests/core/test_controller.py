"""Tests for the two-loop PD controller (closed loop wired to mixer + dynamics + RK4)."""

from __future__ import annotations

import dataclasses
import math

from slosh.core.controller import Controller, Meas, Ref, euler_zyx, meas_from_state
from slosh.core.initial import initial_state
from slosh.core.rk4 import rk4_step
from slosh.params import Params, load_params

P = load_params()
Q0 = (1.0, 0.0, 0.0, 0.0)
Z3 = (0.0, 0.0, 0.0)


def _meas(pos: tuple[float, float, float] = Z3) -> Meas:
    return Meas(pos=pos, vel=Z3, q=Q0, w_b=Z3)


def _with_sensing(p: Params, **kw: object) -> Params:
    return dataclasses.replace(p, sensing=dataclasses.replace(p.sensing, **kw))


def run_closed_loop(
    p: Params,
    x0: list[float],
    ref: Ref,
    seconds: float,
    gs: float = 1.0,
    ctrl: Controller | None = None,
) -> tuple[list[float], list[list[float]]]:
    """Controller -> mixer -> 10 x RK4 per 10 ms tick. Returns final state and per-tick states."""
    ctrl = ctrl or Controller(p)
    x = list(x0)
    hist = []
    for _ in range(round(seconds * p.control.rateHz)):
        out = ctrl.step(meas_from_state(x), ref, gs)
        for _ in range(p.sim.controlDecimation):
            x = rk4_step(x, p.sim.dt, out.hold, p)
        hist.append(x)
    return x, hist


def test_euler_extraction() -> None:
    r, pch, y = 0.1, -0.2, 0.3
    cr, sr, cp, sp, cy, sy = (
        math.cos(r / 2),
        math.sin(r / 2),
        math.cos(pch / 2),
        math.sin(pch / 2),
        math.cos(y / 2),
        math.sin(y / 2),
    )
    q = (
        cr * cp * cy + sr * sp * sy,
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
    )
    got = euler_zyx(q)
    for a, b in zip(got, (r, pch, y), strict=True):
        assert abs(a - b) < 1e-12


def test_signs() -> None:
    c = Controller(P)
    out = c.step(_meas((-0.1, 0.0, 0.0)), Ref(), 1.0, (1.0, 1.0))  # ref - pos = +0.1 in x
    assert out.pitch_c < 0.0 and out.u[0] > 0.0 and abs(out.roll_c) < 1e-12
    c = Controller(P)
    out = c.step(_meas((0.0, -0.1, 0.0)), Ref(), 1.0, (1.0, 1.0))
    assert out.roll_c > 0.0 and out.u[1] > 0.0 and abs(out.pitch_c) < 1e-12


def test_gain_shift_and_kT_scale_u() -> None:
    base = Controller(P).step(_meas((-0.1, -0.1, 0.0)), Ref(), 1.0, (1.0, 1.0))
    out = Controller(P).step(_meas((-0.1, -0.1, 0.0)), Ref(), 2.0, (0.5, 1.5))
    assert abs(out.u[0] - base.u[0]) < 1e-12  # 2 * 0.5
    assert abs(out.u[1] - 3.0 * base.u[1]) < 1e-12  # 2 * 1.5


def test_saturation_exact() -> None:
    out = Controller(P).step(_meas((-10.0, -10.0, 0.0)), Ref(), 1.0, (1.0, 1.0))
    assert out.pitch_c == -0.35 and out.roll_c == 0.35
    assert abs(out.u[0]) > 0.35 * P.sim.g  # u is exposed pre-saturation
    out = Controller(P).step(_meas((10.0, 10.0, 0.0)), Ref(), 1.0, (1.0, 1.0))
    assert out.pitch_c == 0.35 and out.roll_c == -0.35


def test_yaw_aligned_frame() -> None:
    # heading east (yaw = +90 deg): a north error is a body -y (left) error -> roll_c < 0
    h = math.sqrt(0.5)
    m = Meas(pos=(-0.1, 0.0, 0.0), vel=Z3, q=(h, 0.0, 0.0, h), w_b=Z3)
    out = Controller(P).step(m, Ref(yaw=math.pi / 2), 1.0, (1.0, 1.0))
    assert abs(out.pitch_c) < 1e-9 and out.roll_c < 0.0


def test_altitude_sign_ned() -> None:
    c = Controller(P)
    hover = c.step(_meas(), Ref(), 1.0).f
    assert abs(hover - (P.vehicle.m_q + P.pendulum.m_p) * P.sim.g) < 1e-9
    # quad is above the reference (pd = -0.1, ref_d = 0): thrust must drop
    assert c.step(_meas((0.0, 0.0, -0.1)), Ref(), 1.0).f < hover
    assert c.step(_meas((0.0, 0.0, 0.1)), Ref(), 1.0).f > hover


def test_thrust_clamped() -> None:
    out = Controller(P).step(_meas((0.0, 0.0, 100.0)), Ref(), 1.0)
    assert out.f == 4.0 * P.vehicle.k_f * P.motor.omegaMax**2


def test_hover_is_equilibrium() -> None:
    x0 = initial_state(P)
    x, _ = run_closed_loop(P, x0, Ref(), 5.0)
    assert max(abs(v) for v in x[0:3]) < 1e-6
    assert max(abs(v) for v in x[10:13]) < 1e-6


def test_closed_loop_offset_recovery() -> None:
    x0 = initial_state(P, p_q=(0.2, 0.2, 0.0))
    x, hist = run_closed_loop(P, x0, Ref(), 20.0, gs=1.0)
    assert abs(x[0]) < 0.02 and abs(x[1]) < 0.02 and abs(x[2]) < 0.02
    # stable throughout: attitude stays small, no blow-up
    assert max(abs(euler_zyx(s[6:10])[0]) for s in hist) < 0.35
    assert max(abs(euler_zyx(s[6:10])[1]) for s in hist) < 0.35


def test_closed_loop_altitude_and_yaw() -> None:
    x0 = initial_state(P, p_q=(0.0, 0.0, 0.2))
    x0[9] = 0.01  # small yaw offset (quaternion z); renormalized by rk4
    x, _ = run_closed_loop(P, x0, Ref(), 15.0)
    assert abs(x[2]) < 0.02
    assert abs(euler_zyx(x[6:10])[2]) < 0.02


def test_latency_uses_measurement_from_3_ticks_ago() -> None:
    p = _with_sensing(P, latencyMs=30)
    c = Controller(p)
    assert c.delay_ticks == 3
    xs = [-0.01 * (k + 1) for k in range(10)]  # scripted x positions
    outs = [c.step(_meas((x, 0.0, 0.0)), Ref(), 1.0) for x in xs]
    for k in range(3, 10):
        assert outs[k].sensed.pos[0] == xs[k - 3]
        ref_out = Controller(P).step(_meas((xs[k - 3], 0.0, 0.0)), Ref(), 1.0)
        assert outs[k].pitch_c == ref_out.pitch_c
    # warm-up: oldest available sample
    assert outs[0].sensed.pos[0] == xs[0] and outs[2].sensed.pos[0] == xs[0]


def test_latency_rounding_and_default_off() -> None:
    assert Controller(P).delay_ticks == 0
    assert Controller(_with_sensing(P, latencyMs=24)).delay_ticks == 2
    assert Controller(_with_sensing(P, latencyMs=26)).delay_ticks == 3


def test_noise_off_by_default_and_deterministic_when_on() -> None:
    m = _meas((0.1, 0.0, 0.0))
    assert Controller(P).step(m, Ref(), 1.0).sensed.pos == (0.1, 0.0, 0.0)
    noisy = _with_sensing(P, noise=dataclasses.replace(P.sensing.noise, enabled=True))
    a = Controller(noisy).step(m, Ref(), 1.0).sensed
    b = Controller(noisy).step(m, Ref(), 1.0).sensed
    assert a == b and a.pos != (0.1, 0.0, 0.0)


def test_closed_loop_with_noise_and_latency_stays_stable() -> None:
    p = _with_sensing(P, latencyMs=20, noise=dataclasses.replace(P.sensing.noise, enabled=True))
    x0 = initial_state(p, p_q=(0.2, 0.2, 0.0))
    x, _ = run_closed_loop(p, x0, Ref(), 20.0)
    assert abs(x[0]) < 0.05 and abs(x[1]) < 0.05
