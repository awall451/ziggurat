"""Write one JSON line per playbook event to $ZIGGURAT_EVENTS_PATH.

The console tails that file to show a run as it happens and reads it again to
decide how the run ended. Rules this plugin keeps:

- a task marked no_log never has its output written: only its name and outcome;
- text is cut to a fixed length, so a chatty task cannot fill the disk;
- a failure that the play ignores is marked as such;
- the play's own result comes from `set_stats` data (key "ziggurat"), not from
  scraping printed text.
"""
from __future__ import annotations

import json
import os
import time

from ansible.plugins.callback import CallbackBase

DOCUMENTATION = """
    name: ziggurat_events
    type: stdout
    short_description: JSON lines for the Ziggurat Console
    description: Writes one JSON object per event to the file named by ZIGGURAT_EVENTS_PATH.
"""

MAX_TEXT = 4000
DEBUG_ACTIONS = ("debug", "ansible.builtin.debug", "assert", "ansible.builtin.assert", "fail", "ansible.builtin.fail")


def _cut(value, limit=MAX_TEXT):
    if value is None:
        return None
    if not isinstance(value, str):
        try:
            value = json.dumps(value, default=str, ensure_ascii=False)
        except Exception:
            value = str(value)
    if len(value) > limit:
        return value[:limit] + " ... (cut)"
    return value


def _tail(value, limit=MAX_TEXT):
    if not isinstance(value, str) or not value:
        return None
    return value if len(value) <= limit else "(cut) ... " + value[-limit:]


class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = "stdout"
    CALLBACK_NAME = "ziggurat_events"

    def __init__(self):
        super().__init__()
        self._path = os.environ.get("ZIGGURAT_EVENTS_PATH")
        self._fh = open(self._path, "a", buffering=1, encoding="utf-8") if self._path else None
        self._check = False

    # -- helpers ------------------------------------------------------------
    def _emit(self, kind, **fields):
        row = {"type": kind, "ts": int(time.time() * 1000)}
        row.update({k: v for k, v in fields.items() if v is not None})
        line = json.dumps(row, default=str, ensure_ascii=False)
        if self._fh:
            self._fh.write(line + "\n")
            self._fh.flush()
            try:
                os.fsync(self._fh.fileno())
            except OSError:
                pass
        # A short human line for the run's stdout log.
        text = fields.get("task") or fields.get("play") or ""
        self._display.display("%s %s" % (kind, text))

    @staticmethod
    def _parts(result):
        # Attribute names changed between ansible-core versions.
        host = getattr(result, "host", None) or getattr(result, "_host", None)
        task = getattr(result, "task", None) or getattr(result, "_task", None)
        data = getattr(result, "result", None)
        if not isinstance(data, dict):
            data = getattr(result, "_result", None) or {}
        return host, task, data

    @staticmethod
    def _secret(task, data):
        return bool(data.get("_ansible_no_log")) or bool(getattr(task, "no_log", False)) or data.get("censored") is not None

    def _ok(self, result, item=False):
        host, task, data = self._parts(result)
        fields = {"task": task.get_name(), "host": host.get_name(), "changed": bool(data.get("changed")), "item": True if item else None}
        if self._secret(task, data):
            fields["censored"] = True
        elif task.action in DEBUG_ACTIONS and "msg" in data:
            fields["msg"] = _cut(data.get("msg"))
        self._emit("task_ok", **fields)

    def _failed(self, result, ignore_errors=False, unreachable=False, item=False):
        host, task, data = self._parts(result)
        fields = {
            "task": task.get_name(),
            "host": host.get_name(),
            "ignored": True if ignore_errors else None,
            "unreachable": True if unreachable else None,
            "item": True if item else None,
        }
        if self._secret(task, data):
            fields["censored"] = True
            fields["msg"] = "output hidden (no_log)"
        else:
            fields["msg"] = _cut(data.get("msg") or ("unreachable" if unreachable else "task failed"))
            fields["stderr"] = _tail(data.get("stderr"))
            fields["stdout"] = _tail(data.get("stdout"))
            fields["rc"] = data.get("rc")
        self._emit("task_failed", **fields)

    # -- playbook events ----------------------------------------------------
    def v2_playbook_on_start(self, playbook):
        self._emit("playbook_start", playbook=os.path.basename(getattr(playbook, "_file_name", "") or ""))

    def v2_playbook_on_play_start(self, play):
        self._check = bool(getattr(play, "check_mode", False)) or bool(self._check)
        self._emit("play_start", play=play.get_name())

    def v2_playbook_on_task_start(self, task, is_conditional):
        self._emit("task_start", task=task.get_name())

    def v2_playbook_on_handler_task_start(self, task):
        self._emit("task_start", task=task.get_name())

    def v2_runner_on_ok(self, result):
        self._ok(result)

    def v2_runner_item_on_ok(self, result):
        self._ok(result, item=True)

    def v2_runner_on_failed(self, result, ignore_errors=False):
        self._failed(result, ignore_errors=ignore_errors)

    def v2_runner_item_on_failed(self, result):
        self._failed(result, item=True)

    def v2_runner_on_unreachable(self, result):
        self._failed(result, unreachable=True)

    def v2_runner_on_skipped(self, result):
        host, task, _ = self._parts(result)
        self._emit("task_skipped", task=task.get_name(), host=host.get_name())

    def v2_runner_retry(self, result):
        host, task, data = self._parts(result)
        self._emit("task_retry", task=task.get_name(), host=host.get_name(), attempt=data.get("attempts"), retries=data.get("retries"))

    def v2_runner_on_async_poll(self, result):
        host, task, _ = self._parts(result)
        self._emit("task_wait", task=task.get_name(), host=host.get_name())

    def v2_playbook_on_stats(self, stats):
        for host in sorted(stats.processed.keys()):
            s = stats.summarize(host)
            self._emit("recap", host=host, ok=s.get("ok"), changed=s.get("changed"), failed=s.get("failures"), unreachable=s.get("unreachable"), skipped=s.get("skipped"))
        custom = (getattr(stats, "custom", None) or {}).get("_run", {})
        data = custom.get("ziggurat") if isinstance(custom, dict) else None
        if isinstance(data, dict):
            self._emit("result", data=data)
