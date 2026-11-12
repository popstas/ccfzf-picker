# Таймер кеша промпта — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** в строке сессии рядом с долей контекста показывать, сколько минут
осталось до истечения часового кеша промпта: серый, жёлтый меньше 30, красный
меньше 15.

**Architecture:** ccfzf в уже идущем обратном проходе `tail_facts` находит
метку последнего ответа ассистента и отдаёт её в записи агента полем
`cacheAt`. Пикер считает остаток от `nowSec` на каждой перерисовке и красит.
Две части, два репозитория, два исполнителя: Task 1 — исполнитель `ccfzf` в
`~/projects/shell/ccfzf`, Tasks 2–4 — head в `ccfzf-picker`, ветка
`feat/cache-timer`.

**Tech Stack:** Python 3 (ccfzf, тесты `tests/*.py`), ванильный JS + `node --test`
(пикер, `npm test`), Tauri 2.

**Spec:** `docs/superpowers/specs/2026-11-12-cache-timer-design.md`

## Global Constraints

- TTL — константа 3600 с, запас 5 с; пороги: жёлтый `< 30` мин, красный `< 15` мин (Стас).
- Работающая сессия (`agentState === 'active'`) и истёкший кеш — таймера нет.
- Метки нет — ключа `cacheAt` нет вовсе, не ноль (правило `from_tail`).
- ccfzf: в `main` не коммитить напрямую — `~/bin/ccfzf` симлинк на репо, `main` сразу едет в живой пикер; ветка + PR.
- ccfzf: `grep popstas ccfzf` пуст (репо публичное); никаких дополнительных открытий файлов на сессию (`--state` раз в секунду).
- `vendor/ccfzf` в пикере совпадает с ccfzf побайтово.
- Видимое человеку — по-английски, комментарии и названия тестов — по-русски (CLAUDE.md).
- Цвета только токенами `theme.css`; сырые цвета в `<style>` запрещены `test/theme.test.js`.

## Review Focus

- Часы машин расходятся: `cacheAt` с чужой машины новее `nowSec` → остаток не больше 60 мин, не `61m` (тест в Task 3).
- Сессия ждёт разрешения / вопроса (`question`, `attention`, `review`) — таймер идёт: кеш остывает и пока человек думает (тест в Task 3).
- Мемо фактов (`test_facts_cache.py`): сессия, чьи факты взяты из кеша, не теряет `cacheAt` (тест в Task 1).
- Последний ответ ассистента — ошибка API или без кеш-токенов, а до него нормальный ответ: берётся нормальный (тест в Task 1).
- Последняя минута показывается `1m`, а не `0m` (тест в Task 3).

---

### Task 1 (исполнитель ccfzf): `cacheAt` в записи агента

**Files:**
- Modify: `ccfzf` — `tail_facts` / внутренний `pick` (~1117–1275), мемо фактов (то, что даёт `f.get("agentState")` в `--state`, ~3497), `agent_of` и `from_tail` (~622–770)
- Test: `tests/test_cache_at.py` (новый), `tests/test_facts_cache.py`

**Interfaces:**
- Produces: в словаре агента, который `tail_facts` уже возвращает шестым элементом (`{"state", "question"}`), — ключ `"cacheAt": int` (epoch-секунды), только если метка найдена. Кортеж `tail_facts` не растёт — существующие распаковки не трогаются.
- Produces: `agent_of(...)["cacheAt"]` и `from_tail(...)["cacheAt"]` — то же число, в обеих дорогах (хуковая запись и запись из хвоста). Нет метки — ключа нет.

- [ ] **Step 1: падающие тесты `tests/test_cache_at.py`** (по образцу `test_turn_from_transcript.py`, транскрипт во временном файле):
  - `test_метка_последнего_ответа_с_кешем`: user → assistant (`usage.cache_read_input_tokens: 100`, timestamp T) → `agent["cacheAt"] == int(T)`.
  - `test_ошибка_api_и_ответ_без_кеша_пропускаются`: assistant T1 с кешем, затем assistant T2 `isApiErrorMessage: true`, затем assistant T3 с `usage` и нулями в обоих cache-полях → `cacheAt == int(T1)`.
  - `test_ответ_без_usage_засчитывается`: assistant без `message.usage` → его метка.
  - `test_сайдчейн_не_считается`: последний assistant с `isSidechain: true` → метка предыдущего основного.
  - `test_нет_ответа_нет_ключа`: только реплика человека → `"cacheAt" not in agent`.
  - `test_обе_дороги`: `agent_of` с `state.json` в `STATUS_DIR` и без него (`from_tail`) — оба отдают `cacheAt`.
- [ ] **Step 2:** `python3 -m pytest tests/test_cache_at.py -v` (или как гоняются тесты репо) → FAIL.
- [ ] **Step 3:** в `pick` — переменная `cache_at`, заполняется первой (обратный проход) записью `type == "assistant"`, не `isSidechain`, не `isApiErrorMessage`, с `usage` отсутствующим или с `cache_read + cache_creation > 0`, через `stamp_of`. Условие выхода из цикла `doing and turn_at` дополнить так, чтобы проход не дочитывался до конца ради метки: метка ищется только в уже читаемом хвосте; не нашлась в `TAIL` — ключа нет (второго чтения нет). В словарь агента — `"cacheAt": int(cache_at)` при `cache_at`. Мемо фактов несёт поле дальше, `agent_of`/`from_tail` кладут его в запись.
- [ ] **Step 4:** тест в `test_facts_cache.py`: второй вызов `--state` с фактами из мемо отдаёт тот же `cacheAt`. Прогнать весь набор тестов репо → PASS.
- [ ] **Step 5:** попутно починить `ValueError` интерактивного `sessions` (распаковка `tail_facts` в двух значениях, из docs/TODO.md исполнителя) — отдельным коммитом, с тестом.
- [ ] **Step 6:** ветка, коммиты, PR; `grep popstas ccfzf` пуст. Итог head-у: ветка, sha, PR, вывод тестов, пример `--state` с `cacheAt` у живой сессии.

### Task 2 (head): сабмодуль и поле строки

**Files:**
- Modify: `vendor/ccfzf` (на коммит Task 1), `frontend-src/session-list.js:~307`
- Test: `test/session-list.test.js`

**Interfaces:**
- Consumes: `agent.cacheAt` из Task 1.
- Produces: поле строки `agentCacheAt: number` (0 — «не знаем»).

- [ ] **Step 1:** тест: `buildSessionList` переносит `agent.cacheAt` в `agentCacheAt`; без ключа — `0`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** `agentCacheAt: (agent || {}).cacheAt || 0`. Сабмодуль поднять на коммит Task 1.
- [ ] **Step 4:** `npm test` → PASS. Commit.

### Task 3 (head): отрисовка, галка, серый значок терминала

**Files:**
- Modify: `frontend-src/session-glyph.js` (рядом с `contextLevel`, ~352; `usageHtml`, ~375; экспорт ~894), `sessions.html` (CSS `.win` ~458 и `.usage` ~501; `TOGGLE_CHECKS` ~997; умолчания ~1047; вызов ~1654), `settings.html` (`TOGGLE_LABELS`, `UI_DEFAULTS`, `COLUMN_ICONS`), `frontend-src/session-info.js`
- Test: `test/session-glyph.test.js`, `test/session-info.test.js`, `test/row-contract.test.js`, `test/settings-page.test.js`

**Interfaces:**
- Produces в `SessionGlyph`:
  - `CACHE_TTL_SEC = 3600`, `CACHE_SAFETY_SEC = 5`, `CACHE_WARN_SEC = 1800`, `CACHE_HOT_SEC = 900`
  - `cacheRemainingSec(session, nowSec) -> number | null` — `null` при `!agentCacheAt`, `agentState === 'active'` или остатке `<= 0`; остаток не больше `CACHE_TTL_SEC - CACHE_SAFETY_SEC`.
  - `cacheLevel(remainingSec) -> '' | 'warn' | 'hot'` — `hot` при `< 900`, `warn` при `< 1800`.
  - `cacheText(remainingSec) -> string` — `${Math.ceil(sec / 60)}m`.
  - `usageHtml(session, { showCost = true, showContext = true, showCache = true } = {}, nowSec = Date.now() / 1000)`.

- [ ] **Step 1:** тесты в `session-glyph.test.js`:
  - `cacheRemainingSec({agentCacheAt: 1000}, 1000 + 600) === 3600 - 5 - 600`.
  - активная — `null`; `agentState: 'question'` и `'review'` — число; истёкший (`now - at >= 3595`) — `null`; `agentCacheAt` больше `now` на 120 — `3595`.
  - `cacheLevel(1801) === ''`, `cacheLevel(1799) === 'warn'`, `cacheLevel(899) === 'hot'`.
  - `cacheText(3595) === '60m'`, `cacheText(30) === '1m'`.
  - `buildSessionInfoRows` с `agentCacheAt` в пределах часа даёт строку `cache` с текстом `cacheText`; без — строки нет.
  - `usageHtml({agentContextPct: 13, agentCostUsd: 2, agentCacheAt: 1000}, {}, 1000 + 2000)` содержит `<span class="cache warn">27m</span>` после `ctx`, через ` · `; `{showCost:false, showContext:false, showCache:false}` → `''`; без `agentCacheAt` — разметка как сейчас (старые тесты не меняются).
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** реализовать функции; в карточке строка `['cache', …]` после `context`; в `sessions.html` вызов `usageHtml(session, toggles, nowSec)`; галка `{ key: 'showCache', label: 'cache', side: 'right' }` после `showContext`; умолчание `showCache: { list: true, statusline: false }` в обеих страницах; `TOGGLE_LABELS.showCache = 'cache'`; `COLUMN_ICONS.showCache = '⏱︎'` (U+23F1 U+FE0E); CSS `.usage .cache.warn { color: var(--warn); }`, `.usage .cache.hot { color: var(--danger); }`, у `.win` `color: var(--fg-dim)` и комментарий над ним переписать (зелень снята: решение Стаса, значок выделялся без смысла).
- [ ] **Step 4:** `npm test` → PASS (парность галок двух окон и `theme.test.js` в том числе). Commit.

### Task 4 (head): выкатка и живая проверка

- [ ] Пуш `feat/cache-timer`, затем параллельно в фоне `BRANCH=feat/cache-timer ./data/scripts/deploy-win.sh` и `BRANCH=feat/cache-timer ./data/scripts/deploy-mac.sh`; в выводе обоих — `== готово`.
- [ ] Живая проверка: у простаивающей сессии `NNm` справа от `%`, у работающей пусто; у сессии старше часа пусто; значок терминала серый; галка `cache` в `^K`/настройках включает и выключает колонку.
- [ ] PR в ccfzf-picker; в `docs/rules/list-rows.md` — правило про таймер (что считается, почему работающая и холодная пусты), счёт в указателе CLAUDE.md.
