import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Real git on real repositories in a temp folder. A bare repository stands in
// for the VM's canonical one, another for the remote. Only the ssh calls to
// the VM are faked; the secret scanner is a small stand-in script.
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-publish-'));
process.env.CONSOLE_DATA_DIR = path.join(T, 'data');
process.env.CONSOLE_CONFIG_DIR = path.join(T, 'config');
fs.mkdirSync(process.env.CONSOLE_CONFIG_DIR, { recursive: true });
const TOKEN = 'tok-' + 'Zq9'.repeat(12);
fs.writeFileSync(path.join(T, 'config', 'claude-token'), TOKEN + '\n');

// Stand-in for gitleaks: a commit that adds the word FAKESECRET is a finding of a
// rule for a known format, FAKEGUESS one of the rule that only guesses.
const SCANNER = path.join(T, 'gitleaks');
fs.writeFileSync(
  SCANNER,
  `#!/bin/bash
report= opts= repo=
while [ $# -gt 0 ]; do
  case "$1" in
    --report-path) report=$2; shift ;;
    --log-opts=*) opts=\${1#--log-opts=} ;;
    --exit-code|--report-format) shift ;;
    --ignore-gitleaks-allow) allow=ignored ;;
    -*) ;;
    git) ;;
    *) repo=$1 ;;
  esac
  shift
done
found=
if git -C "$repo" log -p $opts | grep -q FAKESECRET; then
  found='{"RuleID":"github-pat","File":"config.py","Commit":"abcdef0123456789","Secret":"FAKESECRET-raw","Match":"FAKESECRET-raw"}'
fi
if git -C "$repo" log -p $opts | grep -q FAKEGUESS; then
  found="\${found:+$found,}"'{"RuleID":"generic-api-key","File":"keymap.test.js","Commit":"1234567890abcdef","Secret":"FAKEGUESS-raw","Match":"key: FAKEGUESS-raw"}'
fi
[ -n "$found" ] || exit 0
echo "[$found]" > "$report"
exit 9
`,
  { mode: 0o755 }
);
process.env.GITLEAKS_BIN = SCANNER;

const sh = (cwd, ...argv) => execFileSync('git', ['-c', 'user.name=agent', '-c', 'user.email=agent@demo.invalid', '-C', cwd, ...argv], { encoding: 'utf8' }).trim();
const vms = new Map(); // project id -> {bare, work, flags, calls}

vi.mock('../src/lib/server/ssh.js', async (importOriginal) => ({
  ...(await importOriginal()),
  pull: async () => ({ code: 0, stderr: '' }),
  kit: async (project, script, argv, opts = {}) => {
    const vm = vms.get(project.id);
    vm.calls.push({ script, argv, input: opts.input ?? null });
    if (argv[0] === 'status') {
      const main = sh(vm.bare, 'rev-parse', 'main');
      return { code: 0, stdout: JSON.stringify({ main, cycle: false, gateBusy: false, unjudged: 0, stopped: false, gatePaused: false, ...vm.flags }) + '\n', stderr: '' };
    }
    return { code: 0, stdout: 'ok\n', stderr: '' };
  },
  kitToFile: async (project, script, argv, dest) => {
    const vm = vms.get(project.id);
    vm.calls.push({ script, argv });
    try {
      execFileSync('git', ['-C', vm.bare, 'bundle', 'create', '-q', dest, ...(argv[1] ? [`^${argv[1]}`] : []), 'refs/heads/main'], { stdio: 'pipe' });
      return { code: 0, stderr: '', bytes: fs.statSync(dest).size };
    } catch (e) {
      return { code: 1, stderr: String(e.stderr || e), bytes: 0 };
    }
  }
}));
vi.mock('../src/lib/server/live.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getStatus: async () => ({ reachable: true, kitVersion: '0.8.0', leadActive: false }),
  peekStatus: () => ({ reachable: true, kitVersion: '0.8.0', leadActive: false })
}));

const publish = await import('../src/lib/server/publish.js');
const config = await import('../src/lib/server/config.js');
const { validateProject } = await import('../src/lib/server/schema.js');
const { maskSecrets } = await import('../src/lib/server/mask.js');
const user = { name: 'owner' };
publish._test.allowLocalRemotes();

let n = 0;
/** A fresh project: a "VM" with one commit on main, an empty remote, set up and verified. */
async function scenario({ verified = true } = {}) {
  const id = `demo${++n}`;
  const bare = path.join(T, `${id}-vm.git`);
  const work = path.join(T, `${id}-work`);
  const remote = path.join(T, `${id}-remote.git`);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  fs.writeFileSync(path.join(work, 'README.md'), `# ${id}\n`);
  sh(work, 'add', '-A');
  sh(work, 'commit', '-q', '-m', 'seed');
  execFileSync('git', ['clone', '-q', '--bare', work, bare]);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  vms.set(id, { bare, work, remote, flags: {}, calls: [] });
  const raw = config.rawProjects();
  config.saveProject({ id, ssh: { alias: id }, publish: { remote } }, { replace: true });
  expect(config.rawProjects().length).toBe(raw.length + 1);
  if (verified) expect((await publish.verify(user, config.getProject(id))).ok).toBe(true);
  return { id, ...vms.get(id), project: () => config.getProject(id) };
}
/** A commit on the VM's main, as if the gate had merged it. */
function commit(s, file, text, message = `add ${file}`) {
  fs.mkdirSync(path.dirname(path.join(s.work, file)), { recursive: true });
  fs.writeFileSync(path.join(s.work, file), text);
  sh(s.work, 'add', '-A');
  sh(s.work, 'commit', '-q', '-m', message);
  sh(s.bare, 'fetch', '-q', s.work, '+main:main');
  return sh(s.bare, 'rev-parse', 'main');
}
const remoteMain = (s) => {
  try {
    return sh(s.remote, 'rev-parse', '--verify', '-q', 'main');
  } catch {
    return '';
  }
};
function request(s, text) {
  const dir = path.join(process.env.CONSOLE_DATA_DIR, 'publish', s.id, 'out');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'request.md'), text);
}
const flags = (s, f) => (vms.get(s.id).flags = f);
const ask = (s, date, summary = 'Menu fixes.') => request(s, `Publish: yes\nDate: ${date}\n---\n${summary}\n`);

describe('remote addresses', () => {
  it('accepts ssh addresses only', () => {
    publish._test.allowLocalRemotes(false);
    for (const ok of ['git@github.com:owner/repo.git', 'ssh://git@git.example.org:2222/team/repo.git', 'ssh://example.org/srv/git/repo.git']) {
      expect(publish.parseRemote(ok), ok).toBeTruthy();
    }
    for (const bad of [
      'https://github.com/owner/repo.git',
      'https://user:token@github.com/owner/repo.git',
      '-oProxyCommand=id@example.org:team/repo.git',
      'git@example.org:-team/repo.git',
      'git@example.org:team/repo.git --upload-pack=id',
      'git@example.org:team/repo.git;id',
      'ext::sh -c id',
      '/srv/git/repo.git',
      'file:///srv/git/repo.git',
      'ssh://git@example.org:99999/x',
      'git@example.org:~user/repo.git',
      `git@example.org:${'a'.repeat(200)}.git`,
      ''
    ]) {
      expect(publish.parseRemote(bad), bad).toBeNull();
    }
    publish._test.allowLocalRemotes();
  });

  it('the project schema takes the same addresses', () => {
    const base = { id: 'x', ssh: { alias: 'x' } };
    expect(validateProject({ ...base, publish: { remote: 'git@github.com:owner/repo.git' } }).publish.remote).toBe('git@github.com:owner/repo.git');
    expect(() => validateProject({ ...base, publish: { remote: 'https://github.com/owner/repo.git' } })).toThrow(/ssh address/);
    expect(() => validateProject({ ...base, publish: { remote: '-oProxyCommand=id@h:p' } })).toThrow(/ssh address/);
    expect(() => validateProject({ ...base, publish: { remote: 'git@h:p', key: '/etc/passwd' } })).toThrow();
  });
});

describe('setting up', () => {
  it('makes one key per project and only ever shows the public half', async () => {
    const s = await scenario({ verified: false });
    const out = await publish.setRemote(user, s.project(), 'git@example.org:team/demo.git');
    expect(out.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+ ziggurat-demo\d+$/);
    const keyFile = path.join(process.env.CONSOLE_DATA_DIR, 'publish', s.id, 'key');
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    const secret = fs.readFileSync(keyFile, 'utf8');
    expect(secret).toContain('PRIVATE KEY');
    const shown = JSON.stringify([out, publish.publishView(s.project()), publish.history(s.project())]);
    expect(shown).not.toContain('PRIVATE KEY');
    expect(shown).not.toContain(secret.split('\n')[1]);
    // The same key is kept when the address changes.
    const again = await publish.setRemote(user, s.project(), 'git@example.org:team/other.git');
    expect(again.publicKey).toBe(out.publicKey);
    await expect(publish.setRemote(user, s.project(), 'https://example.org/x.git')).rejects.toThrow(/ssh address/);
  });

  it('refuses to publish to a remote that was not verified, without recording a refusal', async () => {
    const s = await scenario({ verified: false });
    await expect(publish.publish(user, s.project(), { manual: true })).rejects.toThrow(/not been verified/);
    expect(publish.history(s.project())).toEqual([]);
    expect(remoteMain(s)).toBe('');
  });

  it('a changed address has to be verified again', async () => {
    const s = await scenario();
    expect(publish.publishView(s.project()).verified).toBeTruthy();
    const other = path.join(T, `${s.id}-other.git`);
    execFileSync('git', ['init', '-q', '--bare', other]);
    await publish.setRemote(user, s.project(), other);
    expect(publish.publishView(s.project()).verified).toBeNull();
    await expect(publish.publish(user, s.project(), { manual: true })).rejects.toThrow(/not been verified/);
  });

  it('verifying tells the VM, so its lead learns about publishing', async () => {
    const s = await scenario();
    expect(s.calls.some((c) => c.argv[0] === 'enable' && c.argv[1] === s.remote)).toBe(true);
  });
});

describe('the console verifies by itself', () => {
  const view = (s) => publish.publishView(s.project());

  it('checks a remote that is not verified, records it and tells the VM', async () => {
    const s = await scenario({ verified: false });
    expect(view(s).auto).toMatchObject({ checking: true, waiting: false });
    const out = await publish.maybeVerify(s.project());
    expect(out).toMatchObject({ ok: true, verified: true });
    expect(view(s).verified).toBeTruthy();
    expect(view(s).auto).toBeNull();
    expect(s.calls.at(-1)).toMatchObject({ script: 'agent-kit-publish', argv: ['enable', s.remote] });
    // Verified: nothing more to do, and nothing is asked of the VM again.
    const calls = s.calls.length;
    expect(publish.maybeVerify(s.project())).toBeNull();
    expect(s.calls.length).toBe(calls);
    await expect(publish.publish(user, s.project(), { manual: true })).resolves.toMatchObject({ outcome: 'published' });
  });

  it('tries again with back-off, is quiet for the first hour, then tells the owner, and clears by itself', async () => {
    const s = await scenario({ verified: false });
    const gone = path.join(T, `${s.id}-not-there.git`);
    await publish.setRemote(user, s.project(), gone);
    const t0 = Date.now() - 2 * 3600_000;
    // The key is not there yet (here: no such repository).
    expect(await publish.maybeVerify(s.project(), t0)).toMatchObject({ ok: false });
    expect(s.calls.filter((c) => c.argv[0] === 'enable')).toEqual([]);
    // Not again within 15 minutes; again after.
    expect(publish.maybeVerify(s.project(), t0 + 14 * 60_000)).toBeNull();
    expect(await publish.maybeVerify(s.project(), t0 + 16 * 60_000)).toMatchObject({ ok: false });
    // After the first day: hourly.
    const day = t0 + 25 * 3600_000;
    publish._test.writeState(s.id, { auto: { ...publish._test.readState(s.id).auto, lastAt: day } });
    expect(publish.maybeVerify(s.project(), day + 30 * 60_000)).toBeNull();
    // It started two hours ago and still fails: the owner is told, with the host's answer.
    const v = view(s);
    expect(v.verified).toBeNull();
    expect(v.auto.waiting).toBe(true);
    expect(v.auto.error).toMatch(/Could not read the remote/);
    // A fresh failure (the first hour) is not shown.
    publish._test.writeState(s.id, { auto: { ...publish._test.readState(s.id).auto, since: Date.now() - 10 * 60_000 } });
    expect(view(s).auto.waiting).toBe(false);
    // The repository appears: the next check passes and the item is gone.
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', gone]);
    expect(await publish.maybeVerify(s.project(), day + 61 * 60_000)).toMatchObject({ ok: true, verified: true });
    expect(view(s)).toMatchObject({ auto: null });
    expect(view(s).verified).toBeTruthy();
    expect(s.calls.at(-1).argv).toEqual(['enable', gone]);
  });

  it('a changed address starts the checks over', async () => {
    const s = await scenario({ verified: false });
    await publish.setRemote(user, s.project(), path.join(T, `${s.id}-nowhere.git`));
    await publish.maybeVerify(s.project(), Date.now() - 3 * 3600_000);
    expect(view(s).auto.waiting).toBe(true);
    await publish.setRemote(user, s.project(), path.join(T, `${s.id}-nowhere-else.git`));
    expect(view(s).auto).toMatchObject({ waiting: false, error: null });
  });

  it('never accepts a new host key by itself, and reuses one the owner confirmed for that host', async () => {
    const s = await scenario({ verified: false });
    // Nothing listens there: no network is needed to see what the console does first.
    await publish.setRemote(user, s.project(), 'ssh://git@127.0.0.1:1/team/demo.git');
    const first = await publish.maybeVerify(s.project());
    expect(first).toMatchObject({ ok: false, need: 'hostkey' });
    expect(publish._test.readState(s.id).hostKey).toBeUndefined();
    // Shown at once: only the owner can do this.
    expect(view(s).auto).toMatchObject({ waiting: true, need: 'hostkey' });
    // Another project of this console has that host's key, confirmed by the owner.
    const other = await scenario({ verified: false });
    const line = 'ssh-ed25519 ' + 'A'.repeat(68);
    publish._test.writeState(other.id, { hostKey: { host: '127.0.0.1', port: 1, line, fingerprint: 'SHA256:' + 'b'.repeat(43), at: '2026-01-01T00:00:00Z' } });
    publish._test.writeState(s.id, { auto: { ...publish._test.readState(s.id).auto, lastAt: 0 } });
    const second = await publish.maybeVerify(s.project());
    expect(publish._test.readState(s.id).hostKey).toMatchObject({ host: '127.0.0.1', port: 1, line, reused: true });
    // The key is trusted now; the remote itself still does not answer.
    expect(second.ok).toBe(false);
    expect(second.need).toBeUndefined();
    expect(view(s).verified).toBeNull();
  });

  it("keeps the forge's own reason in a refusal", () => {
    const stderr = 'ERROR: The key you are authenticating with has been marked as read only.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n';
    expect(publish._test.tail({ code: 128, stderr, stdout: '' })).toMatch(/^ERROR: The key you are authenticating with has been marked as read only\. · fatal: Could not read/);
    expect(publish._test.tail({ code: 1, stderr: 'a\nb\nc\nd\n', stdout: '' })).toBe('b · c · d');
  });
});

describe('publishing', () => {
  it('pushes main with the same commits, then has nothing to do', async () => {
    const s = await scenario();
    const main = commit(s, 'a.txt', 'a\n');
    const out = await publish.publish(user, s.project(), { manual: true });
    expect(out).toMatchObject({ ok: true, outcome: 'published', sha: main, commits: 2 });
    expect(remoteMain(s)).toBe(main);
    expect(s.calls.at(-1)).toMatchObject({ argv: ['record', main] });
    expect(publish.publishView(s.project())).toMatchObject({ sha: main, blocked: null });

    const again = await publish.publish(user, s.project(), { manual: true });
    expect(again.outcome).toBe('nothing');
    expect(publish.history(s.project()).map((h) => h.outcome)).toEqual(['published']);
  });

  it('later publishes send only what is new', async () => {
    const s = await scenario();
    const first = commit(s, 'a.txt', 'a\n');
    await publish.publish(user, s.project(), { manual: true });
    const second = commit(s, 'b.txt', 'b\n');
    const out = await publish.publish(user, s.project(), { manual: true });
    expect(out).toMatchObject({ outcome: 'published', commits: 1, sha: second });
    expect(s.calls.find((c) => c.argv[0] === 'bundle' && c.argv[1])?.argv[1]).toBe(first);
    expect(sh(s.remote, 'rev-list', '--count', 'main')).toBe('3');
  });

  it('waits while the gate works; a cycle or an unjudged branch only holds back the automatic publish', async () => {
    const s = await scenario();
    commit(s, 'a.txt', 'a\n');
    flags(s, { gateBusy: true });
    expect((await publish.publish(user, s.project(), { manual: true })).outcome).toBe('waiting');
    flags(s, { cycle: true });
    expect((await publish.publish(user, s.project())).outcome).toBe('waiting');
    flags(s, { unjudged: 2 });
    expect((await publish.publish(user, s.project())).outcome).toBe('waiting');
    expect(remoteMain(s)).toBe('');
    // A halted team's leftover branches are never judged: do not wait for them.
    flags(s, { unjudged: 2, stopped: true });
    expect((await publish.publish(user, s.project())).outcome).toBe('published');
  });
});

describe('what is refused', () => {
  const refused = async (s, pattern, { toldLead = true } = {}) => {
    const before = remoteMain(s);
    const out = await publish.publish(user, s.project(), { manual: true });
    expect(out.outcome).toBe('blocked');
    expect(out.detail).toMatch(pattern);
    expect(remoteMain(s)).toBe(before);
    expect(publish.publishView(s.project()).blocked.reason).toMatch(pattern);
    // The lead is told why, in words, when it is something the team can fix.
    const told = s.calls.filter((c) => c.argv[0] === 'blocked');
    if (toldLead) expect(told.at(-1).input).toMatch(pattern);
    else expect(told).toEqual([]);
    return out;
  };

  it('a secret in the new commits, and never shows the secret', async () => {
    const s = await scenario();
    commit(s, 'ok.txt', 'fine\n');
    await publish.publish(user, s.project(), { manual: true });
    const good = remoteMain(s);
    commit(s, 'config.py', 'KEY = "FAKESECRET-raw"\n');
    const out = await refused(s, /Possible secret.*rule github-pat in config\.py/);
    expect(JSON.stringify([out, publish.publishView(s.project()), publish.history(s.project()), s.calls])).not.toContain('FAKESECRET');
    // Deleting the file later does not help: the commit is still in what would be pushed.
    sh(s.work, 'rm', '-q', 'config.py');
    commit(s, 'ok2.txt', 'fine\n', 'remove the key');
    await refused(s, /Possible secret/);
    expect(remoteMain(s)).toBe(good);
  });

  it('a finding of a rule that only guesses is shown and does not hold the publish back', async () => {
    const s = await scenario();
    commit(s, 'keymap.test.js', "key: 'FAKEGUESS-raw'\n");
    const out = await publish.publish(user, s.project(), { manual: true });
    expect(out.outcome).toBe('published');
    expect(out.detail).toMatch(/1 note/);
    expect(remoteMain(s)).toBe(sh(s.bare, 'rev-parse', 'main'));
    const view = publish.publishView(s.project());
    expect(view.blocked).toBe(null);
    expect(view.notes).toEqual(['rule generic-api-key in keymap.test.js, commit 123456789']);
    expect(publish.history(s.project())[0].notes).toEqual(view.notes);
    expect(s.calls.filter((c) => c.argv[0] === 'blocked')).toEqual([]);
    expect(JSON.stringify([out, view, publish.history(s.project()), s.calls])).not.toContain('FAKEGUESS');
    // The next clean publish has no notes left.
    commit(s, 'ok.txt', 'fine\n');
    await publish.publish(user, s.project(), { manual: true });
    expect(publish.publishView(s.project()).notes).toEqual([]);
  });

  it('a guess beside a finding of a known format: refused, and only for the known format', async () => {
    const s = await scenario();
    commit(s, 'keymap.test.js', "key: 'FAKEGUESS-raw'\n");
    commit(s, 'config.py', 'KEY = "FAKESECRET-raw"\n');
    const out = await refused(s, /Possible secret.*rule github-pat in config\.py/);
    expect(out.detail).not.toMatch(/generic-api-key/);
  });

  it('the Claude token, found by exact match, and never shows it', async () => {
    const s = await scenario();
    commit(s, 'notes.md', `the token is ${TOKEN} do not share\n`);
    const out = await refused(s, /Claude sign-in token/);
    expect(JSON.stringify([out, publish.publishView(s.project()), publish.history(s.project()), s.calls])).not.toContain(TOKEN);
  });

  it('CI files, on a first publish and on a later one', async () => {
    const s = await scenario();
    commit(s, '.github/workflows/build.yml', 'on: push\n');
    await refused(s, /CI files changed.*\.github\/workflows\/build\.yml/);

    const t = await scenario();
    commit(t, 'a.txt', 'a\n');
    await publish.publish(user, t.project(), { manual: true });
    commit(t, '.gitlab-ci.yml', 'stages: []\n');
    await refused(t, /\.gitlab-ci\.yml/);
    // A file that only looks similar is fine.
    const u = await scenario();
    commit(u, 'docs/.github/workflows/readme.md', 'about workflows\n');
    expect((await publish.publish(user, u.project(), { manual: true })).outcome).toBe('published');
  });

  it('a remote that has commits this project does not have', async () => {
    const s = await scenario();
    commit(s, 'a.txt', 'a\n');
    await publish.publish(user, s.project(), { manual: true });
    // Someone else pushes to the remote.
    const other = path.join(T, `${s.id}-someone`);
    execFileSync('git', ['clone', '-q', s.remote, other]);
    fs.writeFileSync(path.join(other, 'x.txt'), 'x\n');
    sh(other, 'add', '-A');
    sh(other, 'commit', '-q', '-m', 'outside change');
    sh(other, 'push', '-q', 'origin', 'HEAD:main');
    commit(s, 'b.txt', 'b\n');
    await refused(s, /not a commit of this project/);
  });

  it('a main whose history was rewritten: never a forced push', async () => {
    const s = await scenario();
    commit(s, 'a.txt', 'a\n');
    await publish.publish(user, s.project(), { manual: true });
    const published = remoteMain(s);
    sh(s.work, 'reset', '-q', '--hard', 'HEAD~1');
    commit(s, 'c.txt', 'c\n');
    await refused(s, /would rewrite history/);
    expect(remoteMain(s)).toBe(published);
  });

  it('everything, when the secret scanner is missing', async () => {
    const s = await scenario();
    commit(s, 'a.txt', 'a\n');
    process.env.GITLEAKS_BIN = path.join(T, 'no-such-scanner');
    try {
      await refused(s, /secret scanner \(gitleaks\) is not installed/, { toldLead: false });
    } finally {
      process.env.GITLEAKS_BIN = SCANNER;
    }
  });
});

describe("the lead's request", () => {
  it('is acted on once, after the cycle', async () => {
    const s = await scenario();
    const main = commit(s, 'a.txt', 'a\n');
    expect(publish.maybePublish(s.project())).toBeNull(); // nobody asked
    ask(s, '2026-01-01T10:00:00Z', 'First playable build.');
    const out = await publish.maybePublish(s.project());
    expect(out).toMatchObject({ outcome: 'published', sha: main });
    expect(publish.history(s.project())[0]).toMatchObject({ by: 'request', summary: 'First playable build.' });
    expect(publish.maybePublish(s.project())).toBeNull(); // the same note is not acted on twice
    commit(s, 'b.txt', 'b\n');
    expect(publish.maybePublish(s.project())).toBeNull(); // new work, but no new request
    ask(s, '2026-01-02T10:00:00Z');
    // A new attempt is throttled; clear the stamp, as a minute's wait would.
    fs.writeFileSync(path.join(process.env.CONSOLE_DATA_DIR, 'publish', s.id, 'state.json'), JSON.stringify({ ...publish._test.readState(s.id), attemptAt: 0 }));
    expect((await publish.maybePublish(s.project())).outcome).toBe('published');
  });

  it('a withdrawn, malformed or oversized note asks for nothing', async () => {
    const s = await scenario();
    commit(s, 'a.txt', 'a\n');
    for (const text of [
      'Publish: no\nDate: 2026-01-01T10:00:00Z\n---\nnot yet\n',
      'Publish: yes\nDate: tomorrow\n---\nx\n',
      'Publish: yes please\nDate: 2026-01-01T10:00:00Z\n---\nx\n',
      'Publish: yes\nDate: 2026-01-01T10:00:00Z\n', // no separator
      `${'x'.repeat(9000)}\nPublish: yes\nDate: 2026-01-01T10:00:00Z\n---\nx\n`
    ]) {
      request(s, text);
      expect(publish.maybePublish(s.project()), text.slice(0, 30)).toBeNull();
    }
    expect(remoteMain(s)).toBe('');
    expect(publish.readRequest(s.project())).toBeNull();
    request(s, `Publish: yes\nDate: 2026-01-01T10:00:00Z\n---\n${'long '.repeat(3000)}`);
    expect(publish.readRequest(s.project()).summary.length).toBeLessThanOrEqual(4000);
  });

  it('a note that is a link is not read', async () => {
    const s = await scenario();
    const dir = path.join(process.env.CONSOLE_DATA_DIR, 'publish', s.id, 'out');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.join(T, 'config', 'claude-token'), path.join(dir, 'request.md'));
    expect(publish.readRequest(s.project())).toBeNull();
  });

  it('a refused request is not retried at once', async () => {
    const s = await scenario();
    commit(s, 'config.py', 'KEY = "FAKESECRET-raw"\n');
    ask(s, '2026-01-01T10:00:00Z');
    expect((await publish.maybePublish(s.project())).outcome).toBe('blocked');
    expect(publish.maybePublish(s.project())).toBeNull();
  });
});

describe('hiding secrets in text', () => {
  it('hides a private key block and a password in an address', () => {
    expect(maskSecrets('a -----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY----- b')).toBe('a [private key hidden by the console] b');
    expect(maskSecrets('fatal: https://bob:hunter2@example.org/x.git not found')).toBe('fatal: https://bob:[hidden]@example.org/x.git not found');
    expect(maskSecrets('git@github.com:owner/repo.git and ssh://git@example.org:2222/x')).toBe('git@github.com:owner/repo.git and ssh://git@example.org:2222/x');
  });
});
