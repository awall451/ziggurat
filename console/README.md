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
| Gallery | Screenshots the gate took of the newest passing build, by day |
| Digest | The morning digest and its spoken version (written by `workstation/agent-digest`) |
| Usage | Tokens and cost estimates by model, role and cycle, computed from the transcripts |
| Controls | Halt, resume, a one-shot job (one cycle for the work you describe, then halted again), stop at a set time, cycle cap, budget, models, gate pause, audit log |

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
| `kit.*` | Only if the VM differs from the defaults (`state`, `workspace`, `bare`, `leadUnit`, `agentHome`) |
| `paths.transcripts`, `paths.fleet` | Where pulled data for this project is kept |
| `agentAliases` | Maps older agent ids to the official ones, so old cycles get the right names |

`pricing.json` holds the price table used for the estimates (USD per million tokens, first matching model
wins). Estimates are API-equivalent figures, not a bill.

## Who can use it

There is no login. Anyone who can open the page can message a lead as the owner, halt or resume a team and
read everything the agents read. Keep it on a private network. What is built in:

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
