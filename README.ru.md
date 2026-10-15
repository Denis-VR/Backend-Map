<div align="center">

# ◆ GameTree

**Дерево навыков в стиле игровой прокачки для того, что ты изучаешь.**
Одна большая карта: осваиваешь навык, открываются следующие, а изученное можно повторить.

[![Deploy](https://github.com/Denis-VR/game-tree/actions/workflows/pages.yml/badge.svg)](https://github.com/Denis-VR/game-tree/actions/workflows/pages.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-f2c46d.svg)](LICENSE)
![No dependencies](https://img.shields.io/badge/dependencies-0-57ab5a.svg)

[**Демо**](https://denis-vr.github.io/game-tree/) · [English](README.md) · [Формат данных](skills/gametree-trees/SKILL.md) · [Как помочь проекту](CONTRIBUTING.md)

<img src="docs/images/map.webp" alt="GameTree: глобальная карта навыков бэкенд-разработчика" width="100%">

</div>

## Что умеет

- **Одна большая карта.** Все ветки лежат на общем звёздном круге и связаны между собой:
  Spring Core требует Java ООП, Go и базы данных требуют SQL. Чем дальше от центра, тем продвинутее тема.
- **Прокачка.** Навык открывается, когда освоены все его требования. Состояния: закрыт, доступен,
  изучаю, освоен. Опыт и уровни от «Стажёра» до «Архитектора».
- **Вопросы для самопроверки** у каждого навыка. Отметка «знаю» даёт опыт.
- **Повторение.** Карточки по изученным темам, забытое попадается чаще. Через 21 день навык получает значок ⟳.
- **Спросить Claude.** Вопрос открывается в чате Claude с готовым промптом, на claude.ai ответ приходит прямо в карточку.
- **Редактор.** Правка навыков, вопросов и связей, перетаскивание узлов, Shift + клик связывает навыки.
- **Проекты.** Отдельные карты со своим прогрессом: System Design, новый язык, подготовка к вакансии.
- **Импорт и экспорт** проектов и прогресса в JSON, черновик проекта из XMind.
- **Без зависимостей.** Чистый JS и SVG, сборка даёт один HTML-файл.

В комплекте карта **Backend-разработчик (Java и Go)**: 10 веток, 97 навыков и 645 вопросов.

## Запуск

Нужен Node.js 18+, больше ничего ставить не надо.

```bash
git clone https://github.com/Denis-VR/game-tree.git
cd game-tree
node scripts/build.mjs       # сборка в dist/index.html
open dist/index.html
```

Прогресс хранится в браузере. Через меню **⋯** его можно сохранить в файл и перенести на другое устройство.
Чтобы опубликовать свою копию, сделай форк и выбери в **Settings → Pages** источник **GitHub Actions**.

## Деревья с помощью Claude

Репозиторий одновременно плагин для [Claude Code](https://claude.com/claude-code) со skill `gametree-trees`:

```text
/plugin marketplace add Denis-VR/game-tree
/plugin install gametree@gametree
```

Дальше достаточно попросить: «добавь ветку Kotlin после Java», «сделай карту по System Design»,
«добавь ответы к вопросам по Kafka». Claude правит JSON, проверяет данные и пересобирает сайт.

## Свои карты

```text
data/projects.json                    порядок проектов в меню
data/projects/<id>/project.json       проект: название, центр, порядок веток
data/projects/<id>/trees/<tree>.json  ветка: навыки, требования, вопросы
```

Раскладка на карте автоматическая. Формат описан в [`skills/gametree-trees/SKILL.md`](skills/gametree-trees/SKILL.md).

```bash
node scripts/validate.mjs                                    # id, ссылки, циклы
python3 scripts/xmind_import.py map.xmind my-map "Моя карта" # XMind → черновик проекта
```

## Лицензия

[MIT](LICENSE) © 2026 Denis Ryabchikov
