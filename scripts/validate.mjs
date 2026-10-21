// node scripts/validate.mjs [--quiet]  — checks every project in data/projects
import { listProjectIds, loadProject, validateProject, countQuestions } from './lib.mjs';

const quiet = process.argv.includes('--quiet');
let failed = false;
for (const id of listProjectIds()) {
  let p;
  try { p = loadProject(id); } catch (e) { console.error(`✗ ${id}: ${e.message}`); failed = true; continue; }
  const { errors, warnings, nodes } = validateProject(p);
  if (p.id !== id) errors.push(`[${id}] project.id "${p.id}" must match its folder name`);
  const qs = p.trees.reduce((s, t) => s + t.nodes.reduce((a, n) => a + countQuestions(n.questions), 0), 0);
  console.log(`${errors.length ? '✗' : '✓'} ${id}: ${p.trees.length} trees, ${nodes} nodes, ${qs} questions`);
  errors.forEach(e => console.error('  error:', e));
  if (!quiet) warnings.forEach(w => console.warn('  warn:', w));
  if (errors.length) failed = true;
}
process.exit(failed ? 1 : 0);
