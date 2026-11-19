# New project

A fresh start. The team's goal is in the charter (`/opt/agent-kit/CHARTER.md` inside the VM).

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/ruff check .
.venv/bin/pytest -q
```
