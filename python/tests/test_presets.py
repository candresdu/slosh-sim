"""Preset behaviour of the Python reference model with the tuned AAC (Figs 12-14, section V.B).

Reproduction is qualitative, for teaching. theta envelope = 2 s sliding max of theta.
The Fig 12 criterion is the one task #18 closed with (``reports/instability.md``, 'Deviation from
R-1'): outcome A (envelope < 0.05 rad within 30 s) or the outcome B fallback (envelope decreasing
and a positive linear GS 1 slosh-mode decay rate). The measured numbers and the reasons for the
expected failures are in ``reports/aac_tuning.md``.
"""

from __future__ import annotations

from typing import Any

import pytest

from slosh.core.sim import Sim
from slosh.instability import envelope, slosh_rate_gs1
from slosh.params import load_params
from slosh.presets import load_preset
from slosh.story import env_at, ln_slope, run_story, story_times
from slosh.story import first_trip as story_first_trip

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

DT = 0.01
THETA_DANGER = 0.25


def run(preset: str, duration: float, mode: str | None = None) -> list[dict[str, Any]]:
    """Run a preset with the committed (tuned) parameters; ``mode`` overrides its AAC mode."""
    sim = Sim(load_params())
    sim.enqueue({"type": "loadPreset", "id": preset})
    if mode is not None:
        sim.enqueue({"type": "setAacMode", "mode": mode})
    return [sim.step_control() for _ in range(round(duration / DT))]


def env_of(tel: list[dict[str, Any]]) -> list[float]:
    return list(envelope([s["theta"] for s in tel], DT))


def at(env: list[float], t: float) -> float:
    return env[round(t / DT) - 1]


def rms(v: list[float]) -> float:
    return (sum(a * a for a in v) / len(v)) ** 0.5


def window(tel: list[dict[str, Any]], a: float, b: float) -> list[dict[str, Any]]:
    return [s for s in tel if a < s["t"] <= b + 1e-9]


def detect_any(s: dict[str, Any]) -> bool:
    return bool(s["detect_pitch"] or s["detect_roll"])


def first_detect(tel: list[dict[str, Any]]) -> float | None:
    return next((s["t"] for s in tel if detect_any(s)), None)


@pytest.fixture(scope="module")
def fig12() -> list[dict[str, Any]]:
    return run("fig12", 60.0)


@pytest.fixture(scope="module")
def fig12_monitor() -> list[dict[str, Any]]:
    return run("fig12", 60.0, mode="monitor")


@pytest.fixture(scope="module")
def fig13() -> list[dict[str, Any]]:
    return run("fig13", 60.0)


@pytest.fixture(scope="module")
def fig13_off() -> list[dict[str, Any]]:
    """The fig13 preset forced to AAC Off, to show Monitor does not change the motion."""
    return run("fig13", 60.0, mode="off")


@pytest.fixture(scope="module")
def fig14() -> list[dict[str, Any]]:
    return run("fig14", 60.0)


@pytest.fixture(scope="module")
def vb() -> list[dict[str, Any]]:
    return run("vb", 130.0)


# -- Fig 12 ---------------------------------------------------------------------------------------
def test_fig12_envelope_criterion(fig12) -> None:
    """Outcome A (< 0.05 rad within 30 s) or the outcome B fallback from #18."""
    env = env_of(fig12)
    outcome_a = at(env, 30.0) < 0.05
    outcome_b = at(env, 60.0) < at(env, 30.0) < at(env, 10.0) and slosh_rate_gs1(load_params()) > 0
    assert outcome_a or outcome_b, (at(env, 10.0), at(env, 30.0), at(env, 60.0))


def test_fig12_detector_never_trips(fig12, fig12_monitor) -> None:
    """Neither with the AAC off (detector hidden) nor with a Monitor-mode detector."""
    assert not any(detect_any(s) for s in fig12)
    assert not any(detect_any(s) for s in fig12_monitor)


# -- Fig 13 (AAC Monitor; same motion as Off) ----------------------------------------------------
def test_fig13_grows_and_does_not_recover(fig13) -> None:
    env = env_of(fig13)
    assert at(env, 60.0) > at(env, 10.0)
    lo, hi = round(10.0 / DT) - 1, round(60.0 / DT)
    assert min(env[lo:hi]) >= 0.2


def test_fig13_plateau_only_from_saturation(fig13) -> None:
    env = env_of(fig13)
    if at(env, 60.0) < 1.05 * at(env, 50.0):
        for a in range(50, 60, 2):
            w = window(fig13, a, a + 2)
            assert any(s["sat_att"] or s["sat_motor"] for s in w), (a, a + 2)


def test_fig13_x_to_y_migration(fig13) -> None:
    early, late = window(fig13, 0.0, 5.0), window(fig13, 50.0, 60.0)
    assert rms([s["mx"] for s in early]) > rms([s["my"] for s in early])
    assert rms([s["my"] for s in late]) > rms([s["mx"] for s in late])


def test_fig13_detector_trips_before_envelope_025(fig13) -> None:
    """The shipped preset runs in Monitor, so the detector is visible and trips early."""
    env = env_of(fig13)
    t025 = next(s["t"] for s, e in zip(fig13, env, strict=True) if e > THETA_DANGER)
    t_trip = first_detect(fig13)
    assert t_trip is not None and t_trip < t025, (t_trip, t025)


def test_fig13_monitor_motion_identical_to_off(fig13, fig13_off) -> None:
    """Monitor computes K_T and y_SD but does not apply K_T: theta equals the Off run exactly."""
    assert [s["theta"] for s in fig13] == [s["theta"] for s in fig13_off]
    assert not any(detect_any(s) for s in fig13_off)  # AAC off: detector hidden


# -- Fig 14 (AAC engaged) -------------------------------------------------------------------------
def _kt(tel: list[dict[str, Any]]) -> tuple[list[float], list[float]]:
    return [s["kT_pitch"] for s in tel], [s["kT_roll"] for s in tel]


def test_fig14_kt_drops_on_both_axes(fig14) -> None:
    kp, kr = _kt(fig14)
    assert min(kp) < 1.0 and min(kr) < 1.0


def test_fig14_pitch_dips_lower_than_roll(fig14) -> None:
    kp, kr = _kt(fig14)
    assert min(kp) < min(kr)


def test_fig14_kt_recovers_toward_one(fig14) -> None:
    for k in _kt(fig14):
        lo = min(k)
        assert k[-1] >= lo + 0.25 * (1.0 - lo), (lo, k[-1])


def test_fig14_theta_stays_bounded(fig14) -> None:
    assert max(s["theta"] for s in fig14) <= 0.205


# -- Section V.B ----------------------------------------------------------------------------------
def test_vb_slosh_grows_before_engagement(vb) -> None:
    env = env_of(vb)
    assert max(env[: round(100.0 / DT)]) >= 0.35


def test_vb_detector_trips_before_theta_025(vb) -> None:
    t025 = next(s["t"] for s in vb if s["theta"] > THETA_DANGER)
    t_trip = first_detect(vb)
    assert t_trip is not None and t_trip < t025, (t_trip, t025)


@pytest.mark.xfail(
    reason=(
        "expected limitation: the V.B envelope falls from 0.37 rad to only 0.327 rad 15 s after "
        "engagement and reaches 0.087 rad 164.9 s after it (reports/aac_tuning.md). PD-only gains "
        "change the slosh decay rate by about 0.03-0.045 1/s per unit of GS, below the 0.09 1/s "
        "needed for ln 4 in 15 s, and recovery starts from a saturation-limited amplitude"
    ),
    strict=False,
)
def test_vb_recovers_within_15_s_of_engagement(vb) -> None:
    env = env_of(vb)
    assert at(env, 115.0) < 0.087, at(env, 115.0)


# -- Story (Nominal -> Gain shift -> AAC engaged) -------------------------------------------------
@pytest.fixture(scope="module")
def story() -> list[dict[str, Any]]:
    return run_story()


def test_preset_story(story) -> None:
    """Detector catches the shift; growth stops at engagement and the envelope then decays.

    The post-engage criterion is the relaxed one (reports/aac_tuning.md, 'Known deviations'): the
    model's slosh decay is slow, so 'below 0.1 rad within 20 s' can't be met.
    """
    st = story_times()
    assert 30.0 <= st.duration - st.t_engage <= 60.0
    env = env_of(story)
    e_shift, e_eng = env_at(env, st.t_shift), env_at(env, st.t_engage)

    # detection: trips within 10 s of the shift, and not before it (Off, then Monitor)
    t_trip = story_first_trip(story)
    assert t_trip is not None and st.t_shift < t_trip <= st.t_shift + 10.0, t_trip
    assert not any(detect_any(s) for s in window(story, 0.0, st.t_shift))

    # the slosh has grown by the time of engagement, from a moderate amplitude
    assert e_eng > e_shift, (e_shift, e_eng)
    assert e_eng <= 0.35, e_eng

    # (a) growth stops, (b) positive decay rate, (c) visible decay
    after = env[round(st.t_engage / DT) - 1 :]
    assert max(after) <= 1.1 * e_eng, (max(after), e_eng)
    assert ln_slope(env, st.t_engage + 5.0) < 0.0
    assert env[-1] <= 0.9 * e_eng, (env[-1], e_eng)

    # regime bookkeeping seen in the telemetry
    assert at_tel(story, st.t_shift - 0.5)["aacMode"] == "off"
    assert at_tel(story, st.t_shift + 2.0)["aacMode"] == "monitor"
    assert at_tel(story, st.t_shift + 2.0)["gainShift"] == pytest.approx(2.3)
    assert at_tel(story, st.t_engage + 0.5)["aacMode"] == "engaged"
    assert at_tel(story, st.t_engage + 0.5)["gainShift"] == pytest.approx(2.3)


def at_tel(tel: list[dict[str, Any]], t: float) -> dict[str, Any]:
    return tel[round(t / DT) - 1]


def test_story_preset_file() -> None:
    pre = load_preset("story")
    i = pre.initial
    assert (i.theta, i.thetaDot, i.phi, i.phiDot, i.gainShift, i.aacMode) == (
        0.2, 0.0, 0.0, 0.6, 1.0, "off",
    )  # fmt: skip
    ramp = next(e for e in pre.events if e["type"] == "rampGainShift")
    assert ramp["to"] == 2.3 and ramp["durationS"] == 1.5
    assert all("rampS" not in e and e["type"] != "clearSchedule" for e in pre.events)
    assert load_params().aac.engageRampS == 0.0


def test_clear_schedule_after_load_preset() -> None:
    """loadPreset and clearSchedule in the same tick leave no scheduled events."""
    sim = Sim(load_params())
    sim.enqueue({"type": "loadPreset", "id": "story"})
    sim.enqueue({"type": "clearSchedule"})
    sim.apply_commands()
    assert sim._scheduled == []
    assert [c["type"] for _, c in sim.log] == ["loadPreset", "clearSchedule"]
    tel = [sim.step_control() for _ in range(round(30.0 / DT))]
    assert tel[-1]["aacMode"] == "off" and tel[-1]["gainShift"] == 1.0


def test_clear_schedule() -> None:
    """clearSchedule mid-story cancels the remaining events and changes nothing else."""
    st = story_times()
    n = round((st.t_shift + 0.5) / DT)  # inside the gain-shift ramp, before the engage event
    ref = Sim(load_params())
    ref.enqueue({"type": "loadPreset", "id": "story"})
    cut = Sim(load_params())
    cut.enqueue({"type": "loadPreset", "id": "story"})
    for _ in range(n):
        ref.step_control()
        cut.step_control()
    assert cut.mode == "monitor" and 1.0 < cut.gs < 2.3
    assert cut._scheduled  # the engage event is still pending
    state_before, gs_before, mode_before = list(cut.state), cut.gs, cut.mode
    cut.enqueue({"type": "clearSchedule"})
    cut.apply_commands()
    assert cut._scheduled == []
    assert (cut.state, cut.gs, cut.mode) == (state_before, gs_before, mode_before)
    assert cut.log[-1] == (n, {"type": "clearSchedule"})

    # the ramp in progress still completes; the engage event never fires; the motion up to
    # the cut is unchanged and the state stays continuous
    tel_cut = [cut.step_control() for _ in range(round((st.t_engage + 10.0) / DT) - n)]
    tel_ref = [ref.step_control() for _ in range(round((st.t_engage + 10.0) / DT) - n)]
    assert tel_cut[-1]["gainShift"] == 2.3 and tel_cut[-1]["aacMode"] == "monitor"
    assert tel_ref[-1]["aacMode"] == "engaged"
    assert tel_cut[0]["theta"] == tel_ref[0]["theta"]  # bit-identical on the first tick after cut
