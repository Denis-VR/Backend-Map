/* GameTree: one round mind map. The project sits in the middle, topics on a ring around it, sections
 * and questions branching outward; every topic owns its own slice of the circle. The wheel turns so the
 * topic you pick reads horizontally. A mind map opens inside every section.
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
  const PALETTE = ['#7fd492', '#f2cf3a', '#ff7a1a', '#c37ad3', '#2ea8e6', '#39c5cf', '#e06c61', '#e47fb0'];
  // Question difficulty, the same colors as in the XMind map.
  const LEVELS = { 1: { name: 'Базовый', c: '#7fd492' }, 2: { name: 'Средний', c: '#f2cf3a' }, 3: { name: 'Сложный', c: '#ff7a1a' }, 4: { name: 'Эксперт', c: '#c37ad3' } };
  const levelColor = l => (LEVELS[l] ? LEVELS[l].c : null);

  const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya' };
  function slug(s) {
    return String(s || '').toLowerCase().split('').map(c => TRANSLIT[c] ?? c).join('')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'item';
  }

  // Questions: a string, {q, a, level, important}, or a topic {topic, items: [...]} that nests further.
  const isTopic = q => !!q && typeof q === 'object' && typeof q.topic === 'string';
  const qText = q => (typeof q === 'string' ? q : (isTopic(q) ? q.topic : q.q));
  const qAns = q => (typeof q === 'string' || isTopic(q) ? '' : (q.a || ''));
  const qLevel = q => (q && typeof q === 'object' && LEVELS[q.level] ? q.level : null);
  const qImp = q => !!(q && typeof q === 'object' && q.important);
  function flatQ(list, path = [], group = [], lvl = null, imp = false) {
    const out = [];
    (list || []).forEach((q, i) => {
      if (isTopic(q)) out.push(...flatQ(q.items, [...path, i], [...group, q.topic], qLevel(q) || lvl, imp || qImp(q)));
      else if (q) out.push({ q: qText(q), a: qAns(q), path: [...path, i], group: group.join(' / '), level: qLevel(q) || lvl, important: qImp(q) || imp });
    });
    return out;
  }
  // a question object with only its text left goes back to a plain string
  function tidyQ(o) {
    for (const k of ['a', 'level', 'important']) if (!o[k]) delete o[k];
    return Object.keys(o).length === 1 && 'q' in o ? o.q : o;
  }
  const asObj = e => (typeof e === 'string' ? { q: e } : e);

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
    idx: new Map(),       // section id -> {n, t}
    layout: null,
    view: { x: 0, y: 0, k: 0.5 },
    focus: null, // the topic the map is turned to, the rest steps back
    rot: 0, // the wheel's turn, radians: the topic in focus lies along the horizontal
    mapView: null,        // map view saved while inside a section
    sel: null,            // '__core' | 'stage:<tree id>' | section id | '<section id>|<question path>'
    selTree: null,
    inner: null,          // {id, sel: path|null, collapsed: Set, items}
    search: '',
    searchKeys: null,
    qf: null,             // question filter: 1..4 or 'imp'
    undo: [], redo: [],
    fresh: new Set(),     // ids created in this session and not renamed yet (id follows the first name)
    anim: false,
    upgraded: false,
    sample: null,
    downloads: null
  };

  const app = $('#app'), svg = $('#map'), world = $('#world'), innerG = $('#inner');
  const L_EDGES = $('#layer-edges'), L_LINK = $('#layer-link'), L_NODES = $('#layer-nodes'), L_FX = $('#layer-fx');
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
  // every question of a section with its effective difficulty
  function sectionQs(id) {
    const e = S.idx.get(id); if (!e) return [];
    const base = e.n.level || e.t.level || null;
    return flatQ(e.n.questions).map(x => ({ ...x, level: x.level || base }));
  }

  // selection keys
  const qKey = (id, path) => id + '|' + path.join('.');
  const parsePath = s => (s === '' || s == null ? [] : s.split('.').map(Number));
  function selKind(k = S.sel) {
    if (!k) return null;
    if (k === '__core') return 'core';
    if (k.startsWith('stage:')) return 'stage';
    if (k.includes('|')) return 'q';
    return S.idx.has(k) ? 'sec' : null;
  }
  function selQ(k = S.sel) { const i = k.indexOf('|'); return { id: k.slice(0, i), path: parsePath(k.slice(i + 1)) }; }
  function curQ() {
    if (S.inner) return S.inner.sel ? { id: S.inner.id, path: S.inner.sel } : null;
    return selKind() === 'q' ? selQ() : null;
  }

  // XP & levels
  function computeXP() {
    let xp = 0;
    S.idx.forEach((_, id) => {
      const p = nodeProg(id); if (!p) return;
      if (p.s === 'mastered') xp += 100;
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

  // ------------------------------------------------------------------ text measuring
  const mctx = document.createElement('canvas').getContext('2d');
  const FONT = '"Golos Text", "Segoe UI", system-ui, sans-serif';
  const MONO = '"JetBrains Mono", ui-monospace, monospace';
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
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (mctx.measureText(t).width <= maxW) { cur = t; continue; }
      if (cur) lines.push(cur);
      cur = push(w);
    }
    if (cur || !lines.length) lines.push(cur);
    return { lines, w: Math.max(...lines.map(l => mctx.measureText(l).width)) };
  }
  const textW = (t, font) => { mctx.font = font; return mctx.measureText(t).width; };

  // ------------------------------------------------------------------ layout: radial mind map
  // The root sits in the centre, topics on an inner ring, sections on a middle ring and questions on the
  // outer ring. Every topic owns one sector of the circle. Labels run along the radius and are turned over
  // on the left half, so they always read left to right.
  const F_Q = `400 12.5px ${FONT}`, F_TOPIC = `600 12px ${FONT}`, F_SEC = `600 13px ${FONT}`, F_CNT = `500 10.5px ${MONO}`;
  const F_STAGE = `600 13px ${FONT}`, F_ROOT = `700 19px ${FONT}`;
  const SLOT = 19;          // px between neighbouring questions on the outer ring
  const SEC_GAP = 1.2;      // empty slots between sections of one topic
  const TOPIC_GAP = 3.5;    // empty slots between topics
  const Q_H = 18, TP_H = 22, SEC_H = 26, Q_MAXW = 470, RING_GAP = 54, CHILD_GAP = 26;
  // the middle of the map carries no text at reading zoom, so the root and the topic discs are sized
  // against the circle itself: big enough to read when the whole map is on screen
  function fitCircle(text, r, minFs, maxFs) {
    for (let fs = maxFs; ; fs -= 1) {
      const t = wrapText(text, `600 ${fs}px ${FONT}`, 2 * r - fs * 1.2);
      if (fs <= minFs || (t.w <= 2 * r - fs && t.lines.length * fs * 1.18 <= 2 * r - fs)) return { fs, lines: t.lines };
    }
  }
  const TAU = Math.PI * 2;

  function clipText(text, font, maxW) {
    if (textW(text, font) <= maxW) return text;
    let s = text;
    while (s.length > 8 && textW(s + '…', font) > maxW) s = s.slice(0, -1);
    return s.trimEnd() + '…';
  }
  function measureEntry(e, path, n, lvl, known) {
    const key = qKey(n.id, path), level = qLevel(e) || lvl, important = qImp(e);
    if (isTopic(e)) {
      const it = { kind: 'topic', key, id: n.id, path, text: e.topic, level, important, pad: important ? 26 : 11 };
      it.label = clipText(e.topic, F_TOPIC, Q_MAXW);
      it.len = Math.ceil(it.pad + textW(it.label, F_TOPIC) + 11); it.th = TP_H;
      it.children = (e.items || []).map((c, i) => measureEntry(c, [...path, i], n, level, known));
      return it;
    }
    const text = qText(e);
    const it = { kind: 'q', key, id: n.id, path, text, level, important, known: known.has(text), ans: !!qAns(e), children: [], pad: important ? 31 : 16 };
    it.label = clipText(text, F_Q, Q_MAXW);
    it.len = Math.ceil(it.pad + textW(it.label, F_Q) + 6); it.th = Q_H;
    return it;
  }
  function measureSection(n, t) {
    const st = qStats(n.id);
    const s = { kind: 'sec', key: n.id, id: n.id, text: n.title, cnt: st.total ? `${st.known}/${st.total}` : '' };
    s.label = clipText(n.title, F_SEC, 300);
    const cw = s.cnt ? textW(s.cnt, F_CNT) : 0;
    s.len = Math.ceil(14 + textW(s.label, F_SEC) + (cw ? 10 + cw : 0) + 14); s.th = SEC_H;
    const known = knownSet(n.id);
    s.children = (n.questions || []).map((e, i) => measureEntry(e, [i], n, n.level || t.level || null, known));
    return s;
  }
  const leafCount = it => (it.children.length ? it.children.reduce((a, c) => a + leafCount(c), 0) : 1);
  const P = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
  // axis-aligned box of a label that lies along the ray at angle a, from radius r over len px
  function radialBox(it) {
    const c = Math.cos(it.a), s = Math.sin(it.a), h = it.th / 2;
    const xs = [], ys = [];
    for (const [u, v] of [[it.r, -h], [it.r, h], [it.r + it.len, -h], [it.r + it.len, h]]) { xs.push(u * c - v * s); ys.push(u * s + v * c); }
    it.x = Math.min(...xs); it.y = Math.min(...ys); it.w = Math.max(...xs) - it.x; it.h = Math.max(...ys) - it.y;
  }

  function computeLayout() {
    const items = new Map(), pos = new Map();
    const ct = S.project.center?.title || S.project.title;
    const T = S.project.trees.map(t => {
      const secs = t.nodes.map(n => measureSection(n, t));
      const need = secs.reduce((a, s) => a + leafCount(s), 0) + SEC_GAP * Math.max(0, secs.length - 1);
      const q = t.nodes.reduce((a, n) => a + flatQ(n.questions).length, 0);
      return { t, secs, q, need: Math.max(1, need) };
    });
    const secLen = Math.max(120, ...T.flatMap(x => x.secs).map(s => s.len));
    const qAvg = Math.max(1, T.reduce((a, x) => a + x.q, 0) / Math.max(1, T.length));
    // ring radii: questions need SLOT px each on the outer ring; topic discs take room on the inner ring
    let minSlots = 6, N = 1, RQ = 0, RS = 0, RT = 0, rootR = 120, rrMax = 80;
    for (let i = 0; i < 8; i++) {
      N = Math.max(1, T.reduce((a, x) => a + Math.max(x.need, minSlots), 0) + TOPIC_GAP * T.length);
      RQ = Math.max(SLOT * N / TAU, secLen + 760);
      RS = RQ - secLen - RING_GAP;
      rootR = clamp(RS * 0.13, 90, 300);
      const base = clamp(RS * 0.05, 42, 120);
      for (const x of T) x.rr = Math.round(base * clamp(0.62 + 0.5 * Math.sqrt(x.q / qAvg), 0.62, 1.35));
      rrMax = Math.max(...T.map(x => x.rr));
      RT = clamp((rootR + RS) / 2, rootR + rrMax + 60, Math.max(rootR + rrMax + 60, RS - rrMax - 90));
      minSlots = Math.ceil((2 * rrMax + 50) / (RT * TAU / N));
    }
    for (const x of T) { const f = fitCircle(x.t.title, x.rr, 11, Math.round(x.rr * 0.34)); x.fs = f.fs; x.lines = f.lines; }
    const rf = fitCircle(ct, rootR, 16, Math.round(rootR * 0.3));
    const root = { kind: 'core', key: '__core', text: ct, fs: rf.fs, lines: rf.lines, r: rootR, x: -rootR, y: -rootR, w: rootR * 2, h: rootR * 2 };
    items.set(root.key, root);
    const da = TAU / N;
    let cursor = -Math.PI / 2 - (T.length ? Math.max(T[0].need, minSlots) * da / 2 : 0);
    let outer = RQ;
    const stages = [];
    const place = (it, r, depth) => {
      it.r = r; it.depth = depth;
      radialBox(it);
      outer = Math.max(outer, r + it.len);
      for (const c of it.children) place(c, depth === 0 ? RQ : r + it.len + CHILD_GAP, depth + 1);
    };
    for (const x of T) {
      const span = Math.max(x.need, minSlots), u = span / x.need, a0 = cursor;
      let slot = 0;
      // angles: leaves take one slot each, a parent sits in the middle of its children
      const angle = it => {
        if (!it.children.length) { it.a = a0 + (slot + 0.5) * u * da; slot += 1; return it.a; }
        const as = it.children.map(angle);
        return (it.a = (as[0] + as[as.length - 1]) / 2);
      };
      x.secs.forEach((s, i) => { if (i) slot += SEC_GAP; angle(s); });
      const a = a0 + span * da / 2;
      const placed = [];
      const walk = it => { placed.push(it); it.children.forEach(walk); };
      for (const s of x.secs) { place(s, RS, 0); walk(s); }
      const [cx, cy] = P(RT, a);
      const st = { kind: 'stage', key: 'stage:' + x.t.id, tid: x.t.id, t: x.t, a, a0, a1: a0 + span * da, cx, cy, r: x.rr, fs: x.fs, lines: x.lines, secs: x.secs,
        x: cx - x.rr, y: cy - x.rr, w: 2 * x.rr, h: 2 * x.rr };
      let bx0 = st.x, by0 = st.y, bx1 = st.x + st.w, by1 = st.y + st.h;
      for (const it of placed) {
        it.tid = x.t.id; it.color = x.t.color;
        items.set(it.key, it);
        bx0 = Math.min(bx0, it.x); by0 = Math.min(by0, it.y); bx1 = Math.max(bx1, it.x + it.w); by1 = Math.max(by1, it.y + it.h);
      }
      for (const s of x.secs) { const [px, py] = P(s.r + s.len / 2, s.a); pos.set(s.id, { x: px, y: py }); }
      st.box = { x0: bx0, y0: by0, x1: bx1, y1: by1 };
      st.rOut = Math.max(RQ, ...placed.map(it => it.r + it.len));
      for (const sc of x.secs) {
        const ls = []; const leaves = it => (it.children.length ? it.children.forEach(leaves) : ls.push(it)); leaves(sc);
        const h = u * da / 2;
        sc.a0 = Math.min(...ls.map(l => l.a)) - h; sc.a1 = Math.max(...ls.map(l => l.a)) + h;
        sc.rOut = Math.max(sc.r + sc.len, ...ls.map(l => l.r + l.len));
      }
      items.set(st.key, st);
      st.i = stages.length;
      stages.push(st);
      cursor += (span + TOPIC_GAP) * da;
    }
    const RL = outer + 70; // topic names around the rim, shown when the whole map is in view
    const ext = RL + 24;
    S.layout = { root, stages, items, pos, RQ, RS, RT, RL, rootR, bounds: { x0: -ext, y0: -ext, x1: ext, y1: ext } };
  }

  // ------------------------------------------------------------------ render: map
  const f1 = v => (Math.round(v * 10) / 10).toString();
  const pt = (r, a) => { const [x, y] = P(r, a); return f1(x) + ',' + f1(y); };
  const deg = a => f1(a * 180 / Math.PI);
  // a branch from (r0, a0) out to (r1, a1) that leaves and arrives along the radius
  const branch = (r0, a0, r1, a1) => { const m = (r0 + r1) / 2; return `M${pt(r0, a0)}C${pt(m, a0)} ${pt(m, a1)} ${pt(r1, a1)}`; };
  const radialTf = it => `rotate(${deg(it.a)}) translate(${f1(it.r)},0)${it.flip ? ' rotate(180)' : ''}`;
  const upright = () => (S.rot ? ` transform="rotate(${deg(-S.rot)})"` : ''); // keeps horizontal text level while the wheel is turned

  function rootSvg(r) {
    const lh = r.fs * 1.18, top = -((r.lines.length - 1) * lh) / 2 + r.fs * 0.35;
    return `<g class="root" data-key="__core" data-core="1" style="font-size:${r.fs}px">
      <circle class="rt-sel" r="${f1(r.r + 9)}"/><circle class="rt-halo" r="${f1(r.r + 22)}"/><circle class="rt" r="${f1(r.r)}"/>
      <text${upright()}>${r.lines.map((l, i) => `<tspan x="0" y="${f1(top + i * lh)}">${esc(l)}</tspan>`).join('')}</text></g>`;
  }
  function stageSvg(s) {
    const t = s.t, total = t.nodes.length, m = t.nodes.filter(n => isMastered(n.id)).length;
    const pct = total ? Math.round(100 * m / total) : 0;
    const lh = s.fs * 1.18, top = -((s.lines.length - 1) * lh) / 2 + s.fs * 0.35;
    return `<g class="stage${pct === 100 && total ? ' done' : ''}" data-key="${esc(s.key)}" data-tree="${esc(t.id)}" style="--c:${esc(t.color)};font-size:${s.fs}px" transform="translate(${f1(s.cx)},${f1(s.cy)})">
      <circle class="st-sel" r="${s.r + 9}"/>
      ${pct ? `<circle class="st-ring" r="${s.r + 4}"/><circle class="st-prog" r="${s.r + 4}" pathLength="100" stroke-dasharray="${pct} 100" transform="rotate(-90)"/>` : ''}
      <circle class="st-disc" r="${s.r}"/>
      <text class="st-t"${upright()}>${s.lines.map((l, i) => `<tspan x="0" y="${f1(top + i * lh)}">${esc(l)}</tspan>`).join('')}</text></g>`;
  }
  // the topic's name outside the rim, readable when the whole circle is on screen
  function rimSvg(s) {
    const L = S.layout, c = Math.cos(s.a + S.rot), sn = Math.sin(s.a + S.rot);
    const anchor = c > 0.28 ? 'start' : c < -0.28 ? 'end' : 'middle';
    // near the top and bottom the names would collide, so every other one steps out
    const [x, y] = P(L.RL + (Math.abs(c) < 0.55 && s.i % 2 ? 46 : 0), s.a);
    const total = flatQ(s.t.nodes.flatMap(n => n.questions || [])).length;
    return `<g class="rim" data-tree="${esc(s.tid)}" style="--c:${esc(s.t.color)}" transform="translate(${f1(x)},${f1(y)})${S.rot ? ` rotate(${deg(-S.rot)})` : ''}">
      <text class="rim-t" text-anchor="${anchor}" dy="${f1(sn * 0.6 + 0.35)}em"><tspan class="rim-n">${esc(s.t.title)}</tspan><tspan class="rim-c" dx=".5em">${total}</tspan></text></g>`;
  }
  function secSvg(s) {
    const st = nodeState(s.id), X = s.flip ? -1 : 1, a = s.flip ? 'end' : 'start', b = s.flip ? 'start' : 'end';
    const x0 = s.flip ? -s.len : 0, h = s.th;
    return `<g class="sec s-${st}" data-key="${esc(s.key)}" data-id="${esc(s.id)}" data-tree="${esc(s.tid)}" style="--c:${esc(s.color)}" transform="${radialTf(s)}">
      <rect class="sb-sel" x="${x0 - 4}" y="${-h / 2 - 4}" width="${s.len + 8}" height="${h + 8}" rx="${h / 2 + 4}"/>
      <rect class="sb" x="${x0}" y="${-h / 2}" width="${s.len}" height="${h}" rx="${h / 2}"/>
      <text class="sl" x="${X * 14}" y="4.6" text-anchor="${a}">${esc(s.label)}</text>
      ${s.cnt ? `<text class="sc" x="${X * (s.len - 13)}" y="4" text-anchor="${b}">${s.cnt}</text>` : ''}
      ${needsReview(s.id) ? `<circle class="due" cx="${X * (s.len - 4)}" cy="${-h / 2 + 4}" r="3.5"><title>Пора повторить</title></circle>` : ''}</g>`;
  }
  function impSvg(x, y) { return `<g class="imp" transform="translate(${x},${y})"><circle r="6.2"/><text y="3.6">!</text></g>`; }
  function entrySvg(it) {
    const lc = levelColor(it.level), X = it.flip ? -1 : 1, a = it.flip ? 'end' : 'start', x0 = it.flip ? -it.len : 0;
    const attrs = `data-key="${esc(it.key)}" data-id="${esc(it.id)}" data-tree="${esc(it.tid)}" data-path="${it.path.join('.')}" data-l="${it.level || 0}"${it.important ? ' data-imp="1"' : ''}${lc ? ` style="--lc:${lc}"` : ` style="--lc:${esc(it.color)}"`} transform="${radialTf(it)}"`;
    const tip = it.label !== it.text ? `<title>${esc(it.text)}</title>` : '';
    if (it.kind === 'topic') {
      return `<g class="qi tp" ${attrs}>${tip}<rect class="tb" x="${x0}" y="${-it.th / 2}" width="${it.len}" height="${it.th}" rx="${it.th / 2}"/>
        ${it.important ? impSvg(X * 13, 0) : ''}
        <text class="tt" x="${X * it.pad}" y="4.2" text-anchor="${a}">${esc(it.label)}</text></g>`;
    }
    const bw = Math.min(it.len - it.pad, 150);
    return `<g class="qi q${it.known ? ' known' : ''}" ${attrs}>${tip}<rect class="qhit" x="${x0 - 3}" y="${-it.th / 2}" width="${it.len + 6}" height="${it.th}" rx="5"/>
      <rect class="qb" x="${it.flip ? -(it.pad + bw) : it.pad}" y="-4" width="${f1(bw)}" height="8" rx="4"/>
      <g data-check="1"><circle class="qc-hit" cx="${X * 6}" r="8"/><circle class="qc" cx="${X * 6}" r="3.8"/></g>
      ${it.important ? impSvg(X * 20, 0) : ''}
      <text class="qt" x="${X * it.pad}" y="4.3" text-anchor="${a}">${esc(it.label)}</text>
      ${it.ans ? `<circle class="has-a" cx="${X * (it.len + 1)}" cy="-5" r="2"><title>Есть ответ</title></circle>` : ''}</g>`;
  }

  function renderMap() {
    const L = S.layout;
    let eh = '', nh = '', rim = '';
    for (const s of L.stages) {
      const spoke = `M${pt(L.rootR + 6, s.a)}L${pt(L.RT - s.r - 6, s.a)}`;
      const trunks = s.secs.map(sec => branch(L.RT + s.r, s.a, sec.r, sec.a)).join('');
      const conn = [];
      const walk = it => { for (const c of it.children) { conn.push(branch(it.r + it.len, it.a, c.r, c.a)); walk(c); } };
      s.secs.forEach(walk);
      eh += `<g data-tree="${esc(s.tid)}" style="--c:${esc(s.t.color)}"><path class="sector" d="M${pt(L.RL - 34, s.a0)}A${f1(L.RL - 34)},${f1(L.RL - 34)} 0 ${s.a1 - s.a0 > Math.PI ? 1 : 0} 1 ${pt(L.RL - 34, s.a1)}"/>
        <path class="spoke" d="${spoke}"/>${trunks ? `<path class="trunk" d="${trunks}"/>` : ''}${conn.length ? `<path class="conn" d="${conn.join('')}"/>` : ''}</g>`;
      nh += stageSvg(s);
      rim += rimSvg(s);
      const draw = it => { it.flip = Math.cos(it.a + S.rot) < -1e-6; nh += it.kind === 'sec' ? secSvg(it) : entrySvg(it); it.children.forEach(draw); };
      s.secs.forEach(draw);
    }
    L_EDGES.innerHTML = eh;
    L_NODES.innerHTML = rootSvg(L.root) + nh + rim;
    markSel();
    applySearch();
  }
  function refreshMap() { computeLayout(); renderMap(); }

  // selection marks and prerequisite links, without rebuilding the map
  function markSel() {
    $$('.sel, .req, .dep', L_NODES).forEach(el => el.classList.remove('sel', 'req', 'dep'));
    L_LINK.innerHTML = '';
    if (!S.sel || !S.layout) { setFocus(null); return; }
    const it = S.layout.items.get(S.sel);
    setFocus(S.searchKeys ? null : (it && (it.tid || (it.kind === 'stage' && it.t.id))) || null);
    const el = L_NODES.querySelector(`[data-key="${CSS.escape(S.sel)}"]`);
    if (el) el.classList.add('sel');
    if (S.selTree) L_NODES.querySelector(`.rim[data-tree="${CSS.escape(S.selTree)}"]`)?.classList.add('sel');
    if (selKind() !== 'sec') return;
    const { n } = S.idx.get(S.sel);
    let h = '';
    // prerequisites: a curve that bends toward the centre, so it does not cross the labels
    const link = (from, to, cls) => {
      const a = S.layout.pos.get(from), c = S.layout.pos.get(to); if (!a || !c) return;
      const mx = (a.x + c.x) * 0.3, my = (a.y + c.y) * 0.3;
      h += `<path class="${cls}" d="M${f1(a.x)},${f1(a.y)} Q${f1(mx)},${f1(my)} ${f1(c.x)},${f1(c.y)}"/>`;
    };
    for (const r of [...reqs(n), ...reqsAny(n)]) { link(r, S.sel, 'link-req'); L_NODES.querySelector(`.sec[data-id="${CSS.escape(r)}"]`)?.classList.add('req'); }
    for (const d of dependents(S.sel)) L_NODES.querySelector(`.sec[data-id="${CSS.escape(d)}"]`)?.classList.add('dep');
    L_LINK.innerHTML = h;
  }
  // while one topic is in focus the rest of the circle steps back, so the branch reads on its own
  const focusStyle = document.createElement('style');
  document.head.appendChild(focusStyle);
  function setFocus(tid) {
    if (S.focus === tid) return;
    S.focus = tid;
    focusStyle.textContent = tid ? `#map .dimmable [data-tree]:not([data-tree="${CSS.escape(tid)}"]) { opacity: .16; }` : '';
  }
  function applySearch() {
    const keys = S.searchKeys;
    svg.classList.toggle('searching', !!keys);
    if (keys) setFocus(null);
    $$('.hit', L_NODES).forEach(el => el.classList.remove('hit'));
    if (keys) keys.forEach(k => L_NODES.querySelector(`[data-key="${CSS.escape(k)}"]`)?.classList.add('hit'));
  }
  function setQFilter(f) {
    S.qf = S.qf === f ? null : f;
    svg.classList.remove('qf-1', 'qf-2', 'qf-3', 'qf-4', 'qf-imp');
    if (S.qf) svg.classList.add('qf-' + S.qf);
    renderLegend();
  }

  // ------------------------------------------------------------------ stars + view
  const starCanvas = $('#stars');
  let stars = [];
  function seedStars() {
    let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    stars = Array.from({ length: 160 }, () => ({ x: rnd(), y: rnd(), r: rnd() * 1 + 0.2, a: rnd() * 0.3 + 0.05, d: rnd() * 0.5 + 0.1 }));
  }
  function drawStars() {
    const dpr = window.devicePixelRatio || 1;
    const w = starCanvas.clientWidth, h = starCanvas.clientHeight;
    if (starCanvas.width !== Math.round(w * dpr) || starCanvas.height !== Math.round(h * dpr)) { starCanvas.width = Math.round(w * dpr); starCanvas.height = Math.round(h * dpr); }
    const ctx = starCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#c9d4ff';
    for (const st of stars) {
      const x = ((st.x * w * 1.5 + S.view.x * st.d * 0.2) % (w * 1.5) + w * 1.5) % (w * 1.5) - w * 0.25;
      const y = ((st.y * h * 1.5 + S.view.y * st.d * 0.2) % (h * 1.5) + h * 1.5) % (h * 1.5) - h * 0.25;
      ctx.globalAlpha = st.a;
      ctx.beginPath(); ctx.arc(x, y, st.r, 0, Math.PI * 2); ctx.fill();
    }
  }
  function applyView() {
    const v = S.view;
    (S.inner ? innerG : world).setAttribute('transform', `translate(${v.x.toFixed(2)},${v.y.toFixed(2)}) scale(${v.k.toFixed(4)})${S.inner ? '' : ` rotate(${(S.rot * 180 / Math.PI).toFixed(3)})`}`);
    svg.classList.toggle('far', !S.inner && v.k < 0.3);
    svg.classList.toggle('overview', !S.inner && v.k < 0.42);
    svg.style.setProperty('--ik', f1(1 / v.k));
    drawStars();
    positionInline();
  }
  let viewAnim = 0, viewDone = null;
  // a newer animation (or a pan) cancels the running one; its promise still resolves
  function stopView() { cancelAnimationFrame(viewAnim); if (viewDone) { const r = viewDone; viewDone = null; r(); } }
  function animateView(target, ms = 520, ease = 'out') {
    stopView();
    if (reduceMotion() || ms <= 0) {
      const turn = target.rot != null && target.rot !== S.rot;
      S.view = { x: target.x, y: target.y, k: target.k }; if (turn) S.rot = target.rot;
      applyView(); if (turn && !S.inner) renderMap();
      return Promise.resolve();
    }
    const from = { ...S.view }, t0 = performance.now(), r0 = S.rot, r1 = target.rot != null ? target.rot : S.rot;
    const turned = () => { if (r1 !== r0 && !S.inner) renderMap(); };
    const fn = ease === 'in' ? p => p * p * p : ease === 'inout' ? p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2) : p => 1 - Math.pow(1 - p, 3);
    return new Promise(res => {
      viewDone = res;
      const step = t => {
        const p = Math.min(1, (t - t0) / ms), e = fn(p);
        S.view = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e };
        S.rot = r0 + (r1 - r0) * e;
        applyView();
        if (p < 1) viewAnim = requestAnimationFrame(step); else { viewDone = null; turned(); res(); }
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
    const lg = $('#legend');
    if (!isNarrow() && !S.inner && !lg.classList.contains('collapsed')) {
      const lr = lg.getBoundingClientRect(), cut = Math.max(0, lr.right - r.left + 8);
      if (box.w - cut > 360) { box.x += cut; box.w -= cut; }
    }
    return box;
  }
  // world point -> the wheel's turned frame (the inner mind map never turns)
  function turnPt(x, y, rot = S.rot) {
    if (S.inner || !rot) return [x, y];
    const c = Math.cos(rot), s = Math.sin(rot);
    return [x * c - y * s, x * s + y * c];
  }
  function viewForT(tx, ty, k) {
    const b = viewport();
    return { k, x: b.x + b.w / 2 - tx * k, y: b.y + b.h / 2 + (isNarrow() ? 30 : 10) - ty * k };
  }
  const viewFor = (x, y, k) => viewForT(...turnPt(x, y), k);
  const flyTo = (x, y, k, ms, ease) => animateView(viewFor(x, y, k), ms, ease);
  function flyToBox(bx, maxK = 1) {
    const b = viewport();
    const w = bx.x1 - bx.x0 + 80, h = bx.y1 - bx.y0 + 80;
    const k = clamp(Math.min(b.w / w, (b.h - 110) / h), 0.12, maxK);
    return flyTo((bx.x0 + bx.x1) / 2, (bx.y0 + bx.y1) / 2, k);
  }
  // Turn the wheel so the angle a lies along the horizontal (whichever side is nearer), then show the
  // ring band r0..r1 of the sector a0..a1 as large as the screen allows.
  function turnTo(a, a0, a1, r0, r1, minK = 0.75, maxK = 1) {
    let rot = -a;
    if (Math.cos(a + S.rot) < 0) rot += Math.PI;
    rot = S.rot + Math.atan2(Math.sin(rot - S.rot), Math.cos(rot - S.rot));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i <= 12; i++) {
      const ang = a0 + (a1 - a0) * i / 12;
      for (const r of [r0, r1]) {
        const [x, y] = turnPt(r * Math.cos(ang), r * Math.sin(ang), rot);
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
    const b = viewport();
    const k = clamp(Math.min(b.w / (x1 - x0 + 60), (b.h - 100) / (y1 - y0 + 60)), minK, maxK);
    // too tall for the screen: keep the inner end (the sections) in view and let the rest scroll
    return animateView({ ...viewForT((x0 + x1) / 2, (y0 + y1) / 2, k), rot }, 650, 'inout');
  }
  const fitAll = (animate = true) => startView(animate);
  // The whole circle, upright.
  function startView(animate = false) {
    const bx = S.layout.bounds, b = viewport();
    // the topic names on the rim keep their size on screen, so they need room in screen pixels
    const mx = isNarrow() ? 84 : 150, my = isNarrow() ? 30 : 42;
    const top = isNarrow() ? 96 : 64, h = b.h - top - 30;
    const k = clamp(Math.min((b.w - 2 * mx) / (bx.x1 - bx.x0), (h - 2 * my) / (bx.y1 - bx.y0)), 0.02, 1);
    const v = { k, x: b.x + b.w / 2 - ((bx.x0 + bx.x1) / 2) * k, y: top + h / 2 - ((bx.y0 + bx.y1) / 2) * k, rot: 0 };
    return animate ? animateView(v) : animateView(v, 0);
  }
  function zoomAt(f, sx, sy) {
    const v = S.view, k = clamp(v.k * f, S.inner ? 0.2 : 0.02, 3);
    const wx = (sx - v.x) / v.k, wy = (sy - v.y) / v.k;
    S.view = { k, x: sx - wx * k, y: sy - wy * k };
    applyView();
  }
  function zoomCenter(f) { const b = viewport(); zoomAt(f, b.x + b.w / 2, b.y + b.h / 2); }
  function toScreen(x, y) { const r = svg.getBoundingClientRect(), [tx, ty] = turnPt(x, y); return { x: r.left + S.view.x + tx * S.view.k, y: r.top + S.view.y + ty * S.view.k }; }
  // Pan just enough to show a world-space box.
  function ensureVisible(x, y, w = 0, h = 0) {
    const b = viewport(), r = svg.getBoundingClientRect(), m = 60;
    const cs = [toScreen(x, y), toScreen(x + w, y), toScreen(x, y + h), toScreen(x + w, y + h)];
    const ax = Math.min(...cs.map(c => c.x)) - r.left, ay = Math.min(...cs.map(c => c.y)) - r.top;
    const zx = Math.max(...cs.map(c => c.x)) - r.left, zy = Math.max(...cs.map(c => c.y)) - r.top;
    let dx = 0, dy = 0;
    if (ax < b.x + m) dx = b.x + m - ax; else if (zx > b.x + b.w - m) dx = Math.max(b.x + b.w - m - zx, b.x + m - ax);
    if (ay < b.y + m + 40) dy = b.y + m + 40 - ay; else if (zy > b.y + b.h - m) dy = Math.max(b.y + b.h - m - zy, b.y + m + 40 - ay);
    if (dx || dy) return animateView({ k: S.view.k, x: S.view.x + dx, y: S.view.y + dy }, 280);
    return Promise.resolve();
  }
  function ensureItemVisible(key) {
    const it = S.layout && S.layout.items.get(key); if (!it) return Promise.resolve();
    if (S.view.k < 0.45) {
      return animateView(viewFor(it.x + it.w / 2, it.y + it.h / 2, 0.8), 420);
    }
    return ensureVisible(it.x, it.y, it.w, it.h);
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
    if (S.inner && !S.idx.has(S.inner.id)) { leaveInnerInstant(); }
    if (S.inner && S.inner.sel && !entryAt(innerNode(), S.inner.sel)) S.inner.sel = [];
    S.selTree = S.selTree && treeById(S.selTree) ? S.selTree : null;
    computeLayout();
    if (S.sel && !S.layout.items.has(S.sel) && !(S.inner && S.sel === S.inner.id)) S.sel = null;
    saveProject();
    if (!S.sel && !S.inner) closePanel();
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
  function hitInfo(target) {
    if (S.inner) {
      const it = target.closest('.it');
      if (!it) return { kind: 'empty' };
      const path = parsePath(it.dataset.path);
      if (target.closest('[data-check]')) return { kind: 'check', path };
      if (target.closest('[data-fold]')) return { kind: 'fold', path };
      return { kind: 'item', path };
    }
    const q = target.closest('.qi');
    if (q) return { kind: target.closest('[data-check]') ? 'qcheck' : 'q', id: q.dataset.id, path: parsePath(q.dataset.path) };
    const g = target.closest('.sec');
    if (g) return { kind: 'node', id: g.dataset.id };
    const st = target.closest('.stage, .rim');
    if (st) return { kind: 'stage', tid: st.dataset.tree };
    if (target.closest('.root')) return { kind: 'core' };
    return { kind: 'empty' };
  }
  const hitKey = h => h.kind + ':' + (h.id || h.tid || '') + (h.path ? '|' + h.path.join('.') : '');

  svg.addEventListener('pointerdown', e => {
    if (S.anim) return;
    hideCtx();
    if (editing) commitInline();
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    svg.focus({ preventScroll: true });
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stopView();
    clearTimeout(pressTimer);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: S.view.k };
      drag = null; return;
    }
    const h = hitInfo(e.target);
    drag = { sx: e.clientX, sy: e.clientY, vx: S.view.x, vy: S.view.y, h, moved: false, touch: e.pointerType === 'touch' };
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
    if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; clearTimeout(pressTimer); svg.classList.add('panning'); }
    if (!drag.moved) return;
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
    if (d.moved || e.type === 'pointercancel') return;
    onTap(d.h);
  };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    if (S.anim) return;
    stopView();
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
      if (h.kind === 'check') { qToggleKnown(S.inner.id, h.path); return; }
      if (h.kind === 'fold') { toggleFold(h.path); return; }
      if (h.kind === 'item') { if (dbl) startRenameItem(h.path); else selectInner(h.path); return; }
      selectInner(null); return;
    }
    if (h.kind === 'qcheck') { qToggleKnown(h.id, h.path); return; }
    if (h.kind === 'q') { if (dbl) dive(h.id, h.path); else selectMapQ(h.id, h.path); return; }
    if (h.kind === 'node') { if (dbl) dive(h.id); else selectNode(h.id); return; }
    if (h.kind === 'stage') { if (dbl) startRename('stage:' + h.tid); else selectTree(h.tid); return; }
    if (h.kind === 'core') { selectCore(); return; }
    deselect();
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
      if (selKind() === 'q') { const { id, path } = selQ(); selectMapQ(id, path.slice(0, -1)); return; }
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

  // Keys that work on a question both on the map and in the mini map
  function qKeys(e, id, path) {
    const k = e.key;
    if (!path.length || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (/^[1-4]$/.test(k)) { e.preventDefault(); qSetLevel(id, path, +k); return true; }
    if (k === '!') { e.preventDefault(); qToggleImp(id, path); return true; }
    return false;
  }

  function tabAction() {
    const kind = selKind();
    if (kind === 'core') addTree();
    else if (kind === 'stage') addSection(S.selTree);
    else if (kind === 'sec') qAddChild(S.sel, []);
    else if (kind === 'q') { const { id, path } = selQ(); qAddChild(id, path); }
    else selectCore();
  }
  function mapKey(e) {
    const kind = selKind(), k = e.key;
    if (kind === 'q' && qKeys(e, selQ().id, selQ().path)) return;
    if (k === 'Tab') { e.preventDefault(); tabAction(); return; }
    if ((k === 'F6' || (k === 'Enter' && (e.ctrlKey || e.metaKey))) && (kind === 'sec' || kind === 'q')) {
      e.preventDefault(); if (kind === 'sec') dive(S.sel); else dive(selQ().id, selQ().path); return;
    }
    if (k === 'Enter') {
      e.preventDefault();
      if (kind === 'core') addTree();
      else if (kind === 'stage') addTree(S.selTree);
      else if (kind === 'sec') addSection(S.idx.get(S.sel).t.id, S.sel);
      else if (kind === 'q') { const { id, path } = selQ(); qAddSibling(id, path); }
      return;
    }
    if ((k === 'F2' || k === ' ') && kind) { e.preventDefault(); startRename(S.sel); return; }
    if ((k === 'Delete' || k === 'Backspace') && kind && kind !== 'core') {
      e.preventDefault();
      if (kind === 'stage') deleteTree(S.selTree);
      else if (kind === 'sec') deleteNode(S.sel);
      else { const { id, path } = selQ(); qDelete(id, path); }
      return;
    }
    if (e.altKey && k.startsWith('Arrow')) {
      e.preventDefault();
      const d = k === 'ArrowUp' || k === 'ArrowLeft' ? -1 : 1;
      if (kind === 'stage' && (k === 'ArrowLeft' || k === 'ArrowRight')) moveTree(S.selTree, d);
      else if (kind === 'sec' && (k === 'ArrowUp' || k === 'ArrowDown')) moveNode(S.sel, d);
      else if (kind === 'q' && (k === 'ArrowUp' || k === 'ArrowDown')) { const { id, path } = selQ(); qMove(id, path, d); }
      return;
    }
    if (k.startsWith('Arrow')) { e.preventDefault(); navMap(k); return; }
    if (k === '+' || k === '=') { zoomCenter(1.3); return; }
    if (k === '-') { zoomCenter(1 / 1.3); return; }
    if (k === '0') { fitAll(); return; }
    if (k === '?') { showHelp(); return; }
    if (k === '/') { e.preventDefault(); $('#search').focus(); return; }
    if (kind && !e.ctrlKey && !e.metaKey && !e.altKey && k.length === 1 && /\p{L}/u.test(k)) { e.preventDefault(); startRename(S.sel, k); }
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
    if (!S.sel || !S.layout.items.has(S.sel)) { selectCore(); return; }
    // compare positions as they look on screen, with the wheel turned
    const anchor = it => {
      const [x, y] = it.r != null && it.a != null && it.kind !== 'stage' ? [(it.r + 20) * Math.cos(it.a), (it.r + 20) * Math.sin(it.a)] : [it.x + it.w / 2, it.y + it.h / 2];
      const [tx, ty] = turnPt(x, y); return { x: tx, y: ty };
    };
    const cur = anchor(S.layout.items.get(S.sel));
    const cands = [...S.layout.items.values()].map(it => ({ it, ...anchor(it) }));
    const b = spatialPick(cur, cands, key);
    if (b) selectKey(b.it.key, { keyboard: true });
  }
  function selectKey(key, opts = {}) {
    const kind = selKind(key);
    if (kind === 'core') selectCore();
    else if (kind === 'stage') selectTree(key.slice(6), { fly: false });
    else if (kind === 'sec') selectNode(key);
    else if (kind === 'q') { const { id, path } = selQ(key); selectMapQ(id, path); }
    if (opts.keyboard) ensureItemVisible(key);
  }

  // ------------------------------------------------------------------ context menu
  const ctx = $('#ctxMenu');
  let ctxActions = [];
  function showCtx(x, y, items) {
    ctxActions = [];
    ctx.innerHTML = items.map(it => {
      if (it === '-') return '<hr>';
      ctxActions.push(it.run);
      return `<button data-i="${ctxActions.length - 1}" class="${it.danger ? 'danger' : ''}${it.on ? ' active' : ''}"${it.disabled ? ' disabled' : ''}>${it.dot ? `<span class="dot" style="--c:${it.dot}"></span>` : ''}${esc(it.label)}${it.kbd ? `<span class="kbd-hint">${esc(it.kbd)}</span>` : ''}</button>`;
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
  function qCtxItems(id, path) {
    const e = entryAt(S.idx.get(id).n, path), isQ = e && !isTopic(e);
    const known = isQ && knownSet(id).has(qText(e)), lv = qLevel(e);
    return [
      { label: 'Добавить подвопрос', kbd: 'Tab', run: () => qAddChild(id, path) },
      { label: 'Добавить вопрос рядом', kbd: 'Enter', run: () => qAddSibling(id, path) },
      { label: 'Переименовать', kbd: 'F2', run: () => (S.inner ? startRenameItem(path) : startRename(qKey(id, path))) },
      ...(isQ ? [{ label: known ? 'Снять отметку «знаю»' : 'Знаю ответ', run: () => qToggleKnown(id, path) }] : []),
      '-',
      ...[1, 2, 3, 4].map(l => ({ label: LEVELS[l].name, kbd: String(l), dot: LEVELS[l].c, on: lv === l, run: () => qSetLevel(id, path, l) })),
      { label: qImp(e) ? 'Снять «важный»' : 'Отметить важным', kbd: '!', dot: '#e5484d', run: () => qToggleImp(id, path) },
      '-',
      { label: 'Выше', kbd: 'Alt ↑', run: () => qMove(id, path, -1) }, { label: 'Ниже', kbd: 'Alt ↓', run: () => qMove(id, path, 1) },
      '-', { label: isTopic(e) ? 'Удалить подтему' : 'Удалить вопрос', kbd: 'Del', danger: true, run: () => qDelete(id, path) }
    ];
  }
  function openContextFor(h, x, y) {
    if (S.inner) {
      if (h.kind === 'empty') {
        showCtx(x, y, [{ label: 'Новый вопрос', kbd: 'Tab', run: () => qAddChild(S.inner.id, []) }, { label: 'Показать всё', kbd: 'Ctrl 0', run: fitInner }, '-', { label: 'Вернуться к карте', kbd: 'Esc', run: () => exitInner() }]);
        return;
      }
      selectInner(h.path);
      if (!h.path.length) {
        showCtx(x, y, [{ label: 'Добавить вопрос', kbd: 'Tab', run: () => qAddChild(S.inner.id, []) }, { label: 'Переименовать раздел', kbd: 'F2', run: () => startRenameItem([]) }, '-', { label: 'Вернуться к карте', kbd: 'Esc', run: () => exitInner() }]);
        return;
      }
      showCtx(x, y, qCtxItems(S.inner.id, h.path));
      return;
    }
    if (h.kind === 'q' || h.kind === 'qcheck') {
      selectMapQ(h.id, h.path);
      showCtx(x, y, [{ label: 'Открыть в мини-карте', kbd: '2× клик', run: () => dive(h.id, h.path) }, '-', ...qCtxItems(h.id, h.path)]);
      return;
    }
    if (h.kind === 'node') {
      const id = h.id, st = nodeState(id), { t } = S.idx.get(id);
      selectNode(id);
      showCtx(x, y, [
        { label: 'Открыть мини-карту', kbd: '2× клик', run: () => dive(id) },
        '-',
        { label: 'Добавить вопрос', kbd: 'Tab', run: () => qAddChild(id, []) },
        { label: 'Раздел рядом', kbd: 'Enter', run: () => addSection(t.id, id) },
        { label: 'Переименовать', kbd: 'F2', run: () => startRename(id) },
        { label: 'Выше', kbd: 'Alt ↑', run: () => moveNode(id, -1) }, { label: 'Ниже', kbd: 'Alt ↓', run: () => moveNode(id, 1) },
        '-',
        st === 'mastered' ? { label: 'Сбросить «освоено»', run: () => setState(id, null) }
          : { label: 'Отметить освоенным', run: () => (st === 'locked' ? masterWithPrereqs(id) : setState(id, 'mastered')) },
        ...(st === 'available' ? [{ label: 'Начать изучение', run: () => setState(id, 'learning') }] : []),
        '-',
        { label: 'Удалить раздел', kbd: 'Del', danger: true, run: () => deleteNode(id) }
      ]);
      return;
    }
    if (h.kind === 'stage') {
      const tid = h.tid;
      selectTree(tid, { fly: false });
      showCtx(x, y, [
        { label: 'Добавить раздел', kbd: 'Tab', run: () => addSection(tid) },
        { label: 'Новая тема после этой', kbd: 'Enter', run: () => addTree(tid) },
        { label: 'Переименовать', kbd: 'F2', run: () => startRename('stage:' + tid) },
        { label: 'Левее', kbd: 'Alt ←', run: () => moveTree(tid, -1) }, { label: 'Правее', kbd: 'Alt →', run: () => moveTree(tid, 1) },
        '-',
        { label: 'Показать тему целиком', run: () => selectTree(tid) },
        '-',
        { label: 'Удалить тему', kbd: 'Del', danger: true, run: () => deleteTree(tid) }
      ]);
      return;
    }
    if (h.kind === 'core') {
      selectCore();
      showCtx(x, y, [{ label: 'Новая тема в конце', kbd: 'Tab', run: () => addTree() }, { label: 'Переименовать', kbd: 'F2', run: () => startRename('__core') }, { label: 'Показать всю карту', kbd: '0', run: () => fitAll() }]);
      return;
    }
    showCtx(x, y, [
      { label: 'Новая тема в конце', run: () => addTree() },
      '-',
      { label: 'Показать всю карту', kbd: '0', run: () => fitAll() },
      { label: 'Отменить', kbd: 'Ctrl Z', disabled: !S.undo.length, run: undo },
      { label: 'Управление', kbd: '?', run: showHelp }
    ]);
  }

  // ------------------------------------------------------------------ inline rename
  const inl = $('#inlineEdit');
  let editing = null; // {box(), align, orig, commit(v), tab?}
  function startInline(target, initial) {
    commitInline();
    editing = target;
    inl.value = initial != null ? initial : target.orig;
    inl.classList.toggle('left', target.align !== 'center');
    inl.hidden = false;
    positionInline();
    autoGrow();
    inl.focus({ preventScroll: true });
    if (initial == null) inl.select(); else inl.setSelectionRange(inl.value.length, inl.value.length);
  }
  function positionInline() {
    if (!editing) return;
    const b = editing.box(); if (!b) return;
    const k = S.view.k;
    if (b.a != null && b.len != null) { // a label along the radius: open the editor level, over its screen box
      const c = Math.cos(b.a), sn = Math.sin(b.a), pts = [[b.r, -b.th / 2], [b.r + b.len, b.th / 2], [b.r, b.th / 2], [b.r + b.len, -b.th / 2]].map(([u, v]) => toScreen(u * c - v * sn, u * sn + v * c));
      const x0 = Math.min(...pts.map(p => p.x)), x1 = Math.max(...pts.map(p => p.x)), cy = pts.reduce((a, p) => a + p.y, 0) / 4;
      const w = Math.max(240, Math.min(420, x1 - x0 + 24));
      inl.style.width = w + 'px';
      inl.style.left = clamp((x0 + x1) / 2 - w / 2, 8, window.innerWidth - w - 8) + 'px';
      inl.style.top = (cy - 17) + 'px';
      return;
    }
    const s = toScreen(b.x, b.y);
    if (editing.align === 'center') {
      const w = Math.max(200, b.w * k + 24), c = toScreen(b.x + b.w / 2, b.y + b.h / 2);
      inl.style.width = w + 'px';
      inl.style.left = (c.x - w / 2) + 'px';
      inl.style.top = (c.y - 17) + 'px';
    } else {
      const w = Math.max(240, Math.min(420, b.w * k + 24));
      inl.style.width = w + 'px';
      inl.style.left = (s.x - 6) + 'px';
      inl.style.top = (s.y - 6) + 'px';
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
      if (S.inner) { if (S.inner.sel) qAddChild(S.inner.id, S.inner.sel); } else tabAction();
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

  // rename anything on the map by its selection key
  function startRename(key, initial) {
    const kind = selKind(key); if (!kind) return;
    const box = () => S.layout && S.layout.items.get(key);
    let target;
    if (kind === 'core') target = { box, align: 'center', orig: S.project.center?.title || S.project.title, commit: v => { pushUndo(); S.project.center = { ...(S.project.center || {}), title: v }; saveProject(); } };
    else if (kind === 'stage') { const tid = key.slice(6); target = { box, align: 'center', orig: treeById(tid).title, commit: v => renameTree(tid, v) }; }
    else if (kind === 'sec') target = { box, align: 'left', orig: S.idx.get(key).n.title, commit: v => renameNode(key, v) };
    else {
      const { id, path } = selQ(key), e = entryAt(S.idx.get(id)?.n, path); if (!e) return;
      target = { box: () => S.layout && S.layout.items.get(qKey(id, path)), align: 'left', orig: qText(e), commit: v => qRename(id, path, v) };
    }
    ensureItemVisible(key).then(() => startInline(target, initial));
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
    if (S.inner && S.inner.id === oldId) S.inner.id = newId;
    S.fresh.delete(oldId);
    indexProject();
  }
  function renameNode(id, title) {
    const e = S.idx.get(id); if (!e) return;
    pushUndo();
    e.n.title = title;
    if (S.fresh.has(id)) renameNodeId(id, uniqueId(`${e.t.id}.${slug(title)}`));
    saveProject();
    syncHash();
  }
  function renameTree(tid, title) {
    const t = treeById(tid); if (!t) return;
    pushUndo();
    t.title = title;
    if (S.fresh.has('tree:' + tid)) {
      // the first name of a new topic gives it its id
      S.fresh.delete('tree:' + tid);
      t.id = uniqueId(slug(title), tid);
      if (S.selTree === tid) { S.selTree = t.id; S.sel = 'stage:' + t.id; }
    }
    saveProject();
  }
  function newNode(t, extra) {
    const id = uniqueId(`${t.id}.new`);
    S.fresh.add(id);
    return { id, title: 'Новый раздел', description: '', ...extra, questions: [] };
  }
  function addSection(tid, afterId) {
    const t = treeById(tid); if (!t) return;
    pushUndo();
    const extra = {};
    const prev = afterId && S.idx.get(afterId);
    if (prev && prev.n.requires && prev.n.requires.length) extra.requires = [...prev.n.requires];
    const n = newNode(t, extra);
    const at = afterId ? t.nodes.findIndex(x => x.id === afterId) : -1;
    if (at >= 0) t.nodes.splice(at + 1, 0, n); else t.nodes.push(n);
    saveProject();
    selectNode(n.id);
    startRename(n.id);
  }
  function addTree(afterTid) {
    pushUndo();
    const used = new Set(S.project.trees.map(t => (t.color || '').toLowerCase()));
    const color = PALETTE.find(c => !used.has(c)) || PALETTE[S.project.trees.length % PALETTE.length];
    const tid = uniqueId('topic');
    const t = { id: tid, title: 'Новая тема', color, description: '', nodes: [] };
    const at = afterTid ? S.project.trees.findIndex(x => x.id === afterTid) : -1;
    if (at >= 0) S.project.trees.splice(at + 1, 0, t); else S.project.trees.push(t);
    S.fresh.add('tree:' + tid);
    saveProject();
    selectTree(tid, { fly: false });
    startRename('stage:' + tid);
  }
  function deleteNode(id) {
    const e = S.idx.get(id); if (!e) return;
    pushUndo();
    const i = e.t.nodes.indexOf(e.n);
    e.t.nodes = e.t.nodes.filter(n => n.id !== id);
    for (const t of S.project.trees) for (const n of t.nodes) {
      for (const k of ['requires', 'requiresAny']) if (n[k]) { n[k] = n[k].filter(x => x !== id); if (!n[k].length) delete n[k]; }
    }
    S.sel = null;
    saveProject();
    const next = e.t.nodes[Math.min(i, e.t.nodes.length - 1)];
    if (next) selectNode(next.id); else selectTree(e.t.id, { fly: false });
    toast(`Удалено: ${e.n.title}`, 'Ctrl + Z вернёт');
  }
  function deleteTree(tid) {
    const t = treeById(tid); if (!t) return;
    pushUndo();
    const ids = new Set(t.nodes.map(n => n.id));
    S.project.trees = S.project.trees.filter(x => x !== t);
    for (const x of S.project.trees) for (const n of x.nodes) for (const k of ['requires', 'requiresAny']) if (n[k]) { n[k] = n[k].filter(r => !ids.has(r)); if (!n[k].length) delete n[k]; }
    S.selTree = null; S.sel = null; closePanel(); saveProject();
    toast(`Тема удалена: ${t.title}`, 'Ctrl + Z вернёт');
  }
  function moveNode(id, d) {
    const e = S.idx.get(id); if (!e) return;
    const list = e.t.nodes, i = list.indexOf(e.n), j = i + d;
    if (j < 0 || j >= list.length) return;
    pushUndo();
    [list[i], list[j]] = [list[j], list[i]];
    saveProject(); ensureItemVisible(id);
  }
  function moveTree(tid, d) {
    const list = S.project.trees, i = list.findIndex(t => t.id === tid), j = i + d;
    if (i < 0 || j < 0 || j >= list.length) return;
    pushUndo();
    [list[i], list[j]] = [list[j], list[i]];
    saveProject(); ensureItemVisible('stage:' + tid);
  }
  function wouldCycle(id, newReq) { return newReq === id || ancestors(newReq).has(id); }

  // ------------------------------------------------------------------ question editing (map and mini map)
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
  function setEntry(n, path, v) { listAt(n, path.slice(0, -1))[path[path.length - 1]] = v; }
  function uniqueQ(n, base = 'Новый вопрос') {
    const have = new Set(flatQ(n.questions).map(x => x.q));
    let q = base, i = 2; while (have.has(q)) q = `${base} ${i++}`;
    return q;
  }
  // select a question wherever the user is (mini map or map), optionally start renaming it
  function focusQ(id, path, rename) {
    if (S.inner && S.inner.id === id) { selectInner(path, { keyboard: true }); if (rename) startRenameItem(path); return; }
    selectMapQ(id, path);
    if (rename) startRename(path.length ? qKey(id, path) : id);
  }
  function qAddChild(id, path) {
    const n = S.idx.get(id)?.n; if (!n) return;
    pushUndo();
    let newPath;
    if (!path.length) { n.questions = n.questions || []; n.questions.push(uniqueQ(n)); newPath = [n.questions.length - 1]; }
    else {
      let e = entryAt(n, path); if (e == null) return;
      if (!isTopic(e)) {
        const topic = { topic: qText(e), items: [] };
        if (qLevel(e)) topic.level = qLevel(e);
        if (qImp(e)) topic.important = true;
        if (qAns(e)) topic.items.push({ q: 'Ответ', a: qAns(e) });
        setEntry(n, path, topic); e = topic;
        toast('Вопрос стал подтемой', 'Ctrl + Z вернёт');
      }
      e.items.push(uniqueQ(n));
      if (S.inner) S.inner.collapsed.delete(path.join('.'));
      newPath = [...path, e.items.length - 1];
    }
    saveProject();
    focusQ(id, newPath, true);
  }
  function qAddSibling(id, path) {
    const n = S.idx.get(id)?.n; if (!n) return;
    if (!path.length) { qAddChild(id, []); return; }
    pushUndo();
    const list = listAt(n, path.slice(0, -1)), i = path[path.length - 1];
    list.splice(i + 1, 0, uniqueQ(n));
    saveProject();
    focusQ(id, [...path.slice(0, -1), i + 1], true);
  }
  function qDelete(id, path) {
    const n = S.idx.get(id)?.n; if (!n || !path.length) return;
    pushUndo();
    const list = listAt(n, path.slice(0, -1)), i = path[path.length - 1];
    const [gone] = list.splice(i, 1);
    saveProject();
    focusQ(id, list.length ? [...path.slice(0, -1), Math.min(i, list.length - 1)] : path.slice(0, -1));
    toast(isTopic(gone) ? `Подтема удалена: ${gone.topic}` : 'Вопрос удалён', 'Ctrl + Z вернёт');
  }
  function qMove(id, path, d) {
    const n = S.idx.get(id)?.n; if (!n || !path.length) return;
    const list = listAt(n, path.slice(0, -1)), i = path[path.length - 1], j = i + d;
    if (j < 0 || j >= list.length) return;
    pushUndo();
    [list[i], list[j]] = [list[j], list[i]];
    saveProject();
    focusQ(id, [...path.slice(0, -1), j]);
  }
  function qRename(id, path, v) {
    const n = S.idx.get(id)?.n, e = entryAt(n, path); if (!e) return;
    pushUndo();
    if (isTopic(e)) e.topic = v;
    else { const old = qText(e); if (typeof e === 'string') setEntry(n, path, v); else e.q = v; renameKnown(id, old, v); }
    saveProject();
  }
  function qSetLevel(id, path, l) {
    const n = S.idx.get(id)?.n, e = entryAt(n, path); if (!e) return;
    pushUndo();
    const o = asObj(e);
    if (o.level === l) delete o.level; else o.level = l;
    setEntry(n, path, isTopic(o) ? o : tidyQ(o));
    saveProject();
  }
  function qToggleImp(id, path) {
    const n = S.idx.get(id)?.n, e = entryAt(n, path); if (!e) return;
    pushUndo();
    const o = asObj(e);
    if (o.important) delete o.important; else o.important = true;
    setEntry(n, path, isTopic(o) ? o : tidyQ(o));
    saveProject();
  }
  function qToggleKnown(id, path) {
    const e = entryAt(S.idx.get(id)?.n, path); if (!e || isTopic(e)) return;
    const q = qText(e);
    if (S.inner) S.inner.sel = path;
    toggleKnown(id, q, !knownSet(id).has(q));
  }
  function saveAnswer(id, path, text) {
    const n = S.idx.get(id)?.n, e = entryAt(n, path); if (!e || isTopic(e)) return;
    const v = String(text).trim();
    if (v === qAns(e)) return;
    pushUndo();
    setEntry(n, path, tidyQ({ ...asObj(e), a: v }));
    saveProject();
    toast(v ? 'Ответ сохранён' : 'Ответ удалён');
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
      toast(`Освоено: ${S.idx.get(id).n.title}`, opened.length ? `Открыто новых разделов: ${opened.length}` : '');
    }
    afterProgress(lvlBefore);
  }
  function masterWithPrereqs(id) {
    const lvlBefore = levelOf(computeXP());
    let c = 0;
    for (const x of [...ancestors(id), id]) if (!isMastered(x)) { const p = S.progress.nodes[x] || (S.progress.nodes[x] = {}); p.s = 'mastered'; p.t = now(); c++; }
    saveProgress(); burst(id);
    toast(`Освоено разделов: ${c}`, 'Вместе со всеми требованиями');
    afterProgress(lvlBefore);
  }
  function setTreeState(treeId, mastered) {
    const lvlBefore = levelOf(computeXP());
    const t = treeById(treeId); if (!t) return;
    for (const n of t.nodes) {
      if (mastered) { const p = S.progress.nodes[n.id] || (S.progress.nodes[n.id] = {}); if (p.s !== 'mastered') { p.s = 'mastered'; p.t = now(); } } else delete S.progress.nodes[n.id];
    }
    saveProgress();
    if (mastered) toast(`Тема «${t.title}» отмечена изученной`);
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
    const cnt = { 1: 0, 2: 0, 3: 0, 4: 0, imp: 0 };
    S.idx.forEach((_, id) => sectionQs(id).forEach(x => { if (x.level) cnt[x.level]++; if (x.important) cnt.imp++; }));
    $('#levelKey').innerHTML = [1, 2, 3, 4].map(l => `<button class="lk${S.qf === l ? ' on' : ''}" data-lf="${l}" style="--lc:${LEVELS[l].c}" title="Показать только: ${LEVELS[l].name}"><i></i>${LEVELS[l].name}<span class="mono">${cnt[l]}</span></button>`).join('')
      + `<button class="lk imp${S.qf === 'imp' ? ' on' : ''}" data-lf="imp" style="--lc:#e5484d" title="Показать только важные"><b>!</b>Важные<span class="mono">${cnt.imp}</span></button>`;
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
  $('#levelKey').addEventListener('click', e => { const b = e.target.closest('[data-lf]'); if (b) setQFilter(b.dataset.lf === 'imp' ? 'imp' : +b.dataset.lf); });
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
    const kind = selKind();
    if (S.inner) h.innerHTML = [k('Tab', 'подвопрос'), k('Enter', 'вопрос рядом'), k('1–4', 'сложность'), k('!', 'важный'), k('F2', 'переименовать'), k('Esc', 'к карте')].join('   ·   ');
    else if (kind === 'core') h.innerHTML = [k('Tab', 'новая тема'), k('→', 'к темам'), k('?', 'все клавиши')].join('   ·   ');
    else if (kind === 'stage') h.innerHTML = [k('Tab', 'раздел'), k('Enter', 'тема рядом'), k('F2', 'переименовать'), k('Alt ← →', 'переставить'), k('Del', 'удалить')].join('   ·   ');
    else if (kind === 'sec') h.innerHTML = [k('2× клик', 'мини-карта'), k('Tab', 'вопрос'), k('Enter', 'раздел рядом'), k('F2', 'переименовать'), k('Del', 'удалить')].join('   ·   ');
    else if (kind === 'q') h.innerHTML = [k('Tab', 'подвопрос'), k('Enter', 'вопрос рядом'), k('1–4', 'сложность'), k('!', 'важный'), k('F2', 'переименовать'), k('Del', 'удалить')].join('   ·   ');
    else h.innerHTML = [k('клик', 'выбрать'), k('кружок', 'знаю'), k('2× клик', 'мини-карта'), k('колесо', 'прокрутка'), k('Ctrl + колесо', 'масштаб'), k('?', 'клавиши')].join('   ·   ');
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
    else if (panelKind === 'node' && S.idx.has(S.sel)) renderNodePanel(S.sel);
    else if (panelKind === 'q' && selKind() === 'q' && entryAt(S.idx.get(selQ().id)?.n, selQ().path)) renderQPanel(selQ().id, selQ().path);
    else if (panelKind === 'tree' && S.selTree && treeById(S.selTree)) renderTreePanel(S.selTree);
    else if (panelKind === 'project') renderProjectPanel();
    else closePanel();
    if (openDetails) { const d = panelBody.querySelector('details.edit'); if (d) d.open = true; }
    panel.scrollTop = st;
  }
  function syncHash() {
    try {
      const h = S.sel && S.idx.has(S.sel) ? '#' + S.sel : '';
      if (h !== location.hash) history.replaceState(null, '', h || location.pathname + location.search);
    } catch (e) { /* sandboxed */ }
  }
  function afterSelect() { syncHash(); markSel(); renderLegend(); renderHint(); }
  function selectNode(id, opts = {}) {
    if (!S.idx.has(id)) return;
    S.sel = id; S.selTree = null;
    renderNodePanel(id);
    afterSelect();
    if (opts.fly) { const it = S.layout.items.get(id); turnTo(it.a, it.a0, it.a1, it.r - 30, Math.min(it.rOut, S.layout.RQ + 380) + 20, 0.8); }
  }
  function selectMapQ(id, path, opts = {}) {
    if (!path.length) { selectNode(id, opts); return; }
    if (!entryAt(S.idx.get(id)?.n, path)) return;
    S.sel = qKey(id, path); S.selTree = null;
    renderQPanel(id, path);
    afterSelect();
    if (opts.fly) { const it = S.layout.items.get(S.sel); if (it) turnTo(it.a, it.a - 0.04, it.a + 0.04, it.r - 140, it.r + Math.min(it.len, 420) + 20, 0.95); }
  }
  function selectCore() {
    S.sel = '__core'; S.selTree = null;
    renderProjectPanel(); afterSelect();
  }
  function deselect() {
    S.sel = null; S.selTree = null;
    closePanel(); afterSelect();
  }
  function selectTree(tid, opts = {}) {
    const t = treeById(tid); if (!t) return;
    if (S.inner) leaveInnerInstant();
    S.selTree = tid; S.sel = 'stage:' + tid;
    renderTreePanel(tid); afterSelect();
    const st = S.layout.items.get('stage:' + tid);
    if (opts.fly !== false && st) turnTo(st.a, st.a0, st.a1, S.layout.RS - 30, Math.min(st.rOut, S.layout.RQ + 380) + 20, 0.72);
  }

  const STATE_LABEL = { locked: 'Закрыт', available: 'Доступен', learning: 'Изучаю', mastered: 'Освоен' };
  function badge(id, big) {
    const { n, t } = S.idx.get(id);
    return `<span class="badge${isMastered(id) ? ' done' : ''}${big ? ' big' : ''}" style="--c:${esc(t.color)}"><span>${esc(abbrOf(n))}</span></span>`;
  }
  function chip(id) {
    const e = S.idx.get(id); if (!e) return `<span class="link-chip missing">${esc(id)}</span>`;
    return `<button class="link-chip${isMastered(id) ? ' done' : ''}" data-goto="${esc(id)}" style="--c:${esc(e.t.color)}"><span class="dot"></span>${esc(e.n.title)}</button>`;
  }
  const levelTag = l => (LEVELS[l] ? `<span class="tag lvl" style="--lc:${LEVELS[l].c}"><i></i>${LEVELS[l].name}</span>` : '');
  const impMark = '<span class="imp-mark" title="Важный">!</span>';
  function claudeUrl(text) { return 'https://claude.ai/new?q=' + encodeURIComponent(text); }
  function askPrompt(node, q) {
    return `Я повторяю тему «${node.title}». Кратко и по делу (до 150 слов) ответь на вопрос: ${q}. Если уместно, добавь маленький пример кода.`;
  }
  const icon = (name, cls = '') => `<svg class="ic ${cls}"><use href="#i-${name}"/></svg>`;

  function questionListHtml(id) {
    const { n, t } = S.idx.get(id);
    const known = knownSet(id), flat = sectionQs(id);
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
      <ul class="qlist">${g.items.map(x => `<li class="q${known.has(x.q) ? ' known' : ''}"${x.level ? ` style="--lc:${levelColor(x.level)}"` : ''}>
        <input type="checkbox" id="q-${x.i}" data-q="${x.i}" ${known.has(x.q) ? 'checked' : ''}>
        <label for="q-${x.i}">${x.important ? impMark : ''}${esc(x.q)}</label>${askBtn(x)}
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
          <div class="p-sub"><button class="tag tree" data-goto-tree="${esc(t.id)}" style="--c:${esc(t.color)}">${esc(t.title)}</button><span class="tag st-${st}">${STATE_LABEL[st]}</span>${levelTag(n.level || t.level)}</div></div>
      </div>
      ${n.description ? `<p class="p-desc">${esc(n.description)}</p>` : ''}
      ${actions}
      <div id="confirmSlot"></div>
      ${inInner ? '' : `<button class="dive-card" data-act="dive" style="--c:${esc(t.color)}">${icon('dive')}<span><b>Мини-карта раздела</b><small>${total ? `${known} из ${total} вопросов знаю` : 'Добавь вопросы и подтемы'}</small></span><span class="kbd">2× клик</span></button>`}
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

  const levelOptions = cur => `<option value="">Не задана</option>${[1, 2, 3, 4].map(l => `<option value="${l}"${cur === l ? ' selected' : ''}>${LEVELS[l].name}</option>`).join('')}`;
  function nodeEditorHtml(id) {
    const { n, t } = S.idx.get(id);
    const chips = (list, kind) => (list || []).map(r => `<span class="link-chip" style="--c:${esc(S.idx.get(r)?.t.color || '#666')}"><span class="dot"></span>${esc(S.idx.get(r)?.n.title || r)}<button type="button" data-rm="${kind}" data-v="${esc(r)}" title="Убрать">${icon('close', 'sm')}</button></span>`).join('');
    return `<details class="edit"><summary>Изменить раздел</summary>
      <form class="form" id="nodeForm">
        <div class="field-row">
          <label class="field"><span>Название</span><input id="f-title" value="${esc(n.title)}" required></label>
          <label class="field"><span>Метка</span><input id="f-abbr" value="${esc(n.abbr || '')}" maxlength="5" placeholder="${esc(autoAbbr(n.title))}"></label>
        </div>
        <label class="field"><span>Описание</span><textarea id="f-desc">${esc(n.description || '')}</textarea></label>
        <div class="field-row even">
          <label class="field"><span>Тема</span><select id="f-tree">${S.project.trees.map(x => `<option value="${esc(x.id)}"${x.id === t.id ? ' selected' : ''}>${esc(x.title)}</option>`).join('')}</select></label>
          <label class="field"><span>Сложность раздела</span><select id="f-level">${levelOptions(n.level || null)}</select></label>
        </div>
        <div class="field"><span>Требует (все)</span><div class="chips-edit">${chips(n.requires, 'requires')}</div>
          <input list="nodeIds" id="f-addreq" placeholder="Добавить: начни вводить название"></div>
        <div class="field"><span>Требует любой из</span><div class="chips-edit">${chips(n.requiresAny, 'requiresAny')}</div>
          <input list="nodeIds" id="f-addany" placeholder="Добавить альтернативу"></div>
        <label class="field"><span>Материалы: «название | ссылка» на строку</span><textarea id="f-res">${esc((n.resources || []).map(r => `${r.title || ''} | ${r.url}`).join('\n'))}</textarea></label>
        <datalist id="nodeIds">${[...S.idx.values()].filter(x => x.n.id !== id).map(x => `<option value="${esc(x.n.title)}">${esc(x.t.title)}</option>`).join('')}</datalist>
        <div class="p-actions"><button class="btn primary" type="submit">Сохранить</button><button class="btn danger" type="button" data-ed="delete">Удалить</button></div>
        <p class="small muted" style="margin:0">Вопросы правятся прямо на карте или в мини-карте раздела: Tab добавляет вопрос, F2 переименовывает, цифры 1–4 задают сложность.</p>
      </form></details>`;
  }
  function bindNodeEditor(id) {
    const form = $('#nodeForm'); if (!form) return;
    const { n, t } = S.idx.get(id);
    form.addEventListener('submit', e => {
      e.preventDefault();
      pushUndo();
      n.title = $('#f-title').value.trim() || n.title;
      const ab = $('#f-abbr').value.trim(); if (ab) n.abbr = ab; else delete n.abbr;
      n.description = $('#f-desc').value.trim();
      const lv = +$('#f-level').value; if (lv) n.level = lv; else delete n.level;
      n.resources = $('#f-res').value.split('\n').map(s => s.trim()).filter(Boolean).map(l => { const [a, b] = l.split('|').map(x => x.trim()); return b ? { title: a, url: b } : { title: a, url: a }; });
      if (!n.resources.length) delete n.resources;
      const nt = $('#f-tree').value;
      if (nt !== t.id) { t.nodes.splice(t.nodes.indexOf(n), 1); treeById(nt).nodes.push(n); }
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
      if (ed.dataset.ed === 'delete') { if (S.inner) leaveInnerInstant(); deleteNode(id); }
    });
  }

  // a question or subtopic, on the map or in the mini map
  function renderQPanel(id, path) {
    const { n, t } = S.idx.get(id);
    const e = entryAt(n, path); if (!e) return;
    const inner = !!S.inner;
    const known = knownSet(id);
    let inh = n.level || t.level || null;
    const crumbs = [];
    for (let i = 1; i < path.length; i++) {
      const x = entryAt(n, path.slice(0, i));
      if (isTopic(x)) { inh = qLevel(x) || inh; crumbs.push(`<button class="link-chip" data-act="q-select" data-path="${path.slice(0, i).join('.')}" style="--c:${esc(t.color)}">${esc(x.topic)}</button>`); }
    }
    const own = qLevel(e), eff = own || inh;
    const head = `<div class="p-head">${badge(id)}<div><div class="p-sub" style="margin:0 0 4px"><button class="tag tree" data-act="q-select" data-path="" style="--c:${esc(t.color)}">${esc(n.title)}</button></div></div></div>
      ${crumbs.length ? `<div class="links">${crumbs.join('')}</div>` : ''}`;
    const marks = `<div class="lvl-pick">${[1, 2, 3, 4].map(l => `<button class="${eff === l ? (own ? 'on' : 'inh') : ''}" data-act="q-level" data-l="${l}" style="--lc:${LEVELS[l].c}" title="Клавиша ${l}"><i></i>${LEVELS[l].name}</button>`).join('')}
      <button class="imp-btn${qImp(e) ? ' on' : ''}" data-act="q-imp" title="Клавиша !"><b>!</b>Важный</button></div>`;
    const tools = `<div class="p-actions"><button class="btn small" data-act="q-child">Подвопрос <span class="kbd">Tab</span></button><button class="btn small" data-act="q-sibling">Рядом <span class="kbd">Enter</span></button><button class="btn small" data-act="q-rename">Переименовать <span class="kbd">F2</span></button><button class="btn small danger" data-act="q-delete">Удалить</button></div>
      ${inner ? '' : `<button class="dive-card" data-act="q-dive" style="--c:${esc(t.color)}">${icon('dive')}<span><b>Открыть в мини-карте</b><small>${esc(n.title)}</small></span><span class="kbd">2× клик</span></button>`}`;
    if (isTopic(e)) {
      const fl = flatQ(e.items), k = fl.filter(x => known.has(x.q)).length;
      openPanel(inner ? 'inner-topic' : 'q', `${head}
        <h2 class="p-title">${esc(e.topic)}</h2>
        ${marks}
        <div style="--c:${esc(t.color)}"><p class="sec-title"><span>Подтема</span><span class="mono">${k}/${fl.length}</span></p><div class="progress"><i style="width:${fl.length ? Math.round(100 * k / fl.length) : 0}%"></i></div></div>
        <div class="links">${(e.items || []).map((x, i) => `<button class="link-chip${!isTopic(x) && known.has(qText(x)) ? ' done' : ''}" data-act="q-select" data-path="${[...path, i].join('.')}" style="--c:${esc(t.color)}"><span class="dot"></span>${esc(qText(x).length > 60 ? qText(x).slice(0, 58) + '…' : qText(x))}</button>`).join('')}</div>
        ${tools}`);
      return;
    }
    const q = qText(e), a = qAns(e), isK = known.has(q);
    openPanel(inner ? 'inner-q' : 'q', `${head}
      <h2 class="p-title q"${eff ? ` style="color:${levelColor(eff)}"` : ''}>${qImp(e) ? impMark : ''}${esc(q)}</h2>
      ${marks}
      <div class="p-actions"><button class="btn ${isK ? 'good' : 'primary'}" data-act="q-known">${isK ? 'Знаю ✓' : 'Знаю ответ'}</button>
        ${a ? '' : `<button class="btn" data-act="q-ask">${S.sample ? 'Спросить Claude' : 'Спросить Claude ↗'}</button>`}</div>
      <div style="--c:${esc(t.color)}">${a ? `<p class="sec-title">Ответ</p><div class="answer-box" id="qAnswer">${esc(a)}</div>` : '<div class="answer-box" id="qAnswer" hidden></div>'}</div>
      <label class="field"><span>${a ? 'Изменить ответ' : 'Записать свой ответ'}</span><textarea id="qAnsEdit" class="notes" placeholder="Коротко, своими словами">${esc(a)}</textarea></label>
      ${tools}`);
  }

  panelBody.addEventListener('click', e => {
    const go = e.target.closest('[data-goto]');
    if (go) { if (S.inner) leaveInnerInstant(); selectNode(go.dataset.goto, { fly: true }); return; }
    const gt = e.target.closest('[data-goto-tree]');
    if (gt) { selectTree(gt.dataset.gotoTree); return; }
    const act = e.target.closest('[data-act]');
    const nodeId = S.inner ? S.inner.id : S.sel;
    if (act) {
      const a = act.dataset.act, cq = curQ();
      if (a === 'dive') dive(nodeId);
      else if (a === 'learn') setState(nodeId, 'learning');
      else if (a === 'master') setState(nodeId, 'mastered');
      else if (a === 'reset') setState(nodeId, null);
      else if (a === 'master-chain') {
        const cnt = [...ancestors(nodeId)].filter(x => !isMastered(x)).length;
        confirmIn(`Отметить «${S.idx.get(nodeId).n.title}» и все требования (${cnt}) как изученные?`, 'Отметить', () => masterWithPrereqs(nodeId), false);
      } else if (a === 'ask-reset') confirmIn('Сбросить отметку «освоено»? Отметки вопросов и заметки останутся.', 'Сбросить', () => setState(nodeId, null));
      else if (a === 'quiz-node') openQuiz({ node: nodeId });
      else if (a === 'tree-master') confirmIn(`Отметить всю тему «${treeById(S.selTree).title}» изученной?`, 'Отметить', () => setTreeState(S.selTree, true), false);
      else if (a === 'tree-reset') confirmIn('Сбросить прогресс всей темы?', 'Сбросить', () => setTreeState(S.selTree, false));
      else if (a === 'tree-quiz') openQuiz({ tree: S.selTree });
      else if (a === 'tree-add') addSection(S.selTree);
      else if (a === 'add-tree') addTree();
      else if (!cq) return;
      else if (a === 'q-known') qToggleKnown(cq.id, cq.path);
      else if (a === 'q-ask') { const box = $('#qAnswer'); askClaude(S.idx.get(cq.id).n, qText(entryAt(S.idx.get(cq.id).n, cq.path)), box, true); }
      else if (a === 'q-child') qAddChild(cq.id, cq.path);
      else if (a === 'q-sibling') qAddSibling(cq.id, cq.path);
      else if (a === 'q-rename') { if (S.inner) startRenameItem(cq.path); else startRename(qKey(cq.id, cq.path)); }
      else if (a === 'q-delete') qDelete(cq.id, cq.path);
      else if (a === 'q-level') qSetLevel(cq.id, cq.path, +act.dataset.l);
      else if (a === 'q-imp') qToggleImp(cq.id, cq.path);
      else if (a === 'q-dive') dive(cq.id, cq.path);
      else if (a === 'q-select') { const p = act.dataset.path ? parsePath(act.dataset.path) : []; if (S.inner) selectInner(p); else selectMapQ(cq.id, p); }
      else if (a === 'save-answer') saveAnswer(cq.id, cq.path, act.dataset.text || $('#qAnswer')?.textContent || '');
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
    if (e.target.id === 'qAnsEdit') { const cq = curQ(); if (cq) saveAnswer(cq.id, cq.path, e.target.value); }
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
      <div class="p-head"><span class="badge big done" style="--c:${esc(t.color)}"><span>${t.nodes.length}</span></span>
        <div><h2 class="p-title">${esc(t.title)}</h2><div class="p-sub"><span class="tag tree" style="--c:${esc(t.color)}">${m}/${t.nodes.length} разделов</span><span class="tag">${kn}/${qn} вопросов</span>${levelTag(t.level)}</div></div></div>
      ${t.description ? `<p class="p-desc">${esc(t.description)}</p>` : ''}
      <div style="--c:${esc(t.color)}"><div class="progress"><i style="width:${t.nodes.length ? Math.round(100 * m / t.nodes.length) : 0}%"></i></div></div>
      <div class="p-actions">${qn ? '<button class="btn primary" data-act="tree-quiz">Повторить тему</button>' : ''}<button class="btn" data-act="tree-master">Отметить всю тему</button><button class="btn ghost" data-act="tree-reset">Сбросить</button></div>
      <div id="confirmSlot"></div>
      ${avail.length ? `<div><p class="sec-title">Можно изучать сейчас</p><div class="links">${avail.map(n => chip(n.id)).join('')}</div></div>` : ''}
      <div><p class="sec-title">Все разделы темы</p><div class="links">${t.nodes.map(n => chip(n.id)).join('')}</div></div>
      <details class="edit"><summary>Изменить тему</summary>
        <form class="form" id="treeForm">
          <label class="field"><span>Название</span><input id="t-title" value="${esc(t.title)}" required></label>
          <label class="field"><span>Сложность темы</span><select id="t-level">${levelOptions(t.level || null)}</select></label>
          <div class="field"><span>Цвет</span><div class="swatches">${colors.map((c, i) => `<input type="radio" name="tc" id="tc-${i}" value="${esc(c)}"${c === t.color ? ' checked' : ''}><label for="tc-${i}" style="--c:${esc(c)}" title="${used.has(c) ? 'Уже у другой темы' : esc(c)}"></label>`).join('')}</div></div>
          <label class="field"><span>Описание</span><textarea id="t-desc">${esc(t.description || '')}</textarea></label>
          <div class="p-actions"><button class="btn primary" type="submit">Сохранить</button><button class="btn" type="button" data-act="tree-add">Добавить раздел</button><button class="btn danger" type="button" data-ed="del-tree">Удалить тему</button></div>
        </form></details>`);
    $('#t-level').addEventListener('change', e => {
      // picking a difficulty also picks its color, as in the XMind map
      const l = +e.target.value; if (!l) return;
      const r = $(`input[name="tc"][value="${LEVELS[l].c}"]`); if (r) r.checked = true;
    });
    $('#treeForm').addEventListener('submit', e => {
      e.preventDefault();
      const title = $('#t-title').value.trim(); if (!title) return;
      pushUndo();
      Object.assign(t, { title, color: $('input[name="tc"]:checked')?.value || t.color, description: $('#t-desc').value.trim() });
      const lv = +$('#t-level').value; if (lv) t.level = lv; else delete t.level;
      saveProject(); toast('Тема сохранена');
    });
    panelBody.querySelector('[data-ed="del-tree"]').onclick = () => confirmIn(`Удалить тему «${t.title}» со всеми разделами (${t.nodes.length})?`, 'Удалить', () => deleteTree(t.id));
  }

  function renderProjectPanel() {
    const p = S.project;
    const total = S.idx.size, m = [...S.idx.keys()].filter(isMastered).length;
    const av = [...S.idx.keys()].filter(id => nodeState(id) === 'available');
    const learning = [...S.idx.keys()].filter(id => nodeState(id) === 'learning');
    let qn = 0; S.idx.forEach((_, id) => { qn += qStats(id).total; });
    openPanel('project', `
      <div class="p-head"><span class="badge big" style="--c:var(--gold)"><span>${Math.round(total ? 100 * m / total : 0)}%</span></span>
        <div><h2 class="p-title">${esc(p.title)}</h2><div class="p-sub"><span class="tag">${p.trees.length} тем</span><span class="tag">${m}/${total} разделов</span><span class="tag">${qn} вопросов</span></div></div></div>
      ${p.description ? `<p class="p-desc">${esc(p.description)}</p>` : ''}
      <div class="p-actions"><button class="btn" data-act="add-tree">${icon('plus')} Новая тема</button></div>
      ${learning.length ? `<div><p class="sec-title">Сейчас изучаю</p><div class="links">${learning.map(chip).join('')}</div></div>` : ''}
      ${av.length ? `<div><p class="sec-title">Открыто для изучения <span class="mono">${av.length}</span></p><div class="links">${av.map(chip).join('')}</div></div>` : '<p class="muted" style="margin:0">Все доступные разделы уже в работе.</p>'}
      <details class="edit"><summary>Изменить карту</summary>
        <form class="form" id="projForm2">
          <div class="field-row"><label class="field"><span>Название карты</span><input id="pp-title" value="${esc(p.title)}" required></label>
            <label class="field"><span>Название в центре</span><input id="pp-center" value="${esc(p.center?.title || '')}" maxlength="24"></label></div>
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

  // ------------------------------------------------------------------ inner mind map (dive into a section)
  const innerNode = () => (S.inner ? S.idx.get(S.inner.id)?.n : null);

  const HG = 40, HG_ROOT = 64, VG = 10, LH = 18;
  function buildInner() {
    const id = S.inner.id, { n, t } = S.idx.get(id);
    const known = knownSet(id);
    const items = [];
    const mk = (e, path, depth, lvl) => {
      const key = path.join('.');
      const it = { key, path, depth, children: [], level: qLevel(e) || lvl, important: qImp(e) };
      if (isTopic(e)) {
        it.kind = 'topic'; it.text = e.topic;
        const fl = flatQ(e.items);
        it.total = fl.length; it.known = fl.filter(x => known.has(x.q)).length;
        it.hasKids = (e.items || []).length > 0;
        it.folded = S.inner.collapsed.has(key);
        if (!it.folded) it.children = (e.items || []).map((c, i) => mk(c, [...path, i], depth + 1, it.level));
        const tw = wrapText(it.text, `600 13.5px ${FONT}`, 230);
        mctx.font = `500 10.5px ${MONO}`;
        it.cntText = `${it.known}/${it.total}`;
        const cw = mctx.measureText(it.cntText).width;
        it.pad = it.important ? 34 : 16;
        it.lines = tw.lines; it.w = Math.ceil(it.pad + tw.w + 12 + cw + 14); it.h = tw.lines.length * LH + 14;
      } else {
        it.kind = 'q'; it.text = qText(e); it.ans = qAns(e); it.known = known.has(it.text);
        const tw = wrapText(it.text, `400 13px ${FONT}`, 250);
        it.pad = it.important ? 50 : 32;
        it.lines = tw.lines; it.w = Math.max(120, Math.ceil(it.pad + tw.w + 16)); it.h = tw.lines.length * LH + 16;
      }
      items.push(it);
      return it;
    };
    const root = { key: '', path: [], depth: 0, kind: 'root', text: n.title, abbr: abbrOf(n), mastered: isMastered(id) };
    const rt = wrapText(n.title, `600 18px ${FONT}`, 260);
    root.lines = rt.lines; root.w = Math.max(170, Math.ceil(rt.w + 48)); root.h = rt.lines.length * 24 + 42;
    root.children = (n.questions || []).map((c, i) => mk(c, [i], 1, n.level || t.level || null));
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
      const lc = levelColor(it.level);
      const attrs = `data-path="${it.key}" data-l="${it.level || 0}"${it.important ? ' data-imp="1"' : ''}${lc ? ` style="--lc:${lc}"` : ''}`;
      if (it.kind === 'root') {
        nh += `<g class="it k-root${it.mastered ? ' mastered' : ''}${sel}" data-path="" transform="translate(${f1(it.x)},${f1(it.y)})">${box}
          <rect class="card" width="${it.w}" height="${it.h}" rx="12"/>
          <text class="root-abbr" x="${it.w / 2}" y="20" text-anchor="middle">${esc(it.abbr.toUpperCase())}</text>
          <text class="qt" text-anchor="middle">${it.lines.map((l, i) => `<tspan x="${it.w / 2}" y="${44 + i * 24}">${esc(l)}</tspan>`).join('')}</text></g>`;
      } else if (it.kind === 'topic') {
        const fx = it.dir > 0 ? it.w + 9 : -9;
        nh += `<g class="it k-topic${sel}" ${attrs} transform="translate(${f1(it.x)},${f1(it.y)})">${box}
          <rect class="card" width="${it.w}" height="${it.h}" rx="${Math.min(it.h / 2, 13)}"/>
          ${it.important ? impSvg(18, 17) : ''}
          <text class="qt">${it.lines.map((l, i) => `<tspan x="${it.pad}" y="${20 + i * LH}">${esc(l)}</tspan>`).join('')}</text>
          <text class="cnt" x="${it.w - 14}" y="20" text-anchor="end">${it.cntText}</text>
          ${it.hasKids ? `<g data-fold="1"><circle class="fold" cx="${fx}" cy="${f1(it.h / 2)}" r="8"/><text class="fold-t" x="${fx}" y="${f1(it.h / 2 + 3.5)}">${it.folded ? '+' : '−'}</text></g>` : ''}</g>`;
      } else {
        nh += `<g class="it k-q${it.known ? ' known' : ''}${sel}" ${attrs} transform="translate(${f1(it.x)},${f1(it.y)})">${box}
          <rect class="card" width="${it.w}" height="${it.h}" rx="8"/>
          <g class="chk" data-check="1"><circle cx="16" cy="17" r="12" fill="transparent"/><circle class="chk-c" cx="16" cy="17" r="7"/><path class="tick" d="M12.6 17.2l2.4 2.4 4.2-4.6"/></g>
          ${it.important ? impSvg(36, 17) : ''}
          <text class="qt">${it.lines.map((l, i) => `<tspan x="${it.pad}" y="${21 + i * LH}">${esc(l)}</tspan>`).join('')}</text>
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
    markSel();
    if (isNarrow()) closePanel();
    const p = S.layout.pos.get(id);
    S.mapView = { ...S.view };
    try { await Promise.race([document.fonts ? document.fonts.ready : null, new Promise(r => setTimeout(r, 400))]); } catch (e) { /* ignore */ }
    svg.classList.add('fade-world');
    await flyTo(p.x, p.y, clamp(S.view.k * 3.2, 1.6, 3.2), 360, 'in');
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
    S.view = p ? viewFor(p.x, p.y, clamp(back.k * 3.2, 1.6, 3.2)) : back;
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
    markSel();
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
    const id = S.inner.id;
    if (!path.length || !entryAt(S.idx.get(id).n, path)) { renderNodePanel(id); return; }
    renderQPanel(id, path);
  }

  function innerKey(e) {
    const path = S.inner.sel, k = e.key, id = S.inner.id;
    if (path && qKeys(e, id, path)) return;
    if (k === 'Tab') { e.preventDefault(); qAddChild(id, path || []); return; }
    if (k === 'Enter') { e.preventDefault(); if (path && path.length) qAddSibling(id, path); else qAddChild(id, []); return; }
    if ((k === 'F2' || k === ' ') && path) { e.preventDefault(); startRenameItem(path); return; }
    if ((k === 'Delete' || k === 'Backspace') && path && path.length) { e.preventDefault(); qDelete(id, path); return; }
    if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown') && path && path.length) { e.preventDefault(); qMove(id, path, k === 'ArrowUp' ? -1 : 1); return; }
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
    const key = path.join('.');
    const it = S.inner.items.find(x => x.key === key);
    if (!it) return;
    const box = () => S.inner && S.inner.items.find(x => x.key === key);
    const id = S.inner.id;
    if (!path.length) { startInline({ box, align: 'center', orig: n.title, commit: v => renameNode(id, v) }, initial); return; }
    const e = entryAt(n, path);
    S.inner.sel = path;
    ensureVisible(it.x, it.y, it.w, it.h).then(() => startInline({ box, align: 'left', orig: qText(e), commit: v => qRename(id, path, v) }, initial));
  }
  function toggleFold(path) {
    const k = path.join('.');
    S.inner.collapsed.has(k) ? S.inner.collapsed.delete(k) : S.inner.collapsed.add(k);
    renderInner();
  }

  // ------------------------------------------------------------------ persistence of project / progress
  let projTimer = null;
  function saveProject() {
    indexProject();
    refreshMap();
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

  // Edits of a built-in map are stored as a full copy. A copy of an older format of the built-in map
  // (before the round map) is replaced by the new map; progress is kept by section id.
  function upgradeSaved(saved, base) {
    if (!saved || !base) return saved;
    if (saved.baseRev && (saved.schema || 1) >= (base.schema || 1)) return saved;
    S.upgraded = !!saved.baseRev;
    return clone(base);
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
    if (!opts.keepView) startView(false);
    S.prefs.last = id; savePrefs();
    if (S.upgraded) { S.upgraded = false; Store.set('project-' + id, S.project); toast('Карта перестроена в круг', 'Темы и вопросы из твоего XMind, прогресс по разделам сохранён'); }
    else if (b && saved && saved.baseRev && b.rev && saved.baseRev !== b.rev && !opts.keepView) toast('Вышла новая версия карты', 'Меню ⋯ → «Вернуть исходную карту», если хочешь её');
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
      if (!t || !t.id || !Array.isArray(t.nodes)) return 'У каждой темы должны быть id и nodes';
      for (const n of t.nodes) { if (!n.id || !n.title) return 'У каждого раздела должны быть id и title'; if (ids.has(n.id)) return `Повторяется id раздела: ${n.id}`; ids.add(n.id); }
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
      + '<p class="menu-note">Проект это отдельная карта со своими темами и прогрессом.</p>';
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
        <label class="field"><span>Первая тема</span><input id="pj-tree" required placeholder="Основы"></label>
        <div class="p-actions"><button class="btn primary" type="submit">Создать</button><button class="btn ghost" type="button" data-close>Отмена</button></div>
      </form>`);
    $('#pj-title').focus();
    $('#projForm').addEventListener('submit', async e => {
      e.preventDefault();
      const title = $('#pj-title').value.trim(); if (!title) return;
      let id = slug(title), i = 2; while (allProjects().some(p => p.id === id)) id = `${slug(title)}-${i++}`;
      const tTitle = $('#pj-tree').value.trim() || 'Основы', tid = slug(tTitle);
      const p = { schema: 2, id, title, description: $('#pj-desc').value.trim(), center: { title },
        trees: [{ id: tid, title: tTitle, color: PALETTE[0], level: 1, description: '', nodes: [{ id: `${tid}.start`, title: 'Первый раздел', description: '', questions: [] }] }] };
      closeModal();
      await createProject(p);
      selectNode(`${tid}.start`);
      toast(`Проект «${p.title}» создан`, 'Tab добавляет вопрос, Enter добавляет раздел рядом');
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
    S.idx.forEach(({ t }, id) => {
      if (scope.node && id !== scope.node) return;
      if (scope.tree && t.id !== scope.tree) return;
      const st = nodeState(id);
      if (!scope.node && !scope.tree && !scope.imp && st !== 'mastered' && st !== 'learning') return;
      if (scope.due && !needsReview(id)) return;
      for (const x of sectionQs(id)) if (!scope.imp || x.important) pool.push({ id, q: x.q, a: x.a, g: x.group, level: x.level, important: x.important });
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
    if (!scope.node && !scope.tree && !scope.imp && due.length && scope.due === undefined) scope.due = true;
    quiz = { scope, pool: quizPool(scope), seen: new Set(), good: 0, bad: 0, cur: null };
    renderQuiz();
  }
  function quizScopes() {
    const s = quiz.scope;
    const due = [...S.idx.keys()].filter(needsReview).length;
    return `<div class="scope">
      <button data-scope="all" class="${!s.node && !s.tree && !s.due && !s.imp ? 'active' : ''}">Всё изученное</button>
      <button data-scope="imp" class="${s.imp ? 'active' : ''}"><b class="imp-mark">!</b>Важные</button>
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
          : '<p class="help-text">Здесь пока нет вопросов. Отметь разделы как изученные или выбери тему выше.</p>'}
        <div class="p-actions">${quiz.pool.length ? '<button class="btn primary" id="qzAgain">Ещё круг</button>' : ''}<button class="btn ghost" data-close>Закрыть</button></div>`, 'wide');
      const again = $('#qzAgain'); if (again) again.onclick = () => openQuiz(quiz.scope);
      bindScopes(); return;
    }
    const { n, t } = S.idx.get(quiz.cur.id);
    const c = quiz.cur;
    openModal(`<h2>Повторение</h2>${quizScopes()}
      <div class="quiz-meta"><span class="p-sub" style="margin:0"><span class="tag tree" style="--c:${esc(t.color)}">${esc(n.title)}</span>${levelTag(c.level)}</span><span class="mono">${done + 1} / ${quiz.pool.length} · помню ${quiz.good}</span></div>
      <div>${c.g ? `<div class="quiz-group" style="--c:${esc(t.color)}">${esc(c.g)}</div>` : ''}<div class="quiz-q">${c.important ? impMark : ''}${esc(c.q)}</div></div>
      <div class="answer-box" id="qzAnswer" style="--c:${esc(t.color)}" hidden></div>
      <div class="p-actions"><button class="btn" id="qzReveal">${c.a ? 'Показать ответ' : (S.sample ? 'Спросить Claude' : 'Спросить Claude ↗')} <span class="kbd">Пробел</span></button></div>
      <div class="quiz-btns"><button class="btn danger" data-rate="bad">Не помню <span class="kbd">1</span></button><button class="btn good" data-rate="good">Помню <span class="kbd">2</span></button></div>`, 'wide');
    bindScopes();
    $('#qzReveal').onclick = () => {
      const box = $('#qzAnswer');
      if (c.a) { box.hidden = false; box.textContent = c.a; } else askClaude(n, c.q, box);
    };
    $$('[data-rate]', modalCard).forEach(b => { b.onclick = () => rate(b.dataset.rate === 'good'); });
  }
  function bindScopes() {
    $$('[data-scope]', modalCard).forEach(b => {
      b.onclick = () => { const v = b.dataset.scope; openQuiz(v === 'all' ? { due: false } : v === 'due' ? { due: true } : v === 'imp' ? { imp: true } : { tree: v.slice(5) }); };
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
      if (n.title.toLowerCase().includes(q) || id.toLowerCase().includes(q) || (n.abbr || '').toLowerCase() === q) res.push({ id, score: 3, hint: t.title });
      for (const x of flatQ(n.questions)) if (x.q.toLowerCase().includes(q)) res.push({ id, score: 1, hint: x.q, path: x.path });
    });
    return res.sort((a, b) => b.score - a.score);
  }
  function searchKeys(q) {
    q = q.trim().toLowerCase(); if (!q) return null;
    const keys = new Set();
    for (const t of S.project.trees) if (t.title.toLowerCase().includes(q)) keys.add('stage:' + t.id);
    S.idx.forEach(({ n }, id) => {
      if (n.title.toLowerCase().includes(q)) keys.add(id);
      const walk = (list, path) => (list || []).forEach((e, i) => {
        const p = [...path, i];
        if (qText(e).toLowerCase().includes(q)) keys.add(qKey(id, p));
        if (isTopic(e)) walk(e.items, p);
      });
      walk(n.questions, []);
    });
    return keys;
  }
  const searchEl = $('#search'), resultsEl = $('#searchResults');
  searchEl.addEventListener('input', () => {
    S.search = searchEl.value.trim();
    const res = searchNodes(S.search).slice(0, 10);
    resultsEl.innerHTML = res.length ? res.map(r => `<button class="result" data-goto="${esc(r.id)}"${r.path ? ` data-qpath="${r.path.join('.')}"` : ''}>${badge(r.id)}<span>${esc(r.path ? r.hint : S.idx.get(r.id).n.title)}</span><small>${esc(r.path ? S.idx.get(r.id).n.title : r.hint)}</small></button>`).join('')
      : (S.search ? '<p class="menu-note">Ничего не нашлось</p>' : '');
    resultsEl.hidden = !S.search;
    S.searchKeys = S.search.length >= 2 ? searchKeys(S.search) : null;
    if (!S.inner) applySearch();
  });
  searchEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const f = resultsEl.querySelector('[data-goto]'); if (f) f.click(); }
    if (e.key === 'Escape') { searchEl.value = ''; searchEl.dispatchEvent(new Event('input')); svg.focus({ preventScroll: true }); }
  });
  resultsEl.addEventListener('click', e => {
    const b = e.target.closest('[data-goto]'); if (!b) return;
    searchEl.value = ''; S.search = ''; S.searchKeys = null; resultsEl.hidden = true; applySearch();
    const id = b.dataset.goto;
    if (S.inner) leaveInnerInstant();
    if (b.dataset.qpath != null) { selectMapQ(id, parsePath(b.dataset.qpath), { fly: true }); return; }
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
      <p class="help-text">Отметь темы, которые уже прокачаны. Разделы в них станут освоенными, а следующие откроются. Потом всё можно поправить вручную.</p>
      <div class="onb-grid">${S.project.trees.map(t => `<label class="onb-item" style="--c:${esc(t.color)}"><input type="checkbox" value="${esc(t.id)}"><span>${esc(t.title)}</span></label>`).join('')}</div>
      <div class="p-actions"><button class="btn primary" id="onbGo">Поехали</button><button class="btn ghost" id="onbSkip">Начать с нуля</button></div>`);
    const finish = () => { S.prefs.onboarded = true; savePrefs(); closeModal(); };
    $('#onbGo').onclick = () => {
      const ids = $$('.onb-item input:checked', modalCard).map(i => i.value);
      const lvlBefore = levelOf(computeXP());
      for (const tid of ids) for (const n of treeById(tid).nodes) { const p = S.progress.nodes[n.id] || (S.progress.nodes[n.id] = {}); if (p.s !== 'mastered') { p.s = 'mastered'; p.t = now(); } }
      saveProgress(); finish(); afterProgress(lvlBefore);
      if (ids.length) toast('Темы отмечены', `Доступно для изучения: ${[...S.idx.keys()].filter(id => nodeState(id) === 'available').length}`);
    };
    $('#onbSkip').onclick = finish;
  }
  function showHelp() {
    const row = (what, key) => `<div><span>${what}</span><kbd>${key}</kbd></div>`;
    openModal(`<h2>Управление</h2>
      <div class="keys">
        <h3>Карта</h3>
        ${row('Выбрать тему, раздел или вопрос', 'клик')}${row('Отметить «знаю»', 'клик по кружку')}
        ${row('Мини-карта раздела', '2× клик / F6')}${row('Ходить по карте', 'стрелки')}
        ${row('Прокрутка', 'колесо, перетаскивание')}${row('Масштаб', 'Ctrl + колесо, щипок')}
        ${row('Добавить внутрь', 'Tab')}${row('Добавить рядом', 'Enter')}
        ${row('Переименовать', 'F2, пробел или просто печатай')}${row('Удалить', 'Delete')}
        ${row('Переставить', 'Alt + стрелки')}${row('Меню действий', 'правый клик')}
        ${row('Сложность вопроса', '1 2 3 4')}${row('Важный вопрос', '!')}
        ${row('Вся карта целиком', '0 или кнопка ⛶')}
        <h3>Мини-карта</h3>
        ${row('Подвопрос', 'Tab')}${row('Вопрос рядом', 'Enter')}
        ${row('Свернуть подтему', 'клик по ±')}${row('Назад к карте', 'Esc')}
        <h3>Везде</h3>
        ${row('Отменить', 'Ctrl + Z')}${row('Повторить', 'Ctrl + Shift + Z')}
        ${row('Поиск', 'Ctrl + F или /')}${row('Эта справка', '?')}
      </div>
      <p class="help-text">Карта круглая: в центре проект, вокруг темы, от каждой темы расходятся разделы, а от разделов вопросы. Когда выбираешь тему, круг поворачивается к ней, и её ветка читается слева направо, а остальные уходят на второй план. Названия тем видны по краю, когда карта показана целиком. Цвет вопроса это сложность: <b style="color:${LEVELS[1].c}">базовый</b>, <b style="color:${LEVELS[2].c}">средний</b>, <b style="color:${LEVELS[3].c}">сложный</b>, <b style="color:${LEVELS[4].c}">эксперт</b>. Красный «!» отмечает важные вопросы. В легенде слева можно оставить на карте только одну сложность или только важные.</p>
      <p class="help-text">Раздел открывается, когда освоены все его требования. Вопрос с отметкой «знаю» даёт 10 XP, освоенный раздел 100. Через ${REVIEW_AFTER_DAYS} день после освоения у раздела появляется золотая точка: пора повторить.</p>
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
    requestAnimationFrame(() => startView(false));
    // text widths depend on the web font: lay out again once it is loaded
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!S.inner) { refreshMap(); if (!S.sel) startView(false); } });
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
