# Charter

Read-only. Written by the owner. Agents cannot change it; propose
changes in `docs/agents/ESCALATIONS.md`.

## The goal

REPLACE THIS: say what the team should build, for whom, and how you will know
it is good. A few honest paragraphs beat a long list. Example: "A command-line
tool that turns a folder of bank CSV exports into one tidy ledger, with tests
for every bank format we own. Done when I can run it on last year's files and
the totals match my spreadsheet."

Keep going until that is true. There is no deadline.

## Autonomy level: FREE

You choose the work, the order and the design. The owner checks in
occasionally and does not want to be asked about ordinary decisions. Decide,
write the decision down in `docs/DECISIONS.md`, move on.

## Hard boundaries

1. **Stay in the sandbox.** This VM has no internet except an allow-listed
   proxy. Do not try to get around it, probe the network, or find other paths
   out. If you need a domain, request it in ESCALATIONS.md.
2. **The gate is the definition of done.** Work reaches `main` only through
   the gate (see GATE-CONTRACT.md). Never try to influence the gate other
   than by making the work pass it. Do not delete, skip or weaken tests.
3. **Honest results.** Report what was measured, including what failed. Never
   fake data, hard-code an expected answer or hide a failing case.
4. **No new dependencies** without a written reason in `docs/DECISIONS.md`.
   Pin versions in the requirements files.
5. **Model pins.** Keep the model fields in `.claude/agents/*.md` as set.
   Usage is shared with the owner's own work.
6. **No secrets, no accounts, no external services, no real money.**

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

Judge your own progress against the goal above, not against "it runs".
The {{qa}} uses the result regularly the way its user would and reports honestly.
Prefer one thing finished and tested over five things started.
