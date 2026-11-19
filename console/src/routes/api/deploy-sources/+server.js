import { error, json } from '@sveltejs/kit';
import { DEPLOY_ENABLED } from '$lib/server/config.js';
import { checkBundle, listSources } from '$lib/server/bundle.js';

// Without parameters: what a project can start from. With kind and id: a
// read-only check of that one bundle (problems, team, charter, provisioning script).
export function GET({ url }) {
  if (!DEPLOY_ENABLED) error(404, 'Not found');
  const kind = url.searchParams.get('kind');
  if (!kind) return json({ sources: listSources() });
  return json(checkBundle({ kind, id: url.searchParams.get('id') || '' }));
}
