import math
import subprocess
import sys
import time
from dataclasses import replace

import pytest

from slosh.core.sim import Sim
from slosh.params import load_params
from slosh.run import aac_overrides, run_preset

P = load_params()
OV = aac_overrides(P, None, None, None)  # explicit placeholders for the still-null AAC values


def make(**kw) -> Sim:
    return Sim(P, aac_overrides=OV, **kw)


def test_determinism_fig13_30s():
    a = run_preset("fig13", 30.0, OV)
    b = run_preset("fig13", 30.0, OV)
    assert len(a) == 3000
    assert a == b  # dict equality of floats: bit-identical


def test_telemetry_keys_and_motor_normalization():
    s = make()
    tel = s.step_control()
    keys = (
        "t theta phi mx my mz x y z roll pitch yaw kT_pitch kT_roll kTApplied_pitch "
        "kTApplied_roll ySD_pitch ySD_roll detect_pitch detect_roll gainShift aacMode "
        "m1 m2 m3 m4 w1 w2 w3 w4"
    ).split()
    assert [k for k in tel if not k.startswith("sat_")] == keys
    # debug-only fields, appended last; never golden columns or TS Telemetry
    assert list(tel)[-2:] == ["sat_att", "sat_motor"]
    assert tel["t"] == pytest.approx(0.01)
    for i in range(1, 5):
        assert 0.0 < tel[f"m{i}"] < 1.0
    # hover: thrust balances weight, mass hangs straight down
    assert tel["theta"] < 1e-9
    assert tel["mz"] == pytest.approx(P.pendulum.L)


def test_commands_take_effect_at_next_tick_boundary():
    s = make()
    for _ in range(3):
        s.step_control()
    s.enqueue({"type": "setGainShift", "value": 2.0})
    s.enqueue({"type": "setAacMode", "mode": "monitor"})
    assert s.log == []  # queued only; nothing applied mid-tick
    assert s.gs == 1.0
    tel = s.step_control()
    assert s.log == [
        (3, {"type": "setGainShift", "value": 2.0}),
        (3, {"type": "setAacMode", "mode": "monitor"}),
    ]
    assert tel["gainShift"] == 2.0 and tel["aacMode"] == "monitor"
    s.step_control()
    s.enqueue({"type": "kick"})
    s.step_control()
    assert s.log[-1] == (5, {"type": "kick"})


def test_gain_shift_clamped():
    s = make()
    s.enqueue({"type": "setGainShift", "value": 9.0})
    assert s.step_control()["gainShift"] == 3.0
    s.enqueue({"type": "setGainShift", "value": 0.0})
    assert s.step_control()["gainShift"] == 0.5


def test_unknown_command_rejected():
    s = make()
    with pytest.raises(ValueError):
        s.enqueue({"type": "nope"})
    with pytest.raises(ValueError):
        s.enqueue({"type": "setAacMode", "mode": "bogus"})


def test_ramp_gain_shift_midpoint():
    s = make()
    s.enqueue({"type": "setGainShift", "value": 1.0})
    s.enqueue({"type": "rampGainShift", "to": 2.0, "durationS": 20.0})
    tel = [s.step_control() for _ in range(2000)]
    mid = tel[999]
    assert mid["t"] == pytest.approx(10.0)
    assert mid["gainShift"] == pytest.approx(1.5, abs=0.005)
    assert tel[-1]["gainShift"] == 2.0
    assert all(b["gainShift"] >= a["gainShift"] for a, b in zip(tel, tel[1:], strict=False))


def test_set_gain_shift_cancels_ramp():
    s = make()
    s.enqueue({"type": "rampGainShift", "to": 3.0, "durationS": 10.0})
    for _ in range(100):
        s.step_control()
    s.enqueue({"type": "setGainShift", "value": 1.2})
    for _ in range(50):
        assert s.step_control()["gainShift"] == 1.2


def test_kick_sets_theta_and_perpendicular_rate():
    s = make()
    for _ in range(5):
        s.step_control()
    s.enqueue({"type": "kick"})
    s.apply_commands()  # the state exactly as the next tick starts
    x = s.state
    n, w = x[13:16], x[16:19]
    assert math.acos(n[2]) == pytest.approx(0.2, abs=1e-9)
    assert abs(sum(a * b for a, b in zip(w, n, strict=True))) < 1e-12
    assert math.hypot(*w) == pytest.approx(0.6 * math.sin(0.2), rel=1e-9)  # |n x n_dot|
    # and after the full tick the pendulum has barely moved from there
    tel = s.step_control()
    assert tel["theta"] == pytest.approx(0.2, abs=0.01)
    n, w = s.state[13:16], s.state[16:19]
    assert abs(sum(a * b for a, b in zip(w, n, strict=True))) < 1e-12


def test_kick_keeps_current_phi():
    s = make()
    s.enqueue({"type": "kick", "theta": 0.1, "phiDot": 0.0})
    s.apply_commands()
    n = s.state[13:16]
    s.enqueue({"type": "kick", "theta": 0.3, "phiDot": 0.4})
    s.apply_commands()
    m = s.state[13:16]
    assert math.atan2(m[1], m[0]) == pytest.approx(math.atan2(n[1], n[0]), abs=1e-12)
    assert math.acos(m[2]) == pytest.approx(0.3, abs=1e-12)


def test_preset_events_scheduled_through_queue():
    s = make()
    s.enqueue({"type": "loadPreset", "id": "vb"})
    tel = [s.step_control() for _ in range(10100)]
    assert tel[0]["aacMode"] == "monitor"
    assert tel[9999]["aacMode"] == "monitor"  # last tick before t = 100 s
    assert tel[10000]["aacMode"] == "engaged"  # applied at the start of tick 10000 (t = 100 s)
    assert tel[-1]["gainShift"] == 2.0
    cmds = [(k, c["type"]) for k, c in s.log]
    assert cmds == [(0, "loadPreset"), (0, "rampGainShift"), (10000, "setAacMode")]


def test_load_preset_initial_state():
    s = make()
    s.enqueue({"type": "loadPreset", "id": "fig13"})
    s.apply_commands()
    n = s.state[13:16]
    assert math.acos(n[2]) == pytest.approx(0.2, abs=1e-12)
    assert s.gs == 2.3 and s.mode == "monitor"
    tel = s.step_control()
    assert tel["gainShift"] == 2.3 and tel["t"] == pytest.approx(0.01)


def test_reset_restores_preset_and_time():
    s = make()
    s.enqueue({"type": "loadPreset", "id": "fig13"})
    first = [s.step_control() for _ in range(200)]
    s.enqueue({"type": "setGainShift", "value": 1.0})
    for _ in range(50):
        s.step_control()
    s.enqueue({"type": "reset"})
    again = [s.step_control() for _ in range(200)]
    assert again == first  # same preset, same seed -> identical replay
    assert s.tick == 450  # tick counter never resets


def test_reset_without_preset_goes_to_hover_defaults():
    s = make()
    s.enqueue({"type": "kick"})
    s.step_control()
    s.enqueue({"type": "setAacMode", "mode": "monitor"})
    s.enqueue({"type": "reset"})
    tel = s.step_control()
    assert tel["theta"] < 1e-9 and tel["aacMode"] == "off" and tel["gainShift"] == 1.0


def test_replay_from_log_is_bit_exact():
    s = make()
    out = []
    for i in range(600):
        if i == 50:
            s.enqueue({"type": "kick"})
        if i == 120:
            s.enqueue({"type": "setGainShift", "value": 2.4})
        if i == 200:
            s.enqueue({"type": "setAacMode", "mode": "engaged"})
        out.append(s.step_control())
    r = make()
    by_tick: dict[int, list[dict]] = {}
    for k, c in s.log:
        by_tick.setdefault(k, []).append(c)
    out2 = []
    for i in range(600):
        for c in by_tick.get(i, []):
            r.enqueue(c)
        out2.append(r.step_control())
    assert out == out2


def test_aac_off_keeps_kt_one_and_monitor_does_not_apply():
    s = make()
    s.enqueue({"type": "loadPreset", "id": "fig13"})
    s.enqueue({"type": "setAacMode", "mode": "off"})
    off = [s.step_control() for _ in range(500)]
    assert all(t["kT_pitch"] == 1.0 and t["kTApplied_roll"] == 1.0 for t in off)
    s.enqueue({"type": "setAacMode", "mode": "monitor"})
    mon = [s.step_control() for _ in range(500)]
    assert all(t["kTApplied_pitch"] == 1.0 and t["kTApplied_roll"] == 1.0 for t in mon)
    assert any(t["ySD_pitch"] > 0 for t in mon)


def test_null_aac_params_require_explicit_override():
    untuned = replace(P, aac=replace(P.aac, a0=None, b_s=None, threshold=None))
    with pytest.raises(ValueError, match="not tuned"):
        Sim(untuned)


def test_cli_vb_130s_under_120s(tmp_path):
    out = tmp_path / "vb.png"
    t0 = time.perf_counter()
    r = subprocess.run(
        [sys.executable, "-m", "slosh.run", "--preset", "vb", "--out", str(out)],
        capture_output=True,
        text=True,
        check=False,
    )
    wall = time.perf_counter() - t0
    assert r.returncode == 0, r.stderr
    assert "130.0 s simulated" in r.stdout
    assert wall < 120.0
    assert out.stat().st_size > 10_000
    assert out.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
