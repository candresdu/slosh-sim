"""Symbolic re-derivation of the R-1 testbed equations of motion (Eq. 1-6).

The R-1 world frame is z-up with generalized coordinates ``q = [x_q, y_q, z_q, theta, phi]``
and ``m_T = m_q + m_p``. The equations are rebuilt from the Lagrangian (Eq. 1-4) and compared
with Eq. 5 as transcribed from the PDF text, to catch transcription errors. The derived form is
the source of truth. ``eq5_accelerations`` is the lambdified solve of ``M qdd = RHS``.

This module is offline tooling (SymPy); the runtime simulation uses the unit-vector model.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import numpy as np
import sympy as sp

# --- symbols -----------------------------------------------------------------------------------
t = sp.Symbol("t", real=True)
s = sp.Symbol("s")
m_q, m_p, L, g, k1, k2 = sp.symbols("m_q m_p L g k1 k2", positive=True)
m_T = m_q + m_p

# Generalized coordinates, velocities, accelerations (plain symbols for matrix output)
q_syms = sp.symbols("x_q y_q z_q theta phi", real=True)
qd_syms = sp.symbols("xd_q yd_q zd_q thetad phid", real=True)
qdd_syms = sp.symbols("xdd_q ydd_q zdd_q thetadd phidd", real=True)
U_syms = sp.symbols("U_x U_y U_z", real=True)

COORD_NAMES = ("x_q", "y_q", "z_q", "theta", "phi")


@dataclass(frozen=True)
class Eq5:
    """Mass matrix ``M(q)`` and right-hand side ``RHS(q, qd, U)`` with ``M qdd = RHS``."""

    M: sp.Matrix
    rhs: sp.Matrix


def _generalized_forces() -> sp.Matrix:
    th, thd, phd = q_syms[3], qd_syms[3], qd_syms[4]
    return sp.Matrix([*U_syms, -k1 * thd, -k2 * sp.sin(th) ** 2 * phd])


@lru_cache(maxsize=1)
def derive() -> Eq5:
    """Derive ``M(q)`` and ``RHS(q, qd, U)`` from the Lagrangian (R-1 Eq. 1-4)."""
    # Time-dependent coordinates for the Euler-Lagrange derivatives.
    fq = [sp.Function(n.name)(t) for n in q_syms]
    x, y, z, th, ph = fq
    xd, yd, zd, thd, phd = (sp.diff(f, t) for f in fq)

    # Eq. 1: mass position
    xp = x + L * sp.sin(th) * sp.cos(ph)
    yp = y + L * sp.sin(th) * sp.sin(ph)
    zp = z - L * sp.cos(th)

    # Eq. 2: kinetic energy, from the mass velocity (written out, then cross-checked with Eq. 1)
    T = (
        sp.Rational(1, 2) * m_q * (xd**2 + yd**2 + zd**2)
        + sp.Rational(1, 2)
        * m_p
        * (xd - L * phd * sp.sin(th) * sp.sin(ph) + L * thd * sp.cos(th) * sp.cos(ph)) ** 2
        + sp.Rational(1, 2)
        * m_p
        * (yd + L * phd * sp.sin(th) * sp.cos(ph) + L * thd * sp.cos(th) * sp.sin(ph)) ** 2
        + sp.Rational(1, 2) * m_p * (zd + L * thd * sp.sin(th)) ** 2
    )
    T_from_eq1 = sp.Rational(1, 2) * m_q * (xd**2 + yd**2 + zd**2) + sp.Rational(1, 2) * m_p * (
        sp.diff(xp, t) ** 2 + sp.diff(yp, t) ** 2 + sp.diff(zp, t) ** 2
    )
    if sp.simplify(T - T_from_eq1) != 0:  # pragma: no cover - guards the transcription of Eq. 2
        raise ValueError("Eq. 2 is inconsistent with the Eq. 1 mass position")

    # Eq. 3: potential energy
    V = m_q * g * z + m_p * g * (z - L * sp.cos(th))
    lag = T - V

    # Eq. 4: d/dt(dL/dqd) - dL/dq = Q
    # substitute highest derivative first, then velocities, then positions
    def plain(expr: sp.Expr) -> sp.Expr:
        expr = expr.subs({sp.diff(f, t, 2): a for f, a in zip(fq, qdd_syms, strict=True)})
        expr = expr.subs({sp.diff(f, t): a for f, a in zip(fq, qd_syms, strict=True)})
        return expr.subs(dict(zip(fq, q_syms, strict=True)))

    el = []
    for f in fq:
        dL_dqd = sp.diff(lag, sp.diff(f, t))
        el.append(sp.diff(dL_dqd, t) - sp.diff(lag, f))
    el_plain = sp.Matrix([sp.expand(plain(e)) for e in el])

    # el = M qdd - rhs_nonQ  ->  M qdd = Q + (-el|_{qdd=0})
    Q = _generalized_forces()
    M = sp.Matrix([[sp.diff(e, a) for a in qdd_syms] for e in el_plain])
    zero_acc = {a: 0 for a in qdd_syms}
    rhs = sp.Matrix([Q[i] - el_plain[i].subs(zero_acc) for i in range(5)])
    M = M.applyfunc(sp.simplify)
    rhs = rhs.applyfunc(sp.simplify)
    return Eq5(M=M, rhs=rhs)


def printed_eq5() -> Eq5:
    """Eq. 5 exactly as transcribed from the R-1 PDF text (``M qdd = RHS``)."""
    th, ph = q_syms[3], q_syms[4]
    thd, phd = qd_syms[3], qd_syms[4]
    Ux, Uy, Uz = U_syms
    c, sn = sp.cos, sp.sin
    M = sp.Matrix(
        [
            [m_T, 0, 0, L * m_p * c(th) * c(ph), -L * m_p * sn(th) * sn(ph)],
            [0, m_T, 0, L * m_p * c(th) * sn(ph), L * m_p * sn(th) * c(ph)],
            [0, 0, m_T, L * m_p * sn(th), 0],
            [L * m_p * c(th) * c(ph), L * m_p * c(th) * sn(ph), L * m_p * sn(th), L**2 * m_p, 0],
            [-L * m_p * sn(th) * sn(ph), L * m_p * sn(th) * c(ph), 0, 0, L**2 * m_p * sn(th) ** 2],
        ]
    )
    rhs = sp.Matrix(
        [
            Ux
            + L
            * m_p
            * (sn(th) * c(ph) * phd**2 + sn(th) * c(ph) * thd**2 + 2 * c(th) * sn(ph) * thd * phd),
            Uy
            + L
            * m_p
            * (sn(th) * sn(ph) * phd**2 + sn(th) * sn(ph) * thd**2 - 2 * c(th) * c(ph) * thd * phd),
            Uz - L * m_p * c(th) * thd**2 - m_T * g,
            m_p * L * (L * phd**2 * sn(th) * c(th) - g * sn(th)) - k1 * thd,
            -2 * m_p * L**2 * sn(th) * c(th) * thd * phd - k2 * sn(th) ** 2 * phd,
        ]
    )
    return Eq5(M=M, rhs=rhs)


def compare_eq5() -> dict[str, list[list[Any]]]:
    """Entry-by-entry comparison of the derived and printed Eq. 5.

    Returns ``{"M": [[(row, col, status, derived, printed, difference), ...]], "RHS": [...]}``
    where ``status`` is ``"match"`` or ``"differs"``.
    """
    d, p = derive(), printed_eq5()
    out: dict[str, list[list[Any]]] = {"M": [], "RHS": []}
    for i in range(5):
        row = []
        for j in range(5):
            diff = sp.simplify(d.M[i, j] - p.M[i, j])
            row.append(
                (i + 1, j + 1, "match" if diff == 0 else "differs", d.M[i, j], p.M[i, j], diff)
            )
        out["M"].append(row)
        diff = sp.simplify(d.rhs[i] - p.rhs[i])
        out["RHS"].append(
            [(i + 1, 0, "match" if diff == 0 else "differs", d.rhs[i], p.rhs[i], diff)]
        )
    return out


# --- numeric accelerations ---------------------------------------------------------------------
@lru_cache(maxsize=1)
def _lambdified() -> tuple[Any, Any]:
    e = derive()
    args = (*q_syms, *qd_syms, *U_syms, m_q, m_p, L, g, k1, k2)
    return sp.lambdify(args, e.M, "numpy"), sp.lambdify(args, e.rhs, "numpy")


def eq5_accelerations(q: Any, qd: Any, U: Any, p: Any) -> np.ndarray:
    """Solve ``M qdd = RHS`` for the five accelerations of the derived Eq. 5.

    ``q = [x_q, y_q, z_q, theta, phi]`` (z-up), ``qd`` its rate, ``U = [U_x, U_y, U_z]``.
    ``p`` is a :class:`slosh.params.Params`; ``k1 = k2 = p.pendulum.k_damp`` and ``g = p.sim.g``.
    """
    m_f, rhs_f = _lambdified()
    args = (
        *[float(v) for v in q],
        *[float(v) for v in qd],
        *[float(v) for v in U],
        p.vehicle.m_q,
        p.pendulum.m_p,
        p.pendulum.L,
        p.sim.g,
        p.pendulum.k_damp,
        p.pendulum.k_damp,
    )
    M = np.array(m_f(*args), dtype=float)
    rhs = np.array(rhs_f(*args), dtype=float).reshape(5)
    return np.linalg.solve(M, rhs)


# --- Eq. 6 -------------------------------------------------------------------------------------
def x_channel_tf() -> sp.Expr:
    """Linearized x-channel plant ``X(s)/U_x(s)`` from the derived EOM.

    Linearizes about ``x = theta = xd = thetad = 0`` with ``y, z, phi`` dropped (phi = 0,
    phid = 0). The hover weight is balanced by ``U_z`` and is not part of this channel.
    """
    e = derive()
    th, thd = q_syms[3], qd_syms[3]
    xdd, thdd = qdd_syms[0], qdd_syms[3]
    drop = {
        **{v: 0 for v in (q_syms[4], qd_syms[4], qdd_syms[4])},  # phi dropped
        **{v: 0 for v in (qd_syms[1], qd_syms[2], qdd_syms[1], qdd_syms[2])},  # y, z held
    }
    rows = (0, 3)  # x and theta equations
    eqs = []
    for i in rows:
        expr = sum(e.M[i, j] * qdd_syms[j] for j in range(5)) - e.rhs[i]
        expr = expr.subs(drop)
        # first-order Taylor expansion about theta = thetad = 0 (xdd, thetadd already linear)
        lin = sum(
            sp.diff(expr, v).subs({th: 0, thd: 0}) * v for v in (th, thd, xdd, thdd)
        ) + expr.subs({th: 0, thd: 0, xdd: 0, thdd: 0})
        eqs.append(sp.expand(lin))

    X, TH, U = sp.symbols("X TH U")
    sub = {xdd: s**2 * X, thdd: s**2 * TH, th: TH, thd: s * TH, U_syms[0]: U}
    laplace = [sp.expand(eq.subs(sub)) for eq in eqs]
    sol = sp.solve(laplace, [X, TH], dict=True)[0]
    return sp.simplify(sol[X] / U)


def printed_eq6() -> sp.Expr:
    """Eq. 6 as printed in R-1."""
    num = L**2 * m_p * s**2 + k1 * s + m_p * L * g
    den = s**2 * ((m_T - m_p) * m_p * L**2 * s**2 + m_T * k1 * s + m_T * m_p * L * g)
    return num / den


# --- report ------------------------------------------------------------------------------------
_ENTRY_LABEL = {
    "M": lambda i, j: f"M[{i},{j}]",
    "RHS": lambda i, j: f"RHS[{i}]",
}


def report_markdown() -> str:
    """Render the Eq. 5 / Eq. 6 comparison as Markdown (one line per M and RHS entry)."""
    cmp_ = compare_eq5()
    lines = [
        "# R-1 Eq. 5 re-derivation check",
        "",
        "Generated by `python -m slosh.symbolic` (`python/src/slosh/symbolic.py`). The equations",
        "of motion are rebuilt with SymPy from the Lagrangian (Eq. 1-4, generalized forces",
        "`Q = [U_x, U_y, U_z, -k1*thetad, -k2*sin(theta)^2*phid]`) and each entry is compared with",
        "Eq. 5 as transcribed from the PDF text. `match` means `simplify(derived - printed) == 0`.",
        "Any `differs` entry is a transcription error; the derived form is the source of truth.",
        "",
        "## Mass matrix M (5x5, `M qdd = RHS`)",
        "",
    ]
    n_diff = 0
    for kind in ("M", "RHS"):
        if kind == "RHS":
            lines += ["", "## Right-hand side", ""]
        for row in cmp_[kind]:
            for i, j, status, derived, printed, diff in row:
                n_diff += status == "differs"
                line = f"- {_ENTRY_LABEL[kind](i, j)}: {status}"
                if status == "differs":
                    line += f" (derived `{derived}`; printed `{printed}`; difference `{diff}`)"
                lines.append(line)
    eq6_diff = sp.simplify(x_channel_tf() - printed_eq6())
    lines += [
        "",
        "## Eq. 6 (linearized x-channel plant)",
        "",
        "Linearized about `x = theta = xd = thetad = 0` with y, z, phi dropped (z held by U_z).",
        f"- Eq. 6: {'match' if eq6_diff == 0 else 'differs'}",
        "",
        "## Summary",
        "",
        f"{n_diff} of 30 Eq. 5 entries differ. "
        + (
            "No transcription errors were found; the printed Eq. 5 and Eq. 6 are consistent with "
            "the Lagrangian."
            if n_diff == 0 and eq6_diff == 0
            else "See the entries marked `differs` above."
        ),
        "",
        "Notes:",
        "- The printed RHS row 3 carries `-m_T g`: gravity acts in the z equation (z-up frame).",
        "- Only the derived Eq. 5 form is singular at `theta = 0` (M[5,5] = L^2 m_p sin^2(theta));",
        "  the runtime model uses a unit-vector pendulum instead.",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    from pathlib import Path

    out = Path(__file__).resolve().parents[3] / "reports" / "eq5_check.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(report_markdown())
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
