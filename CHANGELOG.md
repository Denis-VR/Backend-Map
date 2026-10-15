# Changelog

## 0.3.0 — 2026-10-15

- The map is now one round mind map: the project in the middle, topics on a ring around it, each topic owning
  a slice of the circle with its sections and questions branching outward. Picking a topic turns the wheel so
  its branch reads left to right and the rest of the circle steps back; topic names sit around the rim.
- The backend map follows the Java Interview mind map one to one: 19 topics, 102 sections, 593 questions.
  Progress on sections that already existed is kept.
- Questions and subtopics have a difficulty `level` (1–4, colored like in XMind) and an `important` mark (red "!").
  Topics and sections can set a level for all their questions.
- Legend filter by difficulty or important only, and an "Important" round in review.
- Questions are edited right on the map: Tab, Enter, F2, Delete, Alt+arrows, 1–4 for difficulty, `!` for important.
- Navy color scheme close to the XMind dark theme.
- Removed: dragging skills, the ⊕ link handle, keystones and the `pos` field.
- XMind importer keeps the original structure and turns text colors into difficulty and "!" markers into `important`.

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
