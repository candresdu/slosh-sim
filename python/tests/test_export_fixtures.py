"""Tests for ``python -m slosh.export fixtures``."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from slosh.export import BUILDERS, DEFAULT_OUT, N_DERIV, N_RK4, export_fixtures, main
from slosh.params import _build

NAMES = sorted(BUILDERS)


@pytest.fixture(scope="module")
def regenerated(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("fixtures")
    assert main(["fixtures", "--out", str(out)]) == 0
    return out


def _load(d: Path, name: str) -> dict:
    return json.loads((d / f"{name}.json").read_text(encoding="utf-8"))


def test_six_files_written(regenerated: Path) -> None:
    assert sorted(p.stem for p in regenerated.glob("*.json")) == sorted(
        ["deriv", "mixer", "filters", "controller", "aac", "rng"]
    )


@pytest.mark.parametrize("name", NAMES)
def test_byte_identical_to_committed(regenerated: Path, name: str) -> None:
    fresh = (regenerated / f"{name}.json").read_bytes()
    committed = (DEFAULT_OUT / f"{name}.json").read_bytes()
    assert fresh == committed, f"{name}.json is stale: run `python -m slosh.export fixtures`"


def test_regeneration_is_deterministic(regenerated: Path, tmp_path: Path) -> None:
    export_fixtures(tmp_path)
    for name in NAMES:
        assert (tmp_path / f"{name}.json").read_bytes() == (
            regenerated / f"{name}.json"
        ).read_bytes()


@pytest.mark.parametrize("name", NAMES)
def test_params_and_model_version(regenerated: Path, name: str) -> None:
    doc = _load(regenerated, name)
    assert isinstance(doc["params"], dict)
    assert doc["modelVersion"] == doc["params"]["modelVersion"]
    assert doc["kind"] == name
    _build(doc["params"])  # snapshot is a loadable parameter file


def test_deriv_counts_and_shapes(regenerated: Path) -> None:
    doc = _load(regenerated, "deriv")
    assert len(doc["deriv"]) == N_DERIV == 200
    assert len(doc["rk4"]) == N_RK4 == 20
    for c in doc["deriv"]:
        assert len(c["x"]) == 23 and len(c["dx"]) == 23
        assert len(c["uHold"]["tau"]) == 3 and len(c["uHold"]["omegaCmd"]) == 4
        n = c["x"][13:16]
        assert math.isclose(sum(v * v for v in n), 1.0, rel_tol=1e-12)
        assert abs(sum(a * b for a, b in zip(n, c["x"][16:19], strict=True))) < 1e-12
        assert 0.0 <= math.acos(n[2]) <= 1.2 + 1e-12
        assert all(600.0 <= w <= 1000.0 for w in c["x"][19:23])
    for c in doc["rk4"]:
        assert len(c["x"]) == 23 and len(c["xNext"]) == 23
        q = c["xNext"][6:10]
        assert math.isclose(sum(v * v for v in q), 1.0, rel_tol=1e-12)


def test_mixer_cases(regenerated: Path) -> None:
    doc = _load(regenerated, "mixer")
    p = _build(doc["params"])
    assert len(doc["mix"]) == 100 and len(doc["forcesTorques"]) == 100
    lo, hi = p.motor.omegaMin, p.motor.omegaMax
    sat = sum(
        1
        for c in doc["mix"]
        if any(math.isclose(w, lo) or math.isclose(w, hi) for w in c["omegaCmd"])
    )
    assert sat >= 20


def test_filters_and_rng(regenerated: Path) -> None:
    f = _load(regenerated, "filters")
    assert len(f["x"]) == 2000
    assert {c["name"] for c in f["cases"]} >= {"hp", "lp"}
    assert all(len(c["y"]) == 2000 for c in f["cases"])
    r = _load(regenerated, "rng")
    assert [s["seed"] for s in r["seeds"]] == [1, 42]
    for s in r["seeds"]:
        assert len(s["u32"]) == 1000 and len(s["normals"]) == 1000


def test_controller_cases(regenerated: Path) -> None:
    doc = _load(regenerated, "controller")
    assert {c["latencyMs"] for c in doc["cases"]} >= {0.0, 30.0}
    for c in doc["cases"]:
        assert len(c["outputs"]["omegaCmd"]) == 300
        assert len(c["inputs"]["q"]) == 300
    a, b = doc["cases"][0]["outputs"], doc["cases"][1]["outputs"]
    assert a["sensedRoll"] != b["sensedRoll"]  # latency visibly changes the sensed signal


def test_aac_cases_explicit_params_and_trips(regenerated: Path) -> None:
    doc = _load(regenerated, "aac")
    a = doc["params"]["aac"]
    assert all(a[k]["v"] is not None for k in ("a0", "b_s", "threshold"))
    by = {c["name"]: c for c in doc["cases"]}
    assert {"off", "monitor", "engaged"} <= set(by)
    for c in doc["cases"]:
        assert len(c["outputs"]["kT"]) == 2000
    assert not any(by["off"]["outputs"]["detect"])
    assert any(by["monitor"]["outputs"]["tripEdge"])
    assert min(by["engaged"]["outputs"]["kTApplied"]) < 1.0
    assert min(by["monitor"]["outputs"]["kTApplied"]) == 1.0
    assert min(by["monitor"]["outputs"]["kT"]) < 1.0
    assert not by["engaged"]["outputs"]["detect"][-1]  # detector clears by the end
