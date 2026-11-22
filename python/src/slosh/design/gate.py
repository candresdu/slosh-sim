"""Nonlinear gate runs for the designed gains (AAC off), shared by the test and the report.

Runs the Python reference model from theta = 0.2 rad, phiDot = 0.6 rad/s at a constant gain shift
and measures the theta envelope (2 s sliding max) and the dominant oscillation frequencies.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ..instability import dominant_freq_hz, envelope, simulate
from ..params import Params


def run_constant_gs(params: Params, gs: float, dur: float = 60.0) -> list[dict[str, Any]]:
    """AAC-off run of the Fig 13 start at constant ``gs`` (``gs = 1`` is the Fig 12 setting)."""
    from .. import instability as inst

    run = f"gate{gs:g}"
    inst.RUNS[run] = {"preset": "fig13", "gs": gs, "dur": dur}
    try:
        return simulate(params, run)
    finally:
        del inst.RUNS[run]


def gate_metrics(tel: list[dict[str, Any]]) -> dict[str, float]:
    """Envelope and frequency metrics of one run (needs >= 60 s).

    ``theta`` is the non-negative polar angle, so a planar swing at frequency f shows up at 2 f in
    its own spectrum. The *oscillation frequency of theta* is therefore taken from the signed
    horizontal components of the pendulum, ``mx`` and ``my`` (``L sin(theta) cos/sin(phi)``).
    """
    dt = tel[1]["t"] - tel[0]["t"]
    theta = np.array([s["theta"] for s in tel])
    env = np.array(envelope(theta.tolist(), dt))

    def i(t: float) -> int:
        return round(t / dt) - 1

    def col(k: str) -> np.ndarray:
        return np.array([s[k] for s in tel])

    return {
        "env10": float(env[i(10.0)]),
        "env60": float(env[i(60.0)]),
        "env_min_10_60": float(env[i(10.0) : i(60.0) + 1].min()),
        "f_theta_hz": dominant_freq_hz([col("mx"), col("my")], dt, 10.0, 40.0),
        "f_quad_hz": dominant_freq_hz([col("x"), col("y")], dt, 10.0, 40.0),
    }
