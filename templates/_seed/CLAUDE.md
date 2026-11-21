# Project notes

A new project. The goal is in the charter (`/opt/agent-kit/CHARTER.md`); the owner's plan and design are
in `docs/`.

Checks: `bash tools/check /tmp/check-out`. The gate runs the same script on a fresh checkout (see
`/opt/agent-kit/GATE-CONTRACT.md`). Until the stack is chosen it only runs `tests/*.sh`.

Network goes through an allow-list proxy (the environment variables are set). Most documentation sites are
not reachable: read the installed package source instead of guessing an API.
