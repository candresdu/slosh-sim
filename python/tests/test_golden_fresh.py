"""Committed golden traces are fresh, schema-valid and tied to the current parameter file."""

from __future__ import annotations

import json
import re
from pathlib import Path

import jsonschema
import pytest

from slosh.export import GOLDEN_DIR, GOLDEN_GENERATOR, main
from slosh.params import SHARED_DIR, params_sha256
from slosh.presets import PRESET_IDS, load_preset

SCHEMA = json.loads((SHARED_DIR / "schema" / "golden.schema.json").read_text(encoding="utf-8"))
_GEN_LINE = re.compile(r'^"generator":.*,$', re.MULTILINE)


def _strip_generator(text: str) -> str:
    """Drop the generator line (it carries the git sha, which changes with every commit)."""
    out, n = _GEN_LINE.subn('"generator":"",', text)
    assert n == 1
    return out


@pytest.fixture(scope="module")
def regenerated(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("goldens")
    assert main(["goldens", "--out", str(out)]) == 0
    return out


@pytest.mark.parametrize("pid", PRESET_IDS)
def test_byte_identical_to_committed(regenerated: Path, pid: str) -> None:
    fresh = (regenerated / f"{pid}.json").read_text(encoding="utf-8")
    committed = (GOLDEN_DIR / f"{pid}.json").read_text(encoding="utf-8")
    assert _strip_generator(fresh) == _strip_generator(committed), (
        f"{pid}.json is stale: run `python -m slosh.export goldens`"
    )


@pytest.mark.parametrize("pid", PRESET_IDS)
def test_committed_golden_header_and_schema(pid: str) -> None:
    doc = json.loads((GOLDEN_DIR / f"{pid}.json").read_text(encoding="utf-8"))
    jsonschema.validate(doc, SCHEMA)
    assert doc["preset"] == pid
    assert doc["paramsSha256"] == params_sha256()
    assert doc["generator"].startswith(GOLDEN_GENERATOR)
    assert doc["dt"] == 0.01
    n = round(load_preset(pid).durationS * 100) + 1
    assert doc["n"] == n
    for name, col in doc["columns"].items():
        assert len(col) == n, name
    t = doc["columns"]["t"]
    assert t[0] == 0.0
    assert abs(t[-1] - (n - 1) * 0.01) < 1e-9
