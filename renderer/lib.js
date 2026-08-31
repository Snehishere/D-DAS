export const TWO_PI = Math.PI * 2;
export const DEG = Math.PI / 180;
export const EARTH_RADIUS_KM = 6371.0;
export const SCENE_RADIUS = 2.0;
export const MINUTES_PER_DAY = 1440;

export function parseCsv(content) {
  const rawLines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (rawLines.length === 0) {
    return { samples: [], meta: {}, stats: { rows: 0, skipped: 0, header: false, units: 'empty' } };
  }

  let header = null;
  let startIdx = 0;
  let headerDetected = false;
  const first = rawLines[0].toLowerCase();
  if (first.includes(',') && (first.includes('time') || first.includes('timestamp') || first.includes('x') || first.includes('y') || first.includes('z'))) {
    header = rawLines[0].split(',').map((c) => c.trim().toLowerCase());
    startIdx = 1;
    headerDetected = true;
  }
  const col = (name, ...aliases) => {
    if (!header) return -1;
    const names = [name, ...aliases];
    for (let i = 0; i < header.length; i++) {
      if (names.includes(header[i])) return i;
    }
    return -1;
  };
  const idxT = col('time_sec', 'time', 't');
  const idxX = col('pos_x_km', 'x');
  const idxY = col('pos_y_km', 'y');
  const idxZ = col('pos_z_km', 'z');
  const idxVx = col('vel_x_kms', 'vx_kms', 'vx');
  const idxVy = col('vel_y_kms', 'vy_kms', 'vy');
  const idxVz = col('vel_z_kms', 'vz_kms', 'vz');
  const idxMass = col('mass_kg', 'mass');
  const idxId = col('object_id', 'id', 'norad_id');
  const idxKind = col('kind', 'object_kind', 'type');

  const hasKmHeader = !!(header && (header.includes('pos_x_km') || header.includes('pos_y_km') || header.includes('pos_z_km')));

  const samples = [];
  let skipped = 0;
  let metaMass = NaN;
  let metaId = '';
  let metaKind = '';
  for (let i = startIdx; i < rawLines.length; i++) {
    const parts = rawLines[i].split(',').map((c) => c.trim());
    if (header) {
      if (parts.length < header.length) { skipped++; continue; }
      const t = parseFloat(parts[idxT >= 0 ? idxT : 0]);
      const x = parseFloat(parts[idxX]);
      const y = parseFloat(parts[idxY]);
      const z = parseFloat(parts[idxZ]);
      if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { skipped++; continue; }
      const vx = idxVx >= 0 ? parseFloat(parts[idxVx]) : NaN;
      const vy = idxVy >= 0 ? parseFloat(parts[idxVy]) : NaN;
      const vz = idxVz >= 0 ? parseFloat(parts[idxVz]) : NaN;
      const m = idxMass >= 0 ? parseFloat(parts[idxMass]) : NaN;
      const id = idxId >= 0 ? parts[idxId] : '';
      const kind = idxKind >= 0 ? parts[idxKind] : '';
      if (!metaId && id) metaId = id;
      if (!metaKind && kind) metaKind = kind;
      if (Number.isFinite(m) && !Number.isFinite(metaMass)) metaMass = m;
      samples.push({
        t,
        x, y, z,
        vx: Number.isFinite(vx) ? vx : null,
        vy: Number.isFinite(vy) ? vy : null,
        vz: Number.isFinite(vz) ? vz : null,
        mass: Number.isFinite(m) ? m : null
      });
    } else {
      if (parts.length < 4) { skipped++; continue; }
      const t = parseFloat(parts[0]);
      const x = parseFloat(parts[1]);
      const y = parseFloat(parts[2]);
      const z = parseFloat(parts[3]);
      if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { skipped++; continue; }
      samples.push({ t, x, y, z, vx: null, vy: null, vz: null, mass: null });
    }
  }
  return {
    samples,
    meta: { objectId: metaId, massKg: metaMass, kind: metaKind, unitsKm: hasKmHeader },
    stats: {
      rows: samples.length,
      skipped,
      header: headerDetected,
      units: header ? (hasKmHeader ? 'km' : 'unknown') : 'normalized'
    }
  };
}

export function augmentVelocity(samples) {
  if (!samples || samples.length < 2) return samples;
  if (samples.every((s) => s.vx === null && s.vy === null && s.vz === null)) {
    for (let i = 0; i < samples.length; i++) {
      let j;
      if (i === 0) j = 1;
      else if (i === samples.length - 1) j = i - 1;
      else j = i + 1;
      const dt = samples[j].t - samples[i].t;
      if (!Number.isFinite(dt) || dt === 0) continue;
      samples[i].vx = (samples[j].x - samples[i].x) / dt;
      samples[i].vy = (samples[j].y - samples[i].y) / dt;
      samples[i].vz = (samples[j].z - samples[i].z) / dt;
    }
    const last = samples.length - 1;
    samples[last].vx = samples[last - 1].vx;
    samples[last].vy = samples[last - 1].vy;
    samples[last].vz = samples[last - 1].vz;
  }
  return samples;
}

export function parseTleContent(content) {
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const out = [];
  let pendingMeta = { objectId: '', massKg: null, kind: 'Satellite' };
  const stats = { entries: 0, skipped: 0 };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.startsWith('#')) {
      const m = ln.match(/^#\s*([A-Za-z_]+)\s*[:=]\s*(.+)$/);
      if (m) {
        const key = m[1].toLowerCase();
        const val = m[2].trim();
        if (key === 'object_id' || key === 'id' || key === 'norad_id') pendingMeta.objectId = val;
        else if (key === 'mass_kg' || key === 'mass') pendingMeta.massKg = parseFloat(val);
        else if (key === 'kind' || key === 'object_kind') pendingMeta.kind = val;
      }
      continue;
    }
    if (/^1 /.test(ln) && i + 1 < lines.length && /^2 /.test(lines[i + 1])) {
      const inferredName = (i > 0 && !/^1 /.test(lines[i - 1]) && !/^2 /.test(lines[i - 1]) && !lines[i - 1].startsWith('#'))
        ? lines[i - 1]
        : pendingMeta.objectId || `Object ${out.length + 1}`;
      out.push({
        name: inferredName,
        line1: lines[i],
        line2: lines[i + 1],
        meta: { ...pendingMeta }
      });
      stats.entries++;
      pendingMeta = { objectId: '', massKg: null, kind: 'Satellite' };
      i += 1;
    } else if (/^[12] /.test(ln)) {
      stats.skipped++;
    }
  }
  return { entries: out, stats };
}

export function tleElements(line2) {
  return {
    inclination: parseFloat(line2.substring(8, 16)),
    raan: parseFloat(line2.substring(17, 25)),
    eccentricity: parseFloat('0.' + line2.substring(26, 33).trim()),
    argPerigee: parseFloat(line2.substring(34, 42)),
    meanAnomaly: parseFloat(line2.substring(43, 51)),
    meanMotion: parseFloat(line2.substring(52, 63))
  };
}

export function classifyImpact(distanceKm) {
  if (!Number.isFinite(distanceKm)) return { text: 'No conjunction data', color: '#7a7a82', severity: 'NONE' };
  if (distanceKm < 1) return { text: `CRITICAL · d=${distanceKm.toFixed(2)} km`, color: '#ff4d6d', severity: 'CRITICAL' };
  if (distanceKm < 300) return { text: `CRITICAL · d=${distanceKm.toFixed(1)} km`, color: '#ff4d6d', severity: 'CRITICAL' };
  if (distanceKm < 800) return { text: `WARNING · d=${distanceKm.toFixed(1)} km`, color: '#ffbf47', severity: 'WARNING' };
  return { text: `Nominal · d=${distanceKm.toFixed(0)} km`, color: '#3ddc84', severity: 'NOMINAL' };
}

export function classifyRisk(distanceKm, relativeSpeedKms, peerKind, selfKind) {
  const base = classifyImpact(distanceKm);
  let severity = base.severity;
  let color = base.color;
  let text = base.text;
  if (Number.isFinite(relativeSpeedKms)) {
    if (relativeSpeedKms > 12 && severity !== 'CRITICAL') {
      severity = 'CRITICAL';
      text = `CRITICAL · d=${distanceKm.toFixed(2)} km, HVR (${relativeSpeedKms.toFixed(1)} km/s)`;
    } else if (relativeSpeedKms > 6 && severity === 'NOMINAL') {
      severity = 'WARNING';
      text = `WARNING · d=${distanceKm.toFixed(1)} km, high-rel-v (${relativeSpeedKms.toFixed(1)} km/s)`;
    }
  }
  if ((peerKind === 'Satellite' || selfKind === 'Satellite') && severity === 'CRITICAL') color = '#ff2d55';
  return { text, color, severity };
}

export function interpolateSample(track, t) {
  if (!track || track.length === 0) return null;
  if (t <= track[0].t) return track[0];
  const last = track[track.length - 1];
  if (t >= last.t) return last;
  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = track[lo];
  const b = track[hi];
  const span = b.t - a.t;
  const f = span > 0 ? (t - a.t) / span : 0;
  return {
    t,
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    z: a.z + (b.z - a.z) * f,
    vx: (a.vx !== null && a.vx !== undefined && b.vx !== null && b.vx !== undefined)
        ? a.vx + (b.vx - a.vx) * f : null,
    vy: (a.vy !== null && a.vy !== undefined && b.vy !== null && b.vy !== undefined)
        ? a.vy + (b.vy - a.vy) * f : null,
    vz: (a.vz !== null && a.vz !== undefined && b.vz !== null && b.vz !== undefined)
        ? a.vz + (b.vz - a.vz) * f : null
  };
}

export function computeClosestApproach(trackA, trackB, samplesPerLeg = 240) {
  if (!trackA || !trackB || trackA.length < 2 || trackB.length < 2) {
    return { distance: Infinity, time: 0, relativeSpeed: NaN, relVx: 0, relVy: 0, relVz: 0 };
  }
  const t0 = Math.max(trackA[0].t, trackB[0].t);
  const t1 = Math.min(trackA[trackA.length - 1].t, trackB[trackB.length - 1].t);
  if (t1 <= t0) return { distance: Infinity, time: 0, relativeSpeed: NaN, relVx: 0, relVy: 0, relVz: 0 };
  let bestD = Infinity;
  let bestT = t0;
  let bestA = trackA[0];
  let bestB = trackB[0];
  for (let i = 0; i < samplesPerLeg; i++) {
    const t = t0 + ((t1 - t0) * i) / (samplesPerLeg - 1);
    const a = interpolateSample(trackA, t);
    const b = interpolateSample(trackB, t);
    if (!a || !b) continue;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < bestD) {
      bestD = d;
      bestT = t;
      bestA = a;
      bestB = b;
    }
  }
  let relVx = 0;
  let relVy = 0;
  let relVz = 0;
  if (bestA.vx !== null && bestA.vx !== undefined && bestB.vx !== null && bestB.vx !== undefined) {
    relVx = bestA.vx - bestB.vx;
    relVy = bestA.vy - bestB.vy;
    relVz = bestA.vz - bestB.vz;
  }
  const relativeSpeed = Math.sqrt(relVx * relVx + relVy * relVy + relVz * relVz);
  return { distance: bestD, time: bestT, relativeSpeed, relVx, relVy, relVz };
}

export function kmToScene(km) {
  return km / EARTH_RADIUS_KM * SCENE_RADIUS;
}

export function sceneToKm(scene) {
  return scene / SCENE_RADIUS * EARTH_RADIUS_KM;
}

export function createSgp4Propagator(satlib, satrec) {
  return (minutesFromEpoch) => {
    const jd = satrec.jdsatepoch + minutesFromEpoch / MINUTES_PER_DAY;
    const arr = satlib.invjday(jd, true);
    if (!arr) return null;
    const [year, mon, day, hr, minute, sec] = arr;
    const result = satlib.propagate(satrec, year, mon, day, hr, minute, sec);
    if (!result || !result.position) return null;
    const v = result.velocity;
    return {
      x: result.position.x,
      y: result.position.y,
      z: result.position.z,
      vx: v ? v.x : null,
      vy: v ? v.y : null,
      vz: v ? v.z : null
    };
  };
}

export function generateOrbitTrack(satlib, sat, options = {}) {
  const satrec = satlib.twoline2satrec(sat.line1, sat.line2);
  if (satrec.error) return { track: [], error: satrec.error };
  const prop = createSgp4Propagator(satlib, satrec);
  const points = options.points || 360;
  const periodMin = options.periodMinutes || (TWO_PI / satrec.no);
  const periods = options.periods || 1.5;
  const total = periodMin * periods;
  const trackOut = [];
  for (let i = 0; i <= points; i++) {
    const minutes = (i / points) * total;
    const p = prop(minutes);
    if (!p) continue;
    trackOut.push({
      t: minutes,
      x: p.x,
      y: p.z,
      z: -p.y,
      vx: p.vx,
      vy: p.vz,
      vz: -p.vy
    });
  }
  return { track: trackOut, satrec };
}