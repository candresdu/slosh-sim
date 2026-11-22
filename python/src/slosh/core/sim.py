"""Simulation orchestrator: command queue, preset scheduling and one 10 ms control tick.

Plain scalar floats, ``math`` only; the TypeScript ``Sim`` mirrors this file.

One call of :meth:`Sim.step_control` advances exactly ``controlDecimation`` RK4 substeps
(10 x 1 ms), in this order (the TS core must use the same order):

1. **Commands.** Apply, in order, the commands enqueued since the last tick, then the preset
   events scheduled for this tick. Every applied command is logged as ``(tick, cmd)`` where
   ``tick`` is the index of the tick about to run. A command enqueued between two calls
   therefore takes effect at the start of the next tick, never inside one.
2. **Gain-shift ramp.** If a ramp is active, ``gs`` is advanced by one linear step.
3. **AAC (per axis), from the previous tick's ``u``.** ``Aac.step(u_prev, e_ref, mode)`` for
   pitch (x) and roll (y). ``u_prev`` is the controller's lateral command of the previous tick
   (0 on the first tick after start/reset); ``e_ref`` is the true position error rotated into the
   yaw-aligned frame at the start of this tick. Using the previous ``u`` (a one-tick delay inside
   the AAC loop) keeps the controller call single, so its measurement FIFO and noise RNG advance
   exactly once per tick.
4. **Controller** with ``kT_applied`` from step 3 and the current gain shift.
5. **Mixer** (inside the controller) gives the rotor speed commands, held for the whole tick.
6. **Plant.** ``controlDecimation`` RK4 substeps.

Telemetry is sampled at the end of the tick: plant state after the substeps, ``t`` = time after
the tick, AAC outputs and gain shift as used during the tick.

Time. ``tick`` counts control ticks since construction and never resets (replay key). ``t`` counts
from the last reset or preset load: ``t = (tick - t_origin) * dt_ctrl``.

Commands (dicts with a ``type`` key)::

    setGainShift   value                  clamped to [0.5, 3.0]; cancels a running ramp
    rampGainShift  to, durationS          linear, one step per tick, reaches ``to`` after durationS
    setAacMode     mode                   'off' | 'monitor' | 'engaged'; no ramp: 'engaged' applies
                                          the current K_T as an immediate step
    kick           theta=0.2, phiDot=0.6  n and w_p from (theta, 0, current phi, phiDot)
    clearSchedule  -                      drop pending scheduled preset events; state, gain shift,
                                          mode and a ramp already running are untouched (runtime
                                          only, not allowed in preset events)
    loadPreset     id                     reset, then load the preset's initial state and events
    reset          -                      restore the active preset (or the defaults)
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

from ..params import Params
from ..presets import Preset, load_preset
from .aac import Aac, AacOut
from .controller import Controller, CtrlOut, Meas, Ref, euler_zyx, meas_from_state
from .dynamics import mass_relative, theta_phi
from .initial import initial_state, pendulum_vectors
from .rk4 import rk4_step

GS_MIN = 0.5
GS_MAX = 3.0
KICK_THETA = 0.2
KICK_PHI_DOT = 0.6
COMMAND_TYPES = (
    "setGainShift",
    "rampGainShift",
    "setAacMode",
    "kick",
    "clearSchedule",
    "loadPreset",
    "reset",
)
AAC_MODES = ("off", "monitor", "engaged")


def clamp_gain_shift(v: float) -> float:
    return min(GS_MAX, max(GS_MIN, float(v)))


class Sim:
    """Closed-loop quad + hanging pendulum + controller + AAC, stepped at the control rate."""

    def __init__(
        self,
        params: Params,
        seed: int | None = None,
        aac_overrides: Mapping[str, float] | None = None,
    ) -> None:
        """``aac_overrides`` may set ``a0``, ``b_s``, ``b_e``, ``threshold``: explicit values for
        AAC parameters that are still ``None`` in the parameter file."""
        self.p = params
        self.seed = params.sim.seed if seed is None else seed
        self.aac_overrides = dict(aac_overrides or {})
        self.dt = params.sim.dt
        self.substeps = params.sim.controlDecimation
        self.dt_ctrl = self.substeps * self.dt
        self.ctrl = Controller(params, self.seed)
        self.aac = (Aac(params, **self.aac_overrides), Aac(params, **self.aac_overrides))
        self.ref = Ref()
        self.omega_min = params.motor.omegaMin
        self.omega_span = params.motor.omegaMax - params.motor.omegaMin

        self.tick = 0
        self.log: list[tuple[int, dict[str, Any]]] = []
        self._queue: list[dict[str, Any]] = []
        self._scheduled: list[tuple[int, dict[str, Any]]] = []  # (absolute tick, cmd)
        self._preset: Preset | None = None
        self._t_origin = 0
        self._ramp: tuple[float, float, int, int] | None = None  # (gs0, to, n_ticks, start_tick)
        self.state: list[float] = []
        self.gs = 1.0
        self.mode = "off"
        self._u_prev: tuple[float, float] = (0.0, 0.0)
        self._restore()

    # -- public API ------------------------------------------------------------------------
    @property
    def t(self) -> float:
        """Simulation time since the last reset / preset load [s]."""
        return (self.tick - self._t_origin) * self.dt_ctrl

    def enqueue(self, cmd: Mapping[str, Any]) -> None:
        """Queue a command; it is applied at the start of the next :meth:`step_control`."""
        c = dict(cmd)
        kind = c.get("type")
        if kind not in COMMAND_TYPES:
            raise ValueError(f"unknown command type {kind!r}")
        if kind == "setAacMode" and c.get("mode") not in AAC_MODES:
            raise ValueError(f"unknown AAC mode {c.get('mode')!r}")
        self._queue.append(c)

    def step_control(self) -> dict[str, Any]:
        """Advance one control tick (10 ms) and return its telemetry."""
        self.apply_commands()
        self._advance_ramp()

        x = self.state
        meas = meas_from_state(x)
        e_x, e_y = self._ref_error(meas)
        a_p = self.aac[0].step(self._u_prev[0], e_x, self.mode)
        a_r = self.aac[1].step(self._u_prev[1], e_y, self.mode)
        out = self.ctrl.step(meas, self.ref, self.gs, (a_p.kT_applied, a_r.kT_applied))
        self._u_prev = out.u

        hold = out.hold
        for _ in range(self.substeps):
            x = rk4_step(x, self.dt, hold, self.p)
        self.state = x
        self.tick += 1
        return self._telemetry(out, a_p, a_r)

    # -- commands --------------------------------------------------------------------------
    def apply_commands(self) -> None:
        """Apply queued then scheduled commands (step 1 of a tick; public for tests)."""
        pending, self._queue = self._queue, []
        for cmd in pending:
            self._apply(cmd)
        # scheduled events due now (re-checked here: a loadPreset above may schedule t = 0 events)
        while self._scheduled and self._scheduled[0][0] <= self.tick:
            _, cmd = self._scheduled.pop(0)
            self._apply(cmd)

    def _apply(self, cmd: dict[str, Any]) -> None:
        self.log.append((self.tick, dict(cmd)))
        kind = cmd["type"]
        if kind == "setGainShift":
            self.gs = clamp_gain_shift(cmd["value"])
            self._ramp = None
        elif kind == "rampGainShift":
            n = round(float(cmd["durationS"]) / self.dt_ctrl)
            to = clamp_gain_shift(cmd["to"])
            if n <= 0:
                self.gs = to
                self._ramp = None
            else:
                self._ramp = (self.gs, to, n, self.tick)
        elif kind == "setAacMode":
            self.mode = cmd["mode"]
        elif kind == "kick":
            self._kick(float(cmd.get("theta", KICK_THETA)), float(cmd.get("phiDot", KICK_PHI_DOT)))
        elif kind == "clearSchedule":
            self._scheduled = []
        elif kind == "loadPreset":
            self._preset = load_preset(cmd["id"])
            self._restore()
        elif kind == "reset":
            self._restore()
        else:  # pragma: no cover - enqueue() validates
            raise ValueError(f"unknown command type {kind!r}")

    def _kick(self, theta: float, phi_dot: float) -> None:
        """Set ``n`` and ``w_p`` from ``(theta, 0, current phi, phi_dot)``; rest of state kept."""
        x = list(self.state)
        phi = math.atan2(x[14], x[13])
        n, w = pendulum_vectors(theta, 0.0, phi, phi_dot)
        x[13:16] = n
        x[16:19] = w
        self.state = x

    def _advance_ramp(self) -> None:
        if self._ramp is None:
            return
        gs0, to, n, start = self._ramp
        k = self.tick - start + 1  # first tick after activation takes step 1 of n
        if k >= n:
            self.gs = to
            self._ramp = None
        else:
            self.gs = gs0 + (to - gs0) * (k / n)

    # -- (re)initialisation ----------------------------------------------------------------
    def _restore(self) -> None:
        """Reset plant, controller, AAC, gain shift and schedule; apply the active preset."""
        self.ctrl.reset(self.seed)
        for a in self.aac:
            a.reset()
        self.ref = Ref()
        self._ramp = None
        self._scheduled = []
        self._u_prev = (0.0, 0.0)
        self._t_origin = self.tick
        pre = self._preset
        if pre is None:
            self.state = initial_state(self.p)
            self.gs = 1.0
            self.mode = "off"
            return
        i = pre.initial
        self.state = initial_state(self.p, i.theta, i.thetaDot, i.phi, i.phiDot)
        self.gs = clamp_gain_shift(i.gainShift)
        self.mode = i.aacMode
        for ev in pre.events:
            cmd = {k: v for k, v in ev.items() if k != "t"}
            self._scheduled.append((self.tick + round(float(ev["t"]) / self.dt_ctrl), cmd))
        self._scheduled.sort(key=lambda s: s[0])  # stable: preset order kept for equal ticks

    # -- helpers ---------------------------------------------------------------------------
    def _ref_error(self, meas: Meas) -> tuple[float, float]:
        """True position error in the yaw-aligned frame (input to the AAC reference-error path)."""
        yaw = euler_zyx(meas.q)[2]
        en, ee = self.ref.pos[0] - meas.pos[0], self.ref.pos[1] - meas.pos[1]
        cy, sy = math.cos(yaw), math.sin(yaw)
        return cy * en + sy * ee, -sy * en + cy * ee

    def _telemetry(self, out: CtrlOut, a_p: AacOut, a_r: AacOut) -> dict[str, Any]:
        x = self.state
        theta, phi = theta_phi(x)
        mx, my, mz = mass_relative(x, self.p.pendulum.L)
        roll, pitch, yaw = euler_zyx(x[6:10])
        tel: dict[str, Any] = {
            "t": self.t,
            "theta": theta,
            "phi": phi,
            "mx": mx,
            "my": my,
            "mz": mz,
            "x": x[0],
            "y": x[1],
            "z": x[2],
            "roll": roll,
            "pitch": pitch,
            "yaw": yaw,
            "kT_pitch": a_p.kT,
            "kT_roll": a_r.kT,
            "kTApplied_pitch": a_p.kT_applied,
            "kTApplied_roll": a_r.kT_applied,
            "ySD_pitch": a_p.ySD,
            "ySD_roll": a_r.ySD,
            "detect_pitch": a_p.detect,
            "detect_roll": a_r.detect,
            "gainShift": self.gs,
            "aacMode": self.mode,
        }
        for i, c in enumerate(out.omega_cmd):
            tel[f"m{i + 1}"] = (c - self.omega_min) / self.omega_span
        for i in range(4):
            tel[f"w{i + 1}"] = x[19 + i]
        # debug only: not golden columns, not part of the TS Telemetry
        tel["sat_att"] = out.sat_att
        tel["sat_motor"] = out.sat_motor
        return tel
