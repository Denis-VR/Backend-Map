#!/usr/bin/env python3
"""Turn an XMind mind map into a draft GameTree project.

    python3 scripts/xmind_import.py path/to/map.xmind <project-id> ["Project title"]

Level 1 topics become trees (branches), level 2 topics become skills, everything
deeper becomes self-check questions. The draft has no dependencies between skills:
open it with Claude (skill "gametree-trees") to add `requires`, icons and descriptions.
"""
import json, os, re, sys, zipfile

PALETTE = ["#f0883e", "#57ab5a", "#539bf5", "#e275ad", "#c69026", "#e5534b", "#986ee2", "#39c5cf", "#8ddb8c", "#e3b341"]
TR = dict(zip("абвгдеёжзийклмнопрстуфхцчшщыэюя", ["a","b","v","g","d","e","e","zh","z","i","y","k","l","m","n","o","p","r","s","t","u","f","h","c","ch","sh","sch","y","e","yu","ya"]))

def slug(s):
    s = "".join(TR.get(c, c) for c in s.lower())
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:32] or "item"

def clean(s): return " ".join((s or "").split())
def kids(t): return [c for k in ("attached", "detached") for c in t.get("children", {}).get(k, [])]
def text_of(t):
    ks = kids(t)
    return clean(t.get("title")) + (" (" + "; ".join(text_of(c) for c in ks) + ")" if ks else "")

def questions(t, prefix=""):
    title, ks = clean(t.get("title")), kids(t)
    note = clean(t.get("notes", {}).get("plain", {}).get("content", "")) if t.get("notes") else ""
    deep = any(kids(g) for c in ks for g in kids(c))
    if ks and "?" not in title and not deep:
        return [q for c in ks for q in questions(c, prefix + title + ": ")]
    q = {"q": prefix + title}
    answer = " ".join(x for x in [note, "; ".join(text_of(c) for c in ks)] if x)
    return [dict(q, a=answer)] if answer else [q["q"]]

def main():
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    src, pid = sys.argv[1], slug(sys.argv[2])
    with zipfile.ZipFile(src) as z:
        sheets = json.loads(z.read("content.json"))
    root = sheets[0]["rootTopic"]
    title = sys.argv[3] if len(sys.argv) > 3 else clean(root.get("title")) or pid
    out = os.path.join(os.path.dirname(__file__), "..", "data", "projects", pid)
    os.makedirs(os.path.join(out, "trees"), exist_ok=True)
    tree_ids, total = [], 0
    for i, area in enumerate(kids(root)):
        tid = slug(clean(area["title"]))
        while tid in tree_ids: tid += "-2"
        nodes, seen = [], set()
        for sub in kids(area):
            nid = f"{tid}.{slug(clean(sub['title']))}"
            while nid in seen: nid += "-2"
            seen.add(nid)
            qs = [q for c in kids(sub) for q in questions(c)]
            nodes.append({"id": nid, "title": clean(sub["title"]), "icon": "", "description": "", "questions": qs})
        tree = {"id": tid, "title": clean(area["title"]), "color": PALETTE[i % len(PALETTE)], "icon": "", "description": "", "nodes": nodes}
        json.dump(tree, open(os.path.join(out, "trees", tid + ".json"), "w"), ensure_ascii=False, indent=2)
        tree_ids.append(tid); total += len(nodes)
    project = {"schema": 1, "id": pid, "title": title, "description": "", "center": {"title": title, "icon": "✨"}, "trees": tree_ids}
    json.dump(project, open(os.path.join(out, "project.json"), "w"), ensure_ascii=False, indent=2)
    print(f"Draft written to data/projects/{pid}: {len(tree_ids)} trees, {total} skills")

if __name__ == "__main__":
    main()
