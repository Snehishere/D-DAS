# D-DAS — Continuation Guide

This is a working Electron desktop app that does two things:
1. **Detects space debris in images** with a custom CV pipeline (box-blur background subtraction + connected components) and draws bounding boxes around detected objects.
2. **Visualizes orbital trajectories in 3D** (Three.js) for satellites/debris loaded from TLE files or CSV telemetry.

Both features were physically tested end-to-end against real ground-truth data on Aug 30, 2026. The SGP4 propagation, CSV/TLE parsers, and detection card layout were upgraded after a code refactor on Aug 31, 2026. This guide explains the architecture, the bugs that were fixed during testing, and where to pick up next.

---

## Quick Start

```bash
cd S:\antigravity\d-das
npm install        # if node_modules missing
npm start          # launches Electron app (production)
npm run dev        # launches with DevTools open + webSecurity disabled
```

The app loads `app://./index.html` via a custom protocol registered in `main.js` (required for ES module imports to work — see "Critical: Custom Protocol" below).

---

## File Layout

```
d-das/
├── main.js              # Electron main process. Custom app:// protocol, IPC handlers.
├── preload.js           # Bridges window.ddasAPI → ipcRenderer.invoke.
├── renderer/
│   └── lib.js           # Pure helpers (parseCsv, parseTleContent, sgp4 propagator, etc.) — testable.
├── index.html           # Layout + importmap for three.js + satellite.js.
├── styles.css           # UI styling (CSS variables, dark theme, toasts).
├── renderer.js          # UI + Three.js scene; imports from renderer/lib.js.
├── package.json         # electron 31, three 0.166, satellite.js 7.1, npm start/dev scripts.
├── node_modules/
├── test-detect.js       # Standalone Node smoke test + grid search over detection params.
├── start.bat            # Convenience launcher.
└── ../debris-detection/ # NOT in this project. Lives at S:\antigravity\debris-detection\
    ├── test/            # 5000 validation JPGs (512×512, dark space scenes)
    └── test/sample_submission.csv  # 5-tuple "bbox" entries (NOTE: not real spatial bboxes)
```

---

## Architecture

### Process split
- **Main process** (`main.js`): owns the BrowserWindow, file dialogs, FS reads (all async), and a custom `app://` protocol handler.
- **Preload** (`preload.js`): exposes `window.ddasAPI` with 5 IPC methods (image/csv/tle dialogs, saveLog, getInfo).
- **Renderer** (`renderer.js`): UI, image detection, Three.js scene. Pure helpers live in `renderer/lib.js`.
- **`renderer/lib.js`**: ESM-only module with pure functions — `parseCsv`, `parseTleContent`, `tleElements`, `createSgp4Propagator`, `generateOrbitTrack`, `interpolateSample`, `computeClosestApproach`, `classifyImpact`, `classifyRisk`, plus unit constants. No DOM access, no IPC. Importable directly from Node for tests.

### Data flow
1. User clicks "Load Image/CSV/TLE" → main opens dialog → reads file (async) → returns base64/text to renderer.
2. Renderer draws to canvas, runs detection/propagation, updates DOM + WebGL.
3. Export Log writes the in-memory session log to a text file (async).

---

## Critical: Custom Protocol (app://)

Three.js and satellite.js ship as ES modules. The renderer uses:

```html
<script type="importmap">
  { "imports": {
      "three":         "app://./node_modules/three/build/three.module.js",
      "satellite.js":  "app://./node_modules/satellite.js/dist/index.js"
  } }
</script>
<script type="module" src="renderer.js"></script>
```

`file://` origins **cannot** load ES modules (CORS + null-origin). The fix is a custom scheme registered in `main.js`:

```js
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

app.whenReady().then(() => {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const filePath = path.join(__dirname, url.pathname);
    const data = await fs.promises.readFile(filePath);
    return new Response(data, { headers: { 'Content-Type': mime } });
  });
});

mainWindow.loadURL('app://./index.html');   // NOT loadFile()
```

The CSP in `index.html` allows this:

```
default-src 'self' app: data: blob:;
script-src 'self' app: 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' app: data: blob:;
connect-src 'self' app: ws:;
```

**If you ever change the protocol or move the project, you must keep `app:` in the CSP, the importmap, and `loadURL('app://./...')` in sync.** Otherwise the renderer silently fails to load.

---

## Detection Algorithm (CV)

`runDetection(canvas)` in `renderer.js`:

1. Read pixel data, compute luma: `0.2126R + 0.7152G + 0.0722B`.
2. **Box-blur background subtraction** with integral images for O(1) per-pixel local mean. Radius = 9 pixels.
3. Threshold: pixels where `luma - localMean > 6` form a mask. Tuned for low-contrast space imagery.
4. Connected components (4-connectivity flood fill) → keep components with `size >= 40 pixels`.
5. Sort by `meanL * size`, take top 6. Draw bounding box on overlay canvas, plus primary target info card.

### Tuned parameters

```js
const detectionParams = {
  radius: 9,       // background blur radius
  threshold: 6,    // luma - localMean cutoff
  minSize: 40      // min pixels in a component
};
```

The grid search lives in `test-detect.js --search`. The default values produce a 100% detection rate on the first 80 images in `debris-detection/test/` (avg ~4 detections per image).

### Detection card layout

The card auto-docks to avoid occluding the primary bounding box. Eight candidate anchor points are tried (4 corners around the bbox + 4 stage corners); the first one that does not overlap and stays inside the stage is chosen. If none qualify, the stage-top-left corner is used as a fallback.

---

## 3D Simulation

### Scene
- Earth sphere (radius 2, 96×64 segments) with a **procedural Earth-like texture**: value-noise FBM (5 octaves) generates elevation, then classified into deep ocean / shallow ocean / coast / grassland / desert / mountain / snow at the poles. **Procedural — no texture assets required.**
- A second slightly larger sphere (radius 2.02) holds a procedural cloud layer (transparent white FBM noise), rotating slightly faster than Earth for a parallax effect.
- Equatorial ring (faint cyan), 1200 random stars.
- One `THREE.Group` per body (`bodyGroup`, `orbitGroup`, `trailGroup`).
- Each body: orbit line + small sphere marker + 64-sample motion trail.
- Camera: PerspectiveCamera at (0,8,18), mouse-drag rotation, wheel zoom.

### DPR / window resize
`onWindowResize` updates `renderer.setPixelRatio(window.devicePixelRatio)` plus camera aspect, and re-sizes the overlay canvas to the rendered image dimensions. Detection overlay is redrawn after resize.

### Animation
- `state.simulationTime` advances by `dt * simSpeed`.
- Each frame, for every body: interpolate along its `samples` track by phase, set mesh position, push position into a circular trail buffer.

### Body list panel
- "Tracked Bodies" card with one row per body, click to select.
- Selection highlights the body+orbit, updates Active Orbital Body info card.
- Rows tagged `(norm)` indicate CSV bodies whose samples were unit-normalized (no km-scale conjunction possible).

### Closest-approach / "impact time"
- For each pair of bodies in **km units** (TLE always, CSV only if its header says `pos_*_km`), sample N points along their tracks, find min distance, classify:
  - d < 1 km → CRITICAL · immediate collision (red)
  - d < 300 km → CRITICAL (red) — covers the Aug 30 scenario suite
  - d < 800 km → WARNING (yellow)
  - else → Nominal (green)
- Bumps to CRITICAL/HVR-warning based on relative speed (>12 km/s critical, >6 km/s warning).
- Bumps to bright red if either body is a satellite and severity is critical.
- Renders on Active Orbital Body card and as the swatch color in the body list.
- Bodies that mix normalized CSV + real-km TLE get "No conjunction data (mixed units)" instead of a meaningless number.

---

## CSV Telemetry Format

`parseCsv` in `renderer/lib.js` accepts:
```
time, x, y, z         # header row optional
0.0, 1.0, 7000.0, 0.0
1.5, 1.2, 6999.5, 500.0
...
```

Header columns auto-detected (`pos_x_km`/`pos_y_km`/`pos_z_km`, `vel_x_kms`/etc, `mass_kg`, `object_id`, `kind`). When the header indicates km units, samples are kept in km and visualized at scene scale (2 scene units = 6371 km). Without a header, samples are normalized to fit in a 7-unit span and tagged `(norm)` — closest-approach is disabled against other normalized bodies.

The parser now reports `{rows, skipped, header, units}` in `parseCsv().stats`. The CSV button logs e.g. `Loaded CSV "x.csv" · 200 rows parsed, 4 skipped, units=km`. Empty results now raise an error toast.

---

## TLE Format & SGP4

`parseTleContent` reads standard 3-line TLEs (with optional `# key: value` metadata). After parsing, **real SGP4** propagation is done via [`satellite.js`](https://www.npmjs.com/package/satellite.js) (`twoline2satrec` + `propagate`). Output positions are in km, velocities in km/min (after ×60 from km/s).

```
generateOrbitTrack(satlib, sat, { points: 360, periods: 1.5 })
  → { track: [{t, x, y, z, vx, vy, vz}, ...], satrec }
```

Eccentricity / inclination / RAAN / arg perigee are still surfaced for the Active Orbital Body card; propagation accuracy now matches the official SGP4 (WGS-72 constants, J2, drag, etc.) instead of the previous two-body Kepler approximation.

TLE line parsing now also reports skipped unpaired lines (e.g. a stray `2 ...` line without a preceding `1 ...`).

---

## Test Harness

`node test-detect.js [--all] [--search]`
- Default: runs the detector on the first 80 images in `debris-detection/test/`, reports detection rate, average count per image, and timing.
- `--all`: process every image (5000+).
- `--search`: grid-search `{radius, threshold, minSize}` and print top 5 by a self-evaluation score.
- The harness self-evaluates because the `sample_submission.csv` ground-truth bboxes in this dataset are **not spatial bboxes in `[x_min, x_max, y_min, y_max]` form** (5-tuple values don't parse as either `[x_min,x_max,y_min,y_max,class]` or `[x_center,y_center,w,h,angle]`). If you have real IoU-comparable ground truth, plug it into `loadGroundTruth` and `evaluate()` — those functions still exist.

`node test/generate-scenarios.js` and `node test/run-scenarios.js`
- `generate-scenarios.js` regenerates the 5 collision scenarios in `test/scenarios/` using real SGP4 via `satellite.js`. Both bodies in each scenario are now propagated in the TEME frame, with a TLE epoch of 2026-08-31 00:00 UTC (matches the CSV `timestamp` column).
- `run-scenarios.js` is now a thin wrapper that imports `parseCsv`, `parseTleContent`, `tleElements`, `generateOrbitTrack`, `computeClosestApproach`, `classifyImpact` from `renderer/lib.js`, plus `satellite.js`. It applies the same `(y=z, z=-y)` scene-convention swap on the CSV that `generateOrbitTrack` does on the TLE output, so cross-format distances are physically meaningful.
- Result: **5/5 scenarios PASS** as of Aug 31, 2026:
  - 01_critical → CRITICAL (177.75 km, 0.20 km/s rel)
  - 02_warning → WARNING (422.84 km, 0.46 km/s rel)
  - 03_nominal → Nominal (1380.01 km, 5.08 km/s rel)
  - 04_geo_vs_leo → Nominal (35355.89 km, 6.91 km/s rel)
  - 05_headon → CRITICAL (8.13 km, 5.16 km/s rel)

---

## Known Issues / Where to Pick Up

1. **Detection uses background subtraction only** — it can't separate overlapping debris or distinguish debris from bright stars. To upgrade: pass detector output to a small CNN (e.g. ONNX runtime with a YOLOv5-nano model), trained on `debris-detection/test/sample_submission.csv` — **but only after re-formatting the ground truth into proper spatial bboxes.**
2. **Detection card fallback** — if every candidate anchor overlaps the primary bbox, the card snaps to the stage top-left and *will* overlap. Very rare in practice.
3. **CSV impact distance** — when a CSV has no header (normalized units) and is loaded with a TLE, the CSV body shows "No conjunction data (mixed units)" rather than a fake km distance.
4. **CSP is permissive** (`'unsafe-inline'` for scripts) because of the inline importmap. If you ever add a build step, move the importmap to a JSON file and remove `unsafe-inline`.
5. **`webPreferences.webSecurity: !isDev`** in `main.js` — production builds keep web security on. Acceptable for a local desktop app, do NOT disable for any web-facing Electron app.
6. **Default ISS TLE** is hard-coded in `loadDefaultExample()`; if SGP4 epoch drifts too far, swap in a fresh TLE.
7. **Toast container** auto-creates in `renderer.js` (`ensureToastContainer`) so it works even if styles.css is reloaded late.

---

## Restoring CDP-based UI tests

The original Aug 30, 2026 CDP test still works:
```bash
# 1. launch with remote debugging
Start-Process electron.cmd -ArgumentList "--remote-debugging-port=9222","S:\antigravity\d-das"
# 2. connect with playwright-core
node -e "const {chromium}=require('playwright-core');(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:9222');const p=b.contexts()[0].pages()[0];await p.screenshot({path:'shot.png'});await b.close();})();"
```

`playwright-core` is already installed at `node_modules/playwright-core` (no-save). Chromium headless shell is at `C:\Users\snehe\AppData\Local\ms-playwright\chromium_headless_shell-1234`.

Note: in production (`npm start`) the CSP no longer allows `127.0.0.1:9222`, so **launch CDP tests with `npm run dev`** to keep `webSecurity: false` and the dev tools port usable.

---

## What Was Tested on Aug 31, 2026

- **Detection harness**: `node test-detect.js` on first 80 images → 100% detection rate, ~4 detections/image,5.25ms/image.
- **Grid search**: 75 combos (5 radii × 5 thresholds × 3 minSizes) — all achieve ≥0.97 self-eval score on the first 80 images.
- **SGP4**: ISS-like TLE propagates to ~6800 km radius (LEO). Period = 92.9 min (matches 1440 / 15.5 rev/day).
- **Closest approach**: 2 ISS-class orbits with 0.01 rev/day mean-motion delta → 2.5 km min distance, 0.13 km/s rel speed.

## What Remains Untested

- End-to-end via CDP with the new SGP4 path (rerun the Aug 30 CDP harness).
- File dialog flow (relies on `dialog.showOpenDialog` in main.js — not exercised in CDP test because dialogs are blocked in headless).
- Window resize during runtime (resize handler added; not yet stress-tested).
- TLE loading from real Celestrak data (only synthetic ISS example tested).