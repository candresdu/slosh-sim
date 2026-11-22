"""Tests for the SymPy re-derivation of R-1 Eq. 5 and Eq. 6."""

from __future__ import annotations

import numpy as np
import sympy as sp

from slosh import symbolic as S
from slosh.params import load_params


def test_derived_mass_matrix_matches_printed() -> None:
    d, p = S.derive(), S.printed_eq5()
    diff = (d.M - p.M).applyfunc(sp.simplify)
    assert diff == sp.zeros(5, 5)


def test_derived_rhs_matches_printed() -> None:
    d, p = S.derive(), S.printed_eq5()
    diff = (d.rhs - p.rhs).applyfunc(sp.simplify)
    assert diff == sp.zeros(5, 1)


def test_compare_reports_all_entries_match() -> None:
    cmp_ = S.compare_eq5()
    entries = [e for rows in cmp_.values() for row in rows for e in row]
    assert len(entries) == 30
    assert all(e[2] == "match" for e in entries)


def test_linearized_x_channel_matches_eq6() -> None:
    assert sp.simplify(S.x_channel_tf() - S.printed_eq6()) == 0


def test_eq5_accelerations_hover_and_numeric_match() -> None:
    p = load_params()
    m_T = p.vehicle.m_q + p.pendulum.m_p
    # Pendulum at rest and hanging (theta = 0.05; Eq. 5 is singular exactly at theta = 0):
    # thrust balances weight, so the quad does not accelerate vertically.
    acc = S.eq5_accelerations([0, 0, 0, 0.05, 0], [0] * 5, [0, 0, m_T * p.sim.g], p)
    assert abs(acc[2]) < 0.05 * p.pendulum.L * 10
    # Eq. 5 is singular at theta = 0 (M[5,5] = 0): the solve must raise, not return nonsense.
    import pytest

    with pytest.raises(np.linalg.LinAlgError):
        S.eq5_accelerations([0] * 5, [0] * 5, [0, 0, m_T * p.sim.g], p)
    # Generic state: derived solve equals the solve of the printed matrices
    q, qd, U = [0.1, -0.2, 0.3, 0.4, 0.7], [0.2, 0.1, -0.1, 0.5, 0.6], [0.3, -0.2, 14.0]
    pr = S.printed_eq5()
    subs = {
        **dict(zip(S.q_syms, q, strict=True)),
        **dict(zip(S.qd_syms, qd, strict=True)),
        **dict(zip(S.U_syms, U, strict=True)),
        S.m_q: p.vehicle.m_q,
        S.m_p: p.pendulum.m_p,
        S.L: p.pendulum.L,
        S.g: p.sim.g,
        S.k1: p.pendulum.k_damp,
        S.k2: p.pendulum.k_damp,
    }
    M = np.array(pr.M.subs(subs).evalf(), dtype=float)
    rhs = np.array(pr.rhs.subs(subs).evalf(), dtype=float).reshape(5)
    assert np.allclose(S.eq5_accelerations(q, qd, U, p), np.linalg.solve(M, rhs), atol=1e-10)


def test_report_file_lists_every_entry() -> None:
    text = S.report_markdown()
    entry_lines = [ln for ln in text.splitlines() if ln.startswith(("- M[", "- RHS["))]
    assert len(entry_lines) == 30
    assert all(": match" in ln or ": differs" in ln for ln in entry_lines)
