"""Story-preset analysis helpers (shared by ``tests/test_presets.py`` and the verification script).

theta envelope = 2 s trailing sliding max of theta (``slosh.instability.envelope``).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .core.sim import Sim
from .instability import envelope
from .params import load_params
from .presets import load_preset

DT = 0.01
SHIFT_GS = 2.3
SHIFT_RAMP_S = 1.5


def run_story(duration: float | None = None) -> list[dict[str, Any]]:
    """Run the shipped story preset (optionally longer than ``durationS``); one dict per tick."""
    sim = Sim(load_params())
    sim.enqueue({"type": "loadPreset", "id": "story"})
    n = round((load_preset("story").durationS if duration is None else duration) / DT)
    return [sim.step_control() for _ in range(n)]


def first_trip(tel: Sequence[dict[str, Any]], after: float = 0.0) -> float | None:
    """Time of the first detector flag (either axis) after ``after`` [s], else None."""
    return next(
        (s["t"] for s in tel if s["t"] > after and (s["detect_pitch"] or s["detect_roll"])), None
    )


def env_at(env: Sequence[float], t: float) -> float:
    return env[round(t / DT) - 1]


def ln_slope(env: Sequence[float], t0: float) -> float:
    """Least-squares slope of ln(envelope) against time over [t0, end of ``env``] [1/s]."""
    xs = [(i * DT, math.log(env[i])) for i in range(round(t0 / DT) - 1, len(env))]
    n = len(xs)
    mx = sum(x for x, _ in xs) / n
    my = sum(y for _, y in xs) / n
    return sum((x - mx) * (y - my) for x, y in xs) / sum((x - mx) ** 2 for x, _ in xs)


@dataclass(frozen=True)
class StoryTimes:
    t_shift: float
    t_engage: float
    duration: float


def story_times() -> StoryTimes:
    pre = load_preset("story")
    shift = next(e["t"] for e in pre.events if e["type"] == "rampGainShift")
    engage = next(
        e["t"] for e in pre.events if e["type"] == "setAacMode" and e["mode"] == "engaged"
    )
    return StoryTimes(float(shift), float(engage), pre.durationS)


def trip_delay_from_amplitude(theta0: float, dwell: float = 8.0, run: float = 60.0) -> dict:
    """Shift applied (ramp to 2.3 + Monitor, as in the story) after ``dwell`` s of nominal flight
    from a kick of amplitude ``theta0`` (phiDot scaled like the 0.2 rad / 0.6 rad/s kick).

    Returns the envelope at the shift, the trip delay after the shift [s] (None if no trip within
    ``run`` s) and the peak envelope."""
    sim = Sim(load_params())
    sim.enqueue({"type": "loadPreset", "id": "story"})
    sim.enqueue({"type": "clearSchedule"})  # manual shift below, not the scheduled one
    sim.enqueue({"type": "kick", "theta": theta0, "phiDot": 0.6 * theta0 / 0.2})
    n_dwell = round(dwell / DT)
    tel: list[dict[str, Any]] = []
    for i in range(round(run / DT)):
        if i == n_dwell:
            sim.enqueue({"type": "rampGainShift", "to": SHIFT_GS, "durationS": SHIFT_RAMP_S})
            sim.enqueue({"type": "setAacMode", "mode": "monitor"})
        tel.append(sim.step_control())
    env = envelope([s["theta"] for s in tel], DT)
    t_trip = first_trip(tel, dwell)
    return {
        "envAtShift": env[n_dwell - 1],
        "tripDelayS": None if t_trip is None else t_trip - dwell,
        "peakEnv": max(env),
    }
