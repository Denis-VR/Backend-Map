// Shared helpers: load projects from data/projects/<id>/ (project.json + trees/*.json) and validate them.
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const PROJECTS_DIR = path.join(ROOT, 'data', 'projects');

export function listProjectIds() {
  return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(PROJECTS_DIR, d.name, 'project.json')))
    .map(d => d.name);
}

export function loadProject(id) {
  const dir = path.join(PROJECTS_DIR, id);
  const project = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  project.trees = (project.trees || []).map(t => {
    if (typeof t === 'object') return t;
    const file = path.join(dir, 'trees', `${t}.json`);
    if (!fs.existsSync(file)) throw new Error(`${id}: tree file not found: trees/${t}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  });
  return project;
}

// A question is a string, {q, a, level, important} or a topic {topic, items: [...]} whose items are questions again.
function checkQuestions(list, fail, depth = 0) {
  if (!Array.isArray(list)) { fail('questions must be an array'); return; }
  for (const q of list) {
    if (q && typeof q === 'object' && 'level' in q && ![1, 2, 3, 4].includes(q.level)) fail(`"${q.q || q.topic}": level must be 1, 2, 3 or 4`);
    if (typeof q === 'string' || (q && typeof q.q === 'string')) continue;
    if (q && typeof q.topic === 'string') {
      if (depth > 6) fail(`topic "${q.topic}" is nested too deep`);
      checkQuestions(q.items || [], fail, depth + 1);
      continue;
    }
    fail('question must be a string, {q, a} or {topic, items}');
  }
}
export function countQuestions(list) {
  return (list || []).reduce((s, q) => s + (q && typeof q === 'object' && 'topic' in q ? countQuestions(q.items) : 1), 0);
}

export function validateProject(p) {
  const errors = [], warnings = [];
  const where = `[${p.id || '?'}]`;
  if (!p.id || !/^[a-z0-9][a-z0-9-]*$/.test(p.id)) errors.push(`${where} project.id must be a lowercase slug`);
  if (!p.title) errors.push(`${where} project.title is required`);
  if (!Array.isArray(p.trees) || !p.trees.length) errors.push(`${where} project needs at least one tree`);
  const ids = new Map(), treeIds = new Set();
  for (const t of p.trees || []) {
    if (!t.id || !/^[a-z0-9][a-z0-9-]*$/.test(t.id)) errors.push(`${where} tree id "${t.id}" must be a lowercase slug`);
    if (treeIds.has(t.id)) errors.push(`${where} duplicate tree id ${t.id}`);
    treeIds.add(t.id);
    if (!t.title) errors.push(`${where} tree ${t.id}: title is required`);
    if (t.color && !/^#[0-9a-fA-F]{6}$/.test(t.color)) errors.push(`${where} tree ${t.id}: color must be #rrggbb`);
    if (!Array.isArray(t.nodes)) { errors.push(`${where} tree ${t.id}: nodes must be an array`); continue; }
    for (const n of t.nodes) {
      if (!n.id || !/^[a-z0-9][a-z0-9.-]*$/.test(n.id)) errors.push(`${where} node id "${n.id}" must match [a-z0-9.-]`);
      if (ids.has(n.id)) errors.push(`${where} duplicate node id ${n.id}`);
      ids.set(n.id, n);
      if (!n.title) errors.push(`${where} node ${n.id}: title is required`);
      checkQuestions(n.questions || [], msg => errors.push(`${where} node ${n.id}: ${msg}`));
      for (const r of n.resources || []) if (!r.url) errors.push(`${where} node ${n.id}: resource without url`);
    }
  }
  for (const n of ids.values()) {
    for (const k of ['requires', 'requiresAny']) for (const r of n[k] || []) {
      if (!ids.has(r)) errors.push(`${where} node ${n.id}: ${k} references unknown node ${r}`);
      if (r === n.id) errors.push(`${where} node ${n.id} requires itself`);
    }
    if (!countQuestions(n.questions || [])) warnings.push(`${where} node ${n.id} has no questions`);
  }
  // cycle check
  const state = new Map();
  const visit = (id, stack) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) { errors.push(`${where} dependency cycle: ${[...stack, id].join(' -> ')}`); return; }
    state.set(id, 1);
    const n = ids.get(id);
    for (const r of [...(n.requires || []), ...(n.requiresAny || [])]) if (ids.has(r)) visit(r, [...stack, id]);
    state.set(id, 2);
  };
  for (const id of ids.keys()) visit(id, []);
  return { errors, warnings, nodes: ids.size };
}
