"""Tests for the biquad filters and the Tustin filter design."""

from __future__ import annotations

import json
import math
import random
import shutil

import numpy as np
from scipy import signal

from slosh.core.filters import Biquad, Sos
from slosh.design import filter_design
from slosh.params import DEFAULT_PARAMS_PATH, load_params

FS = 100.0


def _rows(which: str) -> list[list[float]]:
    return json.loads(DEFAULT_PARAMS_PATH.read_text())["aac"][which]["sos"]["v"]


def _mag(rows: list[list[float]], f: float) -> float:
    b = np.array([r[:3] for r in rows])
    a = np.array([[1.0, r[3], r[4]] for r in rows])
    sos = np.hstack([b, a])
    _, h = signal.sosfreqz(sos, worN=[f], fs=FS)
    return float(abs(h[0]))


def test_biquad_matches_lfilter() -> None:
    rng = random.Random(7)
    b = [0.2, -0.3, 0.1]
    a = [1.0, -1.1, 0.4]
    x = [rng.uniform(-1, 1) for _ in range(2000)]
    bq = Biquad(b[0], b[1], b[2], a[1], a[2])
    y = [bq.step(v) for v in x]
    ref = signal.lfilter(b, a, x)
    assert max(abs(p - q) for p, q in zip(y, ref, strict=True)) < 1e-12


def test_step_response_and_reset() -> None:
    bq = Biquad(*_rows("lp")[0])
    n = 8000  # the tuned LP corner is low (tau of a few seconds)
    ys = [bq.step(1.0) for _ in range(n)]
    ref = signal.lfilter(_rows("lp")[0][:3], [1.0, *_rows("lp")[0][3:]], [1.0] * n)
    assert max(abs(p - q) for p, q in zip(ys, ref, strict=True)) < 1e-12
    assert abs(ys[-1] - 1.0) < 1e-4  # unity DC gain
    bq.reset()
    assert bq.step(1.0) == ys[0]


def test_sos_cascade_matches_sosfilt() -> None:
    rng = random.Random(3)
    rows = _rows("hp") + _rows("lp")
    x = [rng.uniform(-1, 1) for _ in range(2000)]
    cas = Sos(rows)
    y = [cas.step(v) for v in x]
    sos = np.array([[r[0], r[1], r[2], 1.0, r[3], r[4]] for r in rows])
    ref = signal.sosfilt(sos, x)
    assert max(abs(p - q) for p, q in zip(y, ref, strict=True)) < 1e-12
    cas.reset()
    assert cas.step(x[0]) == y[0]


def test_empty_sos_is_identity() -> None:
    assert Sos([]).step(0.37) == 0.37


def test_designed_responses() -> None:
    hp, lp = _rows("hp"), _rows("lp")
    assert len(hp) == 1 and len(lp) == 1
    p = load_params()
    fc_hp, fc_lp = p.aac.hp.fc, p.aac.lp.fc  # tuned corners (0.2-0.4 Hz, 0.05-0.2 Hz)
    assert _mag(hp, 0.5) > 0.7
    assert _mag(hp, 0.05) < 0.05
    assert abs(_mag(lp, fc_lp) - 1 / math.sqrt(2)) < 1e-9  # Tustin pre-warped corner
    assert lp[0][2] == 0.0 and lp[0][4] == 0.0
    assert abs(_mag(hp, fc_hp) - 1 / math.sqrt(2)) < 1e-9


def test_params_load_with_sos() -> None:
    p = load_params()
    assert len(p.aac.hp.sos[0]) == 5 and len(p.aac.lp.sos[0]) == 5


def test_design_matches_file_and_write_is_idempotent(tmp_path) -> None:
    tmp = tmp_path / "default.json"
    shutil.copy(DEFAULT_PARAMS_PATH, tmp)
    before = tmp.read_text()
    assert filter_design.write_params(tmp) is False
    assert tmp.read_text() == before
    # from a blank file, the first write fills the coefficients and the second is a no-op
    data = json.loads(before)
    data["aac"]["hp"]["sos"]["v"] = []
    data["aac"]["lp"]["sos"]["v"] = []
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    assert filter_design.write_params(tmp) is True
    assert tmp.read_text() == before
    assert filter_design.write_params(tmp) is False
