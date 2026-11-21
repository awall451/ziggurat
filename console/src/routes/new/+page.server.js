import { error } from '@sveltejs/kit';
import { DEPLOY_ENABLED, listTargets, listThemes, rawProjects } from '$lib/server/config.js';
import { listSources } from '$lib/server/bundle.js';
import { listDeploys } from '$lib/server/deploy.js';

export function load() {
  if (!DEPLOY_ENABLED) error(404, 'Creating projects from the console is turned off');
  return {
    targets: listTargets().map((t) => ({ id: t.id, name: t.name || t.id, vmidMin: t.vmidMin, vmidMax: t.vmidMax })),
    // Templates, and prepared team folders that are not registered projects.
    sources: listSources(rawProjects().map((p) => p.id)),
    themes: listThemes(),
    deploys: listDeploys()
  };
}
