# Contributing to GameTree

Thanks for helping! Issues and pull requests in English or Russian are both fine.

## Ways to help

- **Content.** Add a branch, improve skill descriptions, add questions or short answers.
- **Fixes.** Prerequisites that are in the wrong order, typos, broken links.
- **App.** Bugs, accessibility, performance, translations of the interface.
- **Ideas.** Open an issue first for bigger changes so we can agree on the approach.

## Development

Node.js 18+ is all you need. There are no dependencies.

```bash
node scripts/validate.mjs   # check data: ids, references, cycles
node scripts/build.mjs      # build dist/index.html
```

Open `dist/index.html` in a browser to test. Code lives in `src/` (vanilla JS, SVG, CSS).

## Editing trees

The data format and design rules are in [`skills/gametree-trees/SKILL.md`](skills/gametree-trees/SKILL.md). The short version:

- A skill is a topic worth 1–10 hours of study. Small facts go into `questions`; group long lists into `{ "topic", "items" }`.
- Give each skill a short `abbr` label (2–4 characters). No emoji.
- Keep 1–3 `requires` per skill and link new branches to existing ones.
- **Never rename existing skill ids or reword existing questions**: user progress is keyed by them.
  If a question is wrong, add a fixed one and remove the old one in the same PR, and say so in the description.
- Do not add `pos` coordinates by hand; the layout is automatic.

You can also let Claude do the editing: the repo is a Claude Code plugin (see the README).

## Pull requests

1. Fork and create a branch from `main`.
2. Make the change and run `node scripts/validate.mjs` and `node scripts/build.mjs`.
3. For UI changes, attach a screenshot.
4. Open a PR using the template. CI validates and builds every PR.

By contributing you agree that your work is released under the [MIT License](LICENSE).
