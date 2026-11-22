"""Load and validate the scenario presets in ``shared/presets``."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import jsonschema

from .params import SHARED_DIR

PRESETS_DIR = SHARED_DIR / "presets"
PRESET_SCHEMA_PATH = SHARED_DIR / "schema" / "preset.schema.json"
PRESET_IDS = ("story", "fig12", "fig13", "fig14", "vb")


@dataclass(frozen=True)
class Initial:
    theta: float
    thetaDot: float
    phi: float
    phiDot: float
    gainShift: float
    aacMode: str


@dataclass(frozen=True)
class Preset:
    id: str
    title: str
    caption: str
    durationS: float
    initial: Initial
    events: tuple[dict[str, Any], ...]  # sorted by time; same shape as the JSON events
    regimeCaptions: dict[str, str] | None = None  # optional fallback narration (story)


def load_preset(preset_id: str, presets_dir: str | Path = PRESETS_DIR) -> Preset:
    data = json.loads((Path(presets_dir) / f"{preset_id}.json").read_text(encoding="utf-8"))
    schema = json.loads(PRESET_SCHEMA_PATH.read_text(encoding="utf-8"))
    jsonschema.validate(data, schema)
    if data["id"] != preset_id:
        raise ValueError(f"preset file {preset_id}.json has id {data['id']!r}")
    init = data["initial"]
    return Preset(
        id=data["id"],
        title=data["title"],
        caption=data["caption"],
        durationS=float(data["durationS"]),
        initial=Initial(
            theta=float(init["theta"]),
            thetaDot=float(init["thetaDot"]),
            phi=float(init["phi"]),
            phiDot=float(init["phiDot"]),
            gainShift=float(init["gainShift"]),
            aacMode=init["aacMode"],
        ),
        events=tuple(sorted((dict(e) for e in data["events"]), key=lambda e: e["t"])),
        regimeCaptions=dict(data["regimeCaptions"]) if "regimeCaptions" in data else None,
    )


def load_presets(presets_dir: str | Path = PRESETS_DIR) -> dict[str, Preset]:
    return {pid: load_preset(pid, presets_dir) for pid in PRESET_IDS}
