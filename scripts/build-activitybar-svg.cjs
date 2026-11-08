const fs = require('fs');
const zlib = require('zlib');

// Read cropped PNG
const buf = fs.readFileSync('media/gravix-logo-crop.png');
const chunks = [];
let offset = 8, width = 0, height = 0;
while (offset < buf.length) {
  const len = buf.readUInt32BE(offset);
  const type = buf.toString('ascii', offset + 4, offset + 8);
  if (type === 'IHDR') {
    width = buf.readUInt32BE(offset + 8);
    height = buf.readUInt32BE(offset + 12);
  } else if (type === 'IDAT') chunks.push(buf.subarray(offset + 8, offset + 8 + len));
  offset += 12 + len;
}
const decompressed = zlib.inflateSync(Buffer.concat(chunks));
const stride = 1 + width * 4;

const gridW = 256, gridH = 256;
const bin = new Uint8Array(gridW * gridH);
for (let gy = 0; gy < gridH; gy++) {
  const py = Math.floor((gy / gridH) * height);
  for (let gx = 0; gx < gridW; gx++) {
    const px = Math.floor((gx / gridW) * width);
    bin[gy * gridW + gx] = decompressed[py * stride + 1 + px * 4 + 3] > 110 ? 1 : 0;
  }
}

const edges = new Map();
for (let y = 0; y < gridH; y++) {
  for (let x = 0; x < gridW; x++) {
    if (bin[y * gridW + x] === 1) {
      if (y === 0 || bin[(y - 1) * gridW + x] === 0) edges.set(x + ',' + y, [x + 1, y]);
      if (x === gridW - 1 || bin[y * gridW + x + 1] === 0) edges.set((x + 1) + ',' + y, [x + 1, y + 1]);
      if (y === gridH - 1 || bin[(y + 1) * gridW + x] === 0) edges.set((x + 1) + ',' + (y + 1), [x, y + 1]);
      if (x === 0 || bin[y * gridW + x - 1] === 0) edges.set(x + ',' + (y + 1), [x, y]);
    }
  }
}

const visited = new Set();
const loops = [];

for (const [startKey, firstNext] of edges) {
  if (visited.has(startKey)) continue;
  const loop = [];
  let currKey = startKey;
  let guard = 0;
  while (guard++ < 20000) {
    visited.add(currKey);
    const [cx, cy] = currKey.split(',').map(Number);
    loop.push([cx, cy]);
    const next = edges.get(currKey);
    if (!next) break;
    currKey = next[0] + ',' + next[1];
    if (currKey === startKey) break;
    if (visited.has(currKey)) break;
  }
  if (loop.length > 20) loops.push(loop);
}

function rdp(points, epsilon) {
  if (points.length <= 2) return points;
  let dmax = 0, index = 0;
  const p1 = points[0], p2 = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const d = perpDist(p, p1, p2);
    if (d > dmax) { dmax = d; index = i; }
  }
  if (dmax > epsilon) {
    const r1 = rdp(points.slice(0, index + 1), epsilon);
    const r2 = rdp(points.slice(index), epsilon);
    return r1.slice(0, -1).concat(r2);
  }
  return [p1, p2];
}

function perpDist(p, p1, p2) {
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - p1[0], p[1] - p1[1]);
  return Math.abs(dy * p[0] - dx * p[1] + p2[0] * p1[1] - p2[1] * p1[0]) / Math.hypot(dx, dy);
}

// Bounding box across all elements:
let minX = 256, maxX = 0, minY = 256, maxY = 0;
for (const l of loops) {
  for (const [x, y] of l) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
}

const spanX = maxX - minX;
const spanY = maxY - minY;
const targetSize = 20.0; // 20px within 24x24 canvas (2px padding on all sides)
const scale = targetSize / Math.max(spanX, spanY);
const centerX = (minX + maxX) / 2;
const centerY = (minY + maxY) / 2;
const offsetX = 12 - centerX * scale;
const offsetY = 12 - centerY * scale;

function toSvgPath(points) {
  return points.map((p, idx) => {
    const x = (p[0] * scale + offsetX).toFixed(2);
    const y = (p[1] * scale + offsetY).toFixed(2);
    return (idx === 0 ? 'M' : 'L') + x + ' ' + y;
  }).join(' ') + ' Z';
}

const simplifiedLoops = loops.map(l => rdp(l, 0.85));
const pathStrings = simplifiedLoops.map(toSvgPath);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd">\n  ` +
  pathStrings.map(p => `<path d="${p}" />`).join('\n  ') +
  `\n</svg>\n`;

fs.writeFileSync('media/gravix-activitybar.svg', svg);
console.log('Successfully generated media/gravix-activitybar.svg with', loops.length, 'loops');

