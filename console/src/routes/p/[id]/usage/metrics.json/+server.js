import { error, json } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { readMetrics, weekly } from '$lib/server/metrics.js';

/** The history of runs as data: one entry per finished run, and the weekly figures the Usage tab shows. */
export function GET({ params }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const runs = readMetrics(project);
  return json({ project: project.id, runs, weekly: weekly(runs) });
}
