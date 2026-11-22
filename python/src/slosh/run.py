"""Run a preset in the reference model and plot the result.

    uv run python -m slosh.run --preset fig13 --out reports/fig13.png [--duration 60]

AAC parameters that are still ``null`` in ``shared/params/default.json`` (``a0``, ``b_s``,
``threshold``) are taken from the explicit PLACEHOLDER values below unless overridden with
``--a0``, ``--b-s``, ``--threshold``. They are not tuned values and are never written to the
parameter file.
"""

from __future__ import annotations

import argparse
import math
import sys
import time
from pathlib import Path
from typing import Any

from .params import load_params
from .presets import PRESET_IDS, load_preset

# Placeholders for AAC parameters that are null in default.json (NOT tuned; see module docstring).
PLACEHOLDER_AAC = {"a0": 0.2, "b_s": 2.0, "threshold": 0.5}


def aac_overrides(params: Any, a0: float | None, b_s: float | None, thr: float | None) -> dict:
    """Explicit values for every AAC parameter that is ``None`` in ``params`` (CLI wins)."""
    given = {"a0": a0, "b_s": b_s, "threshold": thr}
    out: dict[str, float] = {}
    for k, v in given.items():
        if v is not None:
            out[k] = v
        elif getattr(params.aac, k) is None:
            out[k] = PLACEHOLDER_AAC[k]
    return out


def run_preset(
    preset_id: str,
    duration: float | None = None,
    overrides: dict[str, float] | None = None,
    seed: int | None = None,
) -> list[dict[str, Any]]:
    """Run a preset from t = 0 and return the telemetry list (one dict per 10 ms tick)."""
    from .core.sim import Sim

    params = load_params()
    sim = Sim(params, seed, overrides)
    sim.enqueue({"type": "loadPreset", "id": preset_id})
    dur = load_preset(preset_id).durationS if duration is None else duration
    return [sim.step_control() for _ in range(round(dur / sim.dt_ctrl))]


def plot(tel: list[dict[str, Any]], title: str, out: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    t = [s["t"] for s in tel]

    def col(k: str) -> list[float]:
        return [s[k] for s in tel]

    fig, ax = plt.subplots(5, 1, figsize=(9, 11), sharex=True)
    ax[0].plot(t, col("theta"), label="theta")
    ax[0].set_ylabel("theta [rad]")
    ax[1].plot(t, col("mx"), label="mass x (N)")
    ax[1].plot(t, col("my"), label="mass y (E)")
    ax[1].set_ylabel("mass rel. [m]")
    ax[2].plot(t, [math.degrees(v) for v in col("roll")], label="roll")
    ax[2].plot(t, [math.degrees(v) for v in col("pitch")], label="pitch")
    ax[2].set_ylabel("attitude [deg]")
    ax[3].plot(t, col("kT_pitch"), label="K_T pitch")
    ax[3].plot(t, col("kT_roll"), label="K_T roll")
    ax[3].plot(t, col("kTApplied_pitch"), "--", label="applied pitch")
    ax[3].plot(t, col("kTApplied_roll"), "--", label="applied roll")
    ax[3].set_ylabel("K_T")
    ax[4].plot(t, col("ySD_pitch"), label="y_SD pitch")
    ax[4].plot(t, col("ySD_roll"), label="y_SD roll")
    ax[4].set_ylabel("y_SD")
    ax[4].set_xlabel("t [s]")
    for a in ax:
        a.grid(alpha=0.3)
        a.legend(loc="upper right", fontsize=8)
    ax[0].set_title(title)
    fig.tight_layout()
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=110)
    plt.close(fig)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="slosh.run", description=__doc__.split("\n")[0])
    ap.add_argument("--preset", required=True, choices=PRESET_IDS)
    ap.add_argument("--out", required=True, type=Path, help="output PNG path")
    ap.add_argument("--duration", type=float, help="seconds (default: the preset's duration)")
    ap.add_argument("--seed", type=int)
    ap.add_argument("--a0", type=float, help="override aac.a0")
    ap.add_argument("--b-s", type=float, dest="b_s", help="override aac.b_s")
    ap.add_argument("--threshold", type=float, help="override aac.threshold")
    a = ap.parse_args(argv)

    params = load_params()
    ov = aac_overrides(params, a.a0, a.b_s, a.threshold)
    if ov:
        print(f"AAC overrides/placeholders: {ov}", file=sys.stderr)
    t0 = time.perf_counter()
    tel = run_preset(a.preset, a.duration, ov, a.seed)
    wall = time.perf_counter() - t0
    plot(tel, f"{a.preset} (AAC overrides: {ov})", a.out)
    peak = max(s["theta"] for s in tel)
    print(
        f"{a.preset}: {tel[-1]['t']:.1f} s simulated in {wall:.1f} s wall; max theta {peak:.3f} rad"
    )
    print(f"wrote {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
