---
layout: post
title: "Making a quadrotor slosh, and teaching a controller to calm it down"
date: 2026-11-21 10:00:00
description: "An interactive simulation of a quadrotor carrying a hanging mass that mimics propellant slosh, and of the adaptive control that detects and suppresses the instability."
tags: [control, aerospace, simulation, slosh, adaptive-control]
categories: [robotics, control]
giscus_comments: false
related_posts: false
---

<style>
  img.slosh-fig { display: block; margin: 0 auto; }
  @media (min-width: 768px) { img.slosh-fig { max-width: 60%; } }
</style>

*A note before we start.* This post gives an overview of the work I took part in during my internship
at NASA Langley Research Center. I wrote it on my own time; it is not sponsored or endorsed by NASA.
The simulation in it is my own reconstruction from the published paper. It reproduces the paper's
results as closely as I could, but it is not a reflection of the original work.

Rockets are mostly fuel, and fuel moves. This post is about a small testbed that makes a drone
behave like a rocket with sloshing propellant, and about the adaptive control idea that was
used to calm it down. You can fly a simulation of it right here, push it into instability, and
watch the controller step in.

This post is split into the following sections:

1. [Why slosh matters](#1-why-slosh-matters)
2. [The experiment](#2-the-experiment)
3. [The controller](#3-the-controller)
4. [Adaptive Augmenting Control](#4-adaptive-augmenting-control)
5. [Try it yourself](#5-try-it-yourself)
6. [Flight-test results](#6-flight-test-results)
7. [What's reconstructed](#7-whats-reconstructed)
8. [References and credits](#8-references-and-credits)

For an interactive experience, jump right to [section 5](#5-try-it-yourself).

## 1. Why slosh matters

A launch vehicle carries tens or hundreds of tonnes of liquid propellant. When the vehicle
accelerates or steers, the liquid sloshes. The sloshing liquid pushes back on the tank, and the
vehicle's flight control system sees that push as an unmodeled disturbance. These unmodeled modes
can have adverse effects on the flight controller, which can feed the sloshing dynamics and
generate low-frequency oscillations.

This is not a hypothetical. On the second flight of SpaceX's Falcon 1, Demo Flight 2 in March
2007, the second stage developed growing oscillations that were attributed to propellant slosh,
and the vehicle lost control before it reached its target orbit. Slosh is also a standing
concern for NASA's Space Launch System (SLS), whose flight control system has to keep the slosh
modes of its large tanks stable across a very wide range of flight conditions.

For typical launch vehicles the slosh modes sit at low frequencies, roughly 0.3 to 0.5 Hz. The
rigid-body control loop has its gain crossover around 0.2 Hz. That is uncomfortably close: the
slosh mode lives just above the frequency where the controller's authority fades, so a modest
increase in loop gain or a shift in phase can push it from damped to unstable.

SLS therefore includes an **Adaptive Augmenting Control** (AAC) system. It watches the control
signal for the tell-tale signature of an oscillation the main controller is not handling, and
lowers the loop gain when it sees one. The paper this post is based on tested that idea on a
quadrotor [[1]](#references-and-credits).

## 2. The experiment

Slosh is hard to test on a real rocket, so the team I was part of during my internship at NASA
Langley built a stand-in. The quadrotor
(nicknamed "mama bird") carries a **hanging** point mass: 0.05 kg on a rigid 1 m rod below the
vehicle. The hanging mass swings like a pendulum, and the quadrotor's attitude controller has to
live with that swinging load. The pendulum's natural frequency is

$$
\omega_s \approx \sqrt{\frac{m_T\, g}{(m_T - m_p)\, L}} \approx 3.18\ \mathrm{rad/s}
\approx 0.507\ \mathrm{Hz},
$$

where $$m_T$$ is the total mass. That is right in the 0.3 to 0.5 Hz band of a launch vehicle's
slosh modes, and it is the "slosh mode" of this testbed. The simulation uses the paper's vehicle
parameters: a 1.5207 kg quadrotor with a 0.241 m arm, inertias of 0.0211, 0.0216 and
0.01455 kg m², and rotor thrust and torque coefficients of 5.8597e-6 and 2.925e-9.

On the real testbed, a Vicon motion-capture system[^mocap] measured position and
attitude, and the vehicle's IMU supplied angular rates. The pendulum angle was *not* measured or
fed back: just as on a rocket, the slosh is unmodelled and unobservable to the controller, and it
has to be handled through the vehicle's own motion.

The testbed has one more trick: a **gain shift** knob. It multiplies the outer-loop gain on
purpose. Raising it moves the loop's high-frequency gain margin toward zero, until the slosh mode
at about 0.5 Hz becomes unstable. That is how the team created a controlled version of a slosh
instability on demand, safely, and then tested whether the AAC could suppress it.

In the simulation the quadrotor is a full 6-degree-of-freedom rigid body with a quaternion
attitude. The pendulum is integrated as a unit vector on a sphere, so nothing special happens at
the straight-down position. Motors have a first-order lag. The model is integrated with a
fixed-step RK4 at 1 kHz, and the controller runs at 100 Hz.

![The control architecture of the simulation: outer position PD, gain shift and K_T, inner attitude PD, mixer, and the quadrotor with its hanging mass. The spectral damper listens to the control signal and drives K_T. Redrawn for this post.]({{ '/assets/img/slosh/architecture.svg' | relative_url }}){: .img-fluid .slosh-fig }

## 3. The controller

The controller is two nested SISO PD loops per horizontal axis (pitch and roll):

- an **inner loop** that holds the quadrotor's attitude, and
- an **outer loop** that turns position and velocity errors into an attitude command.

Altitude and yaw are held by simple separate loops. The gain shift multiplies the outer-loop
output. Crucially, nothing in the controller measures the pendulum.

The Nichols chart below is the outer loop of this simulation's designed gains. The paper reports
the margins of its real controller (its Table 1); the table compares them with the ones I designed.

![Nichols chart of the outer loop with the designed phase and gain margins annotated, and the paper's Table 1 targets drawn as open diamonds.]({{ '/assets/img/slosh/nichols_outer.png' | relative_url }}){: .img-fluid .slosh-fig }

| Quantity | R-1 Table 1 | This simulation (pitch and roll) |
|---|---|---|
| Phase margin | 22° near 0.2 Hz | 24.4° at 0.205 Hz |
| High-frequency gain margin | 2.6 (8.3 dB) near 0.525 Hz | 1.34 (2.6 dB) at 0.513 Hz |
| Low-frequency gain margin | none | none |

The phase margin and the shape of the loop land close to the paper. The high-frequency gain
margin does not, **on purpose**. In the simulation the slosh mode goes unstable when the gain
shift passes about 1.34, comfortably below 2.0. I chose that deliberately: it makes the unstable
scenarios clearly visible in a short interactive demo. It is a teaching choice and not a claim
about the real vehicle, whose margins are in the paper.

## 4. Adaptive Augmenting Control

The AAC adds one extra number to each of the pitch and roll loops: a forward-loop gain $$K_T$$ that
normally sits at 1. When $$K_T$$ is applied, it multiplies the outer-loop output. The AAC changes it
according to

$$
\dot k_T = -a_0\,(k_T - 1) \;+\; b_e\, e_{\mathrm{ref}}^2\,(k_{\max} - k_T) \;-\; b_s\, y_{SD}\,(k_T - k_{\min}),
$$

with $$k_T$$ kept between $$k_{\min}$$ and $$k_{\max}$$. Each term has a job:

- **Leakage**, $$-a_0 (k_T - 1)$$, pulls the gain back toward 1 so the AAC does not stay in a
  reduced-gain state once the oscillations have subsided.
- **Reference error** (the up-band term, $$b_e$$) would raise the gain when the vehicle does not
  follow its commands. In the testbed experiments it is off, so $$b_e = 0$$ and the AAC is
  *down-band only*.
- **Spectral damper**, $$-b_s\, y_{SD}\,(k_T - k_{\min})$$, lowers the gain when it detects
  oscillation near the slosh frequency.

The **spectral damper signal** $$y_{SD}$$ is built from the control signal. It is a high-pass filter
that keeps the content around 0.5 Hz, followed by squaring (so it measures oscillation *power*)
and a low-pass filter. A flat-lining, quiet control signal gives $$y_{SD} \approx 0$$. A growing oscillation near
the slosh frequency makes $$y_{SD}$$ rise. When it crosses a threshold, the simulation flags an
**anomaly**; that is the detector. Lowering $$K_T$$ lowers the loop gain, which brings the slosh
mode back inside its stability margin.

The AAC has three modes in the simulation. *Off*: $$K_T$$ is fixed at 1 and the detector is hidden.
*Monitor*: the AAC and the detector compute and show everything, but $$K_T$$ is not applied, so the
flight is identical to Off. *Engaged*: $$K_T$$ is applied. This mirrors how the flight test was
run: the AAC watched first and was engaged later.

## 5. Try it yourself

The widget below is a single continuous flight. It starts at nominal gains with the pendulum already swinging (0.2 rad), and
you steer it through three regimes without ever resetting the vehicle.

{% include slosh-sim.html %}

### A guided walkthrough

The three **regime buttons** over the 3D view are labelled with the figure of the paper they
reproduce, qualitatively:

1. **Nominal · Fig 12.** The gain shift is 1 and the AAC is off. The controller damps the slosh,
   slowly: the swing amplitude decays but does not vanish quickly. Nothing is flagged.
2. **Gain shift · Fig 13.** The outer-loop gains are raised on purpose, to 2.3 times their
   nominal value, to drive the slosh mode unstable. The AAC switches to Monitor: it computes
   $$K_T$$ and the detector, but does not apply them. Watch the swing amplitude grow, with the
   mass's dominant motion migrating from one horizontal axis to the other. The detector trips a
   few seconds after the shift, in my reconstruction about 3 s later, while the swing is still moderate.
3. **AAC engaged · Fig 14.** The gain shift stays where it is, and the AAC starts applying $$K_T$$.
   Like the flight test, the computed $$K_T$$ is applied **at once**, as a step, rather than being
   faded in. The growth stops and the amplitude begins to fall. In the charts you see $$K_T$$ drop
   on both axes (more on pitch than on roll), and then slowly recover toward 1 as the slosh
   calms down.

![The story run: the pendulum angle and K_T through Nominal, Gain shift and AAC engaged, with the detector trip marked. Generated from this project's model.]({{ '/assets/img/slosh/story_sequence.png' | relative_url }}){: .img-fluid .slosh-fig }

The regime buttons act on the **running** flight, exactly like the replay. Tapping one starts the
flight if it is paused, ramps the gains over about 1.5 s, and the motion and the charts carry on;
the vehicle is never reset. So you can stay in Gain shift as long as you like, let the oscillation
grow as large as you want, and then engage the AAC. If the pendulum is
nearly still when you tap Gain shift, the widget also gives it a small disturbance so you do not
have to wait for the instability to show up. That disturbance gets its own label on the charts.

Three things help you follow what happens:

- **The info banner** along the bottom edge of the 3D view says what the current phase is, what
  you should see happen, and which paper figure it corresponds to. For Gain shift it says plainly
  that the gains are being raised on purpose to make the fuel slosh. When the detector trips, the
  trip message appears there too.
- **The charts** inside the widget show the pendulum angle, $$K_T$$ and the spectral damper output
  $$y_{SD}$$. **Full screen** shows all six charts, larger, including the mass position, the quad's
  roll and pitch and the motor commands.
- **Markers** on every chart show each regime transition, labelled in full screen ("Gain shift →
  2.3", "AAC monitoring", "AAC engaged"), and the **background shading** shows which regime you
  are in. The
  colours are chosen to be distinguishable under common forms of colour-vision deficiency.
- **The detector-trip marker** is drawn differently from the transition markers, so you can tell
  at a glance "the reader changed something" from "the detector noticed something".

Two more buttons: **Replay the paper** resets the vehicle and then runs the sequence Nominal →
Gain shift → AAC engaged automatically, with timing tuned so that it matches the figure above.
Tapping any regime button during a replay cancels the remaining automatic steps and hands
control back to you. **Restart** is the only control that resets the vehicle: it returns to the starting state and
schedules nothing.

The widget plays like a video: tap the 3D view to pause or resume (a drag still orbits the
camera), and use the small bar for speed and **full screen**. It follows this site's light and
dark theme, and it does not autoplay if your system asks for reduced motion. Inside the widget,
the collapsed *Fine-tune* section holds the raw gain-shift slider, the AAC mode selector and the
parameter panel, if you want to explore outside the three regimes.

## 6. Flight-test results

The paper's flight test (its section V.B) follows the story above, but at the scale of a real
experiment. The gain shift was ramped up to 2 over 20 s with the AAC in Monitor. The slosh grew
into a large rotary motion of about 20°. The AAC was then engaged at t = 100 s, and the paper
reports the slosh suppressed within about 10 s.

The figure below is the same *sequence* in my simulation. It is generated from this project's
model, not copied from the paper.

![A flight-test-style run: gain shift ramped from 1 to 2 over 20 s with the AAC in Monitor, rotary slosh growing to about 0.37 rad, and the AAC engaged at t = 100 s.]({{ '/assets/img/slosh/vb_sequence.png' | relative_url }}){: .img-fluid .slosh-fig }

The simulation reproduces the shape of the story and **not** the speed of the ending. The slosh
grows to about 0.37 rad (21°) before engagement, the detector trips at about 55 s while the AAC
is still only watching, and engagement turns the growth around. But in my reconstruction the
amplitude then comes down slowly (from about 0.37 rad at 100 s to about 0.28 rad at 130 s), not
within 10 s as in the real flight. The cause is that the controller's gains, which I had to
design, change the slosh damping only modestly even when $$K_T$$ is at its minimum. I report this
as a known difference rather than tuning it away.

## 7. What's reconstructed

This simulation is a **reconstruction to tell a story**. The paper gives the dynamics and the
physical parameters (its Eq. 1 to 5 and Table 2), and I used those directly. It does not give the
controller gains, the motor time constant, the controller rate, the AAC filters and tuning, or the
detection threshold. I had to design, assume or tune them, and I cannot claim any of them match
the real testbed. The full list, with where each value comes from, is in the project repository
([reconstruction.md](https://github.com/candresdu/slosh-sim/blob/main/blog/reconstruction.md)).

## 8. References and credits

1. <a id="ref-1"></a>J. Pei, A. Puetz, C. Duarte, L. Miller and P. Rothhaar, "Suppression of
   Nonlinear Rotary Slosh Dynamics using the SLS Adaptive Augmenting Control System:
   Demonstration on a Quadcopter Testbed", AIAA Scitech 2019 Forum, 2019.
   [doi:10.2514/6.2019-0114](https://doi.org/10.2514/6.2019-0114)

The testbed and the AAC concept are the work of that team. This post and its simulation are my
own re-creation from the published paper. Every figure here is generated by my own model; none
of the paper's figures and none of the testbed's photographs is reproduced.

The simulation code, the Python reference model and the design scripts are open source (MIT) at
[github.com/candresdu/slosh-sim](https://github.com/candresdu/slosh-sim).

[^mocap]: **Motion capture.** A Vicon system is a set of fixed infrared cameras around the flight
    area. They track small reflective markers on the vehicle and compute its position and attitude
    many times per second, with millimetre-level precision. The **IMU** (inertial measurement unit)
    is the vehicle's own gyroscopes and accelerometers; here it supplied the angular rates.
