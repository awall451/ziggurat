# Ziggurat Console

One web app for all your agent teams: see the projects, watch the working hierarchy of a cycle, send
feedback to a team's lead, follow progress, and halt or resume a team.

It runs on your workstation (or any machine that can ssh to the sandbox gateway) and reaches the sandbox
VMs **only as the caller**, over ssh and rsync. Nothing on a VM can reach the console.

## What it shows

| Page | What |
|---|---|
| Projects | A card per project: state, current or last cycle, gate main, tests, 24 h estimate, merged/failed, what waits on you |
| Topology | The lead, area leads and builders/scouts of a cycle as a stepped tree. Click an agent for its model, context size, the brief it was given, tools used, branch and final report. Live while a cycle runs; any past cycle can be picked |
| Progress | Cycles, cost estimates, tests on main over time, gate verdicts |
| Inbox | Messages to the lead in three tiers, with attachments; the lead's replies; questions the lead asks you |
| Notes | The lead's plan (`STATE.md`), journal, QA issues, other docs on main |
| Gallery | Screenshots the gate took of the newest passing build, by day |
| Digest | The morning digest and its spoken version (written by `workstation/agent-digest`) |
| Usage | Tokens and cost estimates by model, role and cycle, computed from the transcripts |
| Controls | Halt, resume, stop at a set time, cycle cap, budget, models, gate pause, audit log |

## How it gets its data

- **Live state**: one read-only ssh round trip per project, cached for ten seconds.
- **Pulls**: every 15 minutes the console copies each VM's ledger, gate history, notes, screenshots and
  transcripts into your data folders (rsync, never `--delete`, never following links, agent-owned trees read
  as the agent user). While you look at a running project it pulls the files of the cycle in progress every
  15 seconds.
- **Changes**: every change on a VM is one fixed, root-owned kit script with checked arguments
  (`sudo /opt/agent-kit/bin/<script> ...`). The console never sends free-form commands for a change, and it
  writes every change to an audit log.

The topology is read from Claude Code's transcripts. That format is internal to Claude Code and can change
between versions; the parser skips what it does not understand, and the Claude Code version of each cycle is
shown under the graph.

## Feedback to the lead

| Tier | Delivery | What the lead is told |
|---|---|---|
| note | Read at the start of the next cycle | Weigh it in planning. No change of schedule |
| priority | Also delivered mid-cycle, once | Finish what is running, then plan it into this cycle or the next |
| urgent | Delivered at once | Handle it before new work. Working agents get a fixed notice (never the message text) to wrap up and report back, so the lead sees it sooner |

A message lands in a root-owned inbox on the VM, which the agents cannot write to: that location is what makes
it genuine. The lead answers each message `done`, `planned` or `declined`, and can ask you a question with the
default it will take if you do not answer. See [docs/architecture.md](../docs/architecture.md).

Needs kit 0.2 or later on the VM (`sudo bash install.sh --upgrade`).

## Run it

```bash
# 1. Config and data live outside the repository
mkdir -p /srv/ziggurat/{config,console-data,fleet,transcripts,ssh}
cp console/config.example/*.json /srv/ziggurat/config/     # then edit projects.json
cp console/compose.env.example /srv/ziggurat/compose.env    # then edit

# 2. An ssh folder for the console only: a `config` with a Host entry for the gateway and for each VM
#    (ProxyJump through the gateway, `IdentityFile /run/console/ssh_key`), and a `known_hosts` for them.

# 3. Start
docker compose -f console/docker-compose.yml --env-file /srv/ziggurat/compose.env up -d --build
```

It listens on `127.0.0.1:8440`. Put it behind your VPN or a reverse proxy; do not expose it to the internet.

`projects.json` (one entry per project):

| Field | Meaning |
|---|---|
| `id`, `name`, `description` | `id` is also the default workspace and repo name on the VM |
| `theme` | A file from `themes/`; sets the role names shown (`Ainu · engine`, `Chief Officer · desk`) |
| `accent` | The project's colour |
| `hidden` | Hide the card unless "Show hidden" is ticked |
| `pull` | `false` to stop the background pull (a VM that is switched off) |
| `ssh.alias` | Host name in the console's ssh config |
| `ssh.host`, `ssh.user`, `ssh.jump` | Instead of an alias: address, login and `[user@]host` to jump through |
| `kit.*` | Only if the VM differs from the defaults (`state`, `workspace`, `bare`, `leadUnit`, `agentHome`) |
| `paths.transcripts`, `paths.fleet` | Where pulled data for this project is kept |
| `agentAliases` | Maps older agent ids to the official ones, so old cycles get the right names |

`pricing.json` holds the price table used for the estimates (USD per million tokens, first matching model
wins). Estimates are API-equivalent figures, not a bill.

### Settings page and JSON API

**Settings** (top right) edits `projects.json` and `targets.json`: a form per entry, the whole entry as
JSON, and "Remove entry". Removing an entry only takes it out of the list; the console never deletes a VM or
pulled data. Every entry is checked field by field before it is saved, and every change is in the audit log.

The same through the API (JSON bodies, `Content-Type: application/json`):

| | |
|---|---|
| `GET /api/projects`, `POST /api/projects` | list, add |
| `GET`, `PUT`, `DELETE /api/projects/<id>` | read, replace, remove one entry |
| `GET /api/targets`, `POST /api/targets` | list, add (needs `CONSOLE_DEPLOY=1`) |
| `GET`, `PUT`, `DELETE /api/targets/<id>` | read, replace, remove one entry |
| `POST /api/targets/<id>/check` | read-only look at the target's Proxmox host |

Requests that change something need an `Origin` header that matches the console's address (browsers add
it; with curl pass `-H "Origin: http://127.0.0.1:8440"`).

### Deploy targets (off by default)

A target is a Proxmox host where `sandbox/proxmox` has already set up the isolated bridge and the gateway.
Targets are the base for creating projects from the console. They are off unless `CONSOLE_DEPLOY=1` is set,
because using one means **the console's ssh key logs in to that Proxmox host as an administrator**. Until
you turn it on, the console only ever talks to the sandbox VMs.

`targets.json` (one entry per host; `console/config.example/targets.json`):

| Field | Meaning |
|---|---|
| `id`, `name` | |
| `pveHost`, `pveUser` | Address and login of the Proxmox host (`root` by default) |
| `bastion` | Optional `[user@]host` to jump through; its host key must be in the console's `known_hosts` |
| `pveHostKey` | The host's public key: `ssh-keyscan -t ed25519 <host>`, compare it with the host's own `/etc/ssh/ssh_host_ed25519_key.pub`, then paste type and key (no host name). The console never trusts a host on first contact |
| `pveLanIp`, `lanGateway` | Addresses a sandboxed VM must fail to reach (the host itself, your router) |
| `bridge`, `subnetPrefix` | The isolated bridge and the first three numbers of its subnet. The gateway is `.1`; a VM gets `.(vmid - vmidMin + 10)` |
| `gatewayVmid`, `gatewayLanIp`, `gatewayHostKey` | The gateway container; new VMs are reached through its LAN address |
| `adminUser` | The admin login created in new VMs |
| `templateVmid`, `vmidMin`, `vmidMax` | The cloud-init template and the id range for agent VMs |
| `criticalVmids` | Ids the console must never act on |
| `storage`, `snippetsStorage`, `snippetsDir` | Disk storage, and where cloud-init snippets go |
| `poolWarnPct`, `poolBlockPct` | Storage fill levels for a warning (80) and for refusing a deploy (90) |

### Creating a project (with `CONSOLE_DEPLOY=1`)

"New project" on the start page makes a new sandbox VM for a team:

1. **The form.** A name, and what the team starts from: one of your project folders
   (`CONSOLE_PROJECTS_DIR/<name>/team/`, usually with `seed/` beside it for the starting repo) or an example
   that ships a seed. The charter can be edited in place. Target, size, theme, models and brakes are under
   "Advanced".
2. **The check.** The console reads the team without running anything from it: required files, agent
   headers, no links, size limits. It writes `project.env` itself; a bundle's own env files are read as
   plain `KEY=value` lines and anything else is refused, because the kit later sources them as root in the VM.
3. **Dry run.** Asks the host again (id free, name free, storage below the block line), then runs
   `sandbox/proxmox/playbooks/create-agent-vm.yml` with `--check`. It settles the VM id and address and
   changes nothing. It does not prove that the VM will build.
4. **Create project.** Open for 15 minutes after a dry run of exactly the same inputs. Runs the playbook for
   real with the id the dry run settled on, with live output: clone, cloud-init, the isolation check from
   inside the VM, the VM-to-VM block, a `provisioned` snapshot. The VM's ssh host key is read through
   Proxmox and stored.

5. **Install.** Starts by itself once the VM is ready: `sandbox/install/install-team.yml` copies the kit, the
   rendered team and the seed in, copies the project's `files/` folder (if it has one) to
   `/root/provision-files`, runs the team's `provision.sh` as root (its text is shown before the dry run),
   runs the kit installer and checks that the team is installed and stopped.
6. **Claude sign-in.** With a token saved as `claude-token` in the config folder (one line, from
   `claude setup-token`, mode 600), the VM gets it and the deploy finishes without you. Without one, the page
   shows three things to paste on your workstation (an ssh config entry, the VM's host key, one command) and
   a "check now" button. The check is `claude auth status` on the VM; it spends no tokens.
7. **Registered, halted.** The project is added to `projects.json` and shows up like any other. Its lead
   timer is off. Starting the team is your Resume on its Controls tab; the console never does that.
8. **Gate proof.** Runs by itself on the VM (`agent-kit-gate-proof`, kit 0.3.1): one harmless change must be
   merged by the gate, and a change that deletes a test file (named by `GATE_PROOF_DELETE` in the team's
   `project.env`) must be refused. It uses the gate's real checks, spends no tokens, and leaves the team
   halted. A build that is broken in a way only your project knows is still yours to try once by hand.

About the token: it is read only to hand it to a VM. It goes to the VM on stdin inside a task whose output is
never logged, and it is never written to a run folder, the audit log or a page. On the VM it sits in the
agents' environment, so an agent that prints its environment writes it into its transcript; the console
hides anything shaped like a token wherever it shows transcript text. One token for several VMs means one
leak exposes all of them. A project's Controls tab shows how its team is signed in and can apply the saved
token to a VM with kit 0.3 or later.

A failed install does not harm the VM's snapshot. The page shows
`qm rollback <vmid> provisioned && qm start <vmid>` for you to run, then "Retry the install", which reads the
team from its folder again.

What the console will not do: destroy or roll back a VM, touch an id outside the target's range or in
`criticalVmids`, touch an id that is already in use, run two deploys at once, or start a team. After a failed
run it shows how far the run got and the commands to clean up by hand. A run that failed after the clone
finished can be continued; a VM that failed its isolation check cannot.

Each deploy keeps its inputs, the staged team and every run (inventory, variables, events, output) under
`console-data/deploys/<id>/`. Nothing there is deleted automatically.

API: `GET/POST /api/deploys`, `GET/DELETE /api/deploys/<id>` (DELETE closes the record only),
`POST /api/deploys/<id>/dry-run|create|continue|install|login-check|apply-token|gate-proof`, `GET /api/deploys/<id>/events?run=<run>` (server-sent
events), `GET /api/deploy-sources`.

"Check target" runs one fixed, read-only script on the host (`qm list`, `pct list`, storage, memory, the
bridge, the gateway, the template) and shows what it found. It changes nothing.

## Who can use it

There is no login. Anyone who can open the page can message a lead as the owner, halt or resume a team,
change the project list and read everything the agents read. Keep it on a private network. What is built in:

- the container listens on localhost only;
- every request that changes something must come from the page's own origin, so another web page cannot fire
  actions through your browser;
- pulled text is sanitised before it is shown, and images that point at other hosts are dropped;
- an audit log of every change (`console-data/audit.jsonl`).

For a login, put an auth proxy in front and set `CONSOLE_USER_HEADER` to the header it adds with the user's
name; requests without it are then refused, and the audit log records that name.

## Develop

```bash
cd console
npm install
CONSOLE_CONFIG_DIR=/srv/ziggurat/config CONSOLE_DATA_DIR=/srv/ziggurat/console-data npm run dev
npm test
```

SvelteKit with the Node adapter, plain JavaScript. Server code is in `src/lib/server/`:
`live.js` (status), `pull.js`, `transcripts.js` (agent tree), `aggregate.js` (progress), `feedback.js`,
`controls.js`, `ssh.js`.
