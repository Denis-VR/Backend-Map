/* GameTree — global skill tree. Vanilla JS, no dependencies.
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

  const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya' };
  function slug(s) {
    return String(s || '').toLowerCase().split('').map(c => TRANSLIT[c] ?? c).join('')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'item';
  }
  const qText = q => (typeof q === 'string' ? q : q.q);
  const qAns = q => (typeof q === 'string' ? '' : (q.a || ''));

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
    sel: null,
    selTree: null,
    edit: false,
    search: '',
    sample: null,
    downloads: null,
    lastLevel: null
  };

  const svg = $('#map'), world = $('#world');
  const L_BG = $('#layer-bg'), L_EDGES = $('#layer-edges'), L_NODES = $('#layer-nodes'), L_FX = $('#layer-fx');

  // ------------------------------------------------------------------ project model
  function indexProject() {
    S.idx = new Map();
    for (const t of S.project.trees) for (const n of t.nodes) S.idx.set(n.id, { n, t });
  }
  const isBuiltin = id => BUILTIN.some(p => p.id === id);
  const builtin = id => BUILTIN.find(p => p.id === id);

  function nodeProg(id) { return S.progress.nodes[id] || null; }
  function isMastered(id) { const p = nodeProg(id); return !!p && p.s === 'mastered'; }
  function reqs(n) { return (n.requires || []).filter(r => S.idx.has(r)); }
  function reqsAny(n) { return (n.requiresAny || []).filter(r => S.idx.has(r)); }
  function unlocked(n) {
    const all = reqs(n).every(isMastered);
    const any = reqsAny(n);
    return all && (any.length === 0 || any.some(isMastered));
  }
  function nodeState(id) {
    const e = S.idx.get(id); if (!e) return 'locked';
    const p = nodeProg(id);
    if (p && p.s === 'mastered') return 'mastered';
    if (p && p.s === 'learning') return 'learning';
    return unlocked(e.n) ? 'available' : 'locked';
  }
  function knownSet(id) { const p = nodeProg(id); return new Set(p && p.known ? p.known : []); }
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

  // ------------------------------------------------------------------ layout
  const RING0 = 240, RING_GAP = 175;
  const ringR = d => RING0 + (d - 1) * RING_GAP;

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
        const items = ids.map(id => ({ id, b: bary(id) })).sort((a, b) => a.b - b.b || a.id.localeCompare(b.id));
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
      let rMax = ringR(ds.length ? Math.max(...ds) : 1) + 120;
      for (const n of i.t.nodes) { const p = pos.get(n.id); if (p) rMax = Math.max(rMax, Math.hypot(p.x, p.y) + 110); }
      return { t: i.t, a0: i.a0, a1: i.a1, mid: i.mid, minD: ds.length ? Math.min(...ds) : 1, rMax };
    });
    S.layout = { pos, depth, sectors, maxD };
  }

  // ------------------------------------------------------------------ render: map
  function polar(r, a) { return [Math.cos(a) * r, Math.sin(a) * r]; }
  function octagon(r) {
    const pts = [];
    for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + i * Math.PI / 4; pts.push((Math.cos(a) * r).toFixed(1) + ',' + (Math.sin(a) * r).toFixed(1)); }
    return pts.join(' ');
  }
  function wrapLabel(t, max = 17) {
    const words = String(t).split(' '); const lines = []; let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
    }
    if (cur) lines.push(cur);
    if (lines.length > 2) { lines[1] = lines.slice(1).join(' '); lines.length = 2; if (lines[1].length > max + 3) lines[1] = lines[1].slice(0, max + 1) + '…'; }
    return lines;
  }

  function renderBg() {
    const { sectors, maxD } = S.layout;
    let h = '';
    for (let d = 1; d <= maxD; d++) h += `<circle class="ring" r="${ringR(d)}"/>`;
    const rIn = 90;
    for (const s of sectors) {
      const c = s.t.color || '#888';
      const [x0, y0] = polar(rIn, s.a0), [x1, y1] = polar(rIn, s.a1);
      const [X0, Y0] = polar(s.rMax, s.a0), [X1, Y1] = polar(s.rMax, s.a1);
      const large = s.a1 - s.a0 > Math.PI ? 1 : 0;
      h += `<path class="sector" fill="${esc(c)}" fill-opacity="0.045" d="M${x0},${y0} L${X0},${Y0} A${s.rMax},${s.rMax} 0 ${large} 1 ${X1},${Y1} L${x1},${y1} A${rIn},${rIn} 0 ${large} 0 ${x0},${y0}Z"/>`;
      h += `<line class="sector-edge" x1="${x0}" y1="${y0}" x2="${X0}" y2="${Y0}"/>`;
      const lr = s.rMax + 40;
      const lower = Math.sin(s.mid) > 0.15;
      const [p0x, p0y] = polar(lr, lower ? s.a1 : s.a0), [p1x, p1y] = polar(lr, lower ? s.a0 : s.a1);
      h += `<path id="arc-${esc(s.t.id)}" d="M${p0x},${p0y} A${lr},${lr} 0 ${large} ${lower ? 0 : 1} ${p1x},${p1y}" fill="none"/>`;
      const arc = lr * (s.a1 - s.a0) * 0.92, chars = Math.max(4, s.t.title.length);
      const fs = Math.min(34, arc / (chars * 1.05)), fsFar = Math.min(72, arc / (chars * 1.05));
      h += `<text class="sector-label" fill="${esc(c)}" dy="${lower ? '0.9em' : '0'}" style="--fs:${fs.toFixed(1)}px;--fs-far:${fsFar.toFixed(1)}px"><textPath href="#arc-${esc(s.t.id)}" startOffset="50%" text-anchor="middle">${esc(s.t.title)}</textPath></text>`;
    }
    L_BG.innerHTML = h;
  }

  function edgeClass(from, to) {
    const fm = from === '__core' || isMastered(from);
    const ts = nodeState(to);
    if (fm && ts === 'mastered') return 'e-done';
    if (fm) return 'e-open';
    return 'e-locked';
  }
  function edgePath(a, b) {
    const r1 = Math.hypot(a.x, a.y), r2 = Math.hypot(b.x, b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, mr = Math.hypot(mx, my);
    if (mr < 40) return `M${a.x},${a.y} L${b.x},${b.y}`;
    const cr = (r1 + r2) / 2, k = cr / mr;
    const cx = mx + (mx * k - mx) * 0.85, cy = my + (my * k - my) * 0.85;
    return `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
  }

  function highlightSet() {
    if (S.search) {
      const ids = new Set(searchNodes(S.search).map(r => r.id));
      return { nodes: ids, edges: new Set() };
    }
    if (S.selTree) {
      const t = S.project.trees.find(x => x.id === S.selTree);
      return t ? { nodes: new Set(t.nodes.map(n => n.id)), edges: null, tree: t.id } : null;
    }
    if (!S.sel || !S.idx.has(S.sel)) return null;
    const anc = ancestors(S.sel);
    const nodes = new Set([S.sel, ...anc, ...dependents(S.sel)]);
    return { nodes, edges: null, anc };
  }

  function renderEdges() {
    const pos = S.layout.pos, hl = highlightSet();
    const core = { x: 0, y: 0 };
    let h = '';
    S.idx.forEach(({ n, t }, id) => {
      const b = pos.get(id); if (!b) return;
      const rs = reqs(n), ra = reqsAny(n);
      const c = esc(t.color);
      const hlEdge = from => hl && (hl.tree ? (S.idx.get(id).t.id === hl.tree) : (hl.nodes.has(id) && hl.nodes.has(from) && (id === S.sel || from === S.sel || (hl.anc && hl.anc.has(from) && (hl.anc.has(id) || id === S.sel)))));
      if (!rs.length && !ra.length) {
        h += `<path class="edge ${edgeClass('__core', id)}${hl && hl.nodes.has(id) ? ' hl' : ''}" style="--c:${c}" d="${edgePath(core, b)}"/>`;
      }
      for (const r of rs) { const a = pos.get(r); if (a) h += `<path class="edge ${edgeClass(r, id)}${hlEdge(r) ? ' hl' : ''}" style="--c:${c}" d="${edgePath(a, b)}"/>`; }
      for (const r of ra) { const a = pos.get(r); if (a) h += `<path class="edge e-any ${edgeClass(r, id)}${hlEdge(r) ? ' hl' : ''}" style="--c:${c}" d="${edgePath(a, b)}"/>`; }
    });
    L_EDGES.innerHTML = h;
  }

  function nodeSvg(id) {
    const { n, t } = S.idx.get(id);
    const p = S.layout.pos.get(id); if (!p) return '';
    const st = nodeState(id);
    const R = n.keystone ? 33 : 25;
    const total = (n.questions || []).length;
    const known = knownSet(id).size;
    const pct = total ? Math.round(100 * known / total) : 0;
    const lines = wrapLabel(n.title);
    const label = lines.map((l, i) => `<tspan x="0" dy="${i ? '1.15em' : 0}">${esc(l)}</tspan>`).join('');
    const review = needsReview(id);
    return `<g class="node s-${st}${n.keystone ? ' ks' : ''}${S.sel === id ? ' sel' : ''}" data-id="${esc(id)}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})" style="--c:${esc(t.color)}">
      <circle class="hit" r="${R + 14}"/>
      <circle class="halo" r="${R + 2}"/>
      ${n.keystone ? `<polygon class="shape" points="${octagon(R + 2)}"/>` : `<circle class="shape" r="${R}"/>`}
      ${pct && st !== 'locked' ? `<circle class="prog" r="${R + 6}" pathLength="100" stroke-dasharray="${pct} 100" transform="rotate(-90)"/>` : ''}
      <text class="ico" dy="0.36em">${esc(n.icon || '◆')}</text>
      ${st === 'locked' ? `<text class="badge" x="${R - 4}" y="${-R + 10}">🔒</text>` : ''}
      ${review ? `<circle class="badge-bg" cx="${R - 2}" cy="${-R + 4}" r="9"/><text class="badge-txt" x="${R - 2}" y="${-R + 8}">⟳</text>` : ''}
      <text class="lbl" y="${R + 22}">${label}</text>
    </g>`;
  }

  function renderNodes() {
    const hl = highlightSet();
    let h = `<g class="core" data-core="1"><circle class="core-ring" r="78"/><circle class="core-disc" r="56"/>
      <text class="core-ico" dy="0.1em">${esc(S.project.center?.icon || '⚔️')}</text>
      <text class="core-title" y="34">${esc(S.project.center?.title || S.project.title)}</text></g>`;
    S.idx.forEach((_, id) => { h += nodeSvg(id); });
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
    stars = Array.from({ length: 260 }, () => ({ x: rnd(), y: rnd(), r: rnd() * 1.3 + 0.2, a: rnd() * 0.7 + 0.15, d: rnd() * 0.5 + 0.1 }));
  }
  function drawStars() {
    const dpr = window.devicePixelRatio || 1;
    const w = starCanvas.clientWidth, h = starCanvas.clientHeight;
    if (starCanvas.width !== w * dpr) { starCanvas.width = w * dpr; starCanvas.height = h * dpr; }
    const ctx = starCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const st of stars) {
      const x = ((st.x * w * 1.5 + S.view.x * st.d * 0.25) % (w * 1.5) + w * 1.5) % (w * 1.5) - w * 0.25;
      const y = ((st.y * h * 1.5 + S.view.y * st.d * 0.25) % (h * 1.5) + h * 1.5) % (h * 1.5) - h * 0.25;
      ctx.globalAlpha = st.a; ctx.fillStyle = '#cfe0ff';
      ctx.beginPath(); ctx.arc(x, y, st.r, 0, Math.PI * 2); ctx.fill();
    }
  }
  function applyView() {
    const v = S.view;
    world.setAttribute('transform', `translate(${v.x.toFixed(2)},${v.y.toFixed(2)}) scale(${v.k.toFixed(4)})`);
    svg.classList.toggle('far', v.k < 0.42);
    drawStars();
  }
  let flyAnim = null;
  function flyTo(x, y, k, ms = 550) {
    const r = svg.getBoundingClientRect();
    const panelOpen = !$('#panel').hidden && r.width > 640;
    const cx = (r.width - (panelOpen ? 440 : 0)) / 2, cy = r.height / 2;
    const target = { k, x: cx - x * k, y: cy - y * k };
    const from = { ...S.view }, t0 = performance.now();
    cancelAnimationFrame(flyAnim);
    const step = t => {
      const p = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - p, 3);
      S.view = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e };
      applyView();
      if (p < 1) flyAnim = requestAnimationFrame(step);
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { S.view = target; applyView(); return; }
    flyAnim = requestAnimationFrame(step);
  }
  function fitAll(animate = true) {
    const r = svg.getBoundingClientRect();
    let R = 400; S.layout.sectors.forEach(s => { R = Math.max(R, s.rMax + 90); });
    const k = clamp(Math.min(r.width, r.height - 80) / (2 * R), 0.08, 1.2);
    if (animate) flyTo(0, 0, k); else { S.view = { k, x: r.width / 2, y: r.height / 2 + 20 }; applyView(); }
  }
  function focusNode(id, k) {
    const p = S.layout.pos.get(id); if (!p) return;
    flyTo(p.x, p.y, k || Math.max(S.view.k, 0.85));
  }
  function zoomAt(f, sx, sy) {
    const v = S.view, k = clamp(v.k * f, 0.06, 2.5);
    const wx = (sx - v.x) / v.k, wy = (sy - v.y) / v.k;
    S.view = { k, x: sx - wx * k, y: sy - wy * k };
    applyView();
  }

  // ------------------------------------------------------------------ pointer interaction
  const pointers = new Map();
  let drag = null, pinch = null, movingTimer = null;
  function markMoving() { svg.classList.add('moving'); clearTimeout(movingTimer); movingTimer = setTimeout(() => svg.classList.remove('moving'), 160); }
  function toWorld(sx, sy) { const r = svg.getBoundingClientRect(); return { x: (sx - r.left - S.view.x) / S.view.k, y: (sy - r.top - S.view.y) / S.view.k }; }

  svg.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cancelAnimationFrame(flyAnim);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: S.view.k };
      drag = null; return;
    }
    const g = e.target.closest('.node');
    drag = { sx: e.clientX, sy: e.clientY, vx: S.view.x, vy: S.view.y, node: g ? g.dataset.id : null, core: !!e.target.closest('.core'), moved: false, shift: e.shiftKey };
    if (drag.node && S.edit) { const p = S.layout.pos.get(drag.node); const w = toWorld(e.clientX, e.clientY); drag.off = { x: p.x - w.x, y: p.y - w.y }; }
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
    if (!drag.moved && Math.hypot(dx, dy) > 5) { drag.moved = true; svg.classList.add('dragging'); }
    if (!drag.moved) return;
    if (drag.node && S.edit) {
      const w = toWorld(e.clientX, e.clientY);
      const p = { x: Math.round(w.x + drag.off.x), y: Math.round(w.y + drag.off.y) };
      S.layout.pos.set(drag.node, p);
      const g = L_NODES.querySelector(`.node[data-id="${CSS.escape(drag.node)}"]`);
      if (g) g.setAttribute('transform', `translate(${p.x},${p.y})`);
      renderEdges();
      return;
    }
    S.view.x = drag.vx + dx; S.view.y = drag.vy + dy;
    applyView(); markMoving();
  });
  const endPointer = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!drag) return;
    svg.classList.remove('dragging');
    const d = drag; drag = null;
    if (d.moved) {
      if (d.node && S.edit) {
        const p = S.layout.pos.get(d.node);
        S.idx.get(d.node).n.pos = { x: p.x, y: p.y };
        saveProject(false);
      }
      return;
    }
    if (e.type === 'pointercancel') return;
    if (d.node) onNodeClick(d.node, d.shift || e.shiftKey);
    else if (d.core) { S.sel = null; S.selTree = null; openProjectPanel(); refreshMap(); }
    else if (!$('#panel').hidden) closePanel();
  };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    cancelAnimationFrame(flyAnim);
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    markMoving();
  }, { passive: false });
  window.addEventListener('resize', () => { applyView(); });

  function onNodeClick(id, shift) {
    if (S.edit && shift && S.sel && S.sel !== id) { toggleRequire(S.sel, id); return; }
    selectNode(id, true);
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
      const n = S.idx.get(id).n;
      toast(`Освоено: ${n.title}`, opened.length ? `Открыто новых навыков: ${opened.length}` : '');
    }
    afterProgress(lvlBefore);
  }
  function masterWithPrereqs(id) {
    const lvlBefore = levelOf(computeXP());
    const ids = [...ancestors(id), id];
    let c = 0;
    for (const x of ids) if (!isMastered(x)) { const p = S.progress.nodes[x] || (S.progress.nodes[x] = {}); p.s = 'mastered'; p.t = now(); c++; }
    saveProgress(); burst(id);
    toast(`Освоено навыков: ${c}`, 'Вместе со всеми требованиями');
    afterProgress(lvlBefore);
  }
  function setTreeState(treeId, mastered) {
    const lvlBefore = levelOf(computeXP());
    const t = S.project.trees.find(x => x.id === treeId); if (!t) return;
    for (const n of t.nodes) {
      if (mastered) { const p = S.progress.nodes[n.id] || (S.progress.nodes[n.id] = {}); if (p.s !== 'mastered') { p.s = 'mastered'; p.t = now(); } }
      else delete S.progress.nodes[n.id];
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
    afterProgress(lvlBefore, false);
  }
  function afterProgress(lvlBefore, rerenderPanel = true) {
    refreshMap(); renderLegend(); renderHud();
    const lv = levelOf(computeXP());
    if (lv > lvlBefore) toast(`Новый уровень ${lv}`, levelTitle(lv), 'lvl');
    if (rerenderPanel) rerenderOpenPanel();
  }
  function burst(id) {
    const p = S.layout.pos.get(id); if (!p) return;
    const c = S.idx.get(id).t.color;
    let h = `<g transform="translate(${p.x},${p.y})" style="--c:${esc(c)}"><circle class="burst-ring" r="30"/>`;
    for (let i = 0; i < 16; i++) {
      const a = i / 16 * Math.PI * 2, dist = 70 + (i % 3) * 25;
      h += `<circle class="burst" r="${3 + (i % 3)}" style="--dx:${(Math.cos(a) * dist).toFixed(0)}px;--dy:${(Math.sin(a) * dist).toFixed(0)}px"/>`;
    }
    h += '</g>';
    L_FX.insertAdjacentHTML('beforeend', h);
    const g = L_FX.lastElementChild;
    setTimeout(() => g.remove(), 1000);
  }

  // ------------------------------------------------------------------ HUD, legend
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
        <span class="ic">${esc(t.icon || '◆')}</span><span class="nm">${esc(t.title)}</span><span class="ct">${m}/${t.nodes.length}</span>
        <span class="bar"><i style="width:${pct}%"></i></span></button>`;
    }).join('');
    $('#legendTotal').textContent = `${done}/${total}`;
  }
  $('#legendList').addEventListener('click', e => {
    const b = e.target.closest('[data-tree]'); if (!b) return;
    selectTree(b.dataset.tree);
  });
  $('#legendToggle').addEventListener('click', () => {
    const l = $('#legend'); l.classList.toggle('collapsed');
    $('#legendToggle').setAttribute('aria-expanded', String(!l.classList.contains('collapsed')));
  });
  $('#zoom').addEventListener('click', e => {
    const z = e.target.closest('[data-zoom]'); if (!z) return;
    const r = svg.getBoundingClientRect();
    if (z.dataset.zoom === 'fit') fitAll();
    else zoomAt(z.dataset.zoom === 'in' ? 1.35 : 1 / 1.35, r.width / 2, r.height / 2);
  });

  // ------------------------------------------------------------------ panel
  const panel = $('#panel'), panelBody = $('#panelBody');
  let panelKind = null;
  function openPanel(kind, html) {
    panelKind = kind; panelBody.innerHTML = html; panel.hidden = false;
  }
  function closePanel() {
    panel.hidden = true; panelKind = null; S.sel = null; S.selTree = null;
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    refreshMap(); renderLegend();
  }
  $('#panelClose').addEventListener('click', closePanel);
  function rerenderOpenPanel() {
    if (panel.hidden) return;
    const st = panelBody.scrollTop;
    if (panelKind === 'node' && S.sel) renderNodePanel(S.sel);
    else if (panelKind === 'tree' && S.selTree) renderTreePanel(S.selTree);
    panel.scrollTop = st;
  }

  function selectNode(id, fly) {
    if (!S.idx.has(id)) return;
    S.sel = id; S.selTree = null;
    try { history.replaceState(null, '', '#' + id); } catch (e) { /* ignore */ }
    renderNodePanel(id);
    refreshMap(); renderLegend();
    if (fly) focusNode(id);
  }
  function selectTree(tid) {
    const t = S.project.trees.find(x => x.id === tid); if (!t) return;
    S.selTree = tid; S.sel = null;
    renderTreePanel(tid); refreshMap(); renderLegend();
    const s = S.layout.sectors.find(x => x.t.id === tid);
    const pts = t.nodes.map(n => S.layout.pos.get(n.id)).filter(Boolean);
    if (pts.length) {
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      const r = svg.getBoundingClientRect();
      const w = Math.max(...xs) - Math.min(...xs) + 300, h = Math.max(...ys) - Math.min(...ys) + 300;
      const k = clamp(Math.min((r.width - (r.width > 640 ? 440 : 0)) / w, r.height / h), 0.2, 1);
      flyTo((Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2, k);
    } else if (s) { const [x, y] = polar(400, s.mid); flyTo(x, y, 0.6); }
  }

  const STATE_LABEL = { locked: 'Закрыт', available: 'Доступен', learning: 'Изучаю', mastered: 'Освоен' };
  function chip(id) {
    const e = S.idx.get(id); if (!e) return `<span class="link-chip missing">${esc(id)}</span>`;
    return `<button class="link-chip${isMastered(id) ? ' done' : ''}" data-goto="${esc(id)}" style="--c:${esc(e.t.color)}"><span class="dot"></span>${esc(e.n.icon || '')} ${esc(e.n.title)}</button>`;
  }
  function claudeUrl(text) { return 'https://claude.ai/new?q=' + encodeURIComponent(text); }
  function askPrompt(node, q) {
    return `Я готовлюсь к собеседованию на backend-разработчика и повторяю тему «${node.title}». Кратко и по делу (до 150 слов) ответь на вопрос: ${q}. Если уместно, добавь маленький пример кода.`;
  }

  function renderNodePanel(id) {
    if (S.edit) { renderNodeEditor(id); return; }
    const { n, t } = S.idx.get(id);
    const st = nodeState(id);
    const p = nodeProg(id) || {};
    const known = knownSet(id);
    const qs = n.questions || [];
    const missing = [...reqs(n).filter(r => !isMastered(r))];
    const anyMissing = reqsAny(n).length && !reqsAny(n).some(isMastered) ? reqsAny(n) : [];
    let actions = '';
    if (st === 'locked') {
      actions = `<div><p class="sec-title">Чтобы открыть, освой</p><div class="links">${missing.map(chip).join('')}</div>
        ${anyMissing.length ? `<p class="small muted" style="margin:10px 0 6px">и любой из этих:</p><div class="links">${anyMissing.map(chip).join('')}</div>` : ''}</div>
        <div class="p-actions"><button class="btn" data-act="master-chain">Я это уже знаю</button></div>`;
    } else if (st === 'available') {
      actions = `<div class="p-actions"><button class="btn primary" data-act="learn">Начать изучение</button><button class="btn good" data-act="master">Уже знаю</button></div>`;
    } else if (st === 'learning') {
      actions = `<div class="p-actions"><button class="btn primary" data-act="master">Освоено</button><button class="btn ghost" data-act="reset">Отложить</button></div>`;
    } else {
      actions = `<div class="p-actions">${qs.length ? '<button class="btn primary" data-act="quiz-node">Повторить вопросы</button>' : ''}<button class="btn ghost" data-act="ask-reset">Сбросить</button></div>
        ${needsReview(id) ? '<p class="small muted" style="margin:0">Ты давно не повторял эту тему. Пройди вопросы, чтобы освежить.</p>' : ''}`;
    }
    const unlocks = dependents(id);
    const ask = !!S.sample;
    const qHtml = qs.map((q, i) => {
      const text = qText(q), ans = qAns(q), k = known.has(text);
      return `<li class="q${k ? ' known' : ''}">
        <input type="checkbox" id="q-${i}" data-q="${i}" ${k ? 'checked' : ''}>
        <label for="q-${i}">${esc(text)}</label>
        ${ans ? `<button class="ask" data-ans="${i}">ответ</button>` : (ask ? `<button class="ask" data-ask="${i}">спросить Claude</button>` : `<a class="ask" href="${esc(claudeUrl(askPrompt(n, text)))}" target="_blank" rel="noopener">спросить Claude ↗</a>`)}
        <div class="ans" data-ans-box="${i}" hidden>${esc(ans)}</div>
      </li>`;
    }).join('');
    openPanel('node', `
      <div class="p-head" style="--c:${esc(t.color)}">
        <div class="p-icon${n.keystone ? ' ks' : ''}">${esc(n.icon || '◆')}</div>
        <div><h2 class="p-title">${esc(n.title)}</h2>
          <div class="p-sub"><span class="tag tree" style="--c:${esc(t.color)}">${esc(t.icon || '')} ${esc(t.title)}</span><span class="tag st-${st}">${STATE_LABEL[st]}</span>${n.keystone ? '<span class="tag">Ключевой</span>' : ''}</div></div>
      </div>
      ${n.description ? `<p class="p-desc">${esc(n.description)}</p>` : ''}
      ${actions}
      <div id="confirmSlot"></div>
      ${qs.length ? `<div style="--c:${esc(t.color)}"><p class="sec-title"><span>Вопросы для самопроверки</span><span class="mono">${known.size}/${qs.length}</span></p>
        <div class="progress"><i style="width:${Math.round(100 * known.size / qs.length)}%"></i></div>
        <ul class="qlist" style="margin-top:8px">${qHtml}</ul></div>` : ''}
      ${(n.resources || []).length ? `<div class="res"><p class="sec-title">Материалы</p><ul class="help-list">${n.resources.map(r => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title || r.url)}</a></li>`).join('')}</ul></div>` : ''}
      ${reqs(n).length || reqsAny(n).length ? `<div><p class="sec-title">Требует</p><div class="links">${reqs(n).map(chip).join('')}${reqsAny(n).length ? `<span class="small muted" style="align-self:center">любой из:</span>${reqsAny(n).map(chip).join('')}` : ''}</div></div>` : ''}
      ${unlocks.length ? `<div><p class="sec-title">Открывает</p><div class="links">${unlocks.map(chip).join('')}</div></div>` : ''}
      <div><p class="sec-title">Мои заметки</p><textarea class="notes" id="nodeNotes" placeholder="Ключевые мысли, ссылки, что спросили на собеседовании…">${esc(p.notes || '')}</textarea></div>
    `);
  }

  panelBody.addEventListener('click', e => {
    const go = e.target.closest('[data-goto]');
    if (go) { selectNode(go.dataset.goto, true); return; }
    const act = e.target.closest('[data-act]');
    if (act && panelKind === 'node') {
      const id = S.sel, a = act.dataset.act;
      if (a === 'learn') setState(id, 'learning');
      else if (a === 'master') setState(id, 'mastered');
      else if (a === 'reset') setState(id, null);
      else if (a === 'master-chain') {
        const cnt = [...ancestors(id)].filter(x => !isMastered(x)).length;
        confirmIn(`Отметить «${S.idx.get(id).n.title}» и все требования (${cnt}) как изученные?`, 'Отметить', () => masterWithPrereqs(id), false);
      } else if (a === 'ask-reset') confirmIn('Сбросить отметку «освоено»? Отметки вопросов и заметки останутся.', 'Сбросить', () => setState(id, null));
      else if (a === 'quiz-node') openQuiz({ node: id });
      return;
    }
    if (act && panelKind === 'tree') {
      const a = act.dataset.act;
      if (a === 'tree-master') confirmIn(`Отметить всю ветку «${S.project.trees.find(t => t.id === S.selTree).title}» изученной?`, 'Отметить', () => setTreeState(S.selTree, true), false);
      else if (a === 'tree-reset') confirmIn('Сбросить прогресс всей ветки?', 'Сбросить', () => setTreeState(S.selTree, false));
      else if (a === 'tree-quiz') openQuiz({ tree: S.selTree });
      return;
    }
    const ans = e.target.closest('[data-ans]');
    if (ans) { const box = panelBody.querySelector(`[data-ans-box="${ans.dataset.ans}"]`); box.hidden = !box.hidden; return; }
    const ask = e.target.closest('[data-ask]');
    if (ask) {
      const { n } = S.idx.get(S.sel); const q = n.questions[+ask.dataset.ask];
      const box = panelBody.querySelector(`[data-ans-box="${ask.dataset.ask}"]`);
      if (!box.hidden && box.textContent) { box.hidden = true; return; }
      askClaude(n, qText(q), box);
    }
  });
  panelBody.addEventListener('change', e => {
    const cb = e.target.closest('input[data-q]');
    if (cb && panelKind === 'node') {
      const { n } = S.idx.get(S.sel);
      toggleKnown(S.sel, qText(n.questions[+cb.dataset.q]), cb.checked);
      cb.closest('.q').classList.toggle('known', cb.checked);
      const known = knownSet(S.sel).size, total = n.questions.length;
      const head = cb.closest('div').querySelector('.sec-title .mono'); if (head) head.textContent = `${known}/${total}`;
      const bar = cb.closest('div').querySelector('.progress i'); if (bar) bar.style.width = `${Math.round(100 * known / total)}%`;
    }
  });
  let notesTimer = null;
  panelBody.addEventListener('input', e => {
    if (e.target.id === 'nodeNotes' && S.sel) {
      const id = S.sel, v = e.target.value;
      clearTimeout(notesTimer);
      notesTimer = setTimeout(() => {
        const p = S.progress.nodes[id] || (S.progress.nodes[id] = {});
        p.notes = v; saveProgress();
      }, 500);
    }
  });

  function confirmIn(text, okLabel, fn, danger = true) {
    const slot = $('#confirmSlot', panelBody); if (!slot) { fn(); return; }
    slot.innerHTML = `<div class="confirm" style="${danger ? '' : 'background:#1d1a0e;border-color:#5a4318'}"><span style="${danger ? '' : 'color:#e9d6a6'}">${esc(text)}</span>
      <button class="btn small ${danger ? 'danger' : 'primary'}" data-c="ok">${esc(okLabel)}</button><button class="btn small ghost" data-c="no">Отмена</button></div>`;
    slot.querySelector('[data-c="ok"]').onclick = e => { e.stopPropagation(); slot.innerHTML = ''; fn(); };
    slot.querySelector('[data-c="no"]').onclick = e => { e.stopPropagation(); slot.innerHTML = ''; };
  }

  async function askClaude(node, q, box) {
    box.hidden = false; box.textContent = 'Claude думает…';
    try {
      const res = await S.sample(askPrompt(node, q), { onText: ({ text }) => { box.textContent = text; } });
      box.textContent = res.text;
    } catch (err) {
      if (err && err.code === 'not_granted') { S.sample = null; box.innerHTML = `Нет доступа. <a href="${esc(claudeUrl(askPrompt(node, q)))}" target="_blank" rel="noopener">Открыть в Claude ↗</a>`; }
      else box.textContent = 'Не получилось получить ответ. Попробуй ещё раз чуть позже.';
    }
  }

  function renderTreePanel(tid) {
    const t = S.project.trees.find(x => x.id === tid);
    if (S.edit) { renderTreeEditor(t); return; }
    const m = t.nodes.filter(n => isMastered(n.id)).length;
    const qn = t.nodes.reduce((s, n) => s + (n.questions || []).length, 0);
    const kn = t.nodes.reduce((s, n) => s + knownSet(n.id).size, 0);
    const avail = t.nodes.filter(n => nodeState(n.id) === 'available' || nodeState(n.id) === 'learning');
    openPanel('tree', `
      <div class="p-head" style="--c:${esc(t.color)}"><div class="p-icon ks">${esc(t.icon || '◆')}</div>
        <div><h2 class="p-title">${esc(t.title)}</h2><div class="p-sub"><span class="tag tree" style="--c:${esc(t.color)}">${m}/${t.nodes.length} навыков</span><span class="tag">${kn}/${qn} вопросов</span></div></div></div>
      ${t.description ? `<p class="p-desc">${esc(t.description)}</p>` : ''}
      <div style="--c:${esc(t.color)}"><div class="progress"><i style="width:${t.nodes.length ? Math.round(100 * m / t.nodes.length) : 0}%"></i></div></div>
      <div class="p-actions">${qn ? '<button class="btn primary" data-act="tree-quiz">Повторить ветку</button>' : ''}<button class="btn" data-act="tree-master">Отметить всю ветку</button><button class="btn ghost" data-act="tree-reset">Сбросить</button></div>
      <div id="confirmSlot"></div>
      ${avail.length ? `<div><p class="sec-title">Можно изучать сейчас</p><div class="links">${avail.map(n => chip(n.id)).join('')}</div></div>` : ''}
      <div><p class="sec-title">Все навыки ветки</p><div class="links">${t.nodes.map(n => chip(n.id)).join('')}</div></div>`);
  }

  function openProjectPanel() {
    const p = S.project;
    const total = S.idx.size, m = [...S.idx.keys()].filter(isMastered).length;
    const av = [...S.idx.keys()].filter(id => nodeState(id) === 'available');
    const learning = [...S.idx.keys()].filter(id => nodeState(id) === 'learning');
    openPanel('project', `
      <div class="p-head" style="--c:#f2c46d"><div class="p-icon">${esc(p.center?.icon || '⚔️')}</div>
        <div><h2 class="p-title">${esc(p.title)}</h2><div class="p-sub"><span class="tag">${m}/${total} навыков</span><span class="tag">${p.trees.length} веток</span></div></div></div>
      ${p.description ? `<p class="p-desc">${esc(p.description)}</p>` : ''}
      ${learning.length ? `<div><p class="sec-title">Сейчас изучаю</p><div class="links">${learning.map(chip).join('')}</div></div>` : ''}
      ${av.length ? `<div><p class="sec-title">Открыто для изучения (${av.length})</p><div class="links">${av.map(chip).join('')}</div></div>` : '<p class="muted">Все доступные навыки уже в работе.</p>'}`);
  }

  // ------------------------------------------------------------------ editor
  function setEdit(on) {
    S.edit = on;
    $('#editBtn').setAttribute('aria-pressed', String(on));
    $('#editbar').hidden = !on;
    $('#revertBtn').hidden = !isBuiltin(S.pid);
    svg.classList.toggle('editing', on);
    rerenderOpenPanel();
    if (on && panel.hidden) toast('Режим редактора', 'Выбери навык, чтобы изменить его, или добавь новый');
  }
  $('#editBtn').addEventListener('click', () => setEdit(!S.edit));

  function treeOptions(sel) { return S.project.trees.map(t => `<option value="${esc(t.id)}"${t.id === sel ? ' selected' : ''}>${esc(t.title)}</option>`).join(''); }
  function nodeDatalist() { return `<datalist id="nodeIds">${[...S.idx.values()].map(({ n, t }) => `<option value="${esc(n.id)}">${esc(n.title)} · ${esc(t.title)}</option>`).join('')}</datalist>`; }
  function qToLine(q) { return typeof q === 'string' ? q : (q.a ? `${q.q} :: ${q.a}` : q.q); }
  function lineToQ(l) { const i = l.indexOf(' :: '); return i > 0 ? { q: l.slice(0, i).trim(), a: l.slice(i + 4).trim() } : l.trim(); }

  function renderNodeEditor(id) {
    const { n, t } = S.idx.get(id);
    const chips = (list, kind) => (list || []).map(r => `<span class="link-chip" style="--c:${esc(S.idx.get(r)?.t.color || '#666')}"><span class="dot"></span>${esc(S.idx.get(r)?.n.title || r)}<button data-rm="${kind}" data-v="${esc(r)}" title="Убрать">✕</button></span>`).join('');
    openPanel('node', `
      <div class="p-head" style="--c:${esc(t.color)}"><div class="p-icon${n.keystone ? ' ks' : ''}">${esc(n.icon || '◆')}</div>
        <div><h2 class="p-title">Правка навыка</h2><div class="p-sub"><span class="tag mono">${esc(n.id)}</span></div></div></div>
      <form class="form" id="nodeForm">
        <div class="field-row">
          <label class="field"><span>Иконка</span><input id="f-icon" value="${esc(n.icon || '')}" maxlength="4"></label>
          <label class="field"><span>Название</span><input id="f-title" value="${esc(n.title)}" required></label>
        </div>
        <label class="field"><span>Описание</span><textarea id="f-desc">${esc(n.description || '')}</textarea></label>
        <label class="field"><span>Ветка</span><select id="f-tree">${treeOptions(t.id)}</select></label>
        <label class="field" style="grid-template-columns:auto 1fr;align-items:center;display:grid;gap:8px"><input type="checkbox" id="f-ks" ${n.keystone ? 'checked' : ''} style="width:auto"><span>Ключевой навык (крупнее, больше опыта)</span></label>
        <div class="field"><span>Требует (все)</span><div class="chips-edit">${chips(n.requires, 'requires')}</div>
          <input list="nodeIds" id="f-addreq" placeholder="Добавить требование: начни вводить id или название"></div>
        <div class="field"><span>Требует любой из</span><div class="chips-edit">${chips(n.requiresAny, 'requiresAny')}</div>
          <input list="nodeIds" id="f-addany" placeholder="Добавить альтернативу"></div>
        <label class="field"><span>Вопросы: по одному на строку, ответ после « :: »</span><textarea id="f-qs" style="min-height:160px">${esc((n.questions || []).map(qToLine).join('\n'))}</textarea></label>
        <label class="field"><span>Материалы: «название | ссылка» на строку</span><textarea id="f-res">${esc((n.resources || []).map(r => `${r.title || ''} | ${r.url}`).join('\n'))}</textarea></label>
        ${nodeDatalist()}
        <div class="p-actions"><button class="btn primary" type="submit">Сохранить</button>${n.pos ? '<button class="btn" type="button" data-ed="unpin">Вернуть автораскладку</button>' : ''}<button class="btn danger" type="button" data-ed="delete">Удалить навык</button></div>
      </form>
      <div id="confirmSlot"></div>`);
    const form = $('#nodeForm');
    form.addEventListener('submit', e => {
      e.preventDefault();
      n.title = $('#f-title').value.trim() || n.title;
      n.icon = $('#f-icon').value.trim();
      n.description = $('#f-desc').value.trim();
      n.keystone = $('#f-ks').checked || undefined;
      n.questions = $('#f-qs').value.split('\n').map(s => s.trim()).filter(Boolean).map(lineToQ);
      n.resources = $('#f-res').value.split('\n').map(s => s.trim()).filter(Boolean).map(l => { const [a, b] = l.split('|').map(x => x.trim()); return b ? { title: a, url: b } : { title: a, url: a }; });
      if (!n.resources.length) delete n.resources;
      const nt = $('#f-tree').value;
      if (nt !== t.id) { t.nodes.splice(t.nodes.indexOf(n), 1); S.project.trees.find(x => x.id === nt).nodes.push(n); delete n.pos; }
      saveProject(); toast('Сохранено');
    });
    const addRef = (inputId, kind) => $(inputId).addEventListener('change', e => {
      const v = e.target.value.trim(); if (!S.idx.has(v) || v === id) return;
      if (wouldCycle(id, v)) { toast('Так нельзя', 'Получится замкнутый круг зависимостей'); return; }
      n[kind] = [...new Set([...(n[kind] || []), v])];
      saveProject();
    });
    addRef('#f-addreq', 'requires'); addRef('#f-addany', 'requiresAny');
    form.addEventListener('click', e => {
      const rm = e.target.closest('[data-rm]');
      if (rm) { const k = rm.dataset.rm; n[k] = (n[k] || []).filter(x => x !== rm.dataset.v); if (!n[k].length) delete n[k]; saveProject(); return; }
      const ed = e.target.closest('[data-ed]'); if (!ed) return;
      if (ed.dataset.ed === 'unpin') { delete n.pos; saveProject(); }
      if (ed.dataset.ed === 'delete') confirmIn(`Удалить «${n.title}»? Связи с ним тоже пропадут.`, 'Удалить', () => deleteNode(id));
    });
  }
  function wouldCycle(id, newReq) { return newReq === id || ancestors(newReq).has(id); }
  function toggleRequire(id, req) {
    const n = S.idx.get(id).n;
    if ((n.requires || []).includes(req)) { n.requires = n.requires.filter(x => x !== req); if (!n.requires.length) delete n.requires; toast('Связь удалена'); }
    else {
      if (wouldCycle(id, req)) { toast('Так нельзя', 'Получится замкнутый круг зависимостей'); return; }
      n.requires = [...(n.requires || []), req]; toast('Связь добавлена', `${S.idx.get(req).n.title} → ${n.title}`);
    }
    saveProject();
  }
  function deleteNode(id) {
    for (const t of S.project.trees) t.nodes = t.nodes.filter(n => n.id !== id);
    for (const t of S.project.trees) for (const n of t.nodes) {
      for (const k of ['requires', 'requiresAny']) if (n[k]) { n[k] = n[k].filter(x => x !== id); if (!n[k].length) delete n[k]; }
    }
    delete S.progress.nodes[id]; saveProgress();
    S.sel = null; panel.hidden = true; saveProject();
  }
  function uniqueId(base) { let id = base, i = 2; while (S.idx.has(id) || S.project.trees.some(t => t.id === id)) id = `${base}-${i++}`; return id; }
  function addNode() {
    const t = (S.sel && S.idx.get(S.sel).t) || S.project.trees.find(x => x.id === S.selTree) || S.project.trees[0];
    if (!t) { addTree(); return; }
    let at;
    const pp = S.sel && S.layout.pos.get(S.sel);
    if (pp) { const r0 = Math.hypot(pp.x, pp.y) || 1, f = (r0 + RING_GAP) / r0; at = { x: pp.x * f + 40, y: pp.y * f }; }
    else { const s = S.layout.sectors.find(x => x.t.id === t.id); const [x, y] = polar(ringR(1), s ? s.mid : 0); at = { x, y }; }
    const n = { id: uniqueId(`${t.id}.new-skill`), title: 'Новый навык', icon: '⭐', description: '', questions: [], pos: { x: Math.round(at.x), y: Math.round(at.y) } };
    if (S.sel) n.requires = [S.sel];
    t.nodes.push(n); saveProject(); selectNode(n.id, false);
    setTimeout(() => { const i = $('#f-title'); if (i) { i.focus(); i.select(); } }, 30);
  }
  function addTree() { renderTreeEditor(null); }
  function renderTreeEditor(t) {
    const isNew = !t;
    const tt = t || { title: '', icon: '🌟', color: '#39c5cf', description: '' };
    openPanel('tree', `
      <h2 class="p-title">${isNew ? 'Новая ветка' : 'Правка ветки'}</h2>
      <form class="form" id="treeForm">
        <div class="field-row"><label class="field"><span>Иконка</span><input id="t-icon" value="${esc(tt.icon || '')}" maxlength="4"></label>
          <label class="field"><span>Название</span><input id="t-title" value="${esc(tt.title)}" required placeholder="Например, Kotlin"></label></div>
        <label class="field"><span>Цвет</span><input type="color" id="t-color" value="${esc(tt.color)}" style="height:40px;padding:2px"></label>
        <label class="field"><span>Описание</span><textarea id="t-desc">${esc(tt.description || '')}</textarea></label>
        <div class="p-actions"><button class="btn primary" type="submit">${isNew ? 'Создать ветку' : 'Сохранить'}</button>${isNew ? '' : '<button class="btn danger" type="button" data-ed="del-tree">Удалить ветку</button>'}</div>
      </form><div id="confirmSlot"></div>`);
    $('#treeForm').addEventListener('submit', e => {
      e.preventDefault();
      const title = $('#t-title').value.trim(); if (!title) return;
      if (isNew) {
        const id = uniqueId(slug(title));
        const nt = { id, title, icon: $('#t-icon').value.trim(), color: $('#t-color').value, description: $('#t-desc').value.trim(), nodes: [{ id: `${id}.start`, title: `${title}: основы`, icon: $('#t-icon').value.trim() || '⭐', description: '', keystone: true, questions: [] }] };
        S.project.trees.push(nt); saveProject(); selectNode(`${id}.start`, true);
      } else {
        Object.assign(t, { title, icon: $('#t-icon').value.trim(), color: $('#t-color').value, description: $('#t-desc').value.trim() });
        saveProject(); toast('Ветка сохранена');
      }
    });
    const del = panelBody.querySelector('[data-ed="del-tree"]');
    if (del) del.onclick = () => confirmIn(`Удалить ветку «${t.title}» со всеми навыками (${t.nodes.length})?`, 'Удалить', () => {
      for (const n of [...t.nodes]) deleteNode(n.id);
      S.project.trees = S.project.trees.filter(x => x !== t); S.selTree = null; panel.hidden = true; saveProject();
    });
  }

  $('#editbar').addEventListener('click', e => {
    const b = e.target.closest('[data-edit]'); if (!b) return;
    const a = b.dataset.edit;
    if (a === 'add-node') addNode();
    else if (a === 'add-tree') addTree();
    else if (a === 'export') exportProject();
    else if (a === 'import') pickFile('project');
    else if (a === 'revert') {
      openPanel('confirm', `<h2 class="p-title">Вернуть исходную карту?</h2><p class="p-desc">Все твои правки карты «${esc(S.project.title)}» удалятся. Прогресс останется.</p><div id="confirmSlot"></div>`);
      confirmIn('Правки удалятся без возможности вернуть.', 'Вернуть исходную', async () => { Store.del('project-' + S.pid); panel.hidden = true; await openProject(S.pid); toast('Карта восстановлена'); });
    }
  });

  // ------------------------------------------------------------------ persistence of project / progress
  let projTimer = null;
  function saveProject(relayout = true) {
    indexProject();
    if (relayout) { computeLayout(); renderMap(); rerenderOpenPanel(); } else { computeLayout(); renderBg(); }
    renderLegend(); renderHud();
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

  async function openProject(id, opts = {}) {
    const saved = await Store.get('project-' + id);
    const base = saved || (builtin(id) && clone(builtin(id)));
    if (!base) return false;
    S.pid = id; S.project = normalizeProject(base);
    S.progress = (await Store.get('progress-' + id)) || { nodes: {}, reviews: {} };
    S.progress.nodes = S.progress.nodes || {}; S.progress.reviews = S.progress.reviews || {};
    S.sel = null; S.selTree = null;
    indexProject(); computeLayout(); renderMap(); renderLegend(); renderHud();
    $('#revertBtn').hidden = !isBuiltin(id);
    if (!opts.keepView) fitAll(false);
    S.prefs.last = id; savePrefs();
    return true;
  }
  function normalizeProject(p) {
    p.trees = (p.trees || []).filter(t => t && typeof t === 'object');
    for (const t of p.trees) { t.nodes = Array.isArray(t.nodes) ? t.nodes : []; t.color = t.color || '#8d99b6'; }
    p.center = p.center || { title: p.title, icon: '✨' };
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
    const m = $('#projectMenu');
    m.innerHTML = allProjects().map(p => `<button data-pid="${esc(p.id)}" class="${p.id === S.pid ? 'active' : ''}">${p.id === S.pid ? '◆' : '◇'} ${esc(p.title)}</button>`).join('')
      + '<hr><button data-pact="new">+ Новый проект</button><button data-pact="import">Импорт проекта из JSON</button>'
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
  document.addEventListener('click', e => { if (!e.target.closest('.menu') && !e.target.closest('[aria-haspopup]') && !e.target.closest('.search')) $$('.menu').forEach(m => { m.hidden = true; }); });
  $('#projectMenu').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    $('#projectMenu').hidden = true;
    if (b.dataset.pid) { if (b.dataset.pid !== S.pid) { panel.hidden = true; await openProject(b.dataset.pid); } return; }
    if (b.dataset.pact === 'new') newProjectForm();
    if (b.dataset.pact === 'import') pickFile('project');
    if (b.dataset.pact === 'delete') {
      openPanel('confirm', `<h2 class="p-title">Удалить проект «${esc(S.project.title)}»?</h2><p class="p-desc">Карта и прогресс по ней удалятся. Сначала можно сохранить проект в JSON через редактор.</p><div id="confirmSlot"></div>`);
      confirmIn('Удаление нельзя отменить.', 'Удалить проект', async () => {
        const id = S.pid;
        S.customIndex = S.customIndex.filter(x => x.id !== id); Store.set('projects-index', S.customIndex);
        Store.del('project-' + id); Store.del('progress-' + id);
        panel.hidden = true; await openProject(BUILTIN[0] ? BUILTIN[0].id : S.customIndex[0]?.id);
      });
    }
  });
  function newProjectForm() {
    openPanel('project-new', `
      <h2 class="p-title">Новый проект</h2>
      <p class="p-desc">Отдельная карта навыков: например, «System Design», «English» или подготовка к конкретной вакансии.</p>
      <form class="form" id="projForm">
        <label class="field"><span>Название</span><input id="pj-title" required placeholder="System Design"></label>
        <label class="field"><span>Описание</span><textarea id="pj-desc" placeholder="Что хочешь прокачать и зачем"></textarea></label>
        <div class="field-row"><label class="field"><span>Иконка</span><input id="pj-icon" value="✨" maxlength="4"></label>
          <label class="field"><span>Первая ветка</span><input id="pj-tree" required placeholder="Основы"></label></div>
        <div class="p-actions"><button class="btn primary" type="submit">Создать</button></div>
      </form>`);
    $('#projForm').addEventListener('submit', async e => {
      e.preventDefault();
      const title = $('#pj-title').value.trim(); if (!title) return;
      let id = slug(title), i = 2; while (allProjects().some(p => p.id === id)) id = `${slug(title)}-${i++}`;
      const tTitle = $('#pj-tree').value.trim() || 'Основы', tid = slug(tTitle);
      const icon = $('#pj-icon').value.trim() || '✨';
      const p = { schema: 1, id, title, description: $('#pj-desc').value.trim(), center: { title, icon }, trees: [{ id: tid, title: tTitle, color: '#39c5cf', icon: '🌱', description: '', nodes: [{ id: `${tid}.start`, title: `${tTitle}: первый шаг`, icon: '⭐', description: 'Отредактируй меня или добавь новые навыки.', keystone: true, questions: [] }] }] };
      await createProject(p);
      setEdit(true);
    });
  }
  async function createProject(p) {
    if (isBuiltin(p.id) || S.customIndex.some(x => x.id === p.id)) {
      let i = 2, base = p.id; while (isBuiltin(`${base}-${i}`) || S.customIndex.some(x => x.id === `${base}-${i}`)) i++; p.id = `${base}-${i}`;
    }
    Store.set('project-' + p.id, p);
    S.customIndex.push({ id: p.id, title: p.title }); Store.set('projects-index', S.customIndex);
    panel.hidden = true;
    await openProject(p.id);
    toast(`Проект «${p.title}» создан`);
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
    openModal(`<h2>${esc(filename)}</h2><p class="muted small" style="margin:0">Если файл не скачался, скопируй текст ниже и сохрани его как ${esc(filename)}.</p>
      <textarea class="notes mono" id="jsonOut" style="min-height:260px;font-size:12px" readonly>${esc(data)}</textarea>
      <div class="p-actions"><button class="btn primary" id="copyJson">Скопировать</button><button class="btn ghost" data-close>Закрыть</button></div>`);
    $('#copyJson').onclick = () => {
      const ta = $('#jsonOut');
      navigator.clipboard.writeText(data).then(() => toast('Скопировано'), () => { ta.focus(); ta.select(); });
    };
  }
  function exportProject() { saveFile(`${S.pid}.gametree.json`, S.project); }
  function exportProgress() { saveFile(`${S.pid}.progress.json`, { kind: 'gametree-progress', project: S.pid, progress: S.progress }); }
  let pickKind = null;
  function pickFile(kind) {
    pickKind = kind;
    openModal(`<h2>${kind === 'project' ? 'Импорт проекта' : 'Загрузка прогресса'}</h2>
      <p class="muted small" style="margin:0">${kind === 'project' ? 'JSON-файл проекта GameTree: экспорт из редактора или файл, который сделал Claude.' : 'Файл, сохранённый через «Сохранить прогресс в файл».'}</p>
      <div class="p-actions"><button class="btn primary" id="pickBtn">Выбрать файл</button></div>
      <label class="field"><span>или вставь JSON сюда</span><textarea class="notes mono" id="jsonIn" style="min-height:160px;font-size:12px"></textarea></label>
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
    const err = m => { const el = $('#importErr'); if (el) el.textContent = m; };
    let obj; try { obj = JSON.parse(text); } catch (e) { err('Это не похоже на JSON: ' + e.message); return; }
    if (pickKind === 'progress' || obj.kind === 'gametree-progress') {
      if (!obj.progress || !obj.project) { err('В файле нет прогресса'); return; }
      Store.set('progress-' + obj.project, obj.progress);
      closeModal();
      if (obj.project === S.pid) { S.progress = obj.progress; afterProgress(levelOf(computeXP())); }
      toast('Прогресс загружен'); return;
    }
    const msg = validateProject(obj); if (msg) { err(msg); return; }
    closeModal();
    if (obj.id === S.pid && S.edit) { S.project = normalizeProject(obj); saveProject(); toast('Карта обновлена'); return; }
    await createProject(normalizeProject(obj));
  }

  // ------------------------------------------------------------------ modal
  const modal = $('#modal'), modalCard = $('#modalCard');
  function openModal(html) { modalCard.innerHTML = html; modal.hidden = false; }
  function closeModal() { modal.hidden = true; modalCard.innerHTML = ''; quiz = null; }
  modal.addEventListener('click', e => { if (e.target === modal || e.target.closest('[data-close]')) closeModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (!modal.hidden) closeModal(); else if (!panel.hidden) closePanel(); }
    if (quiz && !modal.hidden && !e.target.closest('textarea,input')) {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); const r = $('#qzReveal'); if (r) r.click(); }
      if (e.key === '1') $('[data-rate="bad"]')?.click();
      if (e.key === '2') $('[data-rate="good"]')?.click();
    }
  });

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
      for (const q of n.questions || []) pool.push({ id, q: qText(q), a: qAns(q) });
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
      return 1 + (r.bad || 0) * 2 - Math.min(2, (r.good || 0) * 0.5) + Math.min(3, age / 7);
    }).map(v => Math.max(0.3, v));
    let s = w.reduce((a, b) => a + b, 0) * Math.random();
    for (let i = 0; i < pool.length; i++) { s -= w[i]; if (s <= 0) return pool[i]; }
    return pool[pool.length - 1];
  }
  function openQuiz(scope = {}) {
    const due = [...S.idx.keys()].filter(needsReview);
    if (!scope.node && !scope.tree && due.length && scope.due === undefined) scope.due = true;
    const pool = quizPool(scope);
    quiz = { scope, pool, seen: new Set(), good: 0, bad: 0, cur: null };
    renderQuiz();
  }
  function quizScopes() {
    const s = quiz.scope;
    const due = [...S.idx.keys()].filter(needsReview).length;
    return `<div class="scope">
      <button data-scope="all" class="${!s.node && !s.tree && !s.due ? 'active' : ''}">Всё изученное</button>
      ${due ? `<button data-scope="due" class="${s.due ? 'active' : ''}">Пора повторить (${due})</button>` : ''}
      ${S.project.trees.map(t => `<button data-scope="tree:${esc(t.id)}" class="${s.tree === t.id ? 'active' : ''}">${esc(t.icon || '')} ${esc(t.title)}</button>`).join('')}
    </div>`;
  }
  function renderQuiz() {
    quiz.cur = pickQuestion();
    const done = quiz.good + quiz.bad;
    if (!quiz.cur) {
      openModal(`<h2>Повторение</h2>${quizScopes()}
        ${quiz.pool.length ? `<p class="quiz-q">Готово! ${quiz.good} из ${done} вспомнил уверенно.</p><p class="muted" style="margin:0">Вопросы с ответом «не помню» будут попадаться чаще.</p>`
          : '<p class="muted">Здесь пока нет вопросов. Отметь навыки как изученные или выбери ветку выше.</p>'}
        <div class="p-actions">${quiz.pool.length ? '<button class="btn primary" id="qzAgain">Ещё круг</button>' : ''}<button class="btn ghost" data-close>Закрыть</button></div>`);
      const again = $('#qzAgain'); if (again) again.onclick = () => openQuiz(quiz.scope);
      bindScopes(); return;
    }
    const { n, t } = S.idx.get(quiz.cur.id);
    openModal(`<h2>Повторение</h2>${quizScopes()}
      <div class="quiz-meta"><span class="tag tree" style="--c:${esc(t.color)}">${esc(n.icon || '')} ${esc(n.title)}</span><span class="mono">${done + 1} / ${quiz.pool.length} · помню ${quiz.good}</span></div>
      <div class="quiz-q">${esc(quiz.cur.q)}</div>
      <div id="qzAnswer" class="q" style="padding:0;display:block"><div class="ans" style="--c:${esc(t.color)}" hidden></div></div>
      <div class="p-actions"><button class="btn" id="qzReveal">${quiz.cur.a ? 'Показать ответ' : (S.sample ? 'Спросить Claude' : 'Спросить Claude ↗')}</button></div>
      <div class="quiz-btns"><button class="btn danger" data-rate="bad">Не помню <span class="kbd">1</span></button><button class="btn good" data-rate="good">Помню <span class="kbd">2</span></button></div>`);
    bindScopes();
    $('#qzReveal').onclick = () => {
      const box = $('#qzAnswer .ans');
      if (quiz.cur.a) { box.hidden = false; box.textContent = quiz.cur.a; }
      else if (S.sample) askClaude(n, quiz.cur.q, box);
      else window.open(claudeUrl(askPrompt(n, quiz.cur.q)), '_blank', 'noopener');
    };
    $$('[data-rate]', modalCard).forEach(b => { b.onclick = () => rate(b.dataset.rate === 'good'); });
  }
  function bindScopes() {
    $$('[data-scope]', modalCard).forEach(b => {
      b.onclick = () => {
        const v = b.dataset.scope;
        openQuiz(v === 'all' ? { due: false } : v === 'due' ? { due: true } : { tree: v.slice(5) });
      };
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
    renderQuiz();
  }
  $('#reviewBtn').addEventListener('click', () => openQuiz({}));

  // ------------------------------------------------------------------ search
  function searchNodes(q) {
    q = q.trim().toLowerCase(); if (!q) return [];
    const res = [];
    S.idx.forEach(({ n, t }, id) => {
      if (n.title.toLowerCase().includes(q) || id.toLowerCase().includes(q)) { res.push({ id, score: 2, hint: t.title }); return; }
      const hit = (n.questions || []).map(qText).find(x => x.toLowerCase().includes(q));
      if (hit) res.push({ id, score: 1, hint: hit });
      else if ((n.description || '').toLowerCase().includes(q)) res.push({ id, score: 1, hint: n.description });
    });
    return res.sort((a, b) => b.score - a.score);
  }
  const searchEl = $('#search'), resultsEl = $('#searchResults');
  searchEl.addEventListener('input', () => {
    S.search = searchEl.value.trim();
    const res = searchNodes(S.search).slice(0, 8);
    resultsEl.innerHTML = res.length ? res.map(r => { const { n } = S.idx.get(r.id); return `<button class="result" data-goto="${esc(r.id)}"><span>${esc(n.icon || '')} ${esc(n.title)}</span><small>${esc(r.hint)}</small></button>`; }).join('') : (S.search ? '<p class="menu-note">Ничего не нашлось</p>' : '');
    resultsEl.hidden = !S.search;
    refreshMap();
  });
  searchEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const f = resultsEl.querySelector('[data-goto]'); if (f) f.click(); }
    if (e.key === 'Escape') { searchEl.value = ''; searchEl.dispatchEvent(new Event('input')); searchEl.blur(); }
  });
  resultsEl.addEventListener('click', e => {
    const b = e.target.closest('[data-goto]'); if (!b) return;
    searchEl.value = ''; S.search = ''; resultsEl.hidden = true;
    selectNode(b.dataset.goto, true);
  });

  // ------------------------------------------------------------------ more menu, onboarding, help
  $('#moreMenu').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    $('#moreMenu').hidden = true;
    const a = b.dataset.act;
    if (a === 'export-progress') exportProgress();
    if (a === 'import-progress') pickFile('progress');
    if (a === 'onboarding') showOnboarding();
    if (a === 'help') showHelp();
    if (a === 'reset-progress') {
      openPanel('confirm', `<h2 class="p-title">Сбросить прогресс?</h2><p class="p-desc">Все отметки, вопросы и заметки по карте «${esc(S.project.title)}» удалятся.</p><div id="confirmSlot"></div>`);
      confirmIn('Это нельзя отменить. Можно сначала сохранить прогресс в файл.', 'Сбросить всё', () => { S.progress = { nodes: {}, reviews: {} }; saveProgress(); panel.hidden = true; afterProgress(1); });
    }
  });
  function showOnboarding() {
    openModal(`<h2>Что ты уже знаешь?</h2>
      <p class="muted" style="margin:0">Отметь ветки, которые уже прокачаны. Навыки в них станут освоенными, а следующие откроются. Потом всё можно поправить вручную.</p>
      <div class="onb-grid">${S.project.trees.map(t => `<label class="onb-item" style="--c:${esc(t.color)}"><input type="checkbox" value="${esc(t.id)}"><span>${esc(t.icon || '')} ${esc(t.title)}</span></label>`).join('')}</div>
      <div class="p-actions"><button class="btn primary" id="onbGo">Поехали</button><button class="btn ghost" id="onbSkip">Начать с нуля</button></div>`);
    const finish = () => { S.prefs.onboarded = true; savePrefs(); closeModal(); };
    $('#onbGo').onclick = () => {
      const ids = $$('.onb-item input:checked', modalCard).map(i => i.value);
      const lvlBefore = levelOf(computeXP());
      for (const tid of ids) { const t = S.project.trees.find(x => x.id === tid); for (const n of t.nodes) { const p = S.progress.nodes[n.id] || (S.progress.nodes[n.id] = {}); if (p.s !== 'mastered') { p.s = 'mastered'; p.t = now(); } } }
      saveProgress(); finish(); afterProgress(lvlBefore);
      if (ids.length) toast('Ветки отмечены', `Доступно для изучения: ${[...S.idx.keys()].filter(id => nodeState(id) === 'available').length}`);
    };
    $('#onbSkip').onclick = finish;
  }
  function showHelp() {
    openModal(`<h2>Как пользоваться</h2>
      <ul class="help-list">
        <li><b>Карта</b>: тащи мышью или пальцем, колесо и щипок меняют масштаб. Чем дальше от центра, тем продвинутее тема.</li>
        <li><b>Навык</b>: золотая рамка значит, что он открыт. Нажми «Начать изучение», а потом «Освоено», и откроются следующие.</li>
        <li><b>Вопросы</b>: отмечай те, на которые уверенно ответишь. Каждый даёт 10 XP, освоенный навык даёт 100.</li>
        <li><b>Повторение</b>: карточки по изученным темам. Через ${REVIEW_AFTER_DAYS} день после освоения навык помечается значком ⟳.</li>
        <li><b>Редактор</b>: меняй навыки, перетаскивай их, Shift + клик связывает навыки. Экспорт JSON отдаёт карту целиком.</li>
        <li><b>Проекты</b>: отдельные карты со своими ветками. Создаются в меню с названием карты.</li>
        <li><b>Claude</b>: в репозитории есть skill, который создаёт и правит деревья по твоей просьбе. Готовый JSON загружается через «Импорт».</li>
      </ul>
      <div class="p-actions"><button class="btn primary" data-close>Понятно</button></div>`);
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
    const fromHash = decodeURIComponent(location.hash.slice(1));
    const first = [S.prefs.last, BUILTIN[0]?.id, S.customIndex[0]?.id].find(id => id && (isBuiltin(id) || S.customIndex.some(c => c.id === id)));
    if (!first) { document.body.insertAdjacentHTML('beforeend', '<p style="position:fixed;inset:40% 0 auto;text-align:center">Нет данных карты. Собери проект командой node scripts/build.mjs</p>'); return; }
    await openProject(first);
    requestAnimationFrame(() => fitAll(false));
    if (fromHash && S.idx.has(fromHash)) setTimeout(() => selectNode(fromHash, true), 300);
    else if (!S.prefs.onboarded && !Object.keys(S.progress.nodes).length) setTimeout(showOnboarding, 500);
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
      const pid = S.pid;
      const sel = S.sel;
      await openProject(pid, { keepView: true });
      if (sel && S.idx.has(sel)) selectNode(sel, false);
    } catch (e) { /* local only */ }
  }

  boot();
})();
