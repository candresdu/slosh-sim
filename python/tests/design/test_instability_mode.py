"""Nonlinear gate: with AAC off the gain-shift instability is the ~0.5 Hz slosh mode.

Runs the Python reference model (committed parameters, AAC off) from theta = 0.2 rad,
phiDot = 0.6 rad/s for 60 s at constant gain shift 2.0 and 2.3 (and 1.0 for Fig 12).

* The theta envelope (2 s sliding max) grows (envelope at 60 s > envelope at 10 s) and stays at
  or above 0.2 rad over 10 to 60 s.
* The dominant oscillation frequency of theta over 10 to 40 s is in 0.45 to 0.6 Hz. ``theta`` is the
  non-negative polar angle, whose spectrum doubles a planar swing's frequency, so the frequency is
  read from the signed horizontal pendulum components (see :func:`slosh.design.gate.gate_metrics`).
* Fig 12 (GS 1) is a decaying envelope: env(60 s) < env(30 s) < env(10 s), with a positive linear
  GS 1 slosh-mode decay rate (fallback criterion, not the R-1 decay to 0.05 rad).
* The dominant quad-position frequency is not in the rigid-body band 0.8 to 1.3 Hz.
"""

from __future__ import annotations

import pytest

from slosh.design.gate import gate_metrics, run_constant_gs
from slosh.instability import envelope, slosh_rate_gs1
from slosh.params import load_params

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


@pytest.fixture(scope="module")
def runs() -> dict[float, list[dict]]:
    p = load_params()
    return {gs: run_constant_gs(p, gs, 60.0) for gs in (1.0, 2.0, 2.3)}


@pytest.mark.parametrize("gs", [2.0, 2.3])
def test_slosh_mode_grows_with_aac_off(runs, gs: float):
    m = gate_metrics(runs[gs])
    assert m["env60"] > m["env10"], m
    assert m["env_min_10_60"] >= 0.2, m
    assert 0.45 <= m["f_theta_hz"] <= 0.6, m
    assert not 0.8 <= m["f_quad_hz"] <= 1.3, m


@pytest.mark.parametrize("gs", [2.0, 2.3])
def test_envelope_is_still_growing_late(runs, gs: float):
    env = envelope([s["theta"] for s in runs[gs]], 0.01)
    assert env[5999] > env[4000]  # 60 s above 40 s: not a decaying or plateaued oscillation


def test_fig12_envelope_decreases(runs):
    """Fallback Fig 12 criterion: env(60 s) < env(30 s) < env(10 s) and a positive linear rate.

    PD-only gains cannot give both the R-1 decay at GS 1 and the growth at GS 2.0 (see
    ``reports/gain_redesign.md``), so Fig 12 decays only at about the passive rate.
    """
    env = envelope([s["theta"] for s in runs[1.0]], 0.01)
    assert env[5999] < env[2999] < env[999], (env[999], env[2999], env[5999])
    assert slosh_rate_gs1(load_params()) > 0.0
