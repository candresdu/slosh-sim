"""Two-loop PD controller, altitude/yaw hold, saturations, latency and noise.

Plain scalar floats, ``math`` only. Runs once per control tick (100 Hz, zero-order hold).
Frames: world NED, body FRD. ``x`` is north (pitch channel), ``y`` is east (roll channel) after
rotating the position error into the yaw-aligned frame.

Outer loop (per axis)::

    e = ref - pos,  e_dot = -vel                       # yaw-aligned frame
    u_a = kT_a * gs * (Kp_pos e_a + Kd_pos e_dot_a)    # commanded lateral accel [m/s^2]
    pitch_c = clamp(-u_x / g, +-attMax)                # +x error -> nose down
    roll_c  = clamp(+u_y / g, +-attMax)

``u_a`` is exposed in :class:`CtrlOut` (after K_T and gain shift, before saturation) for the AAC.

Inner loop::

    tau_x = J_xx (Kp_att (roll_c - roll)  - Kd_att p)
    tau_y = J_yy (Kp_att (pitch_c - pitch) - Kd_att q)

Altitude (NED, ``e_z = ref_d - pd``, "down" positive)::

    f = m_T (g - Kp_z e_z - Kd_z e_z_dot) / (cos roll cos pitch),  clamped to the mixer limits

Yaw: ``tau_z = J_zz (Kp_yaw (yaw_ref - yaw) - Kd_yaw r)``.

Measurement path: optional Gaussian noise (``sensing.noise``, seeded :class:`~slosh.core.rng.Rng`,
only when enabled), then an optional delay of ``round(latencyMs / tick)`` whole ticks through a
FIFO. Until the FIFO is filled the oldest available measurement is used.
"""

from __future__ import annotations

import math
from collections import deque
from collections.abc import Sequence
from typing import NamedTuple

from ..params import Params
from .dynamics import Hold
from .mixer import mix, motor_saturated
from .rng import Rng


class Meas(NamedTuple):
    """Raw measurement from the plant state: NED position/velocity, attitude quaternion, rates."""

    pos: tuple[float, float, float]
    vel: tuple[float, float, float]
    q: tuple[float, float, float, float]  # (w, x, y, z) body -> NED
    w_b: tuple[float, float, float]  # body rates FRD [rad/s]


class Ref(NamedTuple):
    """Position reference in NED [m] and yaw reference [rad]."""

    pos: tuple[float, float, float] = (0.0, 0.0, 0.0)
    yaw: float = 0.0


class Sensed(NamedTuple):
    """What the control law actually sees (Euler angles, after optional noise and latency)."""

    pos: tuple[float, float, float]
    vel: tuple[float, float, float]
    roll: float
    pitch: float
    yaw: float
    rates: tuple[float, float, float]


class CtrlOut(NamedTuple):
    """Controller output for one tick."""

    u: tuple[float, float]  # (u_x, u_y) lateral accel command [m/s^2], after kT*gs, pre-saturation
    pitch_c: float
    roll_c: float
    f: float  # total thrust [N]
    tau: tuple[float, float, float]  # body torque command [N m]
    omega_cmd: tuple[float, float, float, float]  # rotor speed commands [rad/s]
    sensed: Sensed  # measurement used this tick (after noise/latency)
    sat_att: bool = False  # debug only: an attitude command was clamped at +-attMax
    sat_motor: bool = False  # debug only: a motor command was clamped at omegaMin/omegaMax

    @property
    def hold(self) -> Hold:
        """Zero-order-held plant input."""
        return Hold(tau=self.tau, omega_cmd=self.omega_cmd)


def meas_from_state(x: Sequence[float]) -> Meas:
    """Extract a :class:`Meas` from the 23-element plant state."""
    return Meas(
        pos=(x[0], x[1], x[2]),
        vel=(x[3], x[4], x[5]),
        q=(x[6], x[7], x[8], x[9]),
        w_b=(x[10], x[11], x[12]),
    )


def euler_zyx(q: Sequence[float]) -> tuple[float, float, float]:
    """ZYX Euler angles ``(roll, pitch, yaw)`` from a quaternion ``(w, x, y, z)``."""
    w, x, y, z = q
    roll = math.atan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y))
    s = max(-1.0, min(1.0, 2.0 * (w * y - z * x)))
    pitch = math.asin(s)
    yaw = math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))
    return roll, pitch, yaw


def _clamp(v: float, lim: float) -> float:
    return max(-lim, min(lim, v))


class Controller:
    """Stateful 100 Hz controller (state = measurement FIFO and the noise RNG)."""

    def __init__(self, p: Params, seed: int | None = None) -> None:
        c = p.control
        gains = (c.inner, c.outer, c.alt, c.yaw)
        if any(g.Kp is None or g.Kd is None for g in gains):
            raise ValueError("control gains are not set in the parameter file")
        self.p = p
        self.kp_att, self.kd_att = c.inner.Kp, c.inner.Kd
        self.kp_pos, self.kd_pos = c.outer.Kp, c.outer.Kd
        self.kp_z, self.kd_z = c.alt.Kp, c.alt.Kd
        self.kp_yaw, self.kd_yaw = c.yaw.Kp, c.yaw.Kd
        self.m_T = p.vehicle.m_q + p.pendulum.m_p
        k_f = p.vehicle.k_f
        self.f_min = 4.0 * k_f * p.motor.omegaMin**2
        self.f_max = 4.0 * k_f * p.motor.omegaMax**2
        tick = p.sim.controlDecimation * p.sim.dt
        self.delay_ticks = max(0, round(p.sensing.latencyMs * 1e-3 / tick))
        self.noise = p.sensing.noise
        self.rng = Rng(p.sim.seed if seed is None else seed)
        self._fifo: deque[Sensed] = deque(maxlen=self.delay_ticks + 1)

    def reset(self, seed: int | None = None) -> None:
        """Clear the measurement FIFO and re-seed the noise RNG."""
        self._fifo.clear()
        self.rng = Rng(self.p.sim.seed if seed is None else seed)

    # -- measurement path ------------------------------------------------------------------
    def _sense(self, meas: Meas) -> Sensed:
        roll, pitch, yaw = euler_zyx(meas.q)
        pos, vel, rates = meas.pos, meas.vel, meas.w_b
        n = self.noise
        if n.enabled:
            r = self.rng.normal
            pos = (pos[0] + n.pos * r(), pos[1] + n.pos * r(), pos[2] + n.pos * r())
            vel = (vel[0] + n.rate * r(), vel[1] + n.rate * r(), vel[2] + n.rate * r())
            roll += n.att * r()
            pitch += n.att * r()
            yaw += n.att * r()
            rates = (rates[0] + n.rate * r(), rates[1] + n.rate * r(), rates[2] + n.rate * r())
        return Sensed(pos, vel, roll, pitch, yaw, rates)

    def _delayed(self, s: Sensed) -> Sensed:
        self._fifo.append(s)
        return self._fifo[0]  # oldest of the last delay_ticks + 1 samples

    # -- control law -----------------------------------------------------------------------
    def step(
        self,
        meas: Meas,
        ref: Ref,
        gs: float,
        kT_applied: tuple[float, float] = (1.0, 1.0),
    ) -> CtrlOut:
        """One control tick. ``kT_applied = (pitch/x, roll/y)`` forward-loop gains."""
        g = self.p.sim.g
        att_max = self.p.control.attMax
        s = self._delayed(self._sense(meas))
        roll, pitch, yaw = s.roll, s.pitch, s.yaw

        # outer loop, yaw-aligned frame
        e_n, e_e = ref.pos[0] - s.pos[0], ref.pos[1] - s.pos[1]
        ed_n, ed_e = -s.vel[0], -s.vel[1]
        cy, sy = math.cos(yaw), math.sin(yaw)
        e_x, e_y = cy * e_n + sy * e_e, -sy * e_n + cy * e_e
        ed_x, ed_y = cy * ed_n + sy * ed_e, -sy * ed_n + cy * ed_e
        u_x = kT_applied[0] * gs * (self.kp_pos * e_x + self.kd_pos * ed_x)
        u_y = kT_applied[1] * gs * (self.kp_pos * e_y + self.kd_pos * ed_y)
        pitch_c = _clamp(-u_x / g, att_max)
        roll_c = _clamp(u_y / g, att_max)
        sat_att = abs(u_x / g) > att_max or abs(u_y / g) > att_max

        # inner loop
        jx, jy, jz = self.p.vehicle.J
        tau_x = jx * (self.kp_att * (roll_c - roll) - self.kd_att * s.rates[0])
        tau_y = jy * (self.kp_att * (pitch_c - pitch) - self.kd_att * s.rates[1])

        # yaw hold
        tau_z = jz * (self.kp_yaw * (ref.yaw - yaw) - self.kd_yaw * s.rates[2])

        # altitude hold (NED: down positive)
        e_z = ref.pos[2] - s.pos[2]
        ed_z = -s.vel[2]
        tilt = max(math.cos(roll) * math.cos(pitch), 0.5)
        f = self.m_T * (g - self.kp_z * e_z - self.kd_z * ed_z) / tilt
        f_clamped = f < self.f_min or f > self.f_max
        f = min(max(f, self.f_min), self.f_max)

        omega_cmd = mix(f, tau_x, tau_y, tau_z, self.p)
        return CtrlOut(
            u=(u_x, u_y),
            pitch_c=pitch_c,
            roll_c=roll_c,
            f=f,
            tau=(tau_x, tau_y, tau_z),
            omega_cmd=omega_cmd,
            sensed=s,
            sat_att=sat_att,
            sat_motor=f_clamped or motor_saturated(f, tau_x, tau_y, tau_z, self.p),
        )
