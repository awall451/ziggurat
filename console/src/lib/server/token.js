// The owner's Claude subscription token for new VMs: one line in
// `claude-token` in the console's config folder, made with `claude setup-token`.
// It is read only to hand it to a VM. It is never logged and never sent to a browser.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';

export const TOKEN_FILE = path.join(CONFIG_DIR, 'claude-token');
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{20,600}$/;

export function readToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    return TOKEN_RE.test(t) ? t : null;
  } catch {
    return null;
  }
}

/** Is a usable token saved? */
export function tokenConfigured() {
  return readToken() != null;
}
