// Saving and removing registry entries (projects.json, targets.json) through
// the console. Every entry is checked by schema.js before it is written, and
// every change goes to the audit log.
import * as config from './config.js';
import { validateProject, validateTarget } from './schema.js';
import { audit } from './audit.js';
import { invalidateStatus } from './live.js';
import { forgetInfo } from './controls.js';
import { forgetInspect } from './pve.js';

/** An error with an HTTP status the routes pass on. */
function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function needDeploy() {
  if (!config.DEPLOY_ENABLED) throw fail(404, 'Deploy targets are turned off (set CONSOLE_DEPLOY=1)');
}

export function listTargets() {
  needDeploy();
  return config.listTargets();
}

export function getTarget(id) {
  needDeploy();
  const t = config.getTarget(id);
  if (!t) throw fail(404, 'No such target');
  return t;
}

/** `id`: the entry being replaced (PUT); null for a new one (POST). */
export function storeTarget(user, input, id = null) {
  needDeploy();
  let t;
  try {
    t = validateTarget(input);
  } catch (e) {
    throw fail(400, e.message);
  }
  if (id && t.id !== id) throw fail(400, 'id: cannot be changed; remove the entry and add a new one');
  const exists = !!config.getTarget(t.id);
  if (!id && exists) throw fail(409, 'A target with this id already exists');
  if (id && !exists) throw fail(404, 'No such target');
  config.saveTarget(t, { replace: true });
  forgetInspect(t.id);
  audit(user, null, id ? 'target-save' : 'target-add', { target: t.id, pveHost: t.pveHost });
  return t;
}

export function removeTarget(user, id) {
  needDeploy();
  if (!config.deleteTarget(id)) throw fail(404, 'No such target');
  forgetInspect(id);
  audit(user, null, 'target-remove', { target: id });
}

export function listProjects() {
  return config.rawProjects();
}

export function getProject(id) {
  const p = config.rawProjects().find((e) => e.id === id);
  if (!p) throw fail(404, 'No such project');
  return p;
}

export function storeProject(user, input, id = null) {
  let p;
  try {
    p = validateProject(input, config.pathRoots());
  } catch (e) {
    throw fail(400, e.message);
  }
  if (id && p.id !== id) throw fail(400, 'id: cannot be changed; remove the entry and add a new one');
  const exists = config.rawProjects().some((e) => e.id === p.id);
  if (!id && exists) throw fail(409, 'A project with this id already exists');
  if (id && !exists) throw fail(404, 'No such project');
  config.saveProject(p, { replace: true });
  invalidateStatus(p.id);
  forgetInfo(p.id);
  audit(user, p.id, id ? 'project-save' : 'project-add', { ssh: p.ssh.alias || p.ssh.host });
  return p;
}

/** Removes the entry from the registry. The VM, its data and pulled files stay as they are. */
export function removeProject(user, id) {
  if (!config.deleteProject(id)) throw fail(404, 'No such project');
  invalidateStatus(id);
  forgetInfo(id);
  audit(user, id, 'project-remove', {});
}
