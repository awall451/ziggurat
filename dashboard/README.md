# Dashboard

A morning view of your agent boxes: a spoken brief, screenshots, usage, gate
verdicts, the lead's plan, QA issues and trial-run comparisons. Static Svelte 5 +
ECharts build served by nginx; the spoken brief uses edge-tts.

- Data: `$FLEET_DATA` (see `config.example.env`) mounted at `/data`. `publish.py`
  writes `index.json` and `<box>/dashboard.json`; `workstation/agent-pull` runs it
  every 15 minutes and `workstation/agent-digest` after the morning digest.
- Token usage panels need a token tracker that serves `/api/project`
  (`TOKEN_TRACKER_URL`); without one they are simply hidden.
- Build: `cd frontend && npm ci && npx vite build` (outputs to `site/`, never
  wipes `site/data`). Run: `FLEET_DATA=... docker compose up -d`.
- Spoken brief: `python3 -m venv .venv && .venv/bin/pip install edge-tts`.
