"""Tune the AAC and the detector against the Fig 12-14 and section V.B criteria.

    uv run python -m slosh.tune_aac --write

Tuned values (all a labelled reconstruction): ``a0``, ``b_s``, ``kMin``, the detection
threshold, the high-pass corner (0.2-0.4 Hz) and the low-pass corner (0.05-0.2 Hz). ``b_e`` stays
0 (down-band only). The controller and the AAC never use the pendulum state: the spectral
damper works on the outer-loop control signal only.

Method
------
* With AAC off or in Monitor the plant does not depend on the AAC, so the Fig 12, Fig 13 and
  V.B (before t = 100 s) runs are simulated once; the detector is then replayed on the recorded
  control signal. The detection threshold does not feed back either, so it is chosen per filter
  pair: the geometric mean of a lower bound (``MARGIN x`` the largest Fig 12 y_SD, so Fig 12 never
  trips) and an upper bound (the y_SD reached shortly before the first dangerous amplitude in
  Fig 13 and V.B).
* A grid over (b_s, a0, kMin, HP corner, LP corner) runs the closed-loop Fig 14 and V.B
  simulations for every point; Nelder-Mead then polishes the best grid points over
  (log b_s, log a0, kMin, HP corner, LP corner, log threshold).
* The cost adds hinge penalties for each success criterion and the V.B recovery time.

The theta envelope is the 2 s sliding (trailing) max of theta.
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import time
from collections import deque
from collections.abc import Sequence
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, replace
from functools import cache
from pathlib import Path
from typing import Any

import numpy as np
from scipy.optimize import minimize

from .core.aac import Aac
from .core.sim import Sim
from .design.filter_design import design_all
from .params import DEFAULT_PARAMS_PATH, Filter, Params, load_params

ROOT = Path(__file__).resolve().parents[3]
REPORT_PATH = ROOT / "reports" / "aac_tuning.md"
SRC = "tuned (reconstruction)"
ENV_S = 2.0
DT = 0.01
MARGIN = 1.3  # threshold >= MARGIN x the largest Fig 12 y_SD (robust to FP differences)
TRIP_LEAD_S = 1.0  # the detector should trip this long before the dangerous amplitude
THETA_DANGER = 0.25
FIG14_THETA_MAX = 0.205
THETA_5DEG = 0.087
RECOVERY_MARGIN = 0.005
T_ENGAGE = 100.0
EXT_HORIZON_S = 300.0  # longer V.B run used only to report the full recovery time
BOUNDS = {
    "hp": (0.2, 0.4),
    "lp": (0.05, 0.2),
    "kmin": (0.05, 0.5),
}

# grid axes
GRID_BS = (300.0, 1000.0, 3000.0, 10000.0)
GRID_A0 = (0.03, 0.1, 0.3)
GRID_KMIN = (0.1, 0.2)
GRID_HP = (0.2, 0.3, 0.4)
GRID_LP = (0.05, 0.1, 0.2)


@dataclass(frozen=True)
class Cand:
    """One AAC parameter set."""

    b_s: float
    a0: float
    k_min: float
    hp_fc: float
    lp_fc: float
    threshold: float

    def clipped(self) -> Cand:
        return replace(
            self,
            hp_fc=min(max(self.hp_fc, BOUNDS["hp"][0]), BOUNDS["hp"][1]),
            lp_fc=min(max(self.lp_fc, BOUNDS["lp"][0]), BOUNDS["lp"][1]),
            k_min=min(max(self.k_min, BOUNDS["kmin"][0]), BOUNDS["kmin"][1]),
        )


def make_params(base: Params, c: Cand) -> Params:
    """``base`` with the AAC parameters of ``c`` (filters re-designed for the corners)."""
    hp, lp = design_all(c.hp_fc, c.lp_fc, float(base.control.rateHz))
    a = replace(
        base.aac,
        a0=c.a0,
        b_s=c.b_s,
        kMin=c.k_min,
        threshold=c.threshold,
        hp=Filter(c.hp_fc, base.aac.hp.order, tuple(tuple(r) for r in hp)),
        lp=Filter(c.lp_fc, base.aac.lp.order, tuple(tuple(r) for r in lp)),
    )
    return replace(base, aac=a)


# -- helpers ------------------------------------------------------------------------------------
def envelope(v: Sequence[float], dt: float = DT, window_s: float = ENV_S) -> np.ndarray:
    """Trailing sliding max over ``window_s`` (partial window at the start), O(n)."""
    n = max(1, round(window_s / dt))
    out = np.empty(len(v))
    dq: deque[int] = deque()
    for i, x in enumerate(v):
        while dq and v[dq[-1]] <= x:
            dq.pop()
        dq.append(i)
        if dq[0] <= i - n:
            dq.popleft()
        out[i] = v[dq[0]]
    return out


def first_time(t: np.ndarray, mask: np.ndarray) -> float | None:
    idx = np.flatnonzero(mask)
    return float(t[idx[0]]) if len(idx) else None


def run_sim(
    params: Params,
    preset: str,
    duration: float,
    mode: str | None = None,
    record_u: bool = False,
) -> tuple[list[dict[str, Any]], list[tuple[float, float]]]:
    """Run a preset; ``mode`` overrides the preset's initial AAC mode (e.g. 'monitor')."""
    sim = Sim(params)
    sim.enqueue({"type": "loadPreset", "id": preset})
    if mode is not None:
        sim.enqueue({"type": "setAacMode", "mode": mode})
    tel: list[dict[str, Any]] = []
    us: list[tuple[float, float]] = []
    for _ in range(round(duration / sim.dt_ctrl)):
        tel.append(sim.step_control())
        if record_u:
            us.append(sim._u_prev)
    return tel, us


# -- AAC-independent runs (Off / Monitor), simulated once ----------------------------------------
@dataclass
class OpenLoop:
    t: np.ndarray
    theta: np.ndarray
    env: np.ndarray
    u: list[tuple[float, float]]  # control signal of each tick

    @property
    def t_danger(self) -> float | None:
        """First time the envelope exceeds THETA_DANGER (Fig 13) / theta does (V.B)."""
        return first_time(self.t, self.env > THETA_DANGER)


@cache
def open_loop(name: str) -> OpenLoop:
    """Fig 12 / Fig 13 (Off-equivalent; dynamics do not depend on the AAC) and V.B up to engage."""
    base = load_params()
    # placeholders are never used: AAC runs in monitor and only its plant effect (none) matters
    p = make_params(base, Cand(100.0, 0.05, 0.2, 0.3, 0.1, 1.0))
    if name == "vb":
        tel, us = run_sim(p, "vb", T_ENGAGE, record_u=True)
    else:
        tel, us = run_sim(p, name, 60.0, mode="monitor", record_u=True)
    th = np.array([s["theta"] for s in tel])
    t = np.array([s["t"] for s in tel])
    return OpenLoop(t, th, envelope(th), us)


def replay_detector(
    params: Params, ol: OpenLoop
) -> tuple[np.ndarray, np.ndarray, list[float | None]]:
    """y_SD (n, 2) and detect (n, 2) of a Monitor-mode AAC fed with the recorded control signal."""
    aacs = (Aac(params), Aac(params))
    n = len(ol.u)
    y = np.zeros((n, 2))
    d = np.zeros((n, 2), dtype=bool)
    prev = (0.0, 0.0)
    for i in range(n):
        for ax in range(2):
            o = aacs[ax].step(prev[ax], 0.0, "monitor")
            y[i, ax] = o.ySD
            d[i, ax] = o.detect
        prev = ol.u[i]
    trips: list[float | None] = []
    for ax in range(2):
        trips.append(first_time(ol.t, d[:, ax]))
    return y, d, trips


@cache
def _ysd_series(hp_fc: float, lp_fc: float) -> dict[str, np.ndarray]:
    """y_SD (n, 2) of the three open-loop runs for one pair of filter corners."""
    base = load_params()
    p = make_params(base, Cand(100.0, 0.05, 0.2, hp_fc, lp_fc, 1.0))
    return {n: replay_detector(p, open_loop(n))[0] for n in ("fig12", "fig13", "vb")}


def best_threshold(hp_fc: float, lp_fc: float) -> tuple[float, float, float]:
    """(threshold, lower bound, upper bound) for one filter pair; threshold = geometric mean."""
    ys = _ysd_series(hp_fc, lp_fc)
    lower = MARGIN * float(ys["fig12"].max())
    uppers = []
    f13, vb = open_loop("fig13"), open_loop("vb")
    td13 = f13.t_danger
    # V.B: the raw theta crossing is the criterion (stricter than the envelope)
    tdvb = first_time(vb.t, vb.theta > THETA_DANGER)
    for name, td in (("fig13", td13), ("vb", tdvb)):
        if td is None:
            continue
        i = max(0, round((td - TRIP_LEAD_S) / DT) - 1)
        # the detector must have tripped by then on at least one axis: use the axis maximum
        uppers.append(float(ys[name][: i + 1].max(axis=1).max()))
    upper = min(uppers) if uppers else lower * 4.0
    thr = math.sqrt(lower * upper) if upper > lower else lower
    return thr, lower, upper


# -- evaluation ---------------------------------------------------------------------------------
@dataclass
class Metrics:
    cand: Cand
    # Fig 12
    f12_ymax: float
    f12_trip: bool
    # Fig 13 (Off dynamics, Monitor detector)
    f13_trip: float | None
    f13_t025: float | None
    # Fig 14
    f14_min: tuple[float, float]
    f14_k60: tuple[float, float]
    f14_theta_max: float
    # V.B
    vb_trip: float | None
    vb_t025: float | None
    vb_env_max_pre: float
    vb_recovery: float | None  # first time after engage with env < 5 deg [s since engage]
    vb_env_end: float
    vb_env_115: float
    cost: float


def evaluate(c: Cand, with_traces: bool = False) -> Metrics | tuple[Metrics, dict[str, Any]]:
    c = c.clipped()
    base = load_params()
    p = make_params(base, c)

    # detector on the AAC-independent runs
    traces: dict[str, Any] = {}
    out: dict[str, tuple[np.ndarray, np.ndarray, list[float | None]]] = {}
    for name in ("fig12", "fig13"):
        out[name] = replay_detector(p, open_loop(name))
    f12, f13 = open_loop("fig12"), open_loop("fig13")
    f12_trip = bool(out["fig12"][1].any())
    f12_ymax = float(out["fig12"][0].max())
    trips13 = [x for x in out["fig13"][2] if x is not None]
    f13_trip = min(trips13) if trips13 else None
    f13_t025 = f13.t_danger

    # closed loop: Fig 14 and V.B (full run, Monitor then Engaged at 100 s)
    tel14, _ = run_sim(p, "fig14", 60.0)
    kp = np.array([s["kT_pitch"] for s in tel14])
    kr = np.array([s["kT_roll"] for s in tel14])
    th14 = np.array([s["theta"] for s in tel14])
    telvb, _ = run_sim(p, "vb", 130.0)
    tvb = np.array([s["t"] for s in telvb])
    thvb = np.array([s["theta"] for s in telvb])
    envvb = envelope(thvb)
    detvb = np.array([s["detect_pitch"] or s["detect_roll"] for s in telvb])
    pre = tvb <= T_ENGAGE
    post = tvb > T_ENGAGE
    vb_trip = first_time(tvb, detvb)
    vb_t025 = first_time(tvb, thvb > THETA_DANGER)
    below = post & (envvb < THETA_5DEG)
    rec = first_time(tvb, below)
    vb_recovery = None if rec is None else rec - T_ENGAGE

    mn = (float(kp.min()), float(kr.min()))
    k60 = (float(kp[-1]), float(kr[-1]))

    # -- cost --
    cost = 0.0
    thr = c.threshold
    # keep the threshold centred (log scale) between the false-trip and the late-trip bounds
    cost += 0.3 * abs(math.log(thr / best_threshold(c.hp_fc, c.lp_fc)[0]))
    cost += 10.0 * float(f12_trip) + 5.0 * max(0.0, MARGIN - thr / max(f12_ymax, 1e-12))
    if f13_trip is None:
        cost += 20.0
    elif f13_t025 is not None:
        cost += 5.0 * max(0.0, f13_trip - (f13_t025 - TRIP_LEAD_S)) / f13_t025
    if vb_trip is None:
        cost += 20.0
    elif vb_t025 is not None:
        cost += 5.0 * max(0.0, vb_trip - (vb_t025 - TRIP_LEAD_S)) / 100.0
    cost += 200.0 * max(0.0, float(th14.max()) - FIG14_THETA_MAX)
    for m, k in zip(mn, k60, strict=True):
        cost += 5.0 * max(0.0, m - 0.9)
        # recovery toward 1 with a small safety margin over the 25 % criterion
        cost += 60.0 * max(0.0, (m + 0.25 * (1 - m)) + RECOVERY_MARGIN - k)
    cost += 2.0 * float(mn[0] >= mn[1])
    # V.B recovery: continuous in the envelope 15 s after engagement, plus the recovery time
    env115 = float(envvb[round((T_ENGAGE + 15.0) / DT) - 1])
    cost += 2.0 * max(0.0, env115 / THETA_5DEG - 1.0)
    cost += 1.0 if vb_recovery is None else min(1.0, vb_recovery / 30.0)
    cost += 0.0 if vb_recovery is not None else 2.0 * max(0.0, float(envvb[-1]) / THETA_5DEG - 1.0)
    cost += 10.0 * max(0.0, 0.35 - float(envvb[pre].max()))

    m = Metrics(
        c, f12_ymax, f12_trip, f13_trip, f13_t025, mn, k60, float(th14.max()), vb_trip, vb_t025,
        float(envvb[pre].max()), vb_recovery, float(envvb[-1]), env115, cost,
    )  # fmt: skip
    if not with_traces:
        return m
    traces["fig12"] = (f12, out["fig12"])
    traces["fig13"] = (f13, out["fig13"])
    traces["fig14"] = tel14
    traces["vb"] = telvb
    return m, traces


def _eval_cost(c: Cand) -> Metrics:
    m = evaluate(c)
    assert isinstance(m, Metrics)
    return m


# -- search -------------------------------------------------------------------------------------
def grid_points() -> list[Cand]:
    pts: list[Cand] = []
    for hp, lp in itertools.product(GRID_HP, GRID_LP):
        thr = best_threshold(hp, lp)[0]
        for b_s, a0, km in itertools.product(GRID_BS, GRID_A0, GRID_KMIN):
            pts.append(Cand(b_s, a0, km, hp, lp, thr))
    return pts


def _vec(c: Cand) -> np.ndarray:
    return np.array(
        [math.log(c.b_s), math.log(c.a0), c.k_min, c.hp_fc, c.lp_fc, math.log(c.threshold)]
    )


def _cand(v: Sequence[float]) -> Cand:
    return Cand(
        math.exp(v[0]), math.exp(v[1]), float(v[2]), float(v[3]), float(v[4]), math.exp(v[5])
    ).clipped()


def refine(c0: Cand, maxiter: int = 120) -> tuple[Cand, float]:
    res = minimize(
        lambda v: _eval_cost(_cand(v)).cost,
        _vec(c0),
        method="Nelder-Mead",
        options={"maxiter": maxiter, "xatol": 1e-3, "fatol": 1e-4, "adaptive": True},
    )
    return _cand(res.x), float(res.fun)


def search(workers: int, top: int, maxiter: int) -> Metrics:
    t0 = time.perf_counter()
    pts = grid_points()
    print(f"grid: {len(pts)} points", flush=True)
    res: list[Metrics] = []
    with ProcessPoolExecutor(workers) as ex:
        for i, m in enumerate(ex.map(_eval_cost, pts)):
            res.append(m)
            if (i + 1) % 20 == 0:
                print(f"  {i + 1}/{len(pts)} ({time.perf_counter() - t0:.0f} s)", flush=True)
    res.sort(key=lambda m: m.cost)
    print(f"grid done in {time.perf_counter() - t0:.0f} s; best cost {res[0].cost:.3f}", flush=True)
    for m in res[:5]:
        print(f"  {m.cost:7.3f} {m.cand}", flush=True)
    starts = [m.cand for m in res[:top]]
    with ProcessPoolExecutor(min(workers, len(starts))) as ex:
        refined = list(ex.map(refine, starts, itertools.repeat(maxiter)))
    best_c, best_cost = min(refined, key=lambda r: r[1])
    print(f"nelder-mead best cost {best_cost:.3f}: {best_c}", flush=True)
    m = _eval_cost(best_c)
    if m.cost > res[0].cost:  # never worse than the best grid point
        m = res[0]
    return m


# -- output -------------------------------------------------------------------------------------
def write_params(c: Cand, path: Path = DEFAULT_PARAMS_PATH) -> None:
    data = json.loads(path.read_text())
    a = data["aac"]
    vals = {"a0": c.a0, "b_s": c.b_s, "threshold": c.threshold, "kMin": c.k_min}
    for k, v in vals.items():
        a[k] = {"v": float(f"{v:.6g}"), "src": SRC}
    a["hp"]["fc"] = {"v": c.hp_fc, "src": SRC}
    a["lp"]["fc"] = {"v": c.lp_fc, "src": SRC}
    hp, lp = design_all(c.hp_fc, c.lp_fc, float(data["control"]["rateHz"]["v"]))
    a["hp"]["sos"]["v"] = hp
    a["lp"]["sos"]["v"] = lp
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def write_report(m: Metrics, path: Path = REPORT_PATH) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    params = load_params()  # committed values (written just before)
    res = evaluate(replace(m.cand, **{}), with_traces=True)
    assert isinstance(res, tuple)
    m2, tr = res
    thr = params.aac.threshold or m2.cand.threshold
    plots = path.parent / "aac_tuning"
    plots.mkdir(parents=True, exist_ok=True)

    def tel_cols(tel: list[dict[str, Any]]) -> dict[str, np.ndarray]:
        keys = ("t", "theta", "mx", "my", "kT_pitch", "kT_roll", "ySD_pitch", "ySD_roll")
        return {k: np.array([s[k] for s in tel]) for k in keys}

    series: dict[str, dict[str, np.ndarray]] = {}
    for name in ("fig12", "fig13"):
        ol, (y, _d, _tr) = tr[name]
        series[name] = {
            "t": ol.t,
            "theta": ol.theta,
            "ySD_pitch": y[:, 0],
            "ySD_roll": y[:, 1],
        }
    # x/y mass for fig12/fig13 need telemetry: re-run (cheap)
    for name in ("fig12", "fig13"):
        tel, _ = run_sim(params, name, 60.0, mode="monitor")
        series[name] = tel_cols(tel)
    series["fig14"] = tel_cols(tr["fig14"])
    series["vb"] = tel_cols(tr["vb"])
    notes = {
        "fig12": "Fig 12: GS 1, AAC off (detector shown from a Monitor replay; K_T not applied)",
        "fig13": "Fig 13: GS 2.3, AAC off (detector shown from a Monitor replay; K_T not applied)",
        "fig14": "Fig 14: GS 2.3, AAC engaged",
        "vb": "Section V.B: GS ramp to 2 in 20 s, Monitor, Engaged at t = 100 s",
    }
    for name, s in series.items():
        fig, ax = plt.subplots(4, 1, figsize=(9, 9), sharex=True)
        ax[0].plot(s["t"], s["theta"], label="theta")
        ax[0].plot(s["t"], envelope(list(s["theta"])), "--", label="2 s envelope")
        ax[0].set_ylabel("theta [rad]")
        ax[1].plot(s["t"], s["mx"], label="mass x (N)")
        ax[1].plot(s["t"], s["my"], label="mass y (E)")
        ax[1].set_ylabel("mass rel. [m]")
        ax[2].plot(s["t"], s["kT_pitch"], label="K_T pitch")
        ax[2].plot(s["t"], s["kT_roll"], label="K_T roll")
        ax[2].set_ylabel("K_T")
        ax[3].plot(s["t"], s["ySD_pitch"], label="y_SD pitch")
        ax[3].plot(s["t"], s["ySD_roll"], label="y_SD roll")
        ax[3].axhline(thr, color="k", ls=":", label="threshold")
        ax[3].set_ylabel("y_SD")
        ax[3].set_xlabel("t [s]")
        if name == "vb":
            for a in ax:
                a.axvline(T_ENGAGE, color="gray", ls="--", lw=0.8)
        for a in ax:
            a.grid(alpha=0.3)
            a.legend(loc="upper right", fontsize=8)
        ax[0].set_title(notes[name])
        fig.tight_layout()
        fig.savefig(plots / f"{name}.png", dpi=100)
        plt.close(fig)

    c = m2.cand
    rec = "not reached within 30 s" if m2.vb_recovery is None else f"{m2.vb_recovery:.1f} s"
    # longer horizon (information): when does the envelope finally reach 5 degrees?
    ext, _ = run_sim(params, "vb", T_ENGAGE + EXT_HORIZON_S)
    t_ext = np.array([s["t"] for s in ext])
    env_ext = envelope([s["theta"] for s in ext])
    after = first_time(t_ext, (t_ext > T_ENGAGE) & (env_ext < THETA_5DEG))
    rec_ext = (
        f"not reached within {EXT_HORIZON_S:.0f} s"
        if after is None
        else f"{after - T_ENGAGE:.1f} s"
    )

    def f(x: float | None) -> str:
        return "never" if x is None else f"{x:.2f} s"

    lines = [
        "# AAC and detector tuning (reconstruction)",
        "",
        "Generated by `python -m slosh.tune_aac --write`. Every value below is a tuned",
        "reconstruction: R-1 does not publish them. b_e = 0 (down-band only). The AAC and the",
        "detector work on the outer-loop control signal only; the pendulum state is never used.",
        "Reproduction is qualitative, for teaching. theta envelope = 2 s sliding max.",
        "",
        "## Final parameters",
        "",
        "| Parameter | Value | Range searched |",
        "|---|---|---|",
        f"| b_s | {c.b_s:.6g} | log grid {GRID_BS[0]:g}-{GRID_BS[-1]:g}, then free |",
        f"| a0 [1/s] | {c.a0:.6g} | log grid {GRID_A0[0]:g}-{GRID_A0[-1]:g}, then free |",
        f"| kMin | {c.k_min:.4g} | {BOUNDS['kmin'][0]}-{BOUNDS['kmin'][1]} |",
        f"| kMax | {params.aac.kMax:g} | fixed (assumed) |",
        f"| detection threshold (y_SD) | {c.threshold:.6g} | free (log) |",
        f"| HP corner [Hz] | {c.hp_fc:.4g} | {BOUNDS['hp'][0]}-{BOUNDS['hp'][1]} |",
        f"| LP corner [Hz] | {c.lp_fc:.4g} | {BOUNDS['lp'][0]}-{BOUNDS['lp'][1]} |",
        "",
        "The filter coefficients in `aac.hp.sos` / `aac.lp.sos` were regenerated for these corners",
        "(`slosh.design.filter_design`).",
        "",
        "Linear reference (reports/margins.md): the slosh mode goes unstable above a gain shift of",
        "1.344, so K_T x GS must fall below that: at GS 2.3 K_T < 0.58, at GS 2.0 K_T < 0.67.",
        "",
        "## Results",
        "",
        "| Preset | Quantity | Value |",
        "|---|---|---|",
        f"| fig12 | detector tripped | {m2.f12_trip} (largest y_SD {m2.f12_ymax:.3g}) |",
        f"| fig13 | detector trip time / envelope first > 0.25 rad | {f(m2.f13_trip)} / "
        f"{f(m2.f13_t025)} |",
        f"| fig14 | min K_T pitch / roll | {m2.f14_min[0]:.3f} / {m2.f14_min[1]:.3f} |",
        f"| fig14 | K_T at 60 s pitch / roll | {m2.f14_k60[0]:.3f} / {m2.f14_k60[1]:.3f} |",
        f"| fig14 | max theta | {m2.f14_theta_max:.4f} rad |",
        f"| vb | envelope max before 100 s | {m2.vb_env_max_pre:.3f} rad |",
        f"| vb | detector trip / theta first > 0.25 rad | {f(m2.vb_trip)} / {f(m2.vb_t025)} |",
        f"| vb | **recovery time after engagement (envelope < 0.087 rad)** | **{rec}** |",
        f"| vb | time to envelope < 0.087 rad after engagement, longer run | {rec_ext} |",
        f"| vb | envelope at 115 s (15 s after engagement) | {m2.vb_env_115:.3f} rad |",
        f"| vb | envelope at 130 s | {m2.vb_env_end:.3f} rad |",
        "",
        "## Plots",
        "",
    ]
    for name in ("fig12", "fig13", "fig14", "vb"):
        lines += [f"![{name}](aac_tuning/{name}.png)", ""]
    lines += [
        "## Known deviations",
        "",
        "See `python/tests/test_presets.py` for the encoded criteria and the expected failures.",
        "",
        "- **Fig 12 decay (from instability.md).** Fig 12 does not reach 0.05 rad in 30 s; the",
        "  fallback criterion (envelope decreasing, positive linear decay rate) is tested.",
        "- **Fig 14 K_T recovery margin.** K_T settles at about (0.35, 0.51) at 60 s because the",
        "  slow residual swing keeps y_SD above zero. The 25 % recovery criterion passes with a",
        "  margin of only about 0.005 on each axis; the search over (b_s, a0, corners) found no",
        "  design with a larger margin on both axes (pitch and roll trade against each other).",
        "- **V.B recovery.** The required slosh decay rate is about ln(4)/15 = 0.09 1/s. PD-only",
        "  gains change the slosh decay rate by about 0.03-0.045 1/s per unit of GS (reports/",
        "  gain_redesign.md), so even K_T at kMin gives a small decay rate, and recovery starts",
        "  from a large amplitude. Measured after engagement: envelope below 0.087 rad after",
        f"  {rec_ext} (a run longer than the preset); within the 30 s of the preset: {rec}.",
        "  The 15 s assertion in `tests/test_presets.py` is therefore an expected failure (xfail).",
        "  Lower a0 shortens the recovery slightly (about 140 s at a0 = 0.02) but then K_T at 60 s",
        "  in Fig 14 no longer recovers toward 1, so a0 is kept at the value that meets Fig 14.",
        "",
    ]
    path.write_text("\n".join(lines))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="slosh.tune_aac", description=__doc__.split("\n")[0])
    ap.add_argument("--write", action="store_true", help="write params and reports/aac_tuning.md")
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--top", type=int, default=4, help="grid points refined by Nelder-Mead")
    ap.add_argument("--maxiter", type=int, default=120)
    ap.add_argument("--refine-only", action="store_true", help="Nelder-Mead from the committed")
    ap.add_argument("--report-only", action="store_true", help="re-evaluate the committed values")
    a = ap.parse_args(argv)
    if a.report_only:
        p = load_params()
        assert p.aac.b_s is not None and p.aac.a0 is not None and p.aac.threshold is not None
        c = Cand(p.aac.b_s, p.aac.a0, p.aac.kMin, p.aac.hp.fc, p.aac.lp.fc, p.aac.threshold)
        m = _eval_cost(c)
    elif a.refine_only:
        p = load_params()
        assert p.aac.b_s is not None and p.aac.a0 is not None and p.aac.threshold is not None
        c0 = Cand(p.aac.b_s, p.aac.a0, p.aac.kMin, p.aac.hp.fc, p.aac.lp.fc, p.aac.threshold)
        starts = [
            replace(c0, a0=0.145, b_s=10000.0),
            replace(c0, a0=0.25, b_s=10000.0),
            replace(c0, a0=0.145, b_s=10000.0, hp_fc=0.4),
            replace(c0, a0=0.3, b_s=15000.0, k_min=0.05),
            replace(c0, a0=0.1, b_s=6000.0, k_min=0.05, hp_fc=0.3),
            replace(c0, a0=0.145, b_s=3782.0, k_min=0.05),
        ]
        with ProcessPoolExecutor(min(a.workers, len(starts))) as ex:
            refined = list(ex.map(refine, starts, itertools.repeat(a.maxiter)))
        for c, f in refined:
            print(f"  {f:7.3f} {c}", flush=True)
        m = _eval_cost(min(refined, key=lambda r: r[1])[0])
    else:
        m = search(a.workers, a.top, a.maxiter)
    print(m)
    if a.write:
        write_params(m.cand)
        print(f"wrote {DEFAULT_PARAMS_PATH}")
        write_report(m)
        print(f"wrote {REPORT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
