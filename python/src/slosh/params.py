"""Load and validate the shared parameter file (``shared/params/default.json``).

The JSON file is the single source of truth for both the Python and TypeScript runtimes.
Every leaf is ``{"v": value, "src": provenance}``. This module validates the file against
``shared/schema/params.schema.json`` and exposes it as a frozen dataclass of plain floats.
Values that are not designed yet are ``None``.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import jsonschema

SHARED_DIR = Path(
    os.environ.get("SLOSH_SHARED_DIR") or Path(__file__).resolve().parents[3] / "shared"
)
DEFAULT_PARAMS_PATH = SHARED_DIR / "params" / "default.json"
PARAMS_SCHEMA_PATH = SHARED_DIR / "schema" / "params.schema.json"

Vec3 = tuple[float, float, float]


@dataclass(frozen=True)
class Vehicle:
    m_q: float
    J: Vec3
    arm: float
    k_f: float
    k_tau: float
    pivotOffset: Vec3


@dataclass(frozen=True)
class Pendulum:
    m_p: float
    L: float
    k_damp: float


@dataclass(frozen=True)
class Motor:
    tau: float
    omegaMin: float
    omegaMax: float


@dataclass(frozen=True)
class Gains:
    Kp: float | None
    Kd: float | None


@dataclass(frozen=True)
class Control:
    rateHz: float
    attMax: float
    inner: Gains
    outer: Gains
    alt: Gains
    yaw: Gains


@dataclass(frozen=True)
class Filter:
    fc: float
    order: int
    sos: tuple[tuple[float, ...], ...]


@dataclass(frozen=True)
class Aac:
    a0: float | None
    b_e: float
    b_s: float | None
    kMin: float
    kMax: float
    hp: Filter
    lp: Filter
    threshold: float | None
    clearRatio: float
    clearHoldS: float
    engageRampS: float
    refLeadS: float
    refLagS: float


@dataclass(frozen=True)
class Noise:
    enabled: bool
    pos: float
    att: float
    rate: float


@dataclass(frozen=True)
class Sensing:
    latencyMs: float
    noise: Noise


@dataclass(frozen=True)
class Sim:
    dt: float
    controlDecimation: int
    seed: int
    g: float


@dataclass(frozen=True)
class Params:
    modelVersion: str
    vehicle: Vehicle
    pendulum: Pendulum
    motor: Motor
    control: Control
    aac: Aac
    sensing: Sensing
    sim: Sim


def _is_leaf(node: Any) -> bool:
    return isinstance(node, dict) and set(node) == {"v", "src"}


def _freeze(v: Any) -> Any:
    if isinstance(v, list):
        return tuple(_freeze(x) for x in v)
    if isinstance(v, bool) or v is None or isinstance(v, int | str):
        return v
    return float(v)


def _plain(node: Any) -> Any:
    """Strip provenance: leaves become their (frozen) values, sections become dicts."""
    if _is_leaf(node):
        return _freeze(node["v"])
    return {k: _plain(x) for k, x in node.items() if k not in ("schema", "modelVersion")}


def load_params_raw(path: str | Path = DEFAULT_PARAMS_PATH) -> dict[str, Any]:
    """Read the JSON file and validate it against the schema (raises ValidationError)."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    schema = json.loads(PARAMS_SCHEMA_PATH.read_text(encoding="utf-8"))
    jsonschema.validate(data, schema)
    return data


def _build(raw: dict[str, Any]) -> Params:
    p = _plain(raw)
    c, a = p["control"], p["aac"]
    return Params(
        modelVersion=raw["modelVersion"],
        vehicle=Vehicle(**p["vehicle"]),
        pendulum=Pendulum(**p["pendulum"]),
        motor=Motor(**p["motor"]),
        control=Control(
            rateHz=c["rateHz"],
            attMax=c["attMax"],
            **{k: Gains(**c[k]) for k in ("inner", "outer", "alt", "yaw")},
        ),
        aac=Aac(**{**a, "hp": Filter(**a["hp"]), "lp": Filter(**a["lp"])}),
        sensing=Sensing(latencyMs=p["sensing"]["latencyMs"], noise=Noise(**p["sensing"]["noise"])),
        sim=Sim(**p["sim"]),
    )


def load_params(path: str | Path = DEFAULT_PARAMS_PATH) -> Params:
    """Load, validate and return the parameters as a frozen dataclass."""
    return _build(load_params_raw(path))


def canonical_json(data: Any) -> str:
    """Canonical JSON: sorted keys, no whitespace."""
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def params_sha256(path_or_data: str | Path | dict[str, Any] = DEFAULT_PARAMS_PATH) -> str:
    """SHA-256 (hex) of the canonical JSON of the parameter file (or of a loaded dict)."""
    if isinstance(path_or_data, dict):
        data = path_or_data
    else:
        data = json.loads(Path(path_or_data).read_text(encoding="utf-8"))
    return hashlib.sha256(canonical_json(data).encode("utf-8")).hexdigest()


def provenance_table(
    path_or_data: str | Path | dict[str, Any] = DEFAULT_PARAMS_PATH,
) -> list[tuple[str, Any, str]]:
    """Return ``[(dotted_path, value, src)]`` for every leaf, in file order."""
    data = (
        path_or_data
        if isinstance(path_or_data, dict)
        else json.loads(Path(path_or_data).read_text(encoding="utf-8"))
    )
    rows: list[tuple[str, Any, str]] = []

    def walk(node: Any, prefix: str) -> None:
        if _is_leaf(node):
            rows.append((prefix, node["v"], node["src"]))
            return
        for k, x in node.items():
            if isinstance(x, dict):
                walk(x, f"{prefix}.{k}" if prefix else k)

    walk(data, "")
    return rows
