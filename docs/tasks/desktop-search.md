# Настройка «искать в Claude Desktop» — дизайн и план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Дизайн (утверждён Стасом 22.11)

**Зачем.** Сессии Claude Desktop засоряют выдачу поиска и `/h` («они мешают
мне»). В обычном списке их при этом можно оставить.

**Как сейчас.** Галка `claude desktop` (`showDesktop`, отсев `hideDesktop`)
прячет их из списка, но по правилу «спрошенное перебивает отобранное»
(`activeFilters` в `frontend-src/session-groups.js`, `docs/rules/filtering.md`)
непустой запрос и любой префикс режима снимают её вместе с `onlyLive` и
`onlyWindow`.

**Подходы.**
- A. Выключенная галка `claude desktop` прячет Desktop и при поиске. Новой
  настройки нет, но галка списка тогда решает и за поиск.
- **B — выбран Стасом.** Отдельный ключ `searchDesktop` в `config.yaml` и
  галка в окне настроек. Галка списка остаётся как есть, две настройки
  независимы: можно видеть Desktop в списке и не видеть в поиске.

**Решено.**
- Ключ `searchDesktop`, верхнего уровня, умолчание `true`: сегодняшнее
  поведение не меняется ни у кого, кто ключ не трогал.
- Галка `Search Claude Desktop sessions` в окне настроек, в одной секции с
  `Only running sessions`.
- Когда «спрошено» (непустой запрос или префикс режима), Desktop прячет
  `searchDesktop: false`. Галка списка при этом не участвует. Без поиска решает
  галка списка, как и раньше.
- Правило «спрошенное перебивает отобранное» для `onlyLive`/`onlyWindow` не
  трогать.

**Не делаем.** Подсказку «N скрыто» на пустой выдаче: скрытие человек включил
сам.

---

## План

**Goal:** ключ `searchDesktop: false` убирает сессии Claude Desktop из поиска и
режимов, не меняя обычный список.

**Architecture:** новое поле в `config-shape.js` и поле формы в
`settings-form.js`; в `activeFilters` ветка «спрошено» берёт `hideDesktop` из
`searchDesktop`; `regroup()` в `sessions.html` подаёт `CONFIG.searchDesktop`.
Rust ключа не знает и не узнаёт: `onlyLive` в `src-tauri/` тоже не читается.

**Tech Stack:** ванильный JS, `node --test` через `npm test`.

**Spec:** раздел «Дизайн» выше.

## Global Constraints

- Видимая строка — по-английски: `Search Claude Desktop sessions`. Комментарии,
  названия тестов и сообщения `assert` — по-русски (CLAUDE.md, «Язык»).
- Умолчание `searchDesktop` — `true`; значение не-boolean считается `true`.
- Тесты гонять только `npm test` (`node --test test/` на этих версиях Node не
  работает).

## Review Focus

- `searchDesktop: false` и префикс `/h` с пустым запросом: Desktop пропадает и
  из истории — именно об этом просили (тест в Task 2).
- `searchDesktop: false` и `showDesktop: true` без запроса: в списке Desktop
  виден (тест в Task 2).
- `searchDesktop: true` (или ключа нет) и `showDesktop: false` с запросом:
  поиск показывает Desktop, как сегодня (тест в Task 2).
- `searchDesktop: 'нет'` в `config.yaml`: считается `true`, а не `false` (тест в
  Task 1).
- Зелийные строки при `searchDesktop: false` не пропадают: отсев стоит до
  подмешивания zellij, и это уже держит тест «отсев hideDesktop зелийных строк
  не касается» — менять его не надо.

---

### Task 1: ключ `searchDesktop` и галка в окне настроек

**Files:**
- Modify: `frontend-src/config-shape.js` — `DEFAULTS` рядом с `onlyLive`
  (около строки 58) и `normalizeConfig` рядом с `onlyLive` (около 409).
- Modify: `frontend-src/settings-form.js` — поле после `onlyLive` (около 159).
- Test: `test/config-shape.test.js`, `test/settings-form.test.js`.

**Interfaces:**
- Produces: `normalizeConfig(src).searchDesktop: boolean` (умолчание `true`);
  поле формы `{ id: 'searchDesktop', label: 'Search Claude Desktop sessions',
  type: 'bool', default: true, hint: 'Off: searching and modes like /h skip
  Claude Desktop sessions; the list itself follows the "claude desktop" toggle.' }`.

- [ ] **Step 1: failing tests.** В `test/config-shape.test.js` добавить
  `'searchDesktop'` в массив цикла теста «поля с умолчанием true выключаются
  только явным false» (`['onlyLive', 'hideOnBlur', 'searchDesktop']`) и в тест
  умолчаний (около строки 23) — `assert.strictEqual(c.searchDesktop, true)`. В
  `test/settings-form.test.js` добавить `'searchDesktop'` в массив цикла около
  строки 56 (`['onlyLive', 'hideOnBlur', 'backgroundRefresh', 'searchDesktop']`).
- [ ] **Step 2:** `npm test` — новые проверки падают (`undefined !== true`).
- [ ] **Step 3:** в `DEFAULTS` — `searchDesktop: true` с комментарием «почему»
  (Стас 22.11: Desktop мешает в history; умолчание — сегодняшнее поведение);
  в `normalizeConfig` — `searchDesktop: typeof src.searchDesktop === 'boolean'
  ? src.searchDesktop : DEFAULTS.searchDesktop`; поле формы из Interfaces.
- [ ] **Step 4:** `npm test` — всё зелёное. Если падает сторож парности
  полей формы и `DEFAULTS` (или подписей) — дописать то, чего он просит, а не
  ослаблять его.
- [ ] **Step 5: commit** `feat: настройка searchDesktop в config.yaml и окне настроек`.

### Task 2: `searchDesktop` решает за поиск и режимы

**Files:**
- Modify: `frontend-src/session-groups.js` — `activeFilters` (около 460-470) и
  его doc-комментарий.
- Modify: `sessions.html` — `regroup()` (около 2147-2158).
- Modify: `docs/rules/filtering.md` — абзац к правилу про `showDesktop`.
- Test: `test/session-groups.test.js` (раздел `activeFilters`, около 881),
  `test/row-contract.test.js` (`regroupWith`, около 1405).

**Interfaces:**
- Consumes: `CONFIG.searchDesktop` из Task 1.
- Produces: `activeFilters({ mode, query, onlyLive, onlyWindow, hideDesktop,
  searchDesktop })` → `{ onlyLive, onlyWindow, hideDesktop }`. Форма ответа не
  меняется. При «спрошено» `hideDesktop === (opts.searchDesktop === false)`;
  иначе `!!opts.hideDesktop`. `searchDesktop` не задан — как `true`.

- [ ] **Step 1: failing tests** в `test/session-groups.test.js`:
  - «searchDesktop: false прячет Desktop при запросе, даже если галка списка
    его показывает»: `activeFilters({ query: 'x', hideDesktop: false,
    searchDesktop: false }).hideDesktop === true`;
  - «searchDesktop: false прячет Desktop и в /h»: `activeFilters({ mode: 'history',
    query: '', searchDesktop: false }).hideDesktop === true`;
  - «без запроса searchDesktop не участвует»: `activeFilters({ query: '',
    hideDesktop: false, searchDesktop: false }).hideDesktop === false`;
  - «searchDesktop по умолчанию — поиск показывает Desktop»:
    `activeFilters({ query: 'x', hideDesktop: true }).hideDesktop === false`.
  - Существующие ожидания около 898-928 не трогать: при незаданном
    `searchDesktop` они верны как есть.
  - В `test/row-contract.test.js` расширить `regroupWith`: `CONFIG` получает
    `searchDesktop` (параметр), и новый тест — «regroup подаёт
    CONFIG.searchDesktop: при запросе и searchDesktop: false уезжает
    hideDesktop: true».
- [ ] **Step 2:** `npm test` — новые тесты падают.
- [ ] **Step 3:** в `activeFilters` — ветка `hideDesktop` по Interfaces; в
  doc-комментарии одной фразой: `searchDesktop` — исключение из правила для
  одного отсева, и почему (Стас 22.11, решение B). В `regroup()` — передать
  `searchDesktop: CONFIG.searchDesktop` рядом с `hideDesktop`.
- [ ] **Step 4:** `npm test` — всё зелёное.
- [ ] **Step 5:** `docs/rules/filtering.md` — абзац после правила про
  `showDesktop`: что делает `searchDesktop`, почему отдельный ключ, а не галка
  списка (решение B), что правило для `onlyLive`/`onlyWindow` прежнее. Правило
  внутри существующего пункта — счёт в указателе CLAUDE.md не меняется.
- [ ] **Step 6: commit** `feat: searchDesktop прячет Claude Desktop в поиске и режимах`.

### Task 3: выкатка и живая проверка

Мак `mac.popstas.pro` недоступен — пропущен (решение Стаса 14.11). popstas-pc не
трогать.

- [ ] **Step 1:** запушить ветку; `BRANCH=<ветка> ./data/scripts/deploy-win.sh`
  в фоне. Если на nb сейчас выкачена чужая ветка под ревью — собрать сборную
  `deploy/<a>-<b>` (память «Выкатка ветки снимает чужую»).
- [ ] **Step 2:** проверить, что выкатка поднялась: `tasklist` на nb, штамп
  сборки в трее — новый (скрипт может сказать «готово» и соврать).
- [ ] **Step 3: живьём на nb.** Settings → снять `Search Claude Desktop
  sessions` → Save. В пикере: `/h` — строк с глифом `c` нет; запрос по слову из
  имени Desktop-сессии — её нет; пустой запрос с включённой галкой `claude
  desktop` — Desktop в списке есть. Вернуть галку — в поиске Desktop снова
  есть. В `config.yaml` после Save — `searchDesktop: false`.
- [ ] **Step 4:** в PR — что проверено живьём и что не проверено (мак).
