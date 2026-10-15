// node scripts/build.mjs — bundles src/ + data/projects into single-file pages:
//   dist/index.html     full HTML document (GitHub Pages, opening locally)
//   dist/artifact.html  page body without the document skeleton (claude.ai Artifact)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, listProjectIds, loadProject, validateProject } from './lib.mjs';

const order = (() => {
  const f = path.join(ROOT, 'data', 'projects.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
})();
const ids = listProjectIds().sort((a, b) => {
  const ia = order.indexOf(a), ib = order.indexOf(b);
  return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
});
const projects = ids.map(loadProject);
let bad = false;
for (const p of projects) {
  const { errors } = validateProject(p);
  errors.forEach(e => console.error('error:', e));
  if (errors.length) bad = true;
}
if (bad) { console.error('Build stopped: fix the errors above (node scripts/validate.mjs).'); process.exit(1); }

const read = f => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
const json = JSON.stringify(projects).replace(/</g, '\\u003c');
const body = read('index.html')
  .replace('/*STYLE*/', () => read('styles.css'))
  .replace('/*DATA*/', () => `window.GAMETREE_PROJECTS=${json};`)
  .replace('/*SCRIPT*/', () => read('app.js').replace(/<\/script/gi, '<\\/script'));

const dist = path.join(ROOT, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'artifact.html'), body);
fs.writeFileSync(path.join(dist, 'index.html'),
  `<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${body}\n</body>\n</html>\n`);
const kb = n => (n / 1024).toFixed(0) + ' KB';
console.log(`Built ${projects.length} project(s): ${ids.join(', ')} → dist/index.html (${kb(fs.statSync(path.join(dist, 'index.html')).size)})`);
