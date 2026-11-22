// Package and domain requests from a team's lead (kit 0.16). The lead asks
// with owner-packages; the owner approves or declines here. Approving first
// adds the domains the request needs to the gateway's allow-list (gateway.js),
// then tells the VM; the VM installs it as root between cycles. What the lead
// wrote is data: the request is checked here and again on the VM.
//
// Files the console fetches (kit 0.17). Some recipes download from a domain
// the gateway must not allow (Playwright's Chromium comes from a Google
// bucket, and any bucket there takes uploads). Such a recipe names, in its
// "# Fetch:" header, the hosts (and paths) the console may fetch from. On the
// VM it first says which files it wants; the console checks each address
// against that header, in its own copy of the recipe, downloads the files
// outside the sandbox into a cache, and hands them to the VM over ssh. No
// code from outside runs here: the console only downloads named files. The
// list of addresses comes from inside the sandbox and is treated as hostile.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as config from './config.js';
import { kit, pull } from './ssh.js';
import { parseHeaderFile } from './headerfile.js';
import { audit } from './audit.js';
import { kitAtLeast, peekStatus } from './live.js';
import { validateTarget } from './schema.js';
import { inspect, domainAllowed } from './pve.js';
import { allowDomains, removeDomains, DOMAIN_RE } from './gateway.js';
import { maskSecrets } from './mask.js';

export const PACKAGES_KIT = '0.16.0';
export const FETCH_KIT = '0.17.0';
// The same patterns as agent-kit-packages on the VM.
const NEED_URL_RE = /^https:\/\/[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?\/[A-Za-z0-9._~%+\/-]{1,400}$/;
const NEED_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,7}$/;
const MAX_NEEDS = 10;
const MAX_FILE = 600 * 1024 * 1024;
const MAX_REQUEST = 1500 * 1024 * 1024;
const MAX_HOPS = 5;
const KEEP_VERSIONS = 3;
const cacheDir = () => path.join(config.DATA_DIR, 'packages-cache');
const RID_RE = /^[0-9]{8}T[0-9]{6}Z-k-[a-f0-9]{6}$/;
const APT_RE = /^apt:[a-z0-9][a-z0-9+.-]{1,62}$/;
const RECIPE_RE = /^recipe:([a-z0-9][a-z0-9-]{0,39})(@([0-9][0-9A-Za-z.+-]{0,30}))?$/;
const DOMAIN_REQ_RE = /^domain:(.+)$/;
const RECIPES = path.join(config.REPO_DIR, 'kit', 'vm', 'recipes');

export const kitHasPackages = (version) => kitAtLeast(version, PACKAGES_KIT);
const outDir = (project) => path.join(config.DATA_DIR, 'packages', project.id, 'out');

/** What a request is, and the domains it needs; null for anything the kit would not install. */
export function describe(request) {
  const r = String(request || '');
  if (APT_RE.test(r)) return { kind: 'apt', name: r.slice(4), version: null, domains: [] };
  let m = RECIPE_RE.exec(r);
  if (m) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(RECIPES, `${m[1]}.sh`), 'utf8');
    } catch {
      return null;
    }
    const domains = (/^# Domains: (.*)$/m.exec(text)?.[1] || '').split(/\s+/).filter((d) => DOMAIN_RE.test(d));
    // Where the console may fetch this recipe's files from: "host" or "host/path/" entries.
    const fetch = (/^# Fetch: (.*)$/m.exec(text)?.[1] || '')
      .split(/\s+/)
      .map((e) => /^([a-z0-9][a-z0-9.-]{0,252})(\/[A-Za-z0-9._\/-]{0,200})?$/.exec(e))
      .filter((e) => e && DOMAIN_RE.test(e[1]))
      .map((e) => ({ host: e[1], prefix: e[2] || '/' }));
    const about = text
      .split('\n')
      .filter((l) => /^# /.test(l) && !/^# [A-Z][a-z]*: /.test(l))
      .map((l) => l.slice(2))
      .join(' ')
      .slice(0, 400);
    return { kind: 'recipe', name: m[1], version: m[3] || null, domains, about, fetch };
  }
  m = DOMAIN_REQ_RE.exec(r);
  if (m && DOMAIN_RE.test(m[1])) return { kind: 'domain', name: m[1], version: null, domains: [m[1]] };
  return null;
}

/** Parse `agent-kit-packages status`: one JSON object per line. */
export function parseStatus(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || !RID_RE.test(o.rid || '')) continue;
    const what = describe(o.request);
    if (!what) continue;
    const decision = ['approved', 'denied'].includes(o.decision) ? o.decision : null;
    const result = ['fetching', 'installing', 'ok', 'failed'].includes(o.result) ? o.result : null;
    // What a fetching request waits for (kit 0.17): checked like everything else from the VM.
    const needs =
      result === 'fetching' && Array.isArray(o.needs)
        ? o.needs.slice(0, MAX_NEEDS + 1).filter((n) => n && NEED_URL_RE.test(n.url || '') && NEED_NAME_RE.test(n.name || '')).map((n) => ({ url: n.url, name: n.name }))
        : [];
    const log = result === 'failed' && typeof o.log === 'string' ? maskSecrets(o.log).slice(-1500) : null;
    out.push({ rid: o.rid, request: o.request, what, decision, decidedAt: decision ? o.decidedAt || null : null, result, resultAt: result ? o.resultAt || null : null, needs, ready: o.ready === true, log });
  }
  return out;
}

const stateOf = (r) =>
  r.decision === 'denied' ? 'declined' : r.decision === 'approved' ? { ok: 'installed', failed: 'failed', installing: 'installing', fetching: 'fetching' }[r.result] || 'approved' : 'waiting';

/** The project's target, checked, or null (projects added by hand may have none). */
function targetFor(project) {
  const raw = project.target ? config.getTarget(project.target) : null;
  if (!raw) return null;
  try {
    return validateTarget(raw);
  } catch {
    return null;
  }
}

/**
 * The project's requests, newest first, with the lead's reason and which
 * domains the gateway still lacks. Never throws; an unreachable VM gives an error.
 */
export async function requests(project) {
  const res = await kit(project, 'agent-kit-packages', ['status']);
  if (res.code !== 0) return { requests: [], error: (res.stderr || `exit ${res.code}`).trim().slice(-200), gateway: null };
  const list = parseStatus(res.stdout);
  if (list.some((r) => !r.decision)) {
    fs.mkdirSync(outDir(project), { recursive: true });
    await pull(project, [`${project.kit.state}/packages-out/`], outDir(project), { as: 'agent', maxSize: '16k', timeout: 60000, filters: ['--include=*.md', '--exclude=*'] }).catch(() => {});
  }
  const target = targetFor(project);
  let allowed = null;
  let extra = null;
  if (target && list.some((r) => !r.decision && r.what.domains.length)) {
    const seen = await inspect(target).catch(() => null);
    allowed = seen?.allowed || null;
    // The domains the owner added since the gateway was made: these can be taken back.
    extra = seen?.allowedExtra || null;
  }
  const out = list.map((r) => {
    const f = parseHeaderFile(path.join(outDir(project), `${r.rid}.md`), 6000);
    const reason = f && f.fields.request === r.request ? f.body.slice(0, 2000) : null;
    const missing = allowed ? r.what.domains.filter((d) => !domainAllowed(allowed, d.replace(/^\./, ''))) : null;
    return { ...r, state: stateOf(r), reason, missing };
  });
  out.sort((a, b) => (a.rid < b.rid ? 1 : -1));
  return { requests: out, error: null, gateway: target ? (allowed ? 'checked' : 'unknown') : 'none', extra };
}

/** The domains the owner added on the project's gateway (not the base list), or null when it cannot be read. */
export async function extraDomains(project) {
  const target = targetFor(project);
  if (!target) return null;
  const seen = await inspect(target).catch(() => null);
  return seen?.allowedExtra || null;
}

/** Take a domain the owner added back off the gateway's allow-list. */
export async function removeDomain(user, project, domain) {
  const target = targetFor(project);
  if (!target) throw new Error('This project has no deploy target, so the console cannot reach its gateway.');
  const d = String(domain || '').toLowerCase();
  if (!DOMAIN_RE.test(d)) throw new Error('Not a domain name');
  await removeDomains(user, target, [d], { project: project.id });
  return { ok: true, removed: d };
}

// ---- files the console fetches ---------------------------------------------

/** May the console fetch this address for a recipe with this "# Fetch:" list? */
export function fetchAllowed(list, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  // https, the standard port, no login, nothing after the path. The path is
  // the parsed one: "../" and its encoded forms are already resolved in it.
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash) return false;
  if (u.pathname.includes('//') || u.pathname.includes('\\')) return false;
  return (list || []).some((e) => u.hostname === e.host && u.pathname.startsWith(e.prefix));
}

let fetchImpl = (...a) => fetch(...a);

/** Download one file, following redirects only to addresses the list allows. */
async function download(url, list, dest, maxBytes) {
  let cur = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (!fetchAllowed(list, cur)) {
      let host = 'that address';
      try {
        host = new URL(cur).hostname;
      } catch {
        /* not an address at all */
      }
      throw new Error(`${hop ? `${url} leads to` : 'the recipe asked for'} ${host}${hop ? '' : ` (${cur})`}, which is not on the recipe's list of places to fetch from`);
    }
    const res = await fetchImpl(cur, { redirect: 'manual', headers: { 'user-agent': 'ziggurat-console' }, signal: AbortSignal.timeout(30 * 60_000) });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const to = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!to) throw new Error(`${cur} redirects to nowhere`);
      cur = new URL(to, cur).href;
      continue;
    }
    if (res.status !== 200 || !res.body) throw new Error(`${new URL(cur).hostname} answered ${res.status} for ${new URL(url).pathname}`);
    const said = Number(res.headers.get('content-length'));
    if (Number.isFinite(said) && said > maxBytes) throw new Error(`${path.basename(new URL(url).pathname)} is ${Math.round(said / 1024 / 1024)} MB, more than the console fetches`);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(dest, { mode: 0o600 });
    let size = 0;
    try {
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > maxBytes) throw new Error(`${path.basename(new URL(url).pathname)} is larger than the console fetches`);
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    return { size, sha256: hash.digest('hex'), finalHost: new URL(cur).hostname };
  }
  throw new Error(`${url} redirects too many times`);
}

/** The cached copy of one file of a recipe version, fetching it when it is not there yet. */
async function cached(what, need, list, budget) {
  const dir = path.join(cacheDir(), what.name, what.version || 'none');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = crypto.createHash('sha256').update(need.url).digest('hex').slice(0, 32);
  const file = path.join(dir, key);
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8'));
  } catch {
    /* not fetched yet */
  }
  if (meta?.url === need.url && /^[0-9a-f]{64}$/.test(meta.sha256 || '') && fs.existsSync(file) && fs.statSync(file).size === meta.size) {
    // The address is checked even for a cached file: the recipe's list may have changed.
    if (!fetchAllowed(list, need.url)) throw new Error(`the recipe asked for ${need.url}, which is not on the recipe's list of places to fetch from`);
    return { file, ...meta, fromCache: true };
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const got = await download(need.url, list, tmp, Math.min(MAX_FILE, budget));
    fs.renameSync(tmp, file);
    meta = { url: need.url, size: got.size, sha256: got.sha256, from: got.finalHost, at: new Date().toISOString() };
    fs.writeFileSync(`${file}.json`, JSON.stringify(meta, null, 2), { mode: 0o600 });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  // Keep the newest few versions of a recipe: browser builds are large.
  try {
    const versions = fs.readdirSync(path.dirname(dir)).map((v) => ({ v, at: fs.statSync(path.join(path.dirname(dir), v)).mtimeMs })).sort((a, b) => b.at - a.at);
    for (const old of versions.slice(KEEP_VERSIONS)) fs.rmSync(path.join(path.dirname(dir), old.v), { recursive: true, force: true });
  } catch {
    /* tidying only */
  }
  return { file, ...meta, fromCache: false };
}

const fetching = new Map(); // "project rid" -> promise

/**
 * Bring a fetching request its files: check, download (or take from the
 * cache), hand them to the VM with their checksums. When the files cannot be
 * had, the VM is told so and the request fails with the reason. Never throws.
 */
export function fetchFiles(project, r, user = { name: 'console' }) {
  const key = `${project.id} ${r.rid}`;
  if (fetching.has(key)) return fetching.get(key);
  const p = bring(project, r, user)
    .catch((e) => ({ ok: false, error: String(e.message || e) }))
    .finally(() => fetching.delete(key));
  fetching.set(key, p);
  return p;
}

async function bring(project, r, user) {
  const what = describe(r.request);
  const tell = async (reason) => {
    const res = await kit(project, 'agent-kit-packages', ['fetch-failed', r.rid], { input: reason.slice(0, 500), timeout: 60000 });
    audit(user, project.id, 'package-fetch', { rid: r.rid }, { ok: false, detail: reason.slice(0, 300) });
    return { ok: false, error: reason, told: res.code === 0 };
  };
  if (!what?.fetch?.length) return tell('this recipe has no list of places the console may fetch from');
  if (!r.needs.length || r.needs.length > MAX_NEEDS) return tell('the recipe asked for no files, or for more than the console fetches');
  const stage = path.join(cacheDir(), `.stage-${r.rid}-${process.pid}`);
  try {
    let total = 0;
    let fresh = 0;
    const sums = [];
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
    for (const need of r.needs) {
      let got;
      try {
        got = await cached(what, need, what.fetch, MAX_REQUEST - total);
      } catch (e) {
        return tell(String(e.message || e));
      }
      total += got.size;
      if (total > MAX_REQUEST) return tell(`the files are more than ${Math.round(MAX_REQUEST / 1024 / 1024)} MB together`);
      if (!got.fromCache) fresh++;
      const at = path.join(stage, need.name);
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.linkSync(got.file, at);
      sums.push(`${got.sha256}  ${need.name}`);
    }
    fs.writeFileSync(path.join(stage, 'SHA256SUMS'), sums.join('\n') + '\n');
    // --hard-dereference: the staged names are links into the cache; the VM refuses links.
    const tar = spawn('tar', ['-c', '-C', stage, '--owner=0', '--group=0', '--hard-dereference', '.'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const res = await kit(project, 'agent-kit-packages', ['files', r.rid], { inputStream: tar.stdout, timeout: 45 * 60_000 });
    const ok = res.code === 0;
    const detail = ok ? `${r.needs.length} file(s), ${Math.round(total / 1024 / 1024)} MB, ${fresh} fetched now` : (res.stderr || res.stdout || `exit ${res.code}`).trim().slice(-300);
    audit(user, project.id, 'package-fetch', { rid: r.rid, files: r.needs.length, bytes: total, fetched: fresh }, { ok, detail: ok ? null : detail });
    // A VM that did not answer keeps the request fetching: the next look tries again.
    return ok ? { ok: true, files: r.needs.length, bytes: total, fetched: fresh } : { ok: false, error: detail };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

const looked = new Map(); // project id -> when the console last looked for fetching requests

/** Bring every request of this project that waits for files what it needs. Never throws. */
export async function maybeFetch(project, { force = false } = {}) {
  if (!force && Date.now() - (looked.get(project.id) || 0) < 60_000) return [];
  looked.set(project.id, Date.now());
  const { requests: list } = await requests(project).catch(() => ({ requests: [] }));
  const out = [];
  for (const r of list) if (r.result === 'fetching' && !r.ready) out.push({ rid: r.rid, ...(await fetchFiles(project, r)) });
  return out;
}

const watching = new Set();

/**
 * After an approval or a retry of a recipe with files to fetch: the VM says
 * what it needs on its next tick, so look every half minute for a while
 * instead of waiting for the next full pull.
 */
export function watchFetch(project, tries = 30) {
  if (watching.has(project.id)) return;
  watching.add(project.id);
  let left = tries;
  const look = async () => {
    left--;
    const { requests: list } = await requests(project).catch(() => ({ requests: [] }));
    for (const r of list) if (r.result === 'fetching' && !r.ready) await fetchFiles(project, r);
    // Go on while something is still on its way to "fetching".
    const pending = list.some((r) => r.decision === 'approved' && (!r.result || (r.result === 'fetching' && !r.ready)) && r.what.fetch?.length);
    if (pending && left > 0) setTimeout(look, 30_000).unref?.();
    else watching.delete(project.id);
  };
  setTimeout(look, 30_000).unref?.();
}

/** The owner's decision. Approving adds the missing domains on the gateway first. */
export async function decideRequest(user, project, rid, decision) {
  if (!RID_RE.test(rid)) throw new Error('Bad request id');
  if (!['approve', 'deny'].includes(decision)) throw new Error('Bad decision');
  let added = [];
  let requested = null;
  if (decision === 'approve') {
    const { requests: list } = await requests(project);
    const r = list.find((x) => x.rid === rid);
    if (!r) throw new Error('No such request');
    if (r.decision) throw new Error('Already decided');
    requested = r.request;
    const kitVersion = peekStatus(project.id)?.kitVersion;
    if (r.what.fetch?.length && kitVersion && !kitAtLeast(kitVersion, FETCH_KIT)) {
      throw new Error(`This recipe's files are fetched by the console, which needs kit ${FETCH_KIT} on the VM (it runs ${kitVersion}). Upgrade the kit, then approve.`);
    }
    if (r.what.domains.length) {
      const target = targetFor(project);
      if (!target) throw new Error(`This project has no deploy target, so the console cannot add ${r.what.domains.join(', ')} to the gateway. Add them by hand, then approve again.`);
      if (r.missing == null) throw new Error('Could not read the gateway\'s allow-list; try again');
      if (r.missing.length) {
        await allowDomains(user, target, r.missing, { project: project.id });
        added = r.missing;
      }
    }
  }
  const res = await kit(project, 'agent-kit-packages', [decision, rid]);
  const ok = res.code === 0;
  const detail = ok ? null : (res.stderr || res.stdout || `exit ${res.code}`).trim().slice(-200);
  audit(user, project.id, decision === 'approve' ? 'package-approve' : 'package-deny', { rid, added }, { ok, detail });
  if (!ok) throw new Error(detail);
  return { ok: true, added, request: requested };
}

/** Try a failed request again (kit 0.17): the VM starts it over on its next tick. */
export async function retryRequest(user, project, rid) {
  if (!RID_RE.test(rid)) throw new Error('Bad request id');
  const res = await kit(project, 'agent-kit-packages', ['retry', rid]);
  const ok = res.code === 0;
  const detail = ok ? null : (res.stderr || res.stdout || `exit ${res.code}`).trim().slice(-200);
  audit(user, project.id, 'package-retry', { rid }, { ok, detail });
  if (!ok) throw new Error(detail);
  return { ok: true };
}

export const _test = {
  setFetch: (fn) => {
    fetchImpl = fn || ((...a) => fetch(...a));
  },
  cacheDir
};
