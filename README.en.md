<div align="center">

# ◆ Backend Map · GameTree

**A game-style skill tree for what you actually study.**
One big round map: the project in the middle, topics around it, sections and questions branching outward.
Master a section, unlock the next ones, and come back to review what you learned.

[![Deploy](https://github.com/Denis-VR/Backend-Map/actions/workflows/pages.yml/badge.svg)](https://github.com/Denis-VR/Backend-Map/actions/workflows/pages.yml)
[![Validate](https://github.com/Denis-VR/Backend-Map/actions/workflows/validate.yml/badge.svg)](https://github.com/Denis-VR/Backend-Map/actions/workflows/validate.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-d9b36c.svg)](LICENSE)
![No dependencies](https://img.shields.io/badge/dependencies-0-57ab5a.svg)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-986ee2.svg)](#build-trees-with-claude)

[**Live demo**](https://denis-vr.github.io/Backend-Map/) · [Русская версия](README.md) · [Data format](skills/gametree-trees/SKILL.md) · [Contributing](CONTRIBUTING.md)

<img src="docs/images/map.webp" alt="GameTree: the backend developer map as one round mind map, questions colored by difficulty" width="100%">

</div>

## Why

Roadmaps are long lists, and lists are easy to abandon. Skill trees in games make
progress visible: you see what you have, what just opened up, and how far the edge
of the map is. GameTree brings that to learning. It ships with a **Backend developer
map for Java and Go**: 19 topics, 102 sections and 593 self-check questions, taken from a real interview mind map.

The source materials live in this repository too: the [`Java Interview.xmind`](Java%20Interview.xmind) mind map
and the [`SystemDesign.drawio`](SystemDesign.drawio) diagrams.

## Features

- **Reads like XMind.** Topics sit on one line from left to right (Java Core, Java Advanced, Go, SQL…),
  alternating up and down. Each topic grows a trunk of sections, and questions branch off every section.
- **Difficulty colors and important marks.** Question text is green, yellow, orange or purple by difficulty,
  and a red "!" marks the questions that need extra attention. Filter the map by difficulty or show only important ones.
- **Unlocking.** A section opens when all of its prerequisites are mastered. Sections move through
  *locked → available → learning → mastered*, with XP and levels from Intern to Architect.
- **Self-check questions.** Click the circle next to a question when you can answer it.
- **A mind map inside every section.** Double-click a section to dive in: its questions and subtopics open as a
  separate XMind-style map; answers open in the side panel.
- **Spaced review.** Flashcards from what you have learned. Forgotten cards come back more often,
  and sections you have not revisited for 21 days get a gold dot. A separate round for important questions only.
- **Ask Claude.** Any question opens a Claude chat with a ready prompt. On claude.ai the answer streams right into the card.
- **Edit like in XMind.** No separate edit mode, right on the map: Tab adds a child, Enter adds a sibling,
  F2 or just typing renames, Delete removes, Alt+arrows reorder, 1–4 set difficulty, `!` marks important,
  Ctrl+Z undoes. Right-click for a context menu, press `?` for all shortcuts.
- **Projects.** Separate maps with their own progress: System Design, a new language, a specific job offer.
- **Import and export.** Projects and progress as JSON. XMind mind maps convert into a draft project.
- **Zero dependencies.** Vanilla JS and SVG. The build produces one self-contained HTML file.

<table>
<tr>
<td width="60%"><img src="docs/images/skill.webp" alt="A section with its questions on the map and the question panel"></td>
<td width="40%"><img src="docs/images/review.webp" alt="Review flashcards"></td>
</tr>
<tr><td align="center">Sections and questions, colored by difficulty</td><td align="center">Review mode</td></tr>
</table>

## Quick start

Requires Node.js 18 or newer. Nothing to install.

```bash
git clone https://github.com/Denis-VR/Backend-Map.git
cd Backend-Map
node scripts/build.mjs       # bundles everything into dist/index.html
open dist/index.html         # or just double-click the file
```

The interface is in Russian for now; translations are welcome. Progress is stored in your browser's `localStorage`. Use the **⋯** menu to save progress to a file and move it to another device.

### Deploy your own copy

Fork the repo, then in **Settings → Pages** choose **GitHub Actions** as the source.
Every push to `main` validates the data and publishes the site.

## Build trees with Claude

The repository is also a [Claude Code](https://claude.com/claude-code) plugin with the
`gametree-trees` skill. It teaches Claude the data format and the rules for designing good trees.

```text
/plugin marketplace add Denis-VR/Backend-Map
/plugin install gametree@gametree
```

Then just ask: *"add a Kotlin topic after Java Advanced"*, *"make a System Design map"*,
*"write short answers for the Kafka questions"*. Claude edits the JSON, runs the validator and rebuilds the site.
Without the repository, Claude can produce a project JSON that you load through **⋯ → Import**.

## Your own maps

```text
data/projects.json                    order of projects in the menu
data/projects/<id>/project.json       title, start of the line, order of topics
data/projects/<id>/trees/<tree>.json  a topic: sections, prerequisites, questions
```

A section looks like this:

```json
{
  "id": "go.concurrency",
  "title": "Concurrency",
  "abbr": "Chan",
  "level": 2,
  "description": "Goroutines, buffered and unbuffered channels, select.",
  "requires": ["go.structures"],
  "questions": [
    "How does select work?",
    { "q": "What happens when you send to a closed channel?", "a": "panic", "level": 3, "important": true },
    { "topic": "sync", "items": ["What is a WaitGroup?", "Mutex vs RWMutex?"] }
  ]
}
```

`level` is the difficulty from 1 to 4 (the XMind colors green, yellow, orange, purple). A question without
its own `level` takes it from its subtopic, section or topic.

Layout is automatic, so you never write coordinates. The full format is in
[`skills/gametree-trees/SKILL.md`](skills/gametree-trees/SKILL.md).

```bash
node scripts/validate.mjs                                   # ids, references, cycles
python3 scripts/xmind_import.py map.xmind my-map "My map"   # XMind → project, colors become difficulty
```

## Project structure

```text
src/                     app: index.html, styles.css, app.js
scripts/build.mjs        bundles src + data into dist/index.html
scripts/validate.mjs     checks every project in data/projects
scripts/xmind_import.py  converts an XMind file into a draft project
skills/gametree-trees/   Claude skill: how to create and edit trees
.claude-plugin/          Claude Code plugin and marketplace manifests
```

## Contributing

New topics, better questions, fixes and ideas are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md)
to get started, and please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Credits

Inspired by game talent trees and by [SkillWaker](https://skillwaker.com/en) and
[SkillTree OSS](https://skilltreeoss.softexforge.io/). The seed backend map grew out of a personal Java interview mind map.

## License

[MIT](LICENSE) © 2025-2026 Denis Ryabchikov
