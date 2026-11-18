import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGateLog, parseIssue, summary, notes, gallery, mediaFile, noteFile, resolveInside } from '../src/lib/server/aggregate.js';

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
    expect(rows[0]).toMatchObject({ topic: 'field-menu', sha: 'abcdef012', status: 'merged', tests: 1031, canary: false });
    expect(rows[1]).toMatchObject({ status: 'failed', tests: null, canary: true });
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
