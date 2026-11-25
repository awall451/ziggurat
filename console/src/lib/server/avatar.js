// A project's picture (the tile beside its name). Without one the console
// draws the first letter of the name on the project's accent colour. The
// owner uploads a PNG, JPEG or WebP under Settings; it is kept in the data
// folder and served with its own type. SVG is not taken: it can carry script.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ID_RE } from './config.js';
import { audit } from './audit.js';

export const MAX_AVATAR = 2 * 1024 * 1024;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const dir = () => path.join(DATA_DIR, 'avatars');

/** What a file is, from its first bytes: 'png', 'jpg', 'webp' or null. */
export function imageKind(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** The stored picture of a project: {file, type, mtime}, or null. */
export function avatarFile(id) {
  if (!ID_RE.test(id || '')) return null;
  for (const ext of Object.keys(TYPES)) {
    const file = path.join(dir(), `${id}.${ext}`);
    try {
      const st = fs.lstatSync(file);
      if (st.isFile()) return { file, type: TYPES[ext], mtime: Math.floor(st.mtimeMs) };
    } catch {
      /* not this one */
    }
  }
  return null;
}

/** Where the page loads the picture from (a new address when it changes), or null for the letter. */
export function avatarUrl(id) {
  const a = avatarFile(id);
  return a ? `/p/${id}/avatar?v=${a.mtime}` : null;
}

export function saveAvatar(user, id, buf) {
  if (!ID_RE.test(id || '')) throw Object.assign(new Error('No such project'), { status: 404 });
  if (!buf?.length) throw Object.assign(new Error('Pick a picture first'), { status: 400 });
  if (buf.length > MAX_AVATAR) throw Object.assign(new Error('The picture is over 2 MB'), { status: 413 });
  const kind = imageKind(buf);
  if (!kind) throw Object.assign(new Error('Use a PNG, JPEG or WebP picture'), { status: 415 });
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = path.join(dir(), `.${id}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, buf);
  for (const ext of Object.keys(TYPES)) if (ext !== kind) fs.rmSync(path.join(dir(), `${id}.${ext}`), { force: true });
  fs.renameSync(tmp, path.join(dir(), `${id}.${kind}`));
  audit(user, id, 'project-avatar', { kind, size: buf.length });
  return { avatar: avatarUrl(id) };
}

export function removeAvatar(user, id) {
  if (!ID_RE.test(id || '')) throw Object.assign(new Error('No such project'), { status: 404 });
  for (const ext of Object.keys(TYPES)) fs.rmSync(path.join(dir(), `${id}.${ext}`), { force: true });
  audit(user, id, 'project-avatar-remove', {});
  return { avatar: null };
}
