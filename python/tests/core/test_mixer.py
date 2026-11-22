"""Tests for the X-configuration mixer."""

from __future__ import annotations

import math
import random

from slosh.core.mixer import MOTOR_LAYOUT, forces_torques, mix, moment_arm
from slosh.params import load_params

P = load_params()
G = 9.80665


def _base() -> float:
    return 1.5707 * G


def test_layout_table_consistent_with_sign_rules() -> None:
    d = moment_arm(P)
    assert abs(d - 0.1704) < 1e-4
    for _, x, y, s_r, s_p, _ in MOTOR_LAYOUT:
        assert s_p == x  # pitch up raises front motors
        assert s_r == -y  # roll right raises left motors


def test_round_trip_random_unsaturated() -> None:
    rng = random.Random(1234)
    for _ in range(1000):
        f = rng.uniform(12.0, 20.0)
        tx, ty = rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3)
        tz = rng.uniform(-0.002, 0.002)
        out = forces_torques(mix(f, tx, ty, tz, P), P)
        for got, want in zip(out, (f, tx, ty, tz), strict=True):
            assert abs(got - want) < 1e-12


def _delta(f: float, tx: float, ty: float, tz: float) -> list[float]:
    hover = mix(_base(), 0.0, 0.0, 0.0, P)
    cmd = mix(f, tx, ty, tz, P)
    return [c - h for c, h in zip(cmd, hover, strict=True)]


def test_sign_rules() -> None:
    f0 = _base()
    r = _delta(f0, 0.1, 0, 0)
    assert r[0] > 0 and r[3] > 0 and r[1] < 0 and r[2] < 0
    p = _delta(f0, 0, 0.1, 0)
    assert p[2] > 0 and p[3] > 0 and p[0] < 0 and p[1] < 0
    y = _delta(f0, 0, 0, 0.005)
    assert y[0] > 0 and y[2] > 0 and y[1] < 0 and y[3] < 0
    t = _delta(f0 * 1.1, 0, 0, 0)
    assert all(v > 0 for v in t)


def test_hover_speed() -> None:
    for w in mix(_base(), 0.0, 0.0, 0.0, P):
        assert abs(w - 810.7) < 0.5


def test_clamps() -> None:
    lo, hi = P.motor.omegaMin, P.motor.omegaMax
    for w in mix(0.0, 0.0, 0.0, 0.0, P):
        assert math.isclose(w, lo)
    for w in mix(1e4, 0.0, 0.0, 0.0, P):
        assert math.isclose(w, hi)
    out = mix(_base(), 50.0, 0.0, 0.0, P)  # huge roll torque saturates, stays in range
    assert all(lo - 1e-9 <= w <= hi + 1e-9 for w in out)


def test_forces_torques_signs() -> None:
    w = 800.0
    f, tx, ty, tz = forces_torques((w + 10, w, w, w + 10), P)  # M1, M4 up
    assert f > 0 and tx > 0
    assert math.isclose(ty, 0.0, abs_tol=1e-12)
    f, tx, ty, tz = forces_torques((w + 10, w + 10, w + 10, w + 10), P)
    assert abs(tx) < 1e-12 and abs(ty) < 1e-12 and abs(tz) < 1e-12
