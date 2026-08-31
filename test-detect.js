const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const DEBRIS_DIR = path.join(__dirname, '..', 'debris-detection');
const TEST_DIR = path.join(DEBRIS_DIR, 'test');

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

function detectComponents(luma, w, h, opts) {
  const { radius, threshold, minSize } = opts;
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
      comps.push({ cx: sumX / count, cy: sumY / count, size: count, meanL: sumL / count, minX, minY, maxX, maxY });
    }
  }
  return comps;
}

function loadSamples(imageDir, maxCount) {
  const entries = fs.readdirSync(imageDir).filter((f) => /\.(jpg|jpeg)$/i.test(f));
  entries.sort();
  const picked = maxCount > 0 ? entries.slice(0, maxCount) : entries;
  const samples = [];
  for (const name of picked) {
    const buf = fs.readFileSync(path.join(imageDir, name));
    const raw = jpeg.decode(buf, { useTArray: true });
    const w = raw.width;
    const h = raw.height;
    const data = raw.data;
    const luma = new Float32Array(w * h);
    for (let i = 0, p = 0; p < luma.length; i += 4, p++) {
      luma[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
    samples.push({ id: path.basename(name, path.extname(name)), w, h, luma });
  }
  return samples;
}

// Self-evaluation: we don't trust the dataset's sample_submission.csv bboxes
// (they don't represent spatial boxes in this format), so the harness
// reports detection statistics: distribution of detection counts per image,
// fraction of images with N>=1 detection, and average primary meanL.
function evaluate(opts, samples) {
  const counts = [];
  let meanLs = [];
  let primarySizes = [];
  let withAtLeastOne = 0;
  for (const s of samples) {
    const dets = detectComponents(s.luma, s.w, s.h, opts);
    counts.push(dets.length);
    if (dets.length > 0) {
      withAtLeastOne++;
      dets.sort((a, b) => (b.meanL * b.size) - (a.meanL * a.size));
      meanLs.push(dets[0].meanL);
      primarySizes.push(dets[0].size);
    }
  }
  const avg = counts.reduce((a, b) => a + b, 0) / Math.max(1, counts.length);
  const maxCount = counts.reduce((a, b) => Math.max(a, b), 0);
  const avgMeanL = meanLs.length ? meanLs.reduce((a, b) => a + b, 0) / meanLs.length : 0;
  const avgSize = primarySizes.length ? primarySizes.reduce((a, b) => a + b, 0) / primarySizes.length : 0;
  return {
    avgCountPerImage: avg,
    maxCount,
    detectionRate: withAtLeastOne / Math.max(1, samples.length),
    avgPrimaryMeanL: avgMeanL,
    avgPrimarySize: avgSize,
    countDistribution: counts
  };
}

function paramSearch(samples) {
  const radii = [5, 7, 9, 11, 13];
  const thresholds = [3, 5, 6, 8, 10];
  const minSizes = [20, 30, 40, 60];
  let best = null;
  const results = [];
  for (const r of radii) {
    for (const t of thresholds) {
      for (const m of minSizes) {
        const opts = { radius: r, threshold: t, minSize: m };
        const mEval = evaluate(opts, samples);
        const score = mEval.detectionRate * 0.6
                    + Math.min(mEval.avgCountPerImage, 4) / 4 * 0.2
                    + Math.min(mEval.avgPrimaryMeanL, 100) / 100 * 0.2;
        results.push({ ...opts, ...mEval, score });
        if (!best || score > best.score) best = { ...opts, ...mEval, score };
      }
    }
  }
  return { best, results };
}

function main() {
  const args = process.argv.slice(2);
  const maxCount = args.includes('--all') ? 0 : 80;
  const search = args.includes('--search');

  if (!fs.existsSync(TEST_DIR)) {
    console.error(`Missing image dir ${TEST_DIR}`);
    process.exit(1);
  }
  console.log(`Decoding up to ${maxCount || 'all'} images from ${TEST_DIR}`);
  const t0 = Date.now();
  const samples = loadSamples(TEST_DIR, maxCount);
  const decodeMs = Date.now() - t0;
  console.log(`Loaded ${samples.length} samples in ${decodeMs}ms`);

  if (search) {
    console.log('Running grid search...');
    const { best, results } = paramSearch(samples);
    results.sort((a, b) => b.score - a.score);
    console.log('\nTop 5 by score:');
    for (const r of results.slice(0, 5)) {
      console.log(`  r=${r.radius} t=${r.threshold} s=${r.minSize} detRate=${r.detectionRate.toFixed(2)} avgCount=${r.avgCountPerImage.toFixed(2)} meanL=${r.avgPrimaryMeanL.toFixed(1)}`);
    }
    console.log('\nBest:', best);
  } else {
    const opts = { radius: 9, threshold: 6, minSize: 40 };
    const t1 = Date.now();
    const m = evaluate(opts, samples);
    const evalMs = Date.now() - t1;
    console.log(`Default params r=${opts.radius} t=${opts.threshold} s=${opts.minSize}`);
    console.log(`  detectionRate=${m.detectionRate.toFixed(2)} avgCount=${m.avgCountPerImage.toFixed(2)} maxCount=${m.maxCount}`);
    console.log(`  avgPrimaryMeanL=${m.avgPrimaryMeanL.toFixed(1)} avgPrimarySize=${m.avgPrimarySize.toFixed(1)}`);
    console.log(`  eval in ${evalMs}ms (${(evalMs / samples.length).toFixed(2)}ms/image)`);
  }
}

main();