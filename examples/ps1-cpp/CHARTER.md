# Nocturne charter

Read-only. Written by the owner. Agents cannot change it; propose
changes in `docs/agents/ESCALATIONS.md`.

## The goal

Turn Project Nocturne into an **original JRPG for the original PlayStation that
would pass as a top-tier release of its era**: the depth and drama of the best
16-bit and early-PS1 RPGs, in Nocturne's own gothic-horror identity (1930s
monster-film mood: black, silver and one drop of red). A party of distinct
characters, ATB battles with real tactics, towns, dungeons, a world, a story
with drama and dread and humour, music, and art that makes the most of the
hardware. Finished and playable from title to credits, on a real disc image.

Keep going until that is true. There is no deadline.

## Autonomy level: FREE

You own **everything**: engine, systems, tools, story, characters, dialogue,
maps, art, music, balance. The owner checks in occasionally and does not want
to be asked about ordinary decisions. Decide, write it down, move on.

If the repo's own CLAUDE.md reserves some creative work for a human, the owner
decides whether that still applies; record the decision here. In this example
the owner handed everything to the team: replace placeholder content and
existing creative work freely; keep good existing ideas where they serve the game.

## Hard boundaries

1. **Original work only.** Genre conventions are fine. Never copy names,
   characters, story, maps, sprites, music or text from any existing game or
   film, Final Fantasy VI, Xenogears and Universal's monster films included.
   No renamed versions of existing characters (no Dracula, no Frankenstein's
   monster, no Belmonts). Read `docs/decisions/0005-original-ip-gothic-theme.md`.
2. **Stay in the sandbox.** This VM has no internet except an allow-listed
   proxy. Do not try to get around it, probe the network, or find other paths
   out. Need a domain? Ask in ESCALATIONS.md.
3. **The gate is the definition of done.** Work reaches `main` only through
   the gate (see GATE-CONTRACT.md). Never try to influence the gate other than
   by making the game pass it. Never delete, skip or weaken tests to pass.
4. **Real hardware rules.** It must build with the pinned psyqo (`third_party/nugget`)
   and run in the PS1 emulator self-test. Respect the PS1 limits (2 MB RAM,
   1 MB VRAM, CLUT palettes, 512 KB SPU RAM). Update psyqo only on purpose,
   with a decision record.
5. **Keep the TDD split**: game rules in `core/` with host tests; `platform/psx/`
   thin. Assets go through `make assets` from sources in `assets/src/`, never
   converted by hand. The replay (`tests/replay/poc_script.hh`) and the PS1
   self-test (`tests/emu/selftest.cpp`) must keep proving a real playthrough;
   extend them as the game grows.
6. **No new third-party code** without a decision record in `docs/decisions/`.
7. **Model tiers (owner decision 2026-11-17).** {{lead}} on Fable; {{area_leads}} are tech
   leads on Opus (Sonnet for small goals) who delegate implementation;
   `builder` on Sonnet, `scout` on Haiku. Keep the model fields in
   `.claude/agents/*.md` as set. Usage is shared with the owner: prefer the
   cheapest tier that can do a step well, and keep sessions short.
8. **No secrets, accounts or external services.** `make deploy`, `make run` and
   `make debug` target the owner's own machines (emulators, handheld); do not run them here.

## Known gap you should fix early

There is no way yet to *see* the game from here: the PCSX-Redux CLI gives no
screenshots and nobody can watch. QA and art need eyes. Give the team a way to
render real frames to PNG (for example a host-side preview that executes the
same draw lists, or an emulator framebuffer dump in the self-test) and keep
PNGs of key screens under `build/` so reviewers, QA and the owner can look.
When frames exist, also write the newest set to `build/screens/*.png`.

## Escalate (append to `docs/agents/ESCALATIONS.md`, then carry on with other work)

- a gate check is wrong or blocks legitimate progress
- you need a domain on the proxy allow-list
- the same task failed the gate 3 times
- you believe the charter itself should change
- anything that looks like a security problem

Every entry there waits on the owner until it is closed. When one is answered or
no longer needed, add a line `Resolved: <date>, <one sentence>` under its heading.
If you also ask the same thing with `owner-inbox ask`, write that question's id in
the entry. Notes with nothing for the owner to decide go in the journal instead.

## Quality bar

Judge progress against the bar above, not against "it works". QA plays the
game regularly and reports honestly what a player of that era would think.
Prefer depth (one great dungeon) over breadth (five empty ones).
