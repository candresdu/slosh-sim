import copy
import json

import jsonschema
import pytest

from slosh.params import (
    DEFAULT_PARAMS_PATH,
    SHARED_DIR,
    load_params,
    load_params_raw,
    params_sha256,
    provenance_table,
)
from slosh.presets import PRESET_IDS, load_preset, load_presets

ALLOWED_PREFIXES = (
    "assumed",
    "designed (reconstruction)",
    "tuned (reconstruction)",
    "optional realism",
)


def _schema(name):
    return json.loads((SHARED_DIR / "schema" / name).read_text(encoding="utf-8"))


def test_default_params_validate():
    raw = load_params_raw()
    assert raw["schema"] == "slosh-params/1"
    assert raw["modelVersion"] == "0.1.0"


def test_schema_rejects_bad_params():
    raw = load_params_raw()
    bad = copy.deepcopy(raw)
    del bad["motor"]["tau"]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(bad, _schema("params.schema.json"))
    bad = copy.deepcopy(raw)
    bad["vehicle"]["m_q"] = 1.5
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(bad, _schema("params.schema.json"))


def test_r1_table2_values():
    raw = load_params_raw()
    p = load_params()
    expected = {
        "vehicle.m_q": (1.5207, p.vehicle.m_q),
        "vehicle.J": ([0.0211, 0.0216, 0.01455], list(p.vehicle.J)),
        "vehicle.k_f": (5.8597e-6, p.vehicle.k_f),
        "vehicle.k_tau": (2.925e-9, p.vehicle.k_tau),
        "pendulum.m_p": (0.05, p.pendulum.m_p),
        "pendulum.L": (1.0, p.pendulum.L),
    }
    rows = {path: (v, src) for path, v, src in provenance_table(raw)}
    for path, (want, got) in expected.items():
        assert rows[path][0] == want
        assert got == want
        assert "R-1 Table 2" in rows[path][1]


def test_provenance_labels():
    rows = provenance_table()
    assert len(rows) > 40
    for path, _v, src in rows:
        if "R-1" in src:
            continue
        assert src.startswith(ALLOWED_PREFIXES), f"{path}: {src!r}"


def test_key_assumed_values():
    p = load_params()
    assert p.motor.tau == 0.040
    assert p.control.rateHz == 100
    assert p.pendulum.k_damp == 1e-3
    assert p.aac.b_e == 0
    assert p.sim.dt == 0.001 and p.sim.controlDecimation == 10
    assert p.sim.dt * p.sim.controlDecimation * p.control.rateHz == pytest.approx(1.0)


def test_designed_and_tuned_values_are_set():
    p = load_params()
    # control gains are designed by slosh.design.fit_gains
    for g in (p.control.inner, p.control.outer, p.control.alt, p.control.yaw):
        assert g.Kp is not None and g.Kd is not None
    # AAC values are tuned by slosh.tune_aac: no nulls remain
    assert p.aac.a0 is not None and p.aac.b_s is not None and p.aac.threshold is not None
    rows = {path: src for path, _v, src in provenance_table()}
    assert rows["control.inner.Kp"] == "designed (reconstruction)"
    for path in ("aac.a0", "aac.b_s", "aac.threshold", "aac.kMin", "aac.hp.fc", "aac.lp.fc"):
        assert rows[path] == "tuned (reconstruction)", path


def test_params_frozen():
    p = load_params()
    with pytest.raises(AttributeError):
        p.motor.tau = 1.0  # type: ignore[misc]


def test_sha256_stable_and_sensitive():
    assert params_sha256() == params_sha256()
    assert len(params_sha256()) == 64
    raw = load_params_raw()
    base = params_sha256(raw)
    assert base == params_sha256(DEFAULT_PARAMS_PATH)
    changed = copy.deepcopy(raw)
    changed["motor"]["tau"]["v"] = 0.041
    assert params_sha256(changed) != base
    changed = copy.deepcopy(raw)
    changed["aac"]["threshold"]["v"] = 1.0
    assert params_sha256(changed) != base
    changed = copy.deepcopy(raw)
    changed["pendulum"]["L"]["src"] = "other"
    assert params_sha256(changed) != base
    # key order and whitespace don't matter
    reordered = {k: raw[k] for k in reversed(list(raw))}
    assert params_sha256(reordered) == base


def test_presets_validate():
    presets = load_presets()
    assert set(presets) == set(PRESET_IDS)
    for pid in PRESET_IDS:
        jsonschema.validate(
            json.loads((SHARED_DIR / "presets" / f"{pid}.json").read_text(encoding="utf-8")),
            _schema("preset.schema.json"),
        )


def test_preset_contents():
    f12, f13, f14, vb = (load_preset(i) for i in ("fig12", "fig13", "fig14", "vb"))
    for p in (f12, f13, f14):
        assert (p.initial.theta, p.initial.thetaDot, p.initial.phi, p.initial.phiDot) == (
            0.2,
            0.0,
            0.0,
            0.6,
        )
        assert p.durationS == 60 and p.events == ()
    assert (f12.initial.gainShift, f12.initial.aacMode) == (1.0, "off")
    assert (f13.initial.gainShift, f13.initial.aacMode) == (2.3, "monitor")
    assert (f14.initial.gainShift, f14.initial.aacMode) == (2.3, "engaged")
    assert vb.durationS == 130
    assert (vb.initial.theta, vb.initial.phiDot, vb.initial.gainShift) == (0.05, 0.2, 1.0)
    assert vb.initial.aacMode == "monitor"
    assert {"t": 0, "type": "rampGainShift", "to": 2.0, "durationS": 20} in vb.events
    assert {"t": 100, "type": "setAacMode", "mode": "engaged"} in vb.events


def test_golden_schema_is_valid_and_lists_columns():
    schema = _schema("golden.schema.json")
    jsonschema.Draft202012Validator.check_schema(schema)
    cols = set(schema["properties"]["columns"]["properties"])
    expected = (
        "t theta phi roll pitch yaw x y z mx my kT_pitch kT_roll ySD_pitch ySD_roll "
        "detect_pitch detect_roll m1 m2 m3 m4"
    ).split()
    assert cols == set(expected)
    for h in ("modelVersion", "paramsSha256", "preset", "generator", "dt", "n"):
        assert h in schema["required"]
    n = 3
    doc = {
        "schema": "slosh-golden/1",
        "modelVersion": "0.1.0",
        "paramsSha256": "0" * 64,
        "preset": "fig12",
        "generator": "test",
        "dt": 0.01,
        "n": n,
        "columns": {c: [0.0] * n for c in expected},
    }
    jsonschema.validate(doc, schema)
