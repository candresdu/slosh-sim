Every parameter that the paper's Table 2 does not give is listed below with where its
value comes from. None of them is an original value from the testbed.

- **designed**: chosen by this project's own design scripts (PD gains, filter
  coefficients).
- **tuned**: fitted so that the simulation shows the qualitative behaviour of the paper's
  Figs 12 to 14 (AAC gains, filter corners, detection threshold).
- **assumed**: set to a plausible value because the paper gives none.
- **optional setting**: realism options that are off and are not the cause of the
  instability.
- **from the R-1 text**: stated in the paper's text rather than its Table 2.

| Parameter | Value | Kind | Provenance | Meaning |
|---|---|---|---|---|
| `vehicle.pivotOffset` | [0, 0, 0] | assumed | assumed | Offset of the rod pivot from the quad centre of mass |
| `pendulum.k_damp` | 0.001 | assumed | assumed, k1 = k2 | Pendulum damping coefficient (k1 = k2 in the R-1 damping terms) |
| `motor.tau` | 0.04 | assumed | assumed | Motor first-order lag time constant [s] |
| `motor.omegaMin` | 100 | assumed | assumed | Lower motor speed limit [rad/s] |
| `motor.omegaMax` | 1147 | assumed | assumed | Upper motor speed limit [rad/s] |
| `control.rateHz` | 100 | assumed | assumed | Controller and AAC rate [Hz] |
| `control.attMax` | 0.35 | assumed | assumed | Attitude command limit [rad] |
| `control.inner.Kp` | 13.02 | designed | designed (reconstruction) | Inner (attitude) PD gains |
| `control.inner.Kd` | 3.473 | designed | designed (reconstruction) | Inner (attitude) PD gains |
| `control.outer.Kp` | 1.092 | designed | designed (reconstruction) | Outer (position/pendulum) PD gains |
| `control.outer.Kd` | 0.8717 | designed | designed (reconstruction) | Outer (position/pendulum) PD gains |
| `control.alt.Kp` | 16 | designed | designed (reconstruction) | Altitude hold PD gains |
| `control.alt.Kd` | 7.2 | designed | designed (reconstruction) | Altitude hold PD gains |
| `control.yaw.Kp` | 25 | designed | designed (reconstruction) | Yaw hold PD gains |
| `control.yaw.Kd` | 9 | designed | designed (reconstruction) | Yaw hold PD gains |
| `aac.a0` | 0.148765 | tuned | tuned (reconstruction) | AAC leakage rate toward K_T = 1 [1/s] |
| `aac.b_e` | 0 | from the R-1 text | R-1 §III.B | AAC reference-error (up-band) gain; 0 means down-band only |
| `aac.b_s` | 5171.57 | tuned | tuned (reconstruction) | AAC spectral-damper (down-band) gain |
| `aac.kMin` | 0.05 | tuned | tuned (reconstruction) | Lower bound of K_T |
| `aac.kMax` | 2 | assumed | assumed | Upper bound of K_T |
| `aac.hp.fc` | 0.305094 | tuned | tuned (reconstruction) | Spectral-damper high-pass filter |
| `aac.hp.order` | 2 | tuned | tuned (reconstruction) | Spectral-damper high-pass filter |
| `aac.hp.sos` | filter coefficients (see `shared/params/default.json`) | designed | designed (reconstruction) | Spectral-damper high-pass filter |
| `aac.lp.fc` | 0.0546051 | tuned | tuned (reconstruction) | Spectral-damper low-pass filter |
| `aac.lp.order` | 1 | tuned | tuned (reconstruction) | Spectral-damper low-pass filter |
| `aac.lp.sos` | filter coefficients (see `shared/params/default.json`) | designed | designed (reconstruction) | Spectral-damper low-pass filter |
| `aac.threshold` | 0.00166448 | tuned | tuned (reconstruction) | Detection threshold on y_SD |
| `aac.clearRatio` | 0.5 | tuned | tuned (reconstruction) | Detector clears when y_SD falls below this fraction of the threshold |
| `aac.clearHoldS` | 2 | tuned | tuned (reconstruction) | Time y_SD must stay below the clear level [s] |
| `aac.engageRampS` | 0 | assumed | assumed | Ramp time when the AAC is engaged [s]; 0 means a step |
| `aac.refLeadS` | 1 | assumed | assumed (reconstruction) | Reference-error filter lead time [s] |
| `aac.refLagS` | 0.25 | assumed | assumed (reconstruction) | Reference-error filter lag time [s] |
| `sensing.latencyMs` | 0 | optional setting | optional realism, off | Optional realism setting, off by default |
| `sensing.noise.enabled` | off | optional setting | optional realism, off | Optional realism setting, off by default |
| `sensing.noise.pos` | 0.001 | optional setting | optional realism, off | Optional realism setting, off by default |
| `sensing.noise.att` | 0.002 | optional setting | optional realism, off | Optional realism setting, off by default |
| `sensing.noise.rate` | 0.01 | optional setting | optional realism, off | Optional realism setting, off by default |
| `sim.dt` | 0.001 | assumed | assumed | Physics step [s] |
| `sim.controlDecimation` | 10 | assumed | assumed | Physics steps per control tick |
| `sim.seed` | 1 | assumed | assumed | Random seed |
| `sim.g` | 9.80665 | assumed | assumed (standard gravity) | Gravitational acceleration [m/s^2] |

The simulation reproduces the paper **qualitatively, for teaching**. It is not an exact
reproduction: the numbers in the charts (times, amplitudes, margins) come from this
reconstruction and will differ from the numbers in the paper.

