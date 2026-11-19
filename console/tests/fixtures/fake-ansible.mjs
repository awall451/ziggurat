#!/usr/bin/env node
// Stand-in for ansible-playbook in the tests: writes the events a real run of
// create-agent-vm.yml would write, as told by the file named in $FAKE_MODE.
import fs from 'node:fs';

const argv = process.argv.slice(2);
const vars = JSON.parse(fs.readFileSync(argv[argv.indexOf('--extra-vars') + 1].slice(1), 'utf8'));
const check = argv.includes('--check');
const mode = fs.readFileSync(process.env.FAKE_MODE, 'utf8').trim();
const out = process.env.ZIGGURAT_EVENTS_PATH;
const emit = (e) => fs.appendFileSync(out, JSON.stringify({ ...e, ts: Date.now() }) + '\n');
const ok = (task) => emit({ type: 'task_ok', task, host: 'pve', changed: false });
// The install playbook: what a run of install-team.yml would report.
if (argv[0].includes('install-team')) {
  const mode = fs.existsSync(process.env.FAKE_INSTALL_MODE) ? fs.readFileSync(process.env.FAKE_INSTALL_MODE, 'utf8').trim() : 'ok';
  const token = vars.claude_token_file ? fs.readFileSync(vars.claude_token_file, 'utf8').trim() : '';
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ install: true, project: vars.project_id, payload: fs.existsSync(vars.payload_archive), tokenFile: vars.claude_token_file, files: vars.provision_files_dir, rsh: vars.rsync_rsh }) + '\n');
  emit({ type: 'play_start', play: 'Agent kit and team' });
  if (mode === 'refused') {
    emit({ type: 'task_failed', task: 'Nothing may be installed yet', host: 'agent_vm', msg: 'A kit, an earlier install attempt or the project folder is already on this VM.' });
    process.exit(2);
  }
  ok('Milestone - install started');
  if (mode === 'fail-provision') {
    emit({ type: 'task_failed', task: 'Provisioning must have succeeded', host: 'agent_vm', msg: 'provision.sh failed (exit 1). Last lines:\nboom' });
    emit({ type: 'result', data: { stage: 'install-started', project: vars.project_id } });
    process.exit(2);
  }
  ok('Milestone - provisioning done');
  ok('Milestone - kit installed');
  if (token) emit({ type: 'task_ok', task: 'Store the Claude subscription token', host: 'agent_vm', changed: true, censored: true });
  emit({ type: 'result', data: { stage: 'installed', kit_version: '0.3.0', baseline_tests: '2', main: 'abc1234', logged_in: !!token, auth_method: token ? 'oauth_token' : 'none', token_stored: !!token, api_key_set: false } });
  process.exit(0);
}
const vmid = vars.agent_vm_vmid;
const ip = `${vars.agent_subnet_prefix}.${vmid - vars.agent_vmid_min + 10}`;
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ check, vmid, mustBeNew: vars.agent_vm_must_be_new, name: vars.agent_vm_name, pubkey: fs.readFileSync(vars.ssh_pubkey_local_path, 'utf8').trim() }) + '\n');

emit({ type: 'play_start', play: 'Agent sandbox VM' });
ok('Name is required');
if (mode === 'hang') await new Promise((r) => setTimeout(r, 60000));
if (mode === 'unreachable') {
  emit({ type: 'task_failed', task: 'vmbr1 must exist', host: 'pve', unreachable: true, msg: 'Failed to connect to the host via ssh' });
  process.exit(4);
}
if (check) {
  if (mode === 'plan-exists') emit({ type: 'result', data: { stage: 'planned', vmid, name: vars.agent_vm_name, ip, existed: true, peers: '', host_key: '', snapshot: '' } });
  else emit({ type: 'result', data: { stage: 'planned', vmid, name: vars.agent_vm_name, ip, existed: false, peers: '10.66.0.11 10.66.0.12', host_key: '', snapshot: '' } });
  process.exit(0);
}
const fail = (task, msg, stage) => {
  emit({ type: 'task_failed', task, host: 'pve', msg });
  if (stage) emit({ type: 'result', data: { stage, vmid, name: vars.agent_vm_name, ip } });
  process.exit(2);
};
if (mode === 'fail-clone') fail('Clone template, size it, wire it to the isolated bridge', 'storage is full', null);
ok('Clone template, size it, wire it to the isolated bridge');
ok('Milestone - the VM exists');
// From here on the host has this VM.
fs.appendFileSync(process.env.FAKE_GUESTS, JSON.stringify({ vmid, name: vars.agent_vm_name, status: 'running', kind: 'vm' }) + '\n');
if (mode === 'fail-cloud-init') fail('Wait for cloud-init to finish', 'timed out', 'cloned');
if (mode === 'cut-off') process.kill(process.pid, 'SIGKILL');
ok('Milestone - cloud-init finished');
if (mode === 'fail-wall') fail('Wall must hold', 'WALL CHECK FAILED - do not start agents.', 'provisioned');
ok('Milestone - the wall holds');
emit({ type: 'result', data: { stage: 'done', vmid, name: vars.agent_vm_name, ip, existed: false, peers: '', host_key: mode === 'bad-key' ? 'not a key' : 'ssh-ed25519 ' + 'C'.repeat(68), snapshot: 'provisioned' } });
