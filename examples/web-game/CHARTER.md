# Oakhollow charter

Read-only. Written by the owner. Agents cannot change it; propose
changes in `docs/agents/ESCALATIONS.md`.

## The goal

Turn Oakhollow into an **original JRPG that would pass as a top-tier 1994 SNES
release**: the scale, polish and feel of the best 16-bit console RPGs of that
era. ATB battles, a party of distinct characters, a world map, towns,
dungeons, an airship, a story with real drama and humour, memorable music,
rich pixel art. Finished, playable start to credits.

Keep going until that is true. There is no deadline.

## Autonomy level: FREE

You choose the work, the order, the design, the story, the characters and the
art direction. The owner checks in occasionally and does not want to be asked
about ordinary decisions. Decide, write the decision down, move on.

## Hard boundaries

1. **Original work only.** Genre conventions are fine (ATB, espers-like
   summons as a *mechanic*, opera-scale drama). Never copy names, characters,
   story, maps, sprites, music or text from any existing game, Final Fantasy
   VI included. No "inspired-by" renames of existing characters.
2. **Stay in the sandbox.** This VM has no internet except an allow-listed
   proxy. Do not try to get around it, probe the network, or find other paths
   out. If you need a domain, request it in ESCALATIONS.md.
3. **The gate is the definition of done.** Work reaches `main` only through
   the gate (see GATE-CONTRACT.md). Never try to influence the gate other
   than by making the game pass it. Do not delete or skip tests to pass.
4. **Keep the debug contract** (`window.game`, see GATE-CONTRACT.md) working.
5. **Art stays indexed-color data** in `project/` (palette + index rows), as
   the engine requires. No RGBA PNG assets in the game data.
6. **No new runtime dependencies** without a written reason in DECISIONS.md.
   Prefer writing it yourself. The game must run as a static bundle.
7. **Model pins.** Keep the model fields in `.claude/agents/*.md` as set
   (lead on Fable, builders on Opus, helpers cheaper). Usage is shared with
   the owner's own work.
8. **No secrets, no accounts, no external services.**

## Escalate (write to `docs/agents/ESCALATIONS.md`, then carry on with other work)

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

Judge your own progress against the bar above, not against "it works".
QA plays the game regularly and reports honestly what a 1994 player would
think. Prefer depth (one great dungeon) over breadth (five empty ones).
