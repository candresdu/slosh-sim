"""Loop margins, slosh damping and the linear gain-shift instability threshold.

``margins(L)`` works on any SISO python-control loop transfer function ``L`` (discrete or
continuous, ``TransferFunction`` or ``StateSpace``) with negative unity feedback ``1 + GS L = 0``.
``analyze_axis`` runs it on the outer loop of the testbed (see :mod:`slosh.design.linearize`).

Definitions (gain ``GS = 1`` unless stated):

* **Gain crossovers**: frequencies where ``|L| = 1``. The *primary* one is the lowest-frequency
  downward crossing; ``pm_deg`` / ``wc`` refer to it. ``pm_min_deg`` is the smallest phase margin
  over all crossovers.
* **Phase crossings**: frequencies where the (unwrapped) phase passes ``-180 deg`` (mod 360).
  A crossing with ``|L| < 1`` is an *upper* gain margin (``GM = 1/|L|``, gain can rise by ``GM``);
  the HF gain margin is the smallest one. A crossing with ``|L| > 1`` is a *lower* gain margin
  (gain can fall by ``GM = 1/|L| < 1``); ``lf_gm_exists`` says whether any exists.
* **Per-mode thresholds** (``mode_thresholds``): every closed-loop pole pair is followed over the
  gain-shift range; each that crosses ``|z| = 1`` is reported with its GS, frequency and pendulum
  participation ``r``. The *slosh-mode threshold* is the lowest crossing with r > 5 at 0.4 to
  0.65 Hz; the *rigid-body threshold* is the lowest crossing of any other mode.
* **GS instability threshold** (any mode): the smallest ``GS`` in ``[gs_lo, gs_hi]`` for which a
  closed-loop pole of ``1 + GS L`` is outside the unit circle (discrete) or in the right half plane
  (continuous). Found on a ``0.05`` grid and refined by bisection to ``tol``.
"""

from __future__ import annotations

import argparse
import math
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any

import control
import numpy as np

from ..params import Params, load_params
from .linearize import AXES, inner_loop_ss, outer_loop_ss, slosh_omega

Loop = Any  # control.TransferFunction | control.StateSpace

# R-1 Table 1 targets (guidance, not enforced)
TABLE1 = {"pm_deg": 22.0, "pm_hz": 0.2, "hf_gm": 2.6, "hf_hz": 0.525, "lf_gm": math.inf}


@dataclass(frozen=True)
class Crossing:
    w: float  # rad/s
    mag: float  # |L|
    gm: float  # 1/|L|


@dataclass(frozen=True)
class ModeCrossing:
    """One closed-loop pole pair leaving the unit circle as the gain shift rises."""

    gs: float  # gain shift at which |z| first exceeds 1
    freq_hz: float  # |arg z| / (2 pi T) of the pole at the crossing
    r: float  # pendulum participation L |dn| / |dp_quad| (eigenvector)
    kind: str  # "slosh" or "rigid-body"


SLOSH_R_MIN = 5.0
SLOSH_BAND_HZ = (0.4, 0.65)


@dataclass(frozen=True)
class MarginReport:
    # outer loop
    pm_deg: float | None
    wc: float | None  # rad/s, primary gain crossover
    pm_min_deg: float | None
    crossovers: tuple[tuple[float, float, bool], ...]  # (w, pm_deg, downward) per gain crossover
    hf_gm: float | None  # smallest upper gain margin (ratio)
    hf_w: float | None  # its phase-crossover frequency [rad/s]
    lf_gm_exists: bool
    lf_gm: float | None  # closest lower gain margin (ratio < 1), if any
    lf_w: float | None
    phase_crossings: tuple[Crossing, ...]
    gs_threshold: float | None  # None: stable over the whole searched range
    gs_threshold_pole_w: float | None  # |s| [rad/s] of the pole that leaves the stable region
    # optional extras, filled by ``margins`` when the arguments are given
    inner_wc: float | None = None
    inner_pm_deg: float | None = None
    slosh_zeta: float | None = None
    slosh_wn: float | None = None
    fig12_decay_s: float | None = None  # ln 4 / (zeta wn)
    gs_sweep: tuple[dict[str, float], ...] = field(default_factory=tuple)
    # per-mode instability analysis (filled by ``analyze_axis`` / ``attach_modes``)
    mode_crossings: tuple[ModeCrossing, ...] = field(default_factory=tuple)
    slosh_threshold: float | None = None  # lowest GS at which a slosh-mode pole leaves |z| = 1
    rigid_threshold: float | None = None  # lowest GS at which any other mode does (None: > gs_hi)
    mode_gs_hi: float = 3.0

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


# --- helpers ----------------------------------------------------------------------------------
def _dt(L: Loop) -> float:
    dt = L.dt
    return float(dt) if dt not in (None, True, 0) else 0.0


def freq_response(L: Loop, w: np.ndarray) -> np.ndarray:
    """Complex ``L(jw)`` (continuous) or ``L(e^{jwT})`` (discrete) on ``w`` [rad/s]."""
    dt = _dt(L)
    s = np.exp(1j * w * dt) if dt else 1j * w
    return np.asarray(L(s), dtype=complex).reshape(-1)


def default_grid(L: Loop, w_min: float = 1e-2, n: int = 40000) -> np.ndarray:
    dt = _dt(L)
    w_max = 0.999 * math.pi / dt if dt else 1e3
    return np.logspace(math.log10(w_min), math.log10(w_max), n)


def closed_loop_poles(L: Loop, gs: float) -> np.ndarray:
    """Poles of ``1 + gs L = 0`` (z-plane for discrete loops, s-plane for continuous)."""
    return np.asarray(control.feedback(gs * L, 1.0).poles(), dtype=complex)


def stability_metric(poles: np.ndarray, dt: float) -> float:
    """``max|z| - 1`` (discrete) or ``max Re s`` (continuous); > 0 means unstable."""
    if dt:
        return float(np.max(np.abs(poles)) - 1.0)
    return float(np.max(poles.real))


def to_s_plane(poles: np.ndarray, dt: float) -> np.ndarray:
    """Equivalent s-plane poles (``ln z / T`` for discrete loops)."""
    if not dt:
        return poles
    return np.log(poles.astype(complex)) / dt


def gs_instability_threshold(
    L: Loop,
    gs_lo: float = 0.5,
    gs_hi: float = 3.0,
    tol: float = 0.005,
    step: float = 0.05,
) -> tuple[float | None, float | None]:
    """Smallest ``GS`` in ``[gs_lo, gs_hi]`` with an unstable closed-loop pole, and its |s|.

    Returns ``(None, None)`` if the loop is stable over the whole range and ``(gs_lo, w)`` if it is
    already unstable at ``gs_lo``.
    """
    dt = _dt(L)

    def metric(gs: float) -> float:
        return stability_metric(closed_loop_poles(L, gs), dt)

    def unstable_pole_w(gs: float) -> float:
        pol = closed_loop_poles(L, gs)
        s = to_s_plane(pol, dt)
        i = int(np.argmax(np.abs(pol) if dt else pol.real))
        return float(abs(s[i]))

    grid = list(np.arange(gs_lo, gs_hi + 0.5 * step, step))
    if grid[-1] > gs_hi:
        grid[-1] = gs_hi
    if metric(grid[0]) > 0:
        return float(grid[0]), unstable_pole_w(grid[0])
    a = grid[0]
    b = None
    for g in grid[1:]:
        if metric(g) > 0:
            b = g
            break
        a = g
    if b is None:
        return None, None
    while b - a > tol * 0.1:
        mid = 0.5 * (a + b)
        if metric(mid) > 0:
            b = mid
        else:
            a = mid
    return float(0.5 * (a + b)), unstable_pole_w(b)


def _track_eigs(
    A: np.ndarray, B: np.ndarray, C: np.ndarray, gss: np.ndarray
) -> tuple[np.ndarray, list[np.ndarray]]:
    """Closed-loop eigenvalues of ``A - gs B C`` per gain, columns matched between steps."""
    from scipy.optimize import linear_sum_assignment

    n = A.shape[0]
    out = np.zeros((len(gss), n), dtype=complex)
    vecs: list[np.ndarray] = []
    prev: np.ndarray | None = None
    for k, gs in enumerate(gss):
        w, v = np.linalg.eig(A - gs * (B @ C))
        if prev is not None:
            cost = np.abs(prev[:, None] - w[None, :])
            rows, cols = linear_sum_assignment(cost)
            order = np.empty(n, dtype=int)
            order[rows] = cols
            w, v = w[order], v[:, order]
        out[k] = w
        vecs.append(v)
        prev = w
    return out, vecs


def mode_thresholds(
    L: Loop,
    *,
    pos_idx: int,
    n_idx: int,
    pend_len: float,
    gs_lo: float = 0.5,
    gs_hi: float = 3.0,
    step: float = 0.01,
    bisect_iters: int = 30,
) -> tuple[ModeCrossing, ...]:
    """Every closed-loop pole (pair) of ``1 + GS L`` that crosses ``|z| = 1`` for ``GS`` in range.

    ``L`` is a discrete ``StateSpace`` loop with negative feedback ``A - GS B C``. Poles are
    followed from ``gs_lo`` with step ``step`` (optimal matching between successive steps), each
    crossing is refined by bisection, and the pendulum participation
    ``r = L |v[n_idx]| / |v[pos_idx]|`` is read from the right eigenvector at the crossing.
    A pole already outside the unit circle at ``gs_lo`` is reported at ``gs_lo``. Only the first
    crossing of each tracked pole is reported; conjugate duplicates are dropped. The *slosh mode*
    is a crossing with ``r > 5`` and frequency in 0.4 to 0.65 Hz; all others are "rigid-body".
    """
    ss = control.ss(L) if not isinstance(L, control.StateSpace) else L
    A, B, C = np.asarray(ss.A), np.asarray(ss.B), np.asarray(ss.C)
    T = _dt(ss)
    if not T:
        raise ValueError("mode_thresholds needs a discrete loop")
    gss = np.arange(gs_lo, gs_hi + 0.5 * step, step)
    gss[-1] = min(gss[-1], gs_hi)
    eigs, vecs = _track_eigs(A, B, C, gss)

    def info(gs: float, z0: complex) -> tuple[float, float]:
        w, v = np.linalg.eig(A - gs * (B @ C))
        j = int(np.argmin(np.abs(w - z0)))
        vec = v[:, j]
        r = pend_len * abs(vec[n_idx]) / max(abs(vec[pos_idx]), 1e-300)
        return float(abs(np.angle(w[j])) / (2 * math.pi * T)), float(r)

    found: list[ModeCrossing] = []
    n = eigs.shape[1]
    for i in range(n):
        mag = np.abs(eigs[:, i])
        if mag[0] > 1.0:
            k = 0
        else:
            bad = np.nonzero(mag > 1.0)[0]
            if len(bad) == 0:
                continue
            k = int(bad[0])
        if eigs[k, i].imag < -1e-9:
            continue  # conjugate duplicate
        gs_b = float(gss[k])
        z_b = eigs[k, i]
        if k > 0:
            a, b = float(gss[k - 1]), gs_b
            z_a = eigs[k - 1, i]
            for _ in range(bisect_iters):
                mid = 0.5 * (a + b)
                w = np.linalg.eigvals(A - mid * (B @ C))
                z = w[int(np.argmin(np.abs(w - z_a)))]
                if abs(z) > 1.0:
                    b, z_b = mid, z
                else:
                    a, z_a = mid, z
            gs_b = b
        f_hz, r = info(gs_b, z_b)
        slosh = r > SLOSH_R_MIN and SLOSH_BAND_HZ[0] <= f_hz <= SLOSH_BAND_HZ[1]
        found.append(ModeCrossing(gs_b, f_hz, r, "slosh" if slosh else "rigid-body"))
    return tuple(sorted(found, key=lambda c: c.gs))


def attach_modes(
    rep: MarginReport,
    L: Loop,
    p: Params,
    axis: str,
    *,
    gs_lo: float = 0.5,
    gs_hi: float = 3.0,
    step: float = 0.01,
) -> MarginReport:
    """Add the per-mode crossings and slosh / rigid-body thresholds to ``rep``."""
    ss = L if isinstance(L, control.StateSpace) else control.ss(L)
    # state 0 is the quad position and state 4 the pendulum unit-vector component (axis_model)
    mc = mode_thresholds(
        ss,
        pos_idx=0,
        n_idx=4,
        pend_len=p.pendulum.L,
        gs_lo=gs_lo,
        gs_hi=gs_hi,
        step=step,
    )
    sl = [c.gs for c in mc if c.kind == "slosh"]
    ri = [c.gs for c in mc if c.kind != "slosh"]
    return replace(
        rep,
        mode_crossings=mc,
        slosh_threshold=min(sl) if sl else None,
        rigid_threshold=min(ri) if ri else None,
        mode_gs_hi=gs_hi,
    )


def _crossings(
    w: np.ndarray, Lw: np.ndarray
) -> tuple[list[tuple[float, float, bool]], list[Crossing]]:
    """Gain crossovers ``(w, pm_deg, downward)`` and ``-180`` phase crossings."""
    mag = np.abs(Lw)
    ph = np.degrees(np.unwrap(np.angle(Lw)))
    ph = ph + (((ph[0] + 360.0) % 360.0) - 360.0 - ph[0])  # start in [-360, 0)
    lw = np.log(w)
    # gain crossovers
    xo: list[tuple[float, float, bool]] = []
    s = np.sign(np.log(mag))
    for i in np.nonzero(s[:-1] * s[1:] < 0)[0]:
        f = np.log(mag[i]) / (np.log(mag[i]) - np.log(mag[i + 1]))
        phase = ph[i] + f * (ph[i + 1] - ph[i])
        wc = math.exp(lw[i] + f * (lw[i + 1] - lw[i]))
        pm = ((phase + 180.0 + 180.0) % 360.0) - 180.0
        xo.append((wc, pm, bool(np.log(mag[i]) > 0)))
    # phase crossings: residual of (phase + 180) from the nearest multiple of 360
    g = ph + 180.0
    r = g - 360.0 * np.round(g / 360.0)
    pc: list[Crossing] = []
    for i in np.nonzero((r[:-1] * r[1:] < 0) & (np.abs(r[:-1]) < 90) & (np.abs(r[1:]) < 90))[0]:
        f = r[i] / (r[i] - r[i + 1])
        m = math.exp(np.log(mag[i]) + f * (np.log(mag[i + 1]) - np.log(mag[i])))
        wx = math.exp(lw[i] + f * (lw[i + 1] - lw[i]))
        pc.append(Crossing(w=wx, mag=m, gm=1.0 / m))
    return xo, pc


def _primary_crossover(L: Loop) -> tuple[float | None, float | None]:
    """``(wc, pm_deg)`` of the lowest-frequency downward gain crossover (for the inner loop)."""
    w = default_grid(L)
    Lw = freq_response(L, w)
    xo, _ = _crossings(w, Lw)
    for wc, pm, down in xo:
        if down:
            return wc, pm
    return None, None


def slosh_pole(poles: np.ndarray, dt: float, w_slosh: float) -> complex | None:
    """Complex closed-loop pole (s-plane) whose |s| is nearest ``w_slosh`` (upper half plane)."""
    s = to_s_plane(poles, dt)
    cand = s[s.imag > 1e-6]
    if len(cand) == 0:
        return None
    return complex(cand[int(np.argmin(np.abs(np.abs(cand) - w_slosh)))])


def margins(
    L: Loop,
    *,
    w_slosh: float | None = None,
    inner: Loop | None = None,
    gs_lo: float = 0.5,
    gs_hi: float = 3.0,
    tol: float = 0.005,
    sweep_step: float = 0.05,
    w_grid: np.ndarray | None = None,
) -> MarginReport:
    """Margin report for the loop ``L`` (at ``GS = 1``). See the module docstring."""
    dt = _dt(L)
    w = default_grid(L) if w_grid is None else w_grid
    Lw = freq_response(L, w)
    xo, pc = _crossings(w, Lw)

    primary: tuple[float, float] | None = None
    for wc, pm, down in xo:
        if down:
            primary = (wc, pm)
            break
    upper = [c for c in pc if c.mag < 1.0]
    lower = [c for c in pc if c.mag > 1.0]
    hf = min(upper, key=lambda c: c.gm) if upper else None
    lf = max(lower, key=lambda c: c.gm) if lower else None  # closest to 1 (largest ratio < 1)
    thr, thr_w = gs_instability_threshold(L, gs_lo, gs_hi, tol)

    rep = MarginReport(
        pm_deg=None if primary is None else primary[1],
        wc=None if primary is None else primary[0],
        pm_min_deg=min((pm for _, pm, down in xo if down), default=None),
        crossovers=tuple(xo),
        hf_gm=None if hf is None else hf.gm,
        hf_w=None if hf is None else hf.w,
        lf_gm_exists=bool(lower),
        lf_gm=None if lf is None else lf.gm,
        lf_w=None if lf is None else lf.w,
        phase_crossings=tuple(pc),
        gs_threshold=thr,
        gs_threshold_pole_w=thr_w,
    )
    if inner is not None:
        iw, ipm = _primary_crossover(inner)
        rep = replace(rep, inner_wc=iw, inner_pm_deg=ipm)
    if w_slosh is not None:
        sp = slosh_pole(closed_loop_poles(L, 1.0), dt, w_slosh)
        if sp is not None:
            wn = abs(sp)
            zeta = -sp.real / wn
            decay = math.log(4.0) / (zeta * wn) if zeta > 0 else math.inf
            rep = replace(rep, slosh_zeta=zeta, slosh_wn=wn, fig12_decay_s=decay)
        sweep = []
        for gs in np.arange(gs_lo, gs_hi + 0.5 * sweep_step, sweep_step):
            gs = min(float(gs), gs_hi)
            pol = closed_loop_poles(L, gs)
            sp2 = slosh_pole(pol, dt, w_slosh)
            sz = to_s_plane(pol, dt)
            row = {"gs": gs, "max_mag": float(np.max(np.abs(pol)) if dt else np.max(pol.real))}
            if sp2 is not None:
                # magnitude of the corresponding z-plane pole (or Re s for continuous loops)
                row["slosh_mag"] = float(math.exp(sp2.real * dt) if dt else sp2.real)
                row["slosh_zeta"] = float(-sp2.real / abs(sp2))
                row["slosh_w"] = float(abs(sp2))
            row["n_unstable"] = float(np.sum(np.abs(pol) > 1.0 if dt else sz.real > 0))
            sweep.append(row)
        rep = replace(rep, gs_sweep=tuple(sweep))
    return rep


def analyze_axis(axis: str, p: Params | None = None, **kw: Any) -> MarginReport:
    """Full report for the outer loop of ``axis`` ('x' = pitch channel, 'y' = roll channel)."""
    p = load_params() if p is None else p
    L = outer_loop_ss(axis, p)
    return margins(L, w_slosh=slosh_omega(p), inner=inner_loop_ss(axis, p), **kw)


# --- report -----------------------------------------------------------------------------------
AXIS_LABEL = {"x": "x (pitch channel)", "y": "y (roll channel)"}


def _f(v: float | None, fmt: str = "{:.3f}", none: str = "n/a") -> str:
    return none if v is None else fmt.format(v)


def _hz(w: float | None) -> str:
    return "n/a" if w is None else f"{w / (2 * math.pi):.3f}"


def _db(r: float | None) -> str:
    return "n/a" if r is None else f"{20 * math.log10(r):.1f}"


DECAY_RATE_MIN = math.log(4.0) / 30.0


def _rate(r: MarginReport) -> float | None:
    if r.slosh_zeta is None or r.slosh_wn is None:
        return None
    return r.slosh_zeta * r.slosh_wn


def _stable_gs1(r: MarginReport) -> bool:
    """Stable at GS = 1: no instability at or below 1 (threshold above 1 or absent)."""
    row = next((x for x in r.gs_sweep if abs(x["gs"] - 1.0) < 1e-9), None)
    if row is not None:
        return row["n_unstable"] == 0
    return r.gs_threshold is None or r.gs_threshold > 1.0


def render_report(p: Params, reports: dict[str, MarginReport]) -> str:
    lines: list[str] = [
        "# Outer-loop margins and gain-shift threshold",
        "",
        "Generated by `python -m slosh.design.margins` from the linearized nonlinear model",
        "(`slosh.design.linearize`): central-difference Jacobian about hover, ZOH at "
        f"{p.control.rateHz:g} Hz, inner PD loop closed, outer loop broken at `u_a` "
        "(output of the outer PD, GS = K_T = 1).",
        "",
        "PD gains are *designed (reconstruction)* values from `slosh.design.fit_gains` and the "
        "motor time constant is assumed; see `shared/params/default.json` for provenance.",
        "",
        f"- Outer PD: Kp = {p.control.outer.Kp}, Kd = {p.control.outer.Kd}",
        f"- Inner PD: Kp = {p.control.inner.Kp}, Kd = {p.control.inner.Kd}",
        f"- Motor time constant: {p.motor.tau * 1e3:.0f} ms (assumed)",
        f"- Slosh mode (open loop, undamped): {slosh_omega(p):.3f} rad/s = "
        f"{slosh_omega(p) / (2 * math.pi):.3f} Hz",
        "",
        "Phase margin and gain margins use the discrete loop `L(z)` evaluated up to the Nyquist "
        "frequency. A lower gain margin (phase crossing with |L| > 1) would mean a *low* gain also "
        'destabilizes; "LF GM" below says whether one exists.',
        "",
        "## Designed values vs R-1 Table 1 (guidance, not enforced)",
        "",
        "The R-1 Table 1 margins guided the PD design but are not pass/fail. The simulator "
        "deliberately places the *slosh-mode* gain-shift threshold below 2.0 (1.3 to 1.95) so that "
        "the gain-shift presets visibly destabilize the ~0.5 Hz slosh mode (teaching choice).",
        "",
        "| Quantity | R-1 Table 1 target | Designed x (pitch) | Designed y (roll) |",
        "|---|---|---|---|",
    ]
    rx, ry = reports["x"], reports["y"]

    def both(fn: Any) -> str:
        return f"{fn(rx)} | {fn(ry)}"

    lines += [
        f"| Phase margin [deg] | {TABLE1['pm_deg']:.0f} | "
        + both(lambda r: _f(r.pm_deg, "{:.1f}"))
        + " |",
        f"| Gain crossover [Hz] | {TABLE1['pm_hz']} | " + both(lambda r: _hz(r.wc)) + " |",
        f"| HF gain margin [ratio (dB)] | {TABLE1['hf_gm']} "
        f"({20 * math.log10(TABLE1['hf_gm']):.1f} dB) | "
        + both(lambda r: "n/a" if r.hf_gm is None else f"{r.hf_gm:.2f} ({_db(r.hf_gm)} dB)")
        + " |",
        f"| HF GM frequency [Hz] | {TABLE1['hf_hz']} | " + both(lambda r: _hz(r.hf_w)) + " |",
        "| Low-frequency gain margin | none (infinite) | "
        + both(lambda r: "exists" if r.lf_gm_exists else "none (infinite)")
        + " |",
        "",
        "## Design targets (hard) and shortfall flags",
        "",
        "These are the targets of `slosh.design.fit_gains`; they are asserted by "
        "`tests/design/test_margins.py`. The Table 1 rows above are *not* asserted.",
        "",
        "| Hard target | Required | x (pitch) | y (roll) |",
        "|---|---|---|---|",
        "| Slosh-mode GS threshold (r > 5, 0.4 to 0.65 Hz) | 1.3 to 1.95 | "
        + both(lambda r: "none" if r.slosh_threshold is None else f"{r.slosh_threshold:.3f}")
        + " |",
        "| Rigid-body threshold (lowest crossing of any other mode) | >= 2.8 or > "
        f"{rx.mode_gs_hi:g} | "
        + both(
            lambda r: (
                f"> {r.mode_gs_hi:g}" if r.rigid_threshold is None else f"{r.rigid_threshold:.3f}"
            )
        )
        + " |",
        "| Inner-loop crossover [Hz] (reported; may be below 1.5) | reported | "
        + both(lambda r: "n/a" if r.inner_wc is None else f"{r.inner_wc / (2 * math.pi):.3f}")
        + " |",
        "| Inner-loop phase margin [deg] | >= 45 | "
        + both(lambda r: _f(r.inner_pm_deg, "{:.1f}"))
        + " |",
        "| Closed loop stable at GS = 1 | yes | "
        + both(lambda r: "yes" if _stable_gs1(r) else "**NO**")
        + " |",
        f"| Slosh decay rate zeta wn [1/s] at GS = 1 | >= {DECAY_RATE_MIN:.4f} (ln 4 / 30) | "
        + both(lambda r: _f(_rate(r), "{:.4f}"))
        + " |",
        "| Predicted Fig 12 decay, 0.2 to 0.05 rad [s] | <= 30 | "
        + both(lambda r: _f(r.fig12_decay_s, "{:.1f}"))
        + " |",
        "",
        "## Per-mode gain-shift crossings",
        "",
        "Every closed-loop pole pair is followed over GS 0.5 to "
        f"{rx.mode_gs_hi:g} (step 0.01, 100 Hz ZOH loop). The pendulum participation is "
        "`r = L |dn| / |dp_quad|` from the eigenvector at the crossing. A crossing with r > 5 and "
        "frequency 0.4 to 0.65 Hz is the slosh mode; any other is a rigid-body mode.",
        "",
        "| Mode | Axis | GS threshold | Frequency [Hz] | r |",
        "|---|---|---|---|---|",
    ]
    for ax in ("x", "y"):
        mcs = reports[ax].mode_crossings
        for c in mcs:
            lines.append(f"| {c.kind} | {ax} | {c.gs:.3f} | {c.freq_hz:.3f} | {c.r:.1f} |")
        if not any(c.kind == "rigid-body" for c in mcs):
            lines.append(
                f"| rigid-body | {ax} | > {reports[ax].mode_gs_hi:g} (no crossing) | - | - |"
            )
    lines += [""]
    shortfall = [
        ax
        for ax in ("x", "y")
        if reports[ax].fig12_decay_s is None or reports[ax].fig12_decay_s > 30.0
    ]
    if shortfall:
        lines += [
            "**Damping shortfall (input for the pendulum-damping decision):** the predicted Fig 12 "
            f"decay time exceeds 30 s on axis {', '.join(shortfall)}. The GS threshold target was "
            "met first; the pendulum damping `k_damp` (currently "
            f"{p.pendulum.k_damp:g}) may need revising.",
            "",
        ]
    else:
        lines += [
            "No damping shortfall: the predicted Fig 12 decay time is within 30 s on both axes "
            f"with `k_damp` = {p.pendulum.k_damp:g}.",
            "",
        ]
    lines += [
        "## Details per axis",
        "",
        "| Quantity | x (pitch) | y (roll) |",
        "|---|---|---|",
        "| Phase margin at primary crossover [deg] | "
        + both(lambda r: _f(r.pm_deg, "{:.1f}"))
        + " |",
        "| Primary gain crossover [rad/s] | " + both(lambda r: _f(r.wc)) + " |",
        "| Smallest PM over downward crossovers [deg] | "
        + both(lambda r: _f(r.pm_min_deg, "{:.1f}"))
        + " |",
        "| HF gain margin [ratio] | " + both(lambda r: _f(r.hf_gm, "{:.3f}")) + " |",
        "| HF gain margin [dB] | " + both(lambda r: _db(r.hf_gm)) + " |",
        "| HF GM phase-crossover frequency [rad/s] | " + both(lambda r: _f(r.hf_w)) + " |",
        "| LF gain margin exists | " + both(lambda r: "yes" if r.lf_gm_exists else "no") + " |",
        "| Inner-loop crossover [rad/s] | " + both(lambda r: _f(r.inner_wc, "{:.2f}")) + " |",
        "| Inner-loop phase margin [deg] | " + both(lambda r: _f(r.inner_pm_deg, "{:.1f}")) + " |",
        "| Closed-loop slosh damping ratio at GS = 1 | "
        + both(lambda r: _f(r.slosh_zeta, "{:.4f}"))
        + " |",
        "| Closed-loop slosh frequency [rad/s] | " + both(lambda r: _f(r.slosh_wn)) + " |",
        "| Predicted Fig 12 decay time, 0.2 to 0.05 rad [s] (ln 4 / (zeta wn)) | "
        + both(lambda r: _f(r.fig12_decay_s, "{:.1f}"))
        + " |",
        "| **Slosh-mode GS threshold** (linear) | "
        + both(
            lambda r: (
                "none in range" if r.slosh_threshold is None else f"**{r.slosh_threshold:.3f}**"
            )
        )
        + " |",
        "| First crossing of any mode (GS) | "
        + both(lambda r: "none" if r.gs_threshold is None else f"{r.gs_threshold:.3f}")
        + " |",
        "",
        "Phase crossings (-180 deg) of `L` at GS = 1 (ratio = 1/|L|; < 1 means lower margin):",
        "",
    ]
    for ax in ("x", "y"):
        r = reports[ax]
        lines.append(
            f"- {AXIS_LABEL[ax]}: "
            + (
                "; ".join(f"{c.w / (2 * math.pi):.3f} Hz, GM {c.gm:.3f}" for c in r.phase_crossings)
                or "none"
            )
        )
    lines += [
        "",
        "Gain crossovers (frequency, direction of |L|, phase margin; an 'up' crossing comes "
        "from the slosh dipole):",
        "",
    ]
    for ax in ("x", "y"):
        r = reports[ax]
        lines.append(
            f"- {AXIS_LABEL[ax]}: "
            + (
                "; ".join(
                    f"{w / (2 * math.pi):.3f} Hz, {'down' if d else 'up'}, PM {pm:.1f} deg"
                    for w, pm, d in r.crossovers
                )
                or "none"
            )
        )
    lines += [
        "",
        "## Gain-shift sweep (closed-loop slosh pole vs GS)",
        "",
        "`mag(z) slosh` is the magnitude of the closed-loop pole nearest the slosh frequency "
        "(discrete plane, 100 Hz); `max mag(z)` is over all poles. A value above 1 is unstable.",
        "",
        "| GS | x mag(z) slosh | x max mag(z) | x zeta | y mag(z) slosh | y max mag(z) | y zeta |",
        "|---|---|---|---|---|---|---|",
    ]
    for rowx, rowy in zip(rx.gs_sweep, ry.gs_sweep, strict=True):

        def cell(row: dict[str, float]) -> str:
            return (
                f"{row.get('slosh_mag', float('nan')):.5f} | {row['max_mag']:.5f} | "
                f"{row.get('slosh_zeta', float('nan')):+.4f}"
            )

        lines.append(f"| {rowx['gs']:.2f} | {cell(rowx)} | {cell(rowy)} |")
    lines += [
        "",
        "Plots: `nichols_outer_x.png`, `nichols_outer_y.png`, `bode_inner_x.png`, "
        "`bode_inner_y.png`.",
        "",
    ]
    return "\n".join(lines)


def _plot_nichols(L: Loop, rep: MarginReport, title: str, path: Path, w_slosh: float) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    w = default_grid(L)
    Lw = freq_response(L, w)
    ph = np.degrees(np.unwrap(np.angle(Lw)))
    ph = ph + (((ph[0] + 360.0) % 360.0) - 360.0 - ph[0])
    mag_db = 20 * np.log10(np.abs(Lw))
    fig, ax = plt.subplots(figsize=(6.5, 5))
    ax.plot(ph, mag_db, color="#0072B2", lw=1.2, label="L(jw), GS = 1")
    ax.plot(-180, 0, "r+", ms=14, mew=2, label="critical point")
    for gs, style in ((rep.slosh_threshold or rep.gs_threshold, "--"),):
        if gs:
            ax.plot(
                ph,
                mag_db + 20 * np.log10(gs),
                style,
                color="#D55E00",
                lw=0.9,
                label=f"GS = {gs:.2f} (threshold)",
            )
    i = int(np.argmin(np.abs(w - w_slosh)))
    ax.plot(ph[i], mag_db[i], "o", color="#009E73", label=f"{w_slosh / (2 * math.pi):.2f} Hz")
    ax.set_xlim(-360, 0)
    ax.set_ylim(-40, 60)
    ax.set_xlabel("phase [deg]")
    ax.set_ylabel("|L| [dB]")
    ax.set_title(title)
    ax.grid(True, alpha=0.3)
    ax.legend(fontsize=8, loc="upper left")
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def _plot_bode(L: Loop, title: str, path: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    w = default_grid(L, w_min=1e-1)
    Lw = freq_response(L, w)
    ph = np.degrees(np.unwrap(np.angle(Lw)))
    ph = ph + (((ph[0] + 360.0) % 360.0) - 360.0 - ph[0])
    fig, (a1, a2) = plt.subplots(2, 1, sharex=True, figsize=(6.5, 5))
    a1.semilogx(w / (2 * math.pi), 20 * np.log10(np.abs(Lw)), color="#0072B2")
    a1.axhline(0, color="k", lw=0.6)
    a1.set_ylabel("|L| [dB]")
    a1.set_title(title)
    a2.semilogx(w / (2 * math.pi), ph, color="#0072B2")
    a2.axhline(-180, color="k", lw=0.6)
    a2.set_ylabel("phase [deg]")
    a2.set_xlabel("frequency [Hz]")
    for a in (a1, a2):
        a.grid(True, which="both", alpha=0.3)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def write_outputs(p: Params, out_dir: Path) -> dict[str, MarginReport]:
    """Compute reports for both axes and write ``margins.md`` and the PNGs into ``out_dir``."""
    out_dir.mkdir(parents=True, exist_ok=True)
    reports: dict[str, MarginReport] = {}
    ws = slosh_omega(p)
    for ax in AXES:
        L = outer_loop_ss(ax, p)
        reports[ax] = attach_modes(margins(L, w_slosh=ws, inner=inner_loop_ss(ax, p)), L, p, ax)
        _plot_nichols(
            L,
            reports[ax],
            f"Outer loop Nichols, {AXIS_LABEL[ax]}",
            out_dir / f"nichols_outer_{ax}.png",
            ws,
        )
        _plot_bode(
            inner_loop_ss(ax, p),
            f"Inner attitude loop, {AXIS_LABEL[ax]}",
            out_dir / f"bode_inner_{ax}.png",
        )
    (out_dir / "margins.md").write_text(render_report(p, reports), encoding="utf-8")
    return reports


def main(argv: list[str] | None = None) -> None:
    default_out = Path(__file__).resolve().parents[4] / "reports"
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", type=Path, default=default_out, help="output directory")
    ap.add_argument("--params", type=Path, default=None, help="parameter file")
    args = ap.parse_args(argv)
    p = load_params(args.params) if args.params else load_params()
    reports = write_outputs(p, args.out)
    for ax, r in reports.items():
        print(
            f"{ax}: PM {r.pm_deg} deg @ {r.wc} rad/s, HF GM {r.hf_gm} @ {r.hf_w}, "
            f"slosh-mode GS threshold {_f(r.slosh_threshold)}, rigid-body threshold "
            + ("> " + f"{r.mode_gs_hi:g}" if r.rigid_threshold is None else _f(r.rigid_threshold))
            + f", inner PM {_f(r.inner_pm_deg, '{:.1f}')} deg @ {_hz(r.inner_wc)} Hz"
        )
        for c in r.mode_crossings:
            print(f"   {c.kind}: GS {c.gs:.3f}, {c.freq_hz:.3f} Hz, r = {c.r:.1f}")
    print(f"wrote {args.out / 'margins.md'}")


if __name__ == "__main__":
    main()
