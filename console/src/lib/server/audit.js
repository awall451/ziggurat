// Append-only record of everything the console changed on a VM or in config.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'audit.jsonl');

export function audit(user, project, action, args = {}, result = {}) {
  const row = {
    at: new Date().toISOString(),
    user: user?.name || 'unknown',
    project,
    action,
    args,
    ok: result.ok !== false,
    detail: result.detail || null
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(FILE, JSON.stringify(row) + '\n');
  return row;
}

export function readAudit(project = null, limit = 200) {
  let text = '';
  try {
    text = fs.readFileSync(FILE, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (!project || r.project === project) rows.push(r);
    } catch {
      /* skip a bad line */
    }
  }
  return rows.slice(-limit).reverse();
}
