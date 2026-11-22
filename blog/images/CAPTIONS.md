# Figure captions

Every image in this folder is generated from this project's reconstruction model (Python reference model and
the `<slosh-sim>` component). None reproduces an R-1 figure or a testbed photo. Regenerate the PNG and SVG
files with `cd python && uv run python -m slosh.figures --out ../blog/images`; the fallback screenshot with
`cd web && npm run build && node --experimental-strip-types e2e/scripts/fallback-shot.ts`.
Colours follow the Okabe-Ito colour-blind-safe palette.

## nichols_outer.png

Outer-loop Nichols chart of the designed (reconstructed) PD gains, pitch channel, with the designed phase
margin and high-frequency gain margin annotated. The R-1 Table 1 targets (PM 22 deg at 0.2 Hz, GM 2.6 at
0.525 Hz) are drawn as open diamonds for comparison only. The designed gain margin is deliberately below 2.0
so that the slosh mode goes unstable inside the slider range. Generated from the reconstruction model
(values from `reports/margins.md`), not from R-1 data.

## fig12_like.png

Pendulum angle and adaptive gain K_T over 30 s at gain shift 1 with the AAC off: the slosh oscillation decays
and the detector does not trip. Generated from the reconstruction model (golden trace `fig12`), a qualitative
counterpart of R-1 Fig 12, not R-1 data.

## fig13_like.png

Pendulum angle and K_T over 60 s at gain shift 2.3 with the AAC not applied (K_T computed in Monitor mode
only): the oscillation grows and does not recover, and the detector trips early. Generated from the
reconstruction model (golden trace `fig13`), a qualitative counterpart of R-1 Fig 13, not R-1 data.

## fig14_like.png

Pendulum angle and K_T at gain shift 2.3 with the AAC engaged: K_T drops on both axes (pitch lower than roll),
the oscillation is suppressed, and K_T then recovers toward 1. Generated from the reconstruction model
(golden trace `fig14`), a qualitative counterpart of R-1 Fig 14, not R-1 data.

## vb_sequence.png

Flight-test-style sequence: the gain shift ramps from 1 to 2 over 20 s with the AAC in Monitor, slosh grows,
and the AAC is engaged at t = 100 s (marked), after which the angle falls and K_T acts. Generated from the
reconstruction model (golden trace `vb`), a qualitative counterpart of the R-1 section V.B test sequence,
not R-1 data.

## story_sequence.png

The story run as one continuous flight (golden trace `story`): pendulum angle and K_T through Nominal
(Fig 12-like), Gain shift 2.3 with the AAC in Monitor (Fig 13-like) and AAC engaged (Fig 14-like), with
regime shading, the transition lines and the detector trip marked. Generated from the reconstruction model,
not R-1 data.

## architecture.svg

Control architecture of the simulation: outer position PD, gain shift and K_T in the outer forward path,
inner attitude PD, motor mixer, and the quad with its hanging pendulum. A spectral damper on the control
signal drives the adaptive law that sets K_T; only quad states are fed back, never the pendulum. Drawn by this
project's figure script (`slosh.figures`) from the reconstruction model's structure, not copied from R-1.

## slosh-fallback.png

Static fallback image (1280x720) shown when WebGL is unavailable: a screenshot of the `<slosh-sim>` component
at the Fig 13 preset at t = 20 s (gain shift 2.3, growing slosh), taken with
`web/e2e/scripts/fallback-shot.ts`. Generated from the reconstruction model running in the component, not a
photo of the testbed.
