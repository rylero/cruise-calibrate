# Cruise Calibrate

A browser-only tool that corrects GPS-recorded running distance for the motion of the ship you were running laps on.

**[Open the app](https://rylero.github.io/cruise-calibrate/)** — everything runs client-side; your `.fit` file never leaves your machine.

## The problem

GPS distance recorded while running laps on a moving cruise ship includes both your running *and* the ship's own drift through the water. A watch reports the sum of the two, which inflates (or deflates) your real distance depending on the ship's heading relative to your laps.

## How it works

Rather than trying to separate the two motions in position-space, the correction works in velocity-space:

1. Resample the raw GPS track to a uniform time grid.
2. Kalman-smooth (forward-backward RTS smoother) the position to remove GPS jitter before differentiating.
3. Differentiate to get velocity.
4. Estimate the ship's velocity as a moving average of your velocity, windowed to one lap period (read from FIT lap markers, detected via autocorrelation, or set manually).
5. Subtract the ship's estimated velocity from your raw velocity.
6. Integrate the result to get your corrected distance.

Segments separated by a pause/resume gap are corrected independently and summed. A known total or single-lap distance can be supplied to calibrate the result further. A grid search over Kalman parameters, validated against synthetic scenarios with known ground truth, is built in.

The reconstructed ship-frame path is also de-rotated: as the ship turns, laps that are fixed to the deck rotate with it, so each lap is rotated back onto the ship's heading at the start of the activity. Otherwise the loops fan out instead of stacking. This affects the shape only — rotation preserves magnitude, so corrected distance is unchanged.

## Usage

### Browser

Open `index.html` (or use the hosted link above), drop in a `.fit` file, and follow the numbered steps. Results can be exported as CSV or as a corrected `.fit` file.

No build step, no dependencies, no server.

### CLI

The same pipeline runs from a shell — `core.js` holds the algorithms and is shared verbatim by both front ends.

```sh
node cli.js activity.fit
node cli.js activity.fit --units mi --kalman --fit corrected.fit
node cli.js activity.fit --known-dist 400 --known-laps 12 --json
```

`node cli.js --help` lists every option. Requires Node 18+ and no dependencies.

## Layout

| File | Role |
| --- | --- |
| `core.js` | FIT parsing/export, projection, correction pipeline, synthetic scenarios |
| `index.html` | Page markup, canvas plots, UI wiring |
| `cli.js` | Command-line front end |

`core.js` is a classic script rather than an ES module on purpose: it keeps the page working on GitHub Pages *and* when opened directly from disk over `file://`, where module scripts are blocked by CORS.
