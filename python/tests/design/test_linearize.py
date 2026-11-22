"""Tests for slosh.design.linearize and slosh.design.margins."""

from __future__ import annotations

import math
from dataclasses import replace

import control
import numpy as np
import pytest

from slosh.design import linearize as lz
from slosh.design import margins as mg
from slosh.params import load_params

P = load_params()
pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


@pytest.fixture(scope="module")
def lin() -> lz.HoverLinearization:
    return lz.hover_linearization(P)


# --- bare plant vs R-1 Eq. 6 ------------------------------------------------------------------
def test_plant_x_tf_matches_eq6():
    tf = lz.plant_x_tf(P)
    num6, den6 = lz.eq6_coefficients(P)
    # poles: two at the origin plus the slosh pair
    poles = np.sort_complex(np.asarray(tf.poles(), dtype=complex))
    ref_poles = np.sort_complex(np.roots(den6).astype(complex))
    assert len(poles) == 4
    nz = [q for q in poles if abs(q) > 1e-3]
    nz_ref = [q for q in ref_poles if abs(q) > 1e-3]
    for a, b in zip(
        sorted(nz, key=lambda c: c.imag), sorted(nz_ref, key=lambda c: c.imag), strict=True
    ):
        assert abs(a - b) <= 1e-6 * abs(b)
    assert np.all(np.abs([q for q in poles if abs(q) <= 1e-3]) < 1e-6)
    # zeros
    z = sorted(np.asarray(tf.zeros(), dtype=complex), key=lambda c: c.imag)
    z_ref = sorted(np.roots(num6).astype(complex), key=lambda c: c.imag)
    assert len(z) == 2
    for a, b in zip(z, z_ref, strict=True):
        assert abs(a - b) <= 1e-6 * abs(b)
    # gain: coefficients normalised by the leading denominator term agree
    n = np.squeeze(tf.num[0][0])
    d = np.squeeze(tf.den[0][0])
    assert n[0] / d[0] == pytest.approx(num6[0] / den6[0], rel=1e-6)


def test_bare_plant_poles_structure():
    tf = lz.plant_x_tf(P)
    poles = np.asarray(tf.poles(), dtype=complex)
    assert np.sum(np.abs(poles) < 1e-6) == 2  # double integrator
    slosh = [q for q in poles if abs(q) > 1e-3]
    assert len(slosh) == 2
    assert slosh[0].conjugate() == pytest.approx(slosh[1]) or slosh[1].conjugate() == pytest.approx(
        slosh[0]
    )
    for q in slosh:
        assert abs(abs(q.imag) - 3.18) <= 0.05
        assert q.real < 0  # lightly damped, stable
        assert -q.real / abs(q) < 0.01


# --- hover linearization ----------------------------------------------------------------------
def test_hover_is_an_equilibrium(lin):
    assert lin.trim_residual < 1e-9


@pytest.mark.parametrize("axis", ["x", "y"])
def test_axis_subspace_is_invariant(lin, axis):
    m = lz.axis_model(axis, P, lin)
    assert m.invariance_error < 1e-8
    assert m.A.shape == (7, 7)


def test_c2d_matches_nonlinear_tick_map(lin):
    """The c2d model and the exact one-tick map of the simulator agree on each axis."""
    A, B = lz.tick_map_jacobian(P)
    lin2 = replace(lin, A_d=A, B_d=B)
    for axis in ("x", "y"):
        a = lz.axis_model(axis, P, lin)
        b = lz.axis_model(axis, P, lin2)
        assert np.max(np.abs(a.A - b.A)) < 1e-6
        assert np.max(np.abs(a.B - b.B)) < 1e-6 * max(1.0, np.max(np.abs(a.B)))


@pytest.mark.parametrize("axis", ["x", "y"])
def test_outer_loop_structure(axis):
    L = lz.outer_loop_ss(axis, P)
    assert L.dt == pytest.approx(0.01)
    # two open-loop poles at z = 1 (double integrator)
    poles = np.asarray(L.poles())
    assert np.sum(np.abs(poles - 1.0) < 1e-3) == 2
    # slosh pair near 3.18 rad/s
    s = np.log(poles[np.abs(poles - 1.0) > 1e-3].astype(complex)) / 0.01
    assert np.any(np.abs(np.abs(s) - lz.slosh_omega(P)) < 0.1)
    tf = lz.outer_loop_tf(axis, P)
    w = 2 * math.pi * 0.3
    z = np.exp(1j * w * 0.01)
    # the 7th-order tf is ill-conditioned (poles at z = 1); margins use the state-space form
    assert complex(tf(z)) == pytest.approx(complex(L(z)), rel=1e-3)
    # closed loop with provisional gains is stable at GS = 1
    assert mg.stability_metric(mg.closed_loop_poles(L, 1.0), 0.01) < 0


def test_gain_shift_scales_loop():
    L1 = lz.outer_loop_ss("x", P, gs=1.0)
    L2 = lz.outer_loop_ss("x", P, gs=2.0)
    z = np.exp(1j * 0.7 * 0.01)
    assert complex(L2(z)) == pytest.approx(2 * complex(L1(z)), rel=1e-9)


# --- margins on synthetic loops ---------------------------------------------------------------
def test_gs_threshold_matches_known_gain_margin_continuous():
    # k / (s+1)^3 has critical gain 8: with k = 3.2 the gain margin is 2.5 at sqrt(3) rad/s
    L = control.tf([3.2], [1, 3, 3, 1])
    rep = mg.margins(L)
    assert rep.gs_threshold == pytest.approx(2.5, abs=0.01)
    assert rep.hf_gm == pytest.approx(2.5, rel=1e-3)
    assert rep.hf_w == pytest.approx(math.sqrt(3.0), rel=1e-3)
    assert not rep.lf_gm_exists
    assert rep.gs_threshold_pole_w == pytest.approx(math.sqrt(3.0), rel=0.05)


def test_gs_threshold_matches_known_gain_margin_discrete():
    Ts = 0.01
    Lc = control.tf([2.0], [1, 3, 3, 1])  # continuous GM = 4
    Ld = control.c2d(Lc, Ts, "zoh")
    # reference value from the discrete closed loop itself (gain at which |z| = 1)
    lo, hi = 1.0, 10.0
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if np.max(np.abs(control.feedback(mid * Ld, 1).poles())) > 1:
            hi = mid
        else:
            lo = mid
    G = 0.5 * (lo + hi)
    assert 2.5 < G < 4.0
    rep = mg.margins(Ld, gs_hi=G + 1.0)
    assert rep.gs_threshold == pytest.approx(G, abs=0.01)
    assert rep.hf_gm == pytest.approx(G, rel=2e-2)


def test_gs_threshold_none_when_stable_over_range():
    assert mg.margins(control.tf([1.0], [1, 3, 3, 1])).gs_threshold is None


def test_lf_gain_margin_detected():
    # the flag must be consistent with the listed phase crossings for any loop
    L = control.tf([5.0, 10.0, 5.0], [1, 4, 0, 0, 0]) * control.tf([1.0], [1.0, 1.0])
    rep = mg.margins(L)
    # not asserting a specific design: the flag must equal "some -180 crossing has |L| > 1"
    assert rep.lf_gm_exists == any(c.mag > 1.0 for c in rep.phase_crossings)


# --- axis report ------------------------------------------------------------------------------
@pytest.mark.parametrize("axis", ["x", "y"])
def test_analyze_axis_report_fields(axis):
    r = mg.analyze_axis(axis, P)
    assert r.pm_deg is not None and 0 < r.pm_deg < 180
    assert r.wc is not None and 0.1 < r.wc < 10
    assert r.hf_gm is not None and r.hf_gm > 1
    assert r.inner_wc is not None and r.inner_pm_deg is not None
    assert r.slosh_zeta is not None and 0 < r.slosh_zeta < 0.2
    assert r.slosh_wn == pytest.approx(lz.slosh_omega(P), abs=0.1)
    assert r.fig12_decay_s == pytest.approx(math.log(4.0) / (r.slosh_zeta * r.slosh_wn), rel=1e-9)
    assert len(r.gs_sweep) == 51  # 0.5 .. 3.0 in 0.05 steps
    assert r.gs_sweep[0]["gs"] == pytest.approx(0.5)
    assert r.gs_sweep[-1]["gs"] == pytest.approx(3.0)


def test_threshold_consistent_with_hf_gain_margin_and_sweep():
    """The HF gain margin of the designed loop lies inside [0.5, 3.0]; threshold == HF GM."""
    L = lz.outer_loop_ss("x", P)
    rep = mg.margins(L, w_slosh=lz.slosh_omega(P))
    assert rep.hf_gm is not None and 0.5 < rep.hf_gm < 3.0
    assert rep.gs_threshold == pytest.approx(rep.hf_gm, abs=0.02)
    # the instability is a high-frequency (not slosh-dipole-only) pole; sweep flips at threshold
    for row in rep.gs_sweep:
        assert (row["max_mag"] > 1.0) == (row["gs"] > rep.gs_threshold)


def test_cli_writes_report(tmp_path):
    mg.main(["--out", str(tmp_path)])
    text = (tmp_path / "margins.md").read_text()
    for needle in (
        "guidance, not enforced",
        "Slosh-mode GS threshold",
        "Per-mode gain-shift crossings",
        "| Mode | Axis | GS threshold | Frequency [Hz] | r |",
        "Phase margin",
        "HF gain margin",
        "Low-frequency gain margin",
        "Predicted Fig 12 decay",
        "Gain-shift sweep",
        "Inner-loop",
        "slosh damping",
    ):
        assert needle in text
    for name in ("nichols_outer_x.png", "nichols_outer_y.png", "bode_inner_x.png"):
        assert (tmp_path / name).stat().st_size > 1000
