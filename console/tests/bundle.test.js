import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-bun-'));
process.env.CONSOLE_PROJECTS_DIR = path.join(root, 'projects');
process.env.CONSOLE_DATA_DIR = path.join(root, 'data');
const b = await import('../src/lib/server/bundle.js');
const { readFrom, readAll } = await import('../src/lib/server/events.js');

const base = path.join(root, 'projects', 'plan');
const team = path.join(base, 'team');
const src = { kind: 'folder', id: 'plan' };
const put = (rel, text, mode) => {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  if (mode) fs.chmodSync(p, mode);
};
const agent = (id, name = id) => put(`team/agents/${id}.md`, `---\nname: ${name}\ndescription: does ${id}\nmodel: sonnet\n---\nYou are a {{worker}} for the {{lead}}.\n`);

beforeEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
  put('team/CHARTER.md', '# Charter\nThe {{lead}} and the {{area_leads}} build it.\n');
  put('team/GATE-CONTRACT.md', '# Gate\n');
  put('team/lead-cycle.md', 'You are the {{lead}}.\n');
  put('team/gate-checks', '#!/bin/bash\necho TESTS_PASSED=1\n', 0o755);
  put('team/checks/extra.mjs', '// a check\n');
  for (const a of ['area-lead-core', 'builder', 'scout', 'reviewer']) agent(a);
  put('seed/README.md', '# seed\n');
});

describe('checkBundle', () => {
  it('accepts a complete team and reports what is in it', () => {
    put('team/project.env', '# settings\nBASELINE_TESTS=3\nLEAD_MODEL=opus\n');
    put('team/agent.env.extra', 'PIP_DISABLE_PIP_VERSION_CHECK=1\n');
    put('team/requires-domains', 'pypi.org  # packages\n.pythonhosted.org\n');
    put('team/provision.sh', '#!/bin/bash\napt-get install -y python3-venv\n', 0o755);
    const c = b.checkBundle(src);
    expect(c.problems).toEqual([]);
    expect(c.ok).toBe(true);
    expect(c.agents.map((a) => a.id)).toEqual(['area-lead-core', 'builder', 'reviewer', 'scout']);
    expect(c.env).toEqual({ BASELINE_TESTS: '3', LEAD_MODEL: 'opus' });
    expect(c.extras).toEqual([['BASELINE_TESTS', '3']]);
    expect(c.agentEnv).toEqual([['PIP_DISABLE_PIP_VERSION_CHECK', '1']]);
    expect(c.domains).toEqual(['pypi.org', '.pythonhosted.org']);
    expect(c.provision).toContain('python3-venv');
    expect(c.seed).toBe(true);
  });

  it('names each thing that is wrong', () => {
    fs.rmSync(path.join(team, 'GATE-CONTRACT.md'));
    fs.rmSync(path.join(team, 'agents', 'scout.md'));
    put('team/gate-checks', 'echo no shebang\n');
    agent('helper', 'someone-else');
    put('team/agents/plain.md', 'no header here\n');
    put('team/project.env', 'BASELINE_TESTS=$(reboot)\nGOOD=1\nexport X=1\nQUOTED="a b"\n');
    put('team/requires-domains', 'not a domain\n');
    put('team/provision.sh', 'apt-get update\n');
    fs.symlinkSync('/etc/passwd', path.join(team, 'checks', 'link'));
    put('team/notes.txt', 'stray\n');
    const c = b.checkBundle(src);
    expect(c.ok).toBe(false);
    const all = c.problems.join('\n');
    for (const piece of ['GATE-CONTRACT.md: is missing', 'gate-checks: must start with', 'no scout', 'helper.md: the header says name "someone-else"', 'plain.md: has no header', 'project.env line 1', 'project.env line 3', 'project.env line 4', 'requires-domains', 'provision.sh: must start with', 'checks/link: is a link']) {
      expect(all).toContain(piece);
    }
    expect(all).not.toContain('project.env line 2');
    expect(c.warnings.join('\n')).toContain('notes.txt');
  });

  it('refuses names that could leave the projects folder', () => {
    for (const id of ['../etc', 'a/b', '.hidden', '']) expect(b.checkBundle({ kind: 'folder', id }).ok).toBe(false);
    expect(b.checkBundle({ kind: 'other', id: 'plan' }).ok).toBe(false);
  });

  it('warns when there is no seed', () => {
    fs.rmSync(path.join(base, 'seed'), { recursive: true });
    expect(b.checkBundle(src).warnings.join(' ')).toMatch(/No seed/);
  });

  it('lists project folders that have a team', () => {
    fs.mkdirSync(path.join(root, 'projects', 'empty'), { recursive: true });
    expect(b.listSources().filter((s) => s.kind === 'folder')).toEqual([{ kind: 'folder', id: 'plan', seed: true, files: false }]);
  });
});

describe('projectEnv', () => {
  const base = { id: 'demo', leadModel: 'fable', fallbackModel: 'opus', budgetUsd: 40, cyclesPerDay: 6, proxyUrl: 'http://10.66.0.1:3128' };

  it('writes plain lines and keeps its own keys', () => {
    const text = b.projectEnv({ ...base, extras: [['BASELINE_TESTS', '3'], ['PROJECT', 'other'], ['STATE', '/tmp']] });
    expect(text.match(/^PROJECT=/gm)).toHaveLength(1);
    expect(text).toContain('PROJECT=demo\n');
    expect(text).toContain('STATE=/var/lib/agent-kit\n');
    expect(text).toContain('BASELINE_TESTS=3\n');
  });

  it('refuses a value with shell characters', () => {
    expect(() => b.projectEnv({ ...base, leadModel: 'fable; reboot' })).toThrow();
    expect(() => b.projectEnv({ ...base, extras: [['X', '$(id)']] })).toThrow();
  });
});

describe('stageBundle', () => {
  it('copies only bundle files, applies the charter and renders the theme', async () => {
    put('team/notes.txt', 'stray\n');
    const dir = path.join(root, 'data', 'stage');
    const env = b.projectEnv({ id: 'demo', leadModel: 'fable', fallbackModel: 'opus', budgetUsd: 40, cyclesPerDay: 6, proxyUrl: 'http://10.66.0.1:3128' });
    const out = await b.stageBundle(dir, src, { theme: 'starship', charter: '# Goal\nThe {{lead}} ships a demo.', env });
    expect(out.charter).toBe('# Goal\nThe Captain ships a demo.\n');
    expect(fs.readdirSync(out.dir).sort()).toEqual(['CHARTER.md', 'GATE-CONTRACT.md', 'agents', 'checks', 'gate-checks', 'lead-cycle.md', 'project.env']);
    expect(fs.readFileSync(path.join(out.dir, 'agents', 'builder.md'), 'utf8')).not.toContain('{{');
    expect(fs.statSync(path.join(out.dir, 'gate-checks')).mode & 0o111).toBeTruthy();
    expect(fs.readFileSync(path.join(out.dir, 'project.env'), 'utf8')).toBe(env);
    // Staging again replaces the earlier result.
    const again = await b.stageBundle(dir, src, { theme: 'plain', charter: null, env });
    expect(again.charter).toContain('The lead and the area leads');
  });

  it('refuses a theme that does not exist', async () => {
    await expect(b.stageBundle(path.join(root, 'data', 'stage2'), src, { theme: 'nope', charter: null, env: 'PROJECT=demo\n' })).rejects.toThrow(/theme/);
  });
});

describe('buildPayload', () => {
  it('packs kit, team and seed; a project without a seed gets a minimal one', async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = path.join(root, 'data', 'pay');
    const env = b.projectEnv({ id: 'demo', leadModel: 'fable', fallbackModel: 'opus', budgetUsd: 40, cyclesPerDay: 6, proxyUrl: 'http://10.66.0.1:3128' });
    put('seed/.git/config', 'not copied\n');
    await b.stageBundle(dir, src, { theme: 'plain', charter: null, env });
    let out = await b.buildPayload(dir, src, { name: 'Demo', description: 'A demo' });
    let files = execFileSync('tar', ['-tzf', out.archive]).toString().split('\n');
    for (const f of ['kit/install.sh', 'kit/bin/lead-cycle', 'bundle/CHARTER.md', 'bundle/project.env', 'seed/README.md']) expect(files, f).toContain(f);
    expect(files.some((f) => f.startsWith('kit/tests') || f.includes('.git/'))).toBe(false);
    expect(out.files).toBe(null);
    expect(fs.existsSync(path.join(dir, 'payload'))).toBe(false);

    fs.rmSync(path.join(base, 'seed'), { recursive: true });
    put('files/toolchain.tar.gz', 'big\n');
    out = await b.buildPayload(dir, src, { name: 'Demo', description: 'A demo\nwith a second line' });
    files = execFileSync('tar', ['-tzf', out.archive]).toString().split('\n');
    expect(files).toEqual(expect.arrayContaining(['seed/README.md', 'seed/CLAUDE.md', 'seed/.gitignore']));
    expect(out.files).toBe(path.join(base, 'files'));
    const readme = execFileSync('tar', ['-xzOf', out.archive, 'seed/README.md']).toString();
    expect(readme).toBe('# Demo\n\nA demo with a second line\n');
  });
});

describe('the python-starter example', () => {
  it('passes the bundle check and can be picked in the wizard', () => {
    const c = b.checkBundle({ kind: 'example', id: 'python-starter' });
    expect(c.problems).toEqual([]);
    expect(c.agents.map((a) => a.id)).toEqual(['area-lead-core', 'area-lead-platform', 'builder', 'qa', 'reviewer', 'scout']);
    expect(c.domains).toEqual(['pypi.org', 'files.pythonhosted.org']);
    expect(c.extras).toEqual([['BASELINE_TESTS', '2'], ['GATE_PROOF_DELETE', 'tests/test_placeholder.py']]);
    expect(c.provision).toContain('python3-venv');
    expect(c.charter).toContain('REPLACE THIS');
    expect(b.listSources().filter((s) => s.kind === 'example').map((s) => s.id)).toEqual(['python-starter']);
  });

  it('keeps its seed and its own notes out of the team', async () => {
    const dir = path.join(root, 'data', 'starter');
    const out = await b.stageBundle(dir, { kind: 'example', id: 'python-starter' }, { theme: 'plain', charter: '# Charter\nBuild a ledger tool.\n', env: 'PROJECT=demo\n' });
    expect(fs.readdirSync(out.dir).sort()).toEqual(['CHARTER.md', 'GATE-CONTRACT.md', 'agent.env.extra', 'agents', 'gate-checks', 'lead-cycle.md', 'project.env', 'provision.sh', 'requires-domains']);
    for (const f of fs.readdirSync(path.join(out.dir, 'agents'))) expect(fs.readFileSync(path.join(out.dir, 'agents', f), 'utf8'), f).not.toContain('{{');
    expect(fs.readFileSync(path.join(out.dir, 'lead-cycle.md'), 'utf8')).not.toContain('{{');
  });
});

describe('reading a run\'s events', () => {
  it('continues from an offset and leaves a half-written line for later', () => {
    const f = path.join(root, 'events.jsonl');
    fs.writeFileSync(f, '{"type":"a"}\n{"type":"b"}\n{"type":"c"');
    const first = readFrom(f, 0);
    expect(first.events.map((e) => e.event.type)).toEqual(['a', 'b']);
    expect(first.events[0].at).toBe(13);
    fs.appendFileSync(f, '}\nnot json\n{"type":"d"}\n');
    expect(readFrom(f, first.next).events.map((e) => e.event.type)).toEqual(['c', 'd']);
    expect(readFrom(f, first.events[0].at).events.map((e) => e.event.type)).toEqual(['b', 'c', 'd']);
    expect(readAll(f)).toHaveLength(4);
    expect(readFrom(path.join(root, 'missing'), 0)).toEqual({ events: [], next: 0 });
  });
});
