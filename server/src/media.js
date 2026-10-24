import { writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, extname, dirname, join, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from './config.js';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/*
 * Mime types carry parameters — `audio/ogg; codecs=opus`, `text/plain; charset=utf-8` — so
 * an exact-match table silently misses the common cases and everything lands as `.bin`.
 * The base type is matched first, then the top-level type as a fallback.
 */
const EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mp4': 'm4a', 'audio/webm': 'weba',
  'application/pdf': 'pdf', 'application/json': 'json', 'application/zip': 'zip',
  'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'text/html': 'html',
};
const TOP = { image: 'png', video: 'mp4', audio: 'mp3', text: 'txt' };

export function extensionFor(mimetype, fallback = 'bin') {
  const base = String(mimetype || '').split(';')[0].trim().toLowerCase();
  if (EXT[base]) return EXT[base];
  const top = base.split('/')[0];
  return TOP[top] ?? fallback;
}

export const isImage = (mimetype) => /^image\//i.test(String(mimetype || '').split(';')[0].trim());

const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
export function mimeFor(path) {
  const e = extname(path).slice(1).toLowerCase();
  return MIME_BY_EXT[e] ?? 'application/octet-stream';
}

/** Write bytes into the data dir and return where they went. */
export function saveMedia(base64, mimetype, name) {
  mkdirSync(config.mediaDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Filenames coming back from a web page are untrusted; reduce to a basename so nothing
  // can walk out of the media directory.
  const safe = name ? basename(String(name)).replace(/[^\w.-]+/g, '_').slice(0, 120) : '';
  const file = safe && extname(safe) ? `${stamp}-${safe}` : `${stamp}-${safe || 'media'}.${extensionFor(mimetype)}`;
  const path = join(config.mediaDir, file);
  const buf = Buffer.from(base64, 'base64');
  writeFileSync(path, buf);
  return { path, bytes: buf.length, mimetype, filename: file, sha256: sha256(buf) };
}

/**
 * Write media to an exact path the caller chose, and report its digest.
 *
 * The digest is the point: "the download worked" is only checkable against the bytes that
 * went in, and a truncated or re-encoded file is otherwise indistinguishable from a good
 * one until something downstream fails to open it.
 */
export function saveMediaTo(base64, targetPath) {
  const abs = isAbsolute(targetPath) ? targetPath : resolve(process.cwd(), targetPath);
  mkdirSync(dirname(abs), { recursive: true });
  const buf = Buffer.from(base64, 'base64');
  writeFileSync(abs, buf);
  return { path: abs, bytes: buf.length, sha256: sha256(buf) };
}

/** Resolve an outgoing attachment given either a path or inline base64. */
export function resolveOutgoing({ path, base64, mimetype, filename, text }) {
  if (text != null) {
    return { text: String(text), filename: filename ?? 'note.txt', mimetype: mimetype ?? 'text/plain' };
  }
  if (base64) {
    return { base64: String(base64), filename: filename ?? `upload.${extensionFor(mimetype)}`, mimetype: mimetype ?? 'application/octet-stream' };
  }
  if (!path) throw new Error('attachment needs one of: path, base64, or text');
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(abs)) throw new Error(`file_not_found: ${abs}`);
  const st = statSync(abs);
  if (st.size > 200 * 1024 * 1024) throw new Error(`file_too_large: ${abs} is ${Math.round(st.size / 1e6)} MB`);
  return {
    base64: readFileSync(abs).toString('base64'),
    filename: filename ?? basename(abs),
    mimetype: mimetype ?? mimeFor(abs),
    source_path: abs,
    bytes: st.size,
  };
}
