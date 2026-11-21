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
| Inbox | Messages to the lead in three tiers, with attachments; the lead's replies; questions the lead asks you; one-shot jobs, which can be started again from here |
| Notes | The lead's plan (`STATE.md`), journal, QA issues, other docs on main |
| Gallery | Screenshots the gate took of every merged build, grouped by the cycle that made them (kit 0.13; older kits: the newest passing build, by day). Pick a cycle, a build within it, and another cycle to compare with |
| Briefs | A brief for every finished cycle and its spoken version (written by `workstation/agent-brief`); a cycle without one yet shows the lead's own final report |
| Usage | Tokens and cost estimates by model, role and cycle, computed from the transcripts |
| Schedule (all projects) | One timeline for every team: cycles that ran, the one running, and the start times still to come, by day, week or month. Move and zoom through time, drag a start time to another time, add or remove them, mark your own quiet hours; overlaps between teams are pointed out |
| Publishing (on Controls) | Copy the gate's main to a remote git repository: the project's key to add there, verify, publish now, and what was published or refused |
| Controls | Halt now or after the cycle in progress (optionally asking the team to wrap up), resume, a one-shot job (one cycle for the work you describe, on a halted team or one between cycles, then back as it was), why an idle team is idle (daily cap, timer off, next cycle), stop at a set time, cycle cap, budget, models, gate pause, audit log |

## How it gets its data

- **Live state**: one read-only ssh round trip per project, cached for ten seconds.
- **Pulls**: every 15 minutes the console copies each VM's ledger, gate history, notes, screenshots and
  transcripts into your data folders (rsync, never `--delete`, never following links, agent-owned trees read
  as the agent user). While you look at a running project it pulls the files of the cycle in progress every
  15 seconds, and as soon as it sees the cycle end it does a full pull, so the cycle's outcome arrives with it.
  A cycle that ended after the last ledger copy shows as "ending" until that pull lands, never as interrupted.
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

## Schedule

By default a team runs its cycles back to back until its daily cap is used up. On the **Schedule** tab (top
left, beside Projects) you give a project **start times** instead: times of day, on every day or on chosen
days of the week, in a time zone you pick. From then on its cycles start at those times only.

- **Day** and **Week** show a timeline; **Month** is an overview (per day, the cycles that ran and the start
  times still to come). **Today** jumps back to now.
- **Move through time** with the arrows (half of what is shown, so what was at the edge comes to the middle),
  or scroll sideways over the timeline (Shift + wheel). **Zoom in** by dragging across empty space.
- **Change times**: drag a planned start (it snaps to 15 minutes), click an empty place in a row to add one,
  or click a start time to set its time and days or to remove it.
- A change is **not active** until you press **Apply to <project>**, which sends the new times to that
  project's VM. **Undo changes** drops it. **Remove all** returns the project to back-to-back cycles.
- A planned start is drawn as long as that team's typical cycle (the median of its last ten). A cycle has no
  fixed length, so the end is a guess and overlaps between teams are "likely", not certain.
- **Your hours**: the time zone of the timeline (picked by familiar names such as "EST · UTC-05:00 · Eastern
  Time") and your quiet hours, the hours you work with Claude yourself. They are shaded, and a start time
  inside them is pointed out. Nothing is blocked. **24 h / 12 h** switches how times are written.
- The page also warns when a project has more start times on a day than its daily cap allows: the cap still
  applies.

If a start time comes while that team's previous cycle is still running, it is skipped (shown as a small ×).
Halt, resume and one-shot jobs work as before. The times are kept on the VM and the VM starts the cycles, so
they hold while the console is off. Needs kit 0.9 on the VM.

## Publishing

A project can be published to a remote git repository. The team cannot push: the console does it, with a key
that exists only on the console (one per project), and only what the gate has merged.

1. Create an **empty** repository on your git host (no README, no licence).
2. On the project's Controls tab, under Publishing, enter its ssh address (`git@github.com:owner/repo.git`).
   For a new project you can enter it in the "New project" form instead.
3. The console shows a public key. Add it to the repository as a **deploy key with write access**. A deploy key
   works for that one repository only.
4. Press **Verify**. The first time, the console shows the host's key fingerprint: compare it with the ones
   your git host publishes and confirm. Verify then checks that the key can read and may push.
5. On the remote, protect `main`: block force pushes and deletion, and let only the deploy key push. Turn off
   issues, wiki and CI there unless you use them.

From then on the lead asks for a publish at the end of a cycle, and the console pushes once the gate has
judged that cycle's work. **Publish now** does the same on your word. Before every push the console checks
what is new: the remote's history is never rewritten, a secret (found by `gitleaks`, or the stored Claude
token) or a CI file stops the whole publish, and the lead is told why. See
[docs/architecture.md](../docs/architecture.md), "Publishing to a remote repository".

Needs kit 0.8 on the VM, `gitleaks` on the console (the Docker image and `deploy/bootstrap.sh` install it), and
a git host that takes deploy keys over ssh. Hosts without them (Azure DevOps) are not supported yet.

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

### Run it in a container on the Proxmox host

The console holds the keys to every sandbox VM, so a small machine of its own is a better home than a
workstation: it is always on, and it does nothing else. `sandbox/proxmox/playbooks/create-console-ct.yml`
creates an unprivileged container on the LAN side only (never on the agent bridge) and runs
[`deploy/bootstrap.sh`](deploy/bootstrap.sh) in it. No Docker: Node runs under systemd as the `console` user,
which owns the data in `/srv/ziggurat` and cannot change the code in `/opt/ziggurat`.

```bash
# In sandbox/proxmox: set the console_ct_* values in vars/agent-sandbox.yml first
ansible-playbook playbooks/create-console-ct.yml --check
ansible-playbook playbooks/create-console-ct.yml
```

- **Who can connect.** The container's firewall accepts ssh and the console port only from
  `console_ct_allow_from` (your workstation, or the machine your reverse proxy runs on). The console has no
  login, so this list is the protection.
- **Its own key.** The bootstrap makes an ssh key in the container (`/srv/ziggurat/ssh/key`) and prints the
  public half. Add that to the admin user of the gateway and of each VM, and to the Proxmox host if the console
  may create projects. The private half never leaves the container.
- **Settings.** `/srv/ziggurat/console.env` (from [`deploy/console.env.example`](deploy/console.env.example)),
  the config files in `/srv/ziggurat/config`, and an ssh `config` and `known_hosts` in
  `/srv/ziggurat/home/.ssh` (with `IdentityFile /srv/ziggurat/ssh/key`). Then `systemctl start ziggurat-console`.
- **Updates.** `sudo /opt/ziggurat/console/deploy/redeploy.sh`: pull, build, check that the playbooks parse,
  restart, check that it answers. A restart cuts off a deploy that is running.
- **Briefs.** `workstation/agent-brief` still runs on your workstation. `workstation/console-sync` copies the
  pulled data from the container and the finished briefs back to it; the workstation always opens the
  connection.

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

### Plan with Claude, then import

A planning talk with Claude can end in a draft instead of a form to fill in by hand. The draft is one JSON
document with everything the New project page holds: name, goal, the plan and design documents, the team
template, "when it's ready" and the advanced settings. The schema is
[`docs/new-project.schema.json`](docs/new-project.schema.json), and there is an example in
[`docs/new-project.example.json`](docs/new-project.example.json).

```bash
curl -X POST -H 'Content-Type: application/json' -H 'Origin: http://<console>' \
  --data-binary @draft.json http://<console>/api/drafts
# {"id":"…","url":"/new?draft=…","warnings":[]}
```

The `Origin` header must name the console itself: like every request that changes something, a draft from
another site is refused.

The console checks the draft with the same rules as the form and keeps it. Opening the url fills the page.
Read it, change what you like, then press Check. A draft never deploys anything, and it is deleted once it
has become a deploy. "Import JSON…" on the page does the same with a file. `GET /api/drafts` lists the
drafts; `GET` and `DELETE /api/drafts/<id>` read or delete one.

### Creating a project (with `CONSOLE_DEPLOY=1`)

"New project" on the start page makes a new sandbox VM for a team:

1. **The form.** A name; **what the team should build** (the goal, a few paragraphs); your **plan and design
   documents** (Markdown files, dropped, chosen or pasted, put into the new repository's `docs/`); the
   **team**: a template from `templates/` (Standard, Small or Device: how the team works, not the language);
   and **when it's ready**: whether to start one planning cycle once the gate is proven, with a focus and at
   most N proposals. Under "Advanced": target, size, theme, models and brakes, the full charter, and a
   prepared team folder (`CONSOLE_PROJECTS_DIR/<name>/team/` with `seed/` beside it) instead of a template.
   Registered projects are never offered as starting points. The form can also be filled from a draft
   (above).
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
9. **Planning cycle** (when the form asked for one). After the gate proof passes, the console starts one
   planning cycle with your focus and cap. The lead reads the goal and `docs/`, writes no code, and proposes
   jobs on the Backlog tab, where you can talk them over. The team halts again when it ends.

A project from a template starts with a placeholder `tools/check` (it runs `tests/*.sh`). The lead's first
job is choosing the stack and writing the real checks. A change to `tools/check` is held by the gate until
you approve it on the Inbox tab, which shows the lead's explanation and the diff. When the team needs a
system package or a domain, it asks, and the Inbox shows the request. Approving adds the domains it needs to
the gateway's allow-list (shared by all agent VMs), and the VM installs the package between cycles.

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
