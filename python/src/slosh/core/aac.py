"""Adaptive augmenting control: per-axis K_T law, spectral damper, detector, modes.

Plain scalar floats, ``math`` only. One :class:`Aac` instance serves one axis (pitch/x or
roll/y); the simulation holds two and steps them once per control tick (100 Hz).

Spectral damper (per axis)::

    y_SD = LP( HP(u_a)^2 )          # biquads from ``aac.hp.sos`` / ``aac.lp.sos``

Adaptive law (forward Euler, dt = 0.01 s, then clamped to ``[kMin, kMax]``)::

    k_T' = -a0 (k_T - 1) + b_e e_ref^2 (kMax - k_T) - b_s y_SD (k_T - kMin)

``e_ref`` is the position error through a first-order lead-lag ``(tauLead s + 1)/(tauLag s + 1)``
(Tustin at the control rate), computed in every mode even when ``b_e = 0`` (R-1 Sec. III.B).

Detector: trips (latched) when ``y_SD > threshold``; clears once ``y_SD < clearRatio * threshold``
for ``clearHoldS`` seconds continuously. ``trip_edge`` is true on each rising edge.

Modes:

========  =========================================  ==========
mode      filters / detector / k_T                    kT_applied
========  =========================================  ==========
off       reset, k_T = 1                              1
monitor   run and integrate                           1
engaged   run and integrate                           k_T
========  =========================================  ==========

On a switch to ``engaged`` with ``engageRampS > 0``, ``kT_applied`` is rate-limited toward ``k_T``
(slew rate ``(kMax - kMin) / engageRampS``). The default 0 applies ``k_T`` immediately.

``a0``, ``b_s`` and ``threshold`` are ``None`` in the parameter file until tuned; pass explicit
values through the constructor (or ``dataclasses.replace`` on the params) to use them.
"""

from __future__ import annotations

import math
from typing import NamedTuple

from ..params import Params
from .filters import Sos

DT = 0.01
MODES = ("off", "monitor", "engaged")


class AacOut(NamedTuple):
    """Per-axis AAC output for one tick."""

    kT: float  # adaptive state
    kT_applied: float  # what the forward loop uses
    ySD: float
    detect: bool  # detector latch
    trip_edge: bool  # True on the tick the latch goes from clear to tripped


class LeadLag:
    """``(tl s + 1)/(tg s + 1)`` via Tustin; unity DC gain; direct form II transposed."""

    __slots__ = ("a1", "b0", "b1", "z")

    def __init__(self, t_lead: float, t_lag: float, dt: float = DT) -> None:
        c = 2.0 / dt
        den = c * t_lag + 1.0
        self.b0 = (c * t_lead + 1.0) / den
        self.b1 = (1.0 - c * t_lead) / den
        self.a1 = (1.0 - c * t_lag) / den
        self.z = 0.0

    def step(self, x: float) -> float:
        y = self.b0 * x + self.z
        self.z = self.b1 * x - self.a1 * y
        return y

    def reset(self) -> None:
        self.z = 0.0


class Aac:
    """Adaptive gain, spectral damper and detector for one axis."""

    def __init__(
        self,
        p: Params,
        *,
        a0: float | None = None,
        b_s: float | None = None,
        b_e: float | None = None,
        threshold: float | None = None,
    ) -> None:
        a = p.aac
        self.a0 = _pick("a0", a0, a.a0)
        self.b_s = _pick("b_s", b_s, a.b_s)
        self.b_e = float(a.b_e if b_e is None else b_e)
        self.threshold = _pick("threshold", threshold, a.threshold)
        self.k_min = a.kMin
        self.k_max = a.kMax
        self.clear_level = a.clearRatio * self.threshold
        self.clear_ticks = round(a.clearHoldS / DT)
        self.slew = (a.kMax - a.kMin) / a.engageRampS * DT if a.engageRampS > 0.0 else math.inf
        self.hp = Sos(a.hp.sos)
        self.lp = Sos(a.lp.sos)
        self.e_filt = LeadLag(a.refLeadS, a.refLagS)
        self.reset()

    def reset(self) -> None:
        """Back to the Off state: filters cleared, k_T = 1, detector clear."""
        self.hp.reset()
        self.lp.reset()
        self.e_filt.reset()
        self.k = 1.0
        self.k_applied = 1.0
        self.y = 0.0
        self.detect = False
        self.calm = 0  # consecutive ticks below the clear level
        self.mode = "off"

    def step(self, u_a: float, e_ref_a: float, mode: str) -> AacOut:
        """Advance one control tick (0.01 s)."""
        if mode not in MODES:
            raise ValueError(f"unknown AAC mode {mode!r}")
        if mode == "off":
            self.reset()
            return AacOut(1.0, 1.0, 0.0, False, False)

        # Spectral damper and reference-error filter (monitor and engaged).
        h = self.hp.step(u_a)
        self.y = self.lp.step(h * h)
        e = self.e_filt.step(e_ref_a)

        # Adaptive law: forward Euler, then clamp.
        k = self.k
        kd = (
            -self.a0 * (k - 1.0)
            + self.b_e * e * e * (self.k_max - k)
            - self.b_s * self.y * (k - self.k_min)
        )
        k += DT * kd
        self.k = min(self.k_max, max(self.k_min, k))

        # Detector with hysteresis.
        edge = False
        if self.y > self.threshold:
            edge = not self.detect
            self.detect = True
            self.calm = 0
        elif self.detect:
            if self.y < self.clear_level:
                self.calm += 1
                if self.calm >= self.clear_ticks:
                    self.detect = False
                    self.calm = 0
            else:
                self.calm = 0

        # Applied gain: 1 in monitor; in engaged, k_T (rate-limited from 1 right after engaging).
        if mode == "monitor":
            self.k_applied = 1.0
        else:
            cur = self.k_applied if self.mode == "engaged" else 1.0
            if self.slew == math.inf:
                self.k_applied = self.k
            else:
                self.k_applied = (
                    min(self.k, cur + self.slew) if self.k > cur else max(self.k, cur - self.slew)
                )
        self.mode = mode
        return AacOut(self.k, self.k_applied, self.y, self.detect, edge)


def _pick(name: str, override: float | None, default: float | None) -> float:
    v = default if override is None else override
    if v is None:
        raise ValueError(f"aac.{name} is not tuned yet; pass it explicitly")
    return float(v)
