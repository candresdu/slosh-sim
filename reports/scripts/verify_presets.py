# ruff: noqa: E501  (long report strings)
"""Independent verification of the Python reference model against the success criteria.

    cd python && uv run python ../reports/scripts/verify_presets.py
    (or)  python/.venv/bin/python reports/scripts/verify_presets.py   # from the repo root

Writes ``reports/verification_python.md`` (one table: criterion, target, measured, status) and exits 0
when no row is FAIL. Status values: PASS, FAIL, REPORTED (guidance only), DEVIATION (a documented,
accepted departure from the requirement).

Independence. Nothing here reuses a result or a mode label from ``slosh.design.margins`` or from
``tests/``. The closed-loop eigenvalues and eigenvectors are computed here from the raw hover
linearization (``slosh.design.linearize.hover_linearization``: the full 23-state closed discrete
model with the unit-gain outer-loop injection). The gain shift is applied here by closing the outer
PD loop by hand. Preset behaviour is measured from the telemetry of ``slosh.run.run_preset`` (the
Monitor variants use ``slosh.core.sim.Sim`` directly). The margins.py report is used only for the
*reported* Table 1 comparison and as a cross-check next to the independent numbers.

Definitions used below.
* theta envelope: sliding max of theta over the last 2 s.
* Neutral modes: eigenvalues at z = 1 that do not move with the gain shift (redundant states of the
  23-state model: quaternion norm, pendulum-vector norm, pendulum spin about the rod). They are
  excluded and counted; their invariance over the whole GS sweep is checked.
* Slosh-like mode: closed-loop pole at 0.45 to 0.6 Hz with pendulum participation
  r = L |dn| / |dp_quad| > 5 (from the eigenvector).
"""

from __future__ import annotations

import dataclasses
import inspect
import json
import math
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "python" / "src"))

from slosh.core import controller as controller_mod  # noqa: E402
from slosh.core.controller import Controller, Ref, meas_from_state  # noqa: E402
from slosh.core.dynamics import Hold, thrust_force_ned  # noqa: E402
from slosh.core.initial import hover_omega, initial_state  # noqa: E402
from slosh.core.rk4 import rk4_step  # noqa: E402
from slosh.core.sim import Sim  # noqa: E402
from slosh.design import margins as margins_mod  # noqa: E402
from slosh.design.linearize import AXES, hover_linearization, outer_loop_ss  # noqa: E402
from slosh.params import DEFAULT_PARAMS_PATH, load_params  # noqa: E402
from slosh.run import run_preset  # noqa: E402
from slosh.story import (  # noqa: E402
    ln_slope,
    run_story,
    story_times,
    trip_delay_from_amplitude,
)

DT = 0.01
BAND_HZ = (0.45, 0.60)
R_MIN = 5.0
THETA_DANGER = 0.25
FIVE_DEG = math.radians(5.0)
REPORT_PATH = REPO / "reports" / "verification_python.md"

# R-1 Table 1 targets (guidance only)
TABLE1 = "PM 22 deg near 0.2 Hz; HF GM 2.6 near 0.525 Hz; no LF GM"
REF_INSTAB = "reports/instability.md, 'Deviation from R-1'"
REF_AAC = "reports/aac_tuning.md, 'Known deviations'"


@dataclass
class Row:
    key: str
    criterion: str
    target: str
    measured: str
    status: str  # PASS | FAIL | REPORTED | DEVIATION
    note: str = ""


ROWS: list[Row] = []
STORY_LINES: list[str] = []  # the "Story preset" section of the report


def add(key: str, criterion: str, target: str, measured: str, status: str, note: str = "") -> None:
    ROWS.append(Row(key, criterion, target, measured, status, note))
    print(f"[{status:9s}] {key}: {criterion} | target {target} | measured {measured}", flush=True)


def ok(cond: bool) -> str:
    return "PASS" if cond else "FAIL"


# ------------------------------------------------------------------------------------------------
# helpers
# ------------------------------------------------------------------------------------------------
def envelope(v: list[float], window_s: float = 2.0) -> list[float]:
    n = round(window_s / DT)
    return [max(v[max(0, i - n + 1) : i + 1]) for i in range(len(v))]


def env_at(env: list[float], t: float) -> float:
    return env[round(t / DT) - 1]


def rms(v: list[float]) -> float:
    return math.sqrt(sum(a * a for a in v) / len(v))


def window(tel: list[dict[str, Any]], a: float, b: float) -> list[dict[str, Any]]:
    return [s for s in tel if a < s["t"] <= b + 1e-9]


def tripped(s: dict[str, Any]) -> bool:
    return bool(s["detect_pitch"] or s["detect_roll"])


def first_trip(tel: list[dict[str, Any]]) -> float | None:
    return next((s["t"] for s in tel if tripped(s)), None)


def first_theta_above(tel: list[dict[str, Any]], lim: float) -> float | None:
    return next((s["t"] for s in tel if s["theta"] > lim), None)


def peak_freq_hz(sigs: list[list[float]], t0: float, t1: float, nfft: int = 1 << 18) -> float:
    """Dominant frequency (summed power spectra of the signals; Hann; mean removed; zero-padded)."""
    i0, i1 = round(t0 / DT), round(t1 / DT)
    power = None
    for s in sigs:
        seg = np.asarray(s[i0:i1], dtype=float)
        seg = (seg - seg.mean()) * np.hanning(len(seg))
        sp = np.abs(np.fft.rfft(seg, nfft)) ** 2
        power = sp if power is None else power + sp
    freqs = np.fft.rfftfreq(nfft, DT)
    sel = freqs > 0.05
    return float(freqs[sel][np.argmax(power[sel])])  # type: ignore[index]


def fmt(v: float | None, f: str = "{:.4g}") -> str:
    return "n/a" if v is None else f.format(v)


# ------------------------------------------------------------------------------------------------
# 1. independent linear analysis (eigenvalues / eigenvectors of the closed loop)
# ------------------------------------------------------------------------------------------------
@dataclass
class Pole:
    mag: float
    freq_hz: float
    r: float
    rate: float  # -ln|z| / Ts  (>0 decaying)


def closed_loop(lin: Any, kp: float, kd: float, axis: str, gs: float) -> np.ndarray:
    """23-state closed loop: outer PD u = -GS (Kp pos + Kd vel) closed on ``axis``; GS = 1 on the
    other axis. ``lin.B_d`` is the response to the (unit-injected) lateral command ``u``."""
    A = lin.A_d.copy()
    for ax, a in AXES.items():
        g = gs if ax == axis else 1.0
        row = np.zeros(A.shape[0])
        row[a.pos] = kp
        row[a.vel] = kd
        A -= g * np.outer(lin.B_d[:, a.u_index], row)
    return A


def poles_of(A: np.ndarray, Ts: float, L: float) -> tuple[list[Pole], int]:
    """Non-neutral poles with participation; second value = number of neutral (z = 1) modes."""
    w, V = np.linalg.eig(A)
    out: list[Pole] = []
    neutral = 0
    for z, v in zip(w, V.T, strict=True):
        if abs(z - 1.0) < 1e-9:
            neutral += 1
            continue
        dp = float(np.linalg.norm(v[0:3]))
        dn = float(np.linalg.norm(v[13:16]))
        r = L * dn / dp if dp > 0 else math.inf
        out.append(
            Pole(
                mag=float(abs(z)),
                freq_hz=float(abs(np.angle(z)) / (2 * math.pi * Ts)),
                r=r,
                rate=float(-math.log(abs(z)) / Ts),
            )
        )
    return out, neutral


def is_slosh_like(q: Pole) -> bool:
    return BAND_HZ[0] <= q.freq_hz <= BAND_HZ[1] and q.r > R_MIN


def linear_checks(p: Any) -> dict[str, Any]:
    lin = hover_linearization(p)
    Ts, L = lin.Ts, p.pendulum.L
    kp, kd = p.control.outer.Kp, p.control.outer.Kd
    res: dict[str, Any] = {}
    grid = np.round(np.arange(0.5, 3.0 + 1e-9, 0.01), 4)
    for axis in ("x", "y"):
        info: dict[str, Any] = {}
        neutral_counts = set()
        thr_bracket: tuple[float, float] | None = None
        other_max, other_gs = 0.0, 0.0
        all_unstable_slosh = True
        unstable_pair_ok = True
        prev_gs = None
        for gs in grid:
            ps, nn = poles_of(closed_loop(lin, kp, kd, axis, float(gs)), Ts, L)
            neutral_counts.add(nn)
            unstable = [q for q in ps if q.mag > 1.0 + 1e-12]
            if unstable and thr_bracket is None and prev_gs is not None:
                thr_bracket = (prev_gs, float(gs))
            if gs <= 2.8 + 1e-9:
                if not all(is_slosh_like(q) for q in unstable):
                    all_unstable_slosh = False
                if len(unstable) not in (0, 2):
                    unstable_pair_ok = False
                for q in ps:
                    if not is_slosh_like(q) and q.mag > other_max:
                        other_max, other_gs = q.mag, float(gs)
            if gs == 1.0:
                info["gs1_max_mag"] = max(q.mag for q in ps)
                sl = [q for q in ps if is_slosh_like(q)]
                # the axis under test = the slosh pole whose rate changes with GS; at GS 1 both axes
                # have the same pair, so take the worst (slowest) rate
                info["gs1_rate"] = min(q.rate for q in sl) if sl else math.nan
                info["gs1_stable"] = all(q.mag < 1.0 for q in ps)
            prev_gs = float(gs)
        info["neutral_counts"] = sorted(neutral_counts)
        info["other_max_mag"], info["other_max_gs"] = other_max, other_gs
        info["all_unstable_slosh"] = all_unstable_slosh
        info["unstable_pair_ok"] = unstable_pair_ok

        # bisection of the first crossing, then the pole there
        assert thr_bracket is not None, f"no instability found on axis {axis} up to GS 3.0"
        lo, hi = thr_bracket
        for _ in range(60):
            mid = 0.5 * (lo + hi)
            ps, _ = poles_of(closed_loop(lin, kp, kd, axis, mid), Ts, L)
            if any(q.mag > 1.0 + 1e-12 for q in ps):
                hi = mid
            else:
                lo = mid
        ps, _ = poles_of(closed_loop(lin, kp, kd, axis, hi), Ts, L)
        crit = max(ps, key=lambda q: q.mag)
        info["threshold"] = hi
        info["crit_freq_hz"], info["crit_r"], info["crit_mag"] = crit.freq_hz, crit.r, crit.mag
        # linear rate at GS 2.3 (unstable, for the nonlinear cross-check)
        ps23, _ = poles_of(closed_loop(lin, kp, kd, axis, 2.3), Ts, L)
        info["rate_gs23"] = min(q.rate for q in ps23 if is_slosh_like(q))
        res[axis] = info
    return res


def margins_reported(p: Any) -> dict[str, Any]:
    out = {}
    for ax in ("x", "y"):
        rep = margins_mod.analyze_axis(ax, p)
        out[ax] = margins_mod.attach_modes(rep, outer_loop_ss(ax, p), p, ax)
    return out


# ------------------------------------------------------------------------------------------------
# 2. free slosh frequency and energy
# ------------------------------------------------------------------------------------------------
def free_slosh_frequency(p: Any) -> tuple[float, float]:
    """Controller off: constant hover rotor speeds, zero torque, quad free. Small planar swing.
    Returns (frequency from zero crossings [Hz], number of crossings used)."""
    om = hover_omega(p)
    hold = Hold((0.0, 0.0, 0.0), (om, om, om, om))
    x = initial_state(p, theta=0.05)
    t_cross: list[float] = []
    prev = x[13]
    n_steps = 40000
    for k in range(n_steps):
        x = rk4_step(x, 1e-3, hold, p)
        cur = x[13]
        if prev < 0.0 <= cur or prev > 0.0 >= cur:
            t_cross.append((k + prev / (prev - cur)) * 1e-3)
        prev = cur
    n = len(t_cross)
    freq = (n - 1) / (2.0 * (t_cross[-1] - t_cross[0]))
    return freq, float(n)


def total_energy(x: list[float], p: Any) -> float:
    m_q, m_p, L, g = p.vehicle.m_q, p.pendulum.m_p, p.pendulum.L, p.sim.g
    vq = x[3:6]
    n, wp = x[13:16], x[16:19]
    ndot = (
        wp[1] * n[2] - wp[2] * n[1],
        wp[2] * n[0] - wp[0] * n[2],
        wp[0] * n[1] - wp[1] * n[0],
    )
    vm = [vq[i] + L * ndot[i] for i in range(3)]
    ke = 0.5 * m_q * sum(a * a for a in vq) + 0.5 * m_p * sum(a * a for a in vm)
    Jx, Jy, Jz = p.vehicle.J
    ke += 0.5 * (Jx * x[10] ** 2 + Jy * x[11] ** 2 + Jz * x[12] ** 2)
    pd = x[2]
    pe_grav = -m_q * g * pd - m_p * g * (pd + L * n[2])  # D is down
    fn, fe, fd, _ = thrust_force_ned(x, p.vehicle.k_f)
    pe_thrust = -(fn * x[0] + fe * x[1] + fd * x[2])  # thrust is constant in NED (attitude fixed)
    return ke + pe_grav + pe_thrust


def energy_drift(p: Any) -> tuple[float, float]:
    """Zero damping, constant hover thrust, no torque, 60 s, kick theta 0.2 / phiDot 0.6.
    Returns (max |E - E0| / E_osc, E_osc) where E_osc = E0 - E(rest) is the oscillation energy."""
    p0 = dataclasses.replace(p, pendulum=dataclasses.replace(p.pendulum, k_damp=0.0))
    om = hover_omega(p0)
    hold = Hold((0.0, 0.0, 0.0), (om, om, om, om))
    x = initial_state(p0, theta=0.2, phi_dot=0.6)
    e0 = total_energy(x, p0)
    e_rest = total_energy(initial_state(p0), p0)
    e_osc = e0 - e_rest
    worst = 0.0
    for k in range(60000):
        x = rk4_step(x, 1e-3, hold, p0)
        if k % 100 == 99:
            worst = max(worst, abs(total_energy(x, p0) - e0))
    return worst / e_osc, e_osc


# ------------------------------------------------------------------------------------------------
# 3. provenance, realism settings, no pendulum feedback
# ------------------------------------------------------------------------------------------------
TAGS = ("assumed", "designed (reconstruction)", "tuned (reconstruction)", "optional realism")
R1_TABLE2 = {
    ("vehicle", "m_q"): 1.5207,
    ("vehicle", "arm"): 0.241,
    ("vehicle", "k_f"): 5.8597e-06,
    ("vehicle", "k_tau"): 2.925e-09,
    ("pendulum", "m_p"): 0.05,
    ("pendulum", "L"): 1.0,
}


def walk_leaves(node: Any, path: tuple[str, ...] = ()) -> list[tuple[tuple[str, ...], Any, str]]:
    if isinstance(node, dict):
        if "v" in node and "src" in node:
            return [(path, node["v"], node["src"])]
        out = []
        for k, v in node.items():
            out += walk_leaves(v, (*path, k))
        return out
    return []


def provenance_checks() -> None:
    raw = json.loads(Path(DEFAULT_PARAMS_PATH).read_text(encoding="utf-8"))
    leaves = walk_leaves(raw)
    bad: list[str] = []
    counts = {"R-1": 0, **{t: 0 for t in TAGS}}
    for path, v, src in leaves:
        name = ".".join(path)
        if v is None:
            bad.append(f"{name}: null value")
        if src.startswith("R-1"):
            counts["R-1"] += 1
            continue
        tag = next((t for t in TAGS if t in src), None)
        if tag is None:
            bad.append(f"{name}: src={src!r}")
        else:
            counts[tag] += 1
    cnt = ", ".join(f"{k}: {v}" for k, v in counts.items())
    add(
        "prov-tags",
        "Every non-R-1 parameter is tagged",
        "all leaves: R-1 source or one of assumed / designed (reconstruction) / tuned "
        "(reconstruction) / optional realism; none null",
        f"{len(leaves)} leaves ({cnt}); untagged: {bad or 'none'}",
        ok(not bad),
    )
    d = {path: (v, src) for path, v, src in leaves}
    mism = [
        f"{'.'.join(k)}={d[k][0]} (src {d[k][1]!r})"
        for k, want in R1_TABLE2.items()
        if not (d[k][0] == want and d[k][1].startswith("R-1"))
    ]
    j_ok = d[("vehicle", "J")][0] == [0.0211, 0.0216, 0.01455] and d[("vehicle", "J")][
        1
    ].startswith("R-1")
    add(
        "prov-table2",
        "R-1 Table 2 values (FR-1) match default.json and cite R-1",
        "m_q 1.5207, I diag(0.0211, 0.0216, 0.01455), arm 0.241, k_f 5.8597e-6, k_tau 2.925e-9, "
        "m_p 0.05, L 1",
        "all match" if not mism and j_ok else f"mismatch: {mism}, J ok: {j_ok}",
        ok(not mism and j_ok),
    )
    kd = d[("pendulum", "k_damp")]
    add(
        "prov-kdamp",
        "k_damp tagged assumed and cites its revision",
        "src contains 'assumed' and 'k1 = k2'",
        f"v = {kd[0]}, src = {kd[1]!r}",
        ok("assumed" in kd[1] and "k1 = k2" in kd[1]),
    )
    lat, noise = d[("sensing", "latencyMs")], d[("sensing", "noise", "enabled")]
    add(
        "realism-off",
        "Latency and noise are off (optional realism)",
        "latencyMs = 0, noise.enabled = false",
        f"latencyMs = {lat[0]}, noise.enabled = {noise[0]}",
        ok(lat[0] == 0 and noise[0] is False),
    )


def no_pendulum_feedback(p: Any) -> None:
    src = inspect.getsource(controller_mod.meas_from_state)
    idx = [int(m) for m in re.findall(r"x\[(\d+)\]", src)]
    sig = inspect.signature(Controller.step)
    static_ok = bool(idx) and max(idx) < 13 and "x[13" not in src

    # dynamic: bit-identical controller outputs for different pendulum states, same quad state
    rng = np.random.default_rng(7)
    c1, c2 = Controller(p, 1), Controller(p, 1)
    base = initial_state(p)
    base[0:3] = [0.01, -0.02, 0.0]
    base[3:6] = [0.05, 0.02, 0.0]
    base[7:10] = [0.01, -0.02, 0.003]
    base[6] = math.sqrt(1 - sum(a * a for a in base[7:10]))
    worst = 0
    same = True
    for _ in range(60):
        x1, x2 = list(base), list(base)
        for x in (x1, x2):
            n = rng.normal(size=3)
            n[2] = abs(n[2]) + 1.0
            n /= np.linalg.norm(n)
            x[13:16] = list(n)
            x[16:19] = list(rng.normal(size=3))
        o1 = c1.step(meas_from_state(x1), Ref(), 2.0, (0.7, 0.9))
        o2 = c2.step(meas_from_state(x2), Ref(), 2.0, (0.7, 0.9))
        worst += 1
        same = same and (o1.hold == o2.hold and o1.u == o2.u)
        base[0] += 1e-4  # let the filters see changing input
    add(
        "no-pend-fb",
        "Controller never measures or feeds back the pendulum state",
        "meas_from_state reads x[0..12] only; Controller.step outputs identical for any pendulum "
        "state",
        f"max state index read = {max(idx) if idx else 'n/a'}; step() args = "
        f"{[a for a in sig.parameters if a != 'self']}; {worst} steps with random n, w_p: "
        f"outputs {'bit-identical' if same else 'DIFFER'}",
        ok(static_ok and same),
    )


# ------------------------------------------------------------------------------------------------
# 4. preset runs
# ------------------------------------------------------------------------------------------------
def run_variant(preset: str, duration: float, mode: str | None) -> list[dict[str, Any]]:
    sim = Sim(load_params())
    sim.enqueue({"type": "loadPreset", "id": preset})
    if mode is not None:
        sim.enqueue({"type": "setAacMode", "mode": mode})
    return [sim.step_control() for _ in range(round(duration / DT))]


def small_signal_growth(
    gs: float, theta0: float = 0.01, t0: float = 10.0, t1: float = 40.0
) -> float:
    """Nonlinear sim, AAC off, planar kick of ``theta0`` rad: slope of log(theta envelope)."""
    sim = Sim(load_params())
    sim.enqueue({"type": "setGainShift", "value": gs})
    sim.enqueue({"type": "setAacMode", "mode": "off"})
    sim.enqueue({"type": "kick", "theta": theta0, "phiDot": 0.0})
    tel = [sim.step_control() for _ in range(round(t1 / DT))]
    env = envelope([s["theta"] for s in tel])
    ts = np.array([s["t"] for s in tel])
    sel = (ts >= t0) & (ts <= t1)
    slope = np.polyfit(ts[sel], np.log(np.array(env)[sel]), 1)[0]
    return float(slope)


def preset_checks(p: Any) -> None:
    t_start = time.time()
    fig12 = run_preset("fig12", 60.0)
    fig12m = run_variant("fig12", 60.0, "monitor")
    fig13 = run_preset("fig13", 60.0)
    fig13_off = run_variant("fig13", 60.0, "off")
    fig14 = run_preset("fig14", 60.0)
    vb = run_preset("vb", 270.0)
    print(f"preset runs done in {time.time() - t_start:.0f} s wall", flush=True)

    # ---- Fig 12 ---------------------------------------------------------------------------
    env = envelope([s["theta"] for s in fig12])
    e10, e30, e60 = env_at(env, 10), env_at(env, 30), env_at(env, 60)
    lin_rate = LIN["x"]["gs1_rate"], LIN["y"]["gs1_rate"]
    outcome_a = e30 < 0.05
    outcome_b = e60 < e30 < e10 and min(lin_rate) > 0
    meas = (
        f"env(10/30/60 s) = {e10:.4f} / {e30:.4f} / {e60:.4f} rad; independent linear GS 1 slosh "
        f"decay rate = {lin_rate[0]:.4f} (x), {lin_rate[1]:.4f} (y) 1/s"
    )
    if outcome_a:
        add(
            "fig12",
            "Fig 12: theta envelope below 0.05 rad within 30 s (outcome A)",
            "env(30 s) < 0.05",
            meas,
            "PASS",
        )
    elif outcome_b:
        add(
            "fig12",
            "Fig 12 (outcome B fallback closed by #18): env(60) < env(30) < env(10) and linear GS 1 "
            "slosh-mode decay rate > 0",
            "monotonic decrease; rate > 0 (R-1 original: env(30 s) < 0.05 rad)",
            meas + f"; env(30 s) = {e30:.4f} rad vs R-1 target 0.05 rad (not met)",
            "DEVIATION",
            f"documented deviation, see {REF_INSTAB}",
        )
    else:
        add(
            "fig12",
            "Fig 12 decay (outcome A or B)",
            "A: env(30) < 0.05; B: decreasing, rate > 0",
            meas,
            "FAIL",
        )
    t12 = [first_trip(fig12), first_trip(fig12m)]
    mx12 = max(max(s["ySD_pitch"], s["ySD_roll"]) for s in fig12m)
    add(
        "fig12-trip",
        "Fig 12: detector does not trip (AAC off and Monitor)",
        "no trip in 60 s",
        f"first trip: off {t12[0]}, monitor {t12[1]}; max y_SD (monitor) = {mx12:.2e} vs threshold "
        f"{p.aac.threshold:.2e}",
        ok(t12 == [None, None]),
    )

    # ---- Fig 13 ---------------------------------------------------------------------------
    env = envelope([s["theta"] for s in fig13])
    e10, e60 = env_at(env, 10), env_at(env, 60)
    lo, hi = round(10 / DT) - 1, round(60 / DT)
    emin = min(env[lo:hi])
    add(
        "fig13-grow",
        "Fig 13 (AAC Monitor, same motion as Off): envelope(60 s) > envelope(10 s)",
        "env(60) > env(10)",
        f"env(10 s) = {e10:.3f}, env(30 s) = {env_at(env, 30):.3f}, env(60 s) = {e60:.3f} rad",
        ok(e60 > e10),
    )
    add(
        "fig13-norecover",
        "Fig 13: no recovery",
        "min envelope over 10-60 s >= 0.2 rad (the starting amplitude) and env(60) > env(10)",
        f"min env(10-60 s) = {emin:.3f} rad; env(60 s) = {e60:.3f}",
        ok(emin >= 0.2 and e60 > e10),
    )
    e50 = env_at(env, 50)
    if e60 < 1.05 * e50:
        sat = [
            any(s["sat_att"] or s["sat_motor"] for s in window(fig13, a, a + 2))
            for a in range(50, 60, 2)
        ]
        plateau_ok = all(sat)
        meas = f"env(60)/env(50) = {e60 / e50:.3f} (< 1.05, plateau); saturated in each 2 s window: {sat}"
    else:
        plateau_ok = True
        sat_frac = sum(1 for s in window(fig13, 50, 60) if s["sat_att"] or s["sat_motor"]) / len(
            window(fig13, 50, 60)
        )
        meas = (
            f"env(60)/env(50) = {e60 / e50:.3f} (>= 1.05: still growing, no plateau); saturation "
            f"fraction 50-60 s = {sat_frac:.2f}"
        )
    add(
        "fig13-plateau",
        "Fig 13: any plateau comes only from saturation (attitude-command or motor limits)",
        "if env(60) < 1.05 env(50): saturation active in every 2 s window of 50-60 s",
        meas,
        ok(plateau_ok),
    )
    ex, ey = (
        rms([s["mx"] for s in window(fig13, 0, 5)]),
        rms([s["my"] for s in window(fig13, 0, 5)]),
    )
    lx, ly = (
        rms([s["mx"] for s in window(fig13, 50, 60)]),
        rms([s["my"] for s in window(fig13, 50, 60)]),
    )
    add(
        "fig13-migrate",
        "Fig 13: dominant mass motion migrates x -> y within 60 s",
        "x-RMS > y-RMS over 0-5 s and y-RMS > x-RMS over 50-60 s",
        f"0-5 s: x {ex:.3f} / y {ey:.3f} m; 50-60 s: x {lx:.3f} / y {ly:.3f} m "
        f"(late y/x = {ly / lx:.3f})",
        ok(ex > ey and ly > lx),
        "thin late margin: y and x are nearly equal (late motion is close to circular)"
        if ly / lx < 1.05
        else "",
    )
    same = [s["theta"] for s in fig13] == [s["theta"] for s in fig13_off]
    trip = first_trip(fig13)
    t_raw = first_theta_above(fig13, THETA_DANGER)
    t_env = next((s["t"] for s, e in zip(fig13, env, strict=True) if e > THETA_DANGER), None)
    add(
        "fig13-trip",
        "Fig 13: detector trips before theta exceeds 0.25 rad",
        "trip time < first time theta > 0.25 rad (shipped preset, AAC in Monitor)",
        f"trip at {fmt(trip, '{:.2f}')} s; first raw theta > 0.25 at {fmt(t_raw, '{:.2f}')} s, "
        f"first envelope > 0.25 at {fmt(t_env, '{:.2f}')} s; theta identical to the same preset "
        f"forced to AAC Off: {same}; AAC-off detector hidden: {first_trip(fig13_off) is None}",
        ok(
            same
            and trip is not None
            and (t_raw is None or trip < t_raw)
            and first_trip(fig13_off) is None
        ),
        "Monitor computes K_T and y_SD but does not apply K_T, so the plant equals the Off run",
    )
    th, mxs, mys = [s["theta"] for s in fig13], [s["mx"] for s in fig13], [s["my"] for s in fig13]
    f_theta = peak_freq_hz([th], 10, 40)
    f_signed = peak_freq_hz([mxs, mys], 10, 40)
    # theta is a magnitude (non-negative), so a planar swing shows at twice the swing frequency;
    # the oscillation frequency of theta is read from its signed horizontal components too
    doubled = abs(f_theta - 2.0 * f_signed) < 0.1
    raw_in_band = BAND_HZ[0] <= f_theta <= BAND_HZ[1]
    add(
        "fig13-fft",
        "Fig 13: FFT of theta over 10-40 s peaks at the slosh frequency",
        f"{BAND_HZ[0]}-{BAND_HZ[1]} Hz",
        f"signed theta components (mass x, y): {f_signed:.3f} Hz; raw theta magnitude: "
        f"{f_theta:.3f} Hz (= {f_theta / f_signed:.2f} x the signed peak)",
        ok(BAND_HZ[0] <= f_signed <= BAND_HZ[1] and (raw_in_band or doubled)),
        "interpretation: raw theta is non-negative, so its spectrum peaks at 2x the swing frequency "
        "(frequency doubling); the swing frequency is read from the signed components theta cos(phi), "
        "theta sin(phi). The raw-theta peak itself is "
        + ("in band" if raw_in_band else "outside the band for that reason"),
    )

    # ---- Fig 14 ---------------------------------------------------------------------------
    kp = [s["kT_pitch"] for s in fig14]
    kr = [s["kT_roll"] for s in fig14]
    add(
        "fig14-drop",
        "Fig 14: K_T drops below 1 on both axes",
        "min K_T < 1 (pitch and roll)",
        f"min K_T pitch = {min(kp):.3f}, roll = {min(kr):.3f}",
        ok(min(kp) < 1 and min(kr) < 1),
    )
    add(
        "fig14-asym",
        "Fig 14: pitch minimum lower than roll minimum",
        "min K_T pitch < min K_T roll",
        f"{min(kp):.3f} < {min(kr):.3f}",
        ok(min(kp) < min(kr)),
    )
    rec = [(k[-1] - min(k)) / (1 - min(k)) for k in (kp, kr)]
    add(
        "fig14-recover",
        "Fig 14: K_T recovers toward 1",
        "K_T(60 s) >= min + 25 % of (1 - min) on both axes",
        f"K_T(60 s) pitch {kp[-1]:.3f}, roll {kr[-1]:.3f}; recovered fraction {rec[0]:.2f} / {rec[1]:.2f}",
        ok(min(rec) >= 0.25),
        f"thin margin, see {REF_AAC}" if min(rec) < 0.3 else "",
    )
    thmax = max(s["theta"] for s in fig14)
    add(
        "fig14-theta",
        "Fig 14: theta stays below 0.2 rad",
        "max theta < 0.2 rad",
        f"max theta = {thmax:.4f} rad",
        ok(thmax < 0.2),
    )

    # ---- Section V.B ----------------------------------------------------------------------
    vb130 = vb[: round(130 / DT)]
    env = envelope([s["theta"] for s in vb])
    pre = [s for s in vb if s["t"] <= 100.0 + 1e-9]
    e_pre = max(env[: round(100 / DT)])
    th_pre = max(s["theta"] for s in pre)
    t35 = next((s["t"] for s, e in zip(vb, env, strict=True) if e >= 0.35), None)
    gs_end = vb[round(20 / DT) - 1]["gainShift"]
    modes = (vb[10]["aacMode"], vb[round(99 / DT)]["aacMode"], vb[round(101 / DT)]["aacMode"])
    add(
        "vb-grow",
        "V.B: with AAC in Monitor, theta grows to >= 0.35 rad (about 20 deg) before t = 100 s",
        "theta envelope >= 0.35 rad before 100 s",
        f"max envelope before 100 s = {e_pre:.3f} rad (max raw theta {th_pre:.3f}); first envelope >= "
        f"0.35 at {fmt(t35, '{:.1f}')} s; GS at 20 s = {gs_end:.2f}; AAC mode at 10/99/101 s: {modes}",
        ok(
            e_pre >= 0.35
            and abs(gs_end - 2.0) < 1e-9
            and modes == ("monitor", "monitor", "engaged")
        ),
    )
    e115 = env_at(env, 115)
    t_rec = next(
        (s["t"] - 100.0 for s, e in zip(vb, env, strict=True) if s["t"] > 100.0 and e < FIVE_DEG),
        None,
    )
    xfail = bool(
        re.search(
            r"xfail\([^@]*?\)\s*def test_vb_recovers_within_15_s",
            (REPO / "python/tests/test_presets.py").read_text(encoding="utf-8"),
            re.S,
        )
    )
    meas = (
        f"envelope at 115 s = {e115:.3f} rad ({math.degrees(e115):.1f} deg); envelope at 130 s = "
        f"{env_at(env, 130):.3f}; first envelope < 5 deg after engagement: "
        + (f"{t_rec:.1f} s after (run to 270 s)" if t_rec is not None else "not within 170 s")
    )
    if e115 < FIVE_DEG:
        add(
            "vb-recover",
            "V.B: after Engaged at t = 100 s, theta < 5 deg within 15 s",
            "theta (envelope) < 0.0873 rad at 115 s",
            meas,
            "PASS",
        )
    else:
        add(
            "vb-recover",
            "V.B: after Engaged at t = 100 s, theta < 5 deg within 15 s",
            "theta (envelope) < 0.0873 rad at 115 s",
            meas,
            "DEVIATION" if xfail else "FAIL",
            f"documented deviation (xfail in tests/test_presets.py: {xfail}), see {REF_AAC}",
        )
    t_trip = first_trip(vb)
    t_raw = first_theta_above(vb, THETA_DANGER)
    add(
        "vb-trip",
        "V.B: detector trips before theta exceeds 0.25 rad",
        "trip time < first theta > 0.25 rad",
        f"trip at {fmt(t_trip, '{:.2f}')} s; first raw theta > 0.25 at {fmt(t_raw, '{:.2f}')} s",
        ok(t_trip is not None and (t_raw is None or t_trip < t_raw)),
    )
    _ = vb130


def story_checks() -> None:
    """Story preset (Nominal -> Gain shift -> AAC engaged): criteria, dwell times, trip delays."""
    st = story_times()
    run_len = 400.0
    tel = run_story(run_len)  # the preset's duration, then the same flight continued
    env = envelope([s["theta"] for s in tel])
    n_dur = round(st.duration / DT)
    env_dur = env[:n_dur]
    e_shift, e_eng = env_at(env, st.t_shift), env_at(env, st.t_engage)
    t_trip = first_trip(tel)
    delay = None if t_trip is None else t_trip - st.t_shift
    add(
        "story-trip",
        "Story: detector trips within 10 s of the gain shift (and not before it)",
        "t_shift < trip <= t_shift + 10 s",
        f"t_shift = {st.t_shift:g} s; trip at {fmt(t_trip, '{:.2f}')} s; delay {fmt(delay, '{:.2f}')} s",
        ok(t_trip is not None and st.t_shift < t_trip <= st.t_shift + 10.0),
    )
    add(
        "story-grows",
        "Story: envelope at engage > envelope at shift; envelope at engage <= 0.35 rad",
        "env(t_engage) > env(t_shift); env(t_engage) <= 0.35",
        f"env(t_shift = {st.t_shift:g} s) = {e_shift:.3f} rad; env(t_engage = {st.t_engage:g} s) = "
        f"{e_eng:.3f} rad",
        ok(e_eng > e_shift and e_eng <= 0.35),
    )
    after = env_dur[round(st.t_engage / DT) - 1 :]
    slope = ln_slope(env_dur, st.t_engage + 5.0)
    add(
        "story-suppress",
        "Story post-engage suppression (relaxed): (a) env <= 1.1 env(t_engage); (b) ln-envelope "
        "slope over [t_engage + 5 s, end] < 0; (c) env(end) <= 0.9 env(t_engage)",
        "(a) max <= 1.1 x; (b) slope < 0; (c) end <= 0.9 x",
        f"(a) max after engage = {max(after):.3f} rad = {max(after) / e_eng:.3f} x; (b) slope = "
        f"{slope:.5f} 1/s (decay rate {-slope:.5f} 1/s); (c) env(end = {st.duration:g} s) = "
        f"{env_dur[-1]:.3f} rad = {env_dur[-1] / e_eng:.3f} x",
        ok(max(after) <= 1.1 * e_eng and slope < 0 and env_dur[-1] <= 0.9 * e_eng),
    )
    post = st.duration - st.t_engage
    add(
        "story-dwell",
        "Story: duration - t_engage between 30 and 60 s",
        "30 <= D <= 60 s",
        f"durationS = {st.duration:g} s, t_engage = {st.t_engage:g} s, D = {post:g} s",
        ok(30.0 <= post <= 60.0),
    )
    t01 = next(
        (
            s["t"] - st.t_engage
            for s in tel
            if s["t"] > st.t_engage and env[round(s["t"] / DT) - 1] < 0.1
        ),
        None,
    )
    slope_long = ln_slope(env, st.t_engage + 5.0)
    in_run = t01 is not None and t01 <= post
    extrap = math.log(env_dur[-1] / 0.1) / -slope if slope < 0 else None
    add(
        "story-t01",
        "Story: time after engagement until the envelope < 0.1 rad (reported)",
        "reported",
        f"{fmt(t01, '{:.1f}')} s after engagement, measured in a {run_len:g} s run "
        f"({'within' if in_run else 'beyond'} the preset's {post:g} s); extrapolated from the "
        f"preset-length fit: {fmt(extrap, '{:.0f}')} s after the end of the preset",
        "REPORTED",
    )
    # trip delays when the same shift is applied from smaller amplitudes
    rows = []
    for x in (0.2, 0.13, 0.05):
        r = trip_delay_from_amplitude(x)
        d = r["tripDelayS"]
        rows.append((x, r["envAtShift"], d))
        add(
            f"story-trip-{x}",
            f"Trip delay after the shift applied from theta ~ {x} rad (reported)",
            "reported",
            f"envelope at shift {r['envAtShift']:.3f} rad; trip delay {fmt(d, '{:.2f}')} s; "
            f"peak envelope in 60 s {r['peakEnv']:.3f} rad",
            "REPORTED",
        )
    STORY_LINES.extend(
        [
            "## Story preset",
            "",
            "Nominal (AAC Off, GS 1) -> gain shift (GS ramp to 2.3 over 1.5 s, AAC Monitor) -> AAC "
            "engaged (K_T applied as an immediate step, no ramp). Start like Fig 12.",
            "",
            f"- Dwell times: t_shift = {st.t_shift:g} s; t_engage = {st.t_engage:g} s "
            f"(shift + {st.t_engage - st.t_shift:g} s); durationS = {st.duration:g} s "
            f"(D = {post:g} s after engagement).",
            f"- Trip delay in the story: {fmt(delay, '{:.2f}')} s after the shift "
            f"(trip at {fmt(t_trip, '{:.2f}')} s).",
            f"- Envelope at shift / engage / end: {e_shift:.3f} / {e_eng:.3f} / {env_dur[-1]:.3f} rad.",
            f"- Post-engage decay rate (fit of ln envelope over [t_engage + 5 s, end]): "
            f"{-slope:.5f} 1/s; over the {run_len:g} s run: {-slope_long:.5f} 1/s.",
            f"- Time after engagement until envelope < 0.1 rad: {fmt(t01, '{:.1f}')} s "
            f"(measured in a {run_len:g} s run; "
            f"{'within' if in_run else 'beyond'} the {post:g} s of the preset).",
            "",
            "Trip delay when the same shift (ramp to 2.3 + Monitor, applied after 8 s of nominal "
            "flight) starts from a smaller amplitude (kick of theta0 with phiDot scaled "
            "proportionally; the UI narration uses these to decide when to suggest a Kick):",
            "",
            "| theta0 [rad] | envelope at shift [rad] | trip delay after shift [s] |",
            "|---|---|---|",
            *[f"| {x:g} | {e:.3f} | {fmt(d, '{:.2f}')} |" for x, e, d in rows],
            "",
            "The post-engage criterion is the relaxed one (growth stops, positive decay rate, "
            "envelope <= 0.9 x its value at engagement), see `reports/aac_tuning.md`, 'Known "
            "deviations'. Tests: `test_preset_story`, `test_clear_schedule` in "
            "`python/tests/test_presets.py`.",
            "",
        ]
    )


def determinism_check() -> None:
    a = run_preset("fig14", 20.0)
    b = run_preset("fig14", 20.0)
    c = run_preset("fig13", 20.0)
    d = run_preset("fig13", 20.0)
    same = a == b and c == d
    nfields = len(a[0])
    add(
        "determinism",
        "Two runs are bit-identical",
        "== on every telemetry field of every tick",
        f"fig14 and fig13, 20 s each, run twice: {'identical' if same else 'DIFFER'} "
        f"({len(a)} ticks x {nfields} fields)",
        ok(same),
    )


# ------------------------------------------------------------------------------------------------
# 5. report
# ------------------------------------------------------------------------------------------------
LIN: dict[str, Any] = {}


def main() -> int:
    t0 = time.time()
    p = load_params()

    # ---- loop analysis ------------------------------------------------------------------------
    global LIN
    LIN = linear_checks(p)
    rep = margins_reported(p)
    for ax, name in (("x", "pitch (x)"), ("y", "roll (y)")):
        i = LIN[ax]
        add(
            f"gs-thr-{ax}",
            f"Slosh-mode GS instability threshold, {name} (independent eigenvalues)",
            "< 2.0 (hard)",
            f"{i['threshold']:.4f} (margins.py slosh-mode threshold: {fmt(rep[ax].slosh_threshold, '{:.4f}')})",
            ok(i["threshold"] < 2.0),
        )
        add(
            f"gs1-stable-{ax}",
            f"GS = 1 is stable, {name}",
            "all non-neutral closed-loop poles |z| < 1",
            f"max |z| = {i['gs1_max_mag']:.6f} (slosh decay rate {i['gs1_rate']:.4f} 1/s)",
            ok(i["gs1_stable"]),
        )
    for ax, name in (("x", "pitch (x)"), ("y", "roll (y)")):
        r = rep[ax]
        add(
            f"margins-{ax}",
            f"Outer-loop margins, {name} (margins.py, reported)",
            TABLE1,
            f"PM {fmt(r.pm_deg, '{:.1f}')} deg at {fmt(r.wc / (2 * math.pi) if r.wc else None, '{:.3f}')} Hz; "
            f"HF GM {fmt(r.hf_gm, '{:.2f}')} ({fmt(20 * math.log10(r.hf_gm) if r.hf_gm else None, '{:.1f}')} dB) "
            f"at {fmt(r.hf_w / (2 * math.pi) if r.hf_w else None, '{:.3f}')} Hz; "
            f"LF GM: {'exists' if r.lf_gm_exists else 'none'}",
            "REPORTED",
            "guidance, not pass/fail; designed threshold sits below 2.0 on purpose",
        )

    # ---- instability mode ---------------------------------------------------------------------
    for ax, name in (("x", "pitch (x)"), ("y", "roll (y)")):
        i = LIN[ax]
        in_band = BAND_HZ[0] <= i["crit_freq_hz"] <= BAND_HZ[1]
        add(
            f"mode-{ax}",
            f"Pole that goes unstable at the threshold, {name}: frequency and pendulum participation r",
            f"{BAND_HZ[0]}-{BAND_HZ[1]} Hz and r = L|dn|/|dp_q| > {R_MIN:g}",
            f"{i['crit_freq_hz']:.3f} Hz, r = {i['crit_r']:.1f} at GS {i['threshold']:.4f} "
            f"(|z| = {i['crit_mag']:.6f})",
            ok(in_band and i["crit_r"] > R_MIN),
            "eigenvector of the 23-state closed loop (not margins.py labels)",
        )
        add(
            f"others-{ax}",
            f"All other modes stay inside the unit circle up to GS 2.8, {name}",
            "max |z| < 1 for every non-slosh-like pole over GS 0.5-2.8; unstable poles are only the "
            "slosh pair",
            f"max |z| of other poles = {i['other_max_mag']:.6f} (at GS {i['other_max_gs']:.2f}); "
            f"unstable poles all slosh-like: {i['all_unstable_slosh']}; unstable count always 0 or 2: "
            f"{i['unstable_pair_ok']}; neutral z = 1 modes: {i['neutral_counts']}",
            ok(
                i["other_max_mag"] < 1.0
                and i["all_unstable_slosh"]
                and i["unstable_pair_ok"]
                and i["neutral_counts"] == [3]
            ),
            "neutral = 3 structural z = 1 eigenvalues (quaternion norm, pendulum norm, spin about the rod)",
        )
    # cross-check: linear rate vs nonlinear small-amplitude growth
    for gs, key in ((1.0, "gs1_rate"), (2.3, "rate_gs23")):
        slope = small_signal_growth(gs)
        lin = -LIN["x"][key]
        add(
            f"nonlin-rate-gs{gs:g}",
            f"Cross-check: nonlinear small-amplitude envelope growth rate vs linear pole, GS {gs:g}",
            "agree within 0.01 1/s (theta0 = 0.01 rad planar, AAC off, 10-40 s)",
            f"nonlinear {slope:+.4f} 1/s, linear {lin:+.4f} 1/s",
            ok(abs(slope - lin) < 0.01),
            "validates the sign and gain-shift injection of the independent loop closure",
        )

    # ---- free slosh frequency, energy ---------------------------------------------------------
    f, ncross = free_slosh_frequency(p)
    add(
        "free-freq",
        "Free slosh frequency, controller off",
        "0.51 +/- 0.02 Hz",
        f"{f:.4f} Hz ({int(ncross)} zero crossings over 40 s); analytic sqrt(m_T g/(m_q L))/2pi = "
        f"{math.sqrt((p.vehicle.m_q + p.pendulum.m_p) * p.sim.g / (p.vehicle.m_q * p.pendulum.L)) / (2 * math.pi):.4f} Hz",
        ok(abs(f - 0.51) <= 0.02),
    )
    drift, e_osc = energy_drift(p)
    add(
        "energy",
        "Energy conservation, zero damping, no control inputs, 60 s",
        "max |E - E0| / E_osc < 0.1 %",
        f"{100 * drift:.2e} % of the oscillation energy ({e_osc:.4f} J); k_damp = 0, hover thrust, "
        "no torque, theta0 = 0.2, phiDot0 = 0.6",
        ok(drift < 1e-3),
        "E = quad + mass kinetic energy + gravity + constant-thrust potential",
    )

    # ---- presets, determinism, parameters -----------------------------------------------------
    preset_checks(p)
    story_checks()
    determinism_check()
    provenance_checks()
    no_pendulum_feedback(p)

    write_report(time.time() - t0)
    fails = [r for r in ROWS if r.status == "FAIL"]
    print(
        f"\n{len(ROWS)} rows; FAIL: {[r.key for r in fails]}; DEVIATION: "
        f"{[r.key for r in ROWS if r.status == 'DEVIATION']}"
    )
    return 1 if fails else 0


def write_report(wall: float) -> None:
    n = {
        s: sum(1 for r in ROWS if r.status == s) for s in ("PASS", "FAIL", "REPORTED", "DEVIATION")
    }
    lines = [
        "# Verification of the Python reference model (task #20)",
        "",
        "Generated by `reports/scripts/verify_presets.py`. The script measures everything itself: "
        "closed-loop eigenvalues and eigenvectors come from the raw hover linearization "
        "(`slosh.design.linearize.hover_linearization`) with the outer PD closed by hand at each gain "
        "shift, not from `margins.py` mode labels; preset behaviour comes from the telemetry of "
        "`slosh.run.run_preset` (Monitor variants from `slosh.core.sim.Sim`). `margins.py` is used only "
        "for the reported R-1 Table 1 comparison and as a cross-check.",
        "",
        f"Result: {n['PASS']} PASS, {n['FAIL']} FAIL, {n['REPORTED']} REPORTED, "
        f"{n['DEVIATION']} DEVIATION ({len(ROWS)} rows, {wall:.0f} s wall). theta envelope = sliding "
        "max of theta over 2 s. Reproduction of R-1 is qualitative, for teaching.",
        "",
        "| # | Criterion | Target | Measured | Status |",
        "|---|---|---|---|---|",
    ]
    for i, r in enumerate(ROWS, 1):
        st = f"**{r.status}**" if r.status in ("FAIL", "DEVIATION") else r.status
        if r.note:
            st += f" ({r.note})"
        esc = lambda s: s.replace("|", "\\|")  # noqa: E731
        lines.append(
            f"| {i} | {esc(r.criterion)} | {esc(r.target)} | {esc(r.measured)} | {esc(st)} |"
        )
    devs = [r for r in ROWS if r.status == "DEVIATION"]
    lines += ["", *STORY_LINES]
    lines += ["## Deviations and reported items", ""]
    for r in devs:
        lines.append(f"- **{r.key}**: {r.note}.")
    lines += [
        "- **margins-x / margins-y**: reported against the R-1 Table 1 targets only; the design "
        "deliberately puts the slosh-mode gain-shift threshold below 2.0, so the HF gain margin is "
        "smaller than R-1's 2.6 (see `reports/margins.md`).",
        "",
        "Re-run with `cd python && uv run python ../reports/scripts/verify_presets.py` (the script "
        "resolves the repo root itself), or from the repo root with `python/.venv/bin/python reports/scripts/verify_presets.py`.",
        "",
    ]
    REPORT_PATH.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {REPORT_PATH}")


if __name__ == "__main__":
    raise SystemExit(main())
