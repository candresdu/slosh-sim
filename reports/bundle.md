# Bundle size report

Budget (NFR-5): `dist/slosh-sim.js`, including Three.js and uPlot, must be under 400 KB gzipped.
Enforced by `size-limit` (`web/.size-limit.json`, `npm run size`) in the CI `web` job after the build.

## Measured

| File | Raw | Gzip (size-limit) | Budget |
|---|---|---|---|
| `dist/slosh-sim.js` | 816.6 kB | **198.15 kB** | 400 KB |

Vite's own gzip estimate for the same file is 200.49 kB. The budget passes with about 50 % headroom.
Sizes are decimal kB as printed by the tools.

## Top 5 contributors

Per-module figures from `npm run analyze` (rollup-plugin-visualizer, raw-data output in `web/dist-dev/stats.json`).
Gzip is measured per module part, so the numbers sum to slightly more than the bundle's real gzip.

| # | Module | Rendered | Gzip |
|---|---|---|---|
| 1 | `three/build/three.module.js` | 540.9 kB | 100.1 kB |
| 2 | `three/build/three.core.js` | 317.3 kB | 64.8 kB |
| 3 | `uplot/dist/uPlot.esm.js` | 121.6 kB | 32.4 kB |
| 4 | `three/examples/jsm/controls/OrbitControls.js` | 27.6 kB | 5.1 kB |
| 5 | `src/view/charts.ts` | 13.1 kB | 4.5 kB |

By package: Three.js about 170 kB, uPlot about 33 kB, project source (core, view, element) about 37 kB.

## Reproduce

```sh
cd web && npm run build && npm run size   # budget check
cd web && npm run analyze                 # writes dist-dev/stats.json (per-module breakdown)
```

## Notes

No reduction was needed. The only Three.js addon in use is OrbitControls, and the scene already uses named imports.
If the budget is ever approached, the first lever is Three.js, which is 85 % of the bundle.
