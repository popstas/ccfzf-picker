# Строка проекта открывает сессию с профилем — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enter на строке проекта поднимает окно этого каталога или заводит сессию с его профилем, а `^N` всегда заводит новую — тоже с профилем.

**Architecture:** Обе клавиши спрашивают ту же `chooseOpenTransport`, что и Enter на строке сессии: менеджера просят только на машине трекера и при настроенном брокере, иначе остаётся прежняя местная `newSession`. Enter шлёт уже работающую просьбу `{action:"terminal", cwd}`, `^N` — новую `{action:"terminal-new", cwd, name}`, которую windows11-manager уводит в `openClaudeProject` с `reuseOpen: false`.

**Tech Stack:** Rust (Tauri 2, `rumqttc`), `cargo test`; фронтенд — ванильный JS, `node --test`; windows11-manager — Node.js, `vitest`.

**Спека:** [`docs/superpowers/specs/2026-08-12-project-row-open-and-new-design.md`](../specs/2026-08-12-project-row-open-and-new-design.md)

## Global Constraints

- Два репозитория. Пикер: `~/projects/js/ccfzf-picker`, ветка `windows-mqtt-migrate`. Менеджер: `~/projects/js/windows11-manager`, ветка `feat/claude-wt-agent-progress`. Правки одного репозитория не коммитить в другом.
- В обоих репозиториях **перед коммитом проверить `git status`** и добавлять в индекс только файлы своей задачи по именам: в рабочем дереве могут лежать чужие незакоммиченные правки.
- ccfzf-picker публичный. `npm test` (там `node --test`) включает стража `test/no-private-data.test.js`, который ходит по `git ls-files`: живых домашних путей (`/home/<имя>`, `/Users/<имя>`, `\Users\<имя>`) и имён машин в коде, комментариях и документации быть не должно. Каталоги в фикстурах и примерах — `/p/one`, `/p/site`, `/p/home`.
- Комментарии и докстринги — по-русски, как весь файл, и объясняют **почему**, а не пересказывают код.
- Перед любой командой `cargo`: `. "$HOME/.cargo/env"`, запуск из каталога `src-tauri`.
- Хук `rtk` сворачивает вывод cargo и глотает предупреждения компилятора. Проверять сборку только через `rtk proxy cargo build`; «предупреждений нет» без такого вывода — непроверенное утверждение.
- Юнит-тестов на код, которому нужен живой `tauri::AppHandle`, в пикере нет и заводить их не надо. Тестов на `sessions.html` в репозитории нет вовсе — вся развилка живёт в `frontend-src/open-transport.js`, там она и проверяется.
- В windows11-manager тесты запускаются `npm test` (`vitest run`) из корня репозитория.
- Каталог `data/` в пикере под `.gitignore`: скрипты выкатки в коммиты не попадают.

---

### Task 1: Просьба «заведи новую» и мост в страницу

Странице нужны два вызова: «открой проект» (тело уже есть, зовёт его пока только Rust) и «заведи новую сессию» (тела ещё нет). Обе половины в одной задаче, потому что порознь первая оставила бы функцию без вызывающего, а вторая — команду без тела.

**Files:**
- Modify: `src-tauri/src/mqtt.rs` — новые `open_new` и `open_new_payload` после `open_project_payload`, новый тест в `mod tests`.
- Modify: `src-tauri/src/main.rs` — общий помощник `configured_broker`, две команды после `open_session_mqtt` (строки 290–301), регистрация в `generate_handler!` (строки 800–805).

**Interfaces:**
- Consumes: `Broker`, `publish`, `OPEN_TOPIC`, `broker_from_config`, `load_config`, `mqtt::open_project` — всё уже есть.
- Produces:
  - `pub fn open_new(broker: &Broker, cwd: &str, name: &str) -> Result<(), String>`
  - команда Tauri `open_project_mqtt(cwd: String) -> Result<(), String>` — зовётся со страницы как `invoke('open_project_mqtt', { cwd })`
  - команда Tauri `new_session_mqtt(cwd: String, name: String) -> Result<(), String>` — зовётся как `invoke('new_session_mqtt', { cwd, name })`

  Обе команды зовёт Task 3.

- [ ] **Step 1: Написать падающий тест**

В `src-tauri/src/mqtt.rs`, в `mod tests`, сразу после `open_project_body_carries_no_id`:

```rust
    // Тело просьбы «заведи ещё одну»: каталог, имя и отдельное действие.
    // Имя здесь не украшение — его считает пикер (`uniqueSessionName`), потому
    // что basename каталога уже занят открытой сессией, а два окна с одним
    // заголовком трекер привязал бы к одной сессии.
    //
    // `id` не едет и сюда, даже когда нажали на строке живой сессии: с ним
    // приёмник поднял бы ровно ту сессию, рядом с которой просили открыть
    // новую.
    #[test]
    fn open_new_body_names_the_session() {
        assert_eq!(
            open_new_payload("/p/site", "site-2"),
            r#"{"action":"terminal-new","cwd":"/p/site","name":"site-2"}"#
        );
    }
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
. "$HOME/.cargo/env" && cd src-tauri && cargo test open_new_body_names_the_session
```

Ожидается: ошибка компиляции `cannot find function open_new_payload in this scope`.

- [ ] **Step 3: Написать просьбу**

В `src-tauri/src/mqtt.rs`, сразу после `open_project_payload` (перед `restore_payload`):

```rust
/// Попросить завести новую сессию в каталоге, не поднимая существующую.
///
/// Отличается от `open_project` не топиком, а действием: топик отвечает на
/// вопрос «о чём просьба» — открыть сессию, — а не «каким способом». Отдельное
/// значение `action`, а не флаг рядом с прежним `terminal`, выбрано по тому,
/// как ошибётся старый приёмник: незнакомое действие он отклоняет вслух
/// (`unsupported action` в журнал и уведомлением), а незнакомый флаг молча
/// пропустил бы и поднял старое окно — сделал бы обратное просьбе, и никто бы
/// не узнал.
pub fn open_new(broker: &Broker, cwd: &str, name: &str) -> Result<(), String> {
    publish(broker, OPEN_TOPIC, &open_new_payload(cwd, name))
}

/// Тело просьбы о новой сессии: действие, каталог и имя.
///
/// Имя обязательно и пустым не бывает: без него приёмник взял бы basename
/// каталога — то самое имя, которое уже занято открытой сессией. Пустую строку
/// сюда класть нельзя по тому же правилу, по которому её нет в `open_payload`:
/// ключ без значения — это тело, которое врёт о том, что знает.
fn open_new_payload(cwd: &str, name: &str) -> String {
    serde_json::json!({ "action": "terminal-new", "cwd": cwd, "name": name }).to_string()
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

```bash
. "$HOME/.cargo/env" && cd src-tauri && cargo test open_new
```

Ожидается: `open_new_body_names_the_session ... ok`.

- [ ] **Step 5: Вынести общий разбор брокера**

В `src-tauri/src/main.rs` четыре команды повторяют одни и те же три строки (`focus_window_mqtt:219-223`, `unread_session_mqtt:241-245`, `restore_snapshot_mqtt:258-262`, `open_session_mqtt:292-296`). Добавлять к ним пятую и шестую копию нельзя — выносим помощника и переводим на него все шесть.

Перед `focus_window_mqtt` (строка 215) добавить:

```rust
/// Брокер из конфига или внятный отказ.
///
/// Общий для всех команд, публикующих просьбы: шесть копий одной проверки
/// разошлись бы в тексте отказа, а его читает человек в строке ошибки пикера.
fn configured_broker() -> Result<mqtt::Broker, String> {
    let broker = mqtt::broker_from_config(&load_config()?);
    if !broker.is_configured() {
        return Err("mqtt is not configured: host and base are required in config.yaml".to_string());
    }
    Ok(broker)
}
```

Затем в каждой из четырёх команд заменить блок

```rust
    let raw = load_config()?;
    let broker = mqtt::broker_from_config(&raw);
    if !broker.is_configured() {
        return Err("mqtt is not configured: host and base are required in config.yaml".to_string());
    }
```

на одну строку:

```rust
    let broker = configured_broker()?;
```

В `focus_window_mqtt` этот блок стоит **после** `allow_tracker_foreground(pid)` — порядок сохранить, грамота выдаётся до публикации намеренно.

- [ ] **Step 6: Написать две команды**

В `src-tauri/src/main.rs`, сразу после `open_session_mqtt`:

```rust
/// Попросить менеджера открыть проект по каталогу.
///
/// `id` в теле нет вовсе: у строки проекта сессии ещё не существует, есть
/// только каталог, и что с ним делать — поднять окно этого проекта или завести
/// сессию с его профилем — решает `openClaudeProject` на той стороне. Ту же
/// просьбу шлёт проектный хоткей из `project_hotkeys.rs`; здесь она нужна
/// затем, что у страницы своего входа к ней не было.
#[tauri::command]
async fn open_project_mqtt(cwd: String) -> Result<(), String> {
    let broker = configured_broker()?;
    tauri::async_runtime::spawn_blocking(move || mqtt::open_project(&broker, &cwd))
        .await
        .map_err(|e| format!("open_project_mqtt task failed: {e}"))?
}

/// Попросить менеджера завести новую сессию в каталоге.
///
/// Отдельная команда, а не флаг у `open_project_mqtt`: на мосту в webview флаг
/// стал бы необязательным аргументом, а различает он две разные просьбы с
/// разными телами. Имя считает пикер и присылает готовым — менеджер списка
/// занятых имён не ведёт.
#[tauri::command]
async fn new_session_mqtt(cwd: String, name: String) -> Result<(), String> {
    let broker = configured_broker()?;
    tauri::async_runtime::spawn_blocking(move || mqtt::open_new(&broker, &cwd, &name))
        .await
        .map_err(|e| format!("new_session_mqtt task failed: {e}"))?
}
```

- [ ] **Step 7: Зарегистрировать команды**

В `src-tauri/src/main.rs`, в `tauri::generate_handler![…]` (строки 800–805) заменить

```rust
            restore_snapshot_mqtt, open_session_mqtt, save_config, open_settings,
            project_hotkeys_taken
```

на

```rust
            restore_snapshot_mqtt, open_session_mqtt, open_project_mqtt, new_session_mqtt,
            save_config, open_settings, project_hotkeys_taken
```

Незарегистрированная команда — не ошибка сборки: `invoke` со страницы отчитается «command not found» уже в работе.

- [ ] **Step 8: Прогнать всё и закоммитить**

```bash
. "$HOME/.cargo/env" && cd src-tauri && cargo test
rtk proxy cargo build
cargo clippy --all-targets -- -D warnings
cd .. && npm test
git status --porcelain
git add src-tauri/src/mqtt.rs src-tauri/src/main.rs
git commit -m "feat(mqtt): просьба завести новую сессию и мост к обеим просьбам"
```

Ожидается: `cargo test` зелёный, `rtk proxy cargo build` без предупреждений (обе новые команды считаются использованными через `generate_handler!`), clippy молчит (если не установлен — пропустить), `npm test` — 361 тест. `git status` смотрим глазами: в индекс идут только два названных файла.

---

### Task 2: Кто открывает терминал по каталогу

Развилка «просить менеджера или открывать самому» уже написана и покрыта тестами, но строки проекта в неё не заходят. Новая функция — рядом с существующими, в том же файле.

**Files:**
- Modify: `frontend-src/open-transport.js` — новая функция после `chooseEnterAction` (строка 163), новый экспорт (строка 165).
- Modify: `test/open-transport.test.js` — новые тесты в конце файла, новый импорт вверху (строки 3–5).

**Interfaces:**
- Consumes: `chooseOpenTransport`, `rowProjectDir` — уже есть в этом файле.
- Produces: `chooseProjectOpenAction(row, state, configHost, mqttConfigured) -> 'manager' | 'local'` — её зовёт Task 3 из `sessions.html` как `window.OpenTransport.chooseProjectOpenAction(...)`.

- [ ] **Step 1: Написать падающие тесты**

В `test/open-transport.test.js` заменить импорт (строки 3–5):

```js
const {
  chooseOpenTransport, canOpenRemote, chooseEnterAction, rowProjectDir,
} = require('../frontend-src/open-transport');
```

на:

```js
const {
  chooseOpenTransport, canOpenRemote, chooseEnterAction, rowProjectDir,
  chooseProjectOpenAction,
} = require('../frontend-src/open-transport');
```

И дописать в конец файла:

```js
test('строка проекта на машине трекера уходит к менеджеру', () => {
  // Профиль Windows Terminal по каталогу знает только менеджер, и ради него
  // просьба и уезжает: собранная в пикере команда wt.exe профиль теряет.
  const row = { kind: 'project', id: '/p/site', cwd: '/p/site' };
  assert.equal(chooseProjectOpenAction(row, { windowHost: 'PC-WIN' }, 'pc-win', true), 'manager');
});

test('вид строки на выбор не влияет — важен только каталог', () => {
  // «New session» предлагается и рядом с живой сессией, и на сессии снимка.
  // Просьба у всех одна и та же — про каталог, — и id в ней нет вовсе,
  // поэтому позитивный список SESSION_ID_ROW_KINDS здесь не нужен.
  const state = { windowHost: 'PC-WIN' };
  for (const kind of ['project', 'interactive', 'snapshot-session', 'что-то новое']) {
    assert.equal(chooseProjectOpenAction({ kind, cwd: '/p/site' }, state, 'pc-win', true), 'manager');
  }
});

test('чужая машина и ненастроенный брокер — открываем сами', () => {
  const row = { kind: 'project', cwd: '/p/site' };
  assert.equal(chooseProjectOpenAction(row, { windowHost: 'PC-WIN' }, 'macbook', true), 'local');
  assert.equal(chooseProjectOpenAction(row, { windowHost: 'PC-WIN' }, 'pc-win', false), 'local');
});

test('каталога нет — просить не о чем', () => {
  // Без каталога просьба умерла бы в журнале менеджера молча: ответа у
  // публикации нет. Прежняя местная дорога хотя бы скажет человеку об отказе.
  const state = { windowHost: 'PC-WIN' };
  assert.equal(chooseProjectOpenAction({ kind: 'project', cwd: '  ' }, state, 'pc-win', true), 'local');
  assert.equal(chooseProjectOpenAction({ kind: 'project' }, state, 'pc-win', true), 'local');
  assert.equal(chooseProjectOpenAction(null, state, 'pc-win', true), 'local');
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
node --test test/open-transport.test.js
```

Ожидается: падение с `chooseProjectOpenAction is not a function`.

- [ ] **Step 3: Написать функцию**

В `frontend-src/open-transport.js`, после `chooseEnterAction` (строка 163) и перед `return {…}`:

```js
  /**
   * Кто открывает терминал по каталогу: 'manager' | 'local'.
   *
   * Общая для двух поводов: Enter на строке проекта и «New session» (`^N` и
   * пункт меню) на любой строке. Тела просьб у них разные — `terminal` против
   * `terminal-new`, — а транспорт один, и разводить его значило бы завести две
   * копии правила, которые разойдутся.
   *
   * Позитивного списка видов строк, как у `chooseEnterAction`, здесь нет
   * намеренно: тот список защищает `id` от того, чтобы уехать чужим, а в этих
   * двух просьбах `id` не едет вовсе. Значение имеет только каталог.
   *
   * Пустой каталог оставляет строку местной дороге: без него менеджеру не за
   * что взяться, он записал бы отказ в свой журнал, а пикер об этом не узнал
   * бы — ответа у публикации нет.
   */
  function chooseProjectOpenAction(row, state, configHost, mqttConfigured) {
    if (!rowProjectDir(row)) return 'local';
    return chooseOpenTransport(state, configHost, mqttConfigured);
  }
```

И расширить экспорт (строка 165):

```js
  return {
    chooseOpenTransport, canOpenRemote, chooseEnterAction, rowProjectDir,
    chooseProjectOpenAction,
  };
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
node --test test/open-transport.test.js
```

Ожидается: все тесты файла зелёные.

- [ ] **Step 5: Коммит**

```bash
npm test
git status --porcelain
git add frontend-src/open-transport.js test/open-transport.test.js
git commit -m "feat(transport): кто открывает терминал по каталогу — одно правило на две клавиши"
```

Ожидается: `npm test` — 365 тестов (361 прежних плюс четыре новых), все зелёные.

---

### Task 3: Enter на проекте и `^N` идут к менеджеру

Две ветки в `sessions.html` перестают звать `newSession` напрямую и спрашивают транспорт. Местная `newSession` остаётся запасной дорогой и не меняется.

**Files:**
- Modify: `sessions.html` — докблок `newSession` (строки 1256–1265), две новые функции после `newSession` (после строки 1296), ветка строки проекта в `choose()` (строки 1107–1109), ветка `id === 'new'` в `runAction` (строки 1323–1326).

**Interfaces:**
- Consumes: `open_project_mqtt`, `new_session_mqtt` (Task 1); `chooseProjectOpenAction`, `rowProjectDir` (Task 2); из самого файла — `newSession`, `takenSessionNames`, `issuedNames`, `lastState`, `CONFIG`, `invoke`, `render`, `error`, `window.OpenStrategy.newSessionName`.
- Produces: ничего для других задач.

- [ ] **Step 1: Поправить докблок `newSession`**

Он обещает «один вход на три повода», а поводов у него теперь один — запасной. Заменить строки 1256–1265:

```js
  /**
   * Поднять новую сессию в каталоге строки.
   *
   * Один вход на три повода: Enter на строке проекта, `^N` на любой строке и
   * пункт меню. Разводить их значило бы завести три места, где собирается одна
   * и та же удалённая команда, — а собирать её мимо OpenStrategy нельзя вовсе.
   *
   * Отметки «просмотрено» здесь нет: смотреть ещё нечего, сессия только что
   * началась.
   */
```

на:

```js
  /**
   * Поднять новую сессию в каталоге строки самому.
   *
   * Запасная дорога: и Enter на строке проекта, и «New session» сначала
   * спрашивают `chooseProjectOpenAction`, и сюда попадают там, где менеджера
   * нет — на чужой машине и без настроенного брокера. Профиль Windows Terminal
   * по каталогу здесь теряется, и иначе быть не может: соответствие живёт в
   * `claudeWt.projects` у windows11-manager, а на такой машине его нет вовсе.
   *
   * Отметки «просмотрено» здесь нет: смотреть ещё нечего, сессия только что
   * началась.
   */
```

- [ ] **Step 2: Написать две функции**

В `sessions.html`, сразу после `newSession` (то есть после её закрывающей скобки, строка 1296) и перед докблоком `runAction`:

```js
  /**
   * Enter на строке проекта: попросить менеджера открыть проект.
   *
   * Развилку «поднять окно этого каталога или завести сессию» принимает он:
   * правило «последняя открытая сессия проекта» написано и покрыто тестами у
   * него (`pickOpenProjectSession`), и профиль Windows Terminal по каталогу
   * знает тоже только он. Та же просьба, что уходит от проектного хоткея.
   *
   * Отметки «просмотрено» здесь нет и быть не может: у строки проекта нет id
   * сессии, отмечать нечего.
   */
  async function openProjectRow(row) {
    const dir = window.OpenTransport.rowProjectDir(row);
    const action = window.OpenTransport.chooseProjectOpenAction(
      row, lastState, CONFIG.windowHost, CONFIG.mqtt.configured,
    );
    if (action !== 'manager') return newSession(row.cwd);
    try {
      await invoke('open_project_mqtt', { cwd: dir });
    } catch (e) {
      error = String(e);
      render();
      return;
    }
    error = '';
    invoke('hide_picker');
  }

  /**
   * «New session» — всегда новая, но профиль знает менеджер.
   *
   * Отличается от `openProjectRow` ровно тем, что просит не искать открытую:
   * `^N` человек нажимает, когда сессия уже есть и нужна ещё одна.
   *
   * Имя считается здесь, а не на той стороне: менеджер списка занятых имён не
   * ведёт и взял бы basename каталога — то самое имя, которое уже занято, — а
   * два окна с одним заголовком трекер привязал бы к одной сессии. Пустое имя
   * значит отказ `OpenStrategy` (путь с `;`), и тогда местная дорога скажет об
   * этом человеку — своей копии того же сообщения здесь не надо.
   */
  async function newSessionHere(row) {
    const dir = window.OpenTransport.rowProjectDir(row);
    const action = window.OpenTransport.chooseProjectOpenAction(
      row, lastState, CONFIG.windowHost, CONFIG.mqtt.configured,
    );
    if (action !== 'manager') return newSession(row.cwd);
    const taken = takenSessionNames();
    const name = window.OpenStrategy.newSessionName(dir, taken);
    if (!name) return newSession(row.cwd);
    try {
      await invoke('new_session_mqtt', { cwd: dir, name });
    } catch (e) {
      error = String(e);
      render();
      return;
    }
    error = '';
    // Имя занимается после удачной отправки — как и в newSession: иначе два
    // быстрых `^N` подряд дали бы одно и то же имя, потому что дамп ccfzf
    // первую сессию ещё не увидел.
    issuedNames.set(name, Date.now());
    invoke('hide_picker');
  }
```

- [ ] **Step 3: Перевести Enter на строке проекта**

Заменить строки 1107–1109:

```js
    // У строки проекта продолжать нечего — есть только каталог. Enter значит
    // здесь то же, что и на строке сессии: «открой мне терминал с агентом».
    if (row.kind === 'project') return newSession(row.cwd);
```

на:

```js
    // У строки проекта нет id сессии — есть только каталог, и что с ним
    // делать, решает менеджер: поднять окно этого проекта или завести сессию с
    // его профилем. Enter здесь значит «покажи мне проект», а не «дай ещё один
    // терминал» — вторая просьба живёт под `^N`.
    if (row.kind === 'project') return openProjectRow(row);
```

- [ ] **Step 4: Перевести `^N` и пункт меню**

Заменить строки 1323–1326:

```js
    if (id === 'new') {
      newSession(row.cwd);
      return;
    }
```

на:

```js
    if (id === 'new') {
      newSessionHere(row);
      return;
    }
```

- [ ] **Step 5: Проверить, что страница цела**

```bash
npm test
```

Ожидается: 365 зелёных. `test/frontend-load.test.js` загружает `sessions.html` и упал бы на синтаксической ошибке; `test/row-contract.test.js` проверяет форму строк.

- [ ] **Step 6: Убедиться, что старых вызовов не осталось**

```bash
grep -n "newSession(row.cwd)" sessions.html
```

Ожидается: ровно три совпадения, и все внутри новых функций и запасных веток (`openProjectRow`, `newSessionHere` — две ветки `!== 'manager'` и одна на пустое имя). Прямых вызовов из `choose()` и `runAction` быть не должно.

- [ ] **Step 7: Коммит**

```bash
git status --porcelain
git add sessions.html
git commit -m "feat(picker): Enter на проекте поднимает окно, ^N заводит новую с профилем"
```

---

### Task 4: Имя новой сессии — чистой функцией

Правило «чьё имя главнее» — единственное в правке менеджера, что можно проверить без окон Windows. Выносится рядом с остальными такими же в `project-helpers.js`.

**Files:**
- Modify: `~/projects/js/windows11-manager/src/claude-wt/project-helpers.js` — новая функция после `basenameOfCwd` (строка 10), новый экспорт (строки 80–88).
- Modify: `~/projects/js/windows11-manager/src/claude-wt/project-helpers.test.js` — новые тесты в конце файла.
- Modify: `~/projects/js/windows11-manager/src/claude-wt/project.js` — сигнатура `openClaudeProject` (строка 42), имя сессии (строка 47), пропуск поисков (строки 57–71).

**Interfaces:**
- Consumes: `basenameOfCwd` — уже есть в `project-helpers.js`.
- Produces:
  - `sessionNameFor({ cwd, name, reuseOpen })` — строка;
  - `openClaudeProject({ cwd, name, profile, reuseOpen })`, где `reuseOpen` по умолчанию `true`. Её зовёт Task 5.

- [ ] **Step 1: Написать падающие тесты**

В `src/claude-wt/project-helpers.test.js` дописать в конец файла (импорт вверху файла расширить именем `sessionNameFor` — он там один общий `import { … } from './project-helpers.js'`):

```js
describe('sessionNameFor', () => {
  it('обычная просьба берёт имя каталога', () => {
    // Так же назвал бы сессию ccfzf (`claude -n <basename>`), и по этому же
    // имени openClaudeProject ищет открытое окно по заголовку.
    expect(sessionNameFor({ cwd: '/p/site', name: 'что угодно' })).toBe('site');
  });

  it('просьба «заведи ещё одну» берёт имя из тела', () => {
    // basename там занят открытой сессией, и уникальное имя посчитал пикер.
    expect(sessionNameFor({ cwd: '/p/site', name: 'site-2', reuseOpen: false })).toBe('site-2');
  });

  it('без имени в теле остаётся каталог — в обоих случаях', () => {
    expect(sessionNameFor({ cwd: '/p/site', reuseOpen: false })).toBe('site');
    expect(sessionNameFor({ cwd: '/p/site' })).toBe('site');
  });

  it('без каталога остаётся имя — иначе сессия была бы безымянной', () => {
    // Безымянную сессию оконный трекер не найдёт по заголовку вовсе.
    expect(sessionNameFor({ cwd: '', name: 'site-2' })).toBe('site-2');
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cd ~/projects/js/windows11-manager && npm test -- project-helpers
```

Ожидается: падение, `sessionNameFor is not a function`.

- [ ] **Step 3: Написать функцию**

В `src/claude-wt/project-helpers.js`, сразу после `basenameOfCwd` (строка 10):

```js
/**
 * Имя новой сессии: чьё главнее — каталога или просьбы.
 *
 * По умолчанию каталог: так называет сессию ccfzf (`claude -n <basename>`), и
 * по этому же имени `openClaudeProject` ищет уже открытое окно по заголовку —
 * присланное имя перебило бы поиск и открыло второй терминал.
 *
 * У просьбы «заведи ещё одну» (`reuseOpen: false`) поиска нет вовсе, а
 * basename каталога занят той сессией, рядом с которой просят открыть новую.
 * Уникальное имя считает пикер по списку занятых (`uniqueSessionName`) — здесь
 * такого списка нет, — поэтому там главнее оно.
 */
function sessionNameFor({ cwd, name, reuseOpen = true } = {}) {
  const base = basenameOfCwd(cwd);
  const asked = typeof name === 'string' ? name.trim() : '';
  return reuseOpen ? (base || asked) : (asked || base);
}
```

И расширить экспорт в конце файла — заменить

```js
export {
  basenameOfCwd,
  pickOpenProjectSession,
```

на

```js
export {
  basenameOfCwd,
  sessionNameFor,
  pickOpenProjectSession,
```

Импорт в `project-helpers.test.js` (строки 2–9) расширить тем же именем.

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cd ~/projects/js/windows11-manager && npm test -- project-helpers
```

Ожидается: все тесты файла зелёные.

- [ ] **Step 5: Научить `openClaudeProject` не искать открытое**

В `src/claude-wt/project.js` заменить импорт (строка 7):

```js
import { basenameOfCwd, pickOpenProjectSession, planLaunchNew, profileForCwd } from './project-helpers.js';
```

на:

```js
import { pickOpenProjectSession, planLaunchNew, profileForCwd, sessionNameFor } from './project-helpers.js';
```

`basenameOfCwd` из импорта уходит: в этом файле он звался ровно один раз, в строке 47, и её забирает `sessionNameFor`. Оставленный импорт — это `no-unused-vars` у `npm run lint`.

Заменить докблок и заголовок функции (строки 36–47):

```js
/**
 * Focus the last open Claude session for a project cwd, or spawn a fresh
 * `claude -n <basename(cwd)>` there when none is on screen.
 *
 * @param {{ cwd: string, name: string, profile?: string }} opts
 * @returns {Promise<{ ok: boolean, action?: string, reason?: string, sessionId?: string, sessionName?: string }>}
 */
async function openClaudeProject({ cwd, name, profile } = {}) {
  if (typeof cwd !== 'string' || !cwd || typeof name !== 'string' || !name) {
    return { ok: false, reason: 'cwd and name are required' };
  }
  // Display name matches ccfzf "[+] new session" (`claude -n basename`).
  const sessionName = basenameOfCwd(cwd) || name;
```

на:

```js
/**
 * Focus the last open Claude session for a project cwd, or spawn a fresh
 * `claude -n <basename(cwd)>` there when none is on screen.
 *
 * `reuseOpen: false` — «заведи ещё одну»: оба поиска пропускаются, и терминал
 * открывается всегда. Просьба приходит от `^N` в ccfzf-picker, где человек
 * нажимает её именно потому, что сессия уже есть и нужна вторая. Умолчание
 * `true` оставляет проектный хоткей и Enter прежними.
 *
 * @param {{ cwd: string, name: string, profile?: string, reuseOpen?: boolean }} opts
 * @returns {Promise<{ ok: boolean, action?: string, reason?: string, sessionId?: string, sessionName?: string }>}
 */
async function openClaudeProject({ cwd, name, profile, reuseOpen = true } = {}) {
  if (typeof cwd !== 'string' || !cwd || typeof name !== 'string' || !name) {
    return { ok: false, reason: 'cwd and name are required' };
  }
  const sessionName = sessionNameFor({ cwd, name, reuseOpen });
```

Затем обернуть оба поиска (строки 49–71 в исходном файле — блок от `let res;` до конца ветки `byTitle`) так, чтобы при `reuseOpen === false` они не выполнялись вовсе. Целиком блок после проверки аргументов и до `const cfg = getClaudeWtConfig();` должен выглядеть так:

```js
  // Просьбе «заведи ещё одну» оба поиска не нужны и вредны: первый поднял бы
  // ту самую сессию, рядом с которой просят открыть новую, а второй — её окно
  // по заголовку. Заодно не читается список сессий, а он ходит на сетевой диск.
  if (reuseOpen) {
    let res;
    try {
      res = claudeWtSessions();
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    if (!res.ok) return { ok: false, reason: res.reason };

    const session = pickOpenProjectSession(res.sessions, cwd);
    if (session?.windowId && getWindowById(session.windowId)) {
      if (!(await focusTerminalWindow(session.windowId))) {
        return { ok: false, action: 'focus', reason: 'window is not on screen', sessionId: session.id };
      }
      return { ok: true, action: 'focus', sessionId: session.id };
    }

    const byTitle = findOpenTerminalByTitle(sessionName);
    if (byTitle) {
      if (!(await focusTerminalWindow(byTitle.id))) {
        return { ok: false, action: 'focus-title', reason: 'window is not on screen' };
      }
      return { ok: true, action: 'focus-title', sessionName };
    }
  }
```

Остальное (`const cfg = …` и дальше до конца функции) не меняется.

- [ ] **Step 6: Прогнать весь набор и закоммитить**

```bash
cd ~/projects/js/windows11-manager && npm test
git status --porcelain
git add src/claude-wt/project-helpers.js src/claude-wt/project-helpers.test.js src/claude-wt/project.js
git commit -m "feat(claude-wt): openClaudeProject умеет заводить сессию, не поднимая открытую"
```

Ожидается: весь набор зелёный. В индекс идут только три названных файла — в рабочем дереве могут лежать чужие правки.

---

### Task 5: Приёмник понимает `terminal-new`

**Files:**
- Modify: `~/projects/js/windows11-manager/src/commands/claude-commands.js` — `openProject` (строки 93–109) и обработчик `claude-session-open` (строки 173–218).
- Modify: `~/projects/js/windows11-manager/src/commands/claude-commands.test.js` — новые тесты рядом с существующими про `claude-session-open`.

**Interfaces:**
- Consumes: `winMan.openClaudeProject({ cwd, name, reuseOpen })` (Task 4).
- Produces: поддержку действия `terminal-new` в топике `claude-session-open`.

- [ ] **Step 1: Написать падающие тесты**

В `src/commands/claude-commands.test.js`, в тот же `describe`, где лежат тесты про `claude-session-open` (рядом с «открывает проект и без id — по одному каталогу»):

```js
  it('terminal-new заводит сессию, не поднимая открытую', async () => {
    // `^N` в пикере нажимают именно потому, что сессия уже есть: искать её
    // здесь значило бы поднять ту самую, рядом с которой просили открыть новую.
    const d = deps();
    await claudeCommands(d)['claude-session-open']({
      action: 'terminal-new', cwd: '/p/site', name: 'site-2',
    });
    expect(d.winMan.openClaudeProject).toHaveBeenCalledWith({
      cwd: '/p/site', name: 'site-2', reuseOpen: false,
    });
    expect(d.winMan.focusWindowById).not.toHaveBeenCalled();
  });

  it('terminal-new с id всё равно про каталог, а не про сессию', async () => {
    // Пикер id сюда не шлёт, но если он появится, поднимать сессию нельзя:
    // просили обратного.
    const d = deps();
    await claudeCommands(d)['claude-session-open']({
      id: 'abc', action: 'terminal-new', cwd: '/p/site', name: 'site-2',
    });
    expect(d.winMan.focusWindowById).not.toHaveBeenCalled();
    expect(d.winMan.openClaudeProject).toHaveBeenCalledWith({
      cwd: '/p/site', name: 'site-2', reuseOpen: false,
    });
  });

  it('terminal-new без каталога — сообщает человеку, а не молчит', async () => {
    const d = deps();
    await claudeCommands(d)['claude-session-open']({ action: 'terminal-new', name: 'site-2' });
    expect(d.winMan.openClaudeProject).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining('cwd'));
  });

  it('неизвестное действие по-прежнему отклоняется вслух', async () => {
    const d = deps();
    await claudeCommands(d)['claude-session-open']({ action: 'terminal-old', cwd: '/p/site' });
    expect(d.winMan.openClaudeProject).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('terminal-old'), 'warn');
  });
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cd ~/projects/js/windows11-manager && npm test -- claude-commands
```

Ожидается: первые три теста падают (`openClaudeProject` зовётся без `reuseOpen` либо не зовётся вовсе). Четвёртый должен проходить сразу — он про уже написанное поведение, и стоит здесь затем, чтобы правка его не сломала.

- [ ] **Step 3: Прокинуть `reuseOpen` через `openProject`**

В `src/commands/claude-commands.js` заменить сигнатуру и вызов (строки 93–96):

```js
  async function openProject(cwd, name) {
    let res;
    try {
      res = await winMan.openClaudeProject({ cwd, name: name || basenameOfCwd(cwd) });
```

на:

```js
  async function openProject(cwd, name, { reuseOpen = true } = {}) {
    const opts = { cwd, name: name || basenameOfCwd(cwd) };
    // Ключа `reuseOpen: true` в обычной просьбе нет: у `openClaudeProject` это
    // и так умолчание, а лишний ключ пришлось бы дописать в каждый
    // существующий тест, ничего этим не проверив.
    if (!reuseOpen) opts.reuseOpen = false;
    let res;
    try {
      res = await winMan.openClaudeProject(opts);
```

- [ ] **Step 4: Принять новое действие**

В том же файле заменить начало обработчика (строки 198–214):

```js
    async 'claude-session-open'(payload) {
      const { id, action, cwd, name } = parseIdPayload(payload);
      if (!action) return;
      if (action !== 'terminal') {
        log(`claude-wt session-open: unsupported action ${action}`, 'warn');
        return;
      }
      const found = id ? findSession(id) : null;
      if (found?.session) {
        await focusOrRestore(id, found.session);
        return;
      }
      const dir = typeof cwd === 'string' ? cwd.trim() : '';
      if (dir) {
        await openProject(dir, typeof name === 'string' ? name.trim() : '');
        return;
      }
```

на:

```js
    async 'claude-session-open'(payload) {
      const { id, action, cwd, name } = parseIdPayload(payload);
      if (!action) return;
      if (action !== 'terminal' && action !== 'terminal-new') {
        log(`claude-wt session-open: unsupported action ${action}`, 'warn');
        return;
      }
      const dir = typeof cwd === 'string' ? cwd.trim() : '';
      const asked = typeof name === 'string' ? name.trim() : '';
      // «Заведи ещё одну» — просьба про каталог и только про него. Сессию не
      // ищем даже при заданном id: нашлась бы та самая, рядом с которой просят
      // открыть новую, и вместо второго терминала человек получил бы подъём
      // первого — обратное тому, о чём просил.
      if (action === 'terminal-new') {
        if (!dir) {
          const reason = 'session-open: terminal-new нужен cwd проекта';
          log(`claude-wt ${reason}`, 'warn');
          notify(`claude-wt: ${reason}`);
          return;
        }
        await openProject(dir, asked, { reuseOpen: false });
        return;
      }
      const found = id ? findSession(id) : null;
      if (found?.session) {
        await focusOrRestore(id, found.session);
        return;
      }
      if (dir) {
        await openProject(dir, asked);
        return;
      }
```

Хвост обработчика (жалоба «нужен id известной сессии или cwd проекта») не меняется.

- [ ] **Step 5: Дописать докблок обработчика**

В докблоке `claude-session-open` (строки 173–197) заменить абзац

```js
     * Пока поддержано одно действие — `terminal`: остальные (cursor, explorer,
     * pr) осмысленны только там, где стоит человек, и пикер выполняет их у
     * себя.
```

на

```js
     * Поддержано два действия. `terminal` — «покажи мне проект»: сессию
     * поднимают, если она есть. `terminal-new` — «дай ещё один терминал»:
     * поиск пропускается целиком, и имя берётся из тела, потому что basename
     * каталога занят той сессией, рядом с которой просят открыть новую.
     * Остальные действия (cursor, explorer, pr) осмысленны только там, где
     * стоит человек, и пикер выполняет их у себя.
```

- [ ] **Step 6: Прогнать весь набор и закоммитить**

```bash
cd ~/projects/js/windows11-manager && npm test
git status --porcelain
git add src/commands/claude-commands.js src/commands/claude-commands.test.js
git commit -m "feat(claude-wt): terminal-new — открыть сессию, не поднимая существующую"
```

---

### Task 6: Документация

**Files:**
- Modify: `~/projects/js/ccfzf-picker/CLAUDE.md` — рядом с правилом «Проектный хоткей решения не принимает — он его пересылает».
- Modify: `~/.claude/skills/claude-wt/ccfzf-picker.md` — вне репозитория, коммитом не закрывается.

- [ ] **Step 1: Дописать правило в `CLAUDE.md`**

Сразу после абзаца «**Грамоту на передний план отменяет только неизвестный pid, но не просьбу.**» добавить:

```markdown
- **Терминал по каталогу открывает менеджер, а пикер — только там, где
  менеджера нет.** Enter на строке проекта шлёт `{action:"terminal", cwd}`,
  `^N` и пункт «New session» — `{action:"terminal-new", cwd, name}`; оба в
  `<base>/windows/claude-session-open`. Разница одна: `terminal` сначала ищет
  открытое окно этого каталога, `terminal-new` не ищет вовсе. Транспорт у обоих
  решает `chooseProjectOpenAction` (`open-transport.js`) — та же
  `chooseOpenTransport`, что и у Enter на строке сессии: менеджера просят
  только на машине трекера и при настроенном брокере, иначе остаётся местная
  `newSession`, и профиль там теряется по-честному — на такой машине
  `claudeWt.projects` не существует.

- **Имя новой сессии считает пикер, а не менеджер.** `uniqueSessionName` знает
  занятые имена (живые сессии плюс выданные за последнюю минуту), а менеджер
  такого списка не ведёт и взял бы basename каталога — то самое имя, которое
  занято открытой сессией. Два окна с одним заголовком трекер привязал бы к
  одной сессии. Поэтому в `terminal-new` имя едет в теле и на той стороне
  главнее каталога (`sessionNameFor` в `project-helpers.js`), а после удачной
  отправки занимается в `issuedNames` — иначе два быстрых `^N` дали бы одно имя
  дважды.
```

- [ ] **Step 2: Дописать абзац в скилл**

В `~/.claude/skills/claude-wt/ccfzf-picker.md`, следом за абзацем про проектный хоткей (тот, что заканчивается словами про запасную дорогу через страницу), добавить:

```markdown
Строка проекта в режиме `/a` ведёт себя так же, как хоткей: Enter шлёт
`{action:"terminal", cwd}` и получает подъём окна или новую сессию с профилем.
`^N` (и пункт меню «New session», в том числе на строке живой сессии) шлёт
`{action:"terminal-new", cwd, name}` — тот же топик, но поиск открытого окна
пропускается целиком. Имя в теле обязательно и считается в пикере: basename
каталога к этому моменту занят, а два окна с одним заголовком трекер привязал
бы к одной сессии. На машине без трекера или без брокера обе клавиши остаются
на прежней местной `newSession`, и профиль там теряется — соответствия
каталог → профиль на такой машине не существует.
```

- [ ] **Step 3: Прогнать стража и закоммитить**

```bash
cd ~/projects/js/ccfzf-picker && npm test
git status --porcelain
git add CLAUDE.md
git commit -m "docs(picker): правило — терминал по каталогу открывает менеджер"
```

Ожидается: `npm test` зелёный. Если страж `no-private-data` покраснел — в тексте оказался живой путь или имя машины; заменить на `/p/...`.

---

### Task 7: Выкатка и ручная проверка

Правки в обоих репозиториях, и деплой у каждого свой.

**Files:** правок нет.

- [ ] **Step 1: Отправить коммиты**

`deploy-win.sh` тянет ветку с GitHub, а не копирует рабочее дерево: без пуша он соберёт прежний код и отчитается об успехе.

```bash
cd ~/projects/js/ccfzf-picker && git push origin windows-mqtt-migrate
```

`deploy-pc.sh` у менеджера устроен так же — `git fetch origin && git checkout <ветка> && git pull --ff-only` на самой Windows-машине (строка 71), — поэтому его ветку тоже надо отправить:

```bash
cd ~/projects/js/windows11-manager && git push origin feat/claude-wt-agent-progress
```

- [ ] **Step 2: Выкатить менеджер и пикер**

```bash
cd ~/projects/js/windows11-manager && ./data/scripts/deploy-pc.sh
cd ~/projects/js/ccfzf-picker && bash data/scripts/deploy-win.sh
```

Менеджер первым: пикер после выкатки шлёт просьбы, которых старый приёмник не знает, и на `terminal-new` ответил бы `unsupported action` вместо открытия.

Проверить, что доехало именно новое:

По ssh на Windows-машине: `git log --oneline -1` в каталоге установленного
менеджера должен показать свежий коммит ветки. Команда с именем машины и её
путём — в `data/scripts/` (каталог под `.gitignore`).

- [ ] **Step 3: Проверить Enter на строке проекта**

На Windows: `^A` (режим `/a`), встать на проект с открытым окном, Enter.

Ожидается: поднимается существующее окно, второго терминала не появляется.

Затем на проекте без открытых окон: Enter открывает терминал с профилем этого проекта из `claudeWt.projects`, а не с профилем по умолчанию.

- [ ] **Step 4: Проверить `^N`**

Встать на проект с открытым окном, нажать `^N`.

Ожидается: открывается **второй** терминал того же проекта, с тем же профилем, и имя у него отличается от первого (`site-2` при занятом `site`). Заголовок видно в списке пикера после следующего опроса.

Затем то же самое на строке живой сессии: `^N` рядом с ней должен дать новую сессию того же каталога, с профилем.

- [ ] **Step 5: Проверить два быстрых `^N`**

Нажать `^N` дважды подряд, не дожидаясь появления первого окна в списке.

Ожидается: два терминала с разными именами (`site-2`, `site-3`). Одинаковые имена значили бы, что отметка в `issuedNames` не ставится.

- [ ] **Step 6: Проверить запасную дорогу**

Убрать `mqtt.host` из `%USERPROFILE%\.config\ccfzf-picker\config.yaml` (перезапуск не нужен — конфиг читается на каждую просьбу), нажать Enter на проекте с открытым окном.

Ожидается: открывается новая сессия профилем по умолчанию — прежнее поведение. Вернуть `mqtt.host` на место и убедиться, что подъём окна снова работает.

---

## Порядок и зависимости

Task 1 → Task 2 → Task 3: третья зовёт то, что заводят первые две. Task 4 → Task 5 — в этом порядке, но от задач пикера они не зависят и могут идти хоть первыми. Task 6 не зависит ни от чего. Task 7 — только после Task 3 и Task 5.
