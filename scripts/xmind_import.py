#!/usr/bin/env python3
"""Turn an XMind mind map into a GameTree project.

    python3 scripts/xmind_import.py path/to/map.xmind <project-id> ["Project title"]

The map is read the way it looks in XMind:
  root topic            -> the project (its title is the start of the line)
  level 1 topics        -> stages on the line (trees), in XMind order
  level 2 topics        -> sections (skills) of a stage
  deeper topics         -> questions; a topic with children becomes a group {"topic", "items"}
Text colors become question difficulty (green 1, yellow 2, orange 3, purple 4) and the
"!" / priority markers become "important". Questions placed straight under a stage go into
a "Общие вопросы" section. Notes become answers.

The draft has no `requires` between sections: add them with Claude (skill "gametree-trees").
"""
import json, os, re, sys, zipfile

LEVEL_BY_COLOR = {"8EDE99": 1, "FDD834": 2, "FF6F00": 3, "BA69C8": 4}
LEVEL_COLOR = {1: "#7fd492", 2: "#f2cf3a", 3: "#ff7a1a", 4: "#c37ad3"}
PALETTE = ["#2ea8e6", "#7fd492", "#f2cf3a", "#ff7a1a", "#c37ad3", "#e5534b", "#39c5cf"]
IMPORTANT = {"symbol-exclam", "priority-1"}
TR = dict(zip("абвгдеёжзийклмнопрстуфхцчшщыэюя", ["a","b","v","g","d","e","e","zh","z","i","y","k","l","m","n","o","p","r","s","t","u","f","h","c","ch","sh","sch","y","e","yu","ya"]))


def slug(s):
    s = "".join(TR.get(c, c) for c in s.lower())
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:32] or "item"


def clean(s): return " ".join((s or "").split())
def kids(t): return [c for k in ("attached", "detached") for c in t.get("children", {}).get(k, [])]
def props(t): return (t.get("style") or {}).get("properties", {})
def note(t): return clean(t.get("notes", {}).get("plain", {}).get("content", "")) if t.get("notes") else ""
def important(t): return any(m.get("markerId") in IMPORTANT for m in t.get("markers") or [])


def level_of(color):
    if not color: return None
    return LEVEL_BY_COLOR.get(color.lstrip("#")[:6].upper())


def text_of(t):
    ks = kids(t)
    return clean(t.get("title")) + (" (" + "; ".join(text_of(c) for c in ks) + ")" if ks else "")


def question(t, inherited):
    """A topic with children and no question mark is a group; anything else is one question."""
    title, ks, p = clean(t.get("title")), kids(t), props(t)
    lvl = level_of(p.get("fo:color")) or level_of(p.get("line-color")) or inherited
    if ks and "?" not in title:
        g = {"topic": title, "items": [question(c, lvl) for c in ks]}
        if important(t): g["important"] = True
        return g
    q = {"q": title}
    answer = " ".join(x for x in [note(t), "; ".join(text_of(c) for c in ks)] if x)
    if answer: q["a"] = answer
    if lvl: q["level"] = lvl
    if important(t): q["important"] = True
    return q if len(q) > 1 else title


def abbr(title):
    m = re.search(r"\b[A-Z][A-Za-z0-9+#]{1,3}\b", title)
    if m: return m.group(0)
    words = re.findall(r"\w+", title)
    if not words: return "?"
    if len(words) == 1: return words[0][:1].upper() + words[0][1:3]
    return "".join(w[0].upper() for w in words[:3])


def build(src, pid, title=None):
    with zipfile.ZipFile(src) as z:
        sheets = json.loads(z.read("content.json"))
    root = sheets[0]["rootTopic"]
    title = title or clean(root.get("title")) or pid
    trees, used = [], set()
    for i, area in enumerate(kids(root)):
        ap = props(area)
        tlevel = level_of(ap.get("line-color")) or level_of(ap.get("svg:fill"))
        fill = ap.get("svg:fill")
        color = LEVEL_COLOR[tlevel] if tlevel else PALETTE[i % len(PALETTE)]
        if fill and not level_of(fill): color = "#" + fill.lstrip("#")[:6].lower()
        tid = slug(clean(area["title"]))
        while tid in used: tid += "-2"
        used.add(tid)
        nodes, seen, loose = [], set(), []
        for sub in kids(area):
            sp, st = props(sub), clean(sub["title"])
            slevel = level_of(sp.get("line-color")) or tlevel
            if not kids(sub):  # a question right under the stage
                loose.append(question(sub, tlevel)); continue
            if "?" in st and not any(kids(c) for c in kids(sub)):
                loose.append(question(sub, tlevel)); continue
            nid = f"{tid}.{slug(st)}"
            while nid in seen: nid += "-2"
            seen.add(nid)
            node = {"id": nid, "title": st, "abbr": abbr(st)}
            if slevel: node["level"] = slevel
            node["description"] = note(sub)
            node["questions"] = [question(c, slevel) for c in kids(sub)]
            nodes.append(node)
        if loose:
            nodes.append({"id": f"{tid}.general", "title": "Общие вопросы", "abbr": "Gen", "description": "", "questions": loose})
        tree = {"id": tid, "title": clean(area["title"]), "color": color}
        if tlevel: tree["level"] = tlevel
        tree["description"] = ""
        tree["nodes"] = nodes
        trees.append(tree)
    project = {"schema": 2, "id": pid, "title": title, "description": "", "center": {"title": clean(root.get("title")) or title}, "trees": [t["id"] for t in trees]}
    return project, trees


def main():
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    src, pid = sys.argv[1], slug(sys.argv[2])
    project, trees = build(src, pid, sys.argv[3] if len(sys.argv) > 3 else None)
    out = os.path.join(os.path.dirname(__file__), "..", "data", "projects", pid)
    os.makedirs(os.path.join(out, "trees"), exist_ok=True)
    for t in trees:
        with open(os.path.join(out, "trees", t["id"] + ".json"), "w") as f: json.dump(t, f, ensure_ascii=False, indent=2)
    with open(os.path.join(out, "project.json"), "w") as f: json.dump(project, f, ensure_ascii=False, indent=2)
    print(f"Written data/projects/{pid}: {len(trees)} stages, {sum(len(t['nodes']) for t in trees)} sections")


if __name__ == "__main__":
    main()
