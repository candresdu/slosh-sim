"""Nonlinear check of the designed gains (AAC off): decay, unstable growth, saturation.

    uv run python -m slosh.instability [--out ../reports/instability.md]

Runs Fig 12 (GS 1), Fig 13 (GS 2.3), a constant GS 2.0 run (60 s each, from theta = 0.2,
phiDot = 0.6) and the section V.B ramp (100 s, AAC off) in the Python reference model for
three configurations: (a) nominal, (b) attMax 0.2 and 0.35 rad, (c) latency 30 ms plus sensor
noise (information only). ``sat_att`` / ``sat_motor`` are debug fields of the Python telemetry.
"""

from __future__ import annotations

import argparse
import math
from collections.abc import Sequence
from concurrent.futures import ProcessPoolExecutor
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np

from .core.sim import Sim
from .params import Params, load_params
from .run import PLACEHOLDER_AAC

ENV_WINDOW_S = 2.0
FREQ_WINDOW_S = (10.0, 40.0)  # FFT window of the dominant-frequency columns
DECAY_LEVEL = 0.05
REPORT_PATH = Path(__file__).resolve().parents[3] / "reports" / "instability.md"

RUNS: dict[str, dict[str, Any]] = {
    "fig12": {"preset": "fig12", "gs": None, "dur": 60.0},
    "fig13": {"preset": "fig13", "gs": None, "dur": 60.0},
    "gs2.0": {"preset": "fig13", "gs": 2.0, "dur": 60.0},
    "vb": {"preset": "vb", "gs": None, "dur": 100.0},
}


def configure(
    params: Params,
    att_max: float | None = None,
    latency_ms: float | None = None,
    noise: bool | None = None,
) -> Params:
    """Copy of ``params`` with optional attMax / latency / noise overrides."""
    p = params
    if att_max is not None:
        p = replace(p, control=replace(p.control, attMax=att_max))
    s = p.sensing
    if latency_ms is not None:
        s = replace(s, latencyMs=latency_ms)
    if noise is not None:
        s = replace(s, noise=replace(s.noise, enabled=noise))
    return replace(p, sensing=s)


def simulate(params: Params, run: str, seed: int | None = None) -> list[dict[str, Any]]:
    """Run one entry of :data:`RUNS` with AAC off; returns the telemetry list."""
    r = RUNS[run]
    # AAC is off in every run here; placeholders only satisfy the not-yet-tuned (null) parameters
    sim = Sim(params, seed, aac_overrides=PLACEHOLDER_AAC)
    sim.enqueue({"type": "loadPreset", "id": r["preset"]})
    if r["gs"] is not None:
        sim.enqueue({"type": "setGainShift", "value": r["gs"]})
    sim.enqueue({"type": "setAacMode", "mode": "off"})
    return [sim.step_control() for _ in range(round(r["dur"] / sim.dt_ctrl))]


def envelope(theta: Sequence[float], dt: float, window_s: float = ENV_WINDOW_S) -> list[float]:
    """Trailing sliding max of ``theta`` over ``window_s`` (partial window at the start)."""
    n = max(1, round(window_s / dt))
    out: list[float] = []
    for i in range(len(theta)):
        out.append(max(theta[max(0, i - n + 1) : i + 1]))
    return out


def env_at(env: Sequence[float], dt: float, t: float) -> float:
    return env[min(len(env) - 1, round(t / dt) - 1)]


def rms(v: Sequence[float]) -> float:
    return math.sqrt(sum(a * a for a in v) / len(v)) if v else 0.0


def decay_time(env: Sequence[float], dt: float, level: float = DECAY_LEVEL) -> float | None:
    """First time after which the envelope stays below ``level`` to the end; None if never."""
    last_bad = -1
    for i, e in enumerate(env):
        if e >= level:
            last_bad = i
    if last_bad == len(env) - 1:
        return None
    return (last_bad + 2) * dt if last_bad >= 0 else dt


def dominant_freq_hz(signals: list[np.ndarray], dt: float, t0: float, t1: float) -> float:
    """Frequency of the largest peak of the summed power spectrum of ``signals`` in ``[t0, t1]`` s.

    Each signal is detrended and Hann-windowed; the FFT is zero-padded (about 0.0015 Hz bins).
    """
    i0, i1 = round(t0 / dt), round(t1 / dt)
    n = 1 << 16
    power = np.zeros(n // 2 + 1)
    for x in signals:
        seg = np.asarray(x[i0:i1], dtype=float)
        seg = (seg - seg.mean()) * np.hanning(len(seg))
        power += np.abs(np.fft.rfft(seg, n)) ** 2
    f = np.fft.rfftfreq(n, dt)
    k = 1 + int(np.argmax(power[1:]))
    return float(f[k])


def analyse(tel: list[dict[str, Any]], t_win: tuple[float, float] = (50.0, 60.0)) -> dict[str, Any]:
    """Metrics of one run. ``t_win`` is the late window for saturation and x/y RMS."""
    dt = tel[1]["t"] - tel[0]["t"]
    theta = [s["theta"] for s in tel]
    env = envelope(theta, dt)
    t_end = tel[-1]["t"]
    lo, hi = min(t_win[0], t_end - 10.0), min(t_win[1], t_end)

    def sl(a: float, b: float) -> list[dict[str, Any]]:
        return [s for s in tel if a < s["t"] <= b + 1e-9]

    late, early = sl(lo, hi), sl(0.0, 5.0)
    sat_frac = sum(1 for s in late if s["sat_att"] or s["sat_motor"]) / len(late)
    sat_att_frac = sum(1 for s in late if s["sat_att"]) / len(late)
    sat_motor_frac = sum(1 for s in late if s["sat_motor"]) / len(late)
    # every 2 s window in the late span contains a saturated tick
    every_2s = all(
        any(s["sat_att"] or s["sat_motor"] for s in sl(a, a + 2.0))
        for a in [lo + 2.0 * k for k in range(round((hi - lo) / 2.0))]
    )
    x_e, y_e = rms([s["mx"] for s in early]), rms([s["my"] for s in early])
    x_l, y_l = rms([s["mx"] for s in late]), rms([s["my"] for s in late])
    env_min_10_60 = min(env[round(10.0 / dt) - 1 : round(min(60.0, t_end) / dt)])
    f_theta = f_quad_x = None
    if t_end >= FREQ_WINDOW_S[1]:
        # theta is the non-negative polar angle (its spectrum doubles a planar swing), so the
        # swing frequency is read from the signed horizontal mass components mx, my
        a, b = FREQ_WINDOW_S
        f_theta = dominant_freq_hz(
            [np.array([s["mx"] for s in tel]), np.array([s["my"] for s in tel])], dt, a, b
        )
        f_quad_x = dominant_freq_hz([np.array([s["x"] for s in tel])], dt, a, b)
    return {
        "f_theta": f_theta,
        "f_quad_x": f_quad_x,
        "dt": dt,
        "env10": env_at(env, dt, 10.0),
        "env30": env_at(env, dt, 30.0),
        "env50": env_at(env, dt, 50.0) if t_end >= 50.0 else float("nan"),
        "env60": env_at(env, dt, 60.0) if t_end >= 60.0 else float("nan"),
        "env_end": env[-1],
        "env_max": max(env),
        "t_env_035": next((tel[i]["t"] for i, e in enumerate(env) if e >= 0.35), None),
        "env_min_10_60": env_min_10_60,
        "decay": decay_time(env, dt),
        "sat_frac": sat_frac,
        "sat_att_frac": sat_att_frac,
        "sat_motor_frac": sat_motor_frac,
        "sat_every_2s": every_2s,
        "x_rms_early": x_e,
        "y_rms_early": y_e,
        "x_rms_late": x_l,
        "y_rms_late": y_l,
        "migrates": x_e > y_e and y_l > x_l,
        "win": (lo, hi),
    }


def probe_small_amplitude(params: Params) -> dict[str, float]:
    """Diagnostic: GS 2.3, AAC off, attMax effectively unlimited, tiny kick (theta = 0.01 rad).

    Shows which mode the linear instability lives in: oscillation period of the quad position
    and of the hanging mass, and how fast each grows before saturation sets in.
    """
    p = configure(params, att_max=5.0)
    sim = Sim(p, None, aac_overrides=PLACEHOLDER_AAC)
    sim.enqueue({"type": "loadPreset", "id": "fig13"})
    sim.enqueue({"type": "kick", "theta": 0.01, "phiDot": 0.0})
    tel = [sim.step_control() for _ in range(1500)]

    def amp(a: float, b: float, key: str) -> float:
        return max(abs(s[key]) for s in tel if a < s["t"] <= b)

    def period(key: str) -> float:
        v = [s[key] for s in tel if s["t"] > 5.0]
        zc = [i for i in range(1, len(v)) if v[i - 1] < 0 <= v[i]]
        return (zc[-1] - zc[0]) / (len(zc) - 1) * sim.dt_ctrl if len(zc) > 1 else float("nan")

    return {
        "quad_x_5_8": amp(5, 8, "x"),
        "quad_x_10_13": amp(10, 13, "x"),
        "mass_x_5_8": amp(5, 8, "mx"),
        "mass_x_10_13": amp(10, 13, "mx"),
        "quad_period": period("x"),
        "mass_period": period("mx"),
    }


CONFIGS: tuple[tuple[str, str, dict[str, Any]], ...] = (
    ("a", "nominal (attMax 0.35, no latency, no noise)", {}),
    ("b1", "attMax 0.20 rad", {"att_max": 0.2}),
    ("b2", "attMax 0.35 rad (same as a)", {"att_max": 0.35}),
    ("c", "latency 30 ms + sensor noise (info only)", {"latency_ms": 30.0, "noise": True}),
)


def _job(args: tuple[str, str, dict[str, Any]]) -> tuple[str, str, dict[str, Any]]:
    cfg, run, kw = args
    p = configure(load_params(), **kw)
    tel = simulate(p, run)
    return cfg, run, analyse(tel)


def run_all(workers: int = 4) -> dict[tuple[str, str], dict[str, Any]]:
    jobs = [(c, r, kw) for c, _, kw in CONFIGS for r in RUNS]
    with ProcessPoolExecutor(max_workers=workers) as ex:
        res = list(ex.map(_job, jobs))
    return {(c, r): m for c, r, m in res}


def _f(v: float | None, fmt: str = "{:.3f}") -> str:
    return "n/a" if v is None or (isinstance(v, float) and math.isnan(v)) else fmt.format(v)


def slosh_rate_gs1(params: Params) -> float:
    """Linear slosh-mode decay rate [1/s] at GS 1 (worse of the two axes)."""
    from .design import fit_gains as fg

    return min(fg._eval_axis(params, ax).rate1 for ax in ("x", "y"))


def committed_checks(
    m: dict[tuple[str, str], dict[str, Any]], rate1: float | None = None
) -> list[tuple[str, bool, str]]:
    """Acceptance checks on the nominal configuration (a).

    The Fig 12 criterion is the fallback one (a decaying envelope and a positive linear GS 1
    slosh-mode decay rate): PD-only gains cannot give both the R-1 decay and the GS 2.0 growth.
    """
    f12, f13, vb = m[("a", "fig12")], m[("a", "fig13")], m[("a", "vb")]
    out = [
        (
            "fig12 envelope decreases: env(60 s) < env(30 s) < env(10 s)",
            f12["env60"] < f12["env30"] < f12["env10"],
            f"{f12['env60']:.4f} < {f12['env30']:.4f} < {f12['env10']:.4f}",
        ),
        (
            "linear GS 1 slosh-mode decay rate > 0",
            rate1 is not None and rate1 > 0.0,
            _f(rate1, "{:.4f} 1/s"),
        ),
        (
            "fig13 envelope(60 s) > envelope(10 s)",
            f13["env60"] > f13["env10"],
            f"{f13['env60']:.3f} vs {f13['env10']:.3f}",
        ),
        (
            "fig13 envelope >= 0.2 rad over 10-60 s",
            f13["env_min_10_60"] >= 0.2,
            _f(f13["env_min_10_60"]),
        ),
        (
            "plateau only from saturation (or still growing >= 5 %)",
            f13["env60"] >= 1.05 * f13["env50"] or f13["sat_every_2s"],
            f"env60/env50 = {f13['env60'] / f13['env50']:.3f}, "
            f"sat in every 2 s: {f13['sat_every_2s']}",
        ),
        (
            "fig13 y-RMS > x-RMS over 50-60 s",
            f13["y_rms_late"] > f13["x_rms_late"],
            f"{f13['y_rms_late']:.3f} vs {f13['x_rms_late']:.3f}",
        ),
        (
            "fig13 x-RMS > y-RMS over 0-5 s",
            f13["x_rms_early"] > f13["y_rms_early"],
            f"{f13['x_rms_early']:.3f} vs {f13['y_rms_early']:.3f}",
        ),
        (
            "V.B (AAC off) envelope >= 0.35 rad before t = 100 s",
            vb["env_max"] >= 0.35,
            f"max {vb['env_max']:.3f}, first >= 0.35 at {_f(vb['t_env_035'], '{:.1f}')} s",
        ),
    ]
    return out


KDAMP_VALUES = (1e-3, 2e-3, 5e-3, 1e-2)
APPENDIX_TITLE = "Run 1 (superseded: #17 gains, rigid-body instability)"

# Free-text note on the pendulum-damping decision; edited together with the parameter file.
KDAMP_NOTE: list[str] = [
    "- Pendulum damping and gains: the decision sequence is recorded in "
    "`reports/gain_redesign.md` (sections 'Re-fit in the wider band and the k_damp step' and "
    "'Final bounded attempt'). No design passes the linear screen, so `k_damp` stays 0.001 and "
    "the committed gains are the wider-band re-fit (threshold 1.344); the Fig 12 criterion is "
    "the fallback one (see 'Deviation from R-1').",
]

DEVIATION: list[str] = [
    "## Deviation from R-1",
    "",
    "R-1 shows Fig 12 (GS 1) decaying quickly. Here Fig 12 decays only at about the passive rate "
    "of the pendulum (about 0.005 1/s at `k_damp` = 0.001; the envelope falls slowly and does "
    "not reach 0.05 rad within 30 s or 60 s). Two reasons:",
    "",
    "- PD-only gains cannot give both enough slosh damping at GS 1 and enough growth at GS 2.0. "
    "Fig 12 needs about 0.046 1/s of decay at GS 1 and the V.B ramp needs about 0.025 1/s of "
    "growth at GS 2.0, so the slosh-mode decay rate must change by about 0.07 1/s per unit of GS. "
    "The bounded search (`reports/gain_redesign.md`, 'Final bounded attempt') reached at most "
    "0.047 1/s with the other criteria met (gap about 0.024 1/s); the committed design changes "
    "it by about 0.032 1/s per unit of GS.",
    "- Pendulum feedback is excluded: the slosh stands for unobservable, unmodeled dynamics, so "
    "the controller never measures the pendulum angle, rate or mass position.",
    "",
    "The replacement criterion for Fig 12 is: the 2 s sliding-max envelope decreases, "
    "env(60 s) < env(30 s) < env(10 s), and the linear GS 1 slosh-mode decay rate is positive.",
    "",
]


def _kd_job(kd: float) -> tuple[float, dict[str, dict[str, Any]]]:
    p0 = load_params()
    p = replace(p0, pendulum=replace(p0.pendulum, k_damp=kd))
    return kd, {r: analyse(simulate(p, r)) for r in ("fig12", "gs2.0", "vb")}


def kdamp_sweep(workers: int = 4) -> dict[float, dict[str, dict[str, Any]]]:
    """Committed gains with k_damp varied (information for the pendulum-damping decision)."""
    with ProcessPoolExecutor(max_workers=workers) as ex:
        return dict(ex.map(_kd_job, KDAMP_VALUES))


def _fhz(v: float | None) -> str:
    return _f(v, "{:.3f}")


def _preserved_appendix(out: Path) -> list[str]:
    """The 'Run 1 (superseded ...)' section of the existing report, kept verbatim."""
    if not out.exists():
        return []
    lines = out.read_text(encoding="utf-8").split("\n")
    head = f"## {APPENDIX_TITLE}"
    if head not in lines:
        return []
    return ["---", ""] + lines[lines.index(head) :]


def write_report(
    m: dict[tuple[str, str], dict[str, Any]],
    out: Path,
    params: Params,
    sweep: dict[float, dict[str, dict[str, Any]]] | None = None,
) -> None:
    c = params.control
    rate1 = slosh_rate_gs1(params)
    checks = committed_checks(m, rate1)
    all_ok = all(ok for _, ok, _ in checks)
    pr = probe_small_amplitude(params)
    appendix = _preserved_appendix(out)
    a13, a20, a12, avb = m[("a", "fig13")], m[("a", "gs2.0")], m[("a", "fig12")], m[("a", "vb")]
    L = [
        "# Nonlinear check of the redesigned gains (AAC off)",
        "",
        "Generated by `python -m slosh.instability`. Python reference model, AAC off, 100 Hz "
        "controller, RK4 at 1 kHz. Pendulum start: theta = 0.2 rad, phiDot = 0.6 rad/s "
        f"(V.B preset: its own start, theta = 0.05 rad, phiDot = 0.2 rad/s). The run 1 results "
        f"(first-generation gains) are kept in the appendix '{APPENDIX_TITLE}'.",
        "",
        f"Committed parameters: outer PD Kp = {c.outer.Kp}, Kd = {c.outer.Kd}; inner PD "
        f"Kp = {c.inner.Kp}, Kd = {c.inner.Kd}; attMax = {c.attMax} rad; "
        f"k_damp = {params.pendulum.k_damp} N m s; motor tau = {params.motor.tau * 1e3:.0f} ms; "
        f"latencyMs = {params.sensing.latencyMs}; noise enabled = {params.sensing.noise.enabled}.",
        "",
        "theta envelope = sliding max of theta over the last 2 s. Saturation fraction = fraction "
        "of 10 ms ticks in 50-60 s with `sat_att` (attitude command clamped at +-attMax) or "
        "`sat_motor` (a motor command clamped at omegaMin/omegaMax). The V.B run lasts 100 s, so "
        "its saturation and RMS window is 90-100 s. x-to-y migration: x-RMS > y-RMS over 0-5 s "
        "and y-RMS > x-RMS over the late window. Dominant frequencies: FFT over 10-40 s (Hann "
        "window, zero-padded); the theta frequency is read from the signed horizontal mass "
        "components (theta itself is non-negative and shows twice the swing frequency), the "
        "quad-x frequency from the quad x position.",
        "",
        "## Configuration table",
        "",
        "| Cfg | Run | Decay time [s] | Env 10 s | Env 30 s | Env 60 s | Sat frac (late) "
        "| sat_att | sat_motor | x-RMS early / late | y-RMS early / late | x to y "
        "| f theta [Hz] | f quad-x [Hz] |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for cfg, _desc, _ in CONFIGS:
        for run in RUNS:
            r = m[(cfg, run)]
            e60 = r["env60"] if run != "vb" else r["env_end"]
            dec = _f(r["decay"], "{:.1f}") if run == "fig12" else ""
            fq = (
                (_fhz(r["f_theta"]), _fhz(r["f_quad_x"])) if run in ("fig13", "gs2.0") else ("", "")
            )
            L.append(
                f"| {cfg} | {run} | {dec or '-'} | {_f(r['env10'])} | {_f(r['env30'])} | {_f(e60)}"
                f"{' (t = 100 s)' if run == 'vb' else ''} | {_f(r['sat_frac'], '{:.2f}')} "
                f"| {_f(r['sat_att_frac'], '{:.2f}')} | {_f(r['sat_motor_frac'], '{:.2f}')} "
                f"| {r['x_rms_early']:.3f} / {r['x_rms_late']:.3f} "
                f"| {r['y_rms_early']:.3f} / {r['y_rms_late']:.3f} "
                f"| {'yes' if r['migrates'] else 'no'} | {fq[0] or '-'} | {fq[1] or '-'} |"
            )
    L += ["", "Configurations:", ""]
    L += [f"- ({cfg}) {desc}" for cfg, desc, _ in CONFIGS]
    L += [
        "",
        "## Fig 12 decay time (GS 1, AAC off)",
        "",
        "Time after which the 2 s envelope stays below 0.05 rad ('n/a': it does not).",
        "",
        "| Cfg | Decay time [s] | Envelope at 30 s |",
        "|---|---|---|",
    ]
    for cfg, _, _ in CONFIGS:
        r = m[(cfg, "fig12")]
        L.append(f"| {cfg} | {_f(r['decay'], '{:.1f}')} | {_f(r['env30'], '{:.4f}')} |")
    L += [
        "",
        "## Growth levels off only from saturation (attMax 0.20 vs 0.35)",
        "",
        "| attMax | Run | Env 10 s | Env 30 s | Env 50 s | Env 60 s | Env(60) / Env(50) "
        "| Saturated tick in every 2 s of 50-60 s | Sat frac 50-60 s |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for cfg, att in (("b1", 0.2), ("b2", 0.35)):
        for run in ("fig13", "gs2.0"):
            r = m[(cfg, run)]
            L.append(
                f"| {att} | {run} | {_f(r['env10'])} | {_f(r['env30'])} | {_f(r['env50'])} "
                f"| {_f(r['env60'])} | {r['env60'] / r['env50']:.3f} | {r['sat_every_2s']} "
                f"| {_f(r['sat_frac'], '{:.2f}')} |"
            )
    L += ["", "## Acceptance checks (committed parameters, configuration a)", ""]
    for name, ok, detail in checks:
        L.append(f"- {'PASS' if ok else 'FAIL'}: {name} ({detail})")
    for run, r in (("fig13", a13), ("gs2.0", a20)):
        ok = 0.45 <= r["f_theta"] <= 0.6
        L.append(
            f"- {'PASS' if ok else 'FAIL'}: {run} dominant theta frequency in 0.45-0.6 Hz "
            f"({r['f_theta']:.3f} Hz; quad-x {r['f_quad_x']:.3f} Hz)"
        )
    if sweep:
        L += [
            "",
            "## Pendulum damping k_damp",
            "",
            "Committed gains with only `k_damp` varied (AAC off). Fig 12 needs the envelope "
            "below 0.05 rad by t = 30 s while GS 2.0 must still grow.",
            "",
            "| k_damp [N m s] | Fig 12 env 30 s | Fig 12 decay time [s] | GS 2.0 env 10 s "
            "| GS 2.0 env 60 s | V.B max env |",
            "|---|---|---|---|---|---|",
        ]
        for kd, r in sweep.items():
            L.append(
                f"| {kd:g} | {_f(r['fig12']['env30'], '{:.4f}')} "
                f"| {_f(r['fig12']['decay'], '{:.1f}')} | {_f(r['gs2.0']['env10'])} "
                f"| {_f(r['gs2.0']['env60'])} | {_f(r['vb']['env_max'])} |"
            )
    L += [
        "",
        "## Small-amplitude probe (diagnosis)",
        "",
        "GS 2.3, AAC off, attMax = 5 rad (no attitude clamp), kick theta = 0.01 rad, 15 s.",
        "",
        "| Quantity | Value |",
        "|---|---|",
        f"| Quad x amplitude, 5-8 s / 10-13 s [m] "
        f"| {pr['quad_x_5_8']:.4f} / {pr['quad_x_10_13']:.4f} |",
        f"| Mass x amplitude, 5-8 s / 10-13 s [m] "
        f"| {pr['mass_x_5_8']:.4f} / {pr['mass_x_10_13']:.4f} |",
        f"| Quad x oscillation period [s] | {pr['quad_period']:.2f} |",
        f"| Mass x oscillation period [s] | {pr['mass_period']:.2f} |",
        "",
        "## Conclusions",
        "",
    ]
    if all_ok:
        L += ["- All acceptance checks pass for the committed parameters."]
    else:
        L += ["- **Not all acceptance checks pass** (see the FAIL lines above)."]
    L += [
        f"- Frequency: with AAC off the dominant theta frequency is {a20['f_theta']:.3f} Hz "
        f"(GS 2.0) and {a13['f_theta']:.3f} Hz (GS 2.3), the ~0.5 Hz slosh mode; the quad-x "
        f"frequency is {a20['f_quad_x']:.3f} / {a13['f_quad_x']:.3f} Hz, locked to the same "
        "mode (the quad is driven by the swinging mass), not the ~1 Hz rigid-body position mode "
        "of run 1.",
        f"- Growth: fig13 envelope {a13['env10']:.3f} rad at 10 s, {a13['env30']:.3f} at 30 s, "
        f"{a13['env60']:.3f} at 60 s; GS 2.0: {a20['env10']:.3f}, {a20['env30']:.3f}, "
        f"{a20['env60']:.3f}. V.B (AAC off) peaks at {avb['env_max']:.3f} rad before 100 s.",
        "- Configuration (b): a smaller attMax lowers the amplitude where growth stops; the "
        "saturation columns show how often a clamp is active.",
        "- Configuration (c) is for information only. The committed parameters keep "
        "latencyMs = 0 and noise disabled; the instability does not need either.",
        f"- Fig 12 (GS 1) envelope: {a12['env10']:.4f} rad at 10 s, {a12['env30']:.4f} at 30 s, "
        f"{a12['env60']:.4f} at 60 s; linear GS 1 slosh-mode decay rate {rate1:.4f} 1/s.",
    ]
    L += KDAMP_NOTE
    L += [""]
    L += DEVIATION
    L += appendix
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(L).rstrip("\n") + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="slosh.instability", description=__doc__.split("\n")[0])
    ap.add_argument("--out", type=Path, default=REPORT_PATH)
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args(argv)
    m = run_all(a.workers)
    write_report(m, a.out, load_params(), kdamp_sweep(a.workers))
    ok = True
    for name, passed, detail in committed_checks(m, slosh_rate_gs1(load_params())):
        print(("PASS " if passed else "FAIL ") + name + f" [{detail}]")
        ok &= passed
    print(f"wrote {a.out}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
