// Agent tree of one lead cycle, read from Claude Code transcripts:
//   <root>/<slug>/<session>.jsonl                           the lead
//   <root>/<slug>/<session>/subagents/agent-<id>.jsonl      one per subagent
//   <root>/<slug>/<session>/subagents/agent-<id>.meta.json  role, parent, depth
//
// The transcript format is internal to Claude Code and may change, so the
// parser is tolerant: unknown lines are skipped, missing fields become null.
// Files only grow, so each one is folded incrementally from a byte offset.
import fs from 'node:fs';
import path from 'node:path';

const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TEXT_CAP = 40_000;

const folds = new Map(); // file path -> {offset, ino, fold}

function newFold() {
  return {
    first: null,
    last: null,
    prompt: null,
    model: null,
    version: null,
    gitBranch: null,
    cwd: null,
    msgs: new Map(), // message id -> {usage, model}; later lines of one message replace earlier ones
    tools: new Map(), // tool_use id -> tool name
    agentCalls: new Map(), // tool_use id -> {subagentType, description, model}
    results: new Set(), // tool_use ids that have a result
    errors: new Set(), // tool_use ids whose result is an error
    lastText: '',
    lastTextMsg: null
  };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function feedLine(f, line) {
  // Cheap filter first: most lines (request blobs, attachments) are not needed.
  if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) return;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  if (!o || typeof o !== 'object') return;
  if (typeof o.timestamp === 'string') {
    f.first ??= o.timestamp;
    f.last = o.timestamp;
  }
  f.version ??= o.version || null;
  if (o.gitBranch) f.gitBranch = o.gitBranch; // the latest one: area leads rename their branch
  f.cwd ??= o.cwd || null;
  const m = o.message;
  if (!m || typeof m !== 'object') return;

  if (o.type === 'user') {
    const c = m.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b && b.type === 'tool_result' && b.tool_use_id) {
          f.results.add(b.tool_use_id);
          if (b.is_error) f.errors.add(b.tool_use_id);
        }
      }
    }
    if (f.prompt == null) {
      const t = textOf(c);
      if (t) f.prompt = t.slice(0, TEXT_CAP);
    }
    return;
  }

  if (o.type === 'assistant') {
    if (m.model && m.model !== '<synthetic>') f.model = m.model;
    const id = m.id || o.uuid;
    if (id && m.usage) f.msgs.set(id, { usage: m.usage, model: m.model || null });
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b) continue;
        if (b.type === 'tool_use' && b.id) {
          f.tools.set(b.id, b.name || 'unknown');
          if (b.name === 'Agent' || b.name === 'Task') {
            f.agentCalls.set(b.id, {
              subagentType: b.input?.subagent_type || null,
              description: b.input?.description || null,
              model: b.input?.model || null
            });
          }
        } else if (b.type === 'text' && b.text) {
          f.lastText = f.lastTextMsg === id ? `${f.lastText}\n${b.text}` : b.text;
          f.lastTextMsg = id;
        }
      }
    }
  }
}

/** Fold a growing jsonl file, reading only what was appended since last time. */
function foldFile(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    folds.delete(file);
    return null;
  }
  let entry = folds.get(file);
  if (!entry || entry.ino !== st.ino || st.size < entry.offset) {
    entry = { offset: 0, ino: st.ino, fold: newFold() };
    folds.set(file, entry);
  }
  if (st.size > entry.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(st.size - entry.offset);
      const n = fs.readSync(fd, buf, 0, buf.length, entry.offset);
      // Stop at the last complete line: the writer may be mid-line.
      const end = buf.lastIndexOf(0x0a, n - 1);
      if (end >= 0) {
        for (const line of buf.toString('utf8', 0, end).split('\n')) {
          if (line) feedLine(entry.fold, line);
        }
        entry.offset += end + 1;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return entry.fold;
}

function priceFor(model, pricing) {
  const id = model || '';
  for (const m of pricing.models || []) if (id.includes(m.match)) return m;
  return pricing.default;
}

function costOf(usage, model, pricing) {
  const p = priceFor(model, pricing);
  const cc = usage.cache_creation || {};
  const w5 = cc.ephemeral_5m_input_tokens ?? (cc.ephemeral_1h_input_tokens ? 0 : usage.cache_creation_input_tokens || 0);
  const w1 = cc.ephemeral_1h_input_tokens || 0;
  return (
    ((usage.input_tokens || 0) * p.input +
      (usage.output_tokens || 0) * p.output +
      (usage.cache_read_input_tokens || 0) * p.cacheRead +
      w5 * p.input * (pricing.cacheWrite5mFactor ?? 1.25) +
      w1 * p.input * (pricing.cacheWrite1hFactor ?? 2)) /
    1e6
  );
}

const contextOf = (u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);

function summarize(f, pricing) {
  let context = 0;
  let peak = 0;
  let output = 0;
  let cost = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const { usage, model } of f.msgs.values()) {
    context = contextOf(usage); // the last message wins
    if (context > peak) peak = context;
    output += usage.output_tokens || 0;
    tokens.input += usage.input_tokens || 0;
    tokens.output += usage.output_tokens || 0;
    tokens.cacheRead += usage.cache_read_input_tokens || 0;
    tokens.cacheWrite += usage.cache_creation_input_tokens || 0;
    cost += costOf(usage, model, pricing);
  }
  const tally = {};
  for (const name of f.tools.values()) tally[name] = (tally[name] || 0) + 1;
  let waitingOn = 0;
  for (const id of f.agentCalls.keys()) if (!f.results.has(id)) waitingOn++;
  return {
    model: f.model,
    started: f.first,
    ended: f.last,
    contextTokens: context,
    peakTokens: peak,
    outputTokens: output,
    tokens,
    turns: f.msgs.size,
    toolCalls: f.tools.size,
    tools: Object.entries(tally)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    costUsd: Math.round(cost * 10000) / 10000,
    waitingOn,
    version: f.version
  };
}

/**
 * Branch an agent works on: its own latest branch, unless that is still the
 * default branch while it sits in a worktree (then the worktree's branch, its
 * own or the one inherited from its parent).
 */
function branchOf(meta, fold, all) {
  const own = fold.gitBranch;
  const inWorktree = meta.worktreePath || meta.inheritedWorktreePath;
  if (own && !(inWorktree && (own === 'main' || own === 'master'))) return own;
  if (meta.worktreeBranch) return meta.worktreeBranch;
  const parent = all.find((r) => r.id === meta.parentAgentId);
  if (parent) return parent.fold.gitBranch || parent.meta.worktreeBranch || own || null;
  return own || null;
}

function readMeta(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}

function sessionDir(project) {
  return path.join(project.paths.transcripts, project.slug);
}

function readLedger(project) {
  const out = [];
  try {
    for (const line of fs.readFileSync(path.join(project.paths.fleet, 'cycles.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip a bad line */
      }
    }
  } catch {
    /* no ledger yet */
  }
  return out;
}

const cycleNumbers = new Map(); // session id -> number the lead itself used

/**
 * The cycle number as the lead counts it. Leads number their own cycles in
 * the briefs they write ("Goal (cycle 6, ..."), and they do not all count
 * interrupted cycles the same way, so their own word beats any rule here.
 * Reads only the head of each first-tier agent's transcript.
 */
function leadCycleNumber(dir, sid, settled) {
  if (cycleNumbers.has(sid)) return cycleNumbers.get(sid);
  const sub = path.join(dir, sid, 'subagents');
  const votes = new Map();
  let metas = [];
  try {
    metas = fs.readdirSync(sub).filter((n) => n.endsWith('.meta.json'));
  } catch {
    return null;
  }
  for (const n of metas) {
    const meta = readMeta(path.join(sub, n));
    if (meta.parentAgentId || (Number.isInteger(meta.spawnDepth) && meta.spawnDepth > 1)) continue;
    try {
      const fd = fs.openSync(path.join(sub, n.replace(/\.meta\.json$/, '.jsonl')), 'r');
      try {
        const buf = Buffer.allocUnsafe(8192);
        const len = fs.readSync(fd, buf, 0, buf.length, 0);
        for (const m of buf.toString('utf8', 0, len).matchAll(/\bcycle (\d{1,4})\b/gi)) {
          votes.set(m[1], (votes.get(m[1]) || 0) + 1);
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* no transcript yet */
    }
  }
  let best = null;
  for (const [n, c] of votes) if (!best || c > best[1]) best = [n, c];
  const number = best ? Number(best[0]) : null;
  // A finished cycle's number cannot change; a running one may not have briefs yet.
  if (number != null && settled) cycleNumbers.set(sid, number);
  return number;
}

/** First timestamp of a transcript, read from its head only. */
function firstTimestamp(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const m = /"timestamp":"([^"]+)"/.exec(buf.toString('utf8', 0, n));
      return m ? m[1] : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Cycles of a project, newest first. A cycle is a lead session in the
 * workspace's transcript folder; the ledger adds cost, turns and the summary.
 */
export function listSessions(project, status = null) {
  const dir = sessionDir(project);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl') && SID_RE.test(n.slice(0, -6)));
  } catch {
    return [];
  }
  const ledger = readLedger(project);
  const counted = ledger.filter((c) => c.counted !== false && c.session);
  const bySession = new Map(counted.map((c, i) => [c.session, { ...c, number: i + 1 }]));
  const rows = names.map((n) => {
    const id = n.slice(0, -6);
    const file = path.join(dir, n);
    const st = fs.statSync(file);
    let agents = 0;
    try {
      agents = fs.readdirSync(path.join(dir, id, 'subagents')).filter((x) => x.endsWith('.meta.json')).length;
    } catch {
      /* a session without subagents */
    }
    const led = bySession.get(id) || null;
    const started = led?.start || firstTimestamp(file) || st.mtime.toISOString();
    const live = !!(status?.leadActive && status.session === id);
    return {
      id,
      started,
      ended: led?.end || st.mtime.toISOString(),
      agents,
      live,
      state: live ? 'running' : led ? (led.rc === 0 && !led.is_error ? 'done' : 'failed') : 'interrupted',
      number: led?.number ?? null,
      costUsd: led?.cost_usd ?? null,
      turns: led?.turns ?? null,
      secs: led?.secs ?? null
    };
  });
  rows.sort((a, b) => (a.started < b.started ? 1 : -1));
  // Sessions the ledger does not know (interrupted or running) take the number
  // after the last counted cycle that started before them.
  for (const r of rows) {
    if (r.number == null) r.number = counted.filter((c) => c.start && c.start < r.started).length + 1;
    // The lead's own count wins when it is ahead of the ledger's (a lead that
    // counts an interrupted cycle). It never lowers the number: early briefs
    // may mention other cycles in passing.
    const own = r.agents ? leadCycleNumber(dir, r.id, !r.live) : null;
    if (own != null && own > r.number) r.number = own;
  }
  // Sessions with no subagents and no ledger entry are not cycles (a login, a test).
  return rows.filter((r) => r.agents > 0 || bySession.has(r.id) || r.live);
}

/**
 * The agent tree of one session.
 * @returns {{session: object, nodes: object[]} | null}
 */
export function sessionTree(project, sid, { status = null, pricing, labeler }) {
  if (!SID_RE.test(sid)) return null;
  const dir = sessionDir(project);
  const mainFile = path.join(dir, `${sid}.jsonl`);
  const main = foldFile(mainFile);
  if (!main) return null;

  const live = !!(status?.leadActive && status.session === sid);
  const ledger = readLedger(project).find((c) => c.session === sid) || null;

  const subDir = path.join(dir, sid, 'subagents');
  let metas = [];
  try {
    metas = fs.readdirSync(subDir).filter((n) => n.endsWith('.meta.json'));
  } catch {
    /* no subagents */
  }

  const raw = metas.map((n) => {
    const id = n.slice('agent-'.length, -'.meta.json'.length);
    const meta = readMeta(path.join(subDir, n));
    const fold = foldFile(path.join(subDir, `agent-${id}.jsonl`)) || newFold();
    return { id, meta, fold };
  });
  const foldById = new Map(raw.map((r) => [r.id, r.fold]));

  const nodes = [];
  const leadSum = summarize(main, pricing);
  nodes.push({
    id: 'lead',
    parent: null,
    depth: 0,
    agentType: 'lead',
    ...labeler('lead', 0),
    description: null,
    requestedModel: null,
    status: live ? (leadSum.waitingOn ? 'waiting' : 'running') : ledger ? (ledger.rc === 0 && !ledger.is_error ? 'done' : 'failed') : 'interrupted',
    branch: main.gitBranch,
    worktree: null,
    cwd: main.cwd,
    brief: main.prompt,
    report: live ? null : main.lastText.slice(0, TEXT_CAP) || null,
    ...leadSum
  });

  for (const { id, meta, fold } of raw) {
    const sum = summarize(fold, pricing);
    const parentId = meta.parentAgentId && foldById.has(meta.parentAgentId) ? meta.parentAgentId : 'lead';
    const parentFold = parentId === 'lead' ? main : foldById.get(parentId);
    const call = meta.toolUseId ? parentFold?.agentCalls.get(meta.toolUseId) : null;
    const returned = meta.toolUseId ? parentFold?.results.has(meta.toolUseId) : false;
    const errored = meta.toolUseId ? parentFold?.errors.has(meta.toolUseId) : false;
    let state;
    if (errored) state = 'failed';
    else if (meta.finished || returned) state = 'done';
    else if (live) state = sum.waitingOn ? 'waiting' : sum.turns ? 'running' : 'queued';
    else state = 'interrupted';
    const depth = Number.isInteger(meta.spawnDepth) ? meta.spawnDepth : parentId === 'lead' ? 1 : 2;
    const agentType = meta.agentType || call?.subagentType || 'agent';
    nodes.push({
      id,
      parent: parentId,
      depth,
      agentType,
      ...labeler(agentType, depth),
      description: meta.description || call?.description || null,
      requestedModel: meta.model || call?.model || null,
      status: state,
      branch: branchOf(meta, fold, raw),
      worktree: meta.worktreePath || meta.inheritedWorktreePath || null,
      cwd: fold.cwd,
      brief: fold.prompt,
      report: state === 'done' || state === 'failed' ? fold.lastText.slice(0, TEXT_CAP) || null : null,
      ...sum
    });
  }

  // The lead's own last line can be hours before the cycle really stopped
  // (it waits inside its agents), so its span is the whole cycle's span.
  for (const n of nodes) {
    if (n.ended && (!nodes[0].ended || n.ended > nodes[0].ended)) nodes[0].ended = n.ended;
  }

  nodes.sort((a, b) => a.depth - b.depth || String(a.started || '').localeCompare(String(b.started || '')));

  const total = nodes.reduce(
    (t, n) => {
      t.costUsd += n.costUsd;
      t.outputTokens += n.outputTokens;
      t.toolCalls += n.toolCalls;
      t.byStatus[n.status] = (t.byStatus[n.status] || 0) + 1;
      return t;
    },
    { costUsd: 0, outputTokens: 0, toolCalls: 0, byStatus: {} }
  );
  total.costUsd = Math.round(total.costUsd * 100) / 100;

  return {
    session: {
      id: sid,
      live,
      started: ledger?.start || main.first,
      ended: live ? null : ledger?.end || nodes[0].ended || main.last,
      ledger: ledger
        ? { costUsd: ledger.cost_usd ?? null, turns: ledger.turns ?? null, secs: ledger.secs ?? null, summary: ledger.summary || null, rc: ledger.rc }
        : null,
      claudeVersion: main.version,
      agents: nodes.length,
      total
    },
    nodes
  };
}

/** Per-model and per-role token and cost totals of one session (for the Usage tab). */
export function sessionUsage(project, sid, { pricing, labeler }) {
  const tree = sessionTree(project, sid, { pricing, labeler });
  if (!tree) return null;
  const byModel = {};
  const byRole = {};
  for (const n of tree.nodes) {
    const m = (byModel[n.model || 'unknown'] ||= { costUsd: 0, output: 0, input: 0, cacheRead: 0, cacheWrite: 0, agents: 0 });
    const r = (byRole[n.kind] ||= { costUsd: 0, output: 0, agents: 0 });
    m.costUsd += n.costUsd;
    m.output += n.tokens.output;
    m.input += n.tokens.input;
    m.cacheRead += n.tokens.cacheRead;
    m.cacheWrite += n.tokens.cacheWrite;
    m.agents++;
    r.costUsd += n.costUsd;
    r.output += n.tokens.output;
    r.agents++;
  }
  return { id: sid, started: tree.session.started, costUsd: tree.session.total.costUsd, byModel, byRole };
}

export const _test = { feedLine, newFold, summarize, costOf, folds };
