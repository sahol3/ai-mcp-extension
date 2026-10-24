#!/usr/bin/env node
/*
 * Generate deterministic test media for the upload/download checks.
 *
 * Deterministic matters: the point of the media tests is byte-accuracy, and that is only
 * checkable if the file that went up can be compared to the file that came back. Every
 * asset here is produced from a fixed seed, so its SHA-256 is stable across runs and
 * across machines.
 *
 * The large PNG is deliberately incompressible noise. A gradient would deflate to a few
 * kilobytes and prove nothing about throughput — the whole question is how the bridge
 * behaves when it actually has megabytes to move.
 *
 * Usage: node scripts/make-test-media.mjs [outdir]
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] ?? join(homedir(), '.ai-mcp', 'test-media');
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------- png

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Deterministic PRNG — the assets must hash the same on every run. */
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/*
 * A readable marker rendered as blocks. The small image carries something a vision model
 * can actually describe, so "did the upload arrive intact" can be answered by the model
 * itself rather than only by a checksum.
 */
function markerImage(size, text) {
  const buf = Buffer.alloc(size * size * 4);
  const GLYPHS = {
    A: ['01110', '10001', '11111', '10001', '10001'],
    B: ['11110', '10001', '11110', '10001', '11110'],
    C: ['01111', '10000', '10000', '10000', '01111'],
    7: ['11111', '00001', '00010', '00100', '01000'],
    4: ['10010', '10010', '11111', '00010', '00010'],
    2: ['11110', '00001', '01110', '10000', '11111'],
  };
  const chars = [...text];
  const cellW = Math.floor(size / (chars.length * 6));
  const cellH = Math.floor(size / 8);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      buf[i] = 245; buf[i + 1] = 245; buf[i + 2] = 250; buf[i + 3] = 255;
    }
  }
  chars.forEach((ch, ci) => {
    const rows = GLYPHS[ch];
    if (!rows) return;
    rows.forEach((row, ry) => {
      [...row].forEach((on, rx) => {
        if (on !== '1') return;
        const x0 = ci * 6 * cellW + rx * cellW;
        const y0 = Math.floor(size / 3) + ry * cellH;
        for (let y = y0; y < y0 + cellH && y < size; y++) {
          for (let x = x0; x < x0 + cellW && x < size; x++) {
            const i = (y * size + x) * 4;
            buf[i] = 20; buf[i + 1] = 30; buf[i + 2] = 120; buf[i + 3] = 255;
          }
        }
      });
    });
  });
  return png(size, size, buf);
}

function noiseImage(size, seed) {
  const rnd = mulberry32(seed);
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = (rnd() * 256) | 0;
    buf[i * 4 + 1] = (rnd() * 256) | 0;
    buf[i * 4 + 2] = (rnd() * 256) | 0;
    buf[i * 4 + 3] = 255;
  }
  return png(size, size, buf);
}

// ------------------------------------------------------------------ write

const assets = [
  ['marker-742.png', markerImage(256, '742')],
  ['noise-1mb.png', noiseImage(512, 1337)],
  ['noise-4mb.png', noiseImage(1024, 4242)],
  ['note.txt', Buffer.from(
    'AI Studio MCP Bridge — upload fidelity probe\n' +
    'MARKER: ABC-742\n' +
    'If a model reads this file back, it should quote the marker exactly.\n', 'utf8')],
];

const manifest = [];
for (const [name, buf] of assets) {
  const path = join(OUT, name);
  writeFileSync(path, buf);
  const sha = createHash('sha256').update(buf).digest('hex');
  manifest.push({ name, path, bytes: buf.length, sha256: sha });
  console.log(`${name.padEnd(16)} ${String(buf.length).padStart(9)} bytes  sha256 ${sha.slice(0, 16)}…`);
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\nwrote ${assets.length} assets + manifest.json to ${OUT}`);
