import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-avatar-'));
process.env.CONSOLE_DATA_DIR = root;
const av = await import('../src/lib/server/avatar.js');

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16)]);
const owner = { name: 'owner' };

describe("a project's picture", () => {
  it('knows PNG, JPEG and WebP by their first bytes, nothing else', () => {
    expect(av.imageKind(png)).toBe('png');
    expect(av.imageKind(jpg)).toBe('jpg');
    expect(av.imageKind(webp)).toBe('webp');
    expect(av.imageKind(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(av.imageKind(Buffer.from('GIF89a........'))).toBeNull();
  });

  it('is the letter until one is uploaded, then has its own address', () => {
    expect(av.avatarUrl('darkroom')).toBeNull();
    const out = av.saveAvatar(owner, 'darkroom', png);
    expect(out.avatar).toMatch(/^\/p\/darkroom\/avatar\?v=\d+$/);
    expect(av.avatarFile('darkroom')).toMatchObject({ type: 'image/png' });
  });

  it('a new one replaces the old, whatever its type; removing goes back to the letter', () => {
    av.saveAvatar(owner, 'darkroom', jpg);
    expect(av.avatarFile('darkroom').type).toBe('image/jpeg');
    expect(fs.readdirSync(path.join(root, 'avatars')).filter((n) => n.startsWith('darkroom'))).toEqual(['darkroom.jpg']);
    av.removeAvatar(owner, 'darkroom');
    expect(av.avatarUrl('darkroom')).toBeNull();
  });

  it('refuses what is not a picture, too big, or a bad project id', () => {
    expect(() => av.saveAvatar(owner, 'darkroom', Buffer.from('<svg></svg>  padding'))).toThrow('PNG, JPEG or WebP');
    expect(() => av.saveAvatar(owner, 'darkroom', Buffer.concat([png, Buffer.alloc(av.MAX_AVATAR)]))).toThrow('2 MB');
    expect(() => av.saveAvatar(owner, '../etc', png)).toThrow('No such project');
    expect(() => av.saveAvatar(owner, 'darkroom', Buffer.alloc(0))).toThrow('Pick');
    expect(av.avatarFile('../x')).toBeNull();
  });
});
