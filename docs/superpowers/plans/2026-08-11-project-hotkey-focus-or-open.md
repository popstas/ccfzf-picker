# Проектный хоткей поднимает окно, а не плодит сессии — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Нажатие проектного хоткея поднимает окно последней открытой сессии этого каталога, а новую сессию заводит только когда поднимать нечего.

**Architecture:** Развилку «фокус или новая сессия» принимает windows11-manager — она у него уже написана (`openClaudeProject`) и достижима топиком `<base>/windows/claude-session-open` с телом без `id`. Нажатие доводит до неё Rust пикера, а не страница: хоткей нажимают, когда пикер скрыт, а у скрытого окна WebView2 умеет усыплять страницу целиком. Страница остаётся запасным путём на случай ненастроенного брокера.

**Tech Stack:** Rust (Tauri 2, `tauri-plugin-global-shortcut`, `rumqttc`), `cargo test`; фронтенд — ванильный JS, `node --test`.

**Спека:** [`docs/superpowers/specs/2026-08-11-project-hotkey-focus-or-open-design.md`](../specs/2026-08-11-project-hotkey-focus-or-open-design.md)

## Global Constraints

- Репозиторий публичный. `npm test` включает стража `test/no-private-data.test.js`, который ходит по `git ls-files`: живых домашних путей (`/home/<имя>`, `/Users/<имя>`, `\Users\<имя>`) и имён машин этой установки в коде, комментариях и документации быть не должно. Каталоги в фикстурах и примерах — `/p/one`, `/p/site`, как в существующих тестах.
- Комментарии и докстринги — по-русски, как весь файл, и объясняют **почему**, а не пересказывают код. Это принятый в репозитории стиль, см. соседние функции.
- Перед любой командой `cargo` в этой сессии: `. "$HOME/.cargo/env"`.
- Юнит-тестов на код, которому нужен живой `tauri::AppHandle`, в репозитории нет и заводить их не надо. Всё, что можно проверить, выносится чистой функцией рядом — так уже сделаны `plan`, `needs_reapply`, `reapply_list`, `picker_toggle`.
- Каталог `data/` под `.gitignore`: скрипты выкатки в коммиты не попадают.

---

### Task 1: Тело просьбы об открытии проекта

Просьба «открой проект по каталогу» отличается от сегодняшней «открой сессию» ровно одним: в теле нет `id`. Это отдельная пара «функция + сборщик тела» рядом с существующей.

**Files:**
- Modify: `src-tauri/src/mqtt.rs` — докстринг модуля (строки 1–13), новые `open_project` и `open_project_payload` рядом с `open` / `open_payload` (строки 97–126), новый тест в `mod tests`.

**Interfaces:**
- Consumes: `Broker`, `publish`, `OPEN_TOPIC` — уже есть в этом файле.
- Produces: `pub fn open_project(broker: &Broker, cwd: &str) -> Result<(), String>` — её зовёт Task 3.

- [ ] **Step 1: Написать падающий тест**

В `src-tauri/src/mqtt.rs`, в `mod tests`, сразу после `open_body_without_a_dir_carries_no_key`:

```rust
    // Тело просьбы проектного хоткея: каталог есть, `id` нет вовсе. Пустую
    // строку приёмник сегодня прочитал бы как «id нет» и просьбу не сломал бы,
    // но тело перестало бы говорить правду — то же правило, по которому здесь
    // же выброшен пустой `cwd`. А проверка `id !== undefined` на той стороне
    // сломала бы просьбу молча и не на глаз.
    #[test]
    fn open_project_body_carries_no_id() {
        assert_eq!(
            open_project_payload("/p/site"),
            r#"{"action":"terminal","cwd":"/p/site"}"#
        );
    }
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
. "$HOME/.cargo/env" && cd src-tauri && cargo test open_project_body_carries_no_id
```

Ожидается: ошибка компиляции `cannot find function open_project_payload in this scope`.

- [ ] **Step 3: Написать реализацию**

В `src-tauri/src/mqtt.rs`, после `open_payload` (сразу за строкой, закрывающей эту функцию, перед `restore_payload`):

```rust
/// Попросить открыть проект по каталогу — какую сессию, решит менеджер.
///
/// Отличается от `open()` тем, чего в теле нет: `id`. Проектный хоткей знает
/// только каталог, а какая сессия в нём последняя — вопрос к живым окнам
/// Windows, и отвечает на него `openClaudeProject` у менеджера, а не список
/// пикера: у скрытого окна тот отстаёт до восьми минут (бэкофф в `poller.rs`),
/// а при выключенном фоновом опросе не обновляется вовсе.
pub fn open_project(broker: &Broker, cwd: &str) -> Result<(), String> {
    publish(broker, OPEN_TOPIC, &open_project_payload(cwd))
}

/// Тело просьбы об открытии проекта: действие и каталог, без `id`.
///
/// Пустой `id` сюда класть не надо, хотя приёмник его и переживёт: ключ без
/// значения — это тело, которое врёт о том, что знает. Ровно по этому правилу
/// здесь же выброшен пустой `cwd` в `open_payload`.
fn open_project_payload(cwd: &str) -> String {
    serde_json::json!({ "action": "terminal", "cwd": cwd }).to_string()
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

```bash
. "$HOME/.cargo/env" && cd src-tauri && cargo test open_project
```

Ожидается: `open_project_body_carries_no_id ... ok`, и прежние `open_body_*` тоже зелёные.

- [ ] **Step 5: Поправить докстринг модуля**

Докстринг модуля перечисляет топики и тела; про `claude-session-open` он говорит, что `id` там обязателен, а необязателен только `cwd`. Теперь необязательны оба. Заменить эти две строки:

```rust
//! необязательным `sessionIds`, и `<base>/windows/claude-session-open` с телом
//! `{"id": …, "action": "terminal"}` и необязательным `cwd`), и придумывать
```

на эти три:

```rust
//! необязательным `sessionIds`, и `<base>/windows/claude-session-open` с телом
//! `{"action": "terminal"}`, где необязательны оба опознавателя — `id`
//! известной сессии и `cwd` проекта), и придумывать
```

Закрывающая скобка после `cwd` проекта обязана остаться: перечисление топиков — вставка в скобках, открытая выше на `(`<base>/windows/claude-focus``.

- [ ] **Step 6: Прогнать весь набор и закоммитить**

```bash
. "$HOME/.cargo/env" && cd src-tauri && cargo test
cd .. && npm test
git add src-tauri/src/mqtt.rs
git commit -m "feat(mqtt): просьба открыть проект по каталогу, без id в теле"
```

Ожидается: оба набора зелёные (`cargo test` — все тесты пакета, `npm test` — 361 тест).

---

### Task 2: Дребезг нажатия и pid трекера — чистые функции

Две вещи, которые нужны обработчику нажатия и которые можно проверить без живого приложения: «пропускать ли это нажатие» и «кому выдавать грамоту на передний план».

**Files:**
- Modify: `src-tauri/src/project_hotkeys.rs` — импорты (строки 3–6), новые константа и две функции, новое поле в `Registered` (строки 221–226), новые тесты в `mod tests`.

**Interfaces:**
- Consumes: ничего нового.
- Produces:
  - `pub const PRESS_DEBOUNCE: Duration`
  - `pub fn press_allowed(last: Option<Instant>, now: Instant, window: Duration) -> bool`
  - `pub fn tracker_pid_from(snapshot: &serde_json::Value) -> u32`
  - поле `pub presses: Mutex<HashMap<String, Instant>>` у `Registered`
  - `fn take_press(reg: &Registered, cwd: &str, now: Instant) -> bool`

  Всё это зовёт Task 3.

- [ ] **Step 1: Написать падающие тесты**

В `src-tauri/src/project_hotkeys.rs`, в конце `mod tests`:

```rust
    /// Удержанная клавиша — это очередь повторов, а не очередь просьб.
    ///
    /// `RegisterHotKey` на Windows шлёт `WM_HOTKEY` заново, пока клавишу
    /// держат, и все повторы приходят как `Pressed` — фильтр по состоянию их не
    /// отсекает. Без окна дребезга первые повторы успевают отработать раньше,
    /// чем окно нового терминала появится на экране и станет видно менеджеру,
    /// то есть плодят терминалы вместо повторного подъёма одного.
    #[test]
    fn a_held_key_asks_once() {
        let now = Instant::now();
        assert!(press_allowed(None, now, PRESS_DEBOUNCE));
        assert!(!press_allowed(Some(now), now, PRESS_DEBOUNCE));
        assert!(!press_allowed(
            Some(now - Duration::from_millis(900)),
            now,
            PRESS_DEBOUNCE
        ));
    }

    /// Нарочное второе нажатие через секунду проходит: окно дребезга — про
    /// палец на клавише, а не про запрет открывать проект дважды.
    #[test]
    fn a_deliberate_second_press_goes_through() {
        let now = Instant::now();
        assert!(press_allowed(
            Some(now - Duration::from_millis(1100)),
            now,
            PRESS_DEBOUNCE
        ));
    }

    /// Соседние проекты друг друга не глушат: отметка своя на каждый каталог.
    #[test]
    fn projects_do_not_silence_each_other() {
        let reg = Registered::default();
        let now = Instant::now();
        assert!(take_press(&reg, "/p/one", now));
        assert!(take_press(&reg, "/p/two", now));
        assert!(!take_press(&reg, "/p/one", now));
    }

    /// pid трекера лежит внутри `state`, а не рядом с ним: тело
    /// `Poller::snapshot()` — это `{state, error}`.
    #[test]
    fn the_tracker_pid_comes_from_inside_the_answer() {
        let snapshot = serde_json::json!({"state": {"windowPid": 4242}, "error": ""});
        assert_eq!(tracker_pid_from(&snapshot), 4242);
    }

    /// Ответа ещё нет, pid не число, pid ноль — грамоту выдавать некому.
    ///
    /// Ноль здесь не мелочь: `AllowSetForegroundWindow(0)` — это не «никому», а
    /// отдельное значение, и отдавать его системе по недосмотру не стоит.
    #[test]
    fn no_answer_means_no_grant() {
        assert_eq!(
            tracker_pid_from(&serde_json::json!({"state": null, "error": "ssh failed"})),
            0
        );
        assert_eq!(
            tracker_pid_from(&serde_json::json!({"state": {"windowPid": "4242"}})),
            0
        );
        assert_eq!(
            tracker_pid_from(&serde_json::json!({"state": {"windowPid": 0}})),
            0
        );
    }
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
. "$HOME/.cargo/env" && cd src-tauri && cargo test project_hotkeys
```

Ожидается: ошибки компиляции — `cannot find value PRESS_DEBOUNCE`, `cannot find function press_allowed`, `take_press`, `tracker_pid_from`, `no field presses`.

- [ ] **Step 3: Расширить импорты**

В `src-tauri/src/project_hotkeys.rs` заменить строки 3–4:

```rust
use std::str::FromStr;
use std::sync::{Mutex, Once};
```

на:

```rust
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Mutex, Once};
use std::time::{Duration, Instant};
```

- [ ] **Step 4: Добавить поле отметок в `Registered`**

Заменить объявление (строки 221–226):

```rust
#[derive(Default)]
pub struct Registered {
    pub state: Mutex<RegisteredState>,
    pub work: Mutex<Work>,
}
```

на:

```rust
#[derive(Default)]
pub struct Registered {
    pub state: Mutex<RegisteredState>,
    pub work: Mutex<Work>,
    /// Когда по каждому каталогу нажимали в прошлый раз — см. `PRESS_DEBOUNCE`.
    ///
    /// Отдельный мьютекс, а не поле в `RegisteredState`: тот берут и отпускают
    /// вокруг работы с плагином (см. `apply_once`), и добавлять туда что-то,
    /// что читается на каждое нажатие, значило бы связать нажатие клавиши с
    /// перевешиванием списка.
    pub presses: Mutex<HashMap<String, Instant>>,
}
```

- [ ] **Step 5: Написать константу и функции**

В `src-tauri/src/project_hotkeys.rs`, перед `pub fn apply` (строка 352 в исходном файле):

```rust
/// Окно дребезга проектного хоткея.
///
/// Секунда — оттуда же, откуда её взял ограничитель `keys/press-throttled` для
/// кнопок панели: ниже этого порога человек не нажимает нарочно.
pub const PRESS_DEBOUNCE: Duration = Duration::from_secs(1);

/// Пропустить ли нажатие: прошлое по этому же каталогу было достаточно давно.
///
/// Отдельно от отметок, чтобы правило проверялось `cargo test` без мьютекса и
/// без живого `AppHandle` — тем же приёмом, что `picker_toggle` в `main.rs`.
pub fn press_allowed(last: Option<Instant>, now: Instant, window: Duration) -> bool {
    match last {
        Some(previous) => now.duration_since(previous) >= window,
        None => true,
    }
}

/// Записать нажатие, если дребезг его пропускает.
fn take_press(reg: &Registered, cwd: &str, now: Instant) -> bool {
    let mut presses = reg.presses.lock().unwrap();
    if !press_allowed(presses.get(cwd).copied(), now, PRESS_DEBOUNCE) {
        return false;
    }
    presses.insert(cwd.to_string(), now);
    true
}

/// pid демона трекера из последнего ответа поллера; ноль — «грамоту выдавать
/// некому».
///
/// Форма та же, что у `focusPid` во фронтенде: конечное положительное число,
/// всё прочее — ноль. Читается из тела `Poller::snapshot()`, а оно
/// `{state, error}`: сам ответ агрегатора лежит под `state`, и там же
/// `windowPid`, который трекер кладёт в файл окон.
pub fn tracker_pid_from(snapshot: &serde_json::Value) -> u32 {
    snapshot
        .get("state")
        .and_then(|s| s.get("windowPid"))
        .and_then(|v| v.as_u64())
        .filter(|pid| *pid > 0 && *pid <= u32::MAX as u64)
        .unwrap_or(0) as u32
}
```

- [ ] **Step 6: Убедиться, что тесты проходят**

```bash
. "$HOME/.cargo/env" && cd src-tauri && cargo test project_hotkeys
```

Ожидается: пять новых тестов зелёные, прежние тесты модуля тоже.

- [ ] **Step 7: Коммит**

```bash
. "$HOME/.cargo/env" && cd src-tauri && cargo test && cd ..
git add src-tauri/src/project_hotkeys.rs
git commit -m "feat(hotkeys): дребезг нажатия и pid трекера — чистыми функциями"
```

---

### Task 3: Нажатие уходит менеджеру

Замыкание `on_shortcut` перестаёт быть однострочником и зовёт `press`, которая гасит пикер, выдаёт грамоту и публикует просьбу — а без брокера отдаёт нажатие прежней дороге.

Юнит-теста у `press` не будет: ей нужен живой `AppHandle`. Всё, что можно было вынести, вынесено в Task 2; остаётся склейка, и её проверяет сборка плюс ручная проверка в Task 5.

**Files:**
- Modify: `src-tauri/src/project_hotkeys.rs` — новая `press`, замыкание в `apply_once` (строки 396–404).

**Interfaces:**
- Consumes: `open_project` (Task 1); `PRESS_DEBOUNCE`, `press_allowed`, `take_press`, `tracker_pid_from`, `Registered.presses` (Task 2); из `main.rs` — `crate::hide_window`, `crate::allow_tracker_foreground`, `crate::load_config`, `crate::mqtt::broker_from_config`; из `poller.rs` — `crate::poller::Poller::snapshot`.
- Produces: `pub fn press(app: &tauri::AppHandle, cwd: &str)`.

- [ ] **Step 1: Написать `press`**

В `src-tauri/src/project_hotkeys.rs`, сразу после `tracker_pid_from` из Task 2:

```rust
/// Нажали проектный хоткей.
///
/// Развилку «поднять окно или завести сессию» принимает не пикер, а менеджер:
/// правило «последняя открытая сессия этого каталога» уже написано и покрыто
/// тестами у него (`pickOpenProjectSession`), список пикера у скрытого окна
/// отстаёт до восьми минут, и профиль Windows Terminal по каталогу знает тоже
/// только он. Отсюда уходит просьба, а не решение.
///
/// Живёт в этом файле, а не в `main.rs`: она про нажатие хоткея, а не про
/// пикер вообще, и читается вместе с тем, кто её вешает.
pub fn press(app: &tauri::AppHandle, cwd: &str) {
    if let Some(reg) = app.try_state::<Registered>() {
        if !take_press(&reg, cwd, Instant::now()) {
            return;
        }
    }
    // Гасим до просьбы, а не после: показанный пикер накрыл бы поднятое окно.
    // Та же причина, по которой гасит до публикации `focusSession` на странице.
    // Идемпотентна — уже скрытое окно повторно не гасит.
    crate::hide_window(app);

    let raw = crate::load_config().unwrap_or(serde_json::Value::Null);
    let broker = crate::mqtt::broker_from_config(&raw);
    if !broker.is_configured() {
        // Просить некого. Прежняя дорога: страница поднимет новую сессию сама —
        // это и было поведением до всей правки, и без брокера другого нет.
        let _ = app.emit("project-hotkey", cwd.to_string());
        return;
    }

    // Неизвестный pid отменяет грамоту, но не просьбу — и это сознательно иначе,
    // чем в `canFocus` на странице, где нулевой pid запрещает подъём целиком.
    // Там цена ошибки — открыть терминал у себя; здесь — молча завести второй
    // терминал на проект, у которого окно уже есть. Окно, поднятое без грамоты,
    // в худшем случае мигнёт кнопкой на таскбаре, и это дешевле.
    let pid = app
        .try_state::<crate::poller::Poller>()
        .map(|poller| tracker_pid_from(&poller.snapshot()))
        .unwrap_or(0);
    if pid > 0 {
        crate::allow_tracker_foreground(pid);
    }

    // Публикация ждёт подтверждения брокера до пяти секунд — держать на этом
    // поток, из которого плагин зовёт обработчик, нельзя. Ответа у просьбы нет
    // по замыслу, как у фокуса и восстановления: приёмник отчитывается в свой
    // журнал, а не нам.
    let cwd = cwd.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = crate::mqtt::open_project(&broker, &cwd) {
            eprintln!("ccfzf-picker: cannot ask to open {cwd}: {e}");
        }
    });
}
```

- [ ] **Step 2: Перевести замыкание на `press`**

В `apply_once` заменить (строки 396–404):

```rust
        let hooked = app
            .global_shortcut()
            .on_shortcut(shortcut, move |_app, _sc, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = handle.emit("project-hotkey", cwd.clone());
                }
            });
```

на:

```rust
        let hooked = app
            .global_shortcut()
            .on_shortcut(shortcut, move |_app, _sc, event| {
                if event.state() == ShortcutState::Pressed {
                    press(&handle, &cwd);
                }
            });
```

- [ ] **Step 3: Собрать и прогнать тесты**

```bash
. "$HOME/.cargo/env" && cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
```

Ожидается: сборка проходит, все тесты зелёные, clippy молчит. Если `cargo clippy` отвечает «no such command», компонент не установлен — пропустить, `cargo test` обязателен.

Если clippy ругается на неиспользуемый `Emitter` — он всё ещё нужен: `emit` зовётся и в `press`, и в `apply_once`. Импорт не трогать.

- [ ] **Step 4: Проверить, что запасная дорога цела**

Подписка `listen('project-hotkey')` в `sessions.html` не менялась и по-прежнему зовёт `newSession`. Убедиться командой:

```bash
grep -n "project-hotkey'" sessions.html
```

Ожидается: строка с `await listen('project-hotkey', (event) => {` на месте.

- [ ] **Step 5: Коммит**

```bash
npm test
git add src-tauri/src/project_hotkeys.rs
git commit -m "feat(hotkeys): нажатие просит менеджера поднять окно проекта"
```

---

### Task 4: Документация

Правило, за которое заплачено расследованием, обязано быть записано там, где его прочтут до следующей правки.

**Files:**
- Modify: `CLAUDE.md` — раздел с правилами о проектных хоткеях (после абзаца «Отказ регистрации проектного хоткея обязан быть виден», строки 219–224).
- Modify: `~/.claude/skills/claude-wt/ccfzf-picker.md` — вне репозитория, коммитом не закрывается.

- [ ] **Step 1: Дописать правило в `CLAUDE.md`**

После абзаца «**Отказ регистрации проектного хоткея обязан быть виден.**» добавить:

```markdown
- **Проектный хоткей решения не принимает — он его пересылает.** Нажатие уходит
  просьбой `{action:"terminal", cwd}` в `<base>/windows/claude-session-open`, а
  «поднять последнее окно этого каталога или завести новую сессию» решает
  `openClaudeProject` у windows11-manager. Решать это здесь нельзя по двум
  причинам: список у скрытого пикера отстаёт до восьми минут (бэкофф в
  `poller.rs`), а при выключённом фоновом опросе не обновляется вовсе; и
  профиль Windows Terminal по каталогу знает только менеджер —
  собранная здесь команда `wt.exe` его теряет. Шлёт просьбу Rust, а не
  страница: у скрытого окна WebView2 умеет усыплять её целиком, а хоткей
  нажимают ровно тогда, когда пикер скрыт. Страница остаётся запасной дорогой
  на случай ненастроенного брокера — там она поднимает новую сессию, как
  раньше.

- **Грамоту на передний план отменяет только неизвестный pid, но не просьбу.**
  В `canFocus` на странице нулевой `windowPid` запрещает подъём целиком, здесь
  — наоборот. Цена ошибки разная: там альтернатива подъёму безобидная (открыть
  терминал у себя), здесь — второй терминал на проект, у которого окно уже
  есть. Окно, поднятое без `AllowSetForegroundWindow`, в худшем случае мигнёт
  кнопкой на таскбаре; лишний терминал человек закрывает руками.
```

- [ ] **Step 2: Дописать абзац в скилл**

В `~/.claude/skills/claude-wt/ccfzf-picker.md`, в раздел «Хоткеи связки — чтобы не столкнулись», после таблицы:

```markdown
Проектный хоткей открывает сессию только там, где открывать нечего. Нажатие
уходит просьбой `{action:"terminal", cwd}` в
`<base>/windows/claude-session-open`, а развилку принимает `openClaudeProject`
в windows11-manager: последняя открытая сессия этого каталога — её окно (со
сменой виртуального стола), нет открытой — запасной поиск окна WT по
заголовку, нет и его — `claude -n <basename(cwd)>` с профилем из
`claudeWt.projects`. Публикует Rust пикера (`press` в `project_hotkeys.rs`), не
страница: у скрытого окна WebView2 умеет усыплять её целиком. Симптом «хоткей
завёл второй терминал на проект, у которого окно уже открыто» — просьба ушла
не туда или брокер в конфиге пикера не настроен, и сработала запасная дорога
через страницу.
```

- [ ] **Step 3: Прогнать стража и закоммитить**

```bash
npm test
git add CLAUDE.md
git commit -m "docs(hotkeys): правило — хоткей пересылает решение, а не принимает его"
```

Ожидается: `npm test` зелёный. Если страж `no-private-data` покраснел — в тексте оказался живой путь или имя машины; заменить на `/p/...`.

---

### Task 5: Выкатка и ручная проверка

Единственное, чего не проверяет ни один тест: примет ли Windows `AllowSetForegroundWindow` от процесса, который не на переднем плане и получил только `WM_HOTKEY`.

**Files:** правок нет.

- [ ] **Step 1: Выкатить пикер**

```bash
bash data/scripts/deploy-win.sh
```

Скрипт собирает и поднимает пикер на Windows-машине через `schtasks` — напрямую из ssh он попал бы в session 0, где нет ни трея, ни рабочего стола.

- [ ] **Step 2: Проверить подъём окна**

На Windows: открыть проект, у которого хоткей задан в `claudeWt.projects`, дождаться, пока его сессия появится в пикере со значком окна. Уйти в другое приложение, переключиться на другой виртуальный стол, нажать хоткей.

Ожидается: экран переходит на стол этого окна, окно Windows Terminal поднимается на передний план, второго терминала не появляется.

Если окно не поднялось, а в журнале windows-mqtt на этот момент есть строка `claude-wt session-open <cwd>: focus` — просьба доехала и менеджер отработал, значит отказала грамота. Обход описан в спеке: показать окно пикера на миг перед грамотой. Это отдельная правка, в этот план она не входит.

- [ ] **Step 3: Проверить открытие новой сессии**

Закрыть все окна этого проекта, нажать хоткей.

Ожидается: открывается окно Windows Terminal с профилем этого проекта из `claudeWt.projects` (не профилем по умолчанию), внутри `claude -n <имя каталога>`.

- [ ] **Step 4: Проверить дребезг**

Зажать хоткей на три секунды на проекте без открытых окон.

Ожидается: ровно одно новое окно.

- [ ] **Step 5: Проверить запасную дорогу**

Временно убрать `mqtt.host` из `%USERPROFILE%\.config\ccfzf-picker\config.yaml`, сохранить, нажать хоткей на проекте с открытым окном.

Ожидается: открывается новая сессия — прежнее поведение. Вернуть `mqtt.host` на место и убедиться, что подъём окна снова работает.

---

## Порядок и зависимости

Task 1 → Task 2 → Task 3 обязаны идти в этом порядке: Task 3 зовёт то, что заводят первые две. Task 4 не зависит ни от чего и может идти параллельно. Task 5 — только после Task 3.
