"""List every parameter that is not taken from R-1 Table 2 (the reconstruction disclaimer).

    uv run python -m slosh.provenance --md > ../blog/reconstruction.md

Walks ``shared/params/default.json``; every leaf is ``{"v": value, "src": provenance}``.
Leaves whose ``src`` is not ``R-1 Table 2`` are listed with their value and provenance.
"""

from __future__ import annotations

import argparse
import json
import re
from typing import Any

from .params import DEFAULT_PARAMS_PATH

TABLE2 = "R-1 Table 2"

# One-line meaning of each parameter group, keyed by dotted path prefix (longest match wins).
MEANING = {
    "vehicle.pivotOffset": "Offset of the rod pivot from the quad centre of mass",
    "pendulum.k_damp": "Pendulum damping coefficient (k1 = k2 in the R-1 damping terms)",
    "motor.tau": "Motor first-order lag time constant [s]",
    "motor.omegaMin": "Lower motor speed limit [rad/s]",
    "motor.omegaMax": "Upper motor speed limit [rad/s]",
    "control.rateHz": "Controller and AAC rate [Hz]",
    "control.attMax": "Attitude command limit [rad]",
    "control.inner": "Inner (attitude) PD gains",
    "control.outer": "Outer (position/pendulum) PD gains",
    "control.alt": "Altitude hold PD gains",
    "control.yaw": "Yaw hold PD gains",
    "aac.a0": "AAC leakage rate toward K_T = 1 [1/s]",
    "aac.b_e": "AAC reference-error (up-band) gain; 0 means down-band only",
    "aac.b_s": "AAC spectral-damper (down-band) gain",
    "aac.kMin": "Lower bound of K_T",
    "aac.kMax": "Upper bound of K_T",
    "aac.hp": "Spectral-damper high-pass filter",
    "aac.lp": "Spectral-damper low-pass filter",
    "aac.threshold": "Detection threshold on y_SD",
    "aac.clearRatio": "Detector clears when y_SD falls below this fraction of the threshold",
    "aac.clearHoldS": "Time y_SD must stay below the clear level [s]",
    "aac.engageRampS": "Ramp time when the AAC is engaged [s]; 0 means a step",
    "aac.refLeadS": "Reference-error filter lead time [s]",
    "aac.refLagS": "Reference-error filter lag time [s]",
    "sensing": "Optional realism setting, off by default",
    "sim.dt": "Physics step [s]",
    "sim.controlDecimation": "Physics steps per control tick",
    "sim.seed": "Random seed",
    "sim.g": "Gravitational acceleration [m/s^2]",
}


def leaves(node: dict[str, Any], path: str = "") -> list[tuple[str, Any, str]]:
    """All ``(dotted path, value, src)`` leaves of the parameter tree."""
    out: list[tuple[str, Any, str]] = []
    for key, val in node.items():
        if not isinstance(val, dict):
            continue
        sub = f"{path}.{key}" if path else key
        if "v" in val and "src" in val:
            out.append((sub, val["v"], val["src"]))
        else:
            out.extend(leaves(val, sub))
    return out


def reconstructed() -> list[tuple[str, Any, str]]:
    """Leaves whose provenance is not ``R-1 Table 2``."""
    tree = json.loads(DEFAULT_PARAMS_PATH.read_text())
    return [(p, v, s) for p, v, s in leaves(tree) if s != TABLE2]


def clean_src(src: str) -> str:
    """Drop internal planning tags such as ``(Q-<n>)`` if any remain in a provenance string."""
    return re.sub(r"\s*\(Q-\d+\)", "", src).strip()


def kind(src: str) -> str:
    s = clean_src(src)
    if s.startswith("designed"):
        return "designed"
    if s.startswith("tuned"):
        return "tuned"
    if s.startswith("assumed"):
        return "assumed"
    if s.startswith("optional"):
        return "optional setting"
    return "from the R-1 text"


def _fmt(v: Any) -> str:
    if isinstance(v, list) and v and isinstance(v[0], list):
        return "filter coefficients (see `shared/params/default.json`)"
    if isinstance(v, list):
        return "[" + ", ".join(_fmt(x) for x in v) + "]"
    if isinstance(v, bool):
        return "on" if v else "off"
    if isinstance(v, float):
        return f"{v:.6g}"
    return str(v)


def _meaning(path: str) -> str:
    best = ""
    for key in MEANING:
        if (path == key or path.startswith(key + ".")) and len(key) > len(best):
            best = key
    return MEANING.get(best, "")


def to_markdown() -> str:
    rows = reconstructed()
    lines = [
        "Every parameter that the paper's Table 2 does not give is listed below with where its",
        "value comes from. None of them is an original value from the testbed.",
        "",
        "- **designed**: chosen by this project's own design scripts (PD gains, filter",
        "  coefficients).",
        "- **tuned**: fitted so that the simulation shows the qualitative behaviour of the paper's",
        "  Figs 12 to 14 (AAC gains, filter corners, detection threshold).",
        "- **assumed**: set to a plausible value because the paper gives none.",
        "- **optional setting**: realism options that are off and are not the cause of the",
        "  instability.",
        "- **from the R-1 text**: stated in the paper's text rather than its Table 2.",
        "",
        "| Parameter | Value | Kind | Provenance | Meaning |",
        "|---|---|---|---|---|",
    ]
    for path, val, src in rows:
        lines.append(
            f"| `{path}` | {_fmt(val)} | {kind(src)} | {clean_src(src)} | {_meaning(path)} |"
        )
    lines += [
        "",
        "The simulation reproduces the paper **qualitatively, for teaching**. It is not an exact",
        "reproduction: the numbers in the charts (times, amplitudes, margins) come from this",
        "reconstruction and will differ from the numbers in the paper.",
        "",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--md", action="store_true", help="print the Markdown disclaimer")
    args = ap.parse_args(argv)
    if args.md:
        print(to_markdown())
    else:
        for path, val, src in reconstructed():
            print(f"{path}\t{_fmt(val)}\t{clean_src(src)}")


if __name__ == "__main__":
    main()
