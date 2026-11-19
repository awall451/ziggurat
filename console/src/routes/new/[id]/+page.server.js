import { error } from '@sveltejs/kit';
import { getDeploy } from '$lib/server/deploy.js';
import { readRun, runDir } from '$lib/server/runner.js';
import { readFrom } from '$lib/server/events.js';
import path from 'node:path';

export function load({ params }) {
  let deploy;
  try {
    deploy = getDeploy(params.id);
  } catch (e) {
    error(e.status || 500, e.message);
  }
  // The latest run's events so far; the page continues from `next` over the live stream.
  let run = null;
  let events = [];
  let next = 0;
  if (deploy.lastRun) {
    run = readRun(deploy.id, deploy.lastRun);
    const got = readFrom(path.join(runDir(deploy.id, deploy.lastRun), 'events.jsonl'), 0);
    events = got.events.map((e) => e.event);
    next = got.next;
  }
  return { deploy, run, events, next };
}
