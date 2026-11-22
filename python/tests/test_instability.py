"""Debug saturation flags and the instability analysis helpers."""

from __future__ import annotations

from slosh.core.sim import Sim
from slosh.design.fit_gains import with_gains
from slosh.instability import (
    PLACEHOLDER_AAC,
    configure,
    decay_time,
    envelope,
    simulate,
)
from slosh.params import load_params


def test_sat_flags_are_debug_fields_only() -> None:
    p = load_params()
    tel = simulate(p, "fig12")[:5]
    assert all(isinstance(s["sat_att"], bool) and isinstance(s["sat_motor"], bool) for s in tel)
    assert not any(s["sat_att"] or s["sat_motor"] for s in tel)


def test_sat_att_when_command_clamped() -> None:
    p = configure(load_params(), att_max=0.001)
    sim = Sim(p, None, PLACEHOLDER_AAC)
    sim.enqueue({"type": "loadPreset", "id": "fig13"})
    tel = [sim.step_control() for _ in range(300)]
    assert any(s["sat_att"] for s in tel)


def test_sat_motor_when_limits_hit() -> None:
    # the flag test needs a loop aggressive enough to reach the motor limits: use the stiffer
    # first-generation PD gains (the shipped, softer gains stay far from the motor limits)
    p = configure(with_gains(load_params(), inner=(54.63, 9.805), outer=(5.169, 4.07)), att_max=0.8)
    tel = simulate(p, "fig13")[:3000]
    assert any(s["sat_motor"] for s in tel)


def test_envelope_and_decay_time() -> None:
    th = [1.0] * 100 + [0.0] * 300
    env = envelope(th, 0.01)
    assert env[99] == 1.0 and env[350] == 0.0
    d = decay_time(env, 0.01)
    assert d is not None and 2.9 < d < 3.1
    assert decay_time([1.0] * 10, 0.01) is None


def test_committed_params_keep_realism_off() -> None:
    p = load_params()
    assert p.sensing.latencyMs == 0
    assert p.sensing.noise.enabled is False
