"""Bounded last attempt at the Fig 12 decay with PD gains only (no pendulum feedback).

Searches the four PD gains for each ``k_damp`` in [3e-3, 7e-3] under the linear screen:

* GS 1 slosh-mode decay rate >= 0.046 1/s and GS 2.0 growth rate >= 0.025 1/s,
* slosh-mode identity (pendulum participation r > 5, 0.45 to 0.6 Hz) at GS 1 and 2.0,
* slosh-mode GS threshold in :data:`fit_gains.SLOSH_THRESHOLD_RANGE` on both axes,
* rigid-body threshold >= 2.8, inner PM >= 40 deg (:data:`INNER_PM_SCREEN`).

The cost is the normalized sum of shortfalls; the best decay + growth sum is what the report
records. A wall-clock budget bounds the search; progress goes to a log file.

    uv run python -m slosh.design.final_search --minutes 20 --workers 6 --log /tmp/search.log
"""

from __future__ import annotations

import argparse
import json
import math
import time
from dataclasses import replace
from typing import Any

import numpy as np

from ..params import Params, load_params
from . import fit_gains as fg
from .linearize import axis_model, hover_linearization

INNER_PM_SCREEN = 40.0  # screen floor for this attempt (the committed fit_gains floor stays 45)
RATE1_MIN = 0.046
GROWTH2_MIN = 0.025
RIGID_MIN = 2.8
KDAMPS = (0.003, 0.004, 0.005, 0.006, 0.007)
START_005 = (11.77, 2.726, 0.984, 0.757)  # inner Kp, Kd, outer Kp, Kd (k_damp = 0.005 design)


def _identity(p: Params, axis: str) -> tuple[float, float]:
    """Worst (min) participation r and the frequency range violation over GS 1 and 2."""
    lin = hover_linearization(p)
    m = axis_model(axis, p, lin)
    C = p.control.outer.Kp * m.C_pos + p.control.outer.Kd * m.C_vel
    rmin, fviol = 1e9, 0.0
    for gs in (1.0, 2.0):
        w, v = np.linalg.eig(m.A - gs * (m.B @ C))
        j = fg._slosh_index(w, v, 4, 0)
        r = float(abs(v[4, j]) / max(abs(v[0, j]), 1e-300))
        f = abs(math.atan2(w[j].imag, w[j].real)) / m.Ts / (2 * math.pi)
        rmin = min(rmin, r)
        fviol = max(fviol, 0.45 - f, f - 0.6, 0.0)
    return rmin, fviol


def screen(p: Params) -> dict[str, Any]:
    out: dict[str, Any] = {"ok": True, "pen": 0.0}
    lo, hi = fg.SLOSH_THRESHOLD_RANGE
    rates, growths, thrs = [], [], []
    for ax in ("x", "y"):
        f = fg._eval_axis(p, ax)
        r, fv = _identity(p, ax)
        t = f.slosh_thr if f.slosh_thr is not None else 4.0
        rates.append(f.rate1)
        growths.append(f.growth2)
        thrs.append(t)
        pen = (
            max(0.0, RATE1_MIN - f.rate1) / 0.002
            + max(0.0, GROWTH2_MIN - f.growth2) / 0.002
            + max(0.0, lo - t, t - hi) / 0.01
            + max(0.0, RIGID_MIN - 3.0 if f.rigid_zmax >= 0.9997 else 0.0) * 50
            + max(0.0, f.rigid_zmax - 0.9997) / 2e-4
            + max(0.0, INNER_PM_SCREEN - f.inner_pm) / 0.3
            + max(0.0, 5.5 - r) * 2.0
            + fv / 0.005
        )
        out["pen"] += pen
        out[ax] = {"rate1": f.rate1, "growth2": f.growth2, "thr": t, "r": r, "ipm": f.inner_pm}
    out["ok"] = bool(out["pen"] <= 1e-9)
    out["rate1"], out["growth2"] = min(rates), min(growths)
    out["sum"] = out["rate1"] + out["growth2"]
    out["thr"] = thrs
    return out


def _cost(xl: np.ndarray, p0: Params, kd: float, deadline: float) -> float:
    if time.time() > deadline:
        raise TimeoutError
    try:
        p = replace(p0, pendulum=replace(p0.pendulum, k_damp=kd))
        q = fg._params_for(p, np.exp(xl))
        s = screen(q)
        return s["pen"] - 20.0 * s["sum"]  # tie-break: more decay + growth
    except TimeoutError:
        raise
    except Exception:
        return 1e9


def _job(job: tuple[float, list[float], float, str]) -> dict[str, Any]:
    from scipy.optimize import minimize

    kd, start, deadline, log = job
    p0 = load_params()
    best = {"cost": 1e18, "x": start}

    def f(xl: np.ndarray) -> float:
        c = _cost(xl, p0, kd, deadline)
        if c < best["cost"]:
            best["cost"], best["x"] = c, list(np.exp(xl))
            with open(log, "a") as fh:
                g = np.round(np.exp(xl), 4).tolist()
                fh.write(f"{time.strftime('%H:%M:%S')} k_damp={kd} cost={c:.3f} {g}\n")
        return c

    rng = np.random.default_rng(int(kd * 1e4))
    x0 = np.log(np.array(start))
    try:
        for k in range(50):
            xs = x0 if k == 0 else x0 + rng.normal(0.0, 0.08, 4)
            opts = {"maxiter": 300, "xatol": 1e-4, "fatol": 1e-5}
            minimize(f, xs, method="Nelder-Mead", options=opts)
            x0 = np.log(np.array(best["x"]))
    except TimeoutError:
        pass
    p = replace(p0, pendulum=replace(p0.pendulum, k_damp=kd))
    s = screen(fg._params_for(p, np.array(best["x"])))
    return {"k_damp": kd, "gains": best["x"], "screen": s}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=20.0)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--log", default="/tmp/final_search.log")
    ap.add_argument("--out", default="/tmp/final_search.json")
    a = ap.parse_args(argv)
    deadline = time.time() + a.minutes * 60.0
    open(a.log, "w").close()
    jobs = [(kd, list(START_005), deadline, a.log) for kd in KDAMPS]
    with fg._pool() as ex:
        ex._max_workers = min(a.workers, 6)
        res = list(ex.map(_job, jobs))
    with open(a.out, "w") as fh:
        json.dump(res, fh, indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o))
    for r in res:
        s = r["screen"]
        thr = np.round(s["thr"], 3).tolist()
        print(
            r["k_damp"],
            np.round(r["gains"], 4).tolist(),
            "ok" if s["ok"] else "FAIL",
            f"rate1={s['rate1']:.4f} growth2={s['growth2']:.4f} sum={s['sum']:.4f} thr={thr}",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
