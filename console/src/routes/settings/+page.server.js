import { DEPLOY_ENABLED, listTargets, listThemes, rawProjects } from '$lib/server/config.js';
import { avatarUrl } from '$lib/server/avatar.js';

export function load() {
  const projects = rawProjects();
  return {
    deploy: DEPLOY_ENABLED,
    projects,
    // Each project's picture (its tile), where the owner uploaded one.
    avatars: Object.fromEntries(projects.map((p) => [p.id, avatarUrl(p.id)])),
    targets: DEPLOY_ENABLED ? listTargets() : [],
    themes: listThemes()
  };
}
