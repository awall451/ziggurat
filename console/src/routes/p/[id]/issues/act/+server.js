import { error, json } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { edit, addFiles, addNote, fixNow, resendAmend, safeName } from '$lib/server/issues.js';
import { oneshot } from '$lib/server/controls.js';
import { audit } from '$lib/server/audit.js';

const B64_RE = /^[A-Za-z0-9+/=]+$/;

/**
 * Ticket actions on one issue (kit 0.12), as JSON {action, id, ...}:
 *   edit   {title?, kind?, priority?, body?, doneWhen?, related?}
 *   files  {files: [{name, data(base64)}]}
 *   note   {text}
 *   fix    (Fix now: a one-shot job for this issue)
 *   resend (send a change again that did not reach the VM)
 */
export async function POST({ params, request, locals }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== 'object') error(400, 'Bad request');
  const id = String(b.id || '');
  try {
    switch (b.action) {
      case 'edit': {
        const pick = {};
        for (const k of ['title', 'kind', 'priority', 'body', 'doneWhen', 'related']) if (b[k] !== undefined) pick[k] = b[k];
        const issue = await edit(project, locals.user, id, pick);
        audit(locals.user, project.id, 'issue-edit', { id, fields: Object.keys(pick).join(',') }, { ok: !issue.pendingAmend, detail: issue.error });
        return json({ ok: true, pending: !!issue.pendingAmend, error: issue.error || null });
      }
      case 'files': {
        const list = Array.isArray(b.files) ? b.files : [];
        const files = list.map((f) => {
          if (typeof f?.data !== 'string' || !B64_RE.test(f.data)) error(400, 'Bad file');
          return { name: safeName(f?.name), data: Buffer.from(f.data, 'base64') };
        });
        if (files.some((f) => !f.name)) error(400, 'A file has a name that cannot be used');
        const issue = await addFiles(project, locals.user, id, files);
        audit(locals.user, project.id, 'issue-files', { id, files: files.length }, { ok: !issue.pendingAmend, detail: issue.error });
        return json({ ok: true, pending: !!issue.pendingAmend, error: issue.error || null });
      }
      case 'note': {
        const issue = await addNote(project, locals.user, id, b.text);
        const last = issue.notes.at(-1);
        audit(locals.user, project.id, 'issue-note', { id }, { ok: last.delivered || !issue.delivered, detail: last.error });
        return json({ ok: true, delivered: last.delivered, error: last.error });
      }
      case 'fix': {
        const out = await fixNow(locals.user, project, id, oneshot);
        return json(out);
      }
      case 'resend': {
        const issue = await resendAmend(project, id);
        return json({ ok: true, pending: !!issue.pendingAmend, error: issue.error || null });
      }
      default:
        error(400, 'Unknown action');
    }
  } catch (e) {
    if (e?.status) throw e;
    error(400, e.message);
  }
}
