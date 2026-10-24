// Generates the extension PNG icons with zero dependencies (raw RGBA -> zlib -> PNG).
//
// The mark is a hub with three spokes: one bridge, three sites. Deliberately chunky,
// because at 16x16 anything finer than about a pixel of stroke turns to grey mush.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
mkdirSync(OUT, { recursive: true });

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Coverage of a pixel by a shape, sampled 4x4 for cheap anti-aliasing. */
function coverage(x, y, fn) {
  let hits = 0;
  for (let sy = 0; sy < 4; sy++)
    for (let sx = 0; sx < 4; sx++)
      if (fn(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hits++;
  return hits / 16;
}

function draw(size) {
  const s = size;
  const buf = Buffer.alloc(s * s * 4);
  const r = s * 0.24;
  const inRounded = (px, py) => {
    const cx = Math.min(Math.max(px, r), s - r);
    const cy = Math.min(Math.max(py, r), s - r);
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
  };

  const cx = s / 2, cy = s * 0.5;
  const hubR = s * 0.13;
  const nodeR = s * 0.105;
  const orbit = s * 0.29;
  const spoke = s * 0.055;
  const nodes = [-90, 30, 150].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return [cx + Math.cos(a) * orbit, cy + Math.sin(a) * orbit];
  });

  const distToSegment = (px, py, [ax, ay], [bx, by]) => {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };

  const inGlyph = (px, py) => {
    if ((px - cx) ** 2 + (py - cy) ** 2 <= hubR * hubR) return true;
    for (const n of nodes) {
      if ((px - n[0]) ** 2 + (py - n[1]) ** 2 <= nodeR * nodeR) return true;
      if (distToSegment(px, py, [cx, cy], n) <= spoke) return true;
    }
    return false;
  };

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const bg = coverage(x, y, inRounded);
      if (bg <= 0) { buf[i + 3] = 0; continue; }
      // Diagonal gradient #6366f1 -> #a855f7, distinct at a glance from the WhatsApp bridge.
      const t = Math.min(1, (x / s) * 0.45 + (y / s) * 0.55);
      const R = Math.round(0x63 + (0xa8 - 0x63) * t);
      const G = Math.round(0x66 + (0x55 - 0x66) * t);
      const B = Math.round(0xf1 + (0xf7 - 0xf1) * t);
      const fg = coverage(x, y, inGlyph);
      buf[i] = Math.round(R * (1 - fg) + 255 * fg);
      buf[i + 1] = Math.round(G * (1 - fg) + 255 * fg);
      buf[i + 2] = Math.round(B * (1 - fg) + 255 * fg);
      buf[i + 3] = Math.round(255 * bg);
    }
  }
  return buf;
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `icon${size}.png`), png(size, draw(size)));
  console.log('wrote', `icons/icon${size}.png`);
}
