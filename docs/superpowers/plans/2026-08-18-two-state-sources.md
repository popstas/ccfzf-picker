# Два источника состояния — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** пикер спрашивает два агрегатора — удалённый по ssh и местный без ssh — и показывает их сессии одним списком, под флагом `localSource`.

**Architecture:** в Rust вместо строки `ssh_host` живёт список `Vec<Source>`; каждый источник опрашивается своим вызовом, ответы сливаются чистой функцией `merge_states` в документ **прежней формы** (страница живёт полями `lastState` и о втором источнике не знает), а каждой строке проставляется поле `source`. Действия — открытие сессии, новая сессия, комментарий — берут адрес у строки, а не из `CONFIG.sshHost`. Местный `ccfzf` берётся из PATH, а если его там нет — из копии, вшитой в бинарь и распаковываемой рядом с конфигом (тот же приём, что у `terminal_helper`).

**Tech Stack:** Rust + Tauri 2 (`src-tauri`), ванильный JS без сборщика (`frontend-src`, загружается и как `<script>`, и как CommonJS-модуль в тестах), тесты — `node --test` через `npm test` и `cargo test`.

**Spec:** [docs/superpowers/specs/2026-08-18-two-state-sources-design.md](../specs/2026-08-18-two-state-sources-design.md)

## Global Constraints

- **Язык.** Всё, что видит человек, — по-английски (подписи, хинты, тексты ошибок в статуслайне). Комментарии, doc-комментарии и сообщения в `assert` — по-русски: они объясняют «почему».
- **Имена машин в репозиторий не возвращать.** Хост берётся из `~/.config/ccfzf-picker/config.yaml`. В тестах — только выдуманные `remote-host`, `host-a`, `example-host`. Сторож: `test/no-private-data.test.js`.
- **`;` в удалённой команде не ставить** — для Windows Terminal это разделитель панелей.
- **Второй сборки argv быть не должно.** Терминал встречается с командой ровно в `terminalArgv` (`frontend-src/open-strategy.js`). Сторож: «страница не собирает argv терминала мимо terminalArgv» в `test/open-strategy.test.js`.
- **Форма ответа для страницы не меняется.** `merge_states` отдаёт документ с теми же ключами, что и один `ccfzf --state`; новое только поле `source` у записей.
- **Литерал источника — `local`.** Он же значение поля `source` у местных строк. `sshHost`, буквально равный `local`, зарезервирован и работать не будет; это записано комментарием в коде.
- **Порядок источников: удалённый первым.** Дедуп разрешает споры в пользу первого.
- Запуск тестов: `npm test` (фронтенд) и `cd src-tauri && cargo test` (оболочка). `node --test test/` на этих версиях Node не работает — только `npm test`.

---

### Task 1: Тип источника и разрешение его из конфига

**Files:**
- Modify: `src-tauri/src/state_source.rs` (добавить в начало файла, до `fetch`)

**Interfaces:**
- Consumes: ничего.
- Produces:
  - `pub enum Source { Ssh(String), Local }` — `#[derive(Clone, Debug, PartialEq)]`
  - `pub const LOCAL_LABEL: &str = "local";`
  - `impl Source { pub fn label(&self) -> String; pub fn from_label(s: &str) -> Source; }`
  - `pub fn sources_from(config: &serde_json::Value) -> Vec<Source>`

- [ ] **Step 1: Написать падающие тесты**

В конец `src-tauri/src/state_source.rs`, в существующий `mod tests`, добавить (и поправить `use super::…` вверху модуля на `use super::{looks_like_session_id, sources_from, Source};`):

```rust
    /// Список источников — это весь ответ на вопрос «кого спрашивать».
    /// Пустой `sshHost` не источник, а ненастроенное поле; выключенный
    /// `localSource` не добавляет ничего.
    #[test]
    fn sources_come_from_the_config() {
        let cfg = serde_json::json!({"sshHost": "remote-host"});
        assert_eq!(sources_from(&cfg), vec![Source::Ssh("remote-host".into())]);

        let cfg = serde_json::json!({"sshHost": "remote-host", "localSource": true});
        assert_eq!(
            sources_from(&cfg),
            vec![Source::Ssh("remote-host".into()), Source::Local],
            "удалённый первым: дедуп разрешает споры в пользу первого"
        );

        let cfg = serde_json::json!({"localSource": true});
        assert_eq!(sources_from(&cfg), vec![Source::Local], "один местный — тоже рабочая настройка");

        assert_eq!(sources_from(&serde_json::json!({})), Vec::<Source>::new());
        assert_eq!(
            sources_from(&serde_json::json!({"sshHost": "  ", "localSource": false})),
            Vec::<Source>::new(),
            "пробелы — тот же пустой хост"
        );
        assert_eq!(sources_from(&serde_json::Value::Null), Vec::<Source>::new());
    }

    /// Метка источника уезжает в поле `source` каждой строки и возвращается
    /// обратно аргументом команды. Дорога круговая, и разъехаться половинкам
    /// нельзя: по метке потом выбирается транспорт.
    #[test]
    fn label_survives_the_round_trip() {
        for s in [Source::Ssh("user@remote-host".into()), Source::Local] {
            assert_eq!(Source::from_label(&s.label()), s);
        }
        assert_eq!(Source::Ssh("remote-host".into()).label(), "remote-host");
        assert_eq!(Source::Local.label(), "local");
    }
```

- [ ] **Step 2: Прогнать и убедиться, что не собирается**

Run: `cd src-tauri && cargo test sources_come_from_the_config`
Expected: FAIL — `cannot find function \`sources_from\``, `cannot find type \`Source\``.

- [ ] **Step 3: Написать реализацию**

В `src-tauri/src/state_source.rs`, сразу после `use`-строк:

```rust
/// Метка местного источника — она же значение поля `source` у его строк.
///
/// `sshHost`, буквально равный `local`, зарезервирован: обратный разбор
/// (`from_label`) принял бы его за местный источник и пошёл бы не по ssh.
/// Случай выдуманный, а вторая дорога различать их стоила бы поля рядом с
/// меткой в каждой строке ответа.
pub const LOCAL_LABEL: &str = "local";

/// Кого спрашивать. Дорог две, и они не сводятся друг к другу: у ssh чужой
/// шелл на той стороне, у местного вызова — свой процесс и никакого шелла.
#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    Ssh(String),
    Local,
}

impl Source {
    /// Как источник называется в поле `source` строки.
    ///
    /// `sshHost` отдаётся дословно, включая форму `user@host`: этой же строкой
    /// потом адресуются действия, и приведи её пикер к «красивому» имени
    /// машины — ssh пошёл бы не туда.
    pub fn label(&self) -> String {
        match self {
            Source::Ssh(host) => host.clone(),
            Source::Local => LOCAL_LABEL.to_string(),
        }
    }

    pub fn from_label(label: &str) -> Source {
        if label == LOCAL_LABEL {
            Source::Local
        } else {
            Source::Ssh(label.to_string())
        }
    }
}

/// Источники по конфигу. Пустой список — «спрашивать некого», и это
/// единственная проверка ненастроенности: раньше их было две (`check_ssh_host`
/// в Rust и `sshHostMissing()` на странице), и второе правило про то же самое
/// молчало бы, разойдясь с первым.
pub fn sources_from(config: &serde_json::Value) -> Vec<Source> {
    let mut out = Vec::new();
    let host = config
        .get("sshHost")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim();
    if !host.is_empty() {
        out.push(Source::Ssh(host.to_string()));
    }
    if config.get("localSource").and_then(|v| v.as_bool()) == Some(true) {
        out.push(Source::Local);
    }
    out
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd src-tauri && cargo test`
Expected: PASS (существующие тесты не тронуты).

- [ ] **Step 5: Коммит**

```bash
git add src-tauri/src/state_source.rs
git commit -m "feat(sources): тип источника состояния и его разрешение из конфига"
```

---

### Task 2: Местный `ccfzf` — из PATH, иначе из вшитой копии

**Files:**
- Create: подмодуль `vendor/ccfzf` (`git submodule add git@github.com:popstas/ccfzf.git vendor/ccfzf`)
- Create: `src-tauri/src/local_ccfzf.rs`
- Modify: `src-tauri/src/main.rs` (объявить модуль рядом с остальными `mod …;`)
- Modify: `src-tauri/build.rs` (сторож пересборки)

**Interfaces:**
- Consumes: `crate::state_path` из `main.rs` (уже есть, используется `terminal_helper`).
- Produces:
  - `pub fn choose(in_path: bool, vendored: Option<&str>) -> Result<(String, Vec<String>), String>` — чистая, тестируемая
  - `pub fn resolve() -> Result<(String, Vec<String>), String>` — настоящая: смотрит PATH, при нужде распаковывает вшитую копию
  - `pub fn on_path(name: &str) -> bool`

- [ ] **Step 1: Завести подмодуль**

```bash
git submodule add git@github.com:popstas/ccfzf.git vendor/ccfzf
git -C vendor/ccfzf checkout f82b797
test -s vendor/ccfzf/ccfzf && head -1 vendor/ccfzf/ccfzf
```

Expected: печатает `#!/usr/bin/env bash`.

- [ ] **Step 2: Написать падающий тест**

Создать `src-tauri/src/local_ccfzf.rs` с одним только тестовым модулем:

```rust
#[cfg(test)]
mod tests {
    use super::choose;

    /// PATH первым — и это не вкусовщина. На машине, где `ccfzf` уже стоит,
    /// он же переписывает `~/.ccfzf.sessions.json`, с которого живут оконный
    /// трекер, экспорт в Home Assistant и панель. Две разные версии над одним
    /// файлом были бы бедой, которую видно не сразу и не здесь.
    #[test]
    fn path_wins_over_the_bundled_copy() {
        assert_eq!(choose(true, Some("/tmp/ccfzf")).unwrap(), ("ccfzf".to_string(), vec![]));
    }

    /// Нет в PATH — зовём вшитую копию, и зовём её через bash: `ccfzf` это
    /// bash-обёртка вокруг встроенной python-программы, а не исполняемый
    /// питон.
    #[test]
    fn the_bundled_copy_runs_through_bash() {
        assert_eq!(
            choose(false, Some("/tmp/ccfzf")).unwrap(),
            ("bash".to_string(), vec!["/tmp/ccfzf".to_string()])
        );
    }

    /// Ни того, ни другого — отказ со словами. Молчание тут читалось бы как
    /// «местных сессий нет», а это другое утверждение.
    #[test]
    fn without_either_it_says_so() {
        let err = choose(false, None).unwrap_err();
        assert!(err.contains("ccfzf"), "текст обязан называть, чего не нашлось: {err}");
    }
}
```

- [ ] **Step 3: Прогнать и убедиться, что не собирается**

Добавить `mod local_ccfzf;` в `src-tauri/src/main.rs` рядом с прочими `mod` и запустить:

Run: `cd src-tauri && cargo test local_ccfzf`
Expected: FAIL — `cannot find function \`choose\` in this scope`.

- [ ] **Step 4: Написать реализацию**

В начало `src-tauri/src/local_ccfzf.rs`, до `mod tests`:

```rust
//! Чем звать `ccfzf` на этой машине.

/// Копия агрегатора, вшитая в бинарь.
///
/// Файл, а не зависимость: `ccfzf` живёт своим репозиторием (подмодуль
/// `vendor/ccfzf`), и человеку, поставившему пикер рядом с обычным claude,
/// ставить его отдельно негде. Приём тот же, что у `TERMINAL_HELPER`: файл —
/// продолжение бинаря и расходиться с ним не должен, поэтому пишется он на
/// каждый спрос, а не однажды.
const VENDORED: &str = include_str!("../../vendor/ccfzf/ccfzf");

/// Программа и её первые аргументы. Чистая: настоящий PATH и настоящий
/// домашний каталог в тесте не подделать.
pub fn choose(in_path: bool, vendored: Option<&str>) -> Result<(String, Vec<String>), String> {
    if in_path {
        return Ok(("ccfzf".to_string(), vec![]));
    }
    match vendored {
        Some(path) => Ok(("bash".to_string(), vec![path.to_string()])),
        None => Err(
            "ccfzf not found: install it, or check that the bundled copy can be written to the config directory"
                .to_string(),
        ),
    }
}

/// Есть ли программа в PATH. Своим перебором, а не крейтом `which`: дерево
/// зависимостей у пикера и так 323 крейта, а вопрос здесь на десять строк.
pub fn on_path(name: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| {
        let candidate = dir.join(name);
        candidate.is_file()
    })
}

/// Распаковать вшитую копию рядом с конфигом и вернуть путь к ней.
fn unpack() -> Result<String, String> {
    let path = crate::state_path("ccfzf")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    std::fs::write(&path, VENDORED).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("cannot chmod {}: {e}", path.display()))?;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Настоящее разрешение: PATH, иначе распакованная копия.
pub fn resolve() -> Result<(String, Vec<String>), String> {
    if on_path("ccfzf") {
        return choose(true, None);
    }
    let unpacked = unpack().ok();
    choose(false, unpacked.as_deref())
}
```

- [ ] **Step 5: Сторож пересборки**

В `src-tauri/build.rs` дописать рядом с уже стоящей строкой про фронтенд:

```rust
    // Копия агрегатора вшивается на компиляции (`include_str!`), и обновление
    // подмодуля обязано пересобирать крейт. Про сам `include_str!` cargo знает,
    // а про build.rs — нет: он решает про него до того, как хоть что-то наше
    // начнёт выполняться.
    println!("cargo:rerun-if-changed=../vendor/ccfzf/ccfzf");
```

- [ ] **Step 6: Прогнать тесты**

Run: `cd src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 7: Коммит**

```bash
git add .gitmodules vendor/ccfzf src-tauri/src/local_ccfzf.rs src-tauri/src/main.rs src-tauri/build.rs
git commit -m "feat(sources): вшитая копия ccfzf и выбор местного бинаря"
```

---

### Task 3: `fetch` и `set_comment` ходят по источнику

**Files:**
- Modify: `src-tauri/src/state_source.rs:23-58` (`fetch`, `ssh`), `:68-95` (`set_comment`)
- Modify: `src-tauri/src/main.rs` (команда `set_comment`, удаление `check_ssh_host`)

**Interfaces:**
- Consumes: `Source`, `Source::from_label` (Task 1); `local_ccfzf::resolve` (Task 2).
- Produces:
  - `pub fn fetch(source: &Source) -> Result<serde_json::Value, String>`
  - `pub fn set_comment(source: &Source, id: &str, text: &str, from: &str) -> Result<(), String>`
  - команда Tauri `set_comment(source: String, id: String, text: String, from: String)`

- [ ] **Step 1: Написать падающий тест**

В `mod tests` файла `src-tauri/src/state_source.rs`. Строку `use super::…`
вверху модуля расширить до
`use super::{comment_args, looks_like_session_id, sources_from, state_args, Source};`:

```rust
    /// Аргументы у двух дорог разные, и это не оплошность. Через ssh уезжает
    /// **одна строка**, которую заново разбирает удалённый шелл; местный вызов
    /// шелла не поднимает вовсе, и `--state` обязан быть отдельным аргументом.
    /// Склей мы их одинаково — местный ccfzf получил бы аргумент `ccfzf --state`.
    #[test]
    fn state_args_differ_by_transport() {
        assert_eq!(state_args(&Source::Ssh("remote-host".into())), vec!["ccfzf --state".to_string()]);
        assert_eq!(state_args(&Source::Local), vec!["--state".to_string()]);
    }

    /// То же и у комментария: id и имя машины едут аргументами по обеим
    /// дорогам, а текст — на stdin, потому что через ssh его разбирал бы шелл.
    #[test]
    fn comment_args_differ_by_transport() {
        let id = "b5a54ce3-a022-4c9a-aa91-e306d75bdc76";
        assert_eq!(
            comment_args(&Source::Ssh("remote-host".into()), id, "mac"),
            vec!["ccfzf".to_string(), "--comment".to_string(), id.to_string(), "mac".to_string()]
        );
        assert_eq!(
            comment_args(&Source::Local, id, "mac"),
            vec!["--comment".to_string(), id.to_string(), "mac".to_string()]
        );
    }
```

- [ ] **Step 2: Прогнать и убедиться, что не собирается**

Run: `cd src-tauri && cargo test state_args_differ_by_transport`
Expected: FAIL — `cannot find function \`state_args\``.

- [ ] **Step 3: Написать реализацию**

В `src-tauri/src/state_source.rs` заменить `fetch`, `ssh` и `set_comment` на:

```rust
/// Аргументы вызова `--state`, свои у каждой дороги.
///
/// Через ssh уезжает одна строка: её заново разбирает удалённый шелл, и
/// `ccfzf --state` там команда. Местный вызов шелла не поднимает вовсе —
/// `--state` обязан быть отдельным аргументом процесса.
fn state_args(source: &Source) -> Vec<String> {
    match source {
        Source::Ssh(_) => vec!["ccfzf --state".to_string()],
        Source::Local => vec!["--state".to_string()],
    }
}

/// То же для комментария. Текст сюда не входит: он уходит на stdin.
fn comment_args(source: &Source, id: &str, from: &str) -> Vec<String> {
    let mut out = match source {
        Source::Ssh(_) => vec!["ccfzf".to_string()],
        Source::Local => vec![],
    };
    out.push("--comment".to_string());
    out.push(id.to_string());
    out.push(from.to_string());
    out
}

/// Заготовка процесса для источника.
///
/// `hidden_command`, а не `Command::new`: на Windows иначе на каждый опрос
/// всплывает консольное окно, а опрос идёт раз в секунду.
fn command_for(source: &Source) -> Result<std::process::Command, String> {
    match source {
        Source::Ssh(host) => Ok(ssh(host)),
        Source::Local => {
            let (program, args) = crate::local_ccfzf::resolve()?;
            let mut cmd = hidden_command(&program);
            cmd.args(args);
            Ok(cmd)
        }
    }
}

/// Один вызов агрегатора.
///
/// Ответ не разбирается и не чинится: форму проверяет фронтенд той же
/// функцией, что и тесты. Здесь важно только отличить «не смогли спросить» от
/// «спросили, ответили не тем».
pub fn fetch(source: &Source) -> Result<serde_json::Value, String> {
    let out = command_for(source)?
        .args(state_args(source))
        .output()
        .map_err(|e| format!("failed to start: {e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("exited with {}: {}", out.status, err.trim()));
    }

    serde_json::from_slice(&out.stdout).map_err(|e| format!("bad json from ccfzf --state: {e}"))
}
```

`set_comment` — та же правка, тело сохраняется целиком, меняются первые строки:

```rust
pub fn set_comment(source: &Source, id: &str, text: &str, from: &str) -> Result<(), String> {
    if !looks_like_session_id(id) {
        return Err("not a session id".into());
    }
    let mut child = command_for(source)?
        .args(comment_args(source, id, from))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start: {e}"))?;
```

(дальше без изменений; в двух оставшихся `format!` слово `ssh` заменить на `ccfzf`.)

Функция `ssh(ssh_host)` остаётся как есть — она собирает опции таймаута и по-прежнему нужна ветке `Source::Ssh`.

- [ ] **Step 4: Переписать команду Tauri**

В `src-tauri/src/main.rs`: удалить `check_ssh_host` целиком (вместе с тестом `empty_ssh_host_is_a_config_error`) и заменить команду:

```rust
/// Записать комментарий к сессии на машине её источника.
///
/// Адрес называет строка, а не конфиг: с двумя источниками `CONFIG.sshHost`
/// перестал быть адресом чего бы то ни было — комментарий к местной сессии
/// уехал бы на удалённую машину, где такой сессии нет.
///
/// `async` обязателен: ssh идёт до пяти секунд (`ConnectTimeout`), а
/// синхронную команду Tauri выполняет в потоке цикла событий — окно замерло бы
/// на всё это время.
#[tauri::command]
async fn set_comment(
    source: String,
    id: String,
    text: String,
    from: String,
) -> Result<(), String> {
    let source = state_source::Source::from_label(&source);
    tauri::async_runtime::spawn_blocking(move || {
        state_source::set_comment(&source, &id, &text, &from)
    })
    .await
    .map_err(|e| format!("comment task failed: {e}"))?
}
```

- [ ] **Step 5: Прогнать тесты**

Run: `cd src-tauri && cargo test`
Expected: PASS. Сборка `poller.rs` в этот момент уже сломана (`fetch` сменил сигнатуру) — чинится в Task 5; чтобы шаг был проверяемым, временно поправить единственный вызов `crate::state_source::fetch(&host)` на `crate::state_source::fetch(&crate::state_source::Source::Ssh(host.clone()))`.

- [ ] **Step 6: Коммит**

```bash
git add src-tauri/src/state_source.rs src-tauri/src/main.rs src-tauri/src/poller.rs
git commit -m "feat(sources): вызовы агрегатора ходят по источнику, а не по sshHost"
```

---

### Task 4: `merge_states` — слияние ответов

**Files:**
- Create: `src-tauri/src/merge_state.rs`
- Modify: `src-tauri/src/main.rs` (`mod merge_state;`)

**Interfaces:**
- Consumes: `Source::label` (Task 1).
- Produces: `pub fn merge_states(parts: &[(Source, serde_json::Value)]) -> serde_json::Value`

- [ ] **Step 1: Написать падающие тесты**

Создать `src-tauri/src/merge_state.rs` с одним тестовым модулем:

```rust
#[cfg(test)]
mod tests {
    use super::merge_states;
    use crate::state_source::Source;

    fn remote() -> Source { Source::Ssh("remote-host".into()) }

    fn state(generated: i64, ids: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "generated": generated,
            "sessions": ids.iter().map(|id| serde_json::json!({"id": id})).collect::<Vec<_>>(),
        })
    }

    /// Каждой строке проставляется её источник: по нему потом выбирается
    /// транспорт действия и подставляется машина строке без окна.
    #[test]
    fn every_row_gets_its_source() {
        let out = merge_states(&[
            (remote(), state(10, &["a"])),
            (Source::Local, state(20, &["b"])),
        ]);
        let sessions = out["sessions"].as_array().unwrap();
        assert_eq!(sessions[0]["source"], "remote-host");
        assert_eq!(sessions[1]["source"], "local");
    }

    /// Пикер, стоящий на машине агрегатора, получит от обоих источников один и
    /// тот же список целиком. Без дедупа человек увидел бы каждую строку
    /// дважды — и это единственная причина, по которой отдельной проверки «а не
    /// та ли это машина» не заводится.
    #[test]
    fn the_same_id_appears_once() {
        let out = merge_states(&[
            (remote(), state(10, &["a", "b"])),
            (Source::Local, state(10, &["a", "b"])),
        ]);
        assert_eq!(out["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(out["sessions"][0]["source"], "remote-host", "первый источник побеждает");
    }

    /// Окна у сессии-двойника складываются, а не теряются: карточка рисуется
    /// на окно, и выброшенное окно — это исчезнувшая карточка.
    #[test]
    fn windows_of_a_duplicate_are_joined() {
        let a = serde_json::json!({
            "generated": 1,
            "sessions": [{"id": "a", "windows": [{"host": "host-a"}]}],
        });
        let b = serde_json::json!({
            "generated": 1,
            "sessions": [{"id": "a", "windows": [{"host": "host-b"}]}],
        });
        let out = merge_states(&[(remote(), a), (Source::Local, b)]);
        let windows = out["sessions"][0]["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 2);
    }

    /// Возраст ответа — по самому старому куску: максимум соврал бы про
    /// свежесть всей половины.
    #[test]
    fn generated_is_the_oldest_part() {
        let out = merge_states(&[(remote(), state(10, &["a"])), (Source::Local, state(20, &["b"]))]);
        assert_eq!(out["generated"], 10);
    }

    /// Проекты, снимки, зелийные строки и записи машин — те же правила, свои
    /// ключи. Ключ у каждого списка свой, и общего «id» тут нет.
    #[test]
    fn every_list_merges_by_its_own_key() {
        let a = serde_json::json!({
            "generated": 1, "sessions": [],
            "projects": [{"path": "/p"}],
            "snapshots": [{"id": "s"}],
            "zellij": [{"name": "z"}],
            "hosts": [{"host": "host-a"}],
        });
        let b = serde_json::json!({
            "generated": 1, "sessions": [],
            "projects": [{"path": "/p"}, {"path": "/q"}],
            "snapshots": [{"id": "s"}, {"id": "t"}],
            "zellij": [{"name": "z"}],
            "hosts": [{"host": "host-b"}],
        });
        let out = merge_states(&[(remote(), a), (Source::Local, b)]);
        assert_eq!(out["projects"].as_array().unwrap().len(), 2);
        assert_eq!(out["snapshots"].as_array().unwrap().len(), 2);
        assert_eq!(out["zellij"].as_array().unwrap().len(), 1);
        assert_eq!(out["hosts"].as_array().unwrap().len(), 2);
    }

    /// Старый агрегатор не отдаёт ни `projects`, ни `snapshots`, и это не
    /// ошибка: пикер и агрегатор выкатываются порознь.
    #[test]
    fn a_missing_list_is_not_an_error() {
        let out = merge_states(&[
            (remote(), serde_json::json!({"generated": 1, "sessions": [{"id": "a"}]})),
            (Source::Local, serde_json::json!({"generated": 1, "sessions": [{"id": "b"}], "projects": [{"path": "/p"}]})),
        ]);
        assert_eq!(out["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(out["projects"].as_array().unwrap().len(), 1);
    }

    /// Один источник — документ как приехал, плюс метка. Это самая частая
    /// дорога: `localSource` выключен у всех, кто не просил обратного.
    #[test]
    fn one_source_passes_through() {
        let out = merge_states(&[(remote(), serde_json::json!({
            "generated": 7, "sessions": [{"id": "a"}], "windowHost": "host-a", "windowPid": 42,
        }))]);
        assert_eq!(out["windowHost"], "host-a");
        assert_eq!(out["windowPid"], 42);
        assert_eq!(out["generated"], 7);
        assert_eq!(out["sessions"][0]["source"], "remote-host");
    }

    /// Мусор с той стороны не роняет поток: ответ не той формы просто не
    /// приносит строк.
    #[test]
    fn junk_does_not_panic() {
        let out = merge_states(&[
            (remote(), serde_json::json!("строка")),
            (Source::Local, serde_json::json!({"generated": 1, "sessions": [{"id": "a"}]})),
        ]);
        assert_eq!(out["sessions"].as_array().unwrap().len(), 1);
    }
}
```

- [ ] **Step 2: Прогнать и убедиться, что не собирается**

Добавить `mod merge_state;` в `src-tauri/src/main.rs`.

Run: `cd src-tauri && cargo test merge_state`
Expected: FAIL — `cannot find function \`merge_states\``.

- [ ] **Step 3: Написать реализацию**

В начало `src-tauri/src/merge_state.rs`:

```rust
//! Слияние ответов нескольких агрегаторов в один документ.

use crate::state_source::Source;
use serde_json::{Map, Value};

/// Списки, которые складываются, и ключ, по которому у каждого считается
/// двойник. Ключ у каждого свой: общего `id` тут нет, и таблица эта одна —
/// второй список разошёлся бы с первым молча, а видно это было бы только
/// пропавшей строкой.
const LISTS: [(&str, &str); 5] = [
    ("sessions", "id"),
    ("projects", "path"),
    ("snapshots", "id"),
    ("zellij", "name"),
    ("hosts", "host"),
];

/// Пометить строки источником — все списки, кроме `hosts`.
///
/// `hosts` — запись машины, а не строка списка: у неё уже есть своё имя, и
/// вопрос «кто про неё рассказал» к ней не задают.
fn tag(state: &mut Value, label: &str) {
    let Some(obj) = state.as_object_mut() else { return };
    for (list, _) in LISTS.iter().filter(|(l, _)| *l != "hosts") {
        let Some(rows) = obj.get_mut(*list).and_then(|v| v.as_array_mut()) else { continue };
        for row in rows {
            if let Some(fields) = row.as_object_mut() {
                fields.insert("source".to_string(), Value::String(label.to_string()));
            }
        }
    }
}

/// Ключ записи как строка, или None — такую запись не с чем сравнивать, и она
/// проходит как есть.
fn key_of(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// Склеить `windows` двойника. Окна не выбрасываются: карточка рисуется на
/// окно, и потерянное окно — это исчезнувшая карточка. Повторы отсеиваются по
/// самой записи целиком: своего ключа у окна нет.
fn join_windows(into: &mut Value, from: &Value) {
    let Some(extra) = from.get("windows").and_then(|v| v.as_array()) else { return };
    let mut merged = into
        .get("windows")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for w in extra {
        if !merged.contains(w) {
            merged.push(w.clone());
        }
    }
    if let Some(fields) = into.as_object_mut() {
        fields.insert("windows".to_string(), Value::Array(merged));
    }
}

/// Дописать список `incoming` к `out`, пропуская двойников.
fn merge_list(out: &mut Map<String, Value>, incoming: &Value, list: &str, key: &str) {
    let Some(rows) = incoming.get(list).and_then(|v| v.as_array()) else { return };
    let mut acc = out
        .get(list)
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for row in rows {
        match key_of(row, key) {
            Some(k) => match acc.iter_mut().find(|e| key_of(e, key).as_deref() == Some(k.as_str())) {
                // Первый источник побеждает: скалярные поля остаются его.
                Some(existing) => join_windows(existing, row),
                None => acc.push(row.clone()),
            },
            None => acc.push(row.clone()),
        }
    }
    out.insert(list.to_string(), Value::Array(acc));
}

/// Слить ответы в документ прежней формы.
///
/// Форма не меняется намеренно: страница живёт полями `lastState`
/// (`lastState.hosts`, `.snapshots`, `.windowHost`, `openIdsFromState`), и
/// отдай Rust два документа — правок было бы не десять, а сто, и каждая из
/// них молчаливая.
///
/// Верхние поля берутся у первого источника, включая легаси-пару
/// `windowHost`/`windowPid` (окно одно на весь ответ у старого агрегатора):
/// второй источник этой дороги не касается.
pub fn merge_states(parts: &[(Source, Value)]) -> Value {
    let mut tagged: Vec<Value> = parts
        .iter()
        .map(|(source, state)| {
            let mut copy = state.clone();
            tag(&mut copy, &source.label());
            copy
        })
        .collect();

    let mut out = match tagged.iter().find(|v| v.is_object()) {
        Some(first) => first.as_object().cloned().unwrap_or_default(),
        None => Map::new(),
    };
    // Первый объектный кусок уже лёг в out целиком — второй раз его списки
    // сливать не надо, иначе окна двойника склеились бы сами с собой.
    let mut seen_first = false;
    for state in tagged.iter_mut() {
        if !state.is_object() {
            continue;
        }
        if !seen_first {
            seen_first = true;
            continue;
        }
        for (list, key) in LISTS {
            merge_list(&mut out, state, list, key);
        }
    }

    // Возраст ответа — по самому старому куску: максимум соврал бы про
    // свежесть всей половины.
    let oldest = tagged
        .iter()
        .filter_map(|v| v.get("generated").and_then(|g| g.as_i64()))
        .min();
    if let Some(g) = oldest {
        out.insert("generated".to_string(), Value::from(g));
    }

    Value::Object(out)
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd src-tauri && cargo test merge_state`
Expected: PASS, все девять.

- [ ] **Step 5: Коммит**

```bash
git add src-tauri/src/merge_state.rs src-tauri/src/main.rs
git commit -m "feat(sources): слияние ответов агрегаторов в документ прежней формы"
```

---

### Task 5: Поллер опрашивает список источников

**Files:**
- Modify: `src-tauri/src/poller.rs:88` (поле `settings`), `:101-205` (поток), `:225-228` (`set_config`)
- Modify: `src-tauri/src/main.rs:1341-1350` (`apply_config`), `:1961-1970` (`setup`)

**Interfaces:**
- Consumes: `Source`, `sources_from` (Task 1), `fetch` (Task 3), `merge_states` (Task 4).
- Produces:
  - `Poller::start(app: tauri::AppHandle, sources: Vec<Source>, background: bool) -> Poller`
  - `Poller::set_config(&self, sources: Vec<Source>, background: bool)`
  - `pub fn poll_once(sources: &[Source]) -> (Option<serde_json::Value>, String)`

- [ ] **Step 1: Написать падающие тесты**

В `mod tests` файла `src-tauri/src/poller.rs`:

```rust
    use crate::state_source::Source;

    /// Отказ одного источника не гасит второй. Молчаливое выпадение половины
    /// списка — худшее, что здесь может случиться: пропавшие сессии читаются
    /// как «сессий нет», и человек пойдёт искать сессию, а не чинить ssh.
    #[test]
    fn one_failure_does_not_hide_the_other_source() {
        let parts = vec![
            (Source::Ssh("remote-host".into()), Err("exited with 255".to_string())),
            (Source::Local, Ok(serde_json::json!({"generated": 1, "sessions": [{"id": "a"}]}))),
        ];
        let (state, error) = combine(parts);
        let state = state.expect("ответивший источник обязан дать список");
        assert_eq!(state["sessions"].as_array().unwrap().len(), 1);
        assert!(error.contains("remote-host"), "отказ обязан называть источник: {error}");
    }

    /// Отказ всех — прежняя ошибка на весь список, и состояния нет.
    #[test]
    fn all_failing_is_still_an_error() {
        let parts = vec![
            (Source::Ssh("remote-host".into()), Err("exited with 255".to_string())),
            (Source::Local, Err("ccfzf not found".to_string())),
        ];
        let (state, error) = combine(parts);
        assert!(state.is_none());
        assert!(error.contains("remote-host") && error.contains("local"), "{error}");
    }

    /// Все ответили — ошибки нет вовсе.
    #[test]
    fn success_clears_the_error() {
        let parts = vec![(Source::Local, Ok(serde_json::json!({"generated": 1, "sessions": []})))];
        let (state, error) = combine(parts);
        assert!(state.is_some());
        assert_eq!(error, "");
    }
```

- [ ] **Step 2: Прогнать и убедиться, что не собирается**

Run: `cd src-tauri && cargo test one_failure_does_not_hide`
Expected: FAIL — `cannot find function \`combine\``.

- [ ] **Step 3: Написать `combine` и `poll_once`**

В `src-tauri/src/poller.rs`, рядом с `fingerprint`:

```rust
use crate::state_source::Source;

/// Сложить ответы источников в пару «состояние, текст отказа».
///
/// Чистая и отдельная от `poll_once`: настоящий ssh в тесте не поднять, а
/// правило «отказ одного не гасит второй» — единственное, что здесь можно
/// сделать неправильно.
///
/// Отказ называет источник поимённо: `local: ccfzf not found` и
/// `remote-host: exited with 255` — разные беды, и чинят их в разных местах.
pub fn combine(
    parts: Vec<(Source, Result<serde_json::Value, String>)>,
) -> (Option<serde_json::Value>, String) {
    let mut good = Vec::new();
    let mut errors = Vec::new();
    for (source, part) in parts {
        match part {
            Ok(state) => good.push((source, state)),
            Err(e) => errors.push(format!("{}: {e}", source.label())),
        }
    }
    let state = if good.is_empty() {
        None
    } else {
        Some(crate::merge_state::merge_states(&good))
    };
    (state, errors.join("; "))
}

/// Опросить все источники по очереди.
///
/// По очереди, а не параллельно: поток здесь один, источников два, а
/// таймауты у ssh уже выставлены (`ConnectTimeout=5`, `ServerAlive*`), то есть
/// худший случай ограничен. Второй поток стоил бы синхронизации ради секунд.
pub fn poll_once(sources: &[Source]) -> (Option<serde_json::Value>, String) {
    let parts = sources
        .iter()
        .map(|s| (s.clone(), crate::state_source::fetch(s)))
        .collect();
    combine(parts)
}
```

- [ ] **Step 4: Переписать поток**

В `Poller`: поле `settings: Arc<Mutex<(Vec<Source>, bool)>>`, сигнатуры `start` и `set_config` — с `sources: Vec<Source>`. В теле цикла заменить блок от `let host_missing` до конца ветки `if !idle` на:

```rust
                let (sources, background) = thread_settings.lock().unwrap().clone();

                // Спрашивать некого — единственная проверка ненастроенности.
                // Раньше их было две, и вторая молчала бы, разойдясь с первой.
                let idle = sources.is_empty() || (!visible && !background);
                if sources.is_empty() {
                    let mut cache = thread_cache.lock().unwrap();
                    cache.error =
                        "no sources: set sshHost or turn on localSource in ~/.config/ccfzf-picker/config.yaml"
                            .to_string();
                    if visible {
                        let body = payload(&cache);
                        drop(cache);
                        let _ = app.emit("state", body);
                    }
                }
                if !idle {
                    let (state, error) = poll_once(&sources);
                    let changed = match state {
                        Some(state) => {
                            let fp = fingerprint(&state);
                            let changed = prev_fingerprint.as_deref() != Some(fp.as_str());
                            prev_fingerprint = Some(fp);
                            crate::project_hotkeys::apply_from_state(&app, &state);
                            let mut cache = thread_cache.lock().unwrap();
                            cache.state = Some(state);
                            cache.error = error;
                            let body = payload(&cache);
                            drop(cache);
                            let _ = app.emit("state", body);
                            changed
                        }
                        None => {
                            let mut cache = thread_cache.lock().unwrap();
                            cache.error = error;
                            // Показанному окну об отказе говорим сразу;
                            // скрытому — некому, и оно узнает при показе.
                            if visible {
                                let body = payload(&cache);
                                drop(cache);
                                let _ = app.emit("state", body);
                            }
                            // Отказ — это «не изменилось»: сеть, лежащая
                            // десять минут, не повод десять минут долбить ssh.
                            false
                        }
                    };
                    delay = next_delay(visible, changed, delay);
                }
```

- [ ] **Step 5: Подключить в main.rs**

В `apply_config` и в `setup` заменить чтение `sshHost` на:

```rust
        let sources = state_source::sources_from(&config);
```

и передавать `sources` первым аргументом в `poller.set_config(...)` / `poller::Poller::start(...)`.

- [ ] **Step 6: Прогнать тесты**

Run: `cd src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 7: Коммит**

```bash
git add src-tauri/src/poller.rs src-tauri/src/main.rs
git commit -m "feat(sources): поллер опрашивает список источников, отказ одного не гасит второй"
```

---

### Task 6: `localSource` в конфиге и окне настроек

**Files:**
- Modify: `frontend-src/config-shape.js:12-50` (DEFAULTS), `:269` (normalizeConfig)
- Modify: `frontend-src/settings-form.js:63-64` (PAGES, general), `:374-376` (validate)
- Test: `test/settings-form.test.js`, `test/config-shape.test.js`

**Interfaces:**
- Consumes: ничего.
- Produces: поле `localSource: boolean` в нормализованном конфиге; поле формы `{ id: 'localSource', type: 'bool', default: false }`.

- [ ] **Step 1: Написать падающие тесты**

В `test/config-shape.test.js`:

```js
test('localSource — булев флаг с умолчанием false', () => {
  // Умолчание не «удобное», а единственно честное: включённый по умолчанию
  // местный источник на машине без ccfzf и python3 добавил бы всем
  // существующим установкам строку об отказе там, где сегодня всё работает.
  assert.strictEqual(normalizeConfig({}).localSource, false);
  assert.strictEqual(normalizeConfig({ localSource: true }).localSource, true);
  assert.strictEqual(normalizeConfig({ localSource: 'да' }).localSource, false);
});
```

В `test/settings-form.test.js`:

```js
test('пустой sshHost при включённом localSource — не ошибка', () => {
  // Источник есть, просто он один. Проверка ненастроенности теперь одна на
  // всё — пустой список источников, — и второе правило про то же самое
  // молчало бы, разойдясь с первым.
  const fields = { ...configToFields({ localSource: true }), ...NO_PICKER_SIZE, sshHost: '' };
  assert.deepStrictEqual(validate(fields), []);
});

test('ни sshHost, ни localSource — спрашивать некого', () => {
  const fields = { ...configToFields({}), ...NO_PICKER_SIZE, sshHost: '' };
  const problems = validate(fields);
  assert.ok(problems.some(p => p.includes('source')), problems.join('; '));
});
```

- [ ] **Step 2: Прогнать и убедиться, что падают**

Run: `npm test`
Expected: FAIL — `localSource` undefined; `validate` по-прежнему требует `sshHost`.

- [ ] **Step 3: Написать реализацию**

`frontend-src/config-shape.js`, в `DEFAULTS` сразу после `sshHost`:

```js
    // Второй источник списка: `ccfzf` на этой машине, без ssh. Выключен по
    // умолчанию, и это не осторожность, а честность: включённым он добавил бы
    // всем существующим установкам строку об отказе там, где сегодня всё
    // работает — `ccfzf` и python3 есть не везде. Linux и macOS: `ccfzf` это
    // bash-обёртка вокруг встроенной python-программы, на нативном Windows не
    // запустится ни она, ни вшитая копия.
    localSource: false,
```

в `normalizeConfig`, рядом со строкой `sshHost`:

```js
      localSource: typeof src.localSource === 'boolean' ? src.localSource : DEFAULTS.localSource,
```

`frontend-src/settings-form.js`, в `PAGES` (страница `general`) сразу после поля `sshHost`:

```js
        { id: 'localSource', label: 'Also show sessions from this machine', type: 'bool',
          default: false,
          hint: 'Runs ccfzf here, without ssh. Linux and macOS only.' },
```

и в `validate` заменить проверку `sshHost` на:

```js
    if (!String(fields.sshHost || '').trim() && !fields.localSource) {
      problems.push('no source: set the host with sessions, or turn on sessions from this machine');
    }
```

- [ ] **Step 4: Прогнать тесты**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add frontend-src/config-shape.js frontend-src/settings-form.js test/config-shape.test.js test/settings-form.test.js
git commit -m "feat(sources): флаг localSource в конфиге и окне настроек"
```

---

### Task 7: Источник в строке и машина у строки без окна

**Files:**
- Modify: `frontend-src/session-list.js:46-53` (`windowHostOf`), `:130-145` (сборка строки в `buildSessionList`)
- Test: `test/session-list.test.js`

**Interfaces:**
- Consumes: поле `source` у записи сессии (Task 4).
- Produces: у строки — поля `source` (строка) и `windowHost`, считанный с учётом источника.

- [ ] **Step 1: Написать падающие тесты**

В `test/session-list.test.js`:

```js
test('машину строке без окна называет её источник', () => {
  // При одном источнике «своей» считалась всякая строка без окна, и это было
  // верно. С двумя — соврёт: удалённая сессия без окна встала бы в блок
  // местных, и отличить её было бы нечем.
  const rows = buildSessionList({
    sessions: [
      { id: 'a', cwd: '/a', title: 'a', mtime: 1, live: true, kind: 'session', source: 'remote-host' },
      { id: 'b', cwd: '/b', title: 'b', mtime: 1, live: true, kind: 'session', source: 'local' },
    ],
    seen: {}, state: {}, configHost: 'host-a',
  });
  assert.strictEqual(rows.find(r => r.id === 'a').windowHost, 'remote-host');
  assert.strictEqual(rows.find(r => r.id === 'b').windowHost, '', 'местная сессия — своя');
});

test('запись окна главнее источника', () => {
  // Окно называет машину, на экране которой сессия видна; источник — машину, у
  // которой про неё спросили. Это разные вопросы, и первый главнее.
  const rows = buildSessionList({
    sessions: [{
      id: 'a', cwd: '/a', title: 'a', mtime: 1, live: true, kind: 'session',
      source: 'remote-host',
      windows: [{ host: 'host-b', pid: 7, lastSeen: 1 }],
    }],
    seen: {}, state: {}, configHost: 'host-a',
  });
  assert.strictEqual(rows[0].windowHost, 'host-b');
});

test('источник едет в строку полем', () => {
  // По нему выбирается транспорт действия: ssh или местный запуск.
  const rows = buildSessionList({
    sessions: [{ id: 'a', cwd: '/a', title: 'a', mtime: 1, live: true, kind: 'session', source: 'local' }],
    seen: {}, state: {}, configHost: 'host-a',
  });
  assert.strictEqual(rows[0].source, 'local');
});
```

- [ ] **Step 2: Прогнать и убедиться, что падают**

Run: `npm test`
Expected: FAIL — `windowHost` пуст у строки с `source: 'remote-host'`, `source` у строки отсутствует.

- [ ] **Step 3: Написать реализацию**

В `frontend-src/session-list.js` добавить рядом с `windowHostOf`:

```js
  /**
   * Машина, названная источником строки.
   *
   * Ответ на вопрос «чья это сессия» у строки без окна: раньше его давало
   * отсутствие окна («нет окна — значит своя»), и при одном источнике это было
   * верно. С двумя источниками так соврёшь: удалённая сессия без окна встала бы
   * в блок местных.
   *
   * Отдаётся дословно, как записан `sshHost`: этой же строкой адресуются
   * действия, и «красивое» имя машины увело бы ssh не туда.
   */
  function sourceHostOf(source) {
    const label = String(source || '').trim();
    if (!label || label === 'local') return '';
    return label;
  }
```

и в сборке строки внутри `buildSessionList` заменить строку `windowHost: windowHostOf(w, configHost),` на:

```js
      source: String(s.source || ''),
      // Запись окна главнее источника: окно называет машину, на экране которой
      // сессия видна, а источник — только ту, у которой про неё спросили.
      windowHost: windowHostOf(w, configHost) || sourceHostOf(s.source),
```

- [ ] **Step 4: Прогнать тесты**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add frontend-src/session-list.js test/session-list.test.js
git commit -m "feat(sources): источник строки и машина у строки без окна"
```

---

### Task 8: Транспорт действий — по источнику строки

**Files:**
- Modify: `frontend-src/open-strategy.js:205-240` (`buildOpenCommand`), экспорт
- Modify: `sessions.html:844-846` (`sshHostMissing`), `:2286-2299`, `:2545`, `:3009-3025`, `:3235`
- Test: `test/open-strategy.test.js`

**Interfaces:**
- Consumes: `row.source` (Task 7), метка `local` (Task 1).
- Produces:
  - `LOCAL_SOURCE = 'local'`
  - `commandParts(remote, source)` → `['ssh','-t',source,remote]` либо `['/bin/sh','-c',remote]`
  - `buildOpenCommand(row, strategy, opts)` — берёт источник из `row.source`, откатываясь на `opts.sshHost`

- [ ] **Step 1: Написать падающие тесты**

В `test/open-strategy.test.js`:

Модуль в этом файле уже подключён — добавить недостающие имена в существующий
деструктуринг:

```js
const { commandParts, buildOpenCommand, LOCAL_SOURCE } = require('../frontend-src/open-strategy');

test('местная команда идёт без ssh, но через интерактивный шелл', () => {
  // Строка команды та же: `exec $SHELL -ic` нужна ровно затем же, зачем и на
  // удалённой машине — поднять интерактивный шелл, чтобы отработал хук chpwd и
  // телеметрия получила имя проекта. Меняется только транспорт.
  const parts = commandParts("exec $SHELL -ic 'cd -- /a && claude'", LOCAL_SOURCE);
  assert.deepStrictEqual(parts, ['/bin/sh', '-c', "exec $SHELL -ic 'cd -- /a && claude'"]);
});

test('удалённая команда по-прежнему уезжает одной строкой в ssh', () => {
  const parts = commandParts('claude --resume x', 'remote-host');
  assert.deepStrictEqual(parts, ['ssh', '-t', 'remote-host', 'claude --resume x']);
});

test('buildOpenCommand берёт источник у строки, а не у конфига', () => {
  // CONFIG.sshHost перестал быть адресом чего бы то ни было: местная сессия
  // открылась бы на удалённой машине, где её нет вовсе.
  const row = { id: 'b5a54ce3-a022-4c9a-aa91-e306d75bdc76', cwd: '/a', source: LOCAL_SOURCE };
  const out = buildOpenCommand(row, 'resume', {
    sshHost: 'remote-host', terminal: { file: 'kitty', args: ['--hold'] },
  });
  assert.ok(!out.argv.includes('ssh'), `ssh в местной команде: ${JSON.stringify(out.argv)}`);
  assert.deepStrictEqual(out.argv.slice(0, 3), ['kitty', '--hold', '/bin/sh']);
});

test('строка без источника открывается по sshHost — как до этой правки', () => {
  const row = { id: 'b5a54ce3-a022-4c9a-aa91-e306d75bdc76', cwd: '/a' };
  const out = buildOpenCommand(row, 'resume', {
    sshHost: 'remote-host', terminal: { file: 'kitty', args: [] },
  });
  assert.deepStrictEqual(out.argv.slice(0, 4), ['kitty', 'ssh', '-t', 'remote-host']);
});
```

Плюс сторож на страницу — в том же файле, рядом с уже существующим про `terminalArgv`:

```js
test('страница не собирает ssh-хвост мимо commandParts', () => {
  // Поведением такое не поймать: argv тут собирается верным для удалённых
  // строк и молча неверным для местных — то есть ровно та же мина, что
  // взорвалась на `newSession` и iTerm2.
  const page = fs.readFileSync(require('path').join(__dirname, '..', 'sessions.html'), 'utf8');
  const hits = page.match(/'ssh',\s*'-t'/g) || [];
  assert.deepStrictEqual(hits, [], 'ssh-хвост собран на странице, а не в commandParts');
});
```

- [ ] **Step 2: Прогнать и убедиться, что падают**

Run: `npm test`
Expected: FAIL — `commandParts is not a function`; сторож находит два вхождения `'ssh', '-t'` в `sessions.html`.

- [ ] **Step 3: Написать реализацию в open-strategy.js**

Рядом с `HELPER_PLACEHOLDER`:

```js
  // Метка местного источника — та же строка, что в Rust (`LOCAL_LABEL`).
  const LOCAL_SOURCE = 'local';

  /**
   * Хвост argv до терминала: чем доставить команду до шелла.
   *
   * Две дороги, и они не сводятся друг к другу. Через ssh уезжает одна строка,
   * которую заново разбирает чужой шелл, — правило `q` действует ровно здесь.
   * Местный запуск шелла не поднимает вовсе, поэтому строка отдаётся `sh -c`:
   * сама команда (`exec $SHELL -ic 'cd -- … && …'`) не меняется — она нужна
   * затем же, зачем и на той стороне, чтобы отработал хук `chpwd`.
   */
  function commandParts(remote, source) {
    const label = String(source || '').trim();
    if (label === LOCAL_SOURCE) return ['/bin/sh', '-c', remote];
    return ['ssh', '-t', label, remote];
  }
```

В `buildOpenCommand` заменить последние строки:

```js
    if (remote === null) return null;
    // Источник — у строки; opts.sshHost остаётся откатом для строк, которым
    // источник не проставлен (старый ответ, тесты соседних функций).
    const source = String((row || {}).source || '') || String((opts || {}).sshHost || '');
    const argv = terminalArgv(terminal, commandParts(remote, source), opts);
    return argv === null ? null : { argv, destructive };
```

и дописать `commandParts, LOCAL_SOURCE` в объект экспорта.

- [ ] **Step 4: Переписать пять мест в sessions.html**

1. `sshHostMissing()` (около строки 844) → переименовать в `noSources()` и переписать тело; поправить оба вызова (около 2286 и 3009):

```js
  function noSources() {
    if ((CONFIG.sshHost && CONFIG.sshHost.trim()) || CONFIG.localSource) return false;
    error = 'no source: set the host with sessions, or turn on sessions from this machine in settings';
    render();
    return true;
  }
```

2. Открытие сессии (около 2288) — `sshHost: CONFIG.sshHost` в `opts` остаётся как откат, менять не надо: источник берётся из `row.source` внутри `buildOpenCommand`.

3. Текст предупреждения о перехвате (около 2299): `on ${CONFIG.sshHost}` → `on ${row.source || CONFIG.sshHost}`.

4. Комментарий (около 2545): `sshHost: CONFIG.sshHost` → `source: row.source || CONFIG.sshHost` (имя аргумента команды Tauri сменилось в Task 3).

5. `newSession` (около 3025): заменить сборку хвоста на `window.OpenStrategy.commandParts(remote, row.source || CONFIG.sshHost)`:

```js
      const argv = window.OpenStrategy.terminalArgv(
        CONFIG.terminal,
        window.OpenStrategy.commandParts(remote, row.source || CONFIG.sshHost),
        { helperPath: await helperPath() },
      );
```

6. Подсказка про буфер (около 3235): `on ${CONFIG.sshHost}` → `on ${row.source || CONFIG.sshHost}`.

- [ ] **Step 5: Прогнать тесты**

Run: `npm test`
Expected: PASS, включая оба сторожа на текст страницы.

- [ ] **Step 6: Коммит**

```bash
git add frontend-src/open-strategy.js sessions.html test/open-strategy.test.js
git commit -m "feat(sources): действия ходят к источнику своей строки"
```

---

### Task 9: Документация и выкатка

**Files:**
- Modify: `config.example.yml`, `README.md`, `CLAUDE.md`, `docs/TODO.md`
- Локально (не в гите, каталог `data/` под `.gitignore`): `data/scripts/deploy-win.sh`, `data/scripts/deploy-mac.sh`

**Interfaces:**
- Consumes: всё предыдущее.
- Produces: ничего кодового.

- [ ] **Step 1: `config.example.yml`**

Дописать рядом с `sshHost`:

```yaml
# Second source of the list: ccfzf on this machine, without ssh. Off by
# default. Linux and macOS only — ccfzf is a bash wrapper around an embedded
# python program, and neither it nor the bundled copy runs on native Windows.
# With it on, sshHost may be left empty: one source is a working setup.
localSource: false
```

- [ ] **Step 2: `README.md`**

В раздел про конфиг, сразу после описания `sshHost`, добавить:

```markdown
### Sessions from this machine

`localSource: true` adds a second source: the picker runs `ccfzf --state` here,
as a process, without ssh. Both lists are shown as one — a session keeps the
machine of its window, and a session with no window belongs to the source that
reported it.

`ccfzf` is taken from `PATH`. If it is not there, the picker unpacks the copy
built into the binary (`~/.config/ccfzf-picker/ccfzf`) and runs it through
`bash`. `PATH` comes first on purpose: on a machine where `ccfzf` is already
installed, it is the one that rewrites `~/.ccfzf.sessions.json` — the dump the
window tracker, the Home Assistant export and the openHASP panel live on.

Linux and macOS only: `ccfzf` is a bash wrapper around an embedded python
program, and neither it nor the bundled copy runs on native Windows.

With `localSource` on, `sshHost` may be left empty — one source is a working
setup. Local sessions get no window mark and no Enter-to-focus until the window
tracker on this machine learns to bind them; that is a separate task.
```

- [ ] **Step 3: `CLAUDE.md` — правило**

Дописать в раздел «Правила, за которые уже заплачено»:

```markdown
- **Источников состояния бывает два, и адрес действия называет строка.**
  `sshHost` — удалённый агрегатор, `localSource: true` — местный `ccfzf`,
  запускаемый процессом, без ssh (`ssh localhost` требовал бы sshd и своего
  ключа — на маке Remote Login выключен, на Windows сервера нет вовсе). Список
  источников считает `sources_from` в `state_source.rs`, опрашивает их
  `poll_once` в `poller.rs`, а ответы сливает `merge_states` — **в документ
  прежней формы**: страница живёт полями `lastState`, и два документа стоили бы
  не десяти правок, а ста.

  Дедуп в слиянии идёт по `id` (у проектов — `path`, у зелийных — `name`, у
  машин — `host`), первый источник побеждает, окна двойника складываются.
  Отдельной проверки «а не та ли это машина» нет намеренно: пикер на машине
  агрегатора получит от обоих источников один и тот же список целиком, и дедуп
  делает этот случай безвредным сам.

  Метка источника едет полем `source` у каждой строки и оттуда же берётся
  адресом действия — открытия, новой сессии, комментария. `CONFIG.sshHost`
  адресом больше не является: местная сессия открылась бы на удалённой машине,
  где её нет. Транспорт выбирает `commandParts` в `open-strategy.js`, и это
  единственное место, где команда встречается с дорогой, — по той же причине,
  по какой `terminalArgv` единственное место, где она встречается с терминалом.

  `sshHost`, буквально равный `local`, зарезервирован: обратный разбор
  (`Source::from_label`) принял бы его за местный источник.

  Отказ одного источника не гасит второй: список показывается по ответившим, а
  отказавшие называются в статуслайне поимённо. Молчаливое выпадение половины
  списка читалось бы как «сессий нет», а не как «спросить не удалось».

  Проверка ненастроенности теперь одна — пустой список источников. Прежних
  было две (`check_ssh_host` и `sshHostMissing()`), и второе правило про то же
  самое молчало бы, разойдясь с первым.
```

- [ ] **Step 4: `docs/TODO.md`**

Отметить `[x]` задачу про два источника в `# next`.

- [ ] **Step 5: Скрипты выкатки (локально, вне гита)**

В `data/scripts/deploy-win.sh` и `data/scripts/deploy-mac.sh` первый шаг `git pull` заменить на `git pull --recurse-submodules` (и добавить `git submodule update --init --recursive` следом). Без этого на целевой машине окажется пустой `vendor/ccfzf`, а отказ будет выглядеть как «ccfzf не найден».

- [ ] **Step 6: Прогнать всё**

Run: `npm test && cd src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 7: Коммит**

```bash
git add config.example.yml README.md CLAUDE.md docs/TODO.md
git commit -m "docs: два источника состояния — правило, пример конфига и README"
```

---

### Task 10: Живая проверка

**Files:** ничего не правится; при находках — точечные правки и коммит.

- [ ] **Step 1: Собрать и запустить на этой машине**

```bash
cd src-tauri && cargo build --release
```

- [ ] **Step 2: Проверить местный источник в одиночку**

В `~/.config/ccfzf-picker/config.yaml` временно: `localSource: true`, `sshHost` пуст. Открыть пикер.
Expected: список местных сессий, статуслайн без ошибки.

- [ ] **Step 3: Проверить оба источника**

Вернуть настоящий `sshHost`, оставить `localSource: true`.
Expected: строки обеих машин в одном списке; удалённые без окна стоят в блоке с именем `sshHost`, местные — в «Active local sessions»; повторов нет.

- [ ] **Step 4: Проверить открытие**

Enter на местной строке — терминал открывается здесь, каталог верный, `claude --resume` подхватывает сессию. Enter на удалённой — по ssh, как раньше. `^N` на строке проекта каждой машины.

- [ ] **Step 5: Проверить отказ одного источника**

Поставить заведомо несуществующий `sshHost`.
Expected: местные сессии на месте, в статуслайне — `<host>: exited with 255: …`; список не пуст.

- [ ] **Step 6: Проверить вшитую копию**

Временно убрать `ccfzf` из PATH (`PATH=/usr/bin:/bin` в окружении запуска пикера).
Expected: местные сессии по-прежнему приезжают; файл `~/.config/ccfzf-picker/ccfzf` создан и исполняем.

- [ ] **Step 7: Коммит находок**

Если что-то поправлено — коммит с описанием того, что именно не сработало живьём.

---

## Замечания для исполнителя

- **Про Windows.** Ветка местного источника там не работает и работать не
  должна: `ccfzf` — bash + python3. Тестов, требующих обратного, писать не надо;
  подпись в окне настроек об этом говорит.
- **Про `data/`.** Каталог под `.gitignore`: скрипты выкатки знают имена хостов
  конкретной установки. Правка из Task 9 Step 5 делается локально и не
  коммитится.
- **Про живость на маке.** `running_sessions()` в агрегаторе читает `/proc`;
  на macOS местные сессии приедут без `live`, если не стоят хуки claude-wt.
  Это не поломка этого плана — записано в спеке как то, что сюда не входит.
