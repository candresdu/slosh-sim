"""Export cross-language fixtures for the TypeScript port.

    cd python && uv run python -m slosh.export fixtures [--out DIR]

Writes ``golden/fixtures/{deriv,mixer,filters,controller,aac,rng}.json``.

    cd python && uv run python -m slosh.export goldens [--out DIR]

``goldens`` writes ``golden/{fig12,fig13,fig14,vb}.json`` (schema ``slosh-golden/1``, 100 Hz
columns including the t = 0 sample, so ``n = durationS * 100 + 1``). Row 0 is the initial state:
AAC at its reset values (k_T = 1, y_SD = 0, no detection) and the motor columns at the
normalized hover command. ``detect_*`` columns are 0/1 integers.
 Every file is
self-contained:

* ``schema``: ``"slosh-fixture/1"``, ``kind``: the file's topic, ``modelVersion``: from the
  parameter file;
* ``params``: the full parameter file (same ``{"v", "src"}`` leaf format as
  ``shared/params/default.json``) the fixture was generated with. TS tests must build their
  parameters from this snapshot, not from the current default. In ``aac.json`` the AAC values
  that are ``null`` in the default file (``a0``, ``b_s``, ``threshold``) are filled with the
  explicit fixture values, which are *not* tuned values;
* ``cases`` or column arrays with inputs and the Python outputs.

Inputs are generated with ``random.Random(seed)`` using only ``random()`` (stable across Python
versions). Floats are written with ``repr`` (shortest round-trip form, up to 17 significant
digits); NaN and infinity are rejected. The output is deterministic, so regenerating gives
byte-identical files.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import random
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from .core.aac import Aac
from .core.controller import Controller, Meas, Ref, euler_zyx
from .core.dynamics import Hold, deriv, mass_relative, theta_phi
from .core.filters import Sos
from .core.initial import pendulum_vectors
from .core.mixer import forces_torques, mix
from .core.rk4 import rk4_step
from .core.rng import Rng
from .core.sim import Sim
from .params import SHARED_DIR, Params, _build, load_params_raw, params_sha256
from .presets import PRESET_IDS, load_preset

SCHEMA = "slosh-fixture/1"
DEFAULT_OUT = SHARED_DIR.parent / "golden" / "fixtures"
GOLDEN_DIR = SHARED_DIR.parent / "golden"
GOLDEN_SCHEMA = "slosh-golden/1"
GOLDEN_GENERATOR = "python -m slosh.export goldens"
GOLDEN_COLUMNS = (
    "t theta phi roll pitch yaw x y z mx my kT_pitch kT_roll ySD_pitch ySD_roll "
    "detect_pitch detect_roll m1 m2 m3 m4"
).split()

N_DERIV = 200
N_RK4 = 20
N_MIX = 100
N_FT = 100
N_CHIRP = 2000
N_CTRL_TICKS = 300
N_AAC_TICKS = 2000
N_RNG = 1000
RNG_SEEDS = (1, 42)

# Explicit AAC values used for aac.json. NOT tuned values; chosen so the detector trips and clears.
AAC_FIXTURE = {"a0": 0.2, "b_s": 2.0, "threshold": 1.0}
AAC_FIXTURE_SRC = "fixture value (explicit, not tuned)"


# --- helpers -----------------------------------------------------------------------------------
def dumps(obj: Any) -> str:
    """Compact JSON; floats via ``repr``; no NaN/inf."""
    return json.dumps(obj, separators=(",", ":"), allow_nan=False, ensure_ascii=True)


def render(doc: dict[str, Any]) -> str:
    """One top-level key per line (readable diffs), compact values."""
    body = ",\n".join(f"{dumps(k)}:{dumps(v)}" for k, v in doc.items())
    return "{\n" + body + "\n}\n"


def _header(kind: str, raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "kind": kind,
        "modelVersion": raw["modelVersion"],
        "params": raw,
    }


def _vec(rng: random.Random, lo: float, hi: float, n: int) -> list[float]:
    return [lo + (hi - lo) * rng.random() for _ in range(n)]


def _quat_from_euler(roll: float, pitch: float, yaw: float) -> list[float]:
    cr, sr = math.cos(roll / 2), math.sin(roll / 2)
    cp, sp = math.cos(pitch / 2), math.sin(pitch / 2)
    cy, sy = math.cos(yaw / 2), math.sin(yaw / 2)
    return [
        cr * cp * cy + sr * sp * sy,
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
    ]


def _random_quat(rng: random.Random) -> list[float]:
    """Uniform random unit quaternion (Shoemake), three uniforms."""
    u1, u2, u3 = rng.random(), rng.random(), rng.random()
    a, b = math.sqrt(1.0 - u1), math.sqrt(u1)
    t2, t3 = 2.0 * math.pi * u2, 2.0 * math.pi * u3
    return [b * math.cos(t3), a * math.sin(t2), a * math.cos(t2), b * math.sin(t3)]


def _random_state(rng: random.Random) -> list[float]:
    """Random 23-element state: theta in [0, 1.2], random attitude, w_p perpendicular to n."""
    theta = 1.2 * rng.random()
    phi = -math.pi + 2.0 * math.pi * rng.random()
    n, _ = pendulum_vectors(theta, 0.0, phi, 0.0)
    w = _vec(rng, -2.0, 2.0, 3)
    d = w[0] * n[0] + w[1] * n[1] + w[2] * n[2]
    w_p = [w[i] - d * n[i] for i in range(3)]
    x = _vec(rng, -1.0, 1.0, 3)  # position
    x += _vec(rng, -2.0, 2.0, 3)  # velocity
    x += _random_quat(rng)
    x += _vec(rng, -1.0, 1.0, 3)  # body rates
    x += list(n)
    x += w_p
    x += _vec(rng, 600.0, 1000.0, 4)  # rotor speeds
    return x


def _random_hold(rng: random.Random) -> Hold:
    return Hold(tau=_vec(rng, -0.1, 0.1, 3), omega_cmd=_vec(rng, 600.0, 1000.0, 4))


def _hold_json(h: Hold) -> dict[str, list[float]]:
    return {"tau": list(h.tau), "omegaCmd": list(h.omega_cmd)}


# --- deriv.json --------------------------------------------------------------------------------
def make_deriv(raw: dict[str, Any]) -> dict[str, Any]:
    p = _build(raw)
    rng = random.Random(20240901)
    deriv_cases = []
    for _ in range(N_DERIV):
        x = _random_state(rng)
        h = _random_hold(rng)
        deriv_cases.append({"x": x, "uHold": _hold_json(h), "dx": deriv(x, h, p)})
    dt = p.sim.dt
    rk4_cases = []
    for _ in range(N_RK4):
        x = _random_state(rng)
        h = _random_hold(rng)
        rk4_cases.append({"x": x, "uHold": _hold_json(h), "dt": dt, "xNext": rk4_step(x, dt, h, p)})
    doc = _header("deriv", raw)
    doc["description"] = (
        "deriv: dx = deriv(x, uHold) for random states. rk4: one rk4_step(x, dt, uHold) "
        "including renormalization. State layout: pos(3) vel(3) quat wxyz(4) w_b(3) n(3) "
        "w_p(3) rotor speeds(4)."
    )
    doc["deriv"] = deriv_cases
    doc["rk4"] = rk4_cases
    return doc


# --- mixer.json --------------------------------------------------------------------------------
def make_mixer(raw: dict[str, Any]) -> dict[str, Any]:
    p = _build(raw)
    rng = random.Random(20240902)
    hover_f = (p.vehicle.m_q + p.pendulum.m_p) * p.sim.g
    mix_cases = []
    for i in range(N_MIX):
        if i < 60:  # moderate, mostly unsaturated
            f = hover_f * (0.8 + 0.4 * rng.random())
            tau = _vec(rng, -0.2, 0.2, 3)
        elif i < 90:  # large torques: saturates the low and/or high clamp
            f = hover_f * (0.5 + 1.0 * rng.random())
            tau = _vec(rng, -3.0, 3.0, 3)
        else:  # extreme thrust and zero thrust
            f = (0.0, 2.0 * hover_f, 100.0, hover_f, 0.0, 3.0 * hover_f, 1.0, 50.0, hover_f, 0.0)[
                i - 90
            ]
            tau = _vec(rng, -0.05, 0.05, 3)
        out = mix(f, tau[0], tau[1], tau[2], p)
        mix_cases.append({"f": f, "tau": tau, "omegaCmd": list(out)})
    ft_cases = []
    for _ in range(N_FT):
        om = _vec(rng, 0.0, 1200.0, 4)
        f, tx, ty, tz = forces_torques(om, p)
        ft_cases.append({"omega": om, "f": f, "tau": [tx, ty, tz]})
    doc = _header("mixer", raw)
    doc["description"] = (
        "mix: omegaCmd = mix(f, tau) with per-motor thrust clamps (cases 60+ saturate). "
        "forcesTorques: (f, tau) = forces_torques(omega)."
    )
    doc["mix"] = mix_cases
    doc["forcesTorques"] = ft_cases
    return doc


# --- filters.json ------------------------------------------------------------------------------
def make_filters(raw: dict[str, Any]) -> dict[str, Any]:
    p = _build(raw)
    f0, f1, rate = 0.05, 5.0, p.control.rateHz
    dt = 1.0 / rate
    t_total = N_CHIRP * dt
    k = (f1 - f0) / t_total
    chirp = [
        math.sin(2.0 * math.pi * (f0 * (n * dt) + 0.5 * k * (n * dt) ** 2)) for n in range(N_CHIRP)
    ]

    def run(sos_rows: Sequence[Sequence[float]]) -> list[float]:
        f = Sos(sos_rows)
        return [f.step(x) for x in chirp]

    hp, lp = p.aac.hp.sos, p.aac.lp.sos
    cases = [
        {"name": "hp", "sos": [list(r) for r in hp], "y": run(hp)},
        {"name": "lp", "sos": [list(r) for r in lp], "y": run(lp)},
        {"name": "hp_then_lp", "sos": [list(r) for r in (*hp, *lp)], "y": run((*hp, *lp))},
        {"name": "identity", "sos": [], "y": run([])},
    ]
    doc = _header("filters", raw)
    doc["description"] = (
        "Chirp input (sine sweep f0 -> f1 Hz over the record, sample rate rateHz) through "
        "direct-form-II-transposed biquad cascades. hp/lp use aac.hp.sos / aac.lp.sos from params."
    )
    doc["chirp"] = {"f0": f0, "f1": f1, "rateHz": rate, "n": N_CHIRP}
    doc["x"] = chirp
    doc["cases"] = cases
    return doc


# --- controller.json ---------------------------------------------------------------------------
def _ctrl_inputs(rng: random.Random, n: int) -> dict[str, list[Any]]:
    """Smooth sinusoidal inputs with random phases plus a few large excursions (saturations)."""
    comps = [(rng.random() * 2 * math.pi, 0.3 + 1.5 * rng.random()) for _ in range(30)]

    def sig(j: int, t: float, amp: float, w: float) -> float:
        ph, fr = comps[j]
        return amp * math.sin(w * fr * t + ph)

    cols: dict[str, list[Any]] = {
        k: [] for k in ("pos", "vel", "q", "wB", "refPos", "refYaw", "gs", "kT")
    }
    for i in range(n):
        t = i * 0.01
        big = 8.0 if 120 <= i < 150 else 1.0  # large error, gs 3, kT 2 -> attitude saturation
        pos = [
            sig(0, t, 0.3, 1.0) + (4.0 if big > 1.0 else 0.0),
            sig(1, t, 0.3, 1.0) - (4.0 if big > 1.0 else 0.0),
            sig(2, t, 0.2 if 250 <= i < 265 else 0.01, 1.0),
        ]
        vel = [sig(3, t, 0.5, 1.5), sig(4, t, 0.5, 1.5), sig(5, t, 0.02, 1.5)]
        roll, pitch = sig(6, t, 0.25, 1.0), sig(7, t, 0.25, 1.0)
        yaw = sig(8, t, 1.2, 0.5)
        if 200 <= i < 215:
            pitch += 0.8  # large tilt: altitude tilt compensation clamp
        cols["pos"].append(pos)
        cols["vel"].append(vel)
        cols["q"].append(_quat_from_euler(roll, pitch, yaw))
        cols["wB"].append([sig(9, t, 0.4, 2.0), sig(10, t, 0.4, 2.0), sig(11, t, 0.2, 2.0)])
        cols["refPos"].append([sig(12, t, 0.2, 0.3), sig(13, t, 0.2, 0.3), sig(14, t, 0.01, 0.3)])
        cols["refYaw"].append(sig(15, t, 0.3, 0.3))
        gs = 0.5 + 2.5 * (0.5 + 0.5 * sig(16, t, 1.0, 0.2))
        kt = [0.2 + 1.8 * (0.5 + 0.5 * sig(17, t, 1.0, 0.4)), 1.0 + sig(18, t, 0.8, 0.4)]
        if big > 1.0:
            gs, kt = 3.0, [2.0, 2.0]
        cols["gs"].append(gs)
        cols["kT"].append(kt)
    return cols


def make_controller(raw: dict[str, Any]) -> dict[str, Any]:
    cases = []
    specs = [
        ("latency0", 0.0, False, 1),
        ("latency30ms", 30.0, False, 1),
        ("latency30ms_noise", 30.0, True, 7),
    ]
    for name, latency, noise, seed in specs:
        case_raw = copy.deepcopy(raw)
        case_raw["sensing"]["latencyMs"]["v"] = latency
        case_raw["sensing"]["noise"]["enabled"]["v"] = noise
        p = _build(case_raw)
        rng = random.Random(20240903)  # same input sequence for every case
        inp = _ctrl_inputs(rng, N_CTRL_TICKS)
        ctrl = Controller(p, seed)
        out: dict[str, list[Any]] = {
            k: []
            for k in ("u", "pitchC", "rollC", "f", "tau", "omegaCmd", "sensedPos", "sensedVel")
        }
        out.update({k: [] for k in ("sensedRoll", "sensedPitch", "sensedYaw", "sensedRates")})
        for i in range(N_CTRL_TICKS):
            meas = Meas(
                tuple(inp["pos"][i]), tuple(inp["vel"][i]), tuple(inp["q"][i]), tuple(inp["wB"][i])
            )
            ref = Ref(tuple(inp["refPos"][i]), inp["refYaw"][i])
            o = ctrl.step(meas, ref, inp["gs"][i], tuple(inp["kT"][i]))
            out["u"].append(list(o.u))
            out["pitchC"].append(o.pitch_c)
            out["rollC"].append(o.roll_c)
            out["f"].append(o.f)
            out["tau"].append(list(o.tau))
            out["omegaCmd"].append(list(o.omega_cmd))
            s = o.sensed
            out["sensedPos"].append(list(s.pos))
            out["sensedVel"].append(list(s.vel))
            out["sensedRoll"].append(s.roll)
            out["sensedPitch"].append(s.pitch)
            out["sensedYaw"].append(s.yaw)
            out["sensedRates"].append(list(s.rates))
        cases.append(
            {
                "name": name,
                "latencyMs": latency,
                "noiseEnabled": noise,
                "seed": seed,
                "inputs": inp,
                "outputs": out,
            }
        )
    doc = _header("controller", raw)
    doc["description"] = (
        "Controller.step sequences. Per case, build the controller with params.sensing.latencyMs = "
        "latencyMs, params.sensing.noise.enabled = noiseEnabled and Controller(seed). Per tick: "
        "meas = (pos, vel, q wxyz, wB), ref = (refPos, refYaw), gs, kT = kT_applied (pitch, roll). "
        "Outputs are CtrlOut fields; sensed* is the measurement used after noise and latency."
    )
    doc["ticks"] = N_CTRL_TICKS
    doc["cases"] = cases
    return doc


# --- aac.json ----------------------------------------------------------------------------------
def _aac_inputs(rng: random.Random, n: int) -> tuple[list[float], list[float]]:
    """0.5 Hz oscillation with an envelope that grows, holds and drops, plus a little noise."""
    u, e = [], []
    for i in range(n):
        t = i * 0.01
        if i < 600:
            env = 4.0 * i / 600.0
        elif i < 900:
            env = 4.0
        else:
            env = 0.1
        u.append(env * math.sin(2.0 * math.pi * 0.5 * t) + 0.05 * (rng.random() - 0.5))
        e.append(0.3 * math.sin(2.0 * math.pi * 0.2 * t + 1.0) + (1.0 if 1200 <= i < 1260 else 0.0))
    return u, e


def make_aac(raw: dict[str, Any]) -> dict[str, Any]:
    raw = copy.deepcopy(raw)
    for k, v in AAC_FIXTURE.items():
        raw["aac"][k] = {"v": v, "src": AAC_FIXTURE_SRC}
    specs: list[tuple[str, list[tuple[int, str]], dict[str, float]]] = [
        ("off", [(0, "off")], {}),
        ("monitor", [(0, "monitor")], {}),
        ("engaged", [(0, "engaged")], {}),
        ("engaged_b_e", [(0, "engaged")], {"b_e": 0.5}),
        (
            "switching",
            [(0, "off"), (100, "monitor"), (700, "engaged"), (1300, "monitor"), (1600, "off")],
            {},
        ),
        ("switching_ramp", [(0, "monitor"), (300, "engaged"), (1000, "off")], {"engageRampS": 2.0}),
    ]
    cases = []
    for name, schedule, over in specs:
        case_raw = copy.deepcopy(raw)
        if "engageRampS" in over:
            case_raw["aac"]["engageRampS"]["v"] = over["engageRampS"]
        p: Params = _build(case_raw)
        b_e = over.get("b_e")
        aac = Aac(p, b_e=b_e)
        u, e = _aac_inputs(random.Random(20240904), N_AAC_TICKS)
        sched = dict(schedule)
        mode = "off"
        cols: dict[str, list[Any]] = {
            k: [] for k in ("kT", "kTApplied", "ySD", "detect", "tripEdge")
        }
        for i in range(N_AAC_TICKS):
            mode = sched.get(i, mode)
            o = aac.step(u[i], e[i], mode)
            cols["kT"].append(o.kT)
            cols["kTApplied"].append(o.kT_applied)
            cols["ySD"].append(o.ySD)
            cols["detect"].append(o.detect)
            cols["tripEdge"].append(o.trip_edge)
        cases.append(
            {
                "name": name,
                "modeSchedule": [[t, m] for t, m in schedule],
                "bE": aac.b_e,
                "engageRampS": p.aac.engageRampS,
                "u": u,
                "eRef": e,
                "outputs": cols,
            }
        )
    doc = _header("aac", raw)
    doc["description"] = (
        "Aac.step(u, eRef, mode) sequences, one Aac instance per case (single axis). Build with "
        "params (a0, b_s, threshold are explicit fixture values, not tuned), b_e = bE and "
        "aac.engageRampS = engageRampS. modeSchedule lists [tick, mode] changes; the mode holds "
        "until the next change."
    )
    doc["ticks"] = N_AAC_TICKS
    doc["cases"] = cases
    return doc


# --- rng.json ----------------------------------------------------------------------------------
def make_rng(raw: dict[str, Any]) -> dict[str, Any]:
    seeds = []
    for seed in RNG_SEEDS:
        r = Rng(seed)
        u32 = [r.next_u32() for _ in range(N_RNG)]
        r2 = Rng(seed)
        normals = [r2.normal() for _ in range(N_RNG)]
        seeds.append({"seed": seed, "u32": u32, "normals": normals})
    doc = _header("rng", raw)
    doc["description"] = (
        "First 1000 next_u32() values and, from a fresh generator with the same seed, the first "
        "1000 normal() values. The integer stream must match exactly; normals may differ in the "
        "last ulp (log/sin/cos)."
    )
    doc["seeds"] = seeds
    return doc


# --- golden traces -----------------------------------------------------------------------------
def git_sha() -> str | None:
    """Short git sha of the repository, or None when unavailable."""
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=SHARED_DIR,
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.strip() or None


def golden_columns(preset_id: str) -> tuple[dict[str, list[float]], float]:
    """Run the preset for its durationS; return (columns, durationS). Row 0 is t = 0."""
    p = _build(copy.deepcopy(load_params_raw()))
    pre = load_preset(preset_id)
    sim = Sim(p)
    sim.enqueue({"type": "loadPreset", "id": preset_id})
    sim.apply_commands()  # loads the preset and applies its t = 0 events
    cols: dict[str, list[float]] = {k: [] for k in GOLDEN_COLUMNS}

    x = sim.state
    theta, phi = theta_phi(x)
    mx, my, _ = mass_relative(x, p.pendulum.L)
    roll, pitch, yaw = euler_zyx(x[6:10])
    hover = (x[19] - p.motor.omegaMin) / (p.motor.omegaMax - p.motor.omegaMin)
    row0: dict[str, float] = {
        "t": 0.0, "theta": theta, "phi": phi, "roll": roll, "pitch": pitch, "yaw": yaw,
        "x": x[0], "y": x[1], "z": x[2], "mx": mx, "my": my,
        "kT_pitch": 1.0, "kT_roll": 1.0, "ySD_pitch": 0.0, "ySD_roll": 0.0,
        "detect_pitch": 0, "detect_roll": 0,
        "m1": hover, "m2": hover, "m3": hover, "m4": hover,
    }  # fmt: skip
    for k in GOLDEN_COLUMNS:
        cols[k].append(row0[k])

    for _ in range(round(pre.durationS / sim.dt_ctrl)):
        tel = sim.step_control()
        for k in GOLDEN_COLUMNS:
            v = tel[k]
            cols[k].append(int(v) if k.startswith("detect_") else v)
    return cols, pre.durationS


def make_golden(preset_id: str, with_sha: bool = True) -> dict[str, Any]:
    raw = load_params_raw()
    cols, duration = golden_columns(preset_id)
    sha = git_sha() if with_sha else None
    gen = GOLDEN_GENERATOR + (f" (git {sha})" if sha else "")
    return {
        "schema": GOLDEN_SCHEMA,
        "modelVersion": raw["modelVersion"],
        "paramsSha256": params_sha256(raw),
        "preset": preset_id,
        "generator": gen,
        "dt": 0.01,
        "n": round(duration * 100) + 1,
        "columns": cols,
    }


def render_golden(doc: dict[str, Any]) -> str:
    """Header keys one per line, then one line per column."""
    head = [f"{dumps(k)}:{dumps(v)}" for k, v in doc.items() if k != "columns"]
    cols = ",\n".join(f"{dumps(k)}:{dumps(v)}" for k, v in doc["columns"].items())
    return "{\n" + ",\n".join(head) + ',\n"columns":{\n' + cols + "\n}\n}\n"


def export_goldens(out_dir: Path, with_sha: bool = True) -> list[Path]:
    """Write ``<id>.json`` for each preset into ``out_dir`` (created if needed)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for pid in PRESET_IDS:
        path = out_dir / f"{pid}.json"
        path.write_text(render_golden(make_golden(pid, with_sha)), encoding="utf-8", newline="\n")
        paths.append(path)
    return paths


# --- CLI ---------------------------------------------------------------------------------------
BUILDERS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "deriv": make_deriv,
    "mixer": make_mixer,
    "filters": make_filters,
    "controller": make_controller,
    "aac": make_aac,
    "rng": make_rng,
}


def export_fixtures(out_dir: Path) -> list[Path]:
    """Write all fixture files into ``out_dir`` (created if needed); return their paths."""
    out_dir.mkdir(parents=True, exist_ok=True)
    raw = load_params_raw()
    paths = []
    for name, build in BUILDERS.items():
        path = out_dir / f"{name}.json"
        path.write_text(render(build(copy.deepcopy(raw))), encoding="utf-8", newline="\n")
        paths.append(path)
    return paths


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m slosh.export", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    fx = sub.add_parser("fixtures", help="write per-module cross-language fixtures")
    fx.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output directory")
    gd = sub.add_parser("goldens", help="write golden traces for all presets")
    gd.add_argument("--out", type=Path, default=GOLDEN_DIR, help="output directory")
    args = ap.parse_args(argv)
    if args.cmd == "goldens":
        for path in export_goldens(args.out):
            print(f"wrote {path} ({path.stat().st_size} bytes)")
    if args.cmd == "fixtures":
        for path in export_fixtures(args.out):
            print(f"wrote {path} ({path.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
