"""Spectral-damper filter design (Tustin / bilinear transform) at the controller rate.

* HP: 2nd-order Butterworth, corner ``aac.hp.fc`` (default 0.3 Hz).
* LP: 1st-order, corner ``aac.lp.fc`` (default 0.1 Hz), stored as a biquad with ``b2 = a2 = 0``.

Coefficients ``[b0, b1, b2, a1, a2]`` (``a0 = 1``) are written into ``aac.hp.sos`` and
``aac.lp.sos`` of ``shared/params/default.json`` so both runtimes use identical values.

CLI: ``python -m slosh.design.filter_design --write``.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from scipy import signal

from ..params import DEFAULT_PARAMS_PATH


def _warp(fc: float, fs: float) -> float:
    """Analog corner [rad/s] pre-warped so the digital -3 dB point lands at ``fc``."""
    return 2.0 * fs * math.tan(math.pi * fc / fs)


def _row(b: list[float], a: list[float], n: int) -> list[float]:
    """Pad a numerator/denominator pair of order ``n`` to a biquad row (b0,b1,b2,a1,a2)."""
    a0 = float(a[0])
    bb = [float(v) / a0 for v in b] + [0.0] * (3 - len(b))
    aa = [float(v) / a0 for v in a] + [0.0] * (3 - len(a))
    assert len(b) == n + 1 and len(a) == n + 1
    return [bb[0], bb[1], bb[2], aa[1], aa[2]]


def design_hp(fc: float, fs: float) -> list[list[float]]:
    """2nd-order Butterworth high-pass via the bilinear transform."""
    wc = _warp(fc, fs)
    b, a = signal.butter(2, wc, btype="highpass", analog=True)
    bd, ad = signal.bilinear(b, a, fs=fs)
    return [_row(list(bd), list(ad), 2)]


def design_lp(fc: float, fs: float) -> list[list[float]]:
    """1st-order low-pass via the bilinear transform, stored as a biquad (b2 = a2 = 0)."""
    wc = _warp(fc, fs)
    b, a = signal.butter(1, wc, btype="lowpass", analog=True)
    bd, ad = signal.bilinear(b, a, fs=fs)
    return [_row(list(bd), list(ad), 1)]


Rows = list[list[float]]


def design_all(hp_fc: float, lp_fc: float, fs: float) -> tuple[Rows, Rows]:
    return design_hp(hp_fc, fs), design_lp(lp_fc, fs)


def write_params(path: Path = DEFAULT_PARAMS_PATH) -> bool:
    """Recompute the coefficients and write them into the params file; True if it changed."""
    text = path.read_text()
    data = json.loads(text)
    ctrl = data["control"] if "control" in data else None
    fs = float(ctrl["rateHz"]["v"]) if ctrl is not None else 100.0
    aac = data["aac"]
    hp, lp = design_all(float(aac["hp"]["fc"]["v"]), float(aac["lp"]["fc"]["v"]), fs)
    aac["hp"]["sos"]["v"] = hp
    aac["lp"]["sos"]["v"] = lp
    new = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    if new == text:
        return False
    path.write_text(new)
    return True


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--write", action="store_true", help="write coefficients into default.json")
    ap.add_argument("--params", type=Path, default=DEFAULT_PARAMS_PATH)
    args = ap.parse_args(argv)
    if args.write:
        changed = write_params(args.params)
        print(f"{args.params}: {'updated' if changed else 'unchanged'}")
    else:
        data = json.loads(args.params.read_text())
        fs = float(data["control"]["rateHz"]["v"])
        hp, lp = design_all(
            float(data["aac"]["hp"]["fc"]["v"]), float(data["aac"]["lp"]["fc"]["v"]), fs
        )
        print(json.dumps({"hp": hp, "lp": lp}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
