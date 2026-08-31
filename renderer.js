import * as THREE from 'three';
import * as satlib from 'satellite.js';
import {
  TWO_PI,
  DEG,
  EARTH_RADIUS_KM,
  SCENE_RADIUS,
  MINUTES_PER_DAY,
  parseCsv,
  augmentVelocity,
  parseTleContent,
  tleElements,
  classifyImpact,
  classifyRisk,
  interpolateSample,
  computeClosestApproach,
  kmToScene,
  sceneToKm,
  generateOrbitTrack
} from './renderer/lib.js';

(() => {
  'use strict';

  const api = window.ddasAPI;

  const els = {
    tabImage: document.getElementById('tab-image'),
    tabSim: document.getElementById('tab-sim'),
    viewImage: document.getElementById('view-image'),
    viewSim: document.getElementById('view-sim'),
    btnLoadImage: document.getElementById('btn-load-image'),
    btnLoadCsv: document.getElementById('btn-load-csv'),
    btnLoadTle: document.getElementById('btn-load-tle'),
    btnSaveLog: document.getElementById('btn-save-log'),
    selectedFileLabel: document.getElementById('selected-file-label'),
    logView: document.getElementById('log-view'),
    statusDot: document.getElementById('status-dot'),
    statusText: document.getElementById('status-text'),
    engineStatus: document.getElementById('engine-status'),
    loadStatus: document.getElementById('load-status'),
    imageCanvas: document.getElementById('image-canvas'),
    overlayCanvas: document.getElementById('overlay-canvas'),
    canvasContainer: document.getElementById('canvas-container'),
    canvasStage: document.getElementById('canvas-stage'),
    imageEmpty: document.getElementById('image-empty'),
    detectionCard: document.getElementById('detection-card'),
    cardClass: document.getElementById('card-class'),
    cardConfidence: document.getElementById('card-confidence'),
    cardX: document.getElementById('card-x'),
    cardY: document.getElementById('card-y'),
    cardCount: document.getElementById('card-count'),
    cardBbox: document.getElementById('card-bbox'),
    bodyList: document.getElementById('body-list'),
    threeContainer: document.getElementById('three-container'),
    simEmpty: document.getElementById('sim-empty'),
    simName: document.getElementById('sim-name'),
    simInclination: document.getElementById('sim-inclination'),
    simEccentricity: document.getElementById('sim-eccentricity'),
    simRaan: document.getElementById('sim-raan'),
    simArgperigee: document.getElementById('sim-argperigee'),
    simImpact: document.getElementById('sim-impact'),
    toastContainer: ensureToastContainer()
  };

  function ensureToastContainer() {
    let el = document.getElementById('toast-container');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast-container';
      el.className = 'toast-container';
      document.body.appendChild(el);
    }
    return el;
  }

  const state = {
    log: [],
    bodies: [],
    selectedBodyIndex: 0,
    renderer: null,
    scene: null,
    camera: null,
    earthMesh: null,
    cloudMesh: null,
    bodyGroup: null,
    orbitGroup: null,
    trailGroup: null,
    bodyTrails: [],
    lastTime: 0,
    simulationTime: 0,
    simSpeed: 1.0,
    raycaster: null,
    mouse: null,
    canvasSize: { w: 0, h: 0 },
    lastDetection: null,
    imageRenderedSize: { w: 0, h: 0 },
    sgp4ErrorCount: 0
  };

  const detectionParams = {
    radius: 9,
    threshold: 6,
    minSize: 40
  };

  function nowStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function pushLog(message, level = 'info') {
    state.log.push({ time: nowStamp(), message, level });
    if (state.log.length > 500) state.log.shift();
    renderLog();
  }

  function renderLog() {
    if (!els.logView) return;
    if (state.log.length === 0) {
      els.logView.innerHTML = '<div class="log-empty">No activity recorded yet</div>';
      return;
    }
    const html = state.log
      .slice()
      .reverse()
      .map((entry) => {
        const safe = entry.message.replace(/[&<>"']/g, (c) => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
        return `<div class="log-entry ${entry.level}"><span class="log-time">${entry.time}</span>${safe}</div>`;
      })
      .join('');
    els.logView.innerHTML = html;
  }

  function showToast(message, level = 'info', durationMs = 4500) {
    if (!els.toastContainer) return;
    const el = document.createElement('div');
    el.className = `toast toast-${level}`;
    el.textContent = message;
    els.toastContainer.appendChild(el);
    requestAnimationFrame(() => el.classList.add('toast-visible'));
    setTimeout(() => {
      el.classList.remove('toast-visible');
      setTimeout(() => el.remove(), 300);
    }, durationMs);
  }

  function setStatus(online, text) {
    els.statusDot.classList.toggle('online', !!online);
    els.statusText.textContent = text;
  }

  function setLoadStatus(text) {
    if (els.loadStatus) els.loadStatus.textContent = text;
  }

  function setSelectedFile(text) {
    if (els.selectedFileLabel) els.selectedFileLabel.textContent = text;
  }

  function switchTab(tab) {
    const isImage = tab === 'image';
    els.tabImage.classList.toggle('active', isImage);
    els.tabSim.classList.toggle('active', !isImage);
    els.tabImage.setAttribute('aria-selected', String(isImage));
    els.tabSim.setAttribute('aria-selected', String(!isImage));
    els.viewImage.classList.toggle('active', isImage);
    els.viewSim.classList.toggle('active', !isImage);
    if (!isImage) {
      requestAnimationFrame(() => ensureThreeRenderer());
    }
  }

  els.tabImage.addEventListener('click', () => switchTab('image'));
  els.tabSim.addEventListener('click', () => switchTab('sim'));

  // ---------- Image loading & detection ----------
  function loadImageFromBase64(base64, name) {
    const img = new Image();
    img.onload = () => {
      const dpr = window.devicePixelRatio || 1;
      const canvas = els.imageCanvas;
      const ctx = canvas.getContext('2d');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
      canvas.style.display = 'block';
      els.imageEmpty.style.display = 'none';
      els.canvasStage.classList.add('has-target');
      els.canvasContainer.classList.add('has-target');
      sizeOverlayCanvas();
      setSelectedFile(`Image: ${name}`);
      setLoadStatus(`Image loaded (${img.naturalWidth}x${img.naturalHeight})`);
      pushLog(`Loaded image "${name}" (${img.naturalWidth}x${img.naturalHeight}) · DPR ${dpr.toFixed(2)}`, 'success');
      runDetection(canvas);
    };
    img.onerror = () => {
      pushLog(`Failed to decode image "${name}"`, 'error');
      showToast(`Failed to decode image "${name}"`, 'error');
    };
    img.src = `data:image/png;base64,${base64}`;
  }

  function boxBlur(src, w, h, r) {
    const out = new Float32Array(w * h);
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += src[y * w + x];
        integral[(y + 1) * (w + 1) + (x + 1)] = rowSum + integral[y * (w + 1) + (x + 1)];
      }
    }
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r);
        const x1 = Math.min(w - 1, x + r);
        const sum = integral[(y1 + 1) * (w + 1) + (x1 + 1)]
                  - integral[y0 * (w + 1) + (x1 + 1)]
                  - integral[(y1 + 1) * (w + 1) + x0]
                  + integral[y0 * (w + 1) + x0];
        const area = (x1 - x0 + 1) * (y1 - y0 + 1);
        out[y * w + x] = sum / area;
      }
    }
    return out;
  }

  function runDetection(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    if (w === 0 || h === 0) return;

    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const luma = new Float32Array(w * h);
    for (let i = 0, p = 0; p < luma.length; i += 4, p++) {
      luma[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }

    const { radius, threshold, minSize } = detectionParams;
    const local = boxBlur(luma, w, h, radius);
    const mask = new Uint8Array(w * h);
    for (let p = 0; p < luma.length; p++) {
      if (luma[p] - local[p] > threshold) mask[p] = 1;
    }

    const labels = new Int32Array(w * h);
    const comps = [];
    const stack = [];
    for (let p = 0; p < mask.length; p++) {
      if (mask[p] !== 1 || labels[p] !== 0) continue;
      const id = comps.length + 1;
      let sumX = 0, sumY = 0, sumL = 0, count = 0;
      let minX = w, minY = h, maxX = -1, maxY = -1;
      stack.push(p);
      labels[p] = id;
      while (stack.length) {
        const cur = stack.pop();
        const cy = (cur / w) | 0;
        const cx = cur - cy * w;
        sumX += cx; sumY += cy; sumL += luma[cur]; count++;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        const neighbors = [
          cx > 0 ? cur - 1 : -1,
          cx < w - 1 ? cur + 1 : -1,
          cy > 0 ? cur - w : -1,
          cy < h - 1 ? cur + w : -1
        ];
        for (const n of neighbors) {
          if (n >= 0 && mask[n] === 1 && labels[n] === 0) {
            labels[n] = id;
            stack.push(n);
          }
        }
      }
      if (count >= minSize) {
        comps.push({
          cx: sumX / count,
          cy: sumY / count,
          size: count,
          meanL: sumL / count,
          minX, minY, maxX, maxY,
          wBox: maxX - minX + 1,
          hBox: maxY - minY + 1
        });
      }
    }

    if (comps.length === 0) {
      els.detectionCard.classList.add('hidden');
      els.canvasStage.classList.remove('has-target');
      els.canvasContainer.classList.remove('has-target');
      clearOverlay();
      state.lastDetection = null;
      pushLog('No significant orbital objects detected in frame', 'info');
      return;
    }

    comps.sort((a, b) => (b.meanL * b.size) - (a.meanL * a.size));
    const best = comps[0];
    const top = comps.slice(0, 6);

    const snr = Math.max(0, (best.meanL - threshold) / 30);
    const confidence = Math.min(99.9, 45 + snr * 40 + Math.min(best.size / 400, 1) * 12);
    const objectClass = classifySize(best.size);

    state.lastDetection = { top, w, h, primary: best, confidence, objectClass };
    drawOverlay();
    positionDetectionCard(best.minX, best.minY, best.maxX, best.maxY, w, h);

    els.cardClass.textContent = objectClass;
    els.cardConfidence.textContent = `${confidence.toFixed(1)}%`;
    els.cardCount.textContent = `${comps.length}`;
    els.cardBbox.textContent = `${best.wBox}×${best.hBox}`;
    els.cardX.textContent = Math.round(best.cx).toString();
    els.cardY.textContent = Math.round(best.cy).toString();
    els.detectionCard.classList.remove('hidden');
    els.canvasStage.classList.add('has-target');
    els.canvasContainer.classList.add('has-target');

    pushLog(
      `Detected ${comps.length} object(s). Primary: ${objectClass} @ (${Math.round(best.cx)}, ${Math.round(best.cy)}) size ${best.wBox}×${best.hBox} confidence ${confidence.toFixed(1)}%`,
      'success'
    );
  }

  function classifySize(size) {
    if (size > 300) return 'Large Debris / Asteroid';
    if (size > 120) return 'Medium Space Debris';
    return 'Small Orbital Fragment';
  }

  function sizeOverlayCanvas() {
    if (!els.overlayCanvas || !els.imageCanvas) return;
    const overlay = els.overlayCanvas;
    overlay.width = els.imageCanvas.width || 1;
    overlay.height = els.imageCanvas.height || 1;
    overlay.style.width = `${els.imageCanvas.clientWidth}px`;
    overlay.style.height = `${els.imageCanvas.clientHeight}px`;
    state.imageRenderedSize = { w: els.imageCanvas.clientWidth, h: els.imageCanvas.clientHeight };
  }

  function clearOverlay() {
    if (!els.overlayCanvas) return;
    const ctx = els.overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
  }

  function drawOverlay() {
    if (!state.lastDetection || !els.overlayCanvas) return;
    sizeOverlayCanvas();
    const ctx = els.overlayCanvas.getContext('2d');
    const { top, primary } = state.lastDetection;
    ctx.clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
    top.forEach((c, i) => {
      const isPrimary = c === primary;
      const color = isPrimary ? '#3ddc84' : '#4cc2ff';
      const pad = 3;
      const x = c.minX - pad;
      const y = c.minY - pad;
      const w = c.wBox + pad * 2;
      const h = c.hBox + pad * 2;
      ctx.lineWidth = isPrimary ? 3 : 1.5;
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = isPrimary ? 10 : 4;
      ctx.strokeRect(x, y, w, h);

      const label = isPrimary ? classifySize(c.size) : `#${i + 1}`;
      ctx.font = `${isPrimary ? 13 : 11}px "Cascadia Mono", Consolas, monospace`;
      const textW = ctx.measureText(label).width + 12;
      ctx.fillStyle = isPrimary ? 'rgba(61, 220, 132, 0.92)' : 'rgba(76, 194, 255, 0.85)';
      ctx.shadowBlur = 0;
      ctx.fillRect(x, y - (isPrimary ? 22 : 18), textW, isPrimary ? 22 : 18);
      ctx.fillStyle = '#0a0a12';
      ctx.fillText(label, x + 6, y - (isPrimary ? 7 : 5));

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(c.cx, c.cy, isPrimary ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // Position the detection info card so it never overlaps its primary bbox.
  // Strategy: try four anchor corners around the primary bbox; pick the one
  // with the largest gap to the container edge that does not overlap.
  function positionDetectionCard(minX, minY, maxX, maxY, imgW, imgH) {
    const card = els.detectionCard;
    card.classList.remove('hidden');
    card.style.left = '0px';
    card.style.top = '0px';
    card.style.right = 'auto';
    card.style.bottom = 'auto';
    card.style.transform = 'none';

    const stageRect = els.canvasStage.getBoundingClientRect();
    const containerRect = els.canvasContainer.getBoundingClientRect();
    const scaleX = stageRect.width / imgW;
    const scaleY = stageRect.height / imgH;
    const bboxLeft = (minX * scaleX);
    const bboxTop = (minY * scaleY);
    const bboxRight = ((maxX + 1) * scaleX);
    const bboxBottom = ((maxY + 1) * scaleY);

    card.style.visibility = 'hidden';
    requestAnimationFrame(() => {
      const cardW = card.offsetWidth || 240;
      const cardH = card.offsetHeight || 130;
      const stageLeft = stageRect.left - containerRect.left;
      const stageTop = stageRect.top - containerRect.top;
      const stageW = stageRect.width;
      const stageH = stageRect.height;
      const GAP = 12;

      const candidates = [
        { name: 'right-of-bbox', x: stageLeft + bboxRight + GAP, y: stageTop + bboxTop },
        { name: 'left-of-bbox', x: stageLeft + bboxLeft - GAP - cardW, y: stageTop + bboxTop },
        { name: 'below-bbox', x: stageLeft + bboxLeft, y: stageTop + bboxBottom + GAP },
        { name: 'above-bbox', x: stageLeft + bboxLeft, y: stageTop + bboxTop - GAP - cardH },
        { name: 'stage-tl', x: stageLeft + GAP, y: stageTop + GAP },
        { name: 'stage-tr', x: stageLeft + stageW - GAP - cardW, y: stageTop + GAP },
        { name: 'stage-bl', x: stageLeft + GAP, y: stageTop + stageH - GAP - cardH },
        { name: 'stage-br', x: stageLeft + stageW - GAP - cardW, y: stageTop + stageH - GAP - cardH }
      ];

      const overlaps = (x, y) =>
        x < stageLeft + bboxRight &&
        x + cardW > stageLeft + bboxLeft &&
        y < stageTop + bboxBottom &&
        y + cardH > stageTop + bboxTop;

      const inBounds = (x, y) =>
        x >= 0 && y >= 0 && x + cardW <= containerRect.width && y + cardH <= containerRect.height;

      const pick = candidates.find((c) => inBounds(c.x, c.y) && !overlaps(c.x, c.y))
        || candidates.find((c) => inBounds(c.x, c.y))
        || { x: GAP, y: GAP };

      card.style.left = `${Math.max(0, pick.x)}px`;
      card.style.top = `${Math.max(0, pick.y)}px`;
      card.style.visibility = 'visible';
    });
  }

  els.btnLoadImage.addEventListener('click', async () => {
    try {
      setLoadStatus('Opening image dialog…');
      const file = await api.openImage();
      if (!file) {
        setLoadStatus('Image selection canceled');
        return;
      }
      loadImageFromBase64(file.base64, file.name);
    } catch (e) {
      pushLog(`Image load error: ${e.message}`, 'error');
      setLoadStatus('Image load failed');
      showToast(`Image load failed: ${e.message}`, 'error');
    }
  });

  // ---------- CSV telemetry ----------
  els.btnLoadCsv.addEventListener('click', async () => {
    try {
      setLoadStatus('Opening CSV dialog…');
      const file = await api.openCsv();
      if (!file) {
        setLoadStatus('CSV selection canceled');
        return;
      }
      const parsed = parseCsv(file.content);
      const points = parsed.samples;
      if (points.length < 2) {
        const msg = `CSV "${file.name}" contained no usable telemetry rows (skipped ${parsed.stats.skipped})`;
        pushLog(msg, 'error');
        setLoadStatus('CSV parse failed');
        showToast(msg, 'error');
        return;
      }
      setSelectedFile(`CSV: ${file.name}`);
      setLoadStatus(`CSV loaded (${points.length} samples)`);
      pushLog(
        `Loaded CSV "${file.name}" · ${points.length} rows parsed, ${parsed.stats.skipped} skipped, units=${parsed.stats.units}`,
        parsed.stats.skipped > 0 ? 'warn' : 'success'
      );
      augmentVelocity(points);

      const unitsKm = parsed.meta.unitsKm === true;
      const SCENE_PER_KM = SCENE_RADIUS / EARTH_RADIUS_KM;

      let posScale;
      let geoCenter;
      let velScale;
      if (unitsKm) {
        geoCenter = { x: 0, y: 0, z: 0 };
        posScale = SCENE_PER_KM;
        velScale = SCENE_PER_KM;
      } else {
        const xs = points.map((p) => p.x);
        const ys = points.map((p) => p.y);
        const zs = points.map((p) => p.z);
        const spanSize = Math.max(
          Math.max(...xs) - Math.min(...xs),
          Math.max(...ys) - Math.min(...ys),
          Math.max(...zs) - Math.min(...zs)
        ) || 1;
        geoCenter = {
          x: (Math.min(...xs) + Math.max(...xs)) / 2,
          y: (Math.min(...ys) + Math.max(...ys)) / 2,
          z: (Math.min(...zs) + Math.max(...zs)) / 2
        };
        posScale = 7 / spanSize;
        velScale = posScale;
      }

      const t0 = points[0].t;
      const t1 = points[points.length - 1].t;
      const duration = Math.max(1e-9, t1 - t0);
      const samples = points.map((p) => ({
        t: p.t - t0,
        x: (p.x - geoCenter.x) * posScale,
        y: (p.y - geoCenter.y) * posScale,
        z: (p.z - geoCenter.z) * posScale,
        vx: p.vx !== null && p.vx !== undefined ? p.vx * velScale : null,
        vy: p.vy !== null && p.vy !== undefined ? p.vy * velScale : null,
        vz: p.vz !== null && p.vz !== undefined ? p.vz * velScale : null
      }));

      const metaMass = Number.isFinite(parsed.meta.massKg)
        ? parsed.meta.massKg
        : (points.find((p) => p.mass !== null && p.mass !== undefined) || {}).mass;
      const metaKind = parsed.meta.kind || 'Debris';
      const body = {
        name: parsed.meta.objectId || file.name.replace(/\.[^.]+$/, ''),
        type: 'csv',
        kind: metaKind,
        objectId: parsed.meta.objectId || '',
        massKg: Number.isFinite(metaMass) ? metaMass : null,
        unitsKm,
        durationMin: duration,
        samples,
        elements: null,
        inclination: '—',
        eccentricity: '—',
        raan: '—',
        argPerigee: '—',
        impact: '—'
      };
      addOrReplaceBody(body, true);
      switchTab('sim');
    } catch (e) {
      pushLog(`CSV load error: ${e.message}`, 'error');
      setLoadStatus('CSV load failed');
      showToast(`CSV load failed: ${e.message}`, 'error');
    }
  });

  // ---------- TLE parsing & propagation ----------
  els.btnLoadTle.addEventListener('click', async () => {
    try {
      setLoadStatus('Opening TLE dialog…');
      const files = await api.openTle();
      if (!files || files.length === 0) {
        setLoadStatus('TLE selection canceled');
        return;
      }
      const allSatellites = [];
      let totalSkipped = 0;
      for (const file of files) {
        const { entries, stats } = parseTleContent(file.content);
        totalSkipped += stats.skipped;
        if (stats.skipped > 0) {
          pushLog(`TLE "${file.name}" · ${stats.skipped} unpaired line(s) skipped`, 'warn');
        }
        for (const sat of entries) {
          try {
            const elements = tleElements(sat.line2);
            const { track, satrec, error } = generateOrbitTrack(satlib, sat);
            if (!track || track.length === 0) {
              pushLog(`Failed to propagate TLE entry "${sat.name}" (SGP4 error ${error})`, 'error');
              continue;
            }
            allSatellites.push({
              name: sat.name,
              type: 'tle',
              kind: sat.meta?.kind || 'Satellite',
              objectId: sat.meta?.objectId || '',
              massKg: Number.isFinite(sat.meta?.massKg) ? sat.meta.massKg : null,
              unitsKm: true,
              samples: track,
              elements,
              satrec: { jdsatepoch: satrec.jdsatepoch, no: satrec.no },
              inclination: `${elements.inclination.toFixed(2)}°`,
              eccentricity: elements.eccentricity.toFixed(6),
              raan: `${elements.raan.toFixed(2)}°`,
              argPerigee: `${elements.argPerigee.toFixed(2)}°`,
              impact: 'Nominal (no conjunction)'
            });
          } catch (e) {
            pushLog(`Failed to parse TLE entry "${sat.name}": ${e.message}`, 'error');
          }
        }
      }
      computeImpactForBodies(allSatellites);
      if (allSatellites.length === 0) {
        const msg = `No valid TLE entries found (${totalSkipped} skipped)`;
        pushLog(msg, 'error');
        setLoadStatus('TLE parse failed');
        showToast(msg, 'error');
        return;
      }
      setSelectedFile(`TLE: ${files.map((f) => f.name).join(', ')}`);
      setLoadStatus(`${allSatellites.length} satellite(s) loaded`);
      pushLog(
        `Loaded ${allSatellites.length} satellite(s) from ${files.length} TLE file(s)` +
        (totalSkipped > 0 ? ` (${totalSkipped} line(s) skipped)` : ''),
        totalSkipped > 0 ? 'warn' : 'success'
      );
      addOrReplaceBodies(allSatellites, true);
      switchTab('sim');
    } catch (e) {
      pushLog(`TLE load error: ${e.message}`, 'error');
      setLoadStatus('TLE load failed');
      showToast(`TLE load failed: ${e.message}`, 'error');
    }
  });

  function addOrReplaceBodies(bodies, replace = false) {
    if (replace) state.bodies = [];
    for (const b of bodies) state.bodies.push(b);
    if (state.bodies.length > 0) state.selectedBodyIndex = 0;
    if (state.bodyGroup) rebuildBodyVisuals();
    rebuildBodyList();
    updateSimInfo();
  }

  function computeImpactForBodies(bodies) {
    if (!bodies || bodies.length < 2) {
      for (const b of bodies || []) {
        if (b.type !== 'tle') {
          b.impact = 'No conjunction data (mixed units)';
          b.impactColor = '#7a7a82';
          b.impactSeverity = 'NONE';
        } else {
          b.impact = 'Nominal (no conjunction)';
          b.impactColor = '#3ddc84';
          b.impactSeverity = 'NOMINAL';
        }
      }
      return;
    }
    const realKmBodies = bodies.filter((b) => b.unitsKm);
    if (realKmBodies.length < 2) {
      for (const b of bodies) {
        if (b.type !== 'tle') {
          b.impact = 'No conjunction data (mixed units)';
          b.impactColor = '#7a7a82';
          b.impactSeverity = 'NONE';
        } else {
          b.impact = 'Nominal (no conjunction)';
          b.impactColor = '#3ddc84';
          b.impactSeverity = 'NOMINAL';
        }
      }
      return;
    }
    for (let i = 0; i < bodies.length; i++) {
      let worst = { distance: Infinity, peer: null, time: 0, relativeSpeed: NaN };
      for (let j = 0; j < bodies.length; j++) {
        if (i === j) continue;
        if (!bodies[i].unitsKm || !bodies[j].unitsKm) continue;
        const ca = computeClosestApproach(bodies[i].samples, bodies[j].samples);
        if (ca.distance < worst.distance) {
          worst = {
            distance: ca.distance,
            peer: bodies[j].name,
            time: ca.time,
            relativeSpeed: ca.relativeSpeed,
            peerKind: bodies[j].kind || bodies[j].type || 'Unknown'
          };
        }
      }
      if (!bodies[i].unitsKm || !worst.peer) {
        bodies[i].impact = bodies[i].unitsKm
          ? 'Nominal (no conjunction)'
          : 'No conjunction data (mixed units)';
        bodies[i].impactColor = bodies[i].unitsKm ? '#3ddc84' : '#7a7a82';
        bodies[i].impactSeverity = bodies[i].unitsKm ? 'NOMINAL' : 'NONE';
        bodies[i].impactDistance = Infinity;
        bodies[i].impactRelativeSpeed = NaN;
        continue;
      }
      const cls = classifyRisk(worst.distance, worst.relativeSpeed, worst.peerKind, bodies[i].kind || bodies[i].type);
      const tag = ` vs ${worst.peer} (${worst.peerKind})`;
      const speed = Number.isFinite(worst.relativeSpeed) ? ` · v_rel=${worst.relativeSpeed.toFixed(2)} km/s` : '';
      bodies[i].impact = `${cls.text}${tag} @ T+${worst.time.toFixed(1)}m${speed}`;
      bodies[i].impactColor = cls.color;
      bodies[i].impactSeverity = cls.severity;
      bodies[i].impactDistance = worst.distance;
      bodies[i].impactRelativeSpeed = worst.relativeSpeed;
      bodies[i].impactPeer = worst.peer;
      bodies[i].impactPeerKind = worst.peerKind;
    }
  }

  function rebuildBodyList() {
    if (!els.bodyList) return;
    if (state.bodies.length === 0) {
      els.bodyList.innerHTML = '<div class="body-list-title">Tracked Bodies</div><div class="body-list-empty">No bodies loaded</div>';
      return;
    }
    const rows = ['<div class="body-list-title">Tracked Bodies</div>'];
    state.bodies.forEach((b, idx) => {
      const swatch = (b.impactColor && b.impactDistance !== undefined && b.impactDistance < 800)
        ? b.impactColor
        : '#4cc2ff';
      const cls = idx === state.selectedBodyIndex ? 'body-list-row active' : 'body-list-row';
      const safeName = b.name.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const tag = `${b.kind || b.type}${b.unitsKm === false ? ' (norm)' : ''}`;
      rows.push(`<div class="${cls}" data-idx="${idx}"><span class="body-list-swatch" style="background:${swatch}"></span><span class="body-list-name" title="${safeName}">${safeName}</span><span class="body-list-tag">${tag}</span></div>`);
    });
    els.bodyList.innerHTML = rows.join('');
    els.bodyList.querySelectorAll('.body-list-row').forEach((row) => {
      row.addEventListener('click', () => {
        const idx = parseInt(row.getAttribute('data-idx'), 10);
        if (Number.isFinite(idx)) selectBody(idx);
      });
    });
  }

  function selectBody(idx) {
    if (idx < 0 || idx >= state.bodies.length) return;
    state.selectedBodyIndex = idx;
    updateSimInfo();
    rebuildBodyList();
    rebuildBodyVisuals();
    pushLog(`Selected body: ${state.bodies[idx].name}`, 'info');
  }

  function addOrReplaceBody(body, replace = false) {
    addOrReplaceBodies([body], replace);
  }

  // ---------- 3D simulation ----------
  function ensureThreeRenderer() {
    if (state.renderer) {
      onWindowResize();
      return;
    }
    initThree();
  }

  async function initThree() {
    const container = els.threeContainer;
    const rect = container.getBoundingClientRect();
    const width = rect.width || 800;
    const height = rect.height || 600;
    state.canvasSize = { w: width, h: height };

    state.scene = new THREE.Scene();
    state.scene.background = new THREE.Color(0x0a0a12);

    state.camera = new THREE.PerspectiveCamera(55, width / height, 0.01, 1000);
    state.camera.position.set(0, 8, 18);
    state.camera.lookAt(0, 0, 0);

    state.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    state.renderer.setSize(width, height);
    container.appendChild(state.renderer.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, 0.85);
    state.scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xfff6e8, 1.4);
    sun.position.set(20, 12, 14);
    state.scene.add(sun);
    const rim = new THREE.PointLight(0x4cc2ff, 0.5, 60);
    rim.position.set(-10, -8, -6);
    state.scene.add(rim);

    const texturePaths = await api.getTexturePaths();

    const earthGeom = new THREE.SphereGeometry(2, 64, 48);

    const earthTex = await new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(
        texturePaths.earth,
        (tex) => { tex.colorSpace = THREE.SRGBColorSpace; resolve(tex); },
        undefined,
        (err) => reject(err)
      );
    });
    const cloudTex = await new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(
        texturePaths.cloud,
        (tex) => { tex.colorSpace = THREE.SRGBColorSpace; resolve(tex); },
        undefined,
        (err) => reject(err)
      );
    });

    const earthMat = new THREE.MeshPhongMaterial({ map: earthTex, shininess: 18, specular: 0x223344 });
    state.earthMesh = new THREE.Mesh(earthGeom, earthMat);
    state.earthMesh.rotation.y = -Math.PI;
    state.scene.add(state.earthMesh);

    const cloudGeom = new THREE.SphereGeometry(2.02, 48, 32);
    const cloudMat = new THREE.MeshLambertMaterial({ map: cloudTex, transparent: true, opacity: 0.55, depthWrite: false });
    state.cloudMesh = new THREE.Mesh(cloudGeom, cloudMat);
    state.cloudMesh.rotation.y = -Math.PI;
    state.scene.add(state.cloudMesh);

    const ringGeom = new THREE.RingGeometry(2.6, 2.62, 96);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x4cc2ff, transparent: true, opacity: 0.25, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.rotation.x = Math.PI / 2;
    state.scene.add(ring);

    const starGeom = new THREE.BufferGeometry();
    const starCount = 1200;
    const positions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const r = 80 + Math.random() * 60;
      const theta = Math.random() * TWO_PI;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
    }
    starGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.4, sizeAttenuation: true, transparent: true, opacity: 0.85 });
    state.scene.add(new THREE.Points(starGeom, starMat));

    state.bodyGroup = new THREE.Group();
    state.orbitGroup = new THREE.Group();
    state.scene.add(state.bodyGroup);
    state.scene.add(state.orbitGroup);

    state.raycaster = new THREE.Raycaster();
    state.mouse = new THREE.Vector2();

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const dom = state.renderer.domElement;
    dom.addEventListener('mousedown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    window.addEventListener('mouseup', () => { dragging = false; });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      rotateScene(dx * 0.005, dy * 0.005);
    });
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.08 : 0.92;
      state.camera.position.multiplyScalar(factor);
      state.camera.lookAt(0, 0, 0);
    }, { passive: false });
    dom.addEventListener('click', (e) => {
      const rect = dom.getBoundingClientRect();
      state.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      state.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      state.raycaster.setFromCamera(state.mouse, state.camera);
      const meshes = state.bodyGroup.children;
      const hits = state.raycaster.intersectObjects(meshes, false);
      if (hits.length > 0) {
        const hit = hits[0].object;
        const idx = meshes.indexOf(hit);
        if (idx >= 0) selectBody(idx);
      }
    });

    state.lastTime = performance.now();
    state.simulationTime = 0;
    animate();

    if (state.bodies.length === 0) loadDefaultExample();
  }

  function rotateScene(dx, dy) {
    const rot = new THREE.Matrix4().makeRotationFromQuaternion(state.camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyMatrix4(rot);
    const up = new THREE.Vector3(0, 1, 0).applyMatrix4(rot);
    state.camera.position.applyMatrix4(new THREE.Matrix4().makeRotationAxis(up, -dx));
    state.camera.position.applyMatrix4(new THREE.Matrix4().makeRotationAxis(right, -dy));
    state.camera.lookAt(0, 0, 0);
  }

  function onWindowResize() {
    if (!state.renderer) return;
    const container = els.threeContainer;
    const rect = container.getBoundingClientRect();
    const w = rect.width || 800;
    const h = rect.height || 600;
    state.canvasSize = { w, h };
    state.camera.aspect = w / h;
    state.camera.updateProjectionMatrix();
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    state.renderer.setSize(w, h);
    sizeOverlayCanvas();
    if (state.lastDetection) drawOverlay();
  }
  window.addEventListener('resize', onWindowResize);

  const BODY_COLORS = [0xff8c42, 0x63cdff, 0xffd166, 0xef476f, 0x06d6a0, 0xc77dff, 0xff9f1c];

  function rebuildBodyVisuals() {
    while (state.bodyGroup.children.length) state.bodyGroup.remove(state.bodyGroup.children[0]);
    while (state.orbitGroup.children.length) state.orbitGroup.remove(state.orbitGroup.children[0]);
    state.trailGroup = new THREE.Group();
    state.scene.add(state.trailGroup);
    state.bodyTrails = [];
    state.bodies.forEach((body, idx) => {
      const track = body.samples;
      const positions = new Float32Array(track.length * 3);
      for (let i = 0; i < track.length; i++) {
        positions[i * 3] = track[i].x;
        positions[i * 3 + 1] = track[i].y;
        positions[i * 3 + 2] = track[i].z;
      }
      const orbitGeom = new THREE.BufferGeometry();
      orbitGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const isSelected = idx === state.selectedBodyIndex;
      const orbitMat = new THREE.LineBasicMaterial({
        color: isSelected ? 0x63cdff : BODY_COLORS[idx % BODY_COLORS.length],
        transparent: true,
        opacity: isSelected ? 0.95 : 0.45
      });
      const orbitLine = new THREE.Line(orbitGeom, orbitMat);
      orbitLine.userData.index = idx;
      state.orbitGroup.add(orbitLine);

      const bodyGeom = new THREE.SphereGeometry(0.12, 16, 16);
      const bodyMat = new THREE.MeshBasicMaterial({ color: isSelected ? 0xffbf47 : BODY_COLORS[idx % BODY_COLORS.length] });
      const mesh = new THREE.Mesh(bodyGeom, bodyMat);
      mesh.userData.index = idx;
      state.bodyGroup.add(mesh);

      const trailLen = 64;
      const trailPositions = new Float32Array(trailLen * 3);
      const trailGeom = new THREE.BufferGeometry();
      trailGeom.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
      const trailMat = new THREE.LineBasicMaterial({
        color: BODY_COLORS[idx % BODY_COLORS.length],
        transparent: true,
        opacity: 0.7
      });
      const trail = new THREE.Line(trailGeom, trailMat);
      trail.userData.head = 0;
      trail.userData.length = trailLen;
      trail.userData.filled = 0;
      trail.userData.positions = trailPositions;
      state.trailGroup.add(trail);
      state.bodyTrails.push(trail);
    });
  }

  function updateSimInfo() {
    const body = state.bodies[state.selectedBodyIndex];
    if (!body) {
      els.simName.textContent = '—';
      els.simInclination.textContent = '—';
      els.simEccentricity.textContent = '—';
      els.simRaan.textContent = '—';
      els.simArgperigee.textContent = '—';
      els.simImpact.textContent = '—';
      els.simImpact.style.color = '';
      els.simEmpty.style.display = 'flex';
      return;
    }
    els.simEmpty.style.display = 'none';
    els.simName.textContent = body.name;
    els.simInclination.textContent = body.inclination;
    els.simEccentricity.textContent = body.eccentricity;
    els.simRaan.textContent = body.raan;
    els.simArgperigee.textContent = body.argPerigee;
    els.simImpact.textContent = body.impact;
    els.simImpact.style.color = body.impactColor || '';
  }

  function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = (now - state.lastTime) / 1000;
    state.lastTime = now;
    state.simulationTime += dt * state.simSpeed;

    if (state.earthMesh) state.earthMesh.rotation.y += dt * 0.05;
    if (state.cloudMesh) state.cloudMesh.rotation.y += dt * 0.07;

    if (state.bodyGroup && state.bodies.length > 0) {
      for (let i = 0; i < state.bodies.length; i++) {
        const body = state.bodies[i];
        const track = body.samples;
        if (!track || track.length < 2) continue;
        const period = track[track.length - 1].t - track[0].t;
        const phase = ((state.simulationTime * 0.2) % period + period) % period;
        const frac = phase / period;
        const idx = Math.min(track.length - 1, Math.floor(frac * (track.length - 1)));
        const next = Math.min(track.length - 1, idx + 1);
        const localT = frac * (track.length - 1) - idx;
        const a = track[idx];
        const b = track[next];
        const x = a.x + (b.x - a.x) * localT;
        const y = a.y + (b.y - a.y) * localT;
        const z = a.z + (b.z - a.z) * localT;
        const mesh = state.bodyGroup.children[i];
        if (mesh) mesh.position.set(x, y, z);

        if (state.bodyTrails && state.bodyTrails[i]) {
          const trail = state.bodyTrails[i];
          const head = trail.userData.head;
          trail.userData.positions[head * 3] = x;
          trail.userData.positions[head * 3 + 1] = y;
          trail.userData.positions[head * 3 + 2] = z;
          trail.userData.head = (head + 1) % trail.userData.length;
          if (trail.userData.filled < trail.userData.length) trail.userData.filled++;
          trail.geometry.attributes.position.needsUpdate = true;
          trail.geometry.setDrawRange(0, trail.userData.filled);
        }
      }
    }

    if (state.renderer && state.scene && state.camera) {
      state.renderer.render(state.scene, state.camera);
    }
  }

  function loadDefaultExample() {
    const inclination = 51.6400;
    const raan = 0.0000;
    const ecc = 0.0006700;
    const argP = 0.0000;
    const meanAnomaly = 0.0000;
    const meanMotion = 15.50000000;
    const line2 =
      '2 25544 ' +
      inclination.toFixed(4).padStart(8, ' ') +
      raan.toFixed(4).padStart(8, ' ') +
      Math.round(ecc * 1e7).toString().padStart(7, '0') +
      argP.toFixed(4).padStart(8, ' ') +
      meanAnomaly.toFixed(4).padStart(8, ' ') +
      meanMotion.toFixed(8).padStart(11, ' ') +
      '    0';
    const sat = {
      name: 'ISS (example)',
      line1: '1 25544U 98067A   24001.50000000  .00000000  00000-0  00000-0 0  9990',
      line2
    };
    const { track, satrec } = generateOrbitTrack(satlib, sat);
    if (!track || track.length === 0) {
      pushLog('Default example failed to propagate (bad TLE formatting)', 'error');
      return;
    }
    const body = {
      name: 'ISS (example)',
      type: 'tle',
      kind: 'Satellite',
      objectId: '25544',
      massKg: 419725,
      unitsKm: true,
      samples: track,
      satrec: { jdsatepoch: satrec.jdsatepoch, no: satrec.no },
      inclination: `${inclination.toFixed(2)}°`,
      eccentricity: ecc.toFixed(6),
      raan: `${raan.toFixed(2)}°`,
      argPerigee: `${argP.toFixed(2)}°`,
      impact: 'Nominal (example)'
    };
    addOrReplaceBody(body, true);
    pushLog('Loaded default example trajectory (ISS-like LEO)', 'info');
  }

  // ---------- Export log ----------
  els.btnSaveLog.addEventListener('click', async () => {
    try {
      const text = state.log
        .map((e) => `[${e.time}] [${e.level.toUpperCase()}] ${e.message}`)
        .join('\n');
      const header = `D-DAS - Analysis Log\nGenerated: ${new Date().toISOString()}\n\n`;
      const result = await api.saveLog(header + text);
      if (result.success) {
        pushLog(`Log exported to ${result.path}`, 'success');
        showToast(`Log exported to ${result.path}`, 'success');
      } else if (result.reason !== 'canceled') {
        pushLog(`Failed to export log: ${result.reason}`, 'error');
        showToast(`Failed to export log: ${result.reason}`, 'error');
      }
    } catch (e) {
      pushLog(`Export error: ${e.message}`, 'error');
      showToast(`Export error: ${e.message}`, 'error');
    }
  });

  // ---------- Init ----------
  async function init() {
    try {
      const info = await api.getInfo();
      pushLog(`D-DAS ready · Electron ${info.electron} · Node ${info.node}`, 'success');
      els.engineStatus.textContent = `Engine: ready · Electron ${info.electron}`;
      setStatus(true, 'Engine online');
      setLoadStatus('Awaiting data…');
    } catch (e) {
      pushLog(`Failed to load engine info: ${e.message}`, 'error');
      setStatus(false, 'Engine offline');
      showToast(`Engine init failed: ${e.message}`, 'error');
    }
  }

  init();

  if (new URLSearchParams(window.location.search).get('test') === '1') {
    window.__testHooks = {
      switchTab,
      selectBody,
      runDetection,
      state
    };
  }
})();