/* GameTree: a global skill tree with XMind-style editing and a mind map inside every skill.
 * Data: window.GAMETREE_PROJECTS (bundled by scripts/build.mjs).
 * Persistence: localStorage, plus the artifact `db` capability when the page runs on claude.ai. */
(function () {
  'use strict';

  // ------------------------------------------------------------------ utils
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = o => JSON.parse(JSON.stringify(o));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const now = () => Date.now();
  const DAY = 86400000;
  const REVIEW_AFTER_DAYS = 21;
  const BUILTIN = Array.isArray(window.GAMETREE_PROJECTS) ? window.GAMETREE_PROJECTS : [];
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isNarrow = () => window.innerWidth <= 640;
  const PALETTE = ['#39c5cf', '#e0a458', '#9b8cf2', '#7fc79a', '#e06c61', '#5aa9e6', '#d9b36c', '#e47fb0', '#8fb3a0', '#c792ea'];

  const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya' };
  function slug(s) {
    return String(s || '').toLowerCase().split('').map(c => TRANSLIT[c] ?? c).join('')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'item';
  }

  // Questions: a string, {q, a}, or a topic {topic, items: [...]} that nests further.
  const isTopic = q => !!q && typeof q === 'object' && typeof q.topic === 'string';
  const qText = q => (typeof q === 'string' ? q : (isTopic(q) ? q.topic : q.q));
  const qAns = q => (typeof q === 'string' || isTopic(q) ? '' : (q.a || ''));
  function flatQ(list, path = [], group = []) {
    const out = [];
    (list || []).forEach((q, i) => {
      if (isTopic(q)) out.push(...flatQ(q.items, [...path, i], [...group, q.topic]));
      else if (q) out.push({ q: qText(q), a: qAns(q), path: [...path, i], group: group.join(' / ') });
    });
    return out;
  }

  function autoAbbr(title) {
    const t = String(title || '').trim();
    const latin = t.match(/\b[A-Z][A-Za-z0-9+#]{1,3}\b/);
    if (latin) return latin[0];
    const words = t.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    if (words.length === 1) { const w = words[0]; return w[0].toUpperCase() + w.slice(1, 3); }
    return words.slice(0, 3).map(w => w[0].toUpperCase()).join('');
  }
  const abbrOf = n => (n.abbr ? String(n.abbr) : autoAbbr(n.title)).slice(0, 5);
  const abbrSize = s => ({ 1: 15, 2: 14, 3: 12.5, 4: 11, 5: 9.5 }[s.length] || 9.5);

  // ------------------------------------------------------------------ storage
  // Every value is stored as {at, v}. Local copy always; remote (artifact db) when available, newest wins.
  const Store = {
    db: null, uid: null, timers: {}, chains: {},
    lsGet(k) { try { return JSON.parse(localStorage.getItem('gametree:' + k)); } catch (e) { return null; } },
    lsSet(k, rec) { try { localStorage.setItem('gametree:' + k, JSON.stringify(rec)); } catch (e) { /* storage unavailable */ } },
    lsDel(k) { try { localStorage.removeItem('gametree:' + k); } catch (e) { /* ignore */ } },
    ref(k) { return this.db.doc('data/users/' + this.uid + '/kv/' + k); },
    async get(k) {
      const local = this.lsGet(k);
      if (!this.db) return local ? local.v : null;
      let remote = null;
      try { const s = await this.ref(k).get(); if (s.exists) remote = s.data(); } catch (e) { /* offline */ }
      if (remote && (!local || (remote.at || 0) >= (local.at || 0))) { this.lsSet(k, remote); return remote.v; }
      if (local) this.push(k, local);
      return local ? local.v : null;
    },
    set(k, v) {
      const rec = { at: now(), v };
      this.lsSet(k, rec);
      if (!this.db) return;
      clearTimeout(this.timers[k]);
      this.timers[k] = setTimeout(() => this.push(k, rec), 700);
    },
    push(k, rec) {
      const prev = this.chains[k] || Promise.resolve();
      this.chains[k] = prev.then(() => this.ref(k).set(clone(rec))).catch(() => { /* keep local copy */ });
    },
    del(k) {
      this.lsDel(k);
      clearTimeout(this.timers[k]);
      if (this.db) { const prev = this.chains[k] || Promise.resolve(); this.chains[k] = prev.then(() => this.ref(k).delete()).catch(() => {}); }
    }
  };

  // ------------------------------------------------------------------ state
  const S = {
    customIndex: [],      // [{id,title}] user-created projects
    project: null,
    pid: null,
    progress: null,       // {nodes:{id:{s,t,rv,known:[], notes}}, reviews:{}}
    prefs: {},
    idx: new Map(),       // node id -> {n, t}
    layout: null,
    view: { x: 0, y: 0, k: 0.5 },
    mapView: null,        // map view saved while inside a skill
    sel: null,            // selected node id, or '__core'
    selTree: null,
    inner: null,          // {id, sel: path|null, collapsed: Set, items}
    search: '',
    undo: [], redo: [],
    fresh: new Set(),     // ids created in this session and not renamed yet (id follows the first name)
    anim: false,
    sample: null,
    downloads: null
  };

  const app = $('#app'), svg = $('#map'), world = $('#world'), innerG = $('#inner');
  const L_BG = $('#layer-bg'), L_EDGES = $('#layer-edges'), L_LINK = $('#layer-link'), L_NODES = $('#layer-nodes'), L_FX = $('#layer-fx');
  const I_EDGES = $('#inner-edges'), I_NODES = $('#inner-nodes');
  const panel = $('#panel'), panelBody = $('#panelBody');

  // ------------------------------------------------------------------ project model
  function indexProject() {
    S.idx = new Map();
    for (const t of S.project.trees) for (const n of t.nodes) S.idx.set(n.id, { n, t });
  }
  const isBuiltin = id => BUILTIN.some(p => p.id === id);
  const builtin = id => BUILTIN.find(p => p.id === id);
  const treeById = id => S.project.trees.find(t => t.id === id);

  function nodeProg(id) { return S.progress.nodes[id] || null; }
  function isMastered(id) { const p = nodeProg(id); return !!p && p.s === 'mastered'; }
  function reqs(n) { return (n.requires || []).filter(r => S.idx.has(r)); }
  function reqsAny(n) { return (n.requiresAny || []).filter(r => S.idx.has(r)); }
  function unlocked(n) {
    const any = reqsAny(n);
    return reqs(n).every(isMastered) && (any.length === 0 || any.some(isMastered));
  }
  function nodeState(id) {
    const e = S.idx.get(id); if (!e) return 'locked';
    const p = nodeProg(id);
    if (p && p.s === 'mastered') return 'mastered';
    if (p && p.s === 'learning') return 'learning';
    return unlocked(e.n) ? 'available' : 'locked';
  }
  function knownSet(id) { const p = nodeProg(id); return new Set(p && p.known ? p.known : []); }
  function qStats(id) {
    const e = S.idx.get(id); if (!e) return { total: 0, known: 0 };
    const k = knownSet(id), all = flatQ(e.n.questions);
    return { total: all.length, known: all.filter(x => k.has(x.q)).length };
  }
  function needsReview(id) {
    const p = nodeProg(id); if (!p || p.s !== 'mastered') return false;
    return now() - Math.max(p.t || 0, p.rv || 0) > REVIEW_AFTER_DAYS * DAY;
  }
  function dependents(id) {
    const out = [];
    S.idx.forEach(({ n }) => { if ((n.requires || []).includes(id) || (n.requiresAny || []).includes(id)) out.push(n.id); });
    return out;
  }
  function ancestors(id, acc = new Set()) {
    const e = S.idx.get(id); if (!e) return acc;
    for (const r of [...reqs(e.n), ...reqsAny(e.n)]) if (!acc.has(r)) { acc.add(r); ancestors(r, acc); }
    return acc;
  }

  // XP & levels
  function computeXP() {
    let xp = 0;
    S.idx.forEach(({ n }, id) => {
      const p = nodeProg(id); if (!p) return;
      if (p.s === 'mastered') xp += n.keystone ? 150 : 100;
      if (p.known) xp += 10 * p.known.length;
    });
    return xp;
  }
  const levelOf = xp => Math.floor(Math.sqrt(xp / 60)) + 1;
  const xpFor = lvl => 60 * (lvl - 1) * (lvl - 1);
  function levelTitle(l) {
    if (l <= 2) return 'Стажёр';
    if (l <= 5) return 'Junior';
    if (l <= 9) return 'Middle';
    if (l <= 13) return 'Senior';
    if (l <= 16) return 'Lead';
    return 'Архитектор';
  }

  // ------------------------------------------------------------------ layout (radial)
  const RING0 = 240, RING_GAP = 175;
  const ringR = d => RING0 + (d - 1) * RING_GAP;
  const nodeR = n => (n.keystone ? 25 : 21);

  function computeLayout() {
    const trees = S.project.trees;
    const depth = new Map(), visiting = new Set();
    const d = id => {
      if (depth.has(id)) return depth.get(id);
      const e = S.idx.get(id); if (!e) return 0;
      if (visiting.has(id)) return 1;
      visiting.add(id);
      let v = 1;
      for (const r of reqs(e.n)) v = Math.max(v, d(r) + 1);
      const any = reqsAny(e.n);
      if (any.length) v = Math.max(v, Math.min(...any.map(d)) + 1);
      visiting.delete(id); depth.set(id, v);
      return v;
    };
    S.idx.forEach((_, id) => d(id));

    const info = trees.map(t => {
      const layers = new Map();
      for (const n of t.nodes) { const dd = depth.get(n.id); if (!layers.has(dd)) layers.set(dd, []); layers.get(dd).push(n.id); }
      let w = 1; layers.forEach(l => { w = Math.max(w, l.length); });
      return { t, layers, w: Math.max(1.6, w * 0.9 + Math.sqrt(t.nodes.length) * 0.4) };
    });
    const W = info.reduce((s, i) => s + i.w, 0) || 1;
    let a0 = -Math.PI / 2 - (info.length ? Math.PI * info[0].w / W : 0);
    for (const i of info) { i.a0 = a0; i.span = 2 * Math.PI * i.w / W; i.a1 = a0 + i.span; i.mid = a0 + i.span / 2; a0 = i.a1; }

    const pos = new Map(), ang = new Map();
    let maxD = 1; depth.forEach(v => { maxD = Math.max(maxD, v); });
    for (let dd = 1; dd <= maxD; dd++) {
      for (const i of info) {
        const ids = i.layers.get(dd); if (!ids) continue;
        const r = ringR(dd);
        const pad = Math.min(0.05, i.span * 0.08);
        const lo = i.a0 + pad, hi = i.a1 - pad, avail = Math.max(0.01, hi - lo);
        const want = 125 / r;
        const bary = id => {
          const e = S.idx.get(id).n;
          const ps = [...reqs(e), ...reqsAny(e)].filter(x => ang.has(x));
          if (!ps.length) return i.mid;
          let s = 0;
          for (const x of ps) { let a = ang.get(x); while (a - i.mid > Math.PI) a -= 2 * Math.PI; while (a - i.mid < -Math.PI) a += 2 * Math.PI; s += a; }
          return s / ps.length;
        };
        const items = ids.map((id, k) => ({ id, k, b: bary(id) })).sort((a, b) => a.b - b.b || a.k - b.k);
        const n = items.length;
        const tight = want * n > avail;
        const step = tight ? avail / n : want;
        const gw = step * (n - 1);
        let c = items.reduce((s, x) => s + x.b, 0) / n;
        c = clamp(c, lo + gw / 2, hi - gw / 2);
        items.forEach((it, k) => {
          const a = c - gw / 2 + k * step;
          const rr = r + (tight ? (k % 2 ? 62 : -10) : 0);
          ang.set(it.id, a);
          pos.set(it.id, { x: Math.cos(a) * rr, y: Math.sin(a) * rr });
        });
      }
    }
    S.idx.forEach(({ n }, id) => { if (n.pos && Number.isFinite(n.pos.x) && Number.isFinite(n.pos.y)) pos.set(id, { x: n.pos.x, y: n.pos.y }); });

    const sectors = info.map(i => {
      const ds = [...i.layers.keys()];
      let rMax = ringR(ds.length ? Math.max(...ds) : 1) + 110;
      for (const n of i.t.nodes) { const p = pos.get(n.id); if (p) rMax = Math.max(rMax, Math.hypot(p.x, p.y) + 100); }
      return { t: i.t, a0: i.a0, a1: i.a1, mid: i.mid, rMax };
    });
    S.layout = { pos, depth, sectors, maxD };
  }

  // ------------------------------------------------------------------ render: map
  const polar = (r, a) => [Math.cos(a) * r, Math.sin(a) * r];
  const f1 = v => v.toFixed(1);
  function hexPts(r) {
    const pts = [];
    for (let i = 0; i < 6; i++) { const a = -Math.PI / 2 + i * Math.PI / 3; pts.push(f1(Math.cos(a) * r) + ',' + f1(Math.sin(a) * r)); }
    return pts.join(' ');
  }
  function wrapLabel(t, max = 18) {
    const words = String(t).split(' '); const lines = []; let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
    }
    if (cur) lines.push(cur);
    if (lines.length > 2) { lines[1] = lines.slice(1).join(' '); lines.length = 2; }
    if (lines[1] && lines[1].length > max + 2) lines[1] = lines[1].slice(0, max + 1) + '…';
    return lines;
  }
  function arcPath(r, a0, a1, sweep = 1) {
    const [x0, y0] = polar(r, a0), [x1, y1] = polar(r, a1);
    return `M${f1(x0)},${f1(y0)} A${r},${r} 0 ${Math.abs(a1 - a0) > Math.PI ? 1 : 0} ${sweep} ${f1(x1)},${f1(y1)}`;
  }

  function renderBg() {
    const { sectors, maxD } = S.layout;
    let h = '';
    for (let d = 1; d <= maxD; d++) h += `<circle class="ring" r="${ringR(d)}"/>`;
    for (const s of sectors) {
      const c = esc(s.t.color || '#8f939e');
      const [x0, y0] = polar(108, s.a0), [X0, Y0] = polar(s.rMax + 14, s.a0);
      h += `<line class="divider" x1="${f1(x0)}" y1="${f1(y0)}" x2="${f1(X0)}" y2="${f1(Y0)}"/>`;
      const g = Math.min(0.02, (s.a1 - s.a0) * 0.06);
      h += `<path class="rim" style="--c:${c}" d="${arcPath(s.rMax, s.a0 + g, s.a1 - g)}"/>`;
      const lr = s.rMax + 34;
      const lower = Math.sin(s.mid) > 0.15;
      h += `<path id="arc-${esc(s.t.id)}" fill="none" d="${lower ? arcPath(lr, s.a1, s.a0, 0) : arcPath(lr, s.a0, s.a1, 1)}"/>`;
      const arc = lr * (s.a1 - s.a0) * 0.9, chars = Math.max(4, s.t.title.length);
      const fs = Math.min(22, arc / (chars * 1.02)), fsFar = Math.min(56, arc / (chars * 1.02));
      h += `<text class="sector-label" dy="${lower ? '0.95em' : '0'}" style="--c:${c};--fs:${f1(fs)}px;--fs-far:${f1(fsFar)}px"><textPath href="#arc-${esc(s.t.id)}" startOffset="50%" text-anchor="middle">${esc(s.t.title)}</textPath></text>`;
    }
    L_BG.innerHTML = h;
  }

  function edgeClass(from, to) {
    const fm = from === '__core' || isMastered(from);
    if (fm && nodeState(to) === 'mastered') return 'e-done';
    if (fm) return 'e-open';
    return 'e-locked';
  }
  function edgePath(a, b) {
    const r1 = Math.hypot(a.x, a.y), r2 = Math.hypot(b.x, b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, mr = Math.hypot(mx, my);
    if (mr < 40) return `M${f1(a.x)},${f1(a.y)} L${f1(b.x)},${f1(b.y)}`;
    const k = (r1 + r2) / 2 / mr;
    const cx = mx + (mx * k - mx) * 0.85, cy = my + (my * k - my) * 0.85;
    return `M${f1(a.x)},${f1(a.y)} Q${f1(cx)},${f1(cy)} ${f1(b.x)},${f1(b.y)}`;
  }

  function highlightSet() {
    if (S.search) return { nodes: new Set(searchNodes(S.search).map(r => r.id)) };
    if (S.selTree) { const t = treeById(S.selTree); return t ? { nodes: new Set(t.nodes.map(n => n.id)), tree: t.id } : null; }
    if (!S.sel || !S.idx.has(S.sel)) return null;
    const anc = ancestors(S.sel);
    return { nodes: new Set([S.sel, ...anc, ...dependents(S.sel)]), anc };
  }

  function renderEdges() {
    const pos = S.layout.pos, hl = highlightSet();
    const core = { x: 0, y: 0 };
    let h = '';
    S.idx.forEach(({ n, t }, id) => {
      const b = pos.get(id); if (!b) return;
      const rs = reqs(n), ra = reqsAny(n), c = esc(t.color);
      const lit = from => !!hl && (hl.tree ? t.id === hl.tree
        : hl.nodes.has(id) && hl.nodes.has(from) && (id === S.sel || from === S.sel || (hl.anc && hl.anc.has(from) && (hl.anc.has(id) || id === S.sel))));
      if (!rs.length && !ra.length) h += `<path class="edge ${edgeClass('__core', id)}${hl && hl.nodes.has(id) ? ' hl' : ''}" style="--c:${c}" d="${edgePath(core, b)}"/>`;
      for (const r of rs) { const a = pos.get(r); if (a) h += `<path class="edge ${edgeClass(r, id)}${lit(r) ? ' hl' : ''}" style="--c:${c}" d="${edgePath(a, b)}"/>`; }
      for (const r of ra) { const a = pos.get(r); if (a) h += `<path class="edge e-any ${edgeClass(r, id)}${lit(r) ? ' hl' : ''}" style="--c:${c}" d="${edgePath(a, b)}"/>`; }
    });
    L_EDGES.innerHTML = h;
  }

  function nodeSvg(id) {
    const { n, t } = S.idx.get(id);
    const p = S.layout.pos.get(id); if (!p) return '';
    const st = nodeState(id), R = nodeR(n), ks = !!n.keystone;
    const { total, known } = qStats(id);
    const pct = total ? Math.round(100 * known / total) : 0;
    const ab = abbrOf(n);
    const lines = wrapLabel(n.title);
    const label = lines.map((l, i) => `<tspan x="0" dy="${i ? '1.2em' : 0}">${esc(l)}</tspan>`).join('');
    const pr = R + (ks ? 9 : 5);
    return `<g class="node s-${st}${ks ? ' ks' : ''}${S.sel === id ? ' sel' : ''}" data-id="${esc(id)}" transform="translate(${f1(p.x)},${f1(p.y)})" style="--c:${esc(t.color)}">
      <circle class="hit" r="${R + 12}"/>
      ${ks ? `<polygon class="halo" points="${hexPts(R + 11)}"/><polygon class="shape-out" points="${hexPts(R + 5)}"/><polygon class="shape" points="${hexPts(R)}"/>`
        : `<circle class="halo" r="${R + 7}"/><circle class="shape" r="${R}"/>`}
      ${pct && st !== 'locked' && st !== 'mastered' ? `<circle class="prog-bg" r="${pr}"/><circle class="prog" r="${pr}" pathLength="100" stroke-dasharray="${pct} 100" transform="rotate(-90)"/>` : ''}
      <text class="abbr" dy="0.36em" style="--afs:${abbrSize(ab) + (ks ? 1 : 0)}px">${esc(ab)}</text>
      ${needsReview(id) ? `<circle class="due" cx="${f1(R * 0.78)}" cy="${f1(-R * 0.78)}" r="4"/>` : ''}
      <circle class="ring-sel" r="${R + (ks ? 13 : 9)}"/>
      <text class="lbl" y="${R + (ks ? 24 : 20)}">${label}</text>
    </g>`;
  }

  function knobPos(id) {
    const p = S.layout.pos.get(id), n = S.idx.get(id).n;
    const len = Math.hypot(p.x, p.y) || 1, d = nodeR(n) + (n.keystone ? 22 : 17);
    return { x: p.x + p.x / len * d, y: p.y + p.y / len * d };
  }

  function renderNodes() {
    const hl = highlightSet();
    const ct = S.project.center?.title || S.project.title;
    const total = S.idx.size, m = [...S.idx.keys()].filter(isMastered).length;
    let ticks = '';
    for (let i = 0; i < 48; i++) { const a = i / 48 * Math.PI * 2, r0 = i % 4 ? 85 : 82; ticks += `<line class="core-tick" x1="${f1(Math.cos(a) * r0)}" y1="${f1(Math.sin(a) * r0)}" x2="${f1(Math.cos(a) * 88)}" y2="${f1(Math.sin(a) * 88)}"/>`; }
    let h = `<g class="core${S.sel === '__core' ? ' sel' : ''}" data-core="1"><circle class="core-halo" r="98"/>${ticks}<circle class="core-ring" r="76"/><circle class="core-disc" r="70"/>
      <text class="core-title" y="3" style="font-size:${f1(Math.min(17, 150 / Math.max(4, ct.length * 1.25)))}px">${esc(ct)}</text>
      <text class="core-sub" y="24">${m} / ${total}</text></g>`;
    S.idx.forEach((_, id) => { h += nodeSvg(id); });
    if (S.sel && S.idx.has(S.sel) && !S.inner) {
      const k = knobPos(S.sel);
      h += `<g class="knob" transform="translate(${f1(k.x)},${f1(k.y)})"><title>Тяни к навыку, чтобы связать. Клик добавляет следующий навык</title><circle r="9"/><path d="M-4 0h8M0 -4v8"/></g>`;
    }
    L_NODES.innerHTML = h;
    svg.classList.toggle('focus', !!hl);
    if (hl) $$('.node', L_NODES).forEach(g => g.classList.toggle('hl', hl.nodes.has(g.dataset.id)));
  }

  function renderMap() { renderBg(); renderEdges(); renderNodes(); }
  function refreshMap() { renderEdges(); renderNodes(); }

  // ------------------------------------------------------------------ stars + view
  const starCanvas = $('#stars');
  let stars = [];
  function seedStars() {
    let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    stars = Array.from({ length: 220 }, () => ({ x: rnd(), y: rnd(), r: rnd() * 1.1 + 0.2, a: rnd() * 0.45 + 0.08, d: rnd() * 0.5 + 0.1 }));
  }
  function drawStars() {
    const dpr = window.devicePixelRatio || 1;
    const w = starCanvas.clientWidth, h = starCanvas.clientHeight;
    if (starCanvas.width !== Math.round(w * dpr) || starCanvas.height !== Math.round(h * dpr)) { starCanvas.width = Math.round(w * dpr); starCanvas.height = Math.round(h * dpr); }
    const ctx = starCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#dfe3f2';
    for (const st of stars) {
      const x = ((st.x * w * 1.5 + S.view.x * st.d * 0.2) % (w * 1.5) + w * 1.5) % (w * 1.5) - w * 0.25;
      const y = ((st.y * h * 1.5 + S.view.y * st.d * 0.2) % (h * 1.5) + h * 1.5) % (h * 1.5) - h * 0.25;
      ctx.globalAlpha = st.a;
      ctx.beginPath(); ctx.arc(x, y, st.r, 0, Math.PI * 2); ctx.fill();
    }
  }
  function applyView() {
    const v = S.view;
    (S.inner ? innerG : world).setAttribute('transform', `translate(${v.x.toFixed(2)},${v.y.toFixed(2)}) scale(${v.k.toFixed(4)})`);
    svg.classList.toggle('far', !S.inner && v.k < 0.42);
    drawStars();
    positionInline();
  }
  let viewAnim = 0;
  function animateView(target, ms = 520, ease = 'out') {
    cancelAnimationFrame(viewAnim);
    if (reduceMotion() || ms <= 0) { S.view = { ...target }; applyView(); return Promise.resolve(); }
    const from = { ...S.view }, t0 = performance.now();
    const fn = ease === 'in' ? p => p * p * p : ease === 'inout' ? p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2) : p => 1 - Math.pow(1 - p, 3);
    return new Promise(res => {
      const step = t => {
        const p = Math.min(1, (t - t0) / ms), e = fn(p);
        S.view = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e };
        applyView();
        if (p < 1) viewAnim = requestAnimationFrame(step); else res();
      };
      viewAnim = requestAnimationFrame(step);
    });
  }
  // Free screen area: the part of the map not covered by the panel.
  function viewport() {
    const r = svg.getBoundingClientRect();
    const box = { x: 0, y: 0, w: r.width, h: r.height };
    if (!panel.hidden) {
      const pr = panel.getBoundingClientRect();
      if (isNarrow()) box.h = Math.max(160, pr.top - r.top);
      else box.w = Math.max(200, pr.left - r.left);
    }
    return box;
  }
  function viewFor(x, y, k) {
    const b = viewport();
    return { k, x: b.x + b.w / 2 - x * k, y: b.y + b.h / 2 + (isNarrow() ? 30 : 10) - y * k };
  }
  const flyTo = (x, y, k, ms, ease) => animateView(viewFor(x, y, k), ms, ease);
  function fitAll(animate = true) {
    const b = viewport();
    let R = 400; S.layout.sectors.forEach(s => { R = Math.max(R, s.rMax + 70); });
    const k = clamp(Math.min(b.w, b.h - 90) / (2 * R), 0.06, 1.2);
    return animate ? flyTo(0, 0, k) : animateView(viewFor(0, 0, k), 0);
  }
  function zoomAt(f, sx, sy) {
    const v = S.view, k = clamp(v.k * f, S.inner ? 0.2 : 0.05, 3);
    const wx = (sx - v.x) / v.k, wy = (sy - v.y) / v.k;
    S.view = { k, x: sx - wx * k, y: sy - wy * k };
    applyView();
  }
  function zoomCenter(f) { const b = viewport(); zoomAt(f, b.x + b.w / 2, b.y + b.h / 2); }
  function toWorld(cx, cy) { const r = svg.getBoundingClientRect(); return { x: (cx - r.left - S.view.x) / S.view.k, y: (cy - r.top - S.view.y) / S.view.k }; }
  function toScreen(x, y) { const r = svg.getBoundingClientRect(); return { x: r.left + S.view.x + x * S.view.k, y: r.top + S.view.y + y * S.view.k }; }
  // Pan just enough to show a world-space box.
  function ensureVisible(x, y, w = 0, h = 0) {
    const b = viewport(), r = svg.getBoundingClientRect(), m = 70;
    const a = toScreen(x, y), z = toScreen(x + w, y + h);
    const ax = a.x - r.left, ay = a.y - r.top, zx = z.x - r.left, zy = z.y - r.top;
    let dx = 0, dy = 0;
    if (ax < b.x + m) dx = b.x + m - ax; else if (zx > b.x + b.w - m) dx = b.x + b.w - m - zx;
    if (ay < b.y + m + 40) dy = b.y + m + 40 - ay; else if (zy > b.y + b.h - m) dy = b.y + b.h - m - zy;
    if (dx || dy) return animateView({ k: S.view.k, x: S.view.x + dx, y: S.view.y + dy }, 280);
    return Promise.resolve();
  }
  function ensureNodeVisible(id) {
    const p = S.layout.pos.get(id); if (!p) return Promise.resolve();
    return ensureVisible(p.x - 80, p.y - 40, 160, 110);
  }

  // ------------------------------------------------------------------ undo / redo (project snapshots)
  function pushUndo() {
    S.undo.push(JSON.stringify(S.project));
    if (S.undo.length > 60) S.undo.shift();
    S.redo = [];
    updateDock();
  }
  function restoreSnapshot(from, to) {
    if (!from.length) return;
    commitInline();
    to.push(JSON.stringify(S.project));
    S.project = JSON.parse(from.pop());
    indexProject();
    if (S.sel && S.sel !== '__core' && !S.idx.has(S.sel)) S.sel = null;
    if (S.inner && !S.idx.has(S.inner.id)) { leaveInnerInstant(); }
    if (S.inner && S.inner.sel && !entryAt(innerNode(), S.inner.sel)) S.inner.sel = [];
    saveProject();
    if (!S.sel && !S.inner && S.selTree === null) panel.hidden = true;
  }
  const undo = () => restoreSnapshot(S.undo, S.redo);
  const redo = () => restoreSnapshot(S.redo, S.undo);
  function updateDock() {
    $('#dock [data-zoom="undo"]').disabled = !S.undo.length;
    $('#dock [data-zoom="redo"]').disabled = !S.redo.length;
  }

  // ------------------------------------------------------------------ pointer interaction
  const pointers = new Map();
  let drag = null, pinch = null, movingTimer = null, lastTap = null, pressTimer = null;
  function markMoving() { svg.classList.add('moving'); clearTimeout(movingTimer); movingTimer = setTimeout(() => svg.classList.remove('moving'), 160); }
  const parsePath = s => (s === '' || s == null ? [] : s.split('.').map(Number));
  function hitInfo(target) {
    if (S.inner) {
      const it = target.closest('.it');
      if (!it) return { kind: 'empty' };
      const path = parsePath(it.dataset.path);
      if (target.closest('[data-check]')) return { kind: 'check', path };
      if (target.closest('[data-fold]')) return { kind: 'fold', path };
      return { kind: 'item', path };
    }
    if (target.closest('.knob')) return { kind: 'knob' };
    const g = target.closest('.node');
    if (g) return { kind: 'node', id: g.dataset.id };
    if (target.closest('.core')) return { kind: 'core' };
    return { kind: 'empty' };
  }
  const hitKey = h => h.kind + ':' + (h.id || (h.path ? h.path.join('.') : ''));

  svg.addEventListener('pointerdown', e => {
    if (S.anim) return;
    hideCtx();
    if (editing) commitInline();
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    svg.focus({ preventScroll: true });
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cancelAnimationFrame(viewAnim);
    clearTimeout(pressTimer);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: S.view.k };
      drag = null; return;
    }
    const h = hitInfo(e.target);
    drag = { sx: e.clientX, sy: e.clientY, vx: S.view.x, vy: S.view.y, h, moved: false, touch: e.pointerType === 'touch' };
    if (h.kind === 'node' && !drag.touch) {
      const p = S.layout.pos.get(h.id), w = toWorld(e.clientX, e.clientY);
      drag.off = { x: p.x - w.x, y: p.y - w.y };
    }
    if (drag.touch && h.kind !== 'empty') {
      pressTimer = setTimeout(() => {
        if (drag && !drag.moved) { const d = drag; drag = null; pointers.clear(); openContextFor(d.h, d.sx, d.sy); }
      }, 550);
    }
  });
  svg.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), r = svg.getBoundingClientRect();
      zoomAt((pinch.k * d / pinch.d) / S.view.k, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      markMoving(); return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > 4) {
      drag.moved = true; clearTimeout(pressTimer);
      if (drag.h.kind === 'node' && !drag.touch) pushUndo();
      else if (drag.h.kind !== 'knob') svg.classList.add('panning');
    }
    if (!drag.moved) return;
    if (drag.h.kind === 'knob') { drawLinkLine(e); return; }
    if (drag.h.kind === 'node' && !drag.touch) {
      const w = toWorld(e.clientX, e.clientY);
      const p = { x: Math.round(w.x + drag.off.x), y: Math.round(w.y + drag.off.y) };
      S.layout.pos.set(drag.h.id, p);
      const g = L_NODES.querySelector(`.node[data-id="${CSS.escape(drag.h.id)}"]`);
      if (g) g.setAttribute('transform', `translate(${p.x},${p.y})`);
      const kb = L_NODES.querySelector('.knob'); if (kb) kb.remove();
      renderEdges();
      return;
    }
    S.view.x = drag.vx + dx; S.view.y = drag.vy + dy;
    applyView(); markMoving();
  });
  const endPointer = e => {
    pointers.delete(e.pointerId);
    clearTimeout(pressTimer);
    if (pointers.size < 2) pinch = null;
    if (!drag) return;
    svg.classList.remove('panning');
    const d = drag; drag = null;
    if (d.h.kind === 'knob') { finishLink(e, d.moved); return; }
    if (d.moved) {
      if (d.h.kind === 'node' && !d.touch) {
        const p = S.layout.pos.get(d.h.id);
        S.idx.get(d.h.id).n.pos = { x: p.x, y: p.y };
        saveProject();
      }
      return;
    }
    if (e.type === 'pointercancel') return;
    onTap(d.h);
  };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    if (S.anim) return;
    cancelAnimationFrame(viewAnim);
    const r = svg.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    else {
      const unit = e.deltaMode === 1 ? 16 : 1;
      let dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }
      S.view.x -= dx; S.view.y -= dy; applyView();
    }
    markMoving();
  }, { passive: false });
  svg.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (S.anim) return;
    openContextFor(hitInfo(e.target), e.clientX, e.clientY);
  });
  window.addEventListener('resize', () => { applyView(); });

  function onTap(h) {
    const t = now(), k = hitKey(h);
    const dbl = lastTap && lastTap.k === k && t - lastTap.t < 380;
    lastTap = dbl ? null : { k, t };
    if (S.inner) {
      if (h.kind === 'check') { toggleInnerKnown(h.path); return; }
      if (h.kind === 'fold') { toggleFold(h.path); return; }
      if (h.kind === 'item') { if (dbl) startRenameItem(h.path); else selectInner(h.path); return; }
      selectInner(null); return;
    }
    if (h.kind === 'knob') return;
    if (h.kind === 'node') { if (dbl) dive(h.id); else selectNode(h.id); return; }
    if (h.kind === 'core') { selectCore(); return; }
    deselect();
  }

  // connect knob: drag onto a skill to toggle the link, release on empty space to create a skill there
  function linkTargetAt(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const g = el && el.closest && el.closest('.node');
    return g && g.dataset.id !== S.sel ? g.dataset.id : null;
  }
  function drawLinkLine(e) {
    const a = S.layout.pos.get(S.sel), w = toWorld(e.clientX, e.clientY);
    L_LINK.innerHTML = `<path class="link-line" d="M${f1(a.x)},${f1(a.y)} L${f1(w.x)},${f1(w.y)}"/>`;
    const tid = linkTargetAt(e);
    $$('.node.link-target', L_NODES).forEach(g => g.classList.remove('link-target'));
    if (tid) L_NODES.querySelector(`.node[data-id="${CSS.escape(tid)}"]`)?.classList.add('link-target');
  }
  function finishLink(e, moved) {
    L_LINK.innerHTML = '';
    if (!S.sel || !S.idx.has(S.sel)) return;
    if (!moved) { addChild(S.sel); return; }
    const tid = linkTargetAt(e);
    if (tid) { toggleRequire(tid, S.sel); return; }
    const w = toWorld(e.clientX, e.clientY);
    addChild(S.sel, { x: Math.round(w.x), y: Math.round(w.y) });
  }

  // ------------------------------------------------------------------ keyboard
  const typingTarget = el => el && (el.closest('input, textarea, select, [contenteditable="true"]'));
  document.addEventListener('keydown', e => {
    if (e.target === inl) return; // handled by the inline editor
    const mod = e.ctrlKey || e.metaKey;
    if (!modal.hidden) {
      if (e.key === 'Escape') { closeModal(); return; }
      if (quiz && !typingTarget(e.target)) {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); $('#qzReveal')?.click(); }
        if (e.key === '1') $('[data-rate="bad"]')?.click();
        if (e.key === '2') $('[data-rate="good"]')?.click();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (!$('#ctxMenu').hidden) { hideCtx(); return; }
      if (typingTarget(e.target)) { e.target.blur(); svg.focus({ preventScroll: true }); return; }
      if ($$('.menu').some(m => !m.hidden)) { $$('.menu').forEach(m => { m.hidden = true; }); return; }
      if (S.inner) { if (S.inner.sel && S.inner.sel.length) selectInner(S.inner.sel.slice(0, -1)); else exitInner(); return; }
      deselect(); return;
    }
    if (mod && (e.key === 'z' || e.key === 'Z' || e.key === 'я' || e.key === 'Я')) {
      if (typingTarget(e.target)) return;
      e.preventDefault(); e.shiftKey ? redo() : undo(); return;
    }
    if (mod && (e.key === 'y' || e.key === 'н')) { if (typingTarget(e.target)) return; e.preventDefault(); redo(); return; }
    if (mod && (e.key === 'f' || e.key === 'а')) { e.preventDefault(); $('#search').focus(); return; }
    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomCenter(1.3); return; }
    if (mod && e.key === '-') { e.preventDefault(); zoomCenter(1 / 1.3); return; }
    if (mod && e.key === '0') { e.preventDefault(); S.inner ? fitInner() : fitAll(); return; }
    if (typingTarget(e.target) || e.target.closest('#panel, .menu, #hud, #legend, #dock')) {
      if (!(e.target.closest('#dock') && !['Enter', ' '].includes(e.key))) return;
    }
    if (S.anim) return;
    if (S.inner) { innerKey(e); return; }
    mapKey(e);
  });

  function mapKey(e) {
    const id = S.sel, isNode = id && S.idx.has(id);
    const k = e.key;
    if (k === 'Tab') { e.preventDefault(); if (id === '__core') addTree(); else if (isNode) addChild(id); else selectCore(); return; }
    if (k === 'Enter' && (e.ctrlKey || e.metaKey) && isNode) { e.preventDefault(); dive(id); return; }
    if (k === 'F6' && isNode) { e.preventDefault(); dive(id); return; }
    if (k === 'Enter') { e.preventDefault(); if (isNode) addSibling(id); else if (id === '__core') addTree(); return; }
    if ((k === 'F2' || k === ' ') && isNode) { e.preventDefault(); startRenameNode(id); return; }
    if ((k === 'Delete' || k === 'Backspace') && isNode) { e.preventDefault(); deleteNode(id); return; }
    if (k.startsWith('Arrow')) { e.preventDefault(); navMap(k); return; }
    if (k === '+' || k === '=') { zoomCenter(1.3); return; }
    if (k === '-') { zoomCenter(1 / 1.3); return; }
    if (k === '0') { fitAll(); return; }
    if (k === '?') { showHelp(); return; }
    if (k === '/') { e.preventDefault(); $('#search').focus(); return; }
    if (isNode && !e.ctrlKey && !e.metaKey && !e.altKey && k.length === 1 && /\p{L}/u.test(k)) { e.preventDefault(); startRenameNode(id, k); }
  }

  // Arrow keys move the selection to the nearest item in that direction.
  function spatialPick(cur, cands, key) {
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];
    let best = null, bs = Infinity;
    for (const c of cands) {
      const dx = c.x - cur.x, dy = c.y - cur.y;
      const along = dx * dir[0] + dy * dir[1];
      if (along <= 1) continue;
      const perp = Math.abs(dx * dir[1] - dy * dir[0]);
      const s = along + perp * 2.2;
      if (s < bs) { bs = s; best = c; }
    }
    return best;
  }
  function navMap(key) {
    const cands = [...S.layout.pos.entries()].map(([id, p]) => ({ key: id, x: p.x, y: p.y }));
    cands.push({ key: '__core', x: 0, y: 0 });
    const cur = S.sel && S.sel !== '__core' ? S.layout.pos.get(S.sel) : { x: 0, y: 0 };
    if (!S.sel) { selectCore(); return; }
    const b = spatialPick(cur, cands, key);
    if (!b) return;
    if (b.key === '__core') selectCore(); else { selectNode(b.key); ensureNodeVisible(b.key); }
  }

  // ------------------------------------------------------------------ context menu
  const ctx = $('#ctxMenu');
  let ctxActions = [];
  function showCtx(x, y, items) {
    ctxActions = [];
    ctx.innerHTML = items.map(it => {
      if (it === '-') return '<hr>';
      ctxActions.push(it.run);
      return `<button data-i="${ctxActions.length - 1}" class="${it.danger ? 'danger' : ''}"${it.disabled ? ' disabled' : ''}>${esc(it.label)}${it.kbd ? `<span class="kbd-hint">${esc(it.kbd)}</span>` : ''}</button>`;
    }).join('');
    ctx.hidden = false;
    const w = ctx.offsetWidth, h = ctx.offsetHeight;
    ctx.style.left = clamp(x, 8, window.innerWidth - w - 8) + 'px';
    ctx.style.top = clamp(y, 8, window.innerHeight - h - 8) + 'px';
  }
  function hideCtx() { ctx.hidden = true; }
  ctx.addEventListener('click', e => {
    const b = e.target.closest('[data-i]'); if (!b) return;
    hideCtx(); ctxActions[+b.dataset.i]?.();
  });
  function openContextFor(h, x, y) {
    if (S.inner) {
      if (h.kind === 'empty') {
        showCtx(x, y, [{ label: 'Новый вопрос', kbd: 'Tab', run: () => innerAddChild([]) }, { label: 'Показать всё', kbd: 'Ctrl 0', run: fitInner }, '-', { label: 'Вернуться к карте', kbd: 'Esc', run: () => exitInner() }]);
        return;
      }
      const path = h.path; selectInner(path);
      const e = path.length ? entryAt(innerNode(), path) : null;
      const isQ = e && !isTopic(e);
      const known = isQ && knownSet(S.inner.id).has(qText(e));
      showCtx(x, y, [
        { label: path.length ? 'Добавить подвопрос' : 'Добавить вопрос', kbd: 'Tab', run: () => innerAddChild(path) },
        ...(path.length ? [{ label: 'Добавить вопрос рядом', kbd: 'Enter', run: () => innerAddSibling(path) }] : []),
        { label: 'Переименовать', kbd: 'F2', run: () => startRenameItem(path) },
        ...(isQ ? [{ label: known ? 'Снять отметку «знаю»' : 'Знаю ответ', run: () => toggleInnerKnown(path) }] : []),
        ...(path.length ? ['-', { label: 'Выше', kbd: 'Alt ↑', run: () => innerMove(path, -1) }, { label: 'Ниже', kbd: 'Alt ↓', run: () => innerMove(path, 1) },
          '-', { label: isTopic(e) ? 'Удалить подтему' : 'Удалить вопрос', kbd: 'Del', danger: true, run: () => innerDelete(path) }] : [])
      ]);
      return;
    }
    if (h.kind === 'node') {
      const id = h.id, n = S.idx.get(id).n, st = nodeState(id);
      selectNode(id);
      showCtx(x, y, [
        { label: 'Открыть мини-карту', kbd: '2× клик', run: () => dive(id) },
        '-',
        { label: 'Следующий навык', kbd: 'Tab', run: () => addChild(id) },
        { label: 'Соседний навык', kbd: 'Enter', run: () => addSibling(id) },
        { label: 'Переименовать', kbd: 'F2', run: () => startRenameNode(id) },
        { label: n.keystone ? 'Сделать обычным' : 'Сделать ключевым', run: () => { pushUndo(); n.keystone = n.keystone ? undefined : true; saveProject(); } },
        ...(n.pos ? [{ label: 'Вернуть на авторасклад', run: () => { pushUndo(); delete n.pos; saveProject(); } }] : []),
        '-',
        st === 'mastered' ? { label: 'Сбросить «освоено»', run: () => setState(id, null) }
          : { label: 'Отметить освоенным', run: () => (st === 'locked' ? masterWithPrereqs(id) : setState(id, 'mastered')) },
        ...(st === 'available' ? [{ label: 'Начать изучение', run: () => setState(id, 'learning') }] : []),
        '-',
        { label: 'Удалить навык', kbd: 'Del', danger: true, run: () => deleteNode(id) }
      ]);
      return;
    }
    if (h.kind === 'core') {
      selectCore();
      showCtx(x, y, [{ label: 'Новая ветка', kbd: 'Tab', run: addTree }, { label: 'Показать всю карту', kbd: '0', run: () => fitAll() }]);
      return;
    }
    const w = toWorld(x, y);
    showCtx(x, y, [
      { label: 'Новый навык здесь', run: () => addNodeAt(w) },
      { label: 'Новая ветка', run: addTree },
      '-',
      { label: 'Показать всю карту', kbd: '0', run: () => fitAll() },
      { label: 'Отменить', kbd: 'Ctrl Z', disabled: !S.undo.length, run: undo },
      { label: 'Управление', kbd: '?', run: showHelp }
    ]);
  }

  // ------------------------------------------------------------------ inline rename
  const inl = $('#inlineEdit');
  let editing = null; // {kind:'node'|'item', id, path, orig, commit(v)}
  function startInline(target, initial) {
    commitInline();
    editing = target;
    inl.value = initial != null ? initial : target.orig;
    inl.classList.toggle('left', target.kind === 'item');
    inl.hidden = false;
    positionInline();
    autoGrow();
    inl.focus({ preventScroll: true });
    if (initial == null) inl.select(); else inl.setSelectionRange(inl.value.length, inl.value.length);
  }
  function positionInline() {
    if (!editing) return;
    const k = S.view.k;
    if (editing.kind === 'node') {
      const p = S.layout.pos.get(editing.id), n = S.idx.get(editing.id)?.n;
      if (!p || !n) return;
      const s = toScreen(p.x, p.y + nodeR(n) + 6);
      const w = 220;
      inl.style.width = w + 'px';
      inl.style.left = (s.x - w / 2) + 'px';
      inl.style.top = s.y + 'px';
    } else {
      const it = S.inner && S.inner.items.find(x => x.key === editing.path.join('.'));
      if (!it) return;
      const s = toScreen(it.x, it.y);
      const w = Math.max(220, it.w * k);
      inl.style.width = w + 'px';
      inl.style.left = (s.x - 4) + 'px';
      inl.style.top = (s.y - 4) + 'px';
    }
  }
  function autoGrow() { inl.style.height = 'auto'; inl.style.height = inl.scrollHeight + 2 + 'px'; }
  inl.addEventListener('input', autoGrow);
  inl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitInline(); return; }
    if (e.key === 'Escape') { e.preventDefault(); cancelInline(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const t = editing; commitInline();
      if (!t) return;
      if (t.kind === 'node' && S.sel && S.idx.has(S.sel)) addChild(S.sel);
      else if (t.kind === 'item' && S.inner && S.inner.sel) innerAddChild(S.inner.sel);
    }
  });
  inl.addEventListener('blur', () => commitInline());
  function commitInline() {
    if (!editing) return;
    const t = editing; editing = null;
    const v = inl.value.replace(/\s+/g, ' ').trim();
    inl.hidden = true;
    if (v && v !== t.orig) t.commit(v);
    svg.focus({ preventScroll: true });
  }
  function cancelInline() { editing = null; inl.hidden = true; svg.focus({ preventScroll: true }); }

  function startRenameNode(id, initial) {
    const e = S.idx.get(id); if (!e) return;
    ensureNodeVisible(id).then(() => startInline({ kind: 'node', id, orig: e.n.title, commit: v => renameNode(id, v) }, initial));
  }

  // ------------------------------------------------------------------ map editing
  function uniqueId(base, except) {
    let id = base, i = 2;
    while ((S.idx.has(id) || S.project.trees.some(t => t.id === id)) && id !== except) id = `${base}-${i++}`;
    return id;
  }
  function renameNodeId(oldId, newId) {
    const e = S.idx.get(oldId); if (!e || oldId === newId) return;
    e.n.id = newId;
    for (const t of S.project.trees) for (const n of t.nodes) for (const k of ['requires', 'requiresAny']) if (n[k]) n[k] = n[k].map(x => (x === oldId ? newId : x));
    if (S.progress.nodes[oldId]) { S.progress.nodes[newId] = S.progress.nodes[oldId]; delete S.progress.nodes[oldId]; saveProgress(); }
    if (S.sel === oldId) S.sel = newId;
    S.fresh.delete(oldId);
    indexProject();
  }
  function renameNode(id, title) {
    const e = S.idx.get(id); if (!e) return;
    pushUndo();
    e.n.title = title;
    if (S.fresh.has(id)) {
      const t = e.t;
      if (S.fresh.has('tree:' + t.id) && t.nodes.length === 1) {
        // first name of a new branch names the branch too
        S.fresh.delete('tree:' + t.id);
        t.title = title;
        const tid = uniqueId(slug(title), t.id);
        t.id = tid;
        renameNodeId(id, uniqueId(`${tid}.${slug(title)}`));
      } else renameNodeId(id, uniqueId(`${t.id}.${slug(title)}`));
    }
    saveProject();
    if (S.sel && S.idx.has(S.sel)) syncHash();
  }
  function insertAfter(t, n, afterId) {
    let at = t.nodes.findIndex(x => x.id === afterId);
    if (at < 0) { t.nodes.push(n); return; }
    while (at + 1 < t.nodes.length && ((t.nodes[at + 1].requires || []).includes(afterId))) at++;
    t.nodes.splice(at + 1, 0, n);
  }
  function newNode(t, extra) {
    const id = uniqueId(`${t.id}.new`);
    S.fresh.add(id);
    return { id, title: 'Новый навык', description: '', ...extra, questions: [] };
  }
  function addChild(pid, at) {
    const e = S.idx.get(pid); if (!e) return;
    pushUndo();
    const n = newNode(e.t, { requires: [pid] });
    if (at) n.pos = at;
    insertAfter(e.t, n, pid);
    afterAdd(n.id);
  }
  function addSibling(id) {
    const e = S.idx.get(id); if (!e) return;
    pushUndo();
    const extra = {};
    if (e.n.requires && e.n.requires.length) extra.requires = [...e.n.requires];
    if (e.n.requiresAny && e.n.requiresAny.length) extra.requiresAny = [...e.n.requiresAny];
    const n = newNode(e.t, extra);
    if (e.n.pos) { const p = e.n.pos, len = Math.hypot(p.x, p.y) || 1; n.pos = { x: Math.round(p.x - p.y / len * 130), y: Math.round(p.y + p.x / len * 130) }; }
    insertAfter(e.t, n, id);
    afterAdd(n.id);
  }
  function addNodeAt(w) {
    if (!S.project.trees.length) { addTree(); return; }
    let a = Math.atan2(w.y, w.x);
    const s = S.layout.sectors.find(x => { let b = a; while (b < x.a0) b += 2 * Math.PI; return b <= x.a1; }) || S.layout.sectors[0];
    pushUndo();
    const n = newNode(s.t, {});
    n.pos = { x: Math.round(w.x), y: Math.round(w.y) };
    s.t.nodes.push(n);
    afterAdd(n.id);
  }
  function afterAdd(id) {
    saveProject();
    selectNode(id);
    startRenameNode(id);
  }
  function addTree() {
    pushUndo();
    const used = new Set(S.project.trees.map(t => (t.color || '').toLowerCase()));
    const color = PALETTE.find(c => !used.has(c)) || PALETTE[S.project.trees.length % PALETTE.length];
    const tid = uniqueId('branch');
    const nid = `${tid}.start`;
    S.project.trees.push({ id: tid, title: 'Новая ветка', color, description: '', nodes: [{ id: nid, title: 'Новая ветка', description: '', keystone: true, questions: [] }] });
    S.fresh.add('tree:' + tid); S.fresh.add(nid);
    saveProject();
    selectNode(nid);
    ensureNodeVisible(nid).then(() => startRenameNode(nid));
  }
  function deleteNode(id) {
    const e = S.idx.get(id); if (!e) return;
    pushUndo();
    const parent = reqs(e.n)[0] || null;
    e.t.nodes = e.t.nodes.filter(n => n.id !== id);
    for (const t of S.project.trees) for (const n of t.nodes) {
      for (const k of ['requires', 'requiresAny']) if (n[k]) { n[k] = n[k].filter(x => x !== id); if (!n[k].length) delete n[k]; }
    }
    S.sel = null;
    saveProject();
    if (parent && S.idx.has(parent)) selectNode(parent); else { panel.hidden = true; refreshMap(); }
    toast(`Удалено: ${e.n.title}`, 'Ctrl + Z вернёт');
  }
  function wouldCycle(id, newReq) { return newReq === id || ancestors(newReq).has(id); }
  function toggleRequire(id, req) {
    const n = S.idx.get(id).n;
    if ((n.requires || []).includes(req) || (n.requiresAny || []).includes(req)) {
      pushUndo();
      for (const k of ['requires', 'requiresAny']) if (n[k]) { n[k] = n[k].filter(x => x !== req); if (!n[k].length) delete n[k]; }
      toast('Связь удалена');
    } else {
      if (wouldCycle(id, req)) { toast('Так нельзя', 'Получится замкнутый круг зависимостей'); return; }
      pushUndo();
      n.requires = [...(n.requires || []), req];
      toast('Связь добавлена', `${S.idx.get(req).n.title} → ${n.title}`);
    }
    saveProject();
  }

  // ------------------------------------------------------------------ progress actions
  function setState(id, s) {
    const before = new Set([...S.idx.keys()].filter(x => nodeState(x) !== 'locked'));
    const lvlBefore = levelOf(computeXP());
    const p = S.progress.nodes[id] || (S.progress.nodes[id] = {});
    if (s) { p.s = s; p.t = now(); } else { delete p.s; delete p.t; delete p.rv; }
    if (!p.s && !(p.known && p.known.length) && !p.notes) delete S.progress.nodes[id];
    saveProgress();
    const opened = [...S.idx.keys()].filter(x => nodeState(x) !== 'locked' && !before.has(x));
    if (s === 'mastered') {
      burst(id);
      toast(`Освоено: ${S.idx.get(id).n.title}`, opened.length ? `Открыто новых навыков: ${opened.length}` : '');
    }
    afterProgress(lvlBefore);
  }
  function masterWithPrereqs(id) {
    const lvlBefore = levelOf(computeXP());
    let c = 0;
    for (const x of [...ancestors(id), id]) if (!isMastered(x)) { const p = S.progress.nodes[x] || (S.progress.nodes[x] = {}); p.s = 'mastered'; p.t = now(); c++; }
    saveProgress(); burst(id);
    toast(`Освоено навыков: ${c}`, 'Вместе со всеми требованиями');
    afterProgress(lvlBefore);
  }
  function setTreeState(treeId, mastered) {
    const lvlBefore = levelOf(computeXP());
    const t = treeById(treeId); if (!t) return;
    for (const n of t.nodes) {
      if (mastered) { const p = S.progress.nodes[n.id] || (S.progress.nodes[n.id] = {}); if (p.s !== 'mastered') { p.s = 'mastered'; p.t = now(); } } else delete S.progress.nodes[n.id];
    }
    saveProgress();
    if (mastered) toast(`Ветка «${t.title}» отмечена изученной`);
    afterProgress(lvlBefore);
  }
  function toggleKnown(id, q, on) {
    const lvlBefore = levelOf(computeXP());
    const p = S.progress.nodes[id] || (S.progress.nodes[id] = {});
    const k = new Set(p.known || []);
    on ? k.add(q) : k.delete(q);
    p.known = [...k];
    saveProgress();
    afterProgress(lvlBefore);
  }
  function renameKnown(id, oldQ, newQ) {
    const p = S.progress.nodes[id];
    if (p && p.known && p.known.includes(oldQ)) p.known = p.known.map(x => (x === oldQ ? newQ : x));
    const r = S.progress.reviews[id + '|' + oldQ];
    if (r) { S.progress.reviews[id + '|' + newQ] = r; delete S.progress.reviews[id + '|' + oldQ]; }
    saveProgress();
  }
  function afterProgress(lvlBefore) {
    refreshMap(); renderLegend(); renderHud();
    if (S.inner) renderInner();
    const lv = levelOf(computeXP());
    if (lv > lvlBefore) toast(`Новый уровень ${lv}`, levelTitle(lv), 'lvl');
    rerenderOpenPanel();
  }
  function burst(id) {
    if (S.inner) return;
    const p = S.layout.pos.get(id); if (!p) return;
    let h = `<g transform="translate(${f1(p.x)},${f1(p.y)})" style="--c:${esc(S.idx.get(id).t.color)}"><circle class="burst-ring" r="24"/>`;
    for (let i = 0; i < 14; i++) {
      const a = i / 14 * Math.PI * 2, dist = 60 + (i % 3) * 22;
      h += `<circle class="burst" r="${1.6 + (i % 3) * 0.7}" style="--dx:${(Math.cos(a) * dist).toFixed(0)}px;--dy:${(Math.sin(a) * dist).toFixed(0)}px"/>`;
    }
    L_FX.insertAdjacentHTML('beforeend', h + '</g>');
    const g = L_FX.lastElementChild;
    setTimeout(() => g.remove(), 1000);
  }

  // ------------------------------------------------------------------ HUD, legend, dock, hint
  function renderHud() {
    const xp = computeXP(), lv = levelOf(xp);
    const a = xpFor(lv), b = xpFor(lv + 1);
    $('#levelNum').textContent = lv;
    $('#levelTitle').textContent = levelTitle(lv);
    $('#xpFill').style.width = `${Math.round(100 * (xp - a) / (b - a))}%`;
    $('#xpText').textContent = `${xp} / ${b} XP`;
    $('#projectTitle').textContent = S.project.title;
    const due = [...S.idx.keys()].filter(needsReview).length;
    const rc = $('#reviewCount'); rc.hidden = !due; rc.textContent = due;
  }
  function renderLegend() {
    let total = 0, done = 0;
    $('#legendList').innerHTML = S.project.trees.map(t => {
      const m = t.nodes.filter(n => isMastered(n.id)).length;
      total += t.nodes.length; done += m;
      const pct = t.nodes.length ? Math.round(100 * m / t.nodes.length) : 0;
      return `<button class="legend-row${S.selTree === t.id ? ' active' : ''}" data-tree="${esc(t.id)}" style="--c:${esc(t.color)}">
        <span class="bar-c"></span><span class="nm">${esc(t.title)}</span><span class="ct">${m}/${t.nodes.length}</span>
        <span class="bar"><i style="width:${pct}%"></i></span></button>`;
    }).join('');
    $('#legendTotal').textContent = `${done}/${total}`;
  }
  $('#legendList').addEventListener('click', e => { const b = e.target.closest('[data-tree]'); if (b) selectTree(b.dataset.tree); });
  $('#legendToggle').addEventListener('click', () => {
    const l = $('#legend'); l.classList.toggle('collapsed');
    $('#legendToggle').setAttribute('aria-expanded', String(!l.classList.contains('collapsed')));
    S.prefs.legend = l.classList.contains('collapsed') ? 'collapsed' : 'open'; savePrefs();
  });
  $('#dock').addEventListener('click', e => {
    const z = e.target.closest('[data-zoom]'); if (!z) return;
    const a = z.dataset.zoom;
    if (a === 'fit') S.inner ? fitInner() : fitAll();
    else if (a === 'in') zoomCenter(1.3);
    else if (a === 'out') zoomCenter(1 / 1.3);
    else if (a === 'undo') undo();
    else if (a === 'redo') redo();
    else if (a === 'help') showHelp();
  });
  function renderHint() {
    const h = $('#hint');
    const k = (key, what) => `<b>${key}</b> ${what}`;
    if (S.inner) h.innerHTML = [k('Tab', 'подвопрос'), k('Enter', 'вопрос рядом'), k('F2', 'переименовать'), k('Del', 'удалить'), k('клик по кружку', 'знаю'), k('Esc', 'к карте')].join('   ·   ');
    else if (S.sel === '__core') h.innerHTML = [k('Tab', 'новая ветка'), k('стрелки', 'к навыкам'), k('?', 'все клавиши')].join('   ·   ');
    else if (S.sel && S.idx.has(S.sel)) h.innerHTML = [k('2× клик', 'мини-карта'), k('Tab', 'следующий'), k('Enter', 'соседний'), k('F2', 'переименовать'), k('Del', 'удалить'), k('тяни ⊕', 'связать')].join('   ·   ');
    else h.innerHTML = [k('клик', 'выбрать'), k('2× клик', 'внутрь навыка'), k('колесо', 'прокрутка'), k('Ctrl + колесо', 'масштаб'), k('правый клик', 'меню'), k('?', 'клавиши')].join('   ·   ');
  }

  // ------------------------------------------------------------------ selection + panel
  let panelKind = null;
  function openPanel(kind, html) {
    panelKind = kind; panelBody.innerHTML = html; panel.hidden = false;
  }
  function closePanel() { panel.hidden = true; panelKind = null; }
  $('#panelClose').addEventListener('click', () => { if (S.inner) closePanel(); else deselect(); });
  function rerenderOpenPanel() {
    if (panel.hidden) return;
    const st = panel.scrollTop;
    const openDetails = !!panelBody.querySelector('details.edit[open]');
    if (S.inner && panelKind && panelKind.startsWith('inner')) renderInnerPanel();
    else if (panelKind === 'node' && S.sel && S.idx.has(S.sel)) renderNodePanel(S.sel);
    else if (panelKind === 'tree' && S.selTree && treeById(S.selTree)) renderTreePanel(S.selTree);
    else if (panelKind === 'project') renderProjectPanel();
    if (openDetails) { const d = panelBody.querySelector('details.edit'); if (d) d.open = true; }
    panel.scrollTop = st;
  }
  function syncHash() {
    try {
      const h = S.sel && S.idx.has(S.sel) ? '#' + S.sel : '';
      if (h !== location.hash) history.replaceState(null, '', h || location.pathname + location.search);
    } catch (e) { /* sandboxed */ }
  }
  function selectNode(id, opts = {}) {
    if (!S.idx.has(id)) return;
    S.sel = id; S.selTree = null;
    syncHash();
    renderNodePanel(id);
    refreshMap(); renderLegend(); renderHint();
    if (opts.fly) flyTo(S.layout.pos.get(id).x, S.layout.pos.get(id).y, Math.max(S.view.k, 0.85));
  }
  function selectCore() {
    S.sel = '__core'; S.selTree = null; syncHash();
    renderProjectPanel(); refreshMap(); renderLegend(); renderHint();
  }
  function deselect() {
    S.sel = null; S.selTree = null; syncHash();
    closePanel(); refreshMap(); renderLegend(); renderHint();
  }
  function selectTree(tid) {
    const t = treeById(tid); if (!t) return;
    if (S.inner) leaveInnerInstant();
    S.selTree = tid; S.sel = null; syncHash();
    renderTreePanel(tid); refreshMap(); renderLegend(); renderHint();
    const pts = t.nodes.map(n => S.layout.pos.get(n.id)).filter(Boolean);
    if (pts.length) {
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y), b = viewport();
      const w = Math.max(...xs) - Math.min(...xs) + 320, h = Math.max(...ys) - Math.min(...ys) + 320;
      flyTo((Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2, clamp(Math.min(b.w / w, (b.h - 60) / h), 0.18, 1));
    }
  }

  const STATE_LABEL = { locked: 'Закрыт', available: 'Доступен', learning: 'Изучаю', mastered: 'Освоен' };
  function badge(id, big) {
    const { n, t } = S.idx.get(id);
    return `<span class="badge${n.keystone ? ' ks' : ''}${isMastered(id) ? ' done' : ''}${big ? ' big' : ''}" style="--c:${esc(t.color)}"><span>${esc(abbrOf(n))}</span></span>`;
  }
  function chip(id) {
    const e = S.idx.get(id); if (!e) return `<span class="link-chip missing">${esc(id)}</span>`;
    return `<button class="link-chip${isMastered(id) ? ' done' : ''}" data-goto="${esc(id)}" style="--c:${esc(e.t.color)}"><span class="dot"></span>${esc(e.n.title)}</button>`;
  }
  function claudeUrl(text) { return 'https://claude.ai/new?q=' + encodeURIComponent(text); }
  function askPrompt(node, q) {
    return `Я повторяю тему «${node.title}». Кратко и по делу (до 150 слов) ответь на вопрос: ${q}. Если уместно, добавь маленький пример кода.`;
  }
  const icon = (name, cls = '') => `<svg class="ic ${cls}"><use href="#i-${name}"/></svg>`;

  function questionListHtml(id) {
    const { n, t } = S.idx.get(id);
    const known = knownSet(id), flat = flatQ(n.questions);
    const groups = [];
    flat.forEach((x, i) => {
      let g = groups[groups.length - 1];
      if (!g || g.name !== x.group) groups.push(g = { name: x.group, items: [] });
      g.items.push({ ...x, i });
    });
    const askBtn = (x) => x.a ? `<button class="ask" data-ans="${x.i}">ответ</button>`
      : (S.sample ? `<button class="ask" data-ask="${x.i}">спросить Claude</button>` : `<a class="ask" href="${esc(claudeUrl(askPrompt(n, x.q)))}" target="_blank" rel="noopener">спросить Claude ↗</a>`);
    return groups.map(g => `<div class="qgroup" style="--c:${esc(t.color)}">
      ${g.name ? `<p class="qg-title"><span>${esc(g.name)}</span><span class="mono">${g.items.filter(x => known.has(x.q)).length}/${g.items.length}</span></p>` : ''}
      <ul class="qlist">${g.items.map(x => `<li class="q${known.has(x.q) ? ' known' : ''}">
        <input type="checkbox" id="q-${x.i}" data-q="${x.i}" ${known.has(x.q) ? 'checked' : ''}>
        <label for="q-${x.i}">${esc(x.q)}</label>${askBtn(x)}
        <div class="ans" data-ans-box="${x.i}" hidden>${esc(x.a)}</div></li>`).join('')}</ul></div>`).join('');
  }

  function renderNodePanel(id) {
    const { n, t } = S.idx.get(id);
    const st = nodeState(id);
    const p = nodeProg(id) || {};
    const { total, known } = qStats(id);
    const missing = reqs(n).filter(r => !isMastered(r));
    const anyMissing = reqsAny(n).length && !reqsAny(n).some(isMastered) ? reqsAny(n) : [];
    let actions = '';
    if (st === 'locked') {
      actions = `<div><p class="sec-title">Чтобы открыть, освой</p><div class="links">${missing.map(chip).join('')}</div>
        ${anyMissing.length ? `<p class="small muted" style="margin:10px 0 6px">и любой из этих:</p><div class="links">${anyMissing.map(chip).join('')}</div>` : ''}</div>
        <div class="p-actions"><button class="btn" data-act="master-chain">Я это уже знаю</button></div>`;
    } else if (st === 'available') {
      actions = '<div class="p-actions"><button class="btn primary" data-act="learn">Начать изучение</button><button class="btn good" data-act="master">Уже знаю</button></div>';
    } else if (st === 'learning') {
      actions = '<div class="p-actions"><button class="btn primary" data-act="master">Освоено</button><button class="btn ghost" data-act="reset">Отложить</button></div>';
    } else {
      actions = `<div class="p-actions">${total ? '<button class="btn primary" data-act="quiz-node">Повторить вопросы</button>' : ''}<button class="btn ghost" data-act="ask-reset">Сбросить</button></div>
        ${needsReview(id) ? '<p class="small muted" style="margin:0">Ты давно не повторял эту тему. Пройди вопросы, чтобы освежить.</p>' : ''}`;
    }
    const unlocks = dependents(id);
    const inInner = S.inner && S.inner.id === id;
    openPanel(inInner ? 'inner-root' : 'node', `
      <div class="p-head">${badge(id, true)}
        <div><h2 class="p-title">${esc(n.title)}</h2>
          <div class="p-sub"><span class="tag tree" style="--c:${esc(t.color)}">${esc(t.title)}</span><span class="tag st-${st}">${STATE_LABEL[st]}</span>${n.keystone ? '<span class="tag">Ключевой</span>' : ''}</div></div>
      </div>
      ${n.description ? `<p class="p-desc">${esc(n.description)}</p>` : ''}
      ${actions}
      <div id="confirmSlot"></div>
      ${inInner ? '' : `<button class="dive-card" data-act="dive" style="--c:${esc(t.color)}">${icon('dive')}<span><b>Мини-карта навыка</b><small>${total ? `${known} из ${total} вопросов знаю` : 'Добавь вопросы и подтемы'}</small></span><span class="kbd">2× клик</span></button>`}
      ${total ? `<div style="--c:${esc(t.color)}"><p class="sec-title"><span>Вопросы</span><span class="mono">${known}/${total}</span></p>
        <div class="progress"><i style="width:${Math.round(100 * known / total)}%"></i></div>
        <div style="margin-top:10px">${questionListHtml(id)}</div></div>` : ''}
      ${(n.resources || []).length ? `<div class="res"><p class="sec-title">Материалы</p><ul>${n.resources.map(r => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title || r.url)}</a></li>`).join('')}</ul></div>` : ''}
      ${reqs(n).length || reqsAny(n).length ? `<div><p class="sec-title">Требует</p><div class="links">${reqs(n).map(chip).join('')}${reqsAny(n).length ? `<span class="small muted" style="align-self:center">любой из:</span>${reqsAny(n).map(chip).join('')}` : ''}</div></div>` : ''}
      ${unlocks.length ? `<div><p class="sec-title">Открывает</p><div class="links">${unlocks.map(chip).join('')}</div></div>` : ''}
      <div><p class="sec-title">Мои заметки</p><textarea class="notes" id="nodeNotes" placeholder="Ключевые мысли, ссылки, что спросили на собеседовании">${esc(p.notes || '')}</textarea></div>
      ${nodeEditorHtml(id)}
    `);
    bindNodeEditor(id);
  }

  function nodeEditorHtml(id) {
    const { n, t } = S.idx.get(id);
    const chips = (list, kind) => (list || []).map(r => `<span class="link-chip" style="--c:${esc(S.idx.get(r)?.t.color || '#666')}"><span class="dot"></span>${esc(S.idx.get(r)?.n.title || r)}<button type="button" data-rm="${kind}" data-v="${esc(r)}" title="Убрать">${icon('close', 'sm')}</button></span>`).join('');
    return `<details class="edit"><summary>Изменить навык</summary>
      <form class="form" id="nodeForm">
        <div class="field-row">
          <label class="field"><span>Название</span><input id="f-title" value="${esc(n.title)}" required></label>
          <label class="field"><span>Метка</span><input id="f-abbr" value="${esc(n.abbr || '')}" maxlength="5" placeholder="${esc(autoAbbr(n.title))}"></label>
        </div>
        <label class="field"><span>Описание</span><textarea id="f-desc">${esc(n.description || '')}</textarea></label>
        <label class="field"><span>Ветка</span><select id="f-tree">${S.project.trees.map(x => `<option value="${esc(x.id)}"${x.id === t.id ? ' selected' : ''}>${esc(x.title)}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" id="f-ks" ${n.keystone ? 'checked' : ''}> Ключевой навык: крупнее и даёт больше опыта</label>
        <div class="field"><span>Требует (все)</span><div class="chips-edit">${chips(n.requires, 'requires')}</div>
          <input list="nodeIds" id="f-addreq" placeholder="Добавить: начни вводить название"></div>
        <div class="field"><span>Требует любой из</span><div class="chips-edit">${chips(n.requiresAny, 'requiresAny')}</div>
          <input list="nodeIds" id="f-addany" placeholder="Добавить альтернативу"></div>
        <label class="field"><span>Материалы: «название | ссылка» на строку</span><textarea id="f-res">${esc((n.resources || []).map(r => `${r.title || ''} | ${r.url}`).join('\n'))}</textarea></label>
        <datalist id="nodeIds">${[...S.idx.values()].filter(x => x.n.id !== id).map(x => `<option value="${esc(x.n.title)}">${esc(x.t.title)}</option>`).join('')}</datalist>
        <div class="p-actions"><button class="btn primary" type="submit">Сохранить</button>${n.pos ? '<button class="btn" type="button" data-ed="unpin">Вернуть на авторасклад</button>' : ''}<button class="btn danger" type="button" data-ed="delete">Удалить</button></div>
        <p class="small muted" style="margin:0">Вопросы и подтемы правятся в мини-карте навыка. На карте: Tab добавляет следующий навык, F2 переименовывает, Delete удаляет.</p>
      </form></details>`;
  }
  function bindNodeEditor(id) {
    const form = $('#nodeForm'); if (!form) return;
    const { n, t } = S.idx.get(id);
    form.addEventListener('submit', e => {
      e.preventDefault();
      pushUndo();
      const title = $('#f-title').value.trim() || n.title;
      n.title = title;
      const ab = $('#f-abbr').value.trim(); if (ab) n.abbr = ab; else delete n.abbr;
      n.description = $('#f-desc').value.trim();
      if ($('#f-ks').checked) n.keystone = true; else delete n.keystone;
      n.resources = $('#f-res').value.split('\n').map(s => s.trim()).filter(Boolean).map(l => { const [a, b] = l.split('|').map(x => x.trim()); return b ? { title: a, url: b } : { title: a, url: a }; });
      if (!n.resources.length) delete n.resources;
      const nt = $('#f-tree').value;
      if (nt !== t.id) { t.nodes.splice(t.nodes.indexOf(n), 1); treeById(nt).nodes.push(n); delete n.pos; }
      saveProject(); toast('Сохранено');
    });
    const findId = v => { v = v.trim(); if (S.idx.has(v)) return v; for (const [k, x] of S.idx) if (x.n.title === v) return k; return null; };
    const addRef = (sel, kind) => $(sel).addEventListener('change', e => {
      const v = findId(e.target.value); if (!v || v === id) return;
      if (wouldCycle(id, v)) { toast('Так нельзя', 'Получится замкнутый круг зависимостей'); return; }
      pushUndo();
      n[kind] = [...new Set([...(n[kind] || []), v])];
      saveProject();
    });
    addRef('#f-addreq', 'requires'); addRef('#f-addany', 'requiresAny');
    form.addEventListener('click', e => {
      const rm = e.target.closest('[data-rm]');
      if (rm) { pushUndo(); const k = rm.dataset.rm; n[k] = (n[k] || []).filter(x => x !== rm.dataset.v); if (!n[k].length) delete n[k]; saveProject(); return; }
      const ed = e.target.closest('[data-ed]'); if (!ed) return;
      if (ed.dataset.ed === 'unpin') { pushUndo(); delete n.pos; saveProject(); }
      if (ed.dataset.ed === 'delete') { if (S.inner) leaveInnerInstant(); deleteNode(id); }
    });
  }

  panelBody.addEventListener('click', e => {
    const go = e.target.closest('[data-goto]');
    if (go) { if (S.inner) leaveInnerInstant(); selectNode(go.dataset.goto, { fly: true }); return; }
    const act = e.target.closest('[data-act]');
    const nodeId = S.inner ? S.inner.id : S.sel;
    if (act) {
      const a = act.dataset.act;
      if (a === 'dive') dive(nodeId);
      else if (a === 'learn') setState(nodeId, 'learning');
      else if (a === 'master') setState(nodeId, 'mastered');
      else if (a === 'reset') setState(nodeId, null);
      else if (a === 'master-chain') {
        const cnt = [...ancestors(nodeId)].filter(x => !isMastered(x)).length;
        confirmIn(`Отметить «${S.idx.get(nodeId).n.title}» и все требования (${cnt}) как изученные?`, 'Отметить', () => masterWithPrereqs(nodeId), false);
      } else if (a === 'ask-reset') confirmIn('Сбросить отметку «освоено»? Отметки вопросов и заметки останутся.', 'Сбросить', () => setState(nodeId, null));
      else if (a === 'quiz-node') openQuiz({ node: nodeId });
      else if (a === 'tree-master') confirmIn(`Отметить всю ветку «${treeById(S.selTree).title}» изученной?`, 'Отметить', () => setTreeState(S.selTree, true), false);
      else if (a === 'tree-reset') confirmIn('Сбросить прогресс всей ветки?', 'Сбросить', () => setTreeState(S.selTree, false));
      else if (a === 'tree-quiz') openQuiz({ tree: S.selTree });
      else if (a === 'tree-add') { const t = treeById(S.selTree); pushUndo(); const n = newNode(t, {}); t.nodes.push(n); afterAdd(n.id); }
      else if (a === 'add-tree') addTree();
      else if (a === 'q-known') toggleInnerKnown(S.inner.sel);
      else if (a === 'q-ask') { const box = $('#qAnswer'); askClaude(innerNode(), qText(entryAt(innerNode(), S.inner.sel)), box, true); }
      else if (a === 'q-child') innerAddChild(S.inner.sel);
      else if (a === 'q-sibling') innerAddSibling(S.inner.sel);
      else if (a === 'q-rename') startRenameItem(S.inner.sel);
      else if (a === 'q-delete') innerDelete(S.inner.sel);
      else if (a === 'q-select') selectInner(act.dataset.path ? parsePath(act.dataset.path) : []);
      else if (a === 'save-answer') saveAnswer(S.inner.sel, act.dataset.text || $('#qAnswer')?.textContent || '');
      return;
    }
    const ans = e.target.closest('[data-ans]');
    if (ans) { const box = panelBody.querySelector(`[data-ans-box="${ans.dataset.ans}"]`); box.hidden = !box.hidden; return; }
    const ask = e.target.closest('[data-ask]');
    if (ask) {
      const n = S.idx.get(nodeId).n, x = flatQ(n.questions)[+ask.dataset.ask];
      const box = panelBody.querySelector(`[data-ans-box="${ask.dataset.ask}"]`);
      if (!box.hidden && box.textContent) { box.hidden = true; return; }
      askClaude(n, x.q, box);
    }
  });
  panelBody.addEventListener('change', e => {
    const cb = e.target.closest('input[data-q]');
    if (cb) {
      const id = S.inner ? S.inner.id : S.sel;
      const x = flatQ(S.idx.get(id).n.questions)[+cb.dataset.q];
      if (x) toggleKnown(id, x.q, cb.checked);
      return;
    }
    if (e.target.id === 'qAnsEdit' && S.inner) saveAnswer(S.inner.sel, e.target.value);
  });
  let notesTimer = null;
  panelBody.addEventListener('input', e => {
    if (e.target.id !== 'nodeNotes') return;
    const id = S.inner ? S.inner.id : S.sel, v = e.target.value;
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => { const p = S.progress.nodes[id] || (S.progress.nodes[id] = {}); p.notes = v; saveProgress(); }, 500);
  });

  function confirmIn(text, okLabel, fn, danger = true) {
    const slot = $('#confirmSlot', panelBody); if (!slot) { fn(); return; }
    slot.innerHTML = `<div class="confirm${danger ? '' : ' soft'}"><span>${esc(text)}</span>
      <button class="btn small ${danger ? 'danger' : 'primary'}" data-c="ok">${esc(okLabel)}</button><button class="btn small ghost" data-c="no">Отмена</button></div>`;
    slot.querySelector('[data-c="ok"]').onclick = e => { e.stopPropagation(); slot.innerHTML = ''; fn(); };
    slot.querySelector('[data-c="no"]').onclick = e => { e.stopPropagation(); slot.innerHTML = ''; };
  }
  function confirmModal(title, text, okLabel, fn) {
    openModal(`<h2>${esc(title)}</h2><p class="help-text">${esc(text)}</p>
      <div class="p-actions"><button class="btn danger" id="cmOk">${esc(okLabel)}</button><button class="btn ghost" data-close>Отмена</button></div>`);
    $('#cmOk').onclick = () => { closeModal(); fn(); };
  }

  async function askClaude(node, q, box, offerSave) {
    box.hidden = false; box.textContent = 'Claude думает…';
    if (!S.sample) { box.innerHTML = `<a href="${esc(claudeUrl(askPrompt(node, q)))}" target="_blank" rel="noopener">Открыть вопрос в Claude ↗</a>`; return; }
    try {
      const res = await S.sample(askPrompt(node, q), { onText: ({ text }) => { box.textContent = text; } });
      box.textContent = res.text;
      if (offerSave && res.text) {
        const b = document.createElement('div');
        b.className = 'p-actions'; b.style.marginTop = '10px';
        b.innerHTML = '<button class="btn small" data-act="save-answer">Сохранить как ответ</button>';
        box.after(b);
      }
    } catch (err) {
      if (err && err.code === 'not_granted') { S.sample = null; box.innerHTML = `Нет доступа. <a href="${esc(claudeUrl(askPrompt(node, q)))}" target="_blank" rel="noopener">Открыть в Claude ↗</a>`; }
      else box.textContent = 'Не получилось получить ответ. Попробуй ещё раз чуть позже.';
    }
  }

  function renderTreePanel(tid) {
    const t = treeById(tid);
    const m = t.nodes.filter(n => isMastered(n.id)).length;
    let qn = 0, kn = 0;
    t.nodes.forEach(n => { const s = qStats(n.id); qn += s.total; kn += s.known; });
    const avail = t.nodes.filter(n => ['available', 'learning'].includes(nodeState(n.id)));
    const used = new Set(S.project.trees.filter(x => x !== t).map(x => x.color));
    const colors = [...new Set([t.color, ...PALETTE])];
    openPanel('tree', `
      <div class="p-head"><span class="badge big ks" style="--c:${esc(t.color)}"><span>${t.nodes.length}</span></span>
        <div><h2 class="p-title">${esc(t.title)}</h2><div class="p-sub"><span class="tag tree" style="--c:${esc(t.color)}">${m}/${t.nodes.length} навыков</span><span class="tag">${kn}/${qn} вопросов</span></div></div></div>
      ${t.description ? `<p class="p-desc">${esc(t.description)}</p>` : ''}
      <div style="--c:${esc(t.color)}"><div class="progress"><i style="width:${t.nodes.length ? Math.round(100 * m / t.nodes.length) : 0}%"></i></div></div>
      <div class="p-actions">${qn ? '<button class="btn primary" data-act="tree-quiz">Повторить ветку</button>' : ''}<button class="btn" data-act="tree-master">Отметить всю ветку</button><button class="btn ghost" data-act="tree-reset">Сбросить</button></div>
      <div id="confirmSlot"></div>
      ${avail.length ? `<div><p class="sec-title">Можно изучать сейчас</p><div class="links">${avail.map(n => chip(n.id)).join('')}</div></div>` : ''}
      <div><p class="sec-title">Все навыки ветки</p><div class="links">${t.nodes.map(n => chip(n.id)).join('')}</div></div>
      <details class="edit"><summary>Изменить ветку</summary>
        <form class="form" id="treeForm">
          <label class="field"><span>Название</span><input id="t-title" value="${esc(t.title)}" required></label>
          <div class="field"><span>Цвет</span><div class="swatches">${colors.map((c, i) => `<input type="radio" name="tc" id="tc-${i}" value="${esc(c)}"${c === t.color ? ' checked' : ''}><label for="tc-${i}" style="--c:${esc(c)}" title="${used.has(c) ? 'Уже у другой ветки' : esc(c)}"></label>`).join('')}</div></div>
          <label class="field"><span>Описание</span><textarea id="t-desc">${esc(t.description || '')}</textarea></label>
          <div class="p-actions"><button class="btn primary" type="submit">Сохранить</button><button class="btn" type="button" data-act="tree-add">Добавить навык</button><button class="btn danger" type="button" data-ed="del-tree">Удалить ветку</button></div>
        </form></details>`);
    $('#treeForm').addEventListener('submit', e => {
      e.preventDefault();
      const title = $('#t-title').value.trim(); if (!title) return;
      pushUndo();
      Object.assign(t, { title, color: $('input[name="tc"]:checked')?.value || t.color, description: $('#t-desc').value.trim() });
      saveProject(); toast('Ветка сохранена');
    });
    panelBody.querySelector('[data-ed="del-tree"]').onclick = () => confirmIn(`Удалить ветку «${t.title}» со всеми навыками (${t.nodes.length})?`, 'Удалить', () => {
      pushUndo();
      const ids = new Set(t.nodes.map(n => n.id));
      S.project.trees = S.project.trees.filter(x => x !== t);
      for (const x of S.project.trees) for (const n of x.nodes) for (const k of ['requires', 'requiresAny']) if (n[k]) { n[k] = n[k].filter(r => !ids.has(r)); if (!n[k].length) delete n[k]; }
      S.selTree = null; closePanel(); saveProject();
      toast('Ветка удалена', 'Ctrl + Z вернёт');
    });
  }

  function renderProjectPanel() {
    const p = S.project;
    const total = S.idx.size, m = [...S.idx.keys()].filter(isMastered).length;
    const av = [...S.idx.keys()].filter(id => nodeState(id) === 'available');
    const learning = [...S.idx.keys()].filter(id => nodeState(id) === 'learning');
    openPanel('project', `
      <div class="p-head"><span class="badge big" style="--c:var(--gold)"><span>${Math.round(total ? 100 * m / total : 0)}%</span></span>
        <div><h2 class="p-title">${esc(p.title)}</h2><div class="p-sub"><span class="tag">${m}/${total} навыков</span><span class="tag">${p.trees.length} веток</span></div></div></div>
      ${p.description ? `<p class="p-desc">${esc(p.description)}</p>` : ''}
      <div class="p-actions"><button class="btn" data-act="add-tree">${icon('plus')} Новая ветка</button></div>
      ${learning.length ? `<div><p class="sec-title">Сейчас изучаю</p><div class="links">${learning.map(chip).join('')}</div></div>` : ''}
      ${av.length ? `<div><p class="sec-title">Открыто для изучения <span class="mono">${av.length}</span></p><div class="links">${av.map(chip).join('')}</div></div>` : '<p class="muted" style="margin:0">Все доступные навыки уже в работе.</p>'}
      <details class="edit"><summary>Изменить карту</summary>
        <form class="form" id="projForm2">
          <div class="field-row"><label class="field"><span>Название карты</span><input id="pp-title" value="${esc(p.title)}" required></label>
            <label class="field"><span>Центр</span><input id="pp-center" value="${esc(p.center?.title || '')}" maxlength="16"></label></div>
          <label class="field"><span>Описание</span><textarea id="pp-desc">${esc(p.description || '')}</textarea></label>
          <div class="p-actions"><button class="btn primary" type="submit">Сохранить</button></div>
        </form></details>`);
    $('#projForm2').addEventListener('submit', e => {
      e.preventDefault();
      pushUndo();
      p.title = $('#pp-title').value.trim() || p.title;
      p.center = { ...(p.center || {}), title: $('#pp-center').value.trim() || p.title };
      p.description = $('#pp-desc').value.trim();
      saveProject(); toast('Сохранено');
    });
  }

  // ------------------------------------------------------------------ inner mind map (dive into a skill)
  const innerNode = () => (S.inner ? S.idx.get(S.inner.id)?.n : null);
  function entryAt(n, path) {
    if (!n || !path) return null;
    let list = n.questions || [], e = null;
    for (const i of path) { e = list[i]; if (e == null) return null; list = isTopic(e) ? (e.items || []) : []; }
    return e;
  }
  function listAt(n, path) {
    if (!path.length) return n.questions || (n.questions = []);
    const e = entryAt(n, path);
    return isTopic(e) ? (e.items || (e.items = [])) : null;
  }

  const mctx = document.createElement('canvas').getContext('2d');
  const FONT = '"Golos Text", "Segoe UI", system-ui, sans-serif';
  function wrapText(text, font, maxW) {
    mctx.font = font;
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = []; let cur = '';
    const push = w => {
      // split very long words
      while (mctx.measureText(w).width > maxW && w.length > 4) {
        let k = w.length - 1; while (k > 1 && mctx.measureText(w.slice(0, k) + '-').width > maxW) k--;
        lines.push(w.slice(0, k) + '-'); w = w.slice(k);
      }
      return w;
    };
    for (let w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (mctx.measureText(t).width <= maxW) { cur = t; continue; }
      if (cur) lines.push(cur);
      cur = push(w);
    }
    if (cur || !lines.length) lines.push(cur);
    return { lines, w: Math.max(...lines.map(l => mctx.measureText(l).width)) };
  }

  const HG = 40, HG_ROOT = 64, VG = 10, LH = 18;
  function buildInner() {
    const id = S.inner.id, { n } = S.idx.get(id);
    const known = knownSet(id);
    const items = [];
    const mk = (e, path, depth) => {
      const key = path.join('.');
      const it = { key, path, depth, children: [] };
      if (isTopic(e)) {
        it.kind = 'topic'; it.text = e.topic;
        const fl = flatQ(e.items);
        it.total = fl.length; it.known = fl.filter(x => known.has(x.q)).length;
        it.hasKids = (e.items || []).length > 0;
        it.folded = S.inner.collapsed.has(key);
        if (!it.folded) it.children = (e.items || []).map((c, i) => mk(c, [...path, i], depth + 1));
        const t = wrapText(it.text, `600 13.5px ${FONT}`, 230);
        mctx.font = `500 10.5px "JetBrains Mono", monospace`;
        it.cntText = `${it.known}/${it.total}`;
        const cw = mctx.measureText(it.cntText).width;
        it.lines = t.lines; it.w = Math.ceil(16 + t.w + 12 + cw + 14); it.h = t.lines.length * LH + 14;
      } else {
        it.kind = 'q'; it.text = qText(e); it.ans = qAns(e); it.known = known.has(it.text);
        const t = wrapText(it.text, `400 13px ${FONT}`, 250);
        it.lines = t.lines; it.w = Math.max(120, Math.ceil(32 + t.w + 16)); it.h = t.lines.length * LH + 16;
      }
      items.push(it);
      return it;
    };
    const root = { key: '', path: [], depth: 0, kind: 'root', text: n.title, abbr: abbrOf(n), mastered: isMastered(id) };
    const rt = wrapText(n.title, `600 18px ${FONT}`, 260);
    root.lines = rt.lines; root.w = Math.max(170, Math.ceil(rt.w + 48)); root.h = rt.lines.length * 24 + 42;
    root.children = (n.questions || []).map((c, i) => mk(c, [i], 1));
    items.push(root);

    const sub = it => (it.sub = it.children.length ? Math.max(it.h, it.children.reduce((s, c) => s + sub(c), 0) + VG * (it.children.length - 1)) : it.h);
    sub(root);
    const place = (it, xEdge, cy, dir) => {
      it.dir = dir;
      it.x = dir > 0 ? xEdge : xEdge - it.w; it.y = cy - it.h / 2;
      if (!it.children.length) return;
      const total = it.children.reduce((s, c) => s + c.sub, 0) + VG * (it.children.length - 1);
      let y = cy - total / 2;
      const nx = dir > 0 ? it.x + it.w + HG : it.x - HG;
      for (const c of it.children) { place(c, nx, y + c.sub / 2, dir); y += c.sub + VG; }
    };
    root.x = -root.w / 2; root.y = -root.h / 2; root.dir = 0;
    const all = root.children, totalSub = all.reduce((s, c) => s + c.sub + VG, 0);
    const right = [], left = [];
    let acc = 0;
    for (const c of all) { if (all.length < 4 || acc + c.sub / 2 <= totalSub / 2 || !right.length) { right.push(c); acc += c.sub + VG; } else left.push(c); }
    const side = (list, dir) => {
      const total = list.reduce((s, c) => s + c.sub, 0) + VG * Math.max(0, list.length - 1);
      let y = -total / 2;
      for (const c of list) { place(c, dir > 0 ? root.w / 2 + HG_ROOT : -root.w / 2 - HG_ROOT, y + c.sub / 2, dir); y += c.sub + VG; }
    };
    side(right, 1); side(left, -1);
    S.inner.items = items;
    S.inner.root = root;
  }

  function renderInner() {
    if (!S.inner || !S.idx.has(S.inner.id)) return;
    buildInner();
    const { t } = S.idx.get(S.inner.id);
    const c = esc(t.color), selKey = S.inner.sel ? S.inner.sel.join('.') : null;
    let eh = '', nh = '';
    const edge = (p, ch) => {
      const dir = ch.dir;
      let x1 = dir > 0 ? p.x + p.w : p.x;
      if (p.kind === 'topic' && p.hasKids) x1 += dir > 0 ? 18 : -18;
      if (p.kind === 'root') x1 = dir > 0 ? p.x + p.w - 6 : p.x + 6;
      const y1 = p.y + p.h / 2;
      const x2 = dir > 0 ? ch.x : ch.x + ch.w, y2 = ch.y + ch.h / 2;
      const dx = (x2 - x1) * 0.55;
      eh += `<path class="ie${p.kind === 'root' ? ' root' : ''}" d="M${f1(x1)},${f1(y1)} C${f1(x1 + dx)},${f1(y1)} ${f1(x2 - dx)},${f1(y2)} ${f1(x2)},${f1(y2)}"/>`;
    };
    const walk = it => { for (const ch of it.children) { edge(it, ch); walk(ch); } };
    walk(S.inner.root);
    for (const it of S.inner.items) {
      const sel = it.key === selKey ? ' sel' : '';
      const box = `<rect class="sel-box" x="-4" y="-4" width="${it.w + 8}" height="${it.h + 8}" rx="11"/>`;
      if (it.kind === 'root') {
        nh += `<g class="it k-root${it.mastered ? ' mastered' : ''}${sel}" data-path="" transform="translate(${f1(it.x)},${f1(it.y)})">${box}
          <rect class="card" width="${it.w}" height="${it.h}" rx="12"/>
          <text class="root-abbr" x="${it.w / 2}" y="20" text-anchor="middle">${esc(it.abbr.toUpperCase())}</text>
          <text class="qt" text-anchor="middle">${it.lines.map((l, i) => `<tspan x="${it.w / 2}" y="${44 + i * 24}">${esc(l)}</tspan>`).join('')}</text></g>`;
      } else if (it.kind === 'topic') {
        const fx = it.dir > 0 ? it.w + 9 : -9;
        nh += `<g class="it k-topic${sel}" data-path="${it.key}" transform="translate(${f1(it.x)},${f1(it.y)})">${box}
          <rect class="card" width="${it.w}" height="${it.h}" rx="${Math.min(it.h / 2, 13)}"/>
          <text class="qt">${it.lines.map((l, i) => `<tspan x="16" y="${20 + i * LH}">${esc(l)}</tspan>`).join('')}</text>
          <text class="cnt" x="${it.w - 14}" y="20" text-anchor="end">${it.cntText}</text>
          ${it.hasKids ? `<g data-fold="1"><circle class="fold" cx="${fx}" cy="${f1(it.h / 2)}" r="8"/><text class="fold-t" x="${fx}" y="${f1(it.h / 2 + 3.5)}">${it.folded ? '+' : '−'}</text></g>` : ''}</g>`;
      } else {
        nh += `<g class="it k-q${it.known ? ' known' : ''}${sel}" data-path="${it.key}" transform="translate(${f1(it.x)},${f1(it.y)})">${box}
          <rect class="card" width="${it.w}" height="${it.h}" rx="8"/>
          <g class="chk" data-check="1"><circle cx="16" cy="17" r="12" fill="transparent"/><circle class="chk-c" cx="16" cy="17" r="7"/><path class="tick" d="M12.6 17.2l2.4 2.4 4.2-4.6"/></g>
          <text class="qt">${it.lines.map((l, i) => `<tspan x="32" y="${21 + i * LH}">${esc(l)}</tspan>`).join('')}</text>
          ${it.ans ? `<circle class="has-a" cx="${it.w - 7}" cy="7" r="2.2"><title>Есть ответ</title></circle>` : ''}</g>`;
      }
    }
    if (!S.inner.root.children.length) nh += `<text class="inner-empty" y="${S.inner.root.h / 2 + 36}">Нажми Tab, чтобы добавить первый вопрос</text>`;
    innerG.setAttribute('style', `--c:${c}`);
    I_EDGES.innerHTML = eh; I_NODES.innerHTML = nh;
    renderCrumbs();
    positionInline();
  }

  function renderCrumbs() {
    const { n, t } = S.idx.get(S.inner.id);
    const parts = [`<span style="color:${esc(t.color)}">${esc(t.title)}</span>`, `<span class="${S.inner.sel && S.inner.sel.length ? '' : 'cur'}">${esc(n.title)}</span>`];
    if (S.inner.sel) {
      for (let i = 1; i <= S.inner.sel.length; i++) {
        const e = entryAt(n, S.inner.sel.slice(0, i));
        if (isTopic(e)) parts.push(`<span class="${i === S.inner.sel.length ? 'cur' : ''}">${esc(e.topic)}</span>`);
      }
    }
    $('#crumbPath').innerHTML = parts.join('<span class="sep">/</span>');
    const s = qStats(S.inner.id);
    $('#crumbStat').textContent = s.total ? `${s.known} / ${s.total}` : '';
  }

  function innerFitView() {
    const its = S.inner.items;
    const x0 = Math.min(...its.map(i => i.x)) - 30, x1 = Math.max(...its.map(i => i.x + i.w)) + 30;
    const y0 = Math.min(...its.map(i => i.y)) - 30, y1 = Math.max(...its.map(i => i.y + i.h)) + 30;
    const b = viewport();
    const k = clamp(Math.min(b.w / (x1 - x0), (b.h - 150) / (y1 - y0)), 0.3, 1.15);
    return viewFor((x0 + x1) / 2, (y0 + y1) / 2 + 10 / k, k);
  }
  function fitInner() { if (S.inner) animateView(innerFitView(), 420); }

  async function dive(id, selPath) {
    if (!S.idx.has(id) || S.anim) return;
    commitInline(); hideCtx();
    if (S.inner) { if (S.inner.id === id) { if (selPath) selectInner(selPath); return; } leaveInnerInstant(); }
    S.anim = true;
    S.sel = id; S.selTree = null; syncHash();
    refreshMap();
    if (isNarrow()) closePanel();
    const p = S.layout.pos.get(id);
    S.mapView = { ...S.view };
    try { await Promise.race([document.fonts ? document.fonts.ready : null, new Promise(r => setTimeout(r, 400))]); } catch (e) { /* ignore */ }
    svg.classList.add('fade-world');
    await flyTo(p.x, p.y, clamp(S.view.k * 3.2, 1.8, 3.5), 360, 'in');
    world.style.display = 'none';
    S.inner = { id, sel: selPath || [], collapsed: new Set(), items: [] };
    app.classList.add('inner-mode');
    $('#crumbs').hidden = false;
    svg.classList.add('fade-inner');
    renderInner();
    innerG.removeAttribute('hidden');
    const fit = innerFitView();
    S.view = { k: fit.k * 0.55, x: fit.x + (1 - 0.55) * (viewport().w / 2 - fit.x), y: fit.y + (1 - 0.55) * (viewport().h / 2 - fit.y) };
    applyView();
    void innerG.getBoundingClientRect();
    svg.classList.remove('fade-inner');
    await animateView(fit, 420);
    S.anim = false;
    renderHint();
    const deep = !!(selPath && selPath.length);
    if (isNarrow() && !deep) { S.inner.sel = []; renderInner(); } // keep the mind map visible on phones
    else selectInner(S.inner.sel, { reveal: deep });
  }
  async function exitInner() {
    if (!S.inner || S.anim) return;
    commitInline();
    S.anim = true;
    const id = S.inner.id;
    svg.classList.add('fade-inner');
    const b = viewport();
    await animateView({ k: S.view.k * 0.6, x: S.view.x * 0.6 + b.w / 2 * 0.4, y: S.view.y * 0.6 + b.h / 2 * 0.4 }, 260, 'in');
    finishLeave();
    const p = S.layout.pos.get(id), back = S.mapView || S.view;
    S.view = p ? viewFor(p.x, p.y, clamp(back.k * 3.2, 1.8, 3.5)) : back;
    applyView();
    void world.getBoundingClientRect();
    svg.classList.remove('fade-world');
    await animateView(back, 460);
    S.anim = false;
    if (S.idx.has(id)) selectNode(id); else deselect();
  }
  function finishLeave() {
    innerG.setAttribute('hidden', ''); I_EDGES.innerHTML = ''; I_NODES.innerHTML = '';
    world.style.display = '';
    S.inner = null;
    app.classList.remove('inner-mode');
    $('#crumbs').hidden = true;
    renderHint();
  }
  function leaveInnerInstant() {
    if (!S.inner) return;
    commitInline();
    finishLeave();
    svg.classList.remove('fade-world', 'fade-inner');
    if (S.mapView) S.view = { ...S.mapView };
    applyView();
    refreshMap();
  }
  $('#backBtn').addEventListener('click', () => exitInner());
  $('#crumbPath').addEventListener('click', () => { if (S.inner) selectInner([]); });

  function selectInner(path, opts = {}) {
    if (!S.inner) return;
    S.inner.sel = path;
    renderInner();
    if (path) renderInnerPanel(); else closePanel();
    if (path && (opts.reveal || opts.keyboard)) {
      const it = S.inner.items.find(x => x.key === path.join('.'));
      if (it) ensureVisible(it.x, it.y, it.w, it.h);
    }
  }
  function renderInnerPanel() {
    const path = S.inner.sel;
    if (!path) { closePanel(); return; }
    const id = S.inner.id, { n, t } = S.idx.get(id);
    if (!path.length) { renderNodePanel(id); return; }
    const e = entryAt(n, path);
    if (!e) { renderNodePanel(id); return; }
    const known = knownSet(id);
    const crumbs = [];
    for (let i = 1; i < path.length; i++) { const x = entryAt(n, path.slice(0, i)); if (isTopic(x)) crumbs.push(`<button class="link-chip" data-act="q-select" data-path="${path.slice(0, i).join('.')}" style="--c:${esc(t.color)}">${esc(x.topic)}</button>`); }
    const head = `<div class="p-head">${badge(id)}<div><div class="p-sub" style="margin:0 0 4px"><button class="tag tree" data-act="q-select" data-path="" style="--c:${esc(t.color)};border:0;cursor:pointer">${esc(n.title)}</button></div></div></div>
      ${crumbs.length ? `<div class="links">${crumbs.join('')}</div>` : ''}`;
    const tools = `<div class="p-actions"><button class="btn small" data-act="q-child">Подвопрос <span class="kbd">Tab</span></button><button class="btn small" data-act="q-sibling">Рядом <span class="kbd">Enter</span></button><button class="btn small" data-act="q-rename">Переименовать <span class="kbd">F2</span></button><button class="btn small danger" data-act="q-delete">Удалить</button></div>`;
    if (isTopic(e)) {
      const fl = flatQ(e.items), k = fl.filter(x => known.has(x.q)).length;
      openPanel('inner-topic', `${head}
        <h2 class="p-title">${esc(e.topic)}</h2>
        <div style="--c:${esc(t.color)}"><p class="sec-title"><span>Подтема</span><span class="mono">${k}/${fl.length}</span></p><div class="progress"><i style="width:${fl.length ? Math.round(100 * k / fl.length) : 0}%"></i></div></div>
        <div class="links">${(e.items || []).map((x, i) => `<button class="link-chip${!isTopic(x) && known.has(qText(x)) ? ' done' : ''}" data-act="q-select" data-path="${[...path, i].join('.')}" style="--c:${esc(t.color)}"><span class="dot"></span>${esc(qText(x).length > 60 ? qText(x).slice(0, 58) + '…' : qText(x))}</button>`).join('')}</div>
        ${tools}`);
      return;
    }
    const q = qText(e), a = qAns(e), isK = known.has(q);
    openPanel('inner-q', `${head}
      <h2 class="p-title q">${esc(q)}</h2>
      <div class="p-actions"><button class="btn ${isK ? 'good' : 'primary'}" data-act="q-known">${isK ? 'Знаю ✓' : 'Знаю ответ'}</button>
        ${a ? '' : `<button class="btn" data-act="q-ask">${S.sample ? 'Спросить Claude' : 'Спросить Claude ↗'}</button>`}</div>
      <div style="--c:${esc(t.color)}">${a ? `<p class="sec-title">Ответ</p><div class="answer-box" id="qAnswer">${esc(a)}</div>` : '<div class="answer-box" id="qAnswer" hidden></div>'}</div>
      <label class="field"><span>${a ? 'Изменить ответ' : 'Записать свой ответ'}</span><textarea id="qAnsEdit" class="notes" placeholder="Коротко, своими словами">${esc(a)}</textarea></label>
      ${tools}`);
  }

  function innerKey(e) {
    const path = S.inner.sel, k = e.key;
    if (k === 'Tab') { e.preventDefault(); innerAddChild(path || []); return; }
    if (k === 'Enter') { e.preventDefault(); if (path && path.length) innerAddSibling(path); else innerAddChild([]); return; }
    if ((k === 'F2' || k === ' ') && path) { e.preventDefault(); startRenameItem(path); return; }
    if ((k === 'Delete' || k === 'Backspace') && path && path.length) { e.preventDefault(); innerDelete(path); return; }
    if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown') && path && path.length) { e.preventDefault(); innerMove(path, k === 'ArrowUp' ? -1 : 1); return; }
    if (k.startsWith('Arrow')) {
      e.preventDefault();
      const its = S.inner.items;
      const cur = its.find(x => x.key === (path || []).join('.')) || S.inner.root;
      const b = spatialPick({ x: cur.x + cur.w / 2, y: cur.y + cur.h / 2 }, its.map(x => ({ key: x.key, it: x, x: x.x + x.w / 2, y: x.y + x.h / 2 })), k);
      if (b) selectInner(b.it.path, { keyboard: true });
      return;
    }
    if (k === '+' || k === '=') { zoomCenter(1.3); return; }
    if (k === '-') { zoomCenter(1 / 1.3); return; }
    if (k === '0') { fitInner(); return; }
    if (k === '?') { showHelp(); return; }
    if (path && !e.ctrlKey && !e.metaKey && !e.altKey && k.length === 1 && /\p{L}/u.test(k)) { e.preventDefault(); startRenameItem(path, k); }
  }

  function startRenameItem(path, initial) {
    const n = innerNode(); if (!n) return;
    const it = S.inner.items.find(x => x.key === path.join('.'));
    if (!it) return;
    if (!path.length) { S.sel = S.inner.id; startInline({ kind: 'item', path, orig: n.title, commit: v => { renameNode(S.inner.id, v); } }, initial); return; }
    const e = entryAt(n, path);
    S.inner.sel = path;
    ensureVisible(it.x, it.y, it.w, it.h).then(() => startInline({ kind: 'item', path, orig: qText(e), commit: v => innerRename(path, v) }, initial));
  }
  function innerRename(path, v) {
    const n = innerNode(), e = entryAt(n, path); if (!e) return;
    pushUndo();
    const list = listAt(n, path.slice(0, -1)), i = path[path.length - 1];
    if (isTopic(e)) e.topic = v;
    else { const old = qText(e); if (typeof e === 'string') list[i] = v; else e.q = v; renameKnown(S.inner.id, old, v); }
    saveProject();
  }
  function uniqueQ(n, base = 'Новый вопрос') {
    const have = new Set(flatQ(n.questions).map(x => x.q));
    let q = base, i = 2; while (have.has(q)) q = `${base} ${i++}`;
    return q;
  }
  function innerAddChild(path) {
    const n = innerNode(); if (!n) return;
    pushUndo();
    let newPath;
    if (!path.length) { n.questions = n.questions || []; n.questions.push(uniqueQ(n)); newPath = [n.questions.length - 1]; }
    else {
      let e = entryAt(n, path); if (e == null) return;
      if (!isTopic(e)) {
        const list = listAt(n, path.slice(0, -1));
        const topic = { topic: qText(e), items: [] };
        if (qAns(e)) topic.items.push({ q: 'Ответ', a: qAns(e) });
        list[path[path.length - 1]] = topic; e = topic;
        toast('Вопрос стал подтемой', 'Ctrl + Z вернёт');
      }
      e.items.push(uniqueQ(n));
      S.inner.collapsed.delete(path.join('.'));
      newPath = [...path, e.items.length - 1];
    }
    saveProject();
    selectInner(newPath);
    startRenameItem(newPath);
  }
  function innerAddSibling(path) {
    const n = innerNode(); if (!n || !path.length) { innerAddChild([]); return; }
    pushUndo();
    const list = listAt(n, path.slice(0, -1)), i = path[path.length - 1];
    list.splice(i + 1, 0, uniqueQ(n));
    const newPath = [...path.slice(0, -1), i + 1];
    saveProject();
    selectInner(newPath);
    startRenameItem(newPath);
  }
  function innerDelete(path) {
    const n = innerNode(); if (!n || !path.length) return;
    pushUndo();
    const list = listAt(n, path.slice(0, -1)), i = path[path.length - 1];
    const [gone] = list.splice(i, 1);
    saveProject();
    const next = list.length ? [...path.slice(0, -1), Math.min(i, list.length - 1)] : path.slice(0, -1);
    selectInner(next);
    toast(isTopic(gone) ? `Подтема удалена: ${gone.topic}` : 'Вопрос удалён', 'Ctrl + Z вернёт');
  }
  function innerMove(path, d) {
    const n = innerNode(); if (!n) return;
    const list = listAt(n, path.slice(0, -1)), i = path[path.length - 1], j = i + d;
    if (j < 0 || j >= list.length) return;
    pushUndo();
    [list[i], list[j]] = [list[j], list[i]];
    saveProject();
    selectInner([...path.slice(0, -1), j], { keyboard: true });
  }
  function toggleInnerKnown(path) {
    const e = entryAt(innerNode(), path); if (!e || isTopic(e)) return;
    const q = qText(e);
    S.inner.sel = path;
    toggleKnown(S.inner.id, q, !knownSet(S.inner.id).has(q));
  }
  function toggleFold(path) {
    const k = path.join('.');
    S.inner.collapsed.has(k) ? S.inner.collapsed.delete(k) : S.inner.collapsed.add(k);
    renderInner();
  }
  function saveAnswer(path, text) {
    const n = innerNode(), e = entryAt(n, path); if (!e || isTopic(e)) return;
    const v = String(text).trim();
    if (v === qAns(e)) return;
    pushUndo();
    const list = listAt(n, path.slice(0, -1)), i = path[path.length - 1];
    list[i] = v ? { q: qText(e), a: v } : qText(e);
    saveProject();
    toast(v ? 'Ответ сохранён' : 'Ответ удалён');
  }

  // ------------------------------------------------------------------ persistence of project / progress
  let projTimer = null;
  function saveProject() {
    indexProject();
    computeLayout();
    renderMap();
    if (S.inner) renderInner();
    rerenderOpenPanel(); renderLegend(); renderHud(); updateDock(); renderHint();
    clearTimeout(projTimer);
    const pid = S.pid, data = S.project;
    projTimer = setTimeout(() => {
      Store.set('project-' + pid, data);
      if (!isBuiltin(pid)) {
        const i = S.customIndex.find(x => x.id === pid);
        if (i && i.title !== data.title) { i.title = data.title; Store.set('projects-index', S.customIndex); }
      }
    }, 400);
  }
  function saveProgress() { Store.set('progress-' + S.pid, S.progress); }
  function savePrefs() { Store.set('prefs', S.prefs); }

  // Edits of a built-in map are stored as a full copy. Copies saved before the redesign get the new
  // built-in map instead, keeping the positions the user dragged nodes to.
  function upgradeSaved(saved, base) {
    if (!saved || !base || saved.baseRev) return saved;
    const fresh = clone(base);
    const posById = new Map();
    for (const t of saved.trees || []) for (const n of t.nodes || []) if (n.pos) posById.set(n.id, n.pos);
    for (const t of fresh.trees) for (const n of t.nodes) if (posById.has(n.id)) n.pos = posById.get(n.id);
    return fresh;
  }

  async function openProject(id, opts = {}) {
    const b = builtin(id);
    let saved = await Store.get('project-' + id);
    if (b) saved = upgradeSaved(saved, b);
    const base = saved || (b && clone(b));
    if (!base) return false;
    if (S.inner) leaveInnerInstant();
    S.pid = id; S.project = normalizeProject(base);
    if (b && !S.project.baseRev) S.project.baseRev = b.rev || 'builtin';
    S.progress = (await Store.get('progress-' + id)) || { nodes: {}, reviews: {} };
    S.progress.nodes = S.progress.nodes || {}; S.progress.reviews = S.progress.reviews || {};
    S.sel = null; S.selTree = null; S.undo = []; S.redo = []; S.fresh = new Set();
    closePanel();
    indexProject(); computeLayout(); renderMap(); renderLegend(); renderHud(); updateDock(); renderHint();
    $('#revertBtn').hidden = !b;
    if (!opts.keepView) fitAll(false);
    S.prefs.last = id; savePrefs();
    if (b && saved && saved.baseRev && b.rev && saved.baseRev !== b.rev && !opts.keepView) toast('Вышла новая версия карты', 'Меню ⋯ → «Вернуть исходную карту», если хочешь её');
    return true;
  }
  function normalizeProject(p) {
    p.trees = (p.trees || []).filter(t => t && typeof t === 'object');
    for (const t of p.trees) { t.nodes = Array.isArray(t.nodes) ? t.nodes : []; t.color = t.color || '#8f939e'; }
    p.center = p.center || { title: p.title };
    return p;
  }
  function validateProject(p) {
    if (!p || typeof p !== 'object' || !p.id || !p.title || !Array.isArray(p.trees)) return 'Нужен объект с полями id, title и trees';
    const ids = new Set();
    for (const t of p.trees) {
      if (!t || !t.id || !Array.isArray(t.nodes)) return 'У каждой ветки должны быть id и nodes';
      for (const n of t.nodes) { if (!n.id || !n.title) return 'У каждого навыка должны быть id и title'; if (ids.has(n.id)) return `Повторяется id навыка: ${n.id}`; ids.add(n.id); }
    }
    return null;
  }

  // ------------------------------------------------------------------ projects menu
  function allProjects() {
    const list = BUILTIN.map(p => ({ id: p.id, title: p.title, builtin: true }));
    for (const c of S.customIndex) if (!list.some(x => x.id === c.id)) list.push({ id: c.id, title: c.title, builtin: false });
    return list;
  }
  function renderProjectMenu() {
    $('#projectMenu').innerHTML = allProjects().map(p => `<button data-pid="${esc(p.id)}" class="${p.id === S.pid ? 'active' : ''}"><span class="dot" style="--c:${p.id === S.pid ? 'var(--gold)' : 'var(--dim)'}"></span>${esc(p.title)}</button>`).join('')
      + `<hr><button data-pact="new">${icon('plus', 'sm')} Новый проект</button><button data-pact="import">Импорт проекта из JSON</button>`
      + (!isBuiltin(S.pid) ? '<button data-pact="delete" class="danger">Удалить этот проект</button>' : '')
      + '<p class="menu-note">Проект это отдельная карта со своими ветками и прогрессом.</p>';
  }
  function toggleMenu(btn, menu, show) {
    const open = show ?? menu.hidden;
    $$('.menu').forEach(x => { x.hidden = true; });
    $$('[aria-haspopup]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    menu.hidden = !open; btn.setAttribute('aria-expanded', String(open));
  }
  $('#projectBtn').addEventListener('click', e => { e.stopPropagation(); renderProjectMenu(); toggleMenu($('#projectBtn'), $('#projectMenu')); });
  $('#moreBtn').addEventListener('click', e => { e.stopPropagation(); toggleMenu($('#moreBtn'), $('#moreMenu')); });
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest('.menu') && !e.target.closest('[aria-haspopup]') && !e.target.closest('.search')) $$('.menu').forEach(m => { if (m !== ctx) m.hidden = true; });
    if (!e.target.closest('#ctxMenu')) hideCtx();
  });
  $('#projectMenu').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    $('#projectMenu').hidden = true;
    if (b.dataset.pid) { if (b.dataset.pid !== S.pid) await openProject(b.dataset.pid); return; }
    if (b.dataset.pact === 'new') newProjectForm();
    if (b.dataset.pact === 'import') pickFile();
    if (b.dataset.pact === 'delete') confirmModal(`Удалить проект «${S.project.title}»?`, 'Карта и прогресс по ней удалятся. Сначала можно сохранить карту через меню ⋯ → «Экспорт карты в JSON».', 'Удалить проект', async () => {
      const id = S.pid;
      S.customIndex = S.customIndex.filter(x => x.id !== id); Store.set('projects-index', S.customIndex);
      Store.del('project-' + id); Store.del('progress-' + id);
      await openProject(BUILTIN[0] ? BUILTIN[0].id : S.customIndex[0]?.id);
    });
  });
  function newProjectForm() {
    openModal(`<h2>Новый проект</h2>
      <p class="help-text">Отдельная карта навыков: например, «System Design», «English» или подготовка к конкретной вакансии.</p>
      <form class="form" id="projForm" style="margin:0">
        <label class="field"><span>Название</span><input id="pj-title" required placeholder="System Design"></label>
        <label class="field"><span>Описание</span><textarea id="pj-desc" placeholder="Что хочешь прокачать и зачем"></textarea></label>
        <label class="field"><span>Первая ветка</span><input id="pj-tree" required placeholder="Основы"></label>
        <div class="p-actions"><button class="btn primary" type="submit">Создать</button><button class="btn ghost" type="button" data-close>Отмена</button></div>
      </form>`);
    $('#pj-title').focus();
    $('#projForm').addEventListener('submit', async e => {
      e.preventDefault();
      const title = $('#pj-title').value.trim(); if (!title) return;
      let id = slug(title), i = 2; while (allProjects().some(p => p.id === id)) id = `${slug(title)}-${i++}`;
      const tTitle = $('#pj-tree').value.trim() || 'Основы', tid = slug(tTitle);
      const p = { schema: 1, id, title, description: $('#pj-desc').value.trim(), center: { title: title.length > 14 ? title.split(' ')[0] : title },
        trees: [{ id: tid, title: tTitle, color: PALETTE[0], description: '', nodes: [{ id: `${tid}.start`, title: tTitle, description: '', keystone: true, questions: [] }] }] };
      closeModal();
      await createProject(p);
      selectNode(`${tid}.start`);
      toast(`Проект «${p.title}» создан`, 'Tab добавляет следующий навык, двойной клик открывает мини-карту');
    });
  }
  async function createProject(p) {
    if (isBuiltin(p.id) || S.customIndex.some(x => x.id === p.id)) {
      let i = 2; const base = p.id; while (isBuiltin(`${base}-${i}`) || S.customIndex.some(x => x.id === `${base}-${i}`)) i++; p.id = `${base}-${i}`;
    }
    Store.set('project-' + p.id, p);
    S.customIndex.push({ id: p.id, title: p.title }); Store.set('projects-index', S.customIndex);
    await openProject(p.id);
  }

  // ------------------------------------------------------------------ files: export / import
  async function saveFile(filename, obj) {
    const data = JSON.stringify(obj, null, 2);
    if (S.downloads) {
      try { await S.downloads.save({ filename, data }); return; } catch (e) { if (e && e.code !== 'unavailable') return; }
    }
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { /* sandboxed */ }
    showJson(filename, data);
  }
  function showJson(filename, data) {
    openModal(`<h2>${esc(filename)}</h2><p class="help-text">Если файл не скачался, скопируй текст ниже и сохрани его как ${esc(filename)}.</p>
      <textarea class="notes mono" id="jsonOut" style="min-height:260px;font-size:12px" readonly>${esc(data)}</textarea>
      <div class="p-actions"><button class="btn primary" id="copyJson">Скопировать</button><button class="btn ghost" data-close>Закрыть</button></div>`);
    $('#copyJson').onclick = () => {
      navigator.clipboard.writeText(data).then(() => toast('Скопировано'), () => { const ta = $('#jsonOut'); ta.focus(); ta.select(); });
    };
  }
  function exportProject() { const p = clone(S.project); delete p.baseRev; saveFile(`${S.pid}.gametree.json`, p); }
  function exportProgress() { saveFile(`${S.pid}.progress.json`, { kind: 'gametree-progress', project: S.pid, progress: S.progress }); }
  function pickFile() {
    openModal(`<h2>Импорт</h2>
      <p class="help-text">JSON-файл карты GameTree (экспорт или файл, который сделал Claude) или файл прогресса, сохранённый через меню.</p>
      <div class="p-actions"><button class="btn primary" id="pickBtn">Выбрать файл</button></div>
      <label class="field"><span>или вставь JSON сюда</span><textarea class="notes mono" id="jsonIn" style="min-height:150px;font-size:12px"></textarea></label>
      <div class="p-actions"><button class="btn" id="jsonApply">Загрузить</button><button class="btn ghost" data-close>Отмена</button></div><p id="importErr" class="small" style="color:var(--danger);margin:0"></p>`);
    $('#pickBtn').onclick = () => $('#fileInput').click();
    $('#jsonApply').onclick = () => importText($('#jsonIn').value);
  }
  $('#fileInput').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader(); r.onload = () => importText(String(r.result)); r.readAsText(f);
    e.target.value = '';
  });
  async function importText(text) {
    const err = m => { const el = $('#importErr'); if (el) el.textContent = m; else toast('Не получилось', m); };
    let obj; try { obj = JSON.parse(text); } catch (e) { err('Это не похоже на JSON: ' + e.message); return; }
    if (obj.kind === 'gametree-progress') {
      if (!obj.progress || !obj.project) { err('В файле нет прогресса'); return; }
      Store.set('progress-' + obj.project, obj.progress);
      closeModal();
      if (obj.project === S.pid) { S.progress = obj.progress; afterProgress(levelOf(computeXP())); }
      toast('Прогресс загружен'); return;
    }
    const msg = validateProject(obj); if (msg) { err(msg); return; }
    closeModal();
    if (obj.id === S.pid) { pushUndo(); S.project = normalizeProject(obj); if (isBuiltin(S.pid)) S.project.baseRev = builtin(S.pid).rev || 'builtin'; saveProject(); toast('Карта обновлена', 'Ctrl + Z вернёт прежнюю'); return; }
    await createProject(normalizeProject(obj));
    toast(`Проект «${obj.title}» загружен`);
  }

  // ------------------------------------------------------------------ modal
  const modal = $('#modal'), modalCard = $('#modalCard');
  function openModal(html, cls = '') { modalCard.className = 'modal-card ' + cls; modalCard.innerHTML = html; modal.hidden = false; }
  function closeModal() { modal.hidden = true; modalCard.innerHTML = ''; quiz = null; svg.focus({ preventScroll: true }); }
  modal.addEventListener('click', e => { if (e.target === modal || e.target.closest('[data-close]')) closeModal(); });

  // ------------------------------------------------------------------ quiz / review
  let quiz = null;
  function quizPool(scope) {
    const pool = [];
    S.idx.forEach(({ n, t }, id) => {
      if (scope.node && id !== scope.node) return;
      if (scope.tree && t.id !== scope.tree) return;
      const st = nodeState(id);
      if (!scope.node && !scope.tree && st !== 'mastered' && st !== 'learning') return;
      if (scope.due && !needsReview(id)) return;
      for (const x of flatQ(n.questions)) pool.push({ id, q: x.q, a: x.a, g: x.group });
    });
    return pool;
  }
  function pickQuestion() {
    const pool = quiz.pool.filter(x => !quiz.seen.has(x.id + '|' + x.q));
    if (!pool.length) return null;
    const w = pool.map(x => {
      const r = S.progress.reviews[x.id + '|' + x.q];
      if (!r) return 3;
      const age = (now() - (r.last || 0)) / DAY;
      return Math.max(0.3, 1 + (r.bad || 0) * 2 - Math.min(2, (r.good || 0) * 0.5) + Math.min(3, age / 7));
    });
    let s = w.reduce((a, b) => a + b, 0) * Math.random();
    for (let i = 0; i < pool.length; i++) { s -= w[i]; if (s <= 0) return pool[i]; }
    return pool[pool.length - 1];
  }
  function openQuiz(scope = {}) {
    const due = [...S.idx.keys()].filter(needsReview);
    if (!scope.node && !scope.tree && due.length && scope.due === undefined) scope.due = true;
    quiz = { scope, pool: quizPool(scope), seen: new Set(), good: 0, bad: 0, cur: null };
    renderQuiz();
  }
  function quizScopes() {
    const s = quiz.scope;
    const due = [...S.idx.keys()].filter(needsReview).length;
    return `<div class="scope">
      <button data-scope="all" class="${!s.node && !s.tree && !s.due ? 'active' : ''}">Всё изученное</button>
      ${due ? `<button data-scope="due" class="${s.due ? 'active' : ''}">Пора повторить ${due}</button>` : ''}
      ${s.node ? `<button class="active">${esc(S.idx.get(s.node).n.title)}</button>` : ''}
      ${S.project.trees.map(t => `<button data-scope="tree:${esc(t.id)}" class="${s.tree === t.id ? 'active' : ''}"><span class="dot" style="--c:${esc(t.color)}"></span>${esc(t.title)}</button>`).join('')}
    </div>`;
  }
  function renderQuiz() {
    quiz.cur = pickQuestion();
    const done = quiz.good + quiz.bad;
    if (!quiz.cur) {
      openModal(`<h2>Повторение</h2>${quizScopes()}
        ${quiz.pool.length ? `<p class="quiz-q">Готово: ${quiz.good} из ${done} вспомнил уверенно.</p><p class="help-text">Вопросы с ответом «не помню» будут попадаться чаще.</p>`
          : '<p class="help-text">Здесь пока нет вопросов. Отметь навыки как изученные или выбери ветку выше.</p>'}
        <div class="p-actions">${quiz.pool.length ? '<button class="btn primary" id="qzAgain">Ещё круг</button>' : ''}<button class="btn ghost" data-close>Закрыть</button></div>`);
      const again = $('#qzAgain'); if (again) again.onclick = () => openQuiz(quiz.scope);
      bindScopes(); return;
    }
    const { n, t } = S.idx.get(quiz.cur.id);
    openModal(`<h2>Повторение</h2>${quizScopes()}
      <div class="quiz-meta"><span class="tag tree" style="--c:${esc(t.color)}">${esc(n.title)}</span><span class="mono">${done + 1} / ${quiz.pool.length} · помню ${quiz.good}</span></div>
      <div>${quiz.cur.g ? `<div class="quiz-group" style="--c:${esc(t.color)}">${esc(quiz.cur.g)}</div>` : ''}<div class="quiz-q">${esc(quiz.cur.q)}</div></div>
      <div class="answer-box" id="qzAnswer" style="--c:${esc(t.color)}" hidden></div>
      <div class="p-actions"><button class="btn" id="qzReveal">${quiz.cur.a ? 'Показать ответ' : (S.sample ? 'Спросить Claude' : 'Спросить Claude ↗')} <span class="kbd">Пробел</span></button></div>
      <div class="quiz-btns"><button class="btn danger" data-rate="bad">Не помню <span class="kbd">1</span></button><button class="btn good" data-rate="good">Помню <span class="kbd">2</span></button></div>`);
    bindScopes();
    $('#qzReveal').onclick = () => {
      const box = $('#qzAnswer');
      if (quiz.cur.a) { box.hidden = false; box.textContent = quiz.cur.a; } else askClaude(n, quiz.cur.q, box);
    };
    $$('[data-rate]', modalCard).forEach(b => { b.onclick = () => rate(b.dataset.rate === 'good'); });
  }
  function bindScopes() {
    $$('[data-scope]', modalCard).forEach(b => {
      b.onclick = () => { const v = b.dataset.scope; openQuiz(v === 'all' ? { due: false } : v === 'due' ? { due: true } : { tree: v.slice(5) }); };
    });
  }
  function rate(good) {
    const c = quiz.cur, key = c.id + '|' + c.q;
    const r = S.progress.reviews[key] || (S.progress.reviews[key] = { good: 0, bad: 0 });
    good ? r.good++ : r.bad++; r.last = now();
    const p = S.progress.nodes[c.id] || (S.progress.nodes[c.id] = {});
    p.rv = now();
    if (good) { const k = new Set(p.known || []); k.add(c.q); p.known = [...k]; quiz.good++; } else quiz.bad++;
    quiz.seen.add(key);
    saveProgress(); refreshMap(); renderHud(); renderLegend(); rerenderOpenPanel();
    if (S.inner) renderInner();
    renderQuiz();
  }
  $('#reviewBtn').addEventListener('click', () => openQuiz({}));

  // ------------------------------------------------------------------ search
  function searchNodes(q) {
    q = q.trim().toLowerCase(); if (!q) return [];
    const res = [];
    S.idx.forEach(({ n, t }, id) => {
      if (n.title.toLowerCase().includes(q) || id.toLowerCase().includes(q) || (n.abbr || '').toLowerCase() === q) { res.push({ id, score: 2, hint: t.title }); return; }
      const hit = flatQ(n.questions).find(x => x.q.toLowerCase().includes(q) || x.group.toLowerCase().includes(q));
      if (hit) res.push({ id, score: 1, hint: hit.q, path: hit.path });
      else if ((n.description || '').toLowerCase().includes(q)) res.push({ id, score: 1, hint: n.description });
    });
    return res.sort((a, b) => b.score - a.score);
  }
  const searchEl = $('#search'), resultsEl = $('#searchResults');
  searchEl.addEventListener('input', () => {
    S.search = searchEl.value.trim();
    const res = searchNodes(S.search).slice(0, 8);
    resultsEl.innerHTML = res.length ? res.map(r => `<button class="result" data-goto="${esc(r.id)}"${r.path ? ` data-qpath="${r.path.join('.')}"` : ''}>${badge(r.id)}<span>${esc(S.idx.get(r.id).n.title)}</span><small>${esc(r.hint)}</small></button>`).join('')
      : (S.search ? '<p class="menu-note">Ничего не нашлось</p>' : '');
    resultsEl.hidden = !S.search;
    if (!S.inner) refreshMap();
  });
  searchEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const f = resultsEl.querySelector('[data-goto]'); if (f) f.click(); }
    if (e.key === 'Escape') { searchEl.value = ''; searchEl.dispatchEvent(new Event('input')); svg.focus({ preventScroll: true }); }
  });
  resultsEl.addEventListener('click', e => {
    const b = e.target.closest('[data-goto]'); if (!b) return;
    searchEl.value = ''; S.search = ''; resultsEl.hidden = true;
    const id = b.dataset.goto;
    if (b.dataset.qpath != null) { dive(id, parsePath(b.dataset.qpath)); return; }
    if (S.inner) leaveInnerInstant();
    selectNode(id, { fly: true });
  });

  // ------------------------------------------------------------------ more menu, onboarding, help
  $('#moreMenu').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    $('#moreMenu').hidden = true;
    const a = b.dataset.act;
    if (a === 'export-project') exportProject();
    if (a === 'export-progress') exportProgress();
    if (a === 'import') pickFile();
    if (a === 'onboarding') showOnboarding();
    if (a === 'add-tree') { if (S.inner) leaveInnerInstant(); addTree(); }
    if (a === 'help') showHelp();
    if (a === 'revert') confirmModal('Вернуть исходную карту?', `Все правки карты «${S.project.title}» удалятся. Прогресс останется.`, 'Вернуть исходную', async () => {
      Store.del('project-' + S.pid); await openProject(S.pid, { keepView: true }); toast('Карта восстановлена');
    });
    if (a === 'reset-progress') confirmModal('Сбросить прогресс?', `Все отметки, вопросы и заметки по карте «${S.project.title}» удалятся. Можно сначала сохранить прогресс в файл.`, 'Сбросить всё', () => {
      S.progress = { nodes: {}, reviews: {} }; saveProgress(); afterProgress(1);
    });
  });
  function showOnboarding() {
    openModal(`<h2>Что ты уже знаешь?</h2>
      <p class="help-text">Отметь ветки, которые уже прокачаны. Навыки в них станут освоенными, а следующие откроются. Потом всё можно поправить вручную.</p>
      <div class="onb-grid">${S.project.trees.map(t => `<label class="onb-item" style="--c:${esc(t.color)}"><input type="checkbox" value="${esc(t.id)}"><span>${esc(t.title)}</span></label>`).join('')}</div>
      <div class="p-actions"><button class="btn primary" id="onbGo">Поехали</button><button class="btn ghost" id="onbSkip">Начать с нуля</button></div>`);
    const finish = () => { S.prefs.onboarded = true; savePrefs(); closeModal(); };
    $('#onbGo').onclick = () => {
      const ids = $$('.onb-item input:checked', modalCard).map(i => i.value);
      const lvlBefore = levelOf(computeXP());
      for (const tid of ids) for (const n of treeById(tid).nodes) { const p = S.progress.nodes[n.id] || (S.progress.nodes[n.id] = {}); if (p.s !== 'mastered') { p.s = 'mastered'; p.t = now(); } }
      saveProgress(); finish(); afterProgress(lvlBefore);
      if (ids.length) toast('Ветки отмечены', `Доступно для изучения: ${[...S.idx.keys()].filter(id => nodeState(id) === 'available').length}`);
    };
    $('#onbSkip').onclick = finish;
  }
  function showHelp() {
    const row = (what, key) => `<div><span>${what}</span><kbd>${key}</kbd></div>`;
    openModal(`<h2>Управление</h2>
      <div class="keys">
        <h3>Карта</h3>
        ${row('Выбрать навык', 'клик')}${row('Мини-карта навыка', '2× клик / F6')}
        ${row('Прокрутка', 'колесо, перетаскивание')}${row('Масштаб', 'Ctrl + колесо, щипок')}
        ${row('Следующий навык', 'Tab')}${row('Соседний навык', 'Enter')}
        ${row('Переименовать', 'F2, пробел или просто печатай')}${row('Удалить', 'Delete')}
        ${row('Переставить', 'перетащи навык')}${row('Связать навыки', 'тяни ⊕ к навыку')}
        ${row('Ходить по карте', 'стрелки')}${row('Меню действий', 'правый клик')}
        ${row('Показать всё', '0')}${row('Новая ветка', 'Tab в центре')}
        <h3>Мини-карта</h3>
        ${row('Подвопрос', 'Tab')}${row('Вопрос рядом', 'Enter')}
        ${row('Знаю ответ', 'клик по кружку')}${row('Свернуть подтему', 'клик по ±')}
        ${row('Переставить', 'Alt + ↑ ↓')}${row('Назад к карте', 'Esc')}
        <h3>Везде</h3>
        ${row('Отменить', 'Ctrl + Z')}${row('Повторить', 'Ctrl + Shift + Z')}
        ${row('Поиск', 'Ctrl + F или /')}${row('Эта справка', '?')}
      </div>
      <p class="help-text">Навык открывается, когда освоены все его требования. Вопросы, отмеченные «знаю», дают по 10 XP, освоенный навык даёт 100. Через ${REVIEW_AFTER_DAYS} день после освоения у навыка появляется золотая точка: пора повторить.</p>
      <div class="p-actions"><button class="btn primary" data-close>Понятно</button></div>`, 'wide');
  }

  // ------------------------------------------------------------------ toasts
  function toast(title, sub = '', cls = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + cls;
    el.innerHTML = `${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 400); }, 2800);
  }

  // ------------------------------------------------------------------ boot
  async function boot() {
    seedStars();
    S.prefs = (await Store.get('prefs')) || {};
    S.customIndex = (await Store.get('projects-index')) || [];
    if (S.prefs.legend === 'collapsed' || (S.prefs.legend == null && isNarrow())) { $('#legend').classList.add('collapsed'); $('#legendToggle').setAttribute('aria-expanded', 'false'); }
    const fromHash = decodeURIComponent(location.hash.slice(1));
    const first = [S.prefs.last, BUILTIN[0]?.id, S.customIndex[0]?.id].find(id => id && (isBuiltin(id) || S.customIndex.some(c => c.id === id)));
    if (!first) { app.insertAdjacentHTML('beforeend', '<p style="position:fixed;inset:40% 0 auto;text-align:center">Нет данных карты. Собери проект командой node scripts/build.mjs</p>'); return; }
    await openProject(first);
    requestAnimationFrame(() => fitAll(false));
    if (fromHash && S.idx.has(fromHash)) setTimeout(() => selectNode(fromHash, { fly: true }), 300);
    else if (!S.prefs.onboarded && !Object.keys(S.progress.nodes).length) setTimeout(showOnboarding, 500);
    svg.focus({ preventScroll: true });
    connectCapabilities();
  }

  async function connectCapabilities() {
    if (!window.claude || typeof window.claude.use !== 'function') return;
    window.claude.use('sample').then(s => { if (s) { S.sample = s; rerenderOpenPanel(); } }).catch(() => {});
    window.claude.use('downloads').then(d => { if (d) S.downloads = d; }).catch(() => {});
    try {
      const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
      if (!db || !user) return;
      const uid = await user.id(); if (!uid) return;
      Store.db = db; Store.uid = uid;
      // pull anything saved on other devices, then redraw the current project
      S.prefs = (await Store.get('prefs')) || S.prefs;
      S.customIndex = (await Store.get('projects-index')) || S.customIndex;
      if (S.inner || S.anim) return; // don't yank the user out of a mini map
      const sel = S.sel;
      await openProject(S.pid, { keepView: true });
      if (sel && S.idx.has(sel)) selectNode(sel);
    } catch (e) { /* local only */ }
  }

  boot();
})();
