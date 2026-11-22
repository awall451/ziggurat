import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-pk-'));
process.env.CONSOLE_DATA_DIR = path.join(root, 'data');
process.env.CONSOLE_CONFIG_DIR = path.join(root, 'config');
process.env.CONSOLE_DEPLOY = '1';

// The VM, the Proxmox host and the gateway are stand-ins.
const vm = { status: '', calls: [], host: [], allowed: ['.anthropic.com', 'registry.npmjs.org'], hostCode: 0, tars: [], failed: [], filesCode: 0, kitVersion: null };
vi.mock('../src/lib/server/ssh.js', async (original) => ({
  ...(await original()),
  kit: async (project, script, argv, opts = {}) => {
    vm.calls.push([script, ...argv]);
    if (argv[0] === 'status') return { code: 0, stdout: vm.status, stderr: '' };
    if (argv[0] === 'files') {
      // The archive the console sends: kept, to look inside.
      const chunks = [];
      for await (const c of opts.inputStream) chunks.push(c);
      vm.tars.push({ project: project.id, rid: argv[1], tar: Buffer.concat(chunks) });
      return { code: vm.filesCode, stdout: '', stderr: vm.filesCode ? 'agent-kit-packages: a file does not match its checksum' : '' };
    }
    if (argv[0] === 'fetch-failed') vm.failed.push({ rid: argv[1], reason: opts.input });
    return { code: 0, stdout: `${argv[0]}d ${argv[1]}\n`, stderr: '' };
  },
  pull: async () => ({ code: 0 }),
  hostScript: async (spec, script) => {
    vm.host.push(script);
    return { code: vm.hostCode, stdout: '', stderr: vm.hostCode ? 'agent-allow: squid refused the list' : '' };
  }
}));
vi.mock('../src/lib/server/pve.js', async (original) => ({
  ...(await original()),
  inspect: async () => ({ allowed: vm.allowed, allowedExtra: ['go.dev'] }),
  forgetInspect: () => {}
}));
vi.mock('../src/lib/server/live.js', async (original) => ({
  ...(await original()),
  peekStatus: () => (vm.kitVersion ? { kitVersion: vm.kitVersion } : null)
}));

const pk = await import('../src/lib/server/packages.js');
const gw = await import('../src/lib/server/gateway.js');
const config = await import('../src/lib/server/config.js');

const KEY = 'ssh-ed25519 ' + 'A'.repeat(68);
const target = {
  id: 'homelab', pveHost: '192.0.2.10', pveHostKey: KEY, bridge: 'vmbr1', subnetPrefix: '10.66.0', gatewayVmid: 110, gatewayLanIp: '192.0.2.20',
  lanGateway: '192.0.2.1', templateVmid: 9000, vmidMin: 300, vmidMax: 399, storage: 'local-lvm', adminUser: 'admin', criticalVmids: []
};
const project = { id: 'revview', target: 'homelab', kit: { state: '/var/lib/agent-kit' }, ssh: { host: '10.66.0.12', user: 'admin' } };
const user = { name: 'owner' };
const R1 = '20261121T100000Z-k-aaaaaa';
const R2 = '20261121T100100Z-k-bbbbbb';
const R3 = '20261121T100200Z-k-cccccc';
const line = (o) => JSON.stringify({ decision: null, decidedAt: null, result: null, resultAt: null, ...o });

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  config.saveTarget(target);
  const out = path.join(root, 'data', 'packages', 'revview', 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${R1}.md`), 'Request: recipe:go@1.23.4\nDate: x\n---\nScreenshots from the emulator.\n');
  fs.writeFileSync(path.join(out, `${R2}.md`), 'Request: apt:something-else\n---\nThe file was changed after the status was read.\n');
});

describe('the gateway helper', () => {
  it('builds its script only from domain names', () => {
    expect(gw.allowScript(target, ['PyPI.org', '.pythonhosted.org'])).toBe(
      'set -e\npct exec 110 -- /usr/local/sbin/agent-allow add pypi.org\npct exec 110 -- /usr/local/sbin/agent-allow add .pythonhosted.org'
    );
    for (const bad of [['pypi.org; reboot'], ['-x'], ['localhost'], [], Array.from({ length: 11 }, (_, i) => `d${i}.org`)]) expect(() => gw.allowScript(target, bad)).toThrow();
    expect(() => gw.allowScript({}, ['pypi.org'])).toThrow(/gateway/);
  });
});

describe('requests', () => {
  it('reads what a request is and which domains it needs', () => {
    expect(pk.describe('apt:libsdl2-dev')).toMatchObject({ kind: 'apt', name: 'libsdl2-dev', domains: [] });
    // Playwright's browsers are fetched by the console: the proxy is asked for npm only.
    expect(pk.describe('recipe:playwright-browsers@1.49.1')).toMatchObject({
      kind: 'recipe',
      name: 'playwright-browsers',
      version: '1.49.1',
      domains: ['registry.npmjs.org'],
      fetch: [
        { host: 'cdn.playwright.dev', prefix: '/' },
        { host: 'playwright.download.prss.microsoft.com', prefix: '/' },
        { host: 'storage.googleapis.com', prefix: '/chrome-for-testing-public/' }
      ]
    });
    expect(pk.describe('recipe:go@1.23.4').fetch).toEqual([]);
    expect(pk.describe('recipe:go@1.23.4').domains).toContain('dl.google.com');
    expect(pk.describe('domain:pypi.org')).toMatchObject({ kind: 'domain', domains: ['pypi.org'] });
    for (const bad of ['recipe:nope', 'apt:Bad;id', 'domain:-x', 'pip:requests']) expect(pk.describe(bad)).toBeNull();
  });

  it('merges the VM\'s status with the lead\'s reasons and the gateway\'s list', async () => {
    vm.status = [
      line({ rid: R1, request: 'recipe:go@1.23.4' }),
      line({ rid: R2, request: 'apt:libsdl2-dev', decision: 'approved', decidedAt: 'x', result: 'ok', resultAt: 'y' }),
      line({ rid: R3, request: 'pip:requests' }),
      'garbage'
    ].join('\n');
    const out = await pk.requests(project);
    expect(out.gateway).toBe('checked');
    expect(out.requests.map((r) => [r.rid, r.state])).toEqual([[R2, 'installed'], [R1, 'waiting']]);
    const r1 = out.requests.find((r) => r.rid === R1);
    expect(r1.reason).toBe('Screenshots from the emulator.');
    expect(r1.missing).toEqual(['go.dev', 'dl.google.com', 'proxy.golang.org', 'sum.golang.org']);
    expect(out.extra).toEqual(['go.dev']);
    // A reason for another request than the one the VM reports is not shown.
    expect(out.requests.find((r) => r.rid === R2).reason).toBeNull();
  });
});

describe('deciding', () => {
  it('approving adds the missing domains on the gateway first, then tells the VM', async () => {
    vm.calls = [];
    vm.host = [];
    const out = await pk.decideRequest(user, project, R1, 'approve');
    expect(out.added).toEqual(['go.dev', 'dl.google.com', 'proxy.golang.org', 'sum.golang.org']);
    expect(vm.host[0]).toContain('agent-allow add dl.google.com');
    expect(vm.calls.at(-1)).toEqual(['agent-kit-packages', 'approve', R1]);
  });

  it('does not approve when the gateway refuses the domains', async () => {
    vm.calls = [];
    vm.hostCode = 1;
    await expect(pk.decideRequest(user, project, R1, 'approve')).rejects.toThrow(/did not add/);
    expect(vm.calls.some((c) => c[1] === 'approve')).toBe(false);
    vm.hostCode = 0;
  });

  it('a project without a target cannot get domains added, but can decline', async () => {
    await expect(pk.decideRequest(user, { ...project, target: undefined }, R1, 'approve')).rejects.toThrow(/no deploy target/);
    vm.calls = [];
    await pk.decideRequest(user, { ...project, target: undefined }, R1, 'deny');
    expect(vm.calls.at(-1)).toEqual(['agent-kit-packages', 'deny', R1]);
  });

  it('refuses odd ids and decisions', async () => {
    await expect(pk.decideRequest(user, project, '../x', 'approve')).rejects.toThrow(/Bad request id/);
    await expect(pk.decideRequest(user, project, R1, 'install')).rejects.toThrow(/Bad decision/);
  });
});

describe('files the console fetches for a recipe (kit 0.17)', () => {
  const PW = 'recipe:playwright-browsers@1.65.1';
  const CDN = 'https://cdn.playwright.dev/builds/cft/159.0/linux64/chrome-linux64.zip';
  const BUCKET = 'https://storage.googleapis.com/chrome-for-testing-public/159.0/linux64/chrome-linux64.zip';
  const FF = 'https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1013/ffmpeg-linux.zip';
  const needs = [
    { url: CDN, name: 'builds/cft/159.0/linux64/chrome-linux64.zip' },
    { url: FF, name: 'builds/ffmpeg/1013/ffmpeg-linux.zip' }
  ];
  const req = (rid, n = needs) => ({ rid, request: PW, needs: n, result: 'fetching', ready: false });
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  let asked = [];
  // The outside world: Playwright's CDN sends Chromium on to Google's public bucket.
  const web = (routes) =>
    pk._test.setFetch(async (url, opts) => {
      asked.push(url);
      expect(opts.redirect).toBe('manual');
      const r = routes[url];
      if (!r) return new Response('no', { status: 404 });
      if (r.to) return new Response(null, { status: 307, headers: { location: r.to } });
      return new Response(r.body, { status: 200, headers: r.length ? { 'content-length': String(r.length) } : {} });
    });
  const reset = () => {
    asked = [];
    vm.tars = [];
    vm.failed = [];
    vm.calls = [];
    vm.filesCode = 0;
  };
  const unpack = (tar) => {
    const dir = fs.mkdtempSync(path.join(root, 'tar-'));
    execFileSync('tar', ['-x', '-C', dir], { input: tar });
    return dir;
  };
  const list = pk.describe(PW).fetch;

  it('only fetches from the places a recipe names', () => {
    for (const ok of [CDN, BUCKET, 'https://playwright.download.prss.microsoft.com/x/y.zip']) expect(pk.fetchAllowed(list, ok)).toBe(true);
    for (const bad of [
      'https://storage.googleapis.com/some-other-bucket/upload', // any bucket takes uploads: only Chrome's public one
      'https://storage.googleapis.com/chrome-for-testing-public/../some-other-bucket/x',
      'https://storage.googleapis.com/chrome-for-testing-public/%2e%2e/some-other-bucket/x',
      'https://storage.googleapis.com/chrome-for-testing-public',
      'http://cdn.playwright.dev/builds/x.zip',
      'https://cdn.playwright.dev:8443/builds/x.zip',
      'https://user:pw@cdn.playwright.dev/builds/x.zip',
      'https://cdn.playwright.dev/builds/x.zip?token=abc',
      'https://cdn.playwright.dev.evil.example/builds/x.zip',
      'https://evil.example/cdn.playwright.dev/x.zip',
      'https://192.0.2.10/builds/x.zip',
      'https://localhost/x',
      'file:///etc/passwd',
      'not an address'
    ])
      expect(pk.fetchAllowed(list, bad), bad).toBe(false);
    expect(pk.fetchAllowed([], CDN)).toBe(false);
  });

  it('reads what a fetching request waits for, and why a failed one failed, as data', () => {
    const out = pk.parseStatus(
      [
        line({ rid: R1, request: PW, decision: 'approved', result: 'fetching', ready: false, needs: [...needs, { url: 'https://cdn.playwright.dev/x y', name: 'x' }, { url: CDN, name: '../../etc/cron.d/x' }, 'junk'] }),
        line({ rid: R2, request: PW, decision: 'approved', result: 'failed', log: 'npm ERR! token sk-ant-oat01-' + 'a'.repeat(30) + ' E404', needs: needs })
      ].join('\n')
    );
    expect(out[0].needs).toEqual(needs);
    expect(out[1].needs).toEqual([]);
    expect(out[1].log).toMatch(/npm ERR!/);
    expect(out[1].log).not.toContain('sk-ant-oat01-aaaa');
  });

  it('downloads through the allowed redirect, and hands the VM the files with their checksums', async () => {
    reset();
    web({ [CDN]: { to: BUCKET }, [BUCKET]: { body: 'CHROME' }, [FF]: { body: 'FFMPEG' } });
    const out = await pk.fetchFiles(project, req(R1));
    expect(out).toMatchObject({ ok: true, files: 2, fetched: 2 });
    expect(asked).toEqual([CDN, BUCKET, FF]);
    expect(vm.calls.at(-1)).toEqual(['agent-kit-packages', 'files', R1]);
    const dir = unpack(vm.tars[0].tar);
    expect(fs.readFileSync(path.join(dir, 'builds/cft/159.0/linux64/chrome-linux64.zip'), 'utf8')).toBe('CHROME');
    expect(fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8')).toBe(`${sha('CHROME')}  builds/cft/159.0/linux64/chrome-linux64.zip\n${sha('FFMPEG')}  builds/ffmpeg/1013/ffmpeg-linux.zip\n`);
    // Plain files in the archive: the VM refuses links.
    expect(execFileSync('tar', ['-tv'], { input: vm.tars[0].tar, encoding: 'utf8' })).not.toMatch(/^[hl]/m);
    expect(vm.failed).toEqual([]);
    // Nothing of the staging is left in the cache folder.
    expect(fs.readdirSync(pk._test.cacheDir()).filter((n) => n.startsWith('.stage'))).toEqual([]);
  });

  it('a second VM on the same version gets the files from the cache', async () => {
    reset();
    web({});
    const out = await pk.fetchFiles({ ...project, id: 'othervm' }, req(R2));
    expect(out).toMatchObject({ ok: true, files: 2, fetched: 0 });
    expect(asked).toEqual([]);
    expect(vm.tars[0]).toMatchObject({ project: 'othervm', rid: R2 });
  });

  it('refuses a redirect to another bucket, and tells the VM why', async () => {
    reset();
    const url = 'https://cdn.playwright.dev/builds/cft/160.0/linux64/chrome-linux64.zip';
    web({ [url]: { to: 'https://storage.googleapis.com/someone-elses-bucket/chrome.zip' } });
    const out = await pk.fetchFiles(project, req(R1, [{ url, name: 'chrome.zip' }]));
    expect(out.ok).toBe(false);
    expect(asked).toEqual([url]);
    expect(vm.tars).toEqual([]);
    expect(vm.failed[0]).toMatchObject({ rid: R1 });
    expect(vm.failed[0].reason).toMatch(/leads to storage\.googleapis\.com, which is not on the recipe's list/);
  });

  it('refuses an address the recipe may not name: the list comes from inside the sandbox', async () => {
    for (const url of ['https://192.0.2.10/api2/json/nodes', 'https://storage.googleapis.com/agents-bucket/' + 'c2VjcmV0'.repeat(4)]) {
      reset();
      web({ [url]: { body: 'x' } });
      const out = await pk.fetchFiles(project, req(R1, [{ url, name: 'x.zip' }]));
      expect(out.ok).toBe(false);
      // Not one request left the console.
      expect(asked).toEqual([]);
      expect(vm.failed[0].reason).toMatch(/not on the recipe's list/);
    }
  });

  it('refuses a file that is too large, a missing file, and a recipe without a list', async () => {
    reset();
    const big = 'https://cdn.playwright.dev/builds/big.zip';
    web({ [big]: { body: 'x', length: 700 * 1024 * 1024 } });
    expect((await pk.fetchFiles(project, req(R1, [{ url: big, name: 'big.zip' }]))).error).toMatch(/700 MB, more than the console fetches/);
    web({});
    expect((await pk.fetchFiles(project, req(R1, [{ url: 'https://cdn.playwright.dev/builds/gone.zip', name: 'gone.zip' }]))).error).toMatch(/answered 404/);
    expect((await pk.fetchFiles(project, { ...req(R1), request: 'recipe:go@1.23.4' })).error).toMatch(/no list of places/);
    expect(vm.tars).toEqual([]);
    expect(vm.failed).toHaveLength(3);
  });

  it('a VM that refuses the archive leaves the request fetching, for the next look', async () => {
    reset();
    web({});
    vm.filesCode = 2;
    const out = await pk.fetchFiles(project, req(R1));
    expect(out).toMatchObject({ ok: false });
    expect(out.error).toMatch(/does not match its checksum/);
    expect(vm.failed).toEqual([]);
  });

  it('looks for fetching requests of a project and brings each its files', async () => {
    reset();
    web({});
    vm.status = [line({ rid: R1, request: PW, decision: 'approved', result: 'fetching', needs }), line({ rid: R2, request: PW, decision: 'approved', result: 'fetching', ready: true, needs })].join('\n');
    const out = await pk.maybeFetch(project, { force: true });
    expect(out.map((o) => [o.rid, o.ok])).toEqual([[R1, true]]);
    // Not again within the minute.
    expect(await pk.maybeFetch(project)).toEqual([]);
    pk._test.setFetch(null);
  });

  it('does not approve such a recipe for a VM whose kit cannot take the files', async () => {
    vm.status = line({ rid: R3, request: PW });
    vm.kitVersion = '0.16.0';
    await expect(pk.decideRequest(user, project, R3, 'approve')).rejects.toThrow(/needs kit 0\.17\.0 on the VM \(it runs 0\.16\.0\)/);
    vm.kitVersion = '0.17.0';
    vm.calls = [];
    const out = await pk.decideRequest(user, project, R3, 'approve');
    expect(out).toMatchObject({ ok: true, added: [], request: PW });
    expect(vm.calls.at(-1)).toEqual(['agent-kit-packages', 'approve', R3]);
    vm.kitVersion = null;
  });

  it('tries a failed request again, and takes a domain back off the gateway', async () => {
    vm.calls = [];
    vm.host = [];
    await pk.retryRequest(user, project, R1);
    expect(vm.calls.at(-1)).toEqual(['agent-kit-packages', 'retry', R1]);
    await expect(pk.retryRequest(user, project, 'x; id')).rejects.toThrow(/Bad request id/);
    expect(gw.removeScript(target, ['Go.dev'])).toBe('set -e\npct exec 110 -- /usr/local/sbin/agent-allow remove go.dev');
    expect(() => gw.removeScript(target, ['go.dev; reboot'])).toThrow();
    expect(await pk.removeDomain(user, project, 'go.dev')).toMatchObject({ removed: 'go.dev' });
    expect(vm.host.at(-1)).toContain('agent-allow remove go.dev');
    await expect(pk.removeDomain(user, { ...project, target: undefined }, 'go.dev')).rejects.toThrow(/no deploy target/);
    expect(await pk.extraDomains(project)).toEqual(['go.dev']);
  });
});
