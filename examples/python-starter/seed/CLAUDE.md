# Project notes

Python 3.12. Use a repo-local venv:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/ruff check .
.venv/bin/pytest -q
```

The gate runs the same steps on a fresh checkout (see `/opt/agent-kit/GATE-CONTRACT.md`).
Network goes through an allow-list proxy (the environment variables are set). Most
documentation sites are not reachable: read the installed package source under
`.venv` instead of guessing an API.
