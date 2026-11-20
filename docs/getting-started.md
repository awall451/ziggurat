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

Two ways. The console (section 4) does all of this from one form. By hand, either run the playbook:

```bash
tools/render-team.py examples/python-starter --theme plain --out build/my-tool
# edit build/my-tool/CHARTER.md (the goal) and build/my-tool/project.env (PROJECT, WORKSPACE, BARE, ...)
mkdir pay && cp -r kit/vm pay/kit && cp -r build/my-tool pay/bundle && cp -r examples/python-starter/seed pay/seed
tar -czf my-tool.tar.gz -C pay kit bundle seed
ansible-playbook -i <inventory with the VM as agent_vm> sandbox/install/install-team.yml \
  -e project_id=my-tool -e payload_archive=$PWD/my-tool.tar.gz -e agent_proxy_url=http://10.66.0.1:3128
```

It refuses a VM that already has a kit, puts the seed in `/home/agent/<project>` as a fresh repository, runs the
bundle's `provision.sh` if there is one, runs the installer and checks that the team is installed and stopped.
Or do the same steps yourself:

1. Copy your repo to `/home/agent/<project>` (owned by `agent`). Install its dependencies and make its own checks pass first; the gate starts from green.
2. Start from an example and make it yours: the charter (goal, autonomy, boundaries), the gate contract, `gate-checks` (what "done" means), the team. Then render it for a theme:

```bash
tools/render-team.py examples/web-game --theme plain --out build/my-game
# edit build/my-game/project.env (PROJECT, WORKSPACE, BARE, BASELINE_TESTS ...)
```

3. Copy `kit/vm` and `build/my-game` into the VM and run `sudo bash vm/install.sh build/my-game`. It installs the kit, creates the `gatekeeper` and `gaterun` users and the canonical repo, and enables the gate timer. The lead's timer stays **off** and `control` says `stop`.
4. Sign Claude in for the agent user, on your subscription. Either log in once: `sudo -iu agent claude`. Or store a long-lived token from `claude setup-token` (run that on your own machine): `sudo agent-kit-auth set-token < token-file`. `sudo agent-kit-auth status` tells which one is in use. Turn off your account's paid overflow usage if you do not want headless runs to spend money.

   The trade-off: a login is per VM and renews itself, but needs you at a terminal for every new VM. A token needs no terminal, so a VM can be set up unattended, but it is one secret for every VM you give it to, it lasts a year, it sits in the agents' environment (an agent that prints its environment writes it into its transcript), and there is no documented way to revoke a single token.
5. Prove the gate: `sudo agent-kit-gate-proof run` submits one good change (must merge) and one that deletes the test file named by `GATE_PROOF_DELETE` in `project.env` (must fail), while the team stays halted. Then submit one deliberately broken branch yourself (must fail): what "broken" means is specific to your project.
6. Run one supervised cycle: `sudo agent-kit-resume --no-timer && sudo systemctl start agent-kit-lead.service`. Read the transcript, the ledger (`agent-kit-status`) and the gate verdicts (`gate-status`).
7. When you trust it: `sudo agent-kit-resume` (clears the stop and enables the lead's timer). Stop it at any time with `sudo agent-kit-halt [reason]`; for a time window use `sudo agent-kit-halt-at set <unix-seconds>`.

To update a VM that already runs the kit: copy `kit/vm` in, `sudo bash vm/install.sh --upgrade`. A cycle that is running is not interrupted and finishes with the kit it started with. To stop a team without cutting its cycle short: `sudo agent-kit-halt-after set [--wrap-up]`.

## 4. The console (recommended)

[`console/`](../console/README.md) is one web app for all your projects: the live hierarchy of each cycle, progress, usage, feedback to the lead with replies, and halt/resume. It runs on your workstation and reaches the VMs only by ssh as the caller.

- Follow [console/README.md](../console/README.md): a config folder with `projects.json`, a small ssh folder for the console, `docker compose up`.
- Keep it on a private network (VPN or a reverse proxy with a login). It has no login of its own.
- Optional: `workstation/agent-brief` writes a short brief for every cycle that has finished (and a spoken version) from the data the console pulled; it appears in the console's Briefs tab, one per cycle. Copy `config.example.env` to `~/.config/ziggurat/config.env` first, then run it every few minutes, for example with a systemd user timer:

  ```ini
  # ~/.config/systemd/user/agent-brief.service
  [Service]
  Type=oneshot
  ExecStart=/path/to/ziggurat/workstation/agent-brief
  # ~/.config/systemd/user/agent-brief.timer
  [Timer]
  OnBootSec=5min
  OnUnitActiveSec=10min
  [Install]
  WantedBy=timers.target
  ```

  It only writes briefs that do not exist yet, about 20 minutes after a cycle ends (once the gate has judged its work).
