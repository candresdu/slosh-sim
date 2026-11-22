"""Design the PD gains of the testbed controller (a labelled reconstruction).

R-1 does not give the PD gains, so they are always *designed* here and tagged
``designed (reconstruction)`` in ``shared/params/default.json``. Steps:

1. **Joint inner/outer design** (lever A: PD gains only). The outer loop feeds back only quad
   position and velocity; the pendulum angle is never fed back. For the ~0.5 Hz slosh mode (not
   the quad's rigid-body position mode) to be the one that goes unstable, the rigid-body part of
   the loop must already be near -180 deg phase at about 0.5 Hz while the gain crossover sits near
   0.2 Hz, which needs a slower inner loop (crossover below 1.5 Hz) than the first design. A
   log-grid over ``(Kp_att, Kd_att, Kp_pos, Kd_pos)`` is scored with a cheap eigenvalue-based
   objective, then the best grid points are refined with Nelder-Mead. The objective is built from
   the per-mode analysis of :mod:`slosh.design.margins` (slosh pole identified by its
   pendulum participation ``r``):

   * hard: slosh-mode GS threshold in 1.3 to 1.95, every other mode inside the unit circle up to
     GS 3.0, inner PM >= 45 deg, closed loop stable at GS = 1;
   * aims: slosh damping at GS = 1 as high as possible (Fig 12 decay), steep growth beyond the
     threshold;
   * soft R-1 Table 1 guidance (reported, never enforced): PM 22 deg near 0.2 Hz, HF gain margin
     near 0.525 Hz, no low-frequency gain margin.
2. **Altitude and yaw hold**: closed-form second-order designs (natural frequency and damping),
   checked with the motor lag.
3. Optional lever B (first-order velocity-estimate filter) is **not** used: see
   ``reports/gain_redesign.md``. Pendulum-angle feedback is excluded by design.

``python -m slosh.design.fit_gains --write`` stores the gains in the parameter file and
regenerates ``reports/margins.md``; ``--report`` also writes ``reports/gain_redesign.md``.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import control
import numpy as np

from ..params import DEFAULT_PARAMS_PATH, Gains, Params, load_params
from . import margins as mg
from .linearize import (
    AXES,
    axis_model,
    hover_linearization,
    inner_loop_ss,
    outer_loop_ss,
    slosh_omega,
)

SRC = "designed (reconstruction)"

# --- targets ----------------------------------------------------------------------------------
INNER_WC_HZ = (0.5, 2.0)  # sanity band; the inner crossover may be below 1.5 Hz
INNER_PM_MIN = 45.0  # hard [deg]
INNER_PM_AIM = 50.0  # the search keeps this margin over the hard floor

SLOSH_THRESHOLD_RANGE = (1.3, 1.95)  # hard: slosh-mode GS threshold (wider band)
SLOSH_THRESHOLD_AIM = (1.35, 1.88)  # flat cost inside: GS 1 slosh damping is rewarded
RIGID_GS_MIN = 2.8  # hard: every other mode stable up to here
GS_SEARCH_HI = 3.0
DECAY_RATE_MIN = math.log(4.0) / 30.0  # Fig 12 target: zeta wn [1/s] (hard if attainable)
DECAY_RATE_AIM = 0.055
PM_FLOOR = 15.0  # design practice (not an R-1 requirement): outer-loop PM floor [deg]
SOFT = 0.5  # weight of the soft R-1 Table 1 guidance terms
RATE_WEIGHT = 6.0  # weight of the GS 1 slosh damping reward (Fig 12 decay)
GROWTH_WEIGHT = 8.0  # weight of the GS 2.0 growth reward
GROWTH_AIM = 0.015  # desired slosh growth rate [1/s] at GS 2.0 (clear growth in 60 s)
TABLE1_PM_DEG = mg.TABLE1["pm_deg"]
TABLE1_WC_HZ = mg.TABLE1["pm_hz"]
TABLE1_HF_HZ = mg.TABLE1["hf_hz"]

# altitude and yaw hold: (natural frequency [rad/s], damping ratio)
ALT_DESIGN = (4.0, 0.9)
YAW_DESIGN = (5.0, 0.9)
HOLD_PM_MIN = 45.0

# search box (log-uniform): inner Kp, inner Kd, outer Kp, outer Kd
BOX = ((6.0, 30.0), (1.5, 9.0), (0.2, 3.0), (0.3, 3.0))


# --- helpers ----------------------------------------------------------------------------------
def with_gains(
    p: Params,
    inner: tuple[float, float] | None = None,
    outer: tuple[float, float] | None = None,
    alt: tuple[float, float] | None = None,
    yaw: tuple[float, float] | None = None,
) -> Params:
    c = p.control
    return replace(
        p,
        control=replace(
            c,
            inner=c.inner if inner is None else Gains(*inner),
            outer=c.outer if outer is None else Gains(*outer),
            alt=c.alt if alt is None else Gains(*alt),
            yaw=c.yaw if yaw is None else Gains(*yaw),
        ),
    )


def _r(x: float, digits: int = 4) -> float:
    """Round to ``digits`` significant figures (stored gains are short and reproducible)."""
    if x == 0:
        return 0.0
    return round(x, digits - 1 - int(math.floor(math.log10(abs(x)))))


# --- inner loop -------------------------------------------------------------------------------
def inner_metrics(p: Params, n: int = 4000) -> dict[str, tuple[float, float]]:
    """``{axis: (crossover [Hz], PM [deg])}`` of the inner attitude loop (``n`` grid points)."""
    out = {}
    for ax in AXES:
        L = inner_loop_ss(ax, p)
        w = mg.default_grid(L, n=n)
        xo, _ = mg._crossings(w, mg.freq_response(L, w))
        wc, pm = next(((a, b) for a, b, down in xo if down), (None, None))
        out[ax] = (float("nan") if wc is None else wc / (2 * math.pi), pm if pm else float("nan"))
    return out


# --- outer loop -------------------------------------------------------------------------------
def outer_reports(p: Params, **kw: Any) -> dict[str, mg.MarginReport]:
    """Full margin reports (with per-mode analysis) for both axes."""
    kw = {"gs_hi": GS_SEARCH_HI, "tol": 0.002, "sweep_step": 10.0, **kw}
    mode_step = kw.pop("mode_step", 0.01)
    out = {}
    for ax in AXES:
        rep = mg.analyze_axis(ax, p, **kw)
        out[ax] = mg.attach_modes(
            rep, outer_loop_ss(ax, p), p, ax, gs_lo=0.5, gs_hi=kw["gs_hi"], step=mode_step
        )
    return out


def _decay_rate(r: mg.MarginReport) -> float:
    if r.slosh_zeta is None or r.slosh_wn is None:
        return -1.0
    return r.slosh_zeta * r.slosh_wn


@dataclass(frozen=True)
class Fast:
    """Cheap eigenvalue-based scores of one candidate (one axis)."""

    slosh_thr: float | None  # GS at which the slosh pole (largest participation) leaves |z|=1
    rigid_zmax: float  # max |z| of every other pole over GS in [0.5, 3.0]
    rate1: float  # slosh decay rate at GS = 1 [1/s]
    growth2: float  # slosh growth rate at GS = 2.0 [1/s] (negative: decaying)
    inner_pm: float
    inner_wc_hz: float
    pm: float | None
    wc_hz: float | None
    hf_hz: float | None
    lf_exists: bool


def _slosh_index(w: np.ndarray, v: np.ndarray, ni: int, pi: int) -> int:
    """Index of the upper-half-plane pole with the largest pendulum participation."""
    r = np.abs(v[ni]) / np.maximum(np.abs(v[pi]), 1e-300)
    f = np.abs(np.angle(w))
    r = np.where((w.imag >= -1e-12) & (f > 0.005), r, -1.0)
    return int(np.argmax(r))


def _eval_axis(p: Params, axis: str = "x") -> Fast:
    lin = hover_linearization(p)
    m = axis_model(axis, p, lin)
    kp, kd = p.control.outer.Kp, p.control.outer.Kd
    assert kp is not None and kd is not None
    C = kp * m.C_pos + kd * m.C_vel
    A, B, T = m.A, m.B, m.Ts

    def poles(gs: float) -> tuple[np.ndarray, np.ndarray]:
        return np.linalg.eig(A - gs * (B @ C))

    def slosh_mag(gs: float) -> float:
        w, v = poles(gs)
        return float(abs(w[_slosh_index(w, v, 4, 0)]))

    w1, v1 = poles(1.0)
    j1 = _slosh_index(w1, v1, 4, 0)
    rate1 = -math.log(abs(w1[j1])) / T
    w2, v2 = poles(2.0)
    growth2 = math.log(abs(w2[_slosh_index(w2, v2, 4, 0)])) / T

    thr: float | None = None
    grid = np.arange(0.5, GS_SEARCH_HI + 1e-9, 0.1)
    rigid = 0.0
    prev = None
    for gs in grid:
        w, v = poles(float(gs))
        j = _slosh_index(w, v, 4, 0)
        other = (np.abs(w - w[j]) > 1e-9) & (np.abs(w - np.conj(w[j])) > 1e-9)
        rigid = max(rigid, float(np.max(np.abs(w[other]))))
        if thr is None and abs(w[j]) > 1.0:
            lo = float(prev) if prev is not None else float(gs)
            hi = float(gs)
            for _ in range(30):
                mid = 0.5 * (lo + hi)
                if slosh_mag(mid) > 1.0:
                    hi = mid
                else:
                    lo = mid
            thr = hi
        prev = gs
    L = control.ss(A, B, C, np.zeros((1, 1)), T)
    wg = mg.default_grid(L, n=3000)
    xo, pc = mg._crossings(wg, _fast_response(A, B, C, T, wg))
    down = [(wc, pm) for wc, pm, d in xo if d]
    upper = [c for c in pc if c.mag < 1.0]
    hf = min(upper, key=lambda c: c.gm) if upper else None
    li = inner_loop_ss(axis, p)
    wi = mg.default_grid(li, n=3000)
    xi, _ = mg._crossings(wi, mg.freq_response(li, wi))
    di = [(wc, pm) for wc, pm, d in xi if d]
    return Fast(
        slosh_thr=thr,
        rigid_zmax=rigid,
        rate1=rate1,
        growth2=growth2,
        inner_pm=di[0][1] if di else -90.0,
        inner_wc_hz=di[0][0] / (2 * math.pi) if di else 0.0,
        pm=down[0][1] if down else None,
        wc_hz=down[0][0] / (2 * math.pi) if down else None,
        hf_hz=hf.w / (2 * math.pi) if hf else None,
        lf_exists=any(c.mag > 1.0 for c in pc),
    )


def _fast_response(
    A: np.ndarray, B: np.ndarray, C: np.ndarray, T: float, w: np.ndarray
) -> np.ndarray:
    """``C (zI - A)^-1 B`` on ``z = exp(j w T)`` with a batched linear solve (A has z = 1 poles)."""
    z = np.exp(1j * w * T)
    n = A.shape[0]
    M = z[:, None, None] * np.eye(n)[None, :, :] - A[None, :, :]
    x = np.linalg.solve(M, np.broadcast_to(B.astype(complex), (len(w), n, 1)))
    return np.asarray((C.astype(complex)[None, :, :] @ x).reshape(-1))


def score(f: Fast) -> float:
    """Scalar cost (lower is better); see the module docstring for the targets."""
    j = 0.0
    t = f.slosh_thr if f.slosh_thr is not None else 4.0
    lo, hi = SLOSH_THRESHOLD_AIM
    j += (max(0.0, lo - t, t - hi) / 0.02) ** 2
    j += (max(0.0, f.rigid_zmax - 0.9997) / 1e-4) ** 2
    j += (max(0.0, INNER_PM_AIM - f.inner_pm) / 3.0) ** 2
    j += (max(0.0, INNER_PM_MIN + 1.0 - f.inner_pm) / 0.5) ** 2  # hard floor with 1 deg margin
    j += (max(0.0, INNER_WC_HZ[0] + 0.1 - f.inner_wc_hz) / 0.05) ** 2
    j -= RATE_WEIGHT * min(f.rate1, DECAY_RATE_AIM) / 0.01
    j -= GROWTH_WEIGHT * min(f.growth2, GROWTH_AIM) / 0.01
    # soft R-1 Table 1 guidance
    pm = f.pm if f.pm is not None else 0.0
    wc = f.wc_hz if f.wc_hz is not None else 0.0
    j += SOFT * ((pm - TABLE1_PM_DEG) / 5.0) ** 2
    j += (max(0.0, PM_FLOOR - pm) / 2.0) ** 2
    j += SOFT * ((wc - TABLE1_WC_HZ) / 0.02) ** 2
    j += 0.1 * (((f.hf_hz or 0.0) - TABLE1_HF_HZ) / 0.02) ** 2
    j += 3.0 if f.lf_exists else 0.0
    return j


def _params_for(p: Params, x: np.ndarray) -> Params:
    return with_gains(p, inner=(float(x[0]), float(x[1])), outer=(float(x[2]), float(x[3])))


ENV_FLOOR = 0.207  # nonlinear polish: GS 2.0 envelope floor over 10-20 s [rad] (gate: 0.2)


def nonlinear_penalty(p: Params) -> float:
    """Penalty if the AAC-off GS 2.0 run's 2 s theta envelope dips below ``ENV_FLOOR`` in 10-20 s.

    The Fig 13 start has an initial transient that shrinks the envelope to about 0.18 rad before
    the slosh growth takes over; the gate wants the envelope back above 0.2 rad by t = 10 s.
    """
    from ..instability import envelope
    from .gate import run_constant_gs

    tel = run_constant_gs(p, 2.0, 20.0)
    env = envelope([s["theta"] for s in tel], 0.01)
    return (max(0.0, ENV_FLOOR - min(env[999:])) / 0.003) ** 2


def _cost(x_log: np.ndarray, p: Params, nl: bool = False) -> float:
    try:
        q = _params_for(p, np.exp(x_log))
        f = _eval_axis(q)
        j = score(f)
        if nl and f.slosh_thr is not None and f.rigid_zmax < 1.0:
            j += nonlinear_penalty(q)
        return j
    except Exception:  # singular / unstable candidates
        return 1e9


def _pool() -> Any:
    """Process pool of spawned workers; BLAS threads are limited to 1 (inherited via the env)."""
    import multiprocessing as mp
    import os
    from concurrent.futures import ProcessPoolExecutor

    os.environ["OMP_NUM_THREADS"] = os.environ["OPENBLAS_NUM_THREADS"] = "1"
    return ProcessPoolExecutor(mp_context=mp.get_context("spawn"))


def _cost_job(job: tuple[np.ndarray, Params]) -> float:
    return _cost(np.log(job[0]), job[1])


def _refine_job(job: tuple[np.ndarray, Params, int, bool]) -> tuple[float, np.ndarray]:
    from scipy.optimize import minimize

    x0, p, maxiter, nl = job
    sol = minimize(
        _cost,
        np.log(x0),
        args=(p, nl),
        method="Nelder-Mead",
        options={"maxiter": maxiter, "xatol": 1e-4, "fatol": 1e-4},
    )
    return float(sol.fun), np.exp(sol.x)


def grid_search(p: Params, n: int = 6, top: int = 6) -> list[tuple[float, np.ndarray]]:
    """Log-grid over :data:`BOX` (``n`` points per gain); returns the ``top`` best (cost, gains)."""
    axes = [np.exp(np.linspace(math.log(lo), math.log(hi), n)) for lo, hi in BOX]
    pts = [
        np.array([a, b, c, d]) for a in axes[0] for b in axes[1] for c in axes[2] for d in axes[3]
    ]
    with _pool() as ex:
        costs = list(ex.map(_cost_job, [(x, p) for x in pts], chunksize=16))
    res = sorted(zip(costs, pts, strict=True), key=lambda t: t[0])
    return res[:top]


def refine(
    p: Params, starts: list[np.ndarray], maxiter: int = 250, nl: bool = False
) -> tuple[float, np.ndarray]:
    """Nelder-Mead from each start (log gains, one process per start); returns the best result."""
    with _pool() as ex:
        outs = list(ex.map(_refine_job, [(x, p, maxiter, nl) for x in starts]))
    return min(outs, key=lambda t: t[0])


def fit_pd(
    p: Params, n: int = 6, top: int = 6, verbose: bool = False, polish: bool = True
) -> tuple[tuple[float, float], tuple[float, float], list[tuple[float, np.ndarray]]]:
    """Grid search over all four PD gains, local refinement, then a nonlinear polish.

    The polish repeats Nelder-Mead from the best point and a few seeded perturbations of it with
    the nonlinear envelope penalty of :func:`nonlinear_penalty` added (the grid candidates are also
    used as starts).
    """
    cands = grid_search(p, n=n, top=top)
    if verbose:
        for c, x in cands:
            print(f"grid cost {c:9.2f}  gains {np.round(x, 3)}")
    c, x = refine(p, [x for _c, x in cands])
    if verbose:
        print(f"refined cost {c:.2f}  gains {np.round(x, 4)}")
    if polish:
        rng = np.random.default_rng(0)
        starts = [x] + [x * np.exp(rng.normal(0.0, 0.2, 4)) for _ in range(5)]
        starts += [g for _c, g in cands]
        c, x = refine(p, starts, maxiter=200, nl=True)
        if verbose:
            print(f"nonlinear polish cost {c:.2f}  gains {np.round(x, 4)}")
    inner = (_r(float(x[0])), _r(float(x[1])))
    outer = (_r(float(x[2])), _r(float(x[3])))
    return inner, outer, cands


# --- altitude and yaw -------------------------------------------------------------------------
def design_hold(wn: float, zeta: float) -> tuple[float, float]:
    """PD gains of ``x'' = -(Kp x + Kd x')`` with natural frequency ``wn`` and damping ``zeta``."""
    return _r(wn * wn), _r(2.0 * zeta * wn)


def hold_pm(kp: float, kd: float, tau_motor: float) -> float:
    """Phase margin [deg] of ``(Kd s + Kp) / (s^2 (tau s + 1))`` (double integrator + motor lag)."""
    L = control.tf([kd, kp], np.polymul([1.0, 0.0, 0.0], [tau_motor, 1.0]))
    _gm, pm, _wg, _wp = control.margin(L)
    return float(pm)


# --- orchestration ----------------------------------------------------------------------------
@dataclass(frozen=True)
class Design:
    inner: tuple[float, float]
    outer: tuple[float, float]
    alt: tuple[float, float]
    yaw: tuple[float, float]


def design_all(p: Params | None = None, verbose: bool = False, n: int = 6) -> Design:
    p = load_params() if p is None else p
    inner, outer, _cands = fit_pd(p, n=n, verbose=verbose)
    alt = design_hold(*ALT_DESIGN)
    yaw = design_hold(*YAW_DESIGN)
    for name, g in (("alt", alt), ("yaw", yaw)):
        pm = hold_pm(g[0], g[1], p.motor.tau)
        if pm < HOLD_PM_MIN:
            raise RuntimeError(f"{name} hold phase margin {pm:.1f} deg below {HOLD_PM_MIN}")
    return Design(inner=inner, outer=outer, alt=alt, yaw=yaw)


def write_params(d: Design, path: Path = DEFAULT_PARAMS_PATH) -> None:
    """Store the gains with provenance ``designed (reconstruction)`` (JSON layout preserved)."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    for key, (kp, kd) in (
        ("inner", d.inner),
        ("outer", d.outer),
        ("alt", d.alt),
        ("yaw", d.yaw),
    ):
        raw["control"][key]["Kp"] = {"v": kp, "src": SRC}
        raw["control"][key]["Kd"] = {"v": kd, "src": SRC}
    path.write_text(json.dumps(raw, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def check_hard_targets(p: Params) -> list[str]:
    """Human-readable list of violated hard targets (empty list: all met).

    Hard: inner PM and crossover band, stable at GS = 1, per-axis slosh-mode GS threshold in
    1.3 to 1.95 with the slosh mode (not another one) crossing first, and every other mode stable up
    to GS 2.8. The Fig 12 decay rate is a separate flag, see :func:`check_decay_target`.
    """
    bad: list[str] = []
    for ax, (wc, pm) in inner_metrics(p).items():
        if not INNER_WC_HZ[0] <= wc <= INNER_WC_HZ[1]:
            bad.append(f"inner crossover {ax}: {wc:.3f} Hz outside {INNER_WC_HZ}")
        if pm < INNER_PM_MIN:
            bad.append(f"inner PM {ax}: {pm:.1f} deg < {INNER_PM_MIN}")
    for ax, r in outer_reports(p).items():
        lo, hi = SLOSH_THRESHOLD_RANGE
        if r.slosh_threshold is None or not lo <= r.slosh_threshold <= hi:
            bad.append(f"slosh-mode GS threshold {ax}: {r.slosh_threshold} outside [{lo}, {hi}]")
        if r.rigid_threshold is not None and r.rigid_threshold < RIGID_GS_MIN:
            bad.append(f"rigid-body GS threshold {ax}: {r.rigid_threshold:.3f} < {RIGID_GS_MIN}")
        row = next((x for x in r.gs_sweep if abs(x["gs"] - 1.0) < 1e-9), None)
        if row is not None and row["n_unstable"] > 0:
            bad.append(f"closed loop unstable at GS = 1 on {ax}")
    return bad


def check_decay_target(p: Params) -> list[str]:
    """Axes whose closed-loop slosh decay rate at GS = 1 is below ln 4 / 30 (Fig 12 target)."""
    return [
        f"slosh decay rate {ax}: {_decay_rate(r):.4f} < {DECAY_RATE_MIN:.4f}"
        for ax, r in outer_reports(p, sweep_step=10.0).items()
        if _decay_rate(r) < DECAY_RATE_MIN
    ]


def main(argv: list[str] | None = None) -> int:
    default_reports = Path(__file__).resolve().parents[4] / "reports"
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--write", action="store_true", help="update the parameter file and report")
    ap.add_argument("--params", type=Path, default=DEFAULT_PARAMS_PATH, help="parameter file")
    ap.add_argument("--out", type=Path, default=default_reports, help="report directory")
    args = ap.parse_args(argv)
    p = load_params(args.params)
    d = design_all(p, verbose=True)
    print(f"designed: {d}")
    pd = with_gains(p, d.inner, d.outer, d.alt, d.yaw)
    print(f"slosh mode {slosh_omega(pd):.3f} rad/s")
    for line in check_hard_targets(pd) or ["all hard targets met"]:
        print(" -", line)
    for line in check_decay_target(pd) or ["Fig 12 decay-rate target met"]:
        print(" -", line)
    if args.write:
        write_params(d, args.params)
        mg.write_outputs(load_params(args.params), args.out)
        print(f"wrote {args.params} and {args.out / 'margins.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
