"""Tests for the AAC adaptive law, spectral damper, detector and modes."""

from __future__ import annotations

import math
import random
from dataclasses import replace

import pytest

from slosh.core.aac import DT, Aac
from slosh.params import load_params

P = load_params()
KMIN, KMAX = P.aac.kMin, P.aac.kMax


class ConstLp:
    """Stand-in for the low-pass: forces a chosen y_SD."""

    def __init__(self, y: float) -> None:
        self.y = y

    def step(self, _x: float) -> float:
        return self.y

    def reset(self) -> None:
        pass


def make(a0: float = 0.1, b_s: float = 1.0, thr: float = 1.0, **kw: float) -> Aac:
    return Aac(P, a0=a0, b_s=b_s, threshold=thr, **kw)


def sine(f: float, n: int, amp: float = 1.0) -> list[float]:
    return [amp * math.sin(2 * math.pi * f * i * DT) for i in range(n)]


def test_untuned_params_need_explicit_values() -> None:
    # parameters that are null (not tuned) must be passed explicitly
    p = replace(P, aac=replace(P.aac, a0=None, b_s=None, threshold=None))
    with pytest.raises(ValueError):
        Aac(p)


def test_off_mode_is_unity_for_any_input() -> None:
    a = make()
    rng = random.Random(1)
    for _ in range(500):
        o = a.step(rng.uniform(-50, 50), rng.uniform(-5, 5), "off")
        assert o == (1.0, 1.0, 0.0, False, False)
    assert a.k == 1.0


def test_monitor_adapts_but_does_not_apply() -> None:
    a = make(a0=0.1, b_s=5.0, thr=1e9)
    ks = []
    for u in sine(0.5, 3000, amp=3.0):
        o = a.step(u, 0.0, "monitor")
        assert o.kT_applied == 1.0
        ks.append(o.kT)
    assert min(ks) < 0.9
    assert a.y > 0.0


def test_engaged_applies_kt() -> None:
    a = make(b_s=5.0)
    o = None
    for u in sine(0.5, 3000, amp=3.0):
        o = a.step(u, 0.0, "engaged")
        assert o.kT_applied == o.kT
    assert o is not None and o.kT < 0.9


def test_engaged_equilibrium() -> None:
    a0, b_s, y = 0.1, 1.0, 0.7
    a = make(a0=a0, b_s=b_s)
    a.lp = ConstLp(y)  # type: ignore[assignment]
    for _ in range(int(120 / DT)):
        o = a.step(0.0, 0.0, "engaged")
    expect = (a0 + b_s * y * KMIN) / (a0 + b_s * y)
    assert o.kT == pytest.approx(expect, abs=1e-3)


def test_up_band_term_raises_kt_toward_kmax() -> None:
    a = make(a0=0.1, b_s=1.0, b_e=2.0)
    for _ in range(int(60 / DT)):
        o = a.step(0.0, 1.0, "monitor")
    # steady state with y = 0: k = (a0 + b_e e^2 kMax) / (a0 + b_e e^2), e -> 1 (unity DC gain)
    assert o.kT == pytest.approx((0.1 + 2.0 * KMAX) / (0.1 + 2.0), abs=1e-3)


def test_e_ref_computed_even_when_b_e_zero() -> None:
    a = make()
    for _ in range(200):
        a.step(0.0, 1.0, "monitor")
    assert a.e_filt.z != 0.0
    assert a.k == 1.0  # but it has no effect


def test_lead_lag_dc_gain_and_step() -> None:
    a = make()
    y = 0.0
    for _ in range(2000):
        y = a.e_filt.step(1.0)
    assert y == pytest.approx(1.0, abs=1e-9)
    f = make().e_filt
    assert f.step(1.0) == pytest.approx(f.b0)  # initial jump = lead/lag ratio ~ Tustin
    assert f.b0 > 1.0


def test_clamping_random_inputs() -> None:
    rng = random.Random(7)
    for mode in ("monitor", "engaged"):
        a = make(a0=5.0, b_s=500.0, b_e=500.0)
        for _ in range(20000):
            o = a.step(rng.uniform(-200, 200), rng.uniform(-50, 50), mode)
            assert KMIN <= o.kT <= KMAX
            assert KMIN <= o.kT_applied <= KMAX


def test_selectivity_half_hz_vs_tenth_hz() -> None:
    def steady(f: float) -> float:
        a = make(thr=1e9)
        for u in sine(f, int(60 / DT)):
            a.step(u, 0.0, "monitor")
        ys = []
        for u in sine(f, int(60 / DT)):
            a.step(u, 0.0, "monitor")
            ys.append(a.y)
        return sum(ys) / len(ys)

    assert steady(0.5) >= 5.0 * steady(0.1)


def test_detector_trip_and_hysteresis() -> None:
    thr = 1.0
    a = make(thr=thr)
    lp = ConstLp(0.0)
    a.lp = lp  # type: ignore[assignment]
    assert not a.step(0.0, 0.0, "monitor").detect
    # first sample above threshold trips, with exactly one rising edge
    lp.y = 1.5 * thr
    o = a.step(0.0, 0.0, "monitor")
    assert o.detect and o.trip_edge
    o = a.step(0.0, 0.0, "monitor")
    assert o.detect and not o.trip_edge
    # between clear level and threshold: stays latched, never clears
    lp.y = 0.7 * thr
    for _ in range(1000):
        assert a.step(0.0, 0.0, "monitor").detect
    # below 0.5 thr: clears on the 200th consecutive sample, not before
    lp.y = 0.4 * thr
    for i in range(199):
        assert a.step(0.0, 0.0, "monitor").detect, i
    assert not a.step(0.0, 0.0, "monitor").detect
    # new rising edge after clearing
    lp.y = 2.0 * thr
    assert a.step(0.0, 0.0, "monitor").trip_edge


def test_detector_clear_counter_restarts() -> None:
    a = make(thr=1.0)
    lp = ConstLp(2.0)
    a.lp = lp  # type: ignore[assignment]
    a.step(0.0, 0.0, "monitor")
    lp.y = 0.4
    for _ in range(150):
        a.step(0.0, 0.0, "monitor")
    lp.y = 0.8  # interrupts the calm streak
    a.step(0.0, 0.0, "monitor")
    lp.y = 0.4
    for _ in range(199):
        assert a.step(0.0, 0.0, "monitor").detect
    assert not a.step(0.0, 0.0, "monitor").detect


def test_switch_to_off_resets() -> None:
    a = make(b_s=5.0, thr=0.01)
    for u in sine(0.5, 2000, amp=3.0):
        a.step(u, 0.0, "engaged")
    assert a.k < 1.0 and a.detect
    o = a.step(1.0, 0.0, "off")
    assert o == (1.0, 1.0, 0.0, False, False)
    assert a.hp.sections[0].z1 == 0.0 and a.lp.sections[0].z2 == 0.0


def test_engage_ramp_rate_limits_applied_gain() -> None:
    import dataclasses

    p = dataclasses.replace(P, aac=dataclasses.replace(P.aac, engageRampS=2.0))
    a = Aac(p, a0=0.1, b_s=1.0, threshold=1e9)
    a.lp = ConstLp(5.0)  # type: ignore[assignment]
    for _ in range(500):  # monitor: k_T falls to ~kMin, applied stays 1
        o = a.step(0.0, 0.0, "monitor")
    assert o.kT < 0.3 and o.kT_applied == 1.0
    slew = (KMAX - KMIN) / 2.0 * DT
    prev = 1.0
    for _ in range(200):
        o = a.step(0.0, 0.0, "engaged")
        assert prev - o.kT_applied <= slew + 1e-12
        prev = o.kT_applied
    assert o.kT_applied == pytest.approx(o.kT, abs=1e-9) or o.kT_applied < 1.0
    for _ in range(300):
        o = a.step(0.0, 0.0, "engaged")
    assert o.kT_applied == pytest.approx(o.kT)


def test_unknown_mode_rejected() -> None:
    with pytest.raises(ValueError):
        make().step(0.0, 0.0, "bogus")
