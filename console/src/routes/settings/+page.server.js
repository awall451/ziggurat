import { DEPLOY_ENABLED, listTargets, listThemes, rawProjects } from '$lib/server/config.js';

export function load() {
  return {
    deploy: DEPLOY_ENABLED,
    projects: rawProjects(),
    targets: DEPLOY_ENABLED ? listTargets() : [],
    themes: listThemes()
  };
}
