import * as THREE from 'three';
import * as satlib from 'satellite.js';
import { api } from './api.js';
import {
  initElements,
  pushLog,
  showToast,
  setStatus,
  setLoadStatus,
  setSelectedFile,
  switchTab,
  bindTabEvents,
  bindButtonEvents,
  els,
  getLog,
} from './ui.js';
import {
  loadImageFromBase64,
  getState as getDetectionState,
  sizeOverlayCanvas,
  drawOverlay,
} from './image-detection.js';
import {
  loadCsv,
  loadTle,
  computeImpactForBodies,
} from './simulation.js';
import { ThreeScene } from './three-scene.js';
import { generateOrbitTrack } from './lib.js';

const state = {
  bodies: [],
  selectedBodyIndex: 0,
  threeScene: null,
  lastDetection: null,
  simSpeed: 1.0,
};

async function init() {
  initElements();

  bindTabEvents(
    () => switchTab('image'),
    () => switchTab('sim'),
  );

  bindButtonEvents({
    onLoadImage: handleLoadImage,
    onLoadCsv: handleLoadCsv,
    onLoadTle: handleLoadTle,
    onSaveLog: handleSaveLog,
  });

  try {
    const info = await api.getInfo();
    pushLog(`D-DAS ready \u00b7 Electron ${info.electron} \u00b7 Node ${info.node}`, 'success');
    els.engineStatus.textContent = `Engine: ready \u00b7 Electron ${info.electron}`;
    setStatus(true, 'Engine online');
    setLoadStatus('Awaiting data\u2026');
  } catch (e) {
    pushLog(`Failed to load engine info: ${e.message}`, 'error');
    setStatus(false, 'Engine offline');
    showToast(`Engine init failed: ${e.message}`, 'error');
  }
}

async function handleLoadImage() {
  try {
    setLoadStatus('Opening image dialog\u2026');
    const file = await api.openImage();
    if (!file) {
      setLoadStatus('Image selection canceled');
      return;
    }
    loadImageFromBase64(file.base64, file.name, els, pushLog, showToast);
  } catch (e) {
    pushLog(`Image load error: ${e.message}`, 'error');
    setLoadStatus('Image load failed');
    showToast(`Image load failed: ${e.message}`, 'error');
  }
}

async function handleLoadCsv() {
  try {
    setLoadStatus('Opening CSV dialog\u2026');
    const file = await api.openCsv();
    if (!file) {
      setLoadStatus('CSV selection canceled');
      return;
    }
    loadCsv(file, api, els, pushLog, showToast, setSelectedFile, setLoadStatus, switchTab, addOrReplaceBodies);
  } catch (e) {
    pushLog(`CSV load error: ${e.message}`, 'error');
    setLoadStatus('CSV load failed');
    showToast(`CSV load failed: ${e.message}`, 'error');
  }
}

async function handleLoadTle() {
  try {
    setLoadStatus('Opening TLE dialog\u2026');
    const files = await api.openTle();
    if (!files || files.length === 0) {
      setLoadStatus('TLE selection canceled');
      return;
    }
    loadTle(files, satlib, els, pushLog, showToast, setSelectedFile, setLoadStatus, switchTab, addOrReplaceBodies);
  } catch (e) {
    pushLog(`TLE load error: ${e.message}`, 'error');
    setLoadStatus('TLE load failed');
    showToast(`TLE load failed: ${e.message}`, 'error');
  }
}

async function handleSaveLog() {
  try {
    const text = state.bodies.length > 0
      ? state.bodies.map((b) => `${b.name}: ${b.impact}`).join('\n')
      : 'No bodies loaded';
    const logText = getLog()
      .map((e) => `[${e.time}] [${e.level.toUpperCase()}] ${e.message}`)
      .join('\n');
    const header = `D-DAS - Analysis Log\nGenerated: ${new Date().toISOString()}\n\n`;
    const result = await api.saveLog(header + logText);
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
}

function addOrReplaceBodies(bodies, replace = false) {
  if (replace) {
    state.bodies = [];
  }
  for (const b of bodies) {
    state.bodies.push(b);
  }
  if (state.bodies.length > 0) {
    state.selectedBodyIndex = 0;
  }
  if (state.threeScene) {
    state.threeScene.rebuildBodyVisuals(state.bodies, state.selectedBodyIndex);
    rebuildBodyList();
    updateSimInfo();
  }
}

function rebuildBodyList() {
  if (!els.bodyList) {
    return;
  }
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
    const safeName = b.name.replace(/[&<>"']/g, (c) => ({
      '&': '&',
      '<': '<',
      '>': '>',
      '"': '"',
      '\'': '&#39;',
    }[c]));
    const tag = `${b.kind || b.type}${b.unitsKm === false ? ' (norm)' : ''}`;
    rows.push(`<div class="${cls}" data-idx="${idx}"><span class="body-list-swatch" style="background:${swatch}"></span><span class="body-list-name" title="${safeName}">${safeName}</span><span class="body-list-tag">${tag}</span></div>`);
  });
  els.bodyList.innerHTML = rows.join('');
  els.bodyList.querySelectorAll('.body-list-row').forEach((row) => {
    row.addEventListener('click', () => {
      const idx = parseInt(row.getAttribute('data-idx'), 10);
      if (Number.isFinite(idx)) {
        selectBody(idx);
      }
    });
  });
}

function selectBody(idx) {
  if (idx < 0 || idx >= state.bodies.length) {
    return;
  }
  state.selectedBodyIndex = idx;
  updateSimInfo();
  rebuildBodyList();
  if (state.threeScene) {
    state.threeScene.rebuildBodyVisuals(state.bodies, state.selectedBodyIndex);
  }
  pushLog(`Selected body: ${state.bodies[idx].name}`, 'info');
}

function updateSimInfo() {
  const body = state.bodies[state.selectedBodyIndex];
  if (!body) {
    els.simName.textContent = '\u2014';
    els.simInclination.textContent = '\u2014';
    els.simEccentricity.textContent = '\u2014';
    els.simRaan.textContent = '\u2014';
    els.simArgperigee.textContent = '\u2014';
    els.simImpact.textContent = '\u2014';
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

async function ensureThreeRenderer() {
  if (state.threeScene) {
    state.threeScene.resize();
    return;
  }
  state.threeScene = new ThreeScene(els.threeContainer, api);
  state.threeScene.setBodyClickHandler(selectBody);
  await state.threeScene.init();
  if (state.bodies.length > 0) {
    state.threeScene.rebuildBodyVisuals(state.bodies, state.selectedBodyIndex);
  } else {
    loadDefaultExample();
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
    line2,
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
    inclination: `${inclination.toFixed(2)}\u00b0`,
    eccentricity: ecc.toFixed(6),
    raan: `${raan.toFixed(2)}\u00b0`,
    argPerigee: `${argP.toFixed(2)}\u00b0`,
    impact: 'NOMINAL (example)',
  };
  addOrReplaceBodies([body], true);
  pushLog('Loaded default example trajectory (ISS-like LEO)', 'info');
}

function animate() {
  requestAnimationFrame(animate);
  if (state.threeScene) {
    state.threeScene.animate(state.bodies);
  }
  const detectionState = getDetectionState();
  if (detectionState.lastDetection) {
    drawOverlay(els);
  }
}

window.addEventListener('resize', () => {
  if (state.threeScene) {
    state.threeScene.resize();
  }
  sizeOverlayCanvas(els);
  const detectionState = getDetectionState();
  if (detectionState.lastDetection) {
    drawOverlay(els);
  }
});

init();
animate();

if (new URLSearchParams(window.location.search).get('test') === '1') {
  window.__testHooks = {
    switchTab,
    selectBody,
    state,
  };
}
