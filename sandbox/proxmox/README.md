# Agent sandbox

Isolated VMs where autonomous Claude Code agents run unattended, one VM per
project. Goal: an agent that goes rogue, gets prompt-injected or just makes a
destructive mistake cannot reach anything outside its own VM.

```
 internet
    ▲  (allow-listed domains only)
    │
 vmbr0 (your LAN) ─────────── agent-gw CT 110 (e.g. 192.168.1.110)
                                 │ squid :3128, no forwarding,
                                 │ sshd on LAN side only
 vmbr1 (isolated, no uplink, ────┘ eth1 10.66.0.1
        no host IP)
    ├── agent VM 300 (10.66.0.10)  no default route
    └── agent VM 301 (10.66.0.11)  ...
```

Isolation is by topology, not firewall rules: the PVE host has no address on
vmbr1 and does not forward, so the only thing an agent VM can talk to is the
gateway's squid (and other agent VMs on the same bridge).

## Build order

```bash
cd sandbox/proxmox
# Inventory: your Proxmox host as `pve`. Values: vars/agent-sandbox.yml.
X=""

ansible-playbook playbooks/agent-network.yml        --check --diff $X   # then without --check
ansible-playbook playbooks/create-agent-gateway.yml $X
ansible-playbook playbooks/create-agent-vm.yml -e agent_vm_name=oakhollow $X
```

`create-agent-vm.yml` waits for cloud-init, runs `agent-wall-check` inside
the VM as the `agent` user, and only snapshots `provisioned` if the wall holds.

## Files

| File | What |
|---|---|
| `vars/agent-sandbox.yml` | Subnet, IDs, **domain allow-list** |
| `playbooks/agent-network.yml` | Adds `vmbr1` to the host |
| `playbooks/create-agent-gateway.yml` | CT 110: squid + admin user; re-run to apply allow-list changes |
| `playbooks/create-agent-vm.yml` | One project VM, users: your admin user + `agent` (no sudo) |
| `playbooks/templates/cloudinit-agent-vendor.yaml.j2` | Proxy env, Node 22, Claude Code |
| `playbooks/templates/squid-agent-gw.conf.j2` | Proxy rules (denies private/tailnet ranges) |
| `playbooks/files/agent-wall-check.sh` | Proof from inside: what must fail, what must work |

## Operating

- Reach a VM: `ssh -J agent-gw <admin>@10.66.0.10` (ssh config snippets are printed by the playbooks).
- Denied requests: on agent-gw, `sudo grep DENIED /var/log/squid/access.log`. Add a domain to
  `agent_allowed_domains` deliberately, re-run the gateway playbook, re-run `agent-wall-check`.
- Rollback a VM: `qm rollback <vmid> provisioned`.
- Agents on the same bridge can see each other. Fine for one project; give a second
  project its own bridge (or PVE firewall) before running two at once.

## Known limits

- The VM boundary depends on KVM/QEMU: keep the Proxmox host patched.
- Squid allow-listed domains are also possible exfiltration channels; keep the list short.
- Remote Control through squid CONNECT is untested; `agent-wall-check` covers claude.ai reachability only.
