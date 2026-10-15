# GameTree

Статический сайт с глобальным деревом навыков. Без зависимостей: Node 18+ и Python 3 для импорта XMind.

- Данные карт: `data/projects/<id>/project.json` и `data/projects/<id>/trees/*.json`.
- Перед любой правкой деревьев прочитай `skills/gametree-trees/SKILL.md`: там формат и правила.
- После правок: `node scripts/validate.mjs`, затем `node scripts/build.mjs` (обновляет `dist/`).
- Код приложения: `src/app.js`, `src/styles.css`, `src/index.html`. Собирается в один файл `dist/index.html`.
- Не меняй `id` существующих навыков: по ним хранится прогресс.
