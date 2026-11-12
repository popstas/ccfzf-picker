# Хоткей раскладки группы head — план работ (часть пикера)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Ctrl+Win+F10` в пикере просит менеджер разложить группу «head + живые дети» (`claude-place` с `mode: "group"`). Старая плитка остаётся без клавиши, но с кнопкой, MQTT и CLI. Обе клавиши настраиваются в окне настроек.

**Architecture:** группы считает Rust (`place_order::group_ids`) по свежему ответу агрегатора, как `tile_ids` для плитки: при нажатии страница может спать. Подсвеченную строку страница сообщает Rust сама, при каждой смене выбора. Rust берёт её, только если окно было показано в момент нажатия. Тело просьбы собирает отдельная функция рядом с `place_payload`. Транспорт тот же: `transport_for` → http или MQTT.

**Tech Stack:** Rust + Tauri 2 (`src-tauri`, `cargo test`), фронтенд на UMD-модулях + `node --test` (`npm test`).

**Spec:** соседний репозиторий windows11-manager, `docs/superpowers/specs/2026-11-11-claude-wt-head-zones-design.md`. Разделы пикера: «Раскладка группы по хоткею» (сторона пикера), «Хоткеи в пикере», «Мак». Все «почему» там.

## Global Constraints

- **Контракт с windows11-manager держать дословно.** Тело: `{"mode":"group","groups":[[headId, childId...], ...],"selected": id|null}`. Путь тот же, что у плитки: топик `<база>/claude-place`, http `/claude-wt/place`. `selected` есть всегда, `null` пишется явно.
- В каждой группе первый id — head, дальше его **прямые** живые дети на этой машине, в порядке пикера. Head без живых детей группой не считается.
- Групп нет — ничего не слать, причину писать в журнал (`ccfzf_log!`).
- Пустой `ids` для плитки по-прежнему не шлётся никогда.
- `groupTileHotkey`: умолчание `Ctrl+Win+F10` (`Control+Super+F10`) только не на маке. На маке умолчания нет.
- `tileHotkey`: не на маке умолчание — «без клавиши». На маке умолчание `Control+Alt+Super+C` без изменений.
- Значение `none` (без учёта регистра и пробелов) выключает клавишу на любой системе. Пусто или ключа нет — встроенное умолчание, как сейчас.
- Совпали `tileHotkey` и `groupTileHotkey` (сравниваются разобранные `Shortcut`, не строки) — клавишу получает `groupTileHotkey`. `tileHotkey` не регистрируется, в журнал уходит предупреждение.
- На macOS нажатие раскладки группы ничего не шлёт и пишет в журнал `group layout is not supported on macOS`.
- Всё, что видит человек, — по-английски. Комментарии, названия тестов и `assert` — по-русски.
- Имён машин в репозиторий не класть: `test/no-private-data.test.js`. В фикстурах — `pc`, `other`.
- `;` в удалённых командах не ставить (здесь удалённых команд нет, но правило общее).
- Ветка `feat/group-tile-hotkey`. Перед сменой ветки проверить `git status`: рабочий каталог делят несколько сессий.
- Выкатка: **сперва менеджер с `mode: group`, потом пикер.** Старый менеджер незнакомый `mode` отбрасывает, и `Ctrl+Win+F10` выглядел бы мёртвым. Скрипты: `BRANCH=feat/group-tile-hotkey ./data/scripts/deploy-win.sh` и `deploy-mac.sh`, параллельно, в фоне, после пуша. Успех — по строке `== готово`, а не по коду выхода.

## Решения, которых в спеке нет (приняты здесь)

1. **Тусклые строки в группе остаются.** Отсев `dim stale` к группам не применяется: head, молчавший два часа, иначе пропал бы из своей же группы. Свёрнутые окна менеджер пропускает сам.
2. **Родитель ищется как в `nestByHead`.** Сначала `headId` среди id строк. Затем `head` против `title`, затем против заголовков своих окон. При тёзках — первый в порядке пикера. Циклы разрываются тем же алгоритмом, в том же порядке обхода. Согласие держит общая фикстура `test/fixtures/head-groups.json`.
3. **Head обязан иметь окно на этой машине.** Он ищется только среди строк с окном здесь, так что это выходит само. Живость самого head не требуется.
4. **Вложенности не бывает, и это только сторож.** По решению Стаса ребёнок не может стать head. Сессия, у которой есть свой родитель, группу не образует, даже если на неё кто-то ссылается. Группы идут порядком head в пикере. Сортировки по глубине нет. Менеджер берёт первую группу, где есть id (спека обновлена); при такой сборке id и так входит не больше чем в одну группу.
5. **Пикер открыт, а подсвеченная строка не входит ни в одну группу** (заголовок, проект, чужая сессия) — ничего не слать, журнал. Откат менеджера на активное окно здесь врал бы: после гашения пикера активным становится случайное окно.
6. **Свежесть.** На скрытом окне снимок поллера отстаёт до 8 минут, а главный сценарий — «head только что открыл троих детей, жму клавишу». Нажатие опрашивает источники заново (`Poller::fresh_state`). При отказе откатывается на снимок и пишет об этом в журнал.
7. **Мак определяется по системе пикера (`cfg!(target_os = "macos")`).** `windowHost` — своя машина пикера: просьба уходит трекеру из `own_tracker_entry`. Значит, система окон и система пикера совпадают.
8. **Выключенная клавиша — не отказ.** Отчёт `save_config` даёт `"<key>Registered": null` и пустой акселератор. Подпись трея — без «(hotkey is taken)» и без правой колонки.

## Review Focus

1. **Нажатие сразу после открытия ребёнка.** Ребёнок, открытый 10 с назад, попадает в группу: снимок поллера не используется, если свежий опрос удался. Тест — Task 4: `fresh_state` берёт ответ опроса, а не кэш.
2. **Конфиг с `tileHotkey: Ctrl+Win+F10` или `Control+Super+F10`** (разное написание той же клавиши). Встаёт только группа, в журнале конфликт, в окне настроек плитка значится не вставшей. Тест — Task 1: `the_same_key_goes_to_the_group_layout`.
3. **Данные противоречат правилу «ребёнок не head»** (X — ребёнок H, а на X ссылается x1). Ни одна сессия не попадает в две группы, X остаётся в группе H. Тест — Task 2: случай `nested` в фикстуре.
4. **В поле хоткея набрано `none`, или нажата кнопка `Off`.** Форма не ругается «taken by the picker window» и не считает два `none` дублем. Rust ничего не регистрирует. Тесты — Task 6 (`validate`) и Task 1 (`none` → `None`).
5. **Подсветка стоит на той же строке до скрытия и после повторного показа.** Rust выбор видит: на `picker-hidden` страница сбрасывает «последнее посланное» и шлёт выбор заново. Тест — Task 4: `syncSelection` шлёт повторно после сброса.

---

## File Structure

- Create: `src-tauri/src/layout_hotkeys.rs` — чистое разрешение двух клавиш раскладки: умолчания по системам, `none`, конфликт. Без Tauri, под `cargo test`.
- Modify: `src-tauri/src/place_order.rs` — общий сбор строк; `group_ids` и `head_parents`.
- Create: `test/fixtures/head-groups.json` — общий вход для Rust и JS.
- Create: `test/head-groups.test.js` — JS-сторож правила родителя через `SessionTree.nestByHead`.
- Modify: `src-tauri/src/mqtt.rs` — `group_payload`, `place_body`; `place` работает через `place_body`.
- Modify: `src-tauri/src/manager_http.rs` — `place_body`.
- Modify: `src-tauri/src/poller.rs` — `fresh_state`.
- Modify: `src-tauri/src/main.rs`:
  - `PickerSelection` и команда `set_picker_selection`;
  - `group_press`, `register_group_tile_hotkey`;
  - регистрация на двух местах (`apply_config`, `setup`);
  - отчёт `save_config`, подпись трея;
  - `tile_hotkey` и `DEFAULT_TILE_*` переезжают в `layout_hotkeys.rs`.
- Create: `frontend-src/picker-selection.js` — `createSelectionSync(send)`: дедупликация отправки выбора.
- Modify: `sessions.html` — `paint()` зовёт синк, сброс на `picker-hidden`, тег `<script>`.
- Modify: `scripts/prepare-frontend.js` — новый файл в `FILES`.
- Modify: `frontend-src/settings-form.js`:
  - поле `groupTileHotkey`;
  - подсказки;
  - `allowOff` у двух полей;
  - `validate` пропускает `none`.
- Modify: `settings.html`:
  - кнопка `Off`;
  - показ `none` как `Off`;
  - строка в `HOTKEY_REPORTS`.
- Modify: `frontend-src/config-shape.js`, `frontend-src/key-reference.js`.
- Docs:
  - `docs/window-layouts.md` (новый раздел «Раскладка группы»);
  - `docs/rules/layouts.md`, `docs/rules/hotkeys-and-tray.md`;
  - `CLAUDE.md` (счёт правил в указателе).

---

### Task 1: Разрешение двух клавиш раскладки

**Files:**
- Create: `src-tauri/src/layout_hotkeys.rs` (подключить `mod layout_hotkeys;` в `main.rs`)
- Modify: `src-tauri/src/main.rs` — убрать `tile_hotkey`, `default_tile_shortcut`, `DEFAULT_TILE_ACCELERATOR` (≈2548–2600); вызовы переводятся в Task 5. Тест `tile_hotkey_shows_what_is_listened_to` (≈3934) переезжает в новый модуль.

**Interfaces:**
- Produces:
  ```rust
  pub type Hotkey = (Shortcut, String);           // клавиша и запись для показа
  pub struct LayoutHotkeys {
      pub tile: Option<Hotkey>,    // None — клавиши нет (выключена или отдана группе)
      pub group: Option<Hotkey>,
      /// Строка tileHotkey, отданная группе при конфликте: окно настроек
      /// называет её не вставшей.
      pub tile_lost: Option<String>,
  }
  pub fn layout_hotkeys(config: &serde_json::Value) -> LayoutHotkeys;
  pub fn is_off(value: &str) -> bool;              // "none" без учёта регистра и пробелов
  ```
- Умолчания:
  - не мак: tile `None`, group `Control+Super+F10`;
  - мак: tile `Control+Alt+Super+C`, group `None`.
- Нераспознанная строка: журнал `cannot parse <key> <s>, using default`, затем умолчание.

- [ ] **Step 1: Написать падающие тесты в `layout_hotkeys.rs`**

```rust
#[test]
fn defaults_differ_by_system() {
    let h = layout_hotkeys(&json!({}));
    #[cfg(not(target_os = "macos"))]
    { assert!(h.tile.is_none()); assert_eq!(h.group.as_ref().unwrap().1, "Control+Super+F10"); }
    #[cfg(target_os = "macos")]
    { assert_eq!(h.tile.as_ref().unwrap().1, "Control+Alt+Super+C"); assert!(h.group.is_none()); }
    assert!(h.tile_lost.is_none());
}
#[test]
fn empty_means_built_in_and_none_means_off() {
    let empty = layout_hotkeys(&json!({ "tileHotkey": "  ", "groupTileHotkey": "" }));
    let dflt = layout_hotkeys(&json!({}));
    assert_eq!(empty.group.map(|h| h.1), dflt.group.map(|h| h.1));
    let off = layout_hotkeys(&json!({ "tileHotkey": " None ", "groupTileHotkey": "none" }));
    assert!(off.tile.is_none() && off.group.is_none() && off.tile_lost.is_none());
}
#[test]
fn the_same_key_goes_to_the_group_layout() {
    for tile in ["Ctrl+Super+F10", "Control+Super+F10"] {
        let h = layout_hotkeys(&json!({ "tileHotkey": tile, "groupTileHotkey": "Control+Super+F10" }));
        assert!(h.tile.is_none(), "{tile}: плитка обязана уступить");
        assert_eq!(h.group.unwrap().1, "Control+Super+F10");
        assert_eq!(h.tile_lost.as_deref(), Some(tile));
    }
}
#[test]
fn own_keys_are_listened_to_and_garbage_falls_back() {
    let h = layout_hotkeys(&json!({ "tileHotkey": "Cmd+Shift+T", "groupTileHotkey": "не хоткей" }));
    assert_eq!(h.tile.unwrap().1, "Cmd+Shift+T");
    assert_eq!(h.group.map(|g| g.1), layout_hotkeys(&json!({})).group.map(|g| g.1));
}
```

- [ ] **Step 2: Запустить — падают**

Run: `cd src-tauri && cargo test layout_hotkeys`
Expected: FAIL, `layout_hotkeys` не определена.

- [ ] **Step 3: Реализовать `layout_hotkeys` и `is_off`**

Общий помощник `fn optional_hotkey(config, key, default: Option<Hotkey>) -> Option<Hotkey>`. Конфликт — сравнение `Shortcut` через `==`: это `global_hotkey::HotKey` 0.8, у него `derive(PartialEq, Eq)`, и сравниваются модификаторы с кодом, а не строка. Предупреждение о конфликте: `tileHotkey <s> is the same as groupTileHotkey, the group layout takes it`.

- [ ] **Step 4: Запустить — проходят**

Run: `cd src-tauri && cargo test layout_hotkeys`
Expected: PASS. Вызовы `tile_hotkey` в `main.rs` временно не компилируются — это нормально только внутри задачи. Перед коммитом перевести их на `layout_hotkeys(config).tile` с прежней логикой регистрации: `None` → не регистрировать. Полная проводка — в Task 5.

- [ ] **Step 5: `cargo test` целиком зелёный, коммит**

```bash
git add src-tauri/src/layout_hotkeys.rs src-tauri/src/main.rs
git commit -m "feat(hotkeys): tileHotkey и groupTileHotkey разрешаются одним правилом"
```

### Task 2: Группы head в `place_order`

**Files:**
- Modify: `src-tauri/src/place_order.rs` — тело `tile_ids` (≈336–418) делится на `sorted_rows` и проекцию в id. `Row` получает `head`, `head_id`, `window_titles`.
- Create: `test/fixtures/head-groups.json`, `test/head-groups.test.js`

**Interfaces:**
- Produces:
  ```rust
  impl Stale { pub const OFF: Stale = Stale { enabled: false, session_hours: 0.0, now_s: 0.0 }; }
  /// child id → parent id, только среди строк с окном на этой машине.
  pub fn head_parents(state: &Value, config_host: &str, sort: &str) -> BTreeMap<String, String>;
  /// Группы [head, прямые живые дети...] порядком head; head — только строка без своего родителя.
  pub fn group_ids(state: &Value, config_host: &str, sort: &str) -> Vec<Vec<String>>;
  ```
- `tile_ids` — поведение прежнее (сторожат существующие тесты и `place-order.json`).
- Поля сессии: `head`, `headId` (строки, `trim`). Окна: `title` у записей своих окон.

- [ ] **Step 1: Фикстура `test/fixtures/head-groups.json`**

Формат: `{ "comment": [...], "host": "pc", "sort": "recent", "cases": [ { "name", "sessions": [...], "order": [ids], "parents": {child: parent}, "groups": [[...]] } ] }`. Сессии — как в `place-order.json`: `id`, `title`, `live`, `windows: [{host, pid, title}]`, `agent.updated`, плюс `head`/`headId`. Случаи:
- `basic`: H с детьми `c1` (живой), `c2` (живой), `c3` (не живой), `c4` (живой, окно на `other`). Ждём `groups: [[H, c1, c2]]` в порядке `recent`; у `c3` родитель есть, но в группу он не входит.
- `no-live-children`: единственный ребёнок не живой → `groups: []`.
- `by-name`: у ребёнка нет `headId`, `head` равен `title` H → группа есть.
- `by-window-title`: `head` равен заголовку окна H, а не `title` → группа есть.
- `head-elsewhere`: окно H на `other` → `parents: {}`, `groups: []`.
- `nested` (сторож): H > X > x1, все живые, плюс Y ребёнок H. Ждём `parents: {X: H, Y: H, x1: X}` (так рисует дерево) и `groups: [[H, ...X и Y порядком recent]]`. Группы у X нет.
- `cycle`: A.headId = B, B.headId = A, A раньше B в порядке. Ждём `parents: {B: A}`, `groups: [[A, B]]`.

- [ ] **Step 2: Rust-тест над фикстурой (падает)**

```rust
#[test]
fn head_groups_match_the_shared_fixture() {
    const FIXTURE: &str = include_str!("../../test/fixtures/head-groups.json");
    let f: Value = serde_json::from_str(FIXTURE).unwrap();
    for case in f["cases"].as_array().unwrap() {
        let state = json!({ "sessions": case["sessions"] });
        let (host, sort, name) = (f["host"].as_str().unwrap(), f["sort"].as_str().unwrap(), &case["name"]);
        assert_eq!(json!(tile_ids(&state, host, sort, &Stale::OFF)), case["order"], "{name}: порядок");
        assert_eq!(json!(head_parents(&state, host, sort)), case["parents"], "{name}: родители");
        assert_eq!(json!(group_ids(&state, host, sort)), case["groups"], "{name}: группы");
    }
}
```

Плюс тест `stale_rows_stay_in_their_group`: тот же `basic`, но `tile_ids` со `Stale { enabled: true, .. }` отсекает H по давности, а `group_ids` его оставляет.

- [ ] **Step 3: JS-сторож `test/head-groups.test.js` (падает, пока нет фикстуры)**

`test('правило родителя у дерева страницы и у хоткея группы одно', ...)`:
- для каждого случая собрать строки `{ id, title, head, headId, windowTitle }` из `sessions` в порядке `order`, отбросив сессии без окна на `host`; `windowTitle` — заголовок своего окна;
- прогнать `require('../frontend-src/session-tree.js').nestByHead`;
- вывести родителей по `treeDepth`: родитель строки глубины d — ближайшая выше строка глубины d-1;
- `assert.deepStrictEqual(parents, case.parents, case.name)`.

- [ ] **Step 4: Реализовать `sorted_rows`, `head_parents`, `group_ids`**

Порядок поиска родителя и разрыв циклов — как в `nestSegment` (`frontend-src/session-tree.js:87-103`), обход в порядке `sorted_rows`. Head группы — строка, у которой в `head_parents` нет своего родителя. Группы идут порядком строк. Ребёнок попадает в группу, если `live`.

- [ ] **Step 5: Запустить оба сторожа**

Run: `cd src-tauri && cargo test place_order` и `npm test`
Expected: PASS, включая старые тесты `tile_ids`.

- [ ] **Step 6: Коммит**

```bash
git add src-tauri/src/place_order.rs test/fixtures/head-groups.json test/head-groups.test.js
git commit -m "feat(place): группы head считает Rust по правилу дерева страницы"
```

### Task 3: Тело просьбы `group` на обоих транспортах

**Files:**
- Modify: `src-tauri/src/mqtt.rs` (≈508–524), `src-tauri/src/manager_http.rs` (≈140–143)

**Interfaces:**
- Produces:
  ```rust
  // mqtt.rs
  pub(crate) fn group_payload(groups: &[Vec<String>], selected: Option<&str>) -> Result<String, String>;
  pub fn place_body(broker: &Broker, base: &str, body: &str) -> Result<(), String>;   // тот же PLACE_TOPIC
  // manager_http.rs
  pub fn place_body(endpoint: &str, body: String) -> Result<(), String>;               // тот же "/claude-place"
  ```
- `group_payload` отказывает (`Err`) на пустом `groups`, на группе короче двух и на пустом id. `mode` в `LAYOUT_MODES` не добавлять: `place_payload` по-прежнему отвергает `group`.
- Существующие `place()` в обоих модулях становятся обёртками над `place_body`.

- [ ] **Step 1: Тесты в `mqtt.rs` (падают)**

```rust
#[test]
fn a_group_request_is_the_contract_with_the_manager() {
    let g = vec![vec!["h".to_string(), "c1".to_string(), "c2".to_string()]];
    let v: serde_json::Value = serde_json::from_str(&group_payload(&g, None).unwrap()).unwrap();
    assert_eq!(v, serde_json::json!({ "mode": "group", "groups": [["h", "c1", "c2"]], "selected": null }));
    let v: serde_json::Value = serde_json::from_str(&group_payload(&g, Some("c1")).unwrap()).unwrap();
    assert_eq!(v["selected"], "c1");
}
#[test]
fn a_group_request_without_groups_is_refused() {
    assert!(group_payload(&[], None).is_err());
    assert!(group_payload(&[vec!["h".to_string()]], None).is_err());
    assert!(group_payload(&[vec!["h".to_string(), " ".to_string()]], None).is_err());
    assert!(place_payload("group", &[]).is_err(), "плитка не обязана знать group");
}
```

- [ ] **Step 2: Запустить — падают**

Run: `cd src-tauri && cargo test group_request` — FAIL, нет `group_payload`.

- [ ] **Step 3: Реализовать `group_payload` и оба `place_body`**

- [ ] **Step 4: Запустить**

Run: `cd src-tauri && cargo test` — PASS. `routes_match_the_receiver` не тронут.

- [ ] **Step 5: Коммит**

```bash
git add src-tauri/src/mqtt.rs src-tauri/src/manager_http.rs
git commit -m "feat(place): тело просьбы mode=group для http и mqtt"
```

### Task 4: Свежий ответ агрегатора и выбор строки в Rust

**Files:**
- Modify: `src-tauri/src/poller.rs` (рядом с `snapshot`, ≈491)
- Modify: `src-tauri/src/main.rs`:
  - `struct PickerSelection`;
  - команда в `generate_handler!` (≈3117), `.manage(...)` в `main`;
  - сброс в `hide_window` (≈109).
- Create: `frontend-src/picker-selection.js`, `test/picker-selection.test.js`
- Modify: `sessions.html` — `paint()` (≈2217), обработчик `picker-hidden`, тег `<script src="picker-selection.js">`.
- Modify: `scripts/prepare-frontend.js` — `FILES`.

**Interfaces:**
- Produces:
  ```rust
  // poller.rs: свежий опрос текущих источников. При отказе — снимок кэша
  // и строка в журнале. Блокирующий: звать из spawn_blocking.
  pub fn fresh_state(&self) -> serde_json::Value;
  pub fn state_or_snapshot(fresh: Option<Value>, cached: Value) -> (Value, bool);  // чистая, под тест
  // main.rs
  pub(crate) struct PickerSelection(pub Mutex<Option<String>>);
  #[tauri::command] fn set_picker_selection(app: tauri::AppHandle, id: Option<String>);  // trim, "" → None
  ```
  ```js
  // frontend-src/picker-selection.js (UMD, root.PickerSelection)
  createSelectionSync(send) → { sync(id), reset() }
  // sync шлёт send(id|null) только при смене; reset забывает последнее посланное.
  ```

- [ ] **Step 1: JS-тесты (падают)**

```js
test('выбор уходит в Rust только при смене строки', () => {
  const sent = [];
  const s = createSelectionSync(id => sent.push(id));
  s.sync('a'); s.sync('a'); s.sync('b'); s.sync(undefined);
  assert.deepStrictEqual(sent, ['a', 'b', null]);
});
test('после гашения тот же выбор посылается заново', () => {
  const sent = [];
  const s = createSelectionSync(id => sent.push(id));
  s.sync('a'); s.reset(); s.sync('a');
  assert.deepStrictEqual(sent, ['a', 'a']);
});
```

Плюс текстовый сторож в `test/row-contract.test.js` (или рядом):
- `paint()` в `sessions.html` зовёт `selectionSync.sync((rows[active] || {}).id)`;
- обработчик `picker-hidden` зовёт `selectionSync.reset()`.

- [ ] **Step 2: Rust-тест `state_or_snapshot` (падает)**

```rust
#[test]
fn a_fresh_answer_beats_the_cache() {
    let (s, fell_back) = state_or_snapshot(Some(json!({"sessions": [1]})), json!({"sessions": []}));
    assert_eq!(s, json!({"sessions": [1]})); assert!(!fell_back);
    let (s, fell_back) = state_or_snapshot(None, json!({"sessions": []}));
    assert_eq!(s, json!({"sessions": []})); assert!(fell_back);
}
```

- [ ] **Step 3: Реализовать**

- `fresh_state` берёт `self.settings`, зовёт `poll_once(&sources, false)`. При `None` пишет `cannot poll before the group layout, using the cached state: <err>`.
- Обновлять ли кэш поллера свежим ответом — не обязательно; сделать, только если это одна строка под тем же локом.
- Страница: `const selectionSync = window.PickerSelection.createSelectionSync(id => invoke('set_picker_selection', { id }).catch(() => {}));`.

- [ ] **Step 4: Запустить**

Run: `npm test` и `cd src-tauri && cargo test` — PASS.

- [ ] **Step 5: Коммит**

```bash
git add src-tauri/src/poller.rs src-tauri/src/main.rs frontend-src/picker-selection.js test/picker-selection.test.js sessions.html scripts/prepare-frontend.js test/row-contract.test.js
git commit -m "feat(place): выбранная строка и свежий опрос для раскладки группы"
```

### Task 5: Нажатие, регистрация, трей и отчёт

**Files:**
- Modify: `src-tauri/src/main.rs`:
  - `tile_press` (≈2700–2800): общий пролог выносится;
  - новый `group_press`;
  - `register_tile_hotkey` (≈1658), новый `register_group_tile_hotkey`;
  - `apply_config` (≈1873–1895), регистрация в `setup` (≈3213, ≈3300–3325);
  - `save_config` (≈1593);
  - `tile_item_label` (≈3099), `menu_item_parts` (≈1735).
- Docs:
  - `docs/window-layouts.md`: раздел «Раскладка группы» — тело, правило групп, решения 1–8 этого плана, мак;
  - «Кто вешает клавишу»: `Ctrl+Win+F10` теперь у группы;
  - `docs/rules/layouts.md`: новое правило «Хоткей группы принадлежит пикеру, группы считает Rust», рядом с правилом плитки.

**Interfaces:**
- Consumes:
  - `layout_hotkeys` (Task 1);
  - `group_ids` (Task 2);
  - `group_payload`, `place_body` ×2 (Task 3);
  - `fresh_state`, `PickerSelection` (Task 4).
- Produces:
  ```rust
  struct PlaceContext { raw: Value, host: String, state: Value, sort: String }
  fn place_context(app: &tauri::AppHandle, state: Value) -> Option<PlaceContext>; // конфиг, windowHost, sort из ui.json
  fn send_place(ctx: &PlaceContext, body: String, what: &'static str);            // transport_for → http | mqtt, журнал отказа
  fn group_press(app: &tauri::AppHandle);
  fn register_group_tile_hotkey(app: &tauri::AppHandle, hk: Option<Hotkey>) -> (Option<bool>, String);
  fn register_tile_hotkey(app: &tauri::AppHandle, hk: Option<Hotkey>) -> (Option<bool>, String);
  fn tile_item_label(registered: Option<bool>) -> &'static str;
  ```
- `save_config` отдаёт и `"groupTileHotkeyRegistered"`, `"groupTileHotkeyAccelerator"`. `Registered`: `null` у выключенной клавиши.
- При конфликте `tileHotkeyRegistered: false`, акселератор — `tile_lost`.

`group_press(app)`, по порядку:
1. Прочитать видимость окна и `PickerSelection` **до** `hide_window`.
2. `hide_window(app)`.
3. На macOS: журнал `group layout is not supported on macOS`, выход.
4. `allow_any_foreground()` — пока нажатие наше.
5. Остальное — в `spawn_blocking`:
   - `fresh_state`;
   - `place_context`;
   - `group_ids(state, host, sort)`.
6. Групп нет — журнал `no head session with live children on this machine, not asking for a group layout`, выход.
7. Окно было видно, а выбор пуст или не входит ни в одну группу — журнал `the highlighted row is not in a head group, not asking for a group layout`, выход.
8. `send_place(ctx, group_payload(&groups, selected)?, "group layout")`.
9. Журнал успеха: `asked for a group layout: <n> group(s), selected <id|none>`.

`tile_press` переводится на `place_context` и `send_place` без изменения поведения. Его снимок остаётся из кэша: свежий опрос для плитки вне задачи.

Подпись трея плитки:
- `None` → `Tile windows`, без правой колонки;
- `menu_item_parts` с пустым акселератором отдаёт голую подпись и `None`.

Пункта трея для группы нет: спека его не просит.

- [ ] **Step 1: Тесты (падают)**

```rust
#[test]
fn an_unbound_tile_key_is_not_a_taken_one() {
    assert_eq!(tile_item_label(None), "Tile windows");
    assert_eq!(tile_item_label(Some(true)), "Tile windows");
    assert_ne!(tile_item_label(Some(false)), "Tile windows");
    assert_eq!(menu_item_parts("Tile windows", ""), ("Tile windows".to_string(), None));
}
```

Существующий тест (≈4394) переписать под `Option<bool>`. Текстовый сторож `test/settings-page.test.js` («окно спрашивает про хоткеи теми же ключами») после Task 6 обязан видеть `groupTileHotkey` с обеих сторон.

- [ ] **Step 2: Запустить — падают**

Run: `cd src-tauri && cargo test unbound_tile_key` — FAIL.

- [ ] **Step 3: Реализовать по списку выше**

`apply_config` и `setup`:
- зовут `layout_hotkeys(&config)` один раз;
- регистрируют группу **раньше** плитки;
- кладут `tile_lost` в отчёт;
- при `tile_lost` регистрацию плитки пропускают.

- [ ] **Step 4: Запустить**

Run: `cd src-tauri && cargo test` и `npm test` — PASS.

- [ ] **Step 5: Коммит**

```bash
git add src-tauri/src/main.rs docs/window-layouts.md docs/rules/layouts.md
git commit -m "feat(place): Ctrl+Win+F10 раскладывает группу head, плитка без клавиши"
```

### Task 6: Окно настроек, `none` и справка по клавишам

**Files:**
- Modify: `frontend-src/settings-form.js`:
  - поле после `tileHotkey` (≈236);
  - `validate` (≈567–585).
- Modify: `settings.html`:
  - контрол хоткея (≈360–368), обработчик кнопок (≈935);
  - `HOTKEY_REPORTS` (≈149).
- Modify: `frontend-src/config-shape.js` (≈39, ≈352), `frontend-src/key-reference.js` (≈107).
- Test:
  - `test/settings-form.test.js` (≈174 — точный список id);
  - `test/settings-page.test.js`, `test/key-reference.test.js`, `test/config-shape.test.js` (если есть).
- Docs:
  - `docs/rules/hotkeys-and-tray.md`: пять глобальных хоткеев, `none`, конфликт;
  - `CLAUDE.md`: счёт правил в строках указателя, если он изменился.

**Interfaces:**
- Поле:
  ```js
  { id: 'groupTileHotkey', label: 'Lay out the head session group', type: 'hotkey', allowOff: true,
    hint: 'Asks the window manager to put a head session and its children into their zones. '
      + 'Leave empty for the built-in one: Ctrl+Win+F10 on Windows, none on a Mac. '
      + 'Not supported on a Mac.' }
  ```
- `tileHotkey`:
  - `allowOff: true`;
  - hint: `'Asks the window tracker for the tile layout, in the order of this list. Leave empty for the built-in one: none on Windows, Ctrl+Option+Cmd+C on a Mac.'`
- Контрол: у полей с `allowOff` третья кнопка `Off` (`data-hotkey-off`), пишет `'none'`. Значение `none` показывается как `Off`, пустое — как `Built-in`.
- `HOTKEY_REPORTS`: `['group layout hotkey', 'groupTileHotkey']`.
- `config-shape.js`: `groupTileHotkey: ''` в `DEFAULTS` и та же нормализация, что у `tileHotkey`.
- `key-reference.js`:
  - строка `Lay out the head session group` при непустом `groupTileHotkey`;
  - ни одна из двух строк раскладки не показывается при `none`.

- [ ] **Step 1: Тесты (падают)**

- `settings-form.test.js`:
  - список id хоткеев `['hotkey', 'projectsHotkey', 'tileHotkey', 'groupTileHotkey', 'historyHotkey']`;
  - `validate({ sshHost: 'host', tileHotkey: 'none', groupTileHotkey: 'NONE' })` — без проблем: не «taken by the picker window» и не дубль;
  - `validate({ sshHost: 'host', tileHotkey: 'Ctrl+Win+F9', groupTileHotkey: 'ctrl+win+f9' })` — ровно одна проблема `is set for two hotkeys`.
- `key-reference.test.js`:
  - `groupTileHotkey: 'Ctrl+Win+F10'` даёт строку `Lay out the head session group`;
  - `tileHotkey: 'none'` строки плитки не даёт.
- `settings-page.test.js`: отрисованный контрол `groupTileHotkey` со значением `none` содержит `>Off<` и кнопку `data-hotkey-off`. У `hotkey` такой кнопки нет.

- [ ] **Step 2: Запустить — падают**

Run: `npm test` — FAIL на новых тестах.

- [ ] **Step 3: Реализовать**

`validate` пропускает значения, для которых `is off` (та же формула, что `is_off` в Rust: `trim().toLowerCase() === 'none'`), и в проверке «занято окном», и в проверке дублей.

- [ ] **Step 4: Запустить**

Run: `npm test` и `cd src-tauri && cargo test` — PASS. Сторож ключей отчёта видит `groupTileHotkey` у окна и у Rust.

- [ ] **Step 5: Коммит**

```bash
git add frontend-src/settings-form.js settings.html frontend-src/config-shape.js frontend-src/key-reference.js test docs/rules/hotkeys-and-tray.md CLAUDE.md
git commit -m "feat(settings): клавиша раскладки группы и значение none"
```

### Task 7: Проверка и выкатка

- [ ] **Step 1:** `npm test` в основном каталоге (не в worktree: там пропускается проверка приватного) и `cd src-tauri && cargo test`. Ожидается всё зелёное.
- [ ] **Step 2:** Push ветки. Выкатка — только когда руководитель подтвердит, что менеджер с `mode: group` уже на ноутбуке. Потом `BRANCH=feat/group-tile-hotkey ./data/scripts/deploy-win.sh` и `deploy-mac.sh`, параллельно, в фоне. Проверка — `== готово` в выводе. Мак — если машина в сети.
- [ ] **Step 3:** Вживую на ноутбуке:
  - журнал пикера (вкладка Log) после `Ctrl+Win+F10` при скрытом пикере: `asked for a group layout: N group(s), selected none`;
  - при открытом пикере на ребёнке — `selected <id>`;
  - на строке-проекте — отказ с причиной;
  - в окне настроек вкладка Hotkeys показывает плитку `Built-in`, кнопки `Clear` и `Off`, отчёт о не вставших пуст;
  - кнопка `Tile windows` в `^K` работает как раньше.
- [ ] **Step 4:** Merge и релиз — только после того, как Стас посмотрит.
