"""Classic fixed-step RK4 with constraint renormalization."""

from __future__ import annotations

import math
from collections.abc import Sequence

from ..params import Params
from .dynamics import Hold, deriv
from .state import NX


def rk4_step(x: Sequence[float], dt: float, u_hold: Hold, p: Params) -> list[float]:
    """Advance ``x`` by ``dt`` with held input; returns a new state list.

    After the step: ``n <- n/|n|``, ``w_p <- w_p - (w_p.n) n``, ``q_att <- q_att/|q_att|``.
    """
    k1 = deriv(x, u_hold, p)
    h2 = 0.5 * dt
    k2 = deriv([x[i] + h2 * k1[i] for i in range(NX)], u_hold, p)
    k3 = deriv([x[i] + h2 * k2[i] for i in range(NX)], u_hold, p)
    k4 = deriv([x[i] + dt * k3[i] for i in range(NX)], u_hold, p)
    dt6 = dt / 6.0
    y = [x[i] + dt6 * (k1[i] + 2.0 * k2[i] + 2.0 * k3[i] + k4[i]) for i in range(NX)]
    normalize(y)
    return y


def normalize(y: list[float]) -> None:
    """In-place projection: unit ``n``, ``w_p`` perpendicular to ``n``, unit quaternion."""
    inv = 1.0 / math.sqrt(y[13] * y[13] + y[14] * y[14] + y[15] * y[15])
    y[13] *= inv
    y[14] *= inv
    y[15] *= inv
    d = y[16] * y[13] + y[17] * y[14] + y[18] * y[15]
    y[16] -= d * y[13]
    y[17] -= d * y[14]
    y[18] -= d * y[15]
    inv = 1.0 / math.sqrt(y[6] * y[6] + y[7] * y[7] + y[8] * y[8] + y[9] * y[9])
    y[6] *= inv
    y[7] *= inv
    y[8] *= inv
    y[9] *= inv
