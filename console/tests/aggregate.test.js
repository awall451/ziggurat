import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGateLog, parseIssue, summary, notes, gallery, mediaFile, noteFile, resolveInside, briefs } from '../src/lib/server/aggregate.js';

describe('parseGateLog', () => {
  it('reads verdict lines and the test count', () => {
    const rows = parseGateLog(
      [
        '2026-01-01T10:00:00+00:00 field-menu abcdef0123456789 merged all checks passed; main -> abcdef012 (1031 tests)',
        '2026-01-01T10:05:00+00:00 canary-1 1234567890 failed STEP install FAIL 0s - see log',
        'garbage'
      ].join('\n')
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ topic: 'field-menu', sha: 'abcdef012', status: 'merged', tests: 1031, canary: false, proof: false });
    expect(rows[1]).toMatchObject({ status: 'failed', tests: null, canary: true });
  });

  it('marks the verdicts of a gate proof', () => {
    const rows = parseGateLog(
      [
        '2026-01-01T10:00:00+00:00 gate-proof-good-1795102282 abcdef0123456789 merged all checks passed; main -> abcdef012 (2 tests)',
        '2026-01-01T10:00:05+00:00 gate-proof-drop-1795102282 1234567890abcdef failed unit tests passed dropped from 2 to 1 (tests may not be deleted or skipped)',
        '2026-01-01T10:01:00+00:00 improve-gate-proofing 1111111111 merged all checks passed (3 tests)'
      ].join('\n')
    );
    expect(rows.map((r) => r.proof)).toEqual([true, true, false]);
    expect(rows[0].tests).toBe(2);
  });
});

describe('parseIssue', () => {
  it('reads frontmatter and defaults', () => {
    const i = parseIssue('0007-save-bug.md', '---\nid: 0007\ntitle: Save: breaks on reload\nseverity: Major\n---\n\nBody text');
    expect(i).toMatchObject({ id: '0007', title: 'Save: breaks on reload', severity: 'major', status: 'open', body: 'Body text' });
    expect(parseIssue('012-no-front.md', 'just text')).toMatchObject({ id: '012', title: '012-no-front', severity: 'n/a' });
  });
});

describe('files from the fleet folder', () => {
  let project;
  let outside;

  beforeAll(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-agg-'));
    const fleet = path.join(root, 'fleet');
    outside = path.join(root, 'secret.md');
    fs.writeFileSync(outside, 'secret');
    fs.mkdirSync(path.join(fleet, 'notes', 'agents', 'issues'), { recursive: true });
    fs.mkdirSync(path.join(fleet, 'shots', '2026-01-01'), { recursive: true });
    fs.writeFileSync(path.join(fleet, 'notes', 'agents', 'STATE.md'), '# State');
    fs.writeFileSync(path.join(fleet, 'notes', 'agents', 'ESCALATIONS.md'), '# E\n\n## one\n\n## two\n');
    fs.writeFileSync(path.join(fleet, 'notes', 'agents', 'issues', '001-a.md'), '---\nseverity: minor\n---\nx');
    fs.writeFileSync(path.join(fleet, 'notes', 'agents', 'issues', '002-b.md'), '---\nseverity: blocker\nstatus: fixed\n---\nx');
    fs.writeFileSync(path.join(fleet, 'notes', 'design.md'), '# Design');
    fs.symlinkSync(outside, path.join(fleet, 'notes', 'link.md'));
    fs.writeFileSync(path.join(fleet, 'shots', '2026-01-01', '01-title.png'), 'png');
    fs.writeFileSync(path.join(fleet, 'shots', '2026-01-01', 'notes.txt'), 'no');
    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(fleet, 'cycles.jsonl'),
      JSON.stringify({ start: now, secs: 600, cost_usd: 1.234, rc: 0 }) + '\n' + JSON.stringify({ start: '2020-01-01T00:00:00Z', secs: 60, cost_usd: 9 }) + '\n'
    );
    fs.writeFileSync(
      path.join(fleet, 'history.log'),
      `${now} a 1111111111 merged all checks passed (10 tests)\n${now} b 2222222222 merged already contained in main\n${now} c 3333333333 rejected tests dropped\n`
    );
    project = { id: 'demo', paths: { fleet } };
  });

  it('summarises the last 24 hours', () => {
    const s = summary(project);
    expect(s.last24).toEqual({ cycles: 1, costUsd: 1.23, merged: 1, failed: 1, minutes: 10 });
    expect(s.testsNow).toBe(10);
    expect(s.issuesOpen).toBe(1);
    expect(s.escalations).toBe(2);
  });

  it('does not count a gate proof as the team\'s merges or failures', () => {
    const fleet = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-proof-'));
    const now = new Date().toISOString();
    // A brand-new project: the only verdicts are the proof's two.
    fs.writeFileSync(
      path.join(fleet, 'history.log'),
      `${now} gate-proof-good-1 1111111111 merged all checks passed; main -> 111111111 (2 tests)\n${now} gate-proof-drop-1 2222222222 failed unit tests passed dropped from 2 to 1 (tests may not be deleted or skipped)\n`
    );
    const s = summary({ id: 'fresh', paths: { fleet } });
    expect(s.last24).toMatchObject({ merged: 0, failed: 0 });
    // The proof's merge did move main, so its test count is the current one.
    expect(s.testsNow).toBe(2);
  });

  it('sorts issues by severity and lists other notes', () => {
    const n = notes(project);
    expect(n.issues.map((i) => i.id)).toEqual(['002', '001']);
    expect(n.files).toContain('design.md');
  });

  it('lists only png screenshots', () => {
    expect(gallery(project)).toEqual([{ date: '2026-01-01', files: ['01-title.png'] }]);
  });

  it('refuses paths outside the folder, including through a symlink', () => {
    expect(resolveInside(path.join(project.paths.fleet, 'notes'), '../../secret.md')).toBeNull();
    expect(noteFile(project, 'link.md')).toBeNull();
    expect(noteFile(project, 'design.md')).toBe('# Design');
    expect(mediaFile(project, 'shots/2026-01-01/01-title.png')).toMatchObject({ type: 'image/png' });
    expect(mediaFile(project, 'shots/2026-01-01/notes.txt')).toBeNull();
    expect(mediaFile(project, 'notes/design.md')).toBeNull();
    expect(mediaFile(project, 'shots/../../secret.md')).toBeNull();
  });
});

describe('briefs', () => {
  it('lists one brief per cycle and reads only the one asked for', () => {
    const fleet = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-brief-'));
    const A = '11111111-2222-4333-8444-555555555555';
    const B = '22222222-2222-4333-8444-555555555555';
    fs.mkdirSync(path.join(fleet, 'briefs'));
    fs.writeFileSync(path.join(fleet, 'briefs', `${A}.md`), '**Headline:** merged');
    fs.writeFileSync(path.join(fleet, 'briefs', `${A}.mp3`), 'id3');
    fs.writeFileSync(path.join(fleet, 'briefs', `${A}.spoken.txt`), 'spoken');
    fs.writeFileSync(path.join(fleet, 'briefs', `${B}.mp3`), 'id3');
    fs.writeFileSync(path.join(fleet, 'briefs', 'notes.md'), 'not a brief');
    const project = { paths: { fleet } };
    const all = briefs(project);
    expect([...all.keys()].sort()).toEqual([A, B]);
    expect(all.get(A)).toEqual({ md: '', mp3: true });
    expect(all.get(B)).toEqual({ md: null, mp3: true });
    expect(briefs(project, A).get(A).md).toBe('**Headline:** merged');
    expect(mediaFile(project, `briefs/${A}.mp3`)).toBeTruthy();
    expect(mediaFile(project, `briefs/${A}.spoken.txt`)).toBeNull();
  });
});

describe('ledger kinds (kit 0.10)', () => {
  it('counts the cost of chat turns, but not the turns as cycles', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-kinds-'));
    const at = (min) => new Date(Date.now() - min * 60000).toISOString();
    const lines = [
      { start: at(300), end: at(200), secs: 6000, cost_usd: 10, counted: true },
      { start: at(100), end: at(98), secs: 90, cost_usd: 1, counted: true, kind: 'plan', plan: '20260101T000000Z-p-x' },
      { start: at(90), end: at(89), secs: 20, cost_usd: 0.25, counted: false, kind: 'chat', plan: '20260101T000000Z-p-x' },
      { start: at(80), end: at(79), secs: 20, cost_usd: 0.25, counted: false, kind: 'chat', plan: '20260101T000000Z-p-x' }
    ];
    fs.writeFileSync(path.join(root, 'cycles.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const s = summary({ paths: { fleet: root } });
    expect(s.last24.cycles).toBe(2);
    expect(s.last24.costUsd).toBe(11.5);
    expect(s.lastCycle.kind).toBe('plan');
  });
});

describe('galleryCycles (kit 0.13)', () => {
  const sha = (c) => c.repeat(40);
  const S1 = '11111111-1111-4111-8111-111111111111';
  const S2 = '22222222-2222-4222-8222-222222222222';
  const S3 = '33333333-3333-4333-8333-333333333333';
  let project;
  beforeAll(() => {
    const fleet = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-cycles-'));
    project = { paths: { fleet } };
    const shots = path.join(fleet, 'shots');
    // A name alone has the content 'png'; [name, content] gives it other bytes.
    const build = (s, files) => {
      fs.mkdirSync(path.join(shots, s), { recursive: true });
      for (const f of files) fs.writeFileSync(path.join(shots, s, ...[f].flat().slice(0, 1)), [f].flat()[1] || 'png');
    };
    build(sha('a'), ['01-title.png']); // gate proof, before any cycle
    build(sha('b'), ['01-title.png', '02-room.png']); // during cycle 1
    build(sha('c'), [['01-title.png', 'title v2']]); // after cycle 1 ended, before cycle 2: still cycle 1
    build(sha('d'), [['02-title.png', 'title v2'], 'bad name.png']); // during cycle 2 (a plan): renumbered, same bytes
    build(sha('e'), []); // no files: left out
    build(sha('f'), ['03-new.png']); // during the live cycle
    fs.writeFileSync(
      path.join(shots, 'index'),
      [
        `2026-01-01T09:00:00+00:00 ${sha('a')} gate-proof-good-1`,
        `2026-01-01T10:20:00+00:00 ${sha('b')} room-art`,
        `2026-01-01T11:05:00+00:00 ${sha('c')} title-fix`,
        `2026-01-01T12:10:00+00:00 ${sha('d')} plan-notes`,
        `2026-01-01T12:30:00+00:00 ${sha('e')} empty`,
        `2026-01-01T14:10:00+00:00 ${sha('f')} new-screen`,
        `2026-01-01T14:20:00+00:00 ${sha('b')} room-art`,
        'garbage line',
        `not-a-date ${sha('9')} x`
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(fleet, 'cycles.jsonl'),
      [
        { start: '2026-01-01T10:00:00+00:00', end: '2026-01-01T11:00:00+00:00', session: S1, kind: 'normal' },
        { start: '2026-01-01T11:30:00+00:00', end: '2026-01-01T11:40:00+00:00', session: S1, kind: 'chat', counted: false },
        { start: '2026-01-01T12:00:00+00:00', end: '2026-01-01T12:40:00+00:00', session: S2, kind: 'plan' }
      ]
        .map((l) => JSON.stringify(l))
        .join('\n')
    );
  });

  it('puts each merged build in the cycle that made it, newest first', async () => {
    const { galleryCycles } = await import('../src/lib/server/aggregate.js');
    const out = galleryCycles(project, { session: S3, start: '2026-01-01T14:00:00+00:00' });
    expect(out.map((c) => [c.key, c.number, c.kind, c.live])).toEqual([
      [S3, 3, 'normal', true],
      [S2, 2, 'plan', false],
      [S1, 1, 'normal', false],
      ['setup', null, 'setup', false]
    ]);
    expect(out[2].builds.map((b) => b.topic)).toEqual(['title-fix', 'room-art']);
    expect(out[2].builds[1].files).toEqual(['01-title.png', '02-room.png']);
    expect(out[1].builds[0].files).toEqual(['02-title.png']);
    expect(out[3].builds[0].sha).toBe(sha('a'));
  });

  it('without a live cycle, later builds stay with the newest cycle; chat turns are never cycles', async () => {
    const { galleryCycles } = await import('../src/lib/server/aggregate.js');
    const out = galleryCycles(project);
    expect(out.map((c) => c.key)).toEqual([S2, S1, 'setup']);
    expect(out[0].builds.map((b) => b.topic)).toEqual(['new-screen', 'plan-notes']);
  });

  it('marks what a cycle made or changed against the newest build before it', async () => {
    const { galleryCycles } = await import('../src/lib/server/aggregate.js');
    const [live, plan, one, setup] = galleryCycles(project, { session: S3, start: '2026-01-01T14:00:00+00:00' });
    // Setup has nothing before it: all new.
    expect(setup.builds[0].fresh).toEqual([{ file: '01-title.png', why: 'new' }]);
    expect(setup.builds[0].removed).toBe(0);
    // Both builds of cycle 1 are compared with the setup build, not with each other.
    const [fix, room] = one.builds;
    expect(room.fresh).toEqual([{ file: '02-room.png', why: 'new' }]);
    expect(fix.fresh).toEqual([{ file: '01-title.png', why: 'changed' }]);
    expect([room.removed, fix.removed]).toEqual([0, 0]);
    // The same bytes under a new number are the same screen: nothing new.
    expect(plan.builds[0].fresh).toEqual([]);
    expect(plan.builds[0].removed).toBe(0);
    // A new screen, and the title screen is gone.
    expect(live.builds[0].fresh).toEqual([{ file: '03-new.png', why: 'new' }]);
    expect(live.builds[0].removed).toBe(1);
    expect(live.builds[0]).not.toHaveProperty('hashes');
  });

  it('serves a build screenshot through the shots root and still lists days separately', () => {
    expect(mediaFile(project, `shots/${sha('b')}/02-room.png`)).not.toBeNull();
    expect(mediaFile(project, `shots/${sha('b')}/../../cycles.jsonl`)).toBeNull();
    expect(gallery(project)).toEqual([]);
  });
});
