# Changelog

## 0.2.0 — 2026-10-15

- New look: dark minimal map, thin outlined nodes with short labels instead of emoji, hexagon keystones,
  Oswald sector titles, glass HUD with SVG icons.
- XMind-style editing everywhere, no edit mode: Tab, Enter, F2 or type to rename, Delete, arrow keys,
  undo and redo, drag to move, drag the ⊕ handle to link skills, context menu.
- Mind map inside every skill (double-click or F6): questions and subtopics as an XMind-style tree,
  "known" ticks, answers, Ask Claude with "save as answer".
- Data: nodes get `abbr`, `icon` is gone, questions can be grouped as `{ "topic", "items" }`.
  The backend map and the XMind importer use the grouping.

## 0.1.0 — 2026-10-15

First public version.

- Global SVG skill map with automatic radial layout, pan and zoom, semantic zoom.
- Unlocking by prerequisites (`requires`, `requiresAny`), XP and levels.
- Self-check questions, notes, spaced review flashcards, "Ask Claude".
- Built-in editor, separate projects, JSON import and export.
- Backend developer map for Java and Go: 10 branches, 97 skills, 645 questions.
- `gametree-trees` skill and Claude Code plugin manifests, XMind importer.
