// Generates physically-consistent test fixtures for D-DAS collision scenarios.
// Each scenario produces two bodies (one in CSV form, one in TLE form)
// whose orbits are computed from real SGP4 propagation (via satellite.js)
// so the closest-approach predictions match what the renderer will compute.
//
// Outputs:
//   test/scenarios/csv/<scenario>.csv
//   test/scenarios/tle/<scenario>.tle  (with # META headers)
//   test/scenarios/index.json           (machine-readable summary)
//
// Run:  node test/generate-scenarios.js
//
// This script requires satellite.js to be installed (npm install satellite.js).

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const DEG = Math.PI / 180;
const MU = 398600.4418;
const R_EARTH_KM = 6378.137;
const MINUTES_PER_DAY = 1440;

const satlibPath = pathToFileURL(path.join(__dirname, '..', 'node_modules', 'satellite.js', 'dist', 'index.js')).href;

(async () => {
  const satlib = await import(satlibPath);
  generate(satlib);
})().catch((e) => { console.error(e); process.exit(1); });

function keplerPeriod(elements) {
  const a = elements.a;
  return 2 * Math.PI * Math.sqrt(a * a * a / MU);
}

function leoElements(altKm, incDeg, raanDeg, argpDeg, m0Deg) {
  return {
    a: R_EARTH_KM + altKm,
    e: 0.0006,
    i: incDeg,
    raan: raanDeg,
    argp: argpDeg,
    M0: m0Deg
  };
}

function padLeft(str, width) {
  str = String(str);
  return str.length >= width ? str : ' '.repeat(width - str.length) + str;
}

function writeCsv(outPath, samples, meta) {
  const lines = [
    'timestamp,time_sec,object_id,pos_x_km,pos_y_km,pos_z_km,vel_x_kms,vel_y_kms,vel_z_kms,mass_kg,kind'
  ];
  const t0 = new Date('2026-08-31T00:00:00Z').getTime();
  for (const s of samples) {
    const ts = new Date(t0 + s.tSec * 1000).toISOString();
    lines.push([
      ts,
      s.tSec.toFixed(3),
      meta.objectId,
      s.x.toFixed(3),
      s.y.toFixed(3),
      s.z.toFixed(3),
      s.vx.toFixed(6),
      s.vy.toFixed(6),
      s.vz.toFixed(6),
      meta.massKg,
      meta.kind
    ].join(','));
  }
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
}

function writeTleTriplet(outPath, name, elements, meta) {
  const idDigits = (meta.objectId || '99000').replace(/\D/g, '').slice(-5).padStart(5, '0');
  const norad = String(parseInt(idDigits, 10) % 99999).padStart(5, '0');
  const periodSec = keplerPeriod(elements);
  const meanMotion = 86400 / periodSec;

  const line1 = `1 ${norad}U 25001A   26243.00000000  .00000000  00000-0  00000-0 0    999`;

  const inclination = padLeft(elements.i.toFixed(4), 8);
  const raan = padLeft(elements.raan.toFixed(4), 8);
  const eccInt = padLeft(String(Math.round(elements.e * 1e7)), 7).replace(/ /g, '0');
  const argp = padLeft(elements.argp.toFixed(4), 8);
  const mAnom = padLeft(elements.M0.toFixed(4), 8);
  const mm = padLeft(meanMotion.toFixed(8), 11);
  const line2 =
    '2 ' +
    norad +
    ' ' + inclination +
    ' ' + raan +
    ' ' + eccInt +
    ' ' + argp +
    ' ' + mAnom +
    ' ' + mm;

  const metaLines = [
    `# OBJECT_ID: ${meta.objectId}`,
    `# MASS_KG: ${meta.massKg}`,
    `# KIND: ${meta.kind}`,
    name,
    line1,
    line2
  ];
  fs.writeFileSync(outPath, metaLines.join('\n') + '\n');
}

function buildTleRec(satlib, elements) {
  const idDigits = '99000';
  const norad = idDigits;
  const periodSec = keplerPeriod(elements);
  const meanMotion = 86400 / periodSec;
  const inclination = padLeft(elements.i.toFixed(4), 8);
  const raan = padLeft(elements.raan.toFixed(4), 8);
  const eccInt = padLeft(String(Math.round(elements.e * 1e7)), 7).replace(/ /g, '0');
  const argp = padLeft(elements.argp.toFixed(4), 8);
  const mAnom = padLeft(elements.M0.toFixed(4), 8);
  const mm = padLeft(meanMotion.toFixed(8), 11);
  const line1 = `1 ${norad}U 25001A   26243.00000000  .00000000  00000-0  00000-0 0    999`;
  const line2 = '2 ' + norad + ' ' + inclination + ' ' + raan + ' ' + eccInt + ' ' + argp + ' ' + mAnom + ' ' + mm;
  return satlib.twoline2satrec(line1, line2);
}

function sampleTrackSgp4(satlib, satrec, durationSec, stepSec) {
  const out = [];
  const epochMs = Date.UTC(2026, 7, 31, 0, 0, 0);
  for (let t = 0; t <= durationSec; t += stepSec) {
    const dateMs = epochMs + t * 1000;
    const d = new Date(dateMs);
    const yr = d.getUTCFullYear();
    const mo = d.getUTCMonth() + 1;
    const da = d.getUTCDate();
    const hr = d.getUTCHours();
    const mn = d.getUTCMinutes();
    const sc = d.getUTCSeconds() + d.getUTCMilliseconds() / 1000;
    const r = satlib.propagate(satrec, yr, mo, da, hr, mn, sc);
    if (!r || !r.position) continue;
    out.push({
      tSec: t,
      x: r.position.x,
      y: r.position.y,
      z: r.position.z,
      vx: r.velocity.x,
      vy: r.velocity.y,
      vz: r.velocity.z
    });
  }
  return out;
}

function nearestApproachSameTime(samplesA, samplesB) {
  const len = Math.min(samplesA.length, samplesB.length);
  if (len < 2) return { dKm: Infinity, tSec: 0, relSpeed: NaN };
  const t0 = samplesA[0].tSec;
  const t1 = samplesA[len - 1].tSec;
  const totalSpan = t1 - t0;
  const step = samplesA[1].tSec - samplesA[0].tSec;
  let best = { d: Infinity, t: t0, a: null, b: null };
  for (let i = 0; i <= 2400; i++) {
    const t = t0 + (totalSpan * i) / 2400;
    const f = (t - t0) / step;
    const idx = Math.floor(f);
    const frac = f - idx;
    const a1 = samplesA[idx];
    const a2 = samplesA[Math.min(idx + 1, len - 1)];
    const b1 = samplesB[idx];
    const b2 = samplesB[Math.min(idx + 1, len - 1)];
    const a = {
      x: a1.x + (a2.x - a1.x) * frac,
      y: a1.y + (a2.y - a1.y) * frac,
      z: a1.z + (a2.z - a1.z) * frac,
      vx: a1.vx + (a2.vx - a1.vx) * frac,
      vy: a1.vy + (a2.vy - a1.vy) * frac,
      vz: a1.vz + (a2.vz - a1.vz) * frac
    };
    const b = {
      x: b1.x + (b2.x - b1.x) * frac,
      y: b1.y + (b2.y - b1.y) * frac,
      z: b1.z + (b2.z - b1.z) * frac,
      vx: b1.vx + (b2.vx - b1.vx) * frac,
      vy: b1.vy + (b2.vy - b1.vy) * frac,
      vz: b1.vz + (b2.vz - b1.vz) * frac
    };
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < best.d) best = { d, t, a, b };
  }
  let relSpeed = NaN;
  if (best.a && best.b) {
    const dvx = best.a.vx - best.b.vx;
    const dvy = best.a.vy - best.b.vy;
    const dvz = best.a.vz - best.b.vz;
    relSpeed = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
  }
  return { dKm: best.d, tSec: best.t, relSpeed };
}

function buildCriticalScenario() {
  const sat = leoElements(420, 51.6, 0, 0, 0);
  sat.label = 'ISS-like';
  sat.kind = 'Satellite';
  sat.objectId = '25544';
  sat.massKg = 419725;
  const debris = leoElements(420, 51.6, 0, 0, 1.5);
  debris.label = 'Debris-A';
  debris.kind = 'Debris';
  debris.objectId = 'DEB-9001';
  debris.massKg = 8;
  return { sat, debris, expected: 'CRITICAL', note: 'Two co-planar LEO bodies, ~1.5° phase offset produces a closest approach of ~180 km.' };
}

function buildWarningScenario() {
  const sat = leoElements(550, 53, 30, 0, 0);
  sat.label = 'Starlink-shell-1';
  sat.kind = 'Satellite';
  sat.objectId = 'STAR-1234';
  sat.massKg = 260;
  const debris = leoElements(550, 53, 30, 0, 3.5);
  debris.label = 'Fragment-B';
  debris.kind = 'Debris';
  debris.objectId = 'DEB-4411';
  debris.massKg = 2;
  return { sat, debris, expected: 'WARNING', note: 'LEO satellite and a debris fragment on the same orbit with ~3.5° phase offset.' };
}

function buildNominalScenario() {
  const sat = leoElements(420, 51.6, 0, 0, 0);
  sat.label = 'SafeSat';
  sat.kind = 'Satellite';
  sat.objectId = '25544';
  sat.massKg = 419725;
  const debris = leoElements(1420, 80, 30, 0, 90);
  debris.label = 'Polar-Fragment';
  debris.kind = 'Debris';
  debris.objectId = 'DEB-2210';
  debris.massKg = 3;
  return { sat, debris, expected: 'Nominal', note: 'LEO satellite and a debris fragment 1000 km apart in altitude with very different inclination.' };
}

function buildGeoLeoScenario() {
  const geo = {
    a: 42164,
    e: 0.0001,
    i: 0.05,
    raan: 75,
    argp: 0,
    M0: 0,
    label: 'GeoSat-19',
    kind: 'Satellite',
    objectId: 'GEO-19',
    massKg: 2200
  };
  const debris = leoElements(450, 65, 110, 0, 0);
  debris.label = 'High-Inc-Debris';
  debris.kind = 'Debris';
  debris.objectId = 'DEB-7702';
  debris.massKg = 12;
  return { geo, debris, expected: 'Nominal', note: 'A geostationary satellite and a high-inclination LEO debris fragment.' };
}

function buildHeadOnScenario() {
  const sat = leoElements(600, 70, 0, 0, 0);
  sat.label = 'PolarSat-A';
  sat.kind = 'Satellite';
  sat.objectId = 'POLR-A';
  sat.massKg = 850;
  const debris = {
    a: R_EARTH_KM + 600,
    e: 0.0006,
    i: 110,
    raan: 0,
    argp: 0,
    M0: 0,
    label: 'Retrograde-Fragment',
    kind: 'Debris',
    objectId: 'DEB-RETRO',
    massKg: 4
  };
  return { sat, debris, expected: 'CRITICAL', note: 'Polar satellite and a retrograde debris fragment (inclination >90°): head-on crossing.' };
}

function generate(satlib) {
  const scenarios = [
    ['01_critical', buildCriticalScenario()],
    ['02_warning', buildWarningScenario()],
    ['03_nominal', buildNominalScenario()],
    ['04_geo_vs_leo', buildGeoLeoScenario()],
    ['05_headon', buildHeadOnScenario()]
  ];

  const indexEntries = [];

  for (const [slug, sc] of scenarios) {
    const A = sc.sat || sc.geo;
    const B = sc.debris;
    const satPeriodSec = keplerPeriod(A);
    const duration = satPeriodSec * 2;
    const step = 30;

    const satRecA = buildTleRec(satlib, A);
    const satRecB = buildTleRec(satlib, B);
    const samplesA = sampleTrackSgp4(satlib, satRecA, duration, step);
    const samplesB = sampleTrackSgp4(satlib, satRecB, duration, step);
    const na = nearestApproachSameTime(samplesA, samplesB);

    const csvPath = path.join(__dirname, 'scenarios', 'csv', slug + '.csv');
    const tlePath = path.join(__dirname, 'scenarios', 'tle', slug + '.tle');
    writeCsv(csvPath, samplesB, { objectId: B.objectId, massKg: B.massKg, kind: B.kind });
    writeTleTriplet(tlePath, A.label, A, { objectId: A.objectId, massKg: A.massKg, kind: A.kind });

    indexEntries.push({
      slug,
      expected: sc.expected,
      note: sc.note,
      satellite: { objectId: A.objectId, kind: A.kind, massKg: A.massKg, label: A.label, format: 'tle' },
      debris: { objectId: B.objectId, kind: B.kind, massKg: B.massKg, label: B.label, format: 'csv' },
      computed: {
        closestApproachKm: na.dKm,
        timeToClosestApproachSec: na.tSec,
        relativeSpeedKms: na.relSpeed
      }
    });
  }

  fs.writeFileSync(
    path.join(__dirname, 'scenarios', 'index.json'),
    JSON.stringify(indexEntries, null, 2)
  );

  console.log('Generated scenarios (SGP4-via-satellite.js):');
  for (const e of indexEntries) {
    console.log(
      `  ${e.slug.padEnd(14)} ${e.expected.padEnd(14)} ` +
      `closest=${e.computed.closestApproachKm.toFixed(2)} km  ` +
      `v_rel=${e.computed.relativeSpeedKms.toFixed(2)} km/s  ` +
      `t=${e.computed.timeToClosestApproachSec.toFixed(0)}s`
    );
  }
}