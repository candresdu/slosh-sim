"""Linearization of the closed-loop testbed about hover (SciPy / python-control; offline only).

The *nonlinear* reference model (:mod:`slosh.core`) is linearized numerically with central
differences, so the analysis uses exactly the dynamics, motor lag, mixer and inner PD loop that
the simulator runs. Nothing is re-derived by hand except where noted.

Construction (``hover_linearization``):

1. ``A_c = d deriv / d x`` and ``B_c = d deriv / d hold`` at the hover trim (``hold`` = body torque
   and rotor commands, 7 inputs). The plant is discretized with a zero-order hold at the control
   rate via ``control.c2d(..., 'zoh')`` (``Phi``, ``Gamma``), which includes the sample-and-hold.
2. The 100 Hz controller is linearized the same way: ``K = d hold / d x`` and
   ``K_u = d hold / d u`` where ``u = (u_x, u_y)`` is the lateral acceleration command.
3. Closed discrete model: ``x[k+1] = (Phi + Gamma K) x[k] + Gamma K_u u[k]``.

**Loop breaking.** The outer loop is broken at ``u_a`` (the output of the outer PD, after
``K_T * GS``). To get ``u`` as a free input the production
:class:`~slosh.core.controller.Controller` is built with outer gains ``Kp = 1``, ``Kd = 0``
and called with the reference ``pos + u``, so its
position error equals ``u`` and ``u_x = u``. Every other part of the controller (attitude command
``-u_x/g`` and ``+u_y/g``, inner PD, mixer, altitude and yaw hold) is the real code. Latency and
noise are ignored (they are optional realism settings).

The loop transfer function at gain shift ``GS`` is
``L(z) = GS * (Kp_pos pos + Kd_pos vel)(z) / u(z)``;
the closed loop is ``1 + L = 0``. The pitch channel is the x (north) axis, the roll channel is the y
(east) axis.

**Axis subsystems.** At hover the x and y channels decouple (first order), as do altitude and yaw.
Each axis is extracted with an orthonormal basis ``T`` (6 selected states plus the matching rotor
combination = 7 states) and the invariance of that subspace is checked and stored
(``AxisModel.invariance_error``).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace

import control
import numpy as np

from ..core.controller import Controller, Meas, Ref, meas_from_state
from ..core.dynamics import Hold, deriv, thrust_force_ned
from ..core.initial import initial_state
from ..core.mixer import S_PITCH, S_ROLL
from ..core.state import NX
from ..params import Gains, Params, load_params

H_STATE = 1e-5  # central-difference step for states [rad, m, ...]
H_MOTOR = 1e-3  # step for rotor speeds [rad/s]
H_INPUT = 1e-5

N_HOLD = 7  # tau_x, tau_y, tau_z, omega_cmd[4]


@dataclass(frozen=True)
class AxisSpec:
    """State indices and signs of one lateral channel."""

    name: str  # "x" (pitch) or "y" (roll)
    pos: int  # quad position index
    vel: int  # quad velocity index
    quat: int  # quaternion vector component (att ~ 2 q)
    rate: int  # body rate index
    n: int  # unit-vector component moved by the channel
    wp: int  # pendulum angular-velocity component driving it
    motor_signs: tuple[float, ...]  # mixer sign row for the attitude combination
    att_sign: float  # attitude command = att_sign * u / g
    u_index: int  # 0 for x, 1 for y


AXES: dict[str, AxisSpec] = {
    "x": AxisSpec("x", 0, 3, 8, 11, 13, 17, S_PITCH, -1.0, 0),
    "y": AxisSpec("y", 1, 4, 7, 10, 14, 16, S_ROLL, +1.0, 1),
}


def _axis(axis: str) -> AxisSpec:
    try:
        return AXES[axis]
    except KeyError:
        raise ValueError(f"axis must be 'x' or 'y', got {axis!r}") from None


@dataclass(frozen=True)
class HoverLinearization:
    """Full 23-state closed-loop discrete model about hover."""

    x0: tuple[float, ...]
    hold0: tuple[float, ...]
    Ts: float
    A_c: np.ndarray  # 23x23 continuous plant
    B_c: np.ndarray  # 23x7 continuous plant, hold inputs
    K: np.ndarray  # 7x23 controller state gain
    K_u: np.ndarray  # 7x2 controller gain from u
    A_d: np.ndarray  # 23x23 closed-loop discrete (ZOH)
    B_d: np.ndarray  # 23x2 discrete, input u
    trim_residual: float  # max |deriv(x0, hold0)|


@dataclass(frozen=True)
class AxisModel:
    """7-state single-axis discrete model: input ``u`` [m/s^2], see :func:`axis_model`."""

    axis: str
    A: np.ndarray
    B: np.ndarray  # 7x1
    Ts: float
    labels: tuple[str, ...]
    C_pos: np.ndarray  # 1x7
    C_vel: np.ndarray
    C_att: np.ndarray  # attitude angle (~2 q)
    C_rate: np.ndarray
    invariance_error: float


def _linearization_params(p: Params) -> Params:
    """Parameters for linearization: no latency/noise; outer PD replaced by the unit injection."""
    sensing = replace(p.sensing, latencyMs=0.0, noise=replace(p.sensing.noise, enabled=False))
    return replace(p, sensing=sensing, control=replace(p.control, outer=Gains(Kp=1.0, Kd=0.0)))


def _hold_vector(h: Hold) -> np.ndarray:
    return np.array([*h.tau, *h.omega_cmd], dtype=float)


def _as_hold(v: np.ndarray) -> Hold:
    return Hold(tau=tuple(v[:3]), omega_cmd=tuple(v[3:]))


def _controller_hold(ctrl: Controller, x: list[float], u: tuple[float, float]) -> np.ndarray:
    """Held plant input for state ``x`` and lateral command ``u`` (reference = pos + u)."""
    m: Meas = meas_from_state(x)
    ref = Ref(pos=(x[0] + u[0], x[1] + u[1], 0.0), yaw=0.0)
    out = ctrl.step(m, ref, 1.0, (1.0, 1.0))
    return _hold_vector(out.hold)


def hover_linearization(p: Params | None = None) -> HoverLinearization:
    """Linearize the closed loop about hover (see module docstring)."""
    p = load_params() if p is None else p
    pl = _linearization_params(p)
    ctrl = Controller(pl)
    x0 = initial_state(pl)
    h0 = _controller_hold(ctrl, x0, (0.0, 0.0))
    Ts = pl.sim.controlDecimation * pl.sim.dt

    resid = float(np.max(np.abs(deriv(x0, _as_hold(h0), pl))))

    # continuous plant Jacobians
    A_c = np.zeros((NX, NX))
    for i in range(NX):
        h = H_MOTOR if i >= 19 else H_STATE
        xp, xm = list(x0), list(x0)
        xp[i] += h
        xm[i] -= h
        A_c[:, i] = (
            np.array(deriv(xp, _as_hold(h0), pl)) - np.array(deriv(xm, _as_hold(h0), pl))
        ) / (2.0 * h)
    B_c = np.zeros((NX, N_HOLD))
    for j in range(N_HOLD):
        h = H_MOTOR if j >= 3 else H_INPUT
        hp_, hm_ = h0.copy(), h0.copy()
        hp_[j] += h
        hm_[j] -= h
        B_c[:, j] = (
            np.array(deriv(list(x0), _as_hold(hp_), pl))
            - np.array(deriv(list(x0), _as_hold(hm_), pl))
        ) / (2.0 * h)

    # controller Jacobians
    K = np.zeros((N_HOLD, NX))
    for i in range(NX):
        h = H_MOTOR if i >= 19 else H_STATE
        xp, xm = list(x0), list(x0)
        xp[i] += h
        xm[i] -= h
        K[:, i] = (
            _controller_hold(ctrl, xp, (0.0, 0.0)) - _controller_hold(ctrl, xm, (0.0, 0.0))
        ) / (2.0 * h)
    K_u = np.zeros((N_HOLD, 2))
    for j in range(2):
        up, um = [0.0, 0.0], [0.0, 0.0]
        up[j], um[j] = H_INPUT, -H_INPUT
        K_u[:, j] = (
            _controller_hold(ctrl, list(x0), (up[0], up[1]))
            - _controller_hold(ctrl, list(x0), (um[0], um[1]))
        ) / (2.0 * H_INPUT)

    # ZOH discretization of the plant at the control rate, then close the sampled loop
    plant = control.ss(A_c, B_c, np.eye(NX), np.zeros((NX, N_HOLD)))
    plant_d = control.c2d(plant, Ts, method="zoh")
    Phi, Gamma = np.asarray(plant_d.A), np.asarray(plant_d.B)
    return HoverLinearization(
        x0=tuple(x0),
        hold0=tuple(float(v) for v in h0),
        Ts=Ts,
        A_c=A_c,
        B_c=B_c,
        K=K,
        K_u=K_u,
        A_d=Phi + Gamma @ K,
        B_d=Gamma @ K_u,
        trim_residual=resid,
    )


def tick_map_jacobian(p: Params | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Cross-check: Jacobians ``(A, B)`` of the exact one-tick map (controller + 10 RK4 steps).

    This is the nonlinear simulator step itself (no c2d), so it must agree with
    ``hover_linearization(p).A_d`` / ``B_d`` to within the RK4 error.
    """
    from ..core.rk4 import rk4_step

    p = load_params() if p is None else p
    pl = _linearization_params(p)
    ctrl = Controller(pl)
    x0 = initial_state(pl)

    def tick(x: list[float], u: tuple[float, float]) -> np.ndarray:
        hold = _as_hold(_controller_hold(ctrl, x, u))
        y = list(x)
        for _ in range(pl.sim.controlDecimation):
            y = rk4_step(y, pl.sim.dt, hold, pl)
        return np.array(y)

    A = np.zeros((NX, NX))
    for i in range(NX):
        h = H_MOTOR if i >= 19 else H_STATE
        xp, xm = list(x0), list(x0)
        xp[i] += h
        xm[i] -= h
        A[:, i] = (tick(xp, (0.0, 0.0)) - tick(xm, (0.0, 0.0))) / (2.0 * h)
    B = np.zeros((NX, 2))
    for j in range(2):
        up, um = [0.0, 0.0], [0.0, 0.0]
        up[j], um[j] = H_INPUT, -H_INPUT
        B[:, j] = (tick(list(x0), (up[0], up[1])) - tick(list(x0), (um[0], um[1]))) / (
            2.0 * H_INPUT
        )
    return A, B


def axis_model(
    axis: str, p: Params | None = None, lin: HoverLinearization | None = None
) -> AxisModel:
    """Extract the 7-state single-axis closed-inner-loop model (input ``u`` of that axis)."""
    p = load_params() if p is None else p
    lin = hover_linearization(p) if lin is None else lin
    a = _axis(axis)
    sel = [a.pos, a.vel, a.quat, a.rate, a.n, a.wp]
    T = np.zeros((7, NX))
    for r, idx in enumerate(sel):
        T[r, idx] = 1.0
    sign = np.array(a.motor_signs, dtype=float) / 2.0  # unit-norm row over the four rotors
    T[6, 19:23] = sign
    A = T @ lin.A_d @ T.T
    B = T @ lin.B_d[:, a.u_index : a.u_index + 1]
    # invariance of the subspace under A and containment of B
    P_perp = np.eye(NX) - T.T @ T
    err = max(
        float(np.max(np.abs(P_perp @ lin.A_d @ T.T))),
        float(np.max(np.abs(P_perp @ lin.B_d[:, a.u_index]))),
    )
    labels = (
        f"pos_{a.name}",
        f"vel_{a.name}",
        f"q_{a.name}",
        f"rate_{a.name}",
        f"n_{a.name}",
        f"wp_{a.name}",
        f"motor_{'pitch' if a.name == 'x' else 'roll'}",
    )

    def row(i: int, scale: float = 1.0) -> np.ndarray:
        r = np.zeros((1, 7))
        r[0, i] = scale
        return r

    return AxisModel(
        axis=axis,
        A=A,
        B=B,
        Ts=lin.Ts,
        labels=labels,
        C_pos=row(0),
        C_vel=row(1),
        C_att=row(2, 2.0),
        C_rate=row(3),
        invariance_error=err,
    )


def outer_loop_ss(axis: str, p: Params | None = None, gs: float = 1.0) -> control.StateSpace:
    """Discrete outer-loop transfer ``L(z) = gs (Kp pos + Kd vel)/u`` for one axis (K_T = 1)."""
    p = load_params() if p is None else p
    m = axis_model(axis, p)
    kp, kd = p.control.outer.Kp, p.control.outer.Kd
    if kp is None or kd is None:
        raise ValueError("outer-loop gains are not set")
    C = gs * (kp * m.C_pos + kd * m.C_vel)
    return control.ss(m.A, m.B, C, np.zeros((1, 1)), m.Ts)


def outer_loop_tf(axis: str, p: Params | None = None, gs: float = 1.0) -> control.TransferFunction:
    """Same loop as a ``TransferFunction`` (7th order, dt = control period)."""
    return control.ss2tf(outer_loop_ss(axis, p, gs))


def inner_loop_ss(axis: str, p: Params | None = None) -> control.StateSpace:
    """Inner attitude loop ``L_i`` (torque-level loop, broken at the attitude-command node).

    From the closed-inner-loop model: ``T_i = (Kp_att att + Kd_att rate) / (Kp_att c)`` is the
    complementary sensitivity at the injection node ``Kp_att c`` (``c`` = attitude command), and
    ``L_i = T_i / (1 - T_i)``.
    """
    p = load_params() if p is None else p
    m = axis_model(axis, p)
    a = _axis(axis)
    kp, kd = p.control.inner.Kp, p.control.inner.Kd
    if kp is None or kd is None:
        raise ValueError("inner-loop gains are not set")
    g = p.sim.g
    # c = att_sign * u / g  =>  Kp c = Kp att_sign u / g
    scale = kp * a.att_sign / g
    C = kp * m.C_att + kd * m.C_rate
    T = control.ss(m.A, m.B / scale, C, np.zeros((1, 1)), m.Ts)
    return control.feedback(T, 1.0, sign=+1)


def plant_x_tf(p: Params | None = None) -> control.TransferFunction:
    """Bare translational plant ``X/U_x`` with attitude removed (compare R-1 Eq. 6).

    Numerical Jacobian of :func:`slosh.core.dynamics.deriv` at hover for the states
    ``(x, xdot, n_N, w_p,E)``; the force ``U_x`` on the quad is applied through the thrust-vector
    tilt (``dF_N/dq_y`` from :func:`thrust_force_ned`), so no attitude dynamics enter.
    Returns a continuous-time transfer function (4 poles: a double pole at the origin and the
    slosh pair).
    """
    p = load_params() if p is None else p
    x0 = initial_state(p)
    hold = Hold(tau=(0.0, 0.0, 0.0), omega_cmd=(x0[19], x0[20], x0[21], x0[22]))
    sel = [0, 3, 13, 17]  # pos_N, vel_N, n_N, wp_E
    h = H_STATE

    def d(x: list[float]) -> np.ndarray:
        return np.array(deriv(x, hold, p))

    A = np.zeros((4, 4))
    for c, idx in enumerate(sel):
        xp, xm = list(x0), list(x0)
        xp[idx] += h
        xm[idx] -= h
        A[:, c] = ((d(xp) - d(xm)) / (2.0 * h))[sel]
    xp, xm = list(x0), list(x0)
    xp[8] += h
    xm[8] -= h
    dB = ((d(xp) - d(xm)) / (2.0 * h))[sel]
    dFdq = (thrust_force_ned(xp, p.vehicle.k_f)[0] - thrust_force_ned(xm, p.vehicle.k_f)[0]) / (
        2.0 * h
    )
    B = (dB / dFdq).reshape(4, 1)
    C = np.array([[1.0, 0.0, 0.0, 0.0]])
    return _clean_tf(control.ss2tf(control.ss(A, B, C, np.zeros((1, 1)))))


def _clean_tf(tf: control.TransferFunction, rel: float = 1e-9) -> control.TransferFunction:
    """Drop numerically-zero leading coefficients of numerator and denominator."""
    num = np.atleast_1d(np.squeeze(tf.num[0][0])).astype(float)
    den = np.atleast_1d(np.squeeze(tf.den[0][0])).astype(float)

    def trim(c: np.ndarray) -> np.ndarray:
        k = 0
        while k < len(c) - 1 and abs(c[k]) <= rel * np.max(np.abs(c)):
            k += 1
        return c[k:]

    return control.tf(trim(num), trim(den))


def eq6_coefficients(p: Params) -> tuple[np.ndarray, np.ndarray]:
    """R-1 Eq. 6 numerator and denominator polynomial coefficients (descending powers of s)."""
    m_q, m_p, L = p.vehicle.m_q, p.pendulum.m_p, p.pendulum.L
    k1, g = p.pendulum.k_damp, p.sim.g
    m_T = m_q + m_p
    num = np.array([L**2 * m_p, k1, m_p * L * g])
    inner = np.array([(m_T - m_p) * m_p * L**2, m_T * k1, m_T * m_p * L * g])
    den = np.concatenate([inner, [0.0, 0.0]])
    return num, den


def slosh_omega(p: Params) -> float:
    """Slosh-mode frequency ``sqrt(m_T g / ((m_T - m_p) L))`` [rad/s]."""
    m_T = p.vehicle.m_q + p.pendulum.m_p
    return math.sqrt(m_T * p.sim.g / ((m_T - p.pendulum.m_p) * p.pendulum.L))
