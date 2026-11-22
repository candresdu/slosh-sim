"""Article figures, generated from this project's own reconstruction model.

    cd python && uv run python -m slosh.figures --out ../blog/images

Writes ``nichols_outer.png``, ``fig12_like.png``, ``fig13_like.png``, ``fig14_like.png``,
``vb_sequence.png``, ``story_sequence.png`` and ``architecture.svg``. The extra image,
``slosh-fallback.png``, is a browser screenshot taken by ``web/e2e/scripts/fallback-shot.ts``
and is not touched here.

No figure from R-1 and no testbed photo is reproduced. The R-1 Table 1 margins appear only as
numeric reference points. Colours are the Okabe-Ito colour-blind-safe palette.
"""

from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path
from typing import Any

import numpy as np

from .design.linearize import outer_loop_ss
from .design.margins import TABLE1, analyze_axis, default_grid, freq_response
from .params import load_params

ROOT = Path(__file__).resolve().parents[3]
GOLDEN_DIR = ROOT / "golden"
MARGINS_MD = ROOT / "reports" / "margins.md"

# Okabe-Ito
BLUE, ORANGE, GREEN, VERMILION = "#0072B2", "#E69F00", "#009E73", "#D55E00"
SKY, PURPLE, BLACK, GREY = "#56B4E9", "#CC79A7", "#000000", "#666666"

SOURCE_NOTE = "Reconstruction model (generated), not R-1 data"


def _mpl() -> Any:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams.update(
        {
            "font.size": 10,
            "axes.grid": True,
            "grid.alpha": 0.3,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "savefig.dpi": 160,
        }
    )
    return plt


def load_golden(name: str) -> dict[str, np.ndarray]:
    d = json.loads((GOLDEN_DIR / f"{name}.json").read_text())
    return {k: np.asarray(v, dtype=float) for k, v in d["columns"].items()}


def margins_from_report(path: Path = MARGINS_MD) -> dict[str, float]:
    """Designed PM / HF GM values as printed in ``reports/margins.md`` (pitch channel, x)."""
    text = path.read_text()

    def row(label: str) -> str:
        m = re.search(rf"^\| {re.escape(label)}[^|]*\|[^|]*\|\s*([^|]+?)\s*\|", text, re.M)
        if m is None:
            raise ValueError(f"row {label!r} not found in {path}")
        return m.group(1)

    num = lambda s: float(re.match(r"[-+0-9.eE]+", s).group(0))  # noqa: E731
    return {
        "pm_deg": num(row("Phase margin [deg]")),
        "pm_hz": num(row("Gain crossover [Hz]")),
        "hf_gm": num(row("HF gain margin [ratio (dB)]")),
        "hf_hz": num(row("HF GM frequency [Hz]")),
    }


# --- 1. Nichols chart -------------------------------------------------------------------------
def fig_nichols(out: Path) -> None:
    plt = _mpl()
    p = load_params()
    L = outer_loop_ss("x", p)
    rep = analyze_axis("x", p)
    rm = margins_from_report()
    # the report and the live model must agree to the precision printed in the report
    assert rep.pm_deg is not None and abs(rep.pm_deg - rm["pm_deg"]) < 0.06, (rep.pm_deg, rm)
    assert rep.hf_gm is not None and abs(rep.hf_gm - rm["hf_gm"]) < 0.006, (rep.hf_gm, rm)

    w = default_grid(L)
    Lw = freq_response(L, w)
    ph = np.degrees(np.unwrap(np.angle(Lw)))
    ph = ph + (((ph[0] + 360.0) % 360.0) - 360.0 - ph[0])
    mag = 20 * np.log10(np.abs(Lw))

    fig, ax = plt.subplots(figsize=(7.2, 6.2))
    ax.plot(ph, mag, color=BLUE, lw=1.6, label="Designed outer loop L(jw), gain shift 1")
    ax.plot(-180, 0, "+", color=VERMILION, ms=16, mew=2.5, label="Critical point (-180 deg, 0 dB)")
    gs = rep.slosh_threshold or rep.gs_threshold
    if gs:
        ax.plot(
            ph,
            mag + 20 * np.log10(gs),
            "--",
            color=ORANGE,
            lw=1.2,
            label=f"Gain shift {gs:.2f}: slosh mode just unstable",
        )

    # designed margins
    pm = rm["pm_deg"]
    ax.plot(-180 + pm, 0, "o", color=BLUE, ms=8)
    ax.annotate(
        f"Designed PM {pm:.1f} deg\nat {rm['pm_hz']:.3f} Hz",
        (-180 + pm, 0),
        (-350, 38),
        color=BLUE,
        arrowprops={"arrowstyle": "-", "color": BLUE},
    )
    gm_db = -20 * math.log10(rm["hf_gm"])
    ax.plot(-180, gm_db, "s", color=BLUE, ms=8)
    ax.annotate(
        f"Designed HF GM {rm['hf_gm']:.2f} ({-gm_db:.1f} dB)\nat {rm['hf_hz']:.3f} Hz",
        (-180, gm_db),
        (-350, 18),
        color=BLUE,
        arrowprops={"arrowstyle": "-", "color": BLUE},
    )

    # Table 1 reference points (numeric targets only)
    t_pm, t_gm = TABLE1["pm_deg"], TABLE1["hf_gm"]
    ax.plot(
        -180 + t_pm,
        0,
        "D",
        mfc="none",
        color=GREEN,
        ms=9,
        mew=2,
        label=f"R-1 target PM {t_pm:.0f} deg at {TABLE1['pm_hz']} Hz",
    )
    ax.plot(
        -180,
        -20 * math.log10(t_gm),
        "D",
        mfc="none",
        color=PURPLE,
        ms=9,
        mew=2,
        label=f"R-1 target GM {t_gm} at {TABLE1['hf_hz']} Hz",
    )

    ax.set_xlim(-360, 0)
    ax.set_ylim(-40, 55)
    ax.set_xlabel("Phase [deg]")
    ax.set_ylabel("Magnitude [dB]")
    ax.set_title(
        "Outer-loop Nichols chart (pitch channel): designed gains vs R-1 Table 1 targets",
        fontsize=10,
    )
    ax.legend(fontsize=8, loc="upper center", bbox_to_anchor=(0.5, -0.12), ncol=2)
    fig.text(
        0.01, 0.01, f"{SOURCE_NOTE}. Designed GM is deliberately below 2.0.", fontsize=7, color=GREY
    )
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(out / "nichols_outer.png")
    plt.close(fig)


# --- 2. Fig 12/13/14-like ---------------------------------------------------------------------
def _theta_kt(name: str, title: str, out_name: str, out: Path, *, show_kt: bool, note: str) -> None:
    plt = _mpl()
    g = load_golden(name)
    t = g["t"]
    fig, (a1, a2) = plt.subplots(
        2, 1, figsize=(7.2, 5.0), sharex=True, gridspec_kw={"height_ratios": [1.3, 1]}
    )
    a1.plot(t, g["theta"], color=BLUE, lw=1.3, label="pendulum angle theta")
    a1.axhline(0.05, color=GREY, ls=":", lw=1)
    a1.text(t[-1], 0.05, " 0.05 rad", va="bottom", ha="right", fontsize=8, color=GREY)
    trips = [
        (ax_name, t[np.argmax(g[f"detect_{ax_name}"] > 0)])
        for ax_name in ("pitch", "roll")
        if np.any(g[f"detect_{ax_name}"] > 0)
    ]
    for k, (ax_name, tt) in enumerate(trips):
        a1.axvline(
            tt,
            color=VERMILION,
            ls="--" if k == 0 else "-.",
            lw=1,
            label=f"detector trips ({ax_name}) t = {tt:.1f} s",
        )
    a1.set_ylabel("theta [rad]")
    a1.set_ylim(bottom=0)
    a1.legend(fontsize=8, loc="upper right")
    a1.set_title(title, fontsize=10)

    a2.plot(t, g["kT_pitch"], color=ORANGE, lw=1.4, label="K_T pitch")
    a2.plot(t, g["kT_roll"], color=GREEN, lw=1.4, ls="--", label="K_T roll")
    a2.axhline(1.0, color=GREY, ls=":", lw=1)
    a2.set_ylabel("K_T state")
    a2.set_xlabel("Time [s]")
    a2.set_xlim(0, t[-1])
    a2.legend(fontsize=8, loc="lower right")
    if not show_kt:
        a2.text(
            0.5,
            0.88,
            "AAC not applied (K_T computed but not used)",
            transform=a2.transAxes,
            ha="center",
            fontsize=8,
            color=GREY,
        )
    fig.text(0.01, 0.01, f"{SOURCE_NOTE}. {note}", fontsize=7, color=GREY)
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(out / out_name)
    plt.close(fig)


# --- 3. Section V.B sequence ------------------------------------------------------------------
def fig_vb(out: Path) -> None:
    plt = _mpl()
    g = load_golden("vb")
    t = g["t"]
    raw = json.loads((ROOT / "shared" / "presets" / "vb.json").read_text())
    ev = {e["type"]: e for e in raw["events"]}
    gs0 = float(raw["initial"]["gainShift"])
    ramp, engage = ev["rampGainShift"], ev["setAacMode"]
    gs = np.where(
        t >= ramp["t"] + ramp["durationS"],
        ramp["to"],
        gs0 + (ramp["to"] - gs0) * np.clip((t - ramp["t"]) / ramp["durationS"], 0, 1),
    )
    t_eng = float(engage["t"])

    fig, axs = plt.subplots(3, 1, figsize=(7.2, 6.6), sharex=True)
    axs[0].plot(t, g["theta"], color=BLUE, lw=1.2, label="pendulum angle theta")
    axs[0].axhline(0.35, color=GREY, ls=":", lw=1)
    axs[0].text(0.5, 0.35, "0.35 rad (about 20 deg)", va="bottom", fontsize=8, color=GREY)
    axs[0].set_ylabel("theta [rad]")
    axs[0].set_ylim(bottom=0)
    axs[1].plot(t, gs, color=PURPLE, lw=1.6)
    axs[1].set_ylabel("Gain shift")
    axs[2].plot(t, g["kT_pitch"], color=ORANGE, lw=1.4, label="K_T pitch")
    axs[2].plot(t, g["kT_roll"], color=GREEN, lw=1.4, ls="--", label="K_T roll")
    axs[2].axhline(1.0, color=GREY, ls=":", lw=1)
    axs[2].set_ylabel("K_T state")
    axs[2].set_xlabel("Time [s]")
    axs[2].set_xlim(0, t[-1])
    for a in axs:
        a.axvline(t_eng, color=VERMILION, lw=1.4, ls="--")
    axs[0].text(
        t_eng - 1.5,
        axs[0].get_ylim()[1] * 0.92,
        "AAC engaged\nt = 100 s",
        color=VERMILION,
        ha="right",
        va="top",
        fontsize=8,
    )
    axs[0].set_title(
        "Flight-test-style sequence: AAC in Monitor, then Engaged at t = 100 s", fontsize=10
    )
    axs[2].legend(fontsize=8, loc="lower left")
    fig.text(
        0.01,
        0.01,
        f"{SOURCE_NOTE}. K_T is computed but not applied before t = 100 s.",
        fontsize=7,
        color=GREY,
    )
    fig.tight_layout(rect=(0, 0.025, 1, 1))
    fig.savefig(out / "vb_sequence.png")
    plt.close(fig)


# --- 3b. Story sequence -----------------------------------------------------------------------
def fig_story(out: Path) -> None:
    """Nominal -> Gain shift -> AAC engaged as one continuous flight (golden trace ``story``)."""
    plt = _mpl()
    g = load_golden("story")
    t = g["t"]
    raw = json.loads((ROOT / "shared" / "presets" / "story.json").read_text())
    t_shift = float(next(e["t"] for e in raw["events"] if e["type"] == "rampGainShift"))
    t_eng = float(
        next(e["t"] for e in raw["events"] if e["type"] == "setAacMode" and e["mode"] == "engaged")
    )
    trips = [
        t[np.argmax(g[f"detect_{a}"] > 0)]
        for a in ("pitch", "roll")
        if np.any(g[f"detect_{a}"] > 0)
    ]
    t_trip = min(trips) if trips else None

    fig, (a1, a2) = plt.subplots(
        2, 1, figsize=(7.2, 5.0), sharex=True, gridspec_kw={"height_ratios": [1.3, 1]}
    )
    for a in (a1, a2):
        a.axvspan(0, t_shift, color=SKY, alpha=0.12, lw=0)
        a.axvspan(t_shift, t_eng, color=ORANGE, alpha=0.14, lw=0)
        a.axvspan(t_eng, t[-1], color=GREEN, alpha=0.12, lw=0)
        a.axvline(t_shift, color=BLACK, lw=1)
        a.axvline(t_eng, color=BLACK, lw=1)
        if t_trip is not None:
            a.axvline(t_trip, color=VERMILION, ls="--", lw=1.2)
    a1.plot(t, g["theta"], color=BLUE, lw=1.3)
    a1.set_ylabel("theta [rad]")
    a1.set_ylim(0, 0.4)
    top = 0.39
    a1.text(t_shift / 2, top, "Nominal\n(Fig 12)", ha="center", va="top", fontsize=8)
    a1.text(
        (t_shift + t_eng) / 2, top, "Gain shift x2.3\n(Fig 13)", ha="center", va="top", fontsize=8
    )
    a1.text((t_eng + t[-1]) / 2, top, "AAC engaged\n(Fig 14)", ha="center", va="top", fontsize=8)
    if t_trip is not None:
        a1.text(
            t_trip + 0.4, 0.02, f"detector trips\nt = {t_trip:.1f} s", color=VERMILION, fontsize=8
        )
    a1.set_title("Story: one continuous flight, three regimes", fontsize=10)
    a2.plot(t, g["kT_pitch"], color=ORANGE, lw=1.4, label="K_T pitch")
    a2.plot(t, g["kT_roll"], color=GREEN, lw=1.4, ls="--", label="K_T roll")
    a2.axhline(1.0, color=GREY, ls=":", lw=1)
    a2.set_ylabel("K_T state")
    a2.set_xlabel("Time [s]")
    a2.set_xlim(0, t[-1])
    a2.set_ylim(0, 1.4)
    a2.text(
        (t_shift + t_eng) / 2,
        1.22,
        "K_T computed,\nnot applied",
        ha="center",
        fontsize=8,
        color=GREY,
    )
    a2.legend(fontsize=8, loc="upper right")
    fig.text(
        0.01,
        0.01,
        f"{SOURCE_NOTE}. Story preset; K_T is applied only after engagement.",
        fontsize=7,
        color=GREY,
    )
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(out / "story_sequence.png")
    plt.close(fig)


# --- 4. Architecture diagram ------------------------------------------------------------------
def architecture_svg() -> str:
    W, H = 900, 380
    box = 'stroke="#000" stroke-width="1.6" rx="6"'
    t = 'font-family="Helvetica, Arial, sans-serif" text-anchor="middle"'

    def rect(x: int, y: int, w: int, h: int, label: list[str], fill: str = "#fff") -> str:
        s = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" {box} fill="{fill}"/>'
        for i, ln in enumerate(label):
            ty = y + h / 2 + (i - (len(label) - 1) / 2) * 16 + 5
            s += f'<text x="{x + w / 2}" y="{ty}" font-size="14" {t}>{ln}</text>'
        return s

    def arrow(x1: int, y1: int, x2: int, y2: int, color: str = "#000", dash: str = "") -> str:
        d = f' stroke-dasharray="{dash}"' if dash else ""
        return (
            f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" '
            f'stroke-width="1.8"{d} marker-end="url(#a{color[1:]})"/>'
        )

    def marker(color: str) -> str:
        return (
            f'<marker id="a{color[1:]}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" '
            f'markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" '
            f'fill="{color}"/></marker>'
        )

    y = 120
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
        'role="img" aria-labelledby="t d">',
        '<title id="t">Control architecture of the slosh testbed simulation</title>',
        '<desc id="d">Reference minus measured position feeds an outer PD, multiplied by gain '
        "shift and the adaptive gain K_T, then an inner attitude PD, a motor mixer and the quad "
        "with a hanging pendulum. A spectral damper on the control signal drives the adaptive "
        "law that sets K_T. Quad position and attitude are fed back; the pendulum is not "
        "measured.</desc>",
        "<defs>" + marker("#000000") + marker("#D55E00") + marker("#0072B2") + "</defs>",
        f'<rect width="{W}" height="{H}" fill="#fff"/>',
        rect(20, y, 90, 50, ["Outer PD", "(position)"]),
        rect(155, y + 5, 90, 40, ["Gain shift"], "#F4E9F0"),
        rect(285, y + 5, 70, 40, ["K_T"], "#FBF0D5"),
        rect(400, y, 90, 50, ["Inner PD", "(attitude)"]),
        rect(535, y, 80, 50, ["Mixer", "+ motors"]),
        rect(
            660,
            y - 20,
            215,
            90,
            ["Quad + hanging", "pendulum (m = 0.05 kg,", "L = 1 m)"],
            "#E8F2FA",
        ),
        f'<text x="65" y="{y - 14}" font-size="12" {t}>x_ref - x</text>',
        arrow(0, y + 25, 20, y + 25),
        arrow(110, y + 25, 155, y + 25),
        arrow(245, y + 25, 285, y + 25),
        arrow(355, y + 25, 400, y + 25),
        f'<text x="378" y="{y + 15}" font-size="11" {t}>u</text>',
        arrow(490, y + 25, 535, y + 25),
        arrow(615, y + 25, 660, y + 25),
        f'<text x="638" y="{y + 15}" font-size="11" {t}>w1..4</text>',
    ]
    # feedback: quad position/velocity/attitude/rates
    fy = 290
    parts += [
        f'<polyline points="767,{y + 70} 767,{fy} 65,{fy} 65,{y + 50}" fill="none" '
        'stroke="#000" stroke-width="1.8" marker-end="url(#a000000)"/>',
        f'<text x="416" y="{fy + 20}" font-size="12" {t}>measured: quad position, velocity, '
        "attitude, rates (the pendulum is never measured)</text>",
        f'<polyline points="445,{fy} 445,{y + 50}" fill="none" stroke="#000" stroke-width="1.4" '
        'stroke-dasharray="5 4" marker-end="url(#a000000)"/>',
    ]
    # AAC branch: spectral damper on control signal -> adaptive law -> K_T
    parts += [
        rect(190, 20, 150, 44, ["Adaptive law", "dk_T/dt = ..."], "#FBF0D5"),
        rect(400, 20, 140, 44, ["Spectral damper", "y_SD (0.5 Hz band)"], "#FBF0D5"),
        f'<polyline points="378,{y + 25} 378,52 400,52" fill="none" stroke="#D55E00" '
        'stroke-width="1.8" stroke-dasharray="6 4" marker-end="url(#aD55E00)"/>',
        arrow(400, 32, 340, 32, "#D55E00"),
        arrow(320, 64, 320, y + 5, "#0072B2"),
        f'<text x="640" y="40" font-size="12" {t}>Pitch channel shown;</text>',
        f'<text x="640" y="56" font-size="12" {t}>roll has the same structure</text>',
        f'<text x="{W / 2}" y="{H - 8}" font-size="10" fill="#666" {t}>{SOURCE_NOTE}</text>',
        "</svg>",
    ]
    return "\n".join(parts) + "\n"


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, required=True, help="output directory (blog/images)")
    out = ap.parse_args(argv).out
    out.mkdir(parents=True, exist_ok=True)

    fig_nichols(out)
    _theta_kt(
        "fig12",
        "Gain shift 1, AAC off: the slosh oscillation decays",
        "fig12_like.png",
        out,
        show_kt=False,
        note="Preset Fig 12.",
    )
    _theta_kt(
        "fig13",
        "Gain shift 2.3, AAC off: the slosh oscillation grows",
        "fig13_like.png",
        out,
        show_kt=False,
        note="Preset Fig 13 (AAC in Monitor).",
    )
    _theta_kt(
        "fig14",
        "Gain shift 2.3, AAC engaged: K_T drops and suppresses the slosh",
        "fig14_like.png",
        out,
        show_kt=True,
        note="Preset Fig 14.",
    )
    fig_vb(out)
    fig_story(out)
    (out / "architecture.svg").write_text(architecture_svg())
    print(f"wrote figures to {out}")


if __name__ == "__main__":
    main()
