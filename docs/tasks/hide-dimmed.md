# Галка «hide dimmed» — дизайн и план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Дизайн (утверждён Стасом 22.11)

**Зачем.** Быстрый переключатель, который убирает из списка всё затемнённое,
чтобы не дочитывать до живого. Галка `dim stale` уже есть, но она гасит, а не
прячет.

**Подходы.**
- Клавиша для `dimStale` в окне — отвергнуто: просили прятать, а не гасить
  (Стас 22.11).
- **Фильтр `hideStale` рядом с `showAll`/`onlyWindow` — выбран.**

**Решено.**
- Спрятана ⇔ погашена, без исключений (Стас 22.11). Предикат тот же —
  `StaleItems.isStale` с доводом `SessionWindows.minimizedHere`. Прячутся все
  три повода: возраст, свёрнутое окно этой машины, `/compact` без продолжения.
  Работающую после сжатия `isStale` не гасит — она и не прячется.
- При выключенной `dim stale` прятать нечего: ничего не погашено.
- Сессии и проекты — оба.
- Галка в статуслайне, подпись `hide dimmed`, умолчание
  `{ list: false, statusline: true }`.
- Как прочие фильтры, снимается непустым запросом и префиксом режима
  (`activeFilters`).
- Клавиши нет, ключа в `config.yaml` нет. `dimProject` (гашение по наведению)
  не трогать.

**Строка гаснет со временем, а пересчёт — по событию.** `regroup()` зовёт
обработчик ответа агрегатора, а ответ без изменений отсекается по отпечатку
(`--if-changed`, комментарий у обработчика галок в `sessions.html`), и
периодической перерисовки у страницы нет. Значит, строка, перешедшая порог
возраста в тишине, прячется на следующем изменившемся ответе — ровно тогда,
когда сегодня и гаснет: у затемнения та же задержка. «Спрятана ⇔ погашена»
этим не нарушается, и отдельного таймера не заводим (решение head; если
задержка начнёт мешать — таймер нужен обоим сразу). Образец «погашенное не
берём» уже есть — `placeIds` в `frontend-src/session-windows.js`.

**Щелчок `dim stale` обязан пересчитывать состав.** Сегодня у неё `side:
'dim'`, и обработчик зовёт только `render()` (комментарий у `TOGGLE_CHECKS`:
затемнение состав списка не меняет). При включённой `hide dimmed` меняет:
выключил затемнение — спрятанные обязаны вернуться сразу, а не на следующем
ответе.

---

## План

**Goal:** галка `hide dimmed` в статуслайне убирает из списка сессии и проекты,
которые сейчас погашены.

**Architecture:** чистый помощник `StaleItems.hidden(...)` решает за строку;
`activeFilters` получает четвёртый отсев `hideStale`; `buildSessionsPayload`
применяет его к сессиям через предикат из опций, `sectionsFor` — к проектам.
`projectRows` сам не фильтруется: его читают хоткеи проектов, `/p` и справочник
клавиш, и спрятанный проект там обязан остаться.

**Tech Stack:** ванильный JS, `node --test` через `npm test`.

**Spec:** раздел «Дизайн» выше.

## Global Constraints

- Подпись по-английски: `hide dimmed`. Комментарии, тесты, `assert` — по-русски.
- Набор галок в `sessions.html` и `settings.html` парный — сторожа в
  `test/row-contract.test.js` и `test/settings-page.test.js`. Иконка у галки
  уникальная.
- Тесты — только `npm test`.

## Review Focus

- `dim stale` выключена, `hide dimmed` включена: ни одна строка не пропадает
  (тест в Task 1).
- Запрос или `/h` при включённой `hide dimmed`: погашенные видны (тест в
  Task 1).
- Проект со спрятанной строкой: его хоткей и `/p <проект>` по-прежнему
  работают — `projectRows` не фильтруется (тест в Task 2).
- Все строки секции спрятаны: секция показывает свою пустую панель, а не
  падает (живая проверка в Task 3).
- Зелийные строки и снимки не прячутся никогда: `isStale` на их вид отвечает
  `false` (тест в Task 1).

---

### Task 1: отсев сессий

**Files:**
- Modify: `frontend-src/stale-items.js` — новый `hidden`.
- Modify: `frontend-src/session-groups.js` — `activeFilters`, `buildSessionsPayload`.
- Modify: `sessions.html` — `TOGGLE_CHECKS` (около 1081-1092), `uiToggles`
  (около 1105-1160), `regroup()` (около 2138-2170).
- Modify: `settings.html` — `TOGGLE_LABELS` (около 136-142), умолчания осей
  (около 177-184), `COLUMN_ICONS` (около 486), `COLUMN_HINTS` (около 518).
- Test: `test/stale-items.test.js` (или где сейчас тесты `isStale`),
  `test/session-groups.test.js`, `test/row-contract.test.js`.

**Interfaces:**
- Produces: `StaleItems.hidden(row, nowSec, stale, kind, minimized) → boolean`
  — то же, что `isStale`; отдельное имя ради читателя отсева, тело — вызов
  `isStale`. (Если реализатор сочтёт имя лишним — звать `isStale` прямо;
  решать по тому, читается ли отсев.)
- Produces: `activeFilters(opts)` → `{ onlyLive, onlyWindow, hideDesktop,
  hideStale }`; `hideStale: asked ? false : !!opts.hideStale`. Если к этому
  времени влита задача `docs/tasks/desktop-search.md` — её ветка `hideDesktop`
  остаётся как есть.
- Produces: `buildSessionsPayload(res, sort, { ..., hideStale, isDimmed })`,
  где `isDimmed: (row) => boolean`. Отсев `rows.filter(r => !isDimmed(r))` при
  `hideStale && typeof isDimmed === 'function'`, сразу после отсева
  `hideDesktop`, до подмешивания zellij.
- Produces: ключ галки `hideStale`, `side: 'filter'`, подпись `hide dimmed`,
  умолчание `{ list: false, statusline: true }`.

- [ ] **Step 1: failing tests** в `test/session-groups.test.js`:
  - «hideStale убирает погашенные сессии, и только их»: две сессии, предикат
    `isDimmed: r => r.id === 'old'` → в группах только `new`;
  - «hideStale без предиката ничего не убирает»;
  - «запрос и префикс снимают hideStale»: дописать `hideStale: true` во входы
    и `hideStale: false` в ожидания существующих тестов `activeFilters`
    (около 881-928) — форма ответа теперь из четырёх полей;
  - «без запроса hideStale держится»: `activeFilters({ query: '', hideStale:
    true }).hideStale === true`.
  - В `test/row-contract.test.js` — `regroupWith` с `toggles.hideStale: true` и
    `CONFIG.stale.enabled`/порогом: уехавший `isDimmed` на погашенной строке
    отвечает `true`, на свежей — `false`; при `toggles.dimStale: false` —
    `false` на обеих.
  - В `test/row-contract.test.js` — «щелчок dim stale при включённой hide
    dimmed пересчитывает состав»: вычитать обработчик галок (около 1380-1392
    `sessions.html`) тем же приёмом, что `regroupWith`, и проверить, что на
    `dimStale` при `toggles.hideStale === true` зовётся `regroup`, а при
    `false` — только `render`.
- [ ] **Step 2:** `npm test` — новые тесты падают.
- [ ] **Step 3:** реализовать по Interfaces. В `regroup()` — `hideStale:
  toggles.hideStale` в `activeFilters` и `isDimmed: row =>
  window.StaleItems.isStale(row, nowSec, staleSettings(), 'session',
  window.SessionWindows.minimizedHere(row, null, CONFIG.windowHost))` в опции
  `buildSessionsPayload` — те же доводы, что у `staleClass` в отрисовке строки
  (около 1669-1679); `nowSec` взять тем же способом, каким его берёт
  отрисовка. Галка в `TOGGLE_CHECKS` — в группу `filter`, после `showDesktop`;
  умолчание — с комментарием «почему» (Стас 22.11, прятать ⇔ гасить). Пара в
  `settings.html`: подпись, умолчание, иконка (уникальная, например `⊘`),
  подсказка `Hides what "dim stale" dims: old, minimized here, compacted and
  not resumed.` В обработчике галок — `if (isFilter || (key === 'dimStale' &&
  toggles.hideStale)) regroup();`, и поправить комментарий у `TOGGLE_CHECKS`
  про группу `dim`: при `hide dimmed` затемнение состав меняет.
- [ ] **Step 4:** `npm test` — всё зелёное; сторожа парности и статуслайна не
  ослаблять, а дописывать.
- [ ] **Step 5: commit** `feat: галка hide dimmed прячет погашенные сессии`.

### Task 2: отсев проектов

**Files:**
- Modify: `sessions.html` — `sectionsFor` (около 1880).
- Test: `test/row-contract.test.js` (или тест, который уже вычитывает
  `sectionsFor`; если такого нет — вычитать тем же приёмом, что `regroupWith`).

**Interfaces:**
- Consumes: `activeFilters` с `hideStale` (Task 1).
- В `sectionsFor(mode, query)`: `projects` — `projectRows` без строк, для
  которых `isStale(project, nowSec, staleSettings(), 'project')`, когда
  `activeFilters({ mode, query, hideStale: toggles.hideStale }).hideStale`.
  Глобальный `projectRows` не менять.

- [ ] **Step 1: failing test** «hide dimmed прячет погашенный проект только в
  секциях»: в `sectionsFor` уезжает список без старого проекта; `projectRows`
  после вызова — прежней длины.
- [ ] **Step 2:** `npm test` — падает.
- [ ] **Step 3:** реализовать по Interfaces.
- [ ] **Step 4:** `npm test` — зелёное.
- [ ] **Step 5:** `docs/rules/filtering.md` — пункт про `hideStale`: прятать ⇔
  гасить, почему без исключений (Стас 22.11), почему `projectRows` не
  фильтруется. Счёт правил в указателе CLAUDE.md (`Фильтры и режимы`, 7) —
  увеличить на один, и в колонке «О чём» дописать `hideStale`.
- [ ] **Step 6: commit** `feat: hide dimmed прячет и погашенные проекты`.

### Task 3: выкатка и живая проверка

Мак недоступен — пропущен (решение Стаса 14.11). Цели и исключённые машины —
в `data/scripts/` и в скилле claude-wt.

- [ ] **Step 1:** запушить ветку; `BRANCH=<ветка> ./data/scripts/deploy-win.sh`
  в фоне. Чужая ветка под ревью на Windows-цели — сборная `deploy/<a>-<b>`.
- [ ] **Step 2:** `tasklist` на Windows-цели и штамп сборки в трее — новый.
- [ ] **Step 3: живьём на Windows-цели.** В статуслайне щёлкнуть `hide dimmed`: тусклые
  сессии и проекты пропали, яркие на месте. Свернуть окно живой сессии — её
  строка пропадает на следующем опросе; развернуть — возвращается. Набрать
  запрос — погашенные снова видны. Снять `dim stale` — при включённой `hide
  dimmed` всё на месте. Перезапустить пикер — галка помнится (`ui.json`).
  Спрятать всё в секции — пустая панель, не поломка.
- [ ] **Step 4:** в PR — что проверено живьём и что нет (мак).
