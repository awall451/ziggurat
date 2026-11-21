# Charter

Read-only. Written by the owner. Agents cannot change it; propose
changes in `docs/agents/ESCALATIONS.md`.

## The goal

{{goal}}

The owner's plan and design documents are in `docs/` of the repository. Read
them before you plan: they say more about the goal than this page. Where they
and this charter disagree, this charter wins; escalate the difference.

Keep going until the goal is met. There is no deadline.

## Autonomy level: FREE

You choose the work, the order and the design, including the language and the
tools, unless the owner's documents decide them. The owner checks in
occasionally and does not want to be asked about ordinary decisions. Decide,
write the decision down in `docs/DECISIONS.md`, move on.

## Hard boundaries

1. **Stay in the sandbox.** This VM has no internet except an allow-listed
   proxy. Do not try to get around it, probe the network, or find other paths
   out. If you need a domain, request it in ESCALATIONS.md.
2. **The gate is the definition of done.** Work reaches `main` only through
   the gate (see GATE-CONTRACT.md). Never try to influence the gate other
   than by making the work pass it. Do not delete, skip or weaken tests.
3. **What "done" means is the owner's.** `tools/check` (and `tools/check.d/`)
   are the checks the gate runs. You may change them, but such a change waits
   for the owner's approval: keep it on its own branch and explain it with
   `owner-gate explain <topic>`.
4. **Honest results.** Report what was measured, including what failed. Never
   fake data, hard-code an expected answer or hide a failing case.
5. **No new dependencies** without a written reason in `docs/DECISIONS.md`.
   Pin their versions.
6. **Model pins.** Keep the model fields in `.claude/agents/*.md` as set.
   Usage is shared with the owner's own work.
7. **No secrets, no accounts, no external services, no real money.**

## Escalate (write to `docs/agents/ESCALATIONS.md`, then carry on with other work)

- a gate check is wrong or blocks legitimate progress
- you need a domain on the proxy allow-list, or a system package you cannot
  install yourself (you are not root)
- the same task failed the gate 3 times
- you believe the charter itself should change
- anything that looks like a security problem

## Quality bar

Judge your own progress against the goal above, not against "it runs".
The {{qa}} uses the result regularly the way its user would and reports honestly.
Prefer one thing finished and tested over five things started.
