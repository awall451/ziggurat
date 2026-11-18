# Roadmap

Where Ziggurat is going. The structure is still being worked out on two example
projects (a browser game and a PlayStation 1 game).

## 1. Roles are the product, names are a theme

The structure is what matters; themed names are flavour and will not land with
everyone. Treat every agent as a **neutral role** with a
**themed display name**.

| Role id (neutral, used in code and files) | What it does | Model (current) | Tolkien theme |
|---|---|---|---|
| `lead` | Plans each cycle, assigns goals, light review, keeps STATE.md | Fable | Eru |
| `area-lead` (`engine`, `content`, `art`, `audio`) | Owns one goal, plans steps, delegates, reviews diffs, commits | Opus (Sonnet for small goals) | Ainur |
| `builder` | Implements one step, never commits | Sonnet | Maia (`maia-builder`) |
| `scout` | Search, run checks, summarize logs, never edits | Haiku | Maia (`maia-scout`) |
| `reviewer` | Independent review of risky branches | Opus / Sonnet | `ainu-review` |
| `qa` | Plays the game, files issues | Opus | `ainu-qa` |

### Candidate themes

| Theme | lead | area-lead | builder | scout | reviewer | qa |
|---|---|---|---|---|---|---|
| Plain (default for others) | Lead | Area lead | Builder | Scout | Reviewer | QA |
| Tolkien | Eru | Ainur | Maiar | Maiar (scouts) | Ainu reviewer | Ainu QA |
| Orchestra | Conductor | Section principal | Player | Stagehand | Critic | Audience |
| Gothic household | The Count | Steward | Servant | Footman | Chaplain | Night watch |
| Cathedral builders | Master builder | Master mason | Journeyman | Apprentice | Inspector | Pilgrim |
| Starship | Captain | Chief officer | Crew | Ensign | First officer | Away team |
| Norse | Odin | Aesir | Einherjar | Ravens | Norns | Valkyries |

### How a theme toggle could work (later)

- Agent files and prompts use **role ids** (`area-lead-engine.md`, `builder.md`, `scout.md`).
- A theme is a small file, `themes/<name>.yaml`: role id → display name, plus an optional one-line
  flavour per role ("You are a Maia..."). Prompts reference `{{name.builder}}` etc.
- The installer renders the agent files and prompts for the chosen theme (`THEME=tolkien`).
- The dashboard, digests and spoken briefs read the same theme file, so labels match everywhere.
- Switching theme only changes display names and flavour text, never behaviour, models or permissions.
- Migration from today: rename `ainu-*`/`maia-*` files to role ids and render Tolkien names from
  the theme. One mechanical change, best done when the setup is stable.

## 2. What is personal today and would need generalizing

| Hard-coded now | Generalize to |
|---|---|
| Proxmox host, `vmbr1`, `10.66.0.0/24`, gateway CT 110, VMIDs 300+ | Config file; also support "Docker Sandboxes / plain VM / cloud session" backends |
| Admin user, SSH key, workstation paths | Done: `config.example.env`; next: a setup script |
| Allow-list domains | Per-project additions in project config |
| Gate checks (`gate-checks` per project) | Keep: it is the per-project contract; ship examples (web game, PS1/C++) |
| Workstation pull, token tracker override, dashboard behind a reverse proxy | Optional add-ons; document the data contract (`cycles.jsonl`, `history.log`, `dashboard.json`) |
| Subscription-only auth via `claude auth login` in each VM | Document both login and `setup-token` paths and their trade-offs |

## 3. Lessons worth writing up for others

- The gate the workers cannot edit is the core idea; everything else is plumbing.
- Headless cycles kill background subagents when the lead ends its turn: foreground only.
- Count only real work toward daily caps; usage-limit hits must retry, not burn the cap.
- Most spend was long Opus builder sessions re-reading context; tiering (Opus leads, Sonnet
  builders, Haiku scouts) is the main cost lever. Measure: `fleet/<box>/trials/`.
- Toolchains for sandboxed VMs: download on the host, copy in, keep the allow-list small.
