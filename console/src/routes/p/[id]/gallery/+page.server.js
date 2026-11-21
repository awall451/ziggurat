import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { gallery, galleryCycles } from '$lib/server/aggregate.js';
import { peekStatus } from '$lib/server/live.js';
import { screenIndex } from '$lib/server/issues.js';

export function load({ params }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const st = peekStatus(project.id);
  const live = st?.leadActive && st.session && st.sessionStart ? { session: st.session, start: st.sessionStart, kind: st.oneshot?.plan ? 'plan' : st.oneshot ? 'oneshot' : 'normal' } : null;
  // Cycles (kit 0.13: every merged build, by sha), then the older day folders.
  const cycles = galleryCycles(project, live).map((c) => ({
    key: c.key,
    kind: c.kind,
    number: c.number,
    start: c.start,
    live: c.live,
    builds: c.builds.map((b) => ({ folder: b.sha, sha: b.sha, topic: b.topic, at: b.at, files: b.files }))
  }));
  const days = gallery(project).map((d) => ({ key: `day:${d.date}`, kind: 'day', date: d.date, builds: [{ folder: d.date, sha: null, topic: null, at: null, files: d.files }] }));
  return { sets: [...cycles, ...days], issues: screenIndex(project) };
}
