// Display names for agents. Agent ids are fixed by the kit (area-lead-*,
// builder, scout, reviewer, qa); a theme only changes the words. A project may
// map older ids onto the official ones with `agentAliases`.
import fs from 'node:fs';
import path from 'node:path';
import { THEMES_DIR } from './config.js';

const PLAIN = {
  lead: 'lead',
  area_lead: 'area lead',
  area_leads: 'area leads',
  worker: 'builder',
  workers: 'builders',
  scout: 'scout',
  scouts: 'scouts',
  reviewer: 'reviewer',
  qa: 'QA'
};

const cache = new Map();

/** Themes are flat `key: value` files; anything after # is a comment. */
export function loadTheme(name) {
  if (!/^[a-z0-9-]{1,40}$/.test(name || '')) return PLAIN;
  if (cache.has(name)) return cache.get(name);
  const theme = { ...PLAIN };
  try {
    for (const line of fs.readFileSync(path.join(THEMES_DIR, `${name}.yml`), 'utf8').split('\n')) {
      const m = /^([a-z_]+):\s*(.*?)\s*(?:#.*)?$/.exec(line);
      if (m && m[1] in PLAIN && m[2]) theme[m[1]] = m[2];
    }
  } catch {
    /* unknown theme: plain words */
  }
  cache.set(name, theme);
  return theme;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Returns a function (agentType, depth) -> {label, kind, rawType}.
 * kind is one of lead | area_lead | worker | scout | reviewer | qa | other
 * and drives the icon and shape; unknown ids keep their raw name.
 */
export function makeLabeler(project) {
  const theme = loadTheme(project.theme);
  const aliases = project.agentAliases || {};
  return (agentType, depth) => {
    const official = aliases[agentType] || agentType;
    let kind = 'other';
    let label = agentType;
    if (official === 'lead') {
      kind = 'lead';
      label = cap(theme.lead);
    } else if (official.startsWith('area-lead-')) {
      kind = 'area_lead';
      label = `${cap(theme.area_lead)} · ${official.slice('area-lead-'.length)}`;
    } else if (official === 'builder') {
      kind = 'worker';
      label = cap(theme.worker);
    } else if (official === 'scout') {
      kind = 'scout';
      label = cap(theme.scout);
    } else if (official === 'reviewer') {
      kind = 'reviewer';
      label = cap(theme.reviewer);
    } else if (official === 'qa') {
      kind = 'qa';
      label = cap(theme.qa);
    }
    return { label, kind, rawType: agentType, tier: Math.min(depth, 2) };
  };
}

/** Names of the three tiers, for the terrace bands and project cards. */
export function tierNames(project) {
  const t = loadTheme(project.theme);
  return [cap(t.lead), cap(t.area_leads), cap(t.workers)];
}
