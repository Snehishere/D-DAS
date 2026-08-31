// Exercises the real D-DAS parser+collision pipeline (renderer/lib.js) against
// the generated test fixtures and asserts that each scenario classifies as
// expected. After the Aug 31 refactor, this runner is a thin wrapper around
// lib.js for parsing + SGP4 propagation + closest-approach.
//
// Run:  node test/run-scenarios.js
//
// Exits with non-zero status if any scenario does not match.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const libPath = pathToFileURL(path.join(__dirname, '..', 'renderer', 'lib.js')).href;
const satlibPath = pathToFileURL(path.join(__dirname, '..', 'node_modules', 'satellite.js', 'dist', 'index.js')).href;

let classifyImpact, parseCsv, parseTleContent, tleElements, generateOrbitTrack, computeClosestApproach;
let satlib;

(async () => {
  satlib = await import(satlibPath);
  const lib = await import(libPath);
  classifyImpact = lib.classifyImpact;
  parseCsv = lib.parseCsv;
  parseTleContent = lib.parseTleContent;
  tleElements = lib.tleElements;
  generateOrbitTrack = lib.generateOrbitTrack;
  computeClosestApproach = lib.computeClosestApproach;
  run();
})().catch((e) => { console.error(e); process.exit(1); });

function buildBodyFromTle(sat) {
  const elements = tleElements(sat.line2);
  const { track } = generateOrbitTrack(satlib, sat, { points: 360, periods: 2 });
  return {
    name: sat.name,
    type: 'tle',
    kind: sat.meta.kind || 'Satellite',
    objectId: sat.meta.objectId || '',
    massKg: Number.isFinite(sat.meta.massKg) ? sat.meta.massKg : null,
    samples: track,
    elements,
    unitsKm: true
  };
}

function buildBodyFromCsv(fileContent, fileName) {
  const parsed = parseCsv(fileContent);
  const points = parsed.samples;
  if (points.length < 2) throw new Error('CSV had too few rows');
  const kmUnits = parsed.meta.unitsKm === true;
  // CSV is stored in time_sec; the runner compares against TLE samples which are
  // in minutes-from-epoch. Convert to minutes so the two timelines align.
  // The TLE track applies the (y=z, z=-y) scene-convention swap in lib.js's
  // generateOrbitTrack, so apply the same swap here to keep distances comparable.
  const samples = points.map((p) => {
    const xs = p.x;
    const ys = kmUnits ? p.z : p.y;
    const zs = kmUnits ? -p.y : p.z;
    return {
      t: p.t / 60,
      x: xs,
      y: ys,
      z: zs,
      vx: p.vx !== null && p.vx !== undefined ? p.vx : null,
      vy: p.vy !== null && p.vy !== undefined ? (kmUnits ? p.vz : p.vy) : null,
      vz: p.vz !== null && p.vz !== undefined ? (kmUnits ? -p.vy : p.vz) : null
    };
  });
  return {
    name: parsed.meta.objectId || fileName.replace(/\.[^.]+$/, ''),
    type: 'csv',
    kind: parsed.meta.kind || 'Debris',
    objectId: parsed.meta.objectId || '',
    massKg: Number.isFinite(parsed.meta.massKg) ? parsed.meta.massKg : null,
    unitsKm: kmUnits,
    samples
  };
}

function run() {
  const indexPath = path.join(__dirname, 'scenarios', 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  let pass = 0;
  let fail = 0;
  console.log('D-DAS scenario validator (lib.js + satellite.js SGP4)');
  console.log('=======================================================\n');

  for (const entry of index) {
    const slug = entry.slug;
    const expected = entry.expected;
    const csvPath = path.join(__dirname, 'scenarios', 'csv', slug + '.csv');
    const tlePath = path.join(__dirname, 'scenarios', 'tle', slug + '.tle');

    const csvText = fs.readFileSync(csvPath, 'utf8');
    const tleText = fs.readFileSync(tlePath, 'utf8');

    const tleParsed = parseTleContent(tleText);
    const [satEntry] = tleParsed.entries;
    if (!satEntry) {
      console.log(`  [FAIL] ${slug}: TLE did not parse`);
      fail++;
      continue;
    }
    const sat = buildBodyFromTle(satEntry);
    const debris = buildBodyFromCsv(csvText, slug + '.csv');

    if (debris.samples.length < 2) {
      console.log(`  [FAIL] ${slug}: CSV had <2 samples`);
      fail++;
      continue;
    }

    const ca = computeClosestApproach(sat.samples, debris.samples, 2400);
    const cls = classifyImpact(ca.distance);
    const severity = cls.severity;
    const expectedTag = expected.split(' ')[0].toUpperCase();
    const matches = severity === expectedTag;

    const status = matches ? 'PASS' : 'FAIL';
    console.log(
      `  [${status}] ${slug.padEnd(16)} expect=${expected.padEnd(16)} ` +
      `got=${severity.padEnd(10)} closest=${ca.distance.toFixed(2)} km ` +
      `t=${ca.time.toFixed(1)} min rel=${Number.isFinite(ca.relativeSpeed) ? ca.relativeSpeed.toFixed(2) + ' km/s' : 'n/a'}`
    );
    if (matches) pass++;
    else fail++;
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
}