// Drafts for the "New project" page: one JSON document with everything the
// form holds (name, goal, the owner's plan and design documents, the team,
// "when it's ready", the advanced settings). Written by hand, by Claude after a
// planning talk, or by any script; checked with the same rules as the form and
// kept until it is opened, changed and sent, or deleted. A draft never
// deploys anything: the owner opens /new?draft=<id>, reads it, and goes on
// from there. Schema: console/docs/new-project.schema.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as config from './config.js';
import { validateTarget, validateDeployRequest } from './schema.js';
import { audit } from './audit.js';

const DIR = path.join(config.DATA_DIR, 'drafts');
const ID_RE = /^[0-9]{8}T[0-9]{6}Z-d-[a-f0-9]{6}$/;
export const MAX_DRAFTS = 50;

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function needDeploy() {
  if (!config.DEPLOY_ENABLED) throw fail(404, 'Creating projects from the console is turned off');
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const file = (id) => path.join(DIR, `${id}.json`);

function read(id) {
  try {
    return JSON.parse(fs.readFileSync(file(id), 'utf8'));
  } catch {
    return null;
  }
}

/** Check a draft the way the form is checked. The target defaults to the first one. */
export function checkDraft(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'A draft is a JSON object');
  const targets = config.listTargets();
  const targetId = typeof input.target === 'string' && input.target ? input.target : targets[0]?.id;
  const raw = targetId ? config.getTarget(targetId) : null;
  if (!raw) throw fail(400, 'target: no such target');
  let target;
  try {
    target = validateTarget(raw);
  } catch (e) {
    throw fail(409, `That target has settings that are not valid: ${e.message}`);
  }
  // The project id may be left out: it follows from the name, as on the page.
  const id = typeof input.id === 'string' && input.id ? input.id : String(input.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  try {
    return validateDeployRequest({ ...input, id, target: target.id }, target);
  } catch (e) {
    throw fail(400, e.message);
  }
}

/** Store a draft. Returns its id, the page to open, and what the owner should know. */
export function putDraft(user, input) {
  needDeploy();
  const request = checkDraft(input);
  fs.mkdirSync(DIR, { recursive: true });
  if (listDrafts().length >= MAX_DRAFTS) throw fail(409, `There are ${MAX_DRAFTS} drafts already: delete some first`);
  const warnings = [];
  if (config.rawProjects().some((p) => p.id === request.id)) warnings.push(`A project called ${request.id} already exists: change the id before you send it.`);
  const id = `${stamp()}-d-${crypto.randomBytes(3).toString('hex')}`;
  const d = { id, by: user?.name || 'unknown', createdAt: new Date().toISOString(), request };
  fs.writeFileSync(file(id), JSON.stringify(d, null, 2));
  audit(user, request.id, 'draft-add', { draft: id, source: `${request.source.kind}:${request.source.id}`, docs: request.docs.length });
  return { id, url: `/new?draft=${id}`, warnings };
}

export function listDrafts() {
  let names = [];
  try {
    names = fs.readdirSync(DIR).filter((n) => n.endsWith('.json') && ID_RE.test(n.slice(0, -5)));
  } catch {
    return [];
  }
  return names
    .map((n) => read(n.slice(0, -5)))
    .filter(Boolean)
    .map((d) => ({ id: d.id, name: d.request?.name || d.request?.id || '', projectId: d.request?.id || '', createdAt: d.createdAt, by: d.by }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getDraft(id) {
  needDeploy();
  if (!ID_RE.test(id || '')) throw fail(400, 'Bad draft id');
  const d = read(id);
  if (!d) throw fail(404, 'No such draft');
  return d;
}

export function deleteDraft(user, id) {
  const d = getDraft(id);
  fs.rmSync(file(id), { force: true });
  audit(user, d.request?.id || '', 'draft-delete', { draft: id });
  return { ok: true };
}
