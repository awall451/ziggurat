# Getting started

This is a manual path. Read each script before running it; they assume you understand Proxmox and Ansible.

## 1. Sandbox network and gateway (once)

1. Edit `sandbox/proxmox/vars/agent-sandbox.yml`: your LAN gateway, Proxmox IP, a free LAN address for the gateway container, your admin user and public key. Keep the allow-list short.
2. Add your Proxmox host to an Ansible inventory as `pve`, then:

```bash
cd sandbox/proxmox
ansible-playbook playbooks/agent-network.yml --check --diff
ansible-playbook playbooks/agent-network.yml
ansible-playbook playbooks/create-agent-gateway.yml
```

The network playbook refuses to run if the host forwards packets; isolation depends on it.

## 2. One VM per project

```bash
ansible-playbook playbooks/create-agent-vm.yml -e agent_vm_name=my-game
```

It waits for cloud-init, runs `agent-wall-check` **inside** the VM as the agent user (it must fail to reach your LAN, the Proxmox host, the internet and non-allowed domains, and must reach the allowed ones) and takes a `provisioned` snapshot only if the wall holds.

## 3. The project inside the VM

1. Copy your repo to `/home/agent/<project>` (owned by `agent`). Install its dependencies and make its own checks pass first; the gate starts from green.
2. Start from an example and make it yours: the charter (goal, autonomy, boundaries), the gate contract, `gate-checks` (what "done" means), the team. Then render it for a theme:

```bash
tools/render-team.py examples/web-game --theme plain --out build/my-game
# edit build/my-game/project.env (PROJECT, WORKSPACE, BARE, BASELINE_TESTS ...)
```

3. Copy `kit/vm` and `build/my-game` into the VM and run `sudo bash vm/install.sh build/my-game`. It installs the kit, creates the `gatekeeper` and `gaterun` users and the canonical repo, and enables the gate timer. The lead's timer stays **off** and `control` says `stop`.
4. Log Claude in once as the agent user: `sudo -iu agent claude`. Turn off your account's paid overflow usage if you do not want headless runs to spend money.
5. Prove the gate: submit one deliberately broken branch and one that deletes tests (both must fail) and one good change (must merge).
6. Run one supervised cycle: `sudo agent-kit-resume --no-timer && sudo systemctl start agent-kit-lead.service`. Read the transcript, the ledger (`agent-kit-status`) and the gate verdicts (`gate-status`).
7. When you trust it: `sudo agent-kit-resume` (clears the stop and enables the lead's timer). Stop it at any time with `sudo agent-kit-halt [reason]`; for a time window use `sudo agent-kit-halt-at set <unix-seconds>`.

To update a VM that already runs the kit: halt the team, copy `kit/vm` in, `sudo bash vm/install.sh --upgrade`.

## 4. The console (recommended)

[`console/`](../console/README.md) is one web app for all your projects: the live hierarchy of each cycle, progress, usage, feedback to the lead with replies, and halt/resume. It runs on your workstation and reaches the VMs only by ssh as the caller.

- Follow [console/README.md](../console/README.md): a config folder with `projects.json`, a small ssh folder for the console, `docker compose up`.
- Keep it on a private network (VPN or a reverse proxy with a login). It has no login of its own.
- Optional: `workstation/agent-digest` once a day writes a short digest per project (and a spoken version) from the data the console pulled; it appears in the console's Digest tab. Copy `config.example.env` to `~/.config/ziggurat/config.env` first.
