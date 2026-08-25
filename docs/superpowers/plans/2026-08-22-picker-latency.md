# Задержка списка у скрытого пикера — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** скрытый пикер узнаёт о появившемся или закрывшемся окне за секунды, а не за восемь минут, не заводя ни одного постоянного опроса.

**Architecture:** три несвязанные правки. Трекер роняет локальный файл-сигнал при смене **состава** привязанных окон; поток опроса пикера спит секундными кусками и на смену отпечатка опрашивает немедленно. Отдельно пикер после своего же действия, кончающегося терминалом, делает всплеск из трёх опросов с принудительным обновлением дампа (`CCFZF_STATE_DUMP_MAX_AGE=0`). Довеском — порт маковской развилки `wanted` на Windows-трекер.

**Tech Stack:** Rust (Tauri 2, `serde_json`) в пикере и маковском трекере; Node (vitest) в windows11-manager; python внутри bash в агрегаторе `ccfzf`.

**Spec:** `docs/superpowers/specs/2026-08-22-picker-latency-design.md` — читать вместе с планом, все «почему» там.

## Global Constraints

- **Язык.** Всё, что видит человек, — по-английски; комментарии, doc-комментарии и сообщения в `assert` — по-русски. Правило проекта, не пожелание.
- **Имена тестов — на языке соседних тестов того же файла.** В `ccfzf-picker` и `ccfzf` они русские, в `windows11-manager` и `macos-windows-manager` английские; вставленный не в тон тест читался бы как чужой.
- **Имена машин в репозиторий не возвращать.** `test/no-private-data.test.js` это проверяет; в тестах брать `remote-host` и `my-mac`, настоящих имён не писать.
- **Путь сигнала:** `<HOME или USERPROFILE>/.config/ccfzf-picker/tracker-signal.json`. Один и тот же во всех трёх репозиториях, дословно.
- **Ключ в файле сигнала:** `print`, строка. Содержимое отпечатка контрактом **не является** — каждый трекер считает свой; контракт это путь, имя ключа и правило «файл пишется только на смену отпечатка, сердцебиения нет».
- **Переменная окружения:** `CCFZF_STATE_DUMP_MAX_AGE`. Значение `0` (и любое отрицательное) значит «переписать дамп всегда».
- **Расписание всплеска:** 3, 8, 20 секунд.
- **Порядок выкатки не важен ни в одну сторону** — обе половины деградируют в сегодняшнее поведение.
- Тесты: пикер — `npm test` (node --test) и `cd src-tauri && cargo test`; `ccfzf` — `python3 tests/<файл>.py`; windows11-manager — `npx vitest run <файл>`; macos-windows-manager — `cargo test`.

## Структура файлов

| Файл | Ответственность | Задача |
|---|---|---|
| `vendor/ccfzf/ccfzf` | `env_int`, порог `stale_dump`, вызов в режиме `state` | 1 |
| `vendor/ccfzf/tests/test_state_dump_age.py` | сторож переменной | 1 |
| `src-tauri/src/state_source.rs` | как переменная доезжает до агрегатора по обеим дорогам | 2 |
| `src-tauri/src/tracker_signal.rs` | **новый**: разбор файла сигнала и правило «изменилось ли» | 3 |
| `src-tauri/src/poller.rs` | нарезка сна, всплеск, `Signal::Opened` | 4 |
| `src-tauri/src/main.rs` | `opened()` в пяти ветках, команда состояния сигнала, сторожа | 5, 6 |
| `settings.html` | строка `Tracker signal` на вкладке Window | 6 |
| `windows11-manager/src/claude-wt/windows-file-helpers.js` | `signalPrint`, `shouldWriteSignal`, путь | 7 |
| `windows11-manager/src/claude-wt/index.js` | запись сигнала в тике; спрос на индекс | 7, 9 |
| `windows11-manager/src/claude-wt/sessions.js` | чтение индекса мимо `MAX_AGE_MS` | 9 |
| `macos-windows-manager/crates/mwm-core/src/publish.rs` | `signal_print` | 8 |
| `macos-windows-manager/src-tauri/src/main.rs` | запись сигнала в тике | 8 |

Задачи 1-6 — репозиторий пикера (1 внутри сабмодуля `vendor/ccfzf`, коммит там свой), 7 и 9 — windows11-manager, 8 — macos-windows-manager. Порядок задач внутри репозитория обязателен; между репозиториями — любой.

---

### Task 1: `ccfzf` слушается `CCFZF_STATE_DUMP_MAX_AGE`

**Files:**
- Modify: `vendor/ccfzf/ccfzf` (строка 27 — шапка; ~2901 — `stale_dump`; ~3310 — вызов в режиме `state`)
- Test: `vendor/ccfzf/tests/test_state_dump_age.py` (создать)

**Interfaces:**
- Consumes: ничего.
- Produces: `env_int(name, default) -> int`; `stale_dump(path, now, max_age) -> bool` с новым правилом «`max_age <= 0` значит True»; переменная `CCFZF_STATE_DUMP_MAX_AGE`, которой пользуется задача 2.

ВНИМАНИЕ: `vendor/ccfzf` — сабмодуль со своим репозиторием. Коммит делается **внутри** `vendor/ccfzf`, а в пикере отдельным коммитом двигается указатель сабмодуля (шаг 6).

- [x] **Step 1: Написать падающий тест**

Создать `vendor/ccfzf/tests/test_state_dump_age.py`:

```python
"""Переменная CCFZF_STATE_DUMP_MAX_AGE. Запуск: python3 tests/test_state_dump_age.py"""
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness

CC = harness.load()
SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ccfzf")


def test_zero_means_rewrite_always():
    """Ноль значит «переписывать всегда»."""
    with tempfile.NamedTemporaryFile(suffix=".json") as f:
        now = time.time()
        assert not CC["stale_dump"](f.name, now, 30), "по обычному сроку файл свеж"
        assert CC["stale_dump"](f.name, now, 0), "ноль значит переписывать всегда"


def test_negative_is_the_same_as_zero():
    """Отрицательный срок — тот же ноль."""
    with tempfile.NamedTemporaryFile(suffix=".json") as f:
        assert CC["stale_dump"](f.name, time.time(), -1)


def test_empty_path_never_goes_stale():
    """Дамп выключен — писать нечего, и ноль этого не меняет."""
    assert not CC["stale_dump"]("", time.time(), 0)


def test_env_overrides_the_default():
    """Переменная перебивает умолчание."""
    os.environ["CCFZF_STATE_DUMP_MAX_AGE"] = "0"
    try:
        assert CC["env_int"]("CCFZF_STATE_DUMP_MAX_AGE", 30) == 0
    finally:
        del os.environ["CCFZF_STATE_DUMP_MAX_AGE"]


def test_garbage_env_falls_back_to_the_default():
    """Опечатка в переменной не должна ронять ответ, ради которого запуск."""
    os.environ["CCFZF_STATE_DUMP_MAX_AGE"] = "быстро"
    try:
        assert CC["env_int"]("CCFZF_STATE_DUMP_MAX_AGE", 30) == 30
    finally:
        del os.environ["CCFZF_STATE_DUMP_MAX_AGE"]


def test_missing_env_gives_the_default():
    """Нет переменной — прежние тридцать секунд."""
    os.environ.pop("CCFZF_STATE_DUMP_MAX_AGE", None)
    assert CC["env_int"]("CCFZF_STATE_DUMP_MAX_AGE", 30) == 30


def test_state_mode_reads_the_variable():
    """Вызов stale_dump обязан спрашивать переменную, иначе всплеск пикера уйдёт впустую."""
    src = open(SRC, encoding="utf-8").read()
    assert 'env_int("CCFZF_STATE_DUMP_MAX_AGE", STATE_DUMP_MAX_AGE)' in src


def test_the_header_documents_the_variable():
    """Переменная описана в шапке рядом с остальными."""
    src = open(SRC, encoding="utf-8").read()
    assert "CCFZF_STATE_DUMP_MAX_AGE" in src.split("PYEOF")[0]


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
```

- [x] **Step 2: Убедиться, что тест падает**

Run: `cd vendor/ccfzf && python3 tests/test_state_dump_age.py`
Expected: FAIL — `KeyError: 'env_int'`.

- [x] **Step 3: Реализация**

В `vendor/ccfzf/ccfzf` рядом с `stale_dump` (~2900) добавить:

```python
def env_int(name, default):
    """Целое из окружения, с откатом на умолчание.

    Порченое значение — не отказ: переменную ставит машина (пикер зовёт
    `--state` со своим `CCFZF_STATE_DUMP_MAX_AGE=0` во всплеске после открытия
    сессии), и опечатка в ней не должна ронять весь ответ, ради которого
    запуск и затевался.
    """
    try:
        return int(os.environ.get(name, ""))
    except ValueError:
        return default
```

В `stale_dump` после проверки пустого пути добавить строку:

```python
    if max_age <= 0:
        return True
```

и абзац в её docstring:

```
    Ноль (и любое отрицательное) значит «переписывать всегда», и проверяется
    он отдельной строкой, а не общим сравнением: mtime дробный, и у файла,
    написанного в ту же секунду, `now - mtime > 0` — подбрасывание монетки.
    Просит этот ноль всплеск опроса в пикере, и от него зависит, увидит ли
    трекер только что заведённую сессию.
```

Заменить вызов (~3310):

```python
    if stale_dump(sessions_path, now, env_int("CCFZF_STATE_DUMP_MAX_AGE", STATE_DUMP_MAX_AGE)):
```

В шапке скрипта, после строки про `CCFZF_WINDOWS_FILE` (~35):

```
#   CCFZF_STATE_DUMP_MAX_AGE         seconds; --state rewrites the sessions
#                                    dump when it is older than this
#                                    (default 30; 0 — rewrite every time)
```

- [x] **Step 4: Тесты зелёные**

Run: `cd vendor/ccfzf && python3 tests/test_state_dump_age.py && python3 tests/test_state_mode.py`
Expected: PASS оба.

- [x] **Step 5: Коммит в сабмодуле**

```bash
cd vendor/ccfzf
git add ccfzf tests/test_state_dump_age.py
git commit -m "feat: CCFZF_STATE_DUMP_MAX_AGE — заставить --state переписать дамп"
```

- [x] **Step 6: Двинуть указатель сабмодуля в пикере**

```bash
cd ../..
git add vendor/ccfzf
git commit -m "chore: vendor/ccfzf — переменная порога дампа"
```

---

### Task 2: пикер умеет просить свежий дамп

**Files:**
- Modify: `src-tauri/src/state_source.rs:70-140` (`state_args`, `command_for`, `fetch`) и `mod tests` в конце файла
- Modify: `src-tauri/src/poller.rs:86` (`poll_once`) и её единственный вызов в потоке (`:180`)

**Interfaces:**
- Consumes: переменная `CCFZF_STATE_DUMP_MAX_AGE` из задачи 1.
- Produces: `state_source::fetch(source: &Source, fresh_dump: bool) -> Result<serde_json::Value, String>`; `poller::poll_once(sources: &[Source], fresh_dump: bool) -> (Option<serde_json::Value>, String)`; `pub const state_source::DUMP_ENV: &str`.

- [x] **Step 1: Написать падающие тесты**

В `src-tauri/src/state_source.rs`, в существующий `mod tests`:

```rust
    #[test]
    fn свежий_дамп_едет_приставкой_только_по_ssh() {
        // По ssh команду разбирает шелл той стороны, и переменная едет строкой.
        assert_eq!(
            state_args(&Source::Ssh("remote-host".into()), true),
            vec!["CCFZF_STATE_DUMP_MAX_AGE=0 ccfzf --state".to_string()]
        );
        // Местный вызов шелла не поднимает вовсе: там переменная ставится
        // процессу через Command::env, и в аргументах ей делать нечего.
        assert_eq!(state_args(&Source::Local, true), vec!["--state".to_string()]);
    }

    #[test]
    fn обычный_опрос_дамп_не_просит() {
        assert_eq!(
            state_args(&Source::Ssh("remote-host".into()), false),
            vec!["ccfzf --state".to_string()]
        );
        assert_eq!(state_args(&Source::Local, false), vec!["--state".to_string()]);
    }

    #[test]
    fn имя_переменной_одно_на_обе_дороги() {
        // Разойдись приставка с именем в Command::env — одна дорога просила бы
        // дамп, а вторая молча нет, и заметить это можно было бы только на той
        // машине, где живёт вторая.
        assert!(dump_env_prefix(true).starts_with(DUMP_ENV));
        assert_eq!(dump_env_prefix(false), "");
    }
```

- [x] **Step 2: Убедиться, что не компилируется**

Run: `cd src-tauri && cargo test state_source`
Expected: FAIL — `this function takes 1 argument but 2 arguments were supplied`.

- [x] **Step 3: Реализация**

В `src-tauri/src/state_source.rs`:

```rust
/// Переменная, которой пикер просит агрегатор переписать дамп немедленно.
///
/// Имя названо здесь один раз на обе дороги: по ssh оно уезжает приставкой к
/// команде, местному вызову ставится через `Command::env`. Второе написание
/// разошлось бы с первым молча — ответ пришёл бы прежний, а дамп остался бы
/// старым, и всплеск опроса ушёл бы впустую.
pub const DUMP_ENV: &str = "CCFZF_STATE_DUMP_MAX_AGE";

/// Приставка к удалённой команде.
fn dump_env_prefix(fresh_dump: bool) -> String {
    if fresh_dump {
        format!("{DUMP_ENV}=0 ")
    } else {
        String::new()
    }
}
```

`state_args` получает второй аргумент:

```rust
fn state_args(source: &Source, fresh_dump: bool) -> Vec<String> {
    match source {
        Source::Ssh(_) => vec![format!("{}ccfzf --state", dump_env_prefix(fresh_dump))],
        Source::Local => vec!["--state".to_string()],
    }
}
```

`command_for` — тоже:

```rust
fn command_for(source: &Source, fresh_dump: bool) -> Result<std::process::Command, String> {
    match source {
        Source::Ssh(host) => Ok(ssh(host)),
        Source::Local => {
            let (program, args) = crate::local_ccfzf::resolve()?;
            let mut cmd = hidden_command(&program);
            cmd.args(args);
            if fresh_dump {
                cmd.env(DUMP_ENV, "0");
            }
            Ok(cmd)
        }
    }
}
```

`fetch`:

```rust
pub fn fetch(source: &Source, fresh_dump: bool) -> Result<serde_json::Value, String> {
    let out = command_for(source, fresh_dump)?
        .args(state_args(source, fresh_dump))
        .output()
        .map_err(|e| format!("failed to start: {e}"))?;
```

(остальное тело `fetch` не меняется)

В `poller.rs`:

```rust
pub fn poll_once(sources: &[Source], fresh_dump: bool) -> (Option<serde_json::Value>, String) {
    let parts = sources
        .iter()
        .map(|s| (s.clone(), crate::state_source::fetch(s, fresh_dump)))
        .collect();
    combine(parts)
}
```

Единственный вызов в потоке (`poller.rs:180`) пока получает `false` — всплеск приедет задачей 4.

Существующий тест `state_args` (~286) поправить под новую арность: добавить вторым аргументом `false`.

- [x] **Step 4: Тесты зелёные**

Run: `cd src-tauri && cargo test`
Expected: PASS.

- [x] **Step 5: Коммит**

```bash
git add src-tauri/src/state_source.rs src-tauri/src/poller.rs
git commit -m "feat(poller): опрос умеет просить свежий дамп у агрегатора"
```

---

### Task 3: разбор файла сигнала

**Files:**
- Create: `src-tauri/src/tracker_signal.rs`
- Modify: `src-tauri/src/main.rs` (объявить `mod tracker_signal;` рядом с остальными модулями; `fn state_path` сделать `pub(crate)`)

**Interfaces:**
- Consumes: `main::state_path(name) -> Result<PathBuf, String>` (`main.rs:1966`).
- Produces: `tracker_signal::FILE: &str`; `tracker_signal::print_of(&str) -> Option<String>`; `tracker_signal::decide(&mut Option<String>, &mut bool, Option<String>) -> bool`; `tracker_signal::Watcher::new(Option<PathBuf>) -> Watcher`; `Watcher::changed(&mut self) -> bool`; `Watcher::age_secs(&self) -> Option<u64>`.

- [x] **Step 1: Написать падающий тест**

Создать `src-tauri/src/tracker_signal.rs` с одним только блоком тестов (реализация — следующим шагом):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn отпечаток_достаётся_из_поля_print() {
        assert_eq!(
            print_of(r#"{"print":"abc","generated":1}"#),
            Some("abc".to_string())
        );
    }

    #[test]
    fn порченый_файл_это_отсутствие_сигнала_а_не_отказ() {
        // Четыре входа, и все четыре значат одно: сказать нечего. Отказ здесь
        // был бы хуже молчания — сигнал это добавка, а не условие работы.
        assert_eq!(print_of(""), None);
        assert_eq!(print_of("не json"), None);
        assert_eq!(print_of(r#"{"generated":1}"#), None);
        assert_eq!(print_of(r#"{"print":42}"#), None);
    }

    #[test]
    fn первое_чтение_не_считается_изменением() {
        // Иначе каждый старт пикера начинался бы с лишнего похода по ssh.
        let (mut last, mut started) = (None, false);
        assert!(!decide(&mut last, &mut started, Some("a".into())));
        assert_eq!(last, Some("a".to_string()));
    }

    #[test]
    fn другой_отпечаток_значит_опроси_сейчас() {
        let (mut last, mut started) = (None, false);
        decide(&mut last, &mut started, Some("a".into()));
        assert!(decide(&mut last, &mut started, Some("b".into())));
    }

    #[test]
    fn тот_же_отпечаток_ничего_не_значит() {
        let (mut last, mut started) = (None, false);
        decide(&mut last, &mut started, Some("a".into()));
        assert!(!decide(&mut last, &mut started, Some("a".into())));
    }

    #[test]
    fn пропавший_файл_не_стирает_запомненное() {
        // Трекер переписывает файл через tmp+rename, и чтение попадает в эту
        // щель. Считай мы пропажу изменением — каждая перезапись стоила бы
        // двух опросов вместо одного.
        let (mut last, mut started) = (None, false);
        decide(&mut last, &mut started, Some("a".into()));
        assert!(!decide(&mut last, &mut started, None));
        assert_eq!(last, Some("a".to_string()));
        assert!(!decide(&mut last, &mut started, Some("a".into())));
    }

    #[test]
    fn без_пути_сторож_молчит() {
        // Ни HOME, ни USERPROFILE — функция выключена целиком, как и всё
        // прочее, что живёт в этом каталоге.
        let mut w = Watcher::new(None);
        assert!(!w.changed());
        assert_eq!(w.age_secs(), None);
    }
}
```

- [x] **Step 2: Убедиться, что тест падает**

Run: `cd src-tauri && cargo test tracker_signal`
Expected: FAIL — `cannot find function print_of in this scope`.

- [x] **Step 3: Реализация**

Тело `src-tauri/src/tracker_signal.rs` (над блоком тестов):

```rust
//! Сигнал оконного трекера этой машины.
//!
//! Трекер и пикер живут на одной машине, поэтому дорога тут файловая, а не
//! сетевая: ни брокера, ни подписки, ни соединения. Трекер роняет файл, когда
//! меняется **состав** привязанных окон, — то самое, из-за чего снимок
//! скрытого пикера врёт проектному хоткею. Отпечаток внутри файла каждый
//! трекер считает свой; контракт — путь, имя ключа и правило «пишется только
//! на смену», сердцебиения у файла нет.

/// Имя файла в `~/.config/ccfzf-picker/`.
pub const FILE: &str = "tracker-signal.json";

/// Отпечаток из текста файла.
///
/// Пустой, не разбирается, нет поля, поле не строка — всё это «сигнала нет», а
/// не отказ.
pub fn print_of(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    Some(value.get("print")?.as_str()?.to_string())
}

/// Значит ли прочитанное «опроси сейчас».
///
/// Отдельно от чтения файла, потому что правил здесь три и все три
/// молчаливые: первое чтение не считается изменением, «сигнала нет» не стирает
/// запомненное, и только непустой, отличающийся отпечаток значит «опроси».
pub fn decide(last: &mut Option<String>, started: &mut bool, fresh: Option<String>) -> bool {
    let Some(fresh) = fresh else { return false };
    let changed = *started && last.as_deref() != Some(fresh.as_str());
    *last = Some(fresh);
    *started = true;
    changed
}

/// Сторож файла: помнит прошлый отпечаток и жалуется на порченый файл однажды.
pub struct Watcher {
    path: Option<std::path::PathBuf>,
    last: Option<String>,
    started: bool,
    warned: bool,
}

impl Watcher {
    pub fn new(path: Option<std::path::PathBuf>) -> Watcher {
        Watcher { path, last: None, started: false, warned: false }
    }

    /// Изменился ли состав окон с прошлого спроса.
    pub fn changed(&mut self) -> bool {
        let Some(path) = self.path.clone() else { return false };
        let text = std::fs::read_to_string(&path).ok();
        let fresh = text.as_deref().and_then(print_of);
        // Жалоба однажды: файл читается раз в секунду, и непрерывная ругань
        // была бы своей собственной бедой.
        if fresh.is_none() && text.is_some() && !self.warned {
            self.warned = true;
            eprintln!("[picker] tracker signal at {} is unreadable", path.display());
        }
        decide(&mut self.last, &mut self.started, fresh)
    }

    /// Сколько секунд назад трекер трогал файл.
    ///
    /// Для строки в окне настроек: разъедься путь между репозиториями, сигнал
    /// молча перестал бы приходить, и отличить это от «ничего не менялось»
    /// было бы нечем.
    pub fn age_secs(&self) -> Option<u64> {
        let modified = std::fs::metadata(self.path.as_ref()?).ok()?.modified().ok()?;
        Some(modified.elapsed().ok()?.as_secs())
    }
}
```

В `main.rs` добавить `mod tracker_signal;` рядом с остальными объявлениями модулей, а `fn state_path` (`main.rs:1966`) сделать `pub(crate) fn state_path`.

- [x] **Step 4: Тесты зелёные**

Run: `cd src-tauri && cargo test tracker_signal`
Expected: PASS, 7 тестов.

- [x] **Step 5: Коммит**

```bash
git add src-tauri/src/tracker_signal.rs src-tauri/src/main.rs
git commit -m "feat(picker): разбор сигнального файла трекера"
```

---

### Task 4: нарезка сна и всплеск в потоке опроса

**Files:**
- Modify: `src-tauri/src/poller.rs` (константы вверху, `enum Signal`, тело потока ~152-236, `mod tests`)

**Interfaces:**
- Consumes: `tracker_signal::Watcher` (задача 3), `poll_once(sources, fresh_dump)` (задача 2), `crate::state_path` (задача 3).
- Produces: `poller::SIGNAL_TICK: Duration`; `poller::BURST: [Duration; 3]`; `poller::burst_next(step: usize) -> Option<(usize, Duration)>`; `Poller::opened(&self)`.

- [x] **Step 1: Написать падающие тесты**

В `src-tauri/src/poller.rs`, в `mod tests`:

```rust
    #[test]
    fn расписание_всплеска_три_шага_и_конец() {
        assert_eq!(BURST.len(), 3, "расписание названо в спеке: 3, 8, 20 секунд");
        assert_eq!(BURST[0], Duration::from_secs(3));
        assert_eq!(burst_next(0), Some((1, Duration::from_secs(8))));
        assert_eq!(burst_next(1), Some((2, Duration::from_secs(20))));
        assert_eq!(burst_next(2), None, "после третьего шага — обычный бэкофф");
    }

    #[test]
    fn первый_шаг_всплеска_не_раньше_трёх_секунд() {
        // Раньше — впустую: терминал ещё не поднялся, сессия ещё не родилась.
        assert!(BURST[0] >= Duration::from_secs(3));
    }

    #[test]
    fn кусок_сна_короче_фонового_такта() {
        assert_eq!(SIGNAL_TICK, Duration::from_secs(1));
        assert!(SIGNAL_TICK < BACKGROUND_MIN, "иначе сигнал ничего бы не ускорил");
    }

    #[test]
    fn сигнал_не_будит_выключенный_фон() {
        // Текстовый: поведение потока в тесте не поднять, а правило молчаливое
        // — разреши мы сторожу работать при idle, выключенный человеком
        // фоновый опрос воскресал бы сам собой.
        let src = include_str!("poller.rs");
        let body = src
            .split_once("let watching = ")
            .expect("выбор сторожа пропал — тест сторожит не то")
            .1;
        let (body, _) = body.split_once(';').expect("строка не закрыта");
        assert!(body.contains("!idle"), "сторож смотрится только при работающем фоне");
        assert!(body.contains("!visible"), "показанное окно и так опрашивает раз в секунду");
    }

    #[test]
    fn всплеск_просит_свежий_дамп_а_обычный_опрос_нет() {
        // Без принудительного дампа всплеск ушёл бы впустую: STATE_DUMP_MAX_AGE
        // в агрегаторе тридцать секунд, а весь всплеск укладывается в двадцать.
        let src = include_str!("poller.rs");
        assert!(
            src.contains("let fresh_dump = burst.is_some();"),
            "свежий дамп просят ровно опросы всплеска"
        );
    }
```

- [x] **Step 2: Убедиться, что тесты падают**

Run: `cd src-tauri && cargo test poller`
Expected: FAIL — `cannot find value BURST in this scope`.

- [x] **Step 3: Реализация**

Константы рядом с `BACKGROUND_MAX`:

```rust
/// Кусок, которым проспан фоновый такт, пока под присмотром сигнал трекера.
///
/// Секунда — не такт опроса, а частота одного локального `stat`: сам опрос
/// по-прежнему идёт по бэкоффу, и цена этой секунды ровно один системный
/// вызов.
pub const SIGNAL_TICK: Duration = Duration::from_secs(1);

/// Всплеск опроса после своего же действия, кончающегося терминалом.
///
/// Три шага, потому что окно приезжает не сразу: терминал поднимается секунды,
/// заголовок устаивается ещё два тика трекера. Дальше работу забирает сигнал —
/// досиживать до появления окна всплеск не обязан.
pub const BURST: [Duration; 3] = [
    Duration::from_secs(3),
    Duration::from_secs(8),
    Duration::from_secs(20),
];

/// Следующий шаг расписания: его номер и срок. `None` — всплеск кончился.
pub fn burst_next(step: usize) -> Option<(usize, Duration)> {
    BURST.get(step + 1).map(|d| (step + 1, *d))
}
```

В `enum Signal` добавить:

```rust
    /// Пикер сам открыл что-то, кончающееся терминалом. Не опрос, а
    /// расписание: на само нажатие опрашивать нечего, терминал ещё не поднялся.
    Opened,
```

Рядом с потоком — ожидание с оглядкой на сигнал:

```rust
/// Чем кончилось ожидание.
enum Woke {
    Got(Signal),
    Elapsed,
    Tracker,
    Gone,
}

/// Проспать срок, поглядывая на сигнал трекера.
///
/// Кусками по `SIGNAL_TICK`, а не одним сном: у скрытого окна срок доходит до
/// восьми минут, и всё это время поток нечем разбудить, кроме сигнала из
/// канала. Без сторожа (показанное окно, выключенный фон) спим одним куском —
/// лишний системный вызов в секунду там ни за что.
fn wait_for(
    rx: &std::sync::mpsc::Receiver<Signal>,
    wait: Duration,
    mut watcher: Option<&mut tracker_signal::Watcher>,
) -> Woke {
    let deadline = std::time::Instant::now() + wait;
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return Woke::Elapsed;
        }
        let slice = if watcher.is_some() { left.min(SIGNAL_TICK) } else { left };
        match rx.recv_timeout(slice) {
            Ok(signal) => return Woke::Got(signal),
            Err(RecvTimeoutError::Disconnected) => return Woke::Gone,
            Err(RecvTimeoutError::Timeout) => {
                if let Some(w) = watcher.as_deref_mut() {
                    if w.changed() {
                        return Woke::Tracker;
                    }
                }
            }
        }
    }
}
```

Тело потока. Перед `loop` завести:

```rust
            let mut burst: Option<usize> = None;
            let mut skip_poll = false;
            let mut watcher =
                tracker_signal::Watcher::new(crate::state_path(tracker_signal::FILE).ok());
```

Блок опроса `if !idle {` заменить на:

```rust
                if !idle && !std::mem::replace(&mut skip_poll, false) {
                    let fresh_dump = burst.is_some();
                    let (state, error) = poll_once(&sources, fresh_dump);
                    let changed = match state {
                        // ... тело ветки не меняется ...
                    };
                    delay = match burst.and_then(burst_next) {
                        Some((step, wait)) => {
                            burst = Some(step);
                            wait
                        }
                        None => {
                            burst = None;
                            next_delay(visible, changed, delay)
                        }
                    };
                }
```

Ожидание заменить на:

```rust
                let wait = if idle { Duration::from_secs(3600) } else { delay };
                // Сторож смотрится только у скрытого окна и только при
                // работающем фоне: показанное и так опрашивает раз в секунду, а
                // выключенный человеком фон сигнал воскрешать не вправе.
                let watching = !visible && !idle;
                match wait_for(&rx, wait, if watching { Some(&mut watcher) } else { None }) {
                    Woke::Got(Signal::Shown) => {
                        visible = true;
                        delay = VISIBLE_TICK;
                        // Показанное окно опрашивает раз в секунду — всплеску
                        // тут делать нечего, и досиживать его незачем.
                        burst = None;
                        // ... отдача кэша не меняется ...
                    }
                    Woke::Got(Signal::Hidden) => {
                        visible = false;
                        delay = BACKGROUND_MIN;
                    }
                    Woke::Got(Signal::Opened) => {
                        burst = Some(0);
                        delay = BURST[0];
                        skip_poll = true;
                    }
                    Woke::Got(Signal::Nudge) => {
                        // ... отдача кэша не меняется ...
                    }
                    // Трекер сказал, что состав окон изменился: опрос на
                    // следующем витке, без всякой задержки.
                    Woke::Tracker | Woke::Elapsed => {}
                    Woke::Gone => return,
                }
```

Метод рядом с `nudge`:

```rust
    /// Пикер открыл что-то, кончающееся терминалом.
    pub fn opened(&self) {
        self.signal(Signal::Opened);
    }
```

Вверху файла добавить `use crate::tracker_signal;`.

- [x] **Step 4: Тесты зелёные**

Run: `cd src-tauri && cargo test`
Expected: PASS, включая прежние `такт после тишины` и `narrow_size_matches_the_window_config`.

- [x] **Step 5: Коммит**

```bash
git add src-tauri/src/poller.rs
git commit -m "feat(poller): сигнал трекера будит опрос, всплеск после открытия"
```

---

### Task 5: пять веток зовут `opened()`

**Files:**
- Modify: `src-tauri/src/main.rs:1030` (`restore_snapshot_mqtt`), `:1110` (`open_session_mqtt`), `:1147` (`open_project_mqtt`), `:1176` (`new_session_mqtt`), `:1709` (`spawn_detached`), плюс `mod tests`

**Interfaces:**
- Consumes: `Poller::opened()` (задача 4).
- Produces: сторож формы; для следующих задач ничего.

- [x] **Step 1: Написать падающий тест**

В `src-tauri/src/main.rs`, в `mod tests`:

```rust
    /// Каждая ветка, кончающаяся терминалом, заводит всплеск опроса.
    ///
    /// Текстовый, и иначе никак: забытая ветка не падает и не молчит — она
    /// работает ровно как раньше, то есть окно появляется, а список узнаёт о
    /// нём через минуту-восемь. Поймать это можно было бы только глазами и
    /// только на той ветке, которую забыли.
    #[test]
    fn every_branch_that_ends_in_a_terminal_starts_a_burst() {
        let src = include_str!("main.rs");
        for name in [
            "async fn restore_snapshot_mqtt(",
            "async fn open_session_mqtt(",
            "async fn open_project_mqtt(",
            "async fn new_session_mqtt(",
            "fn spawn_detached(",
        ] {
            let body = src
                .split_once(name)
                .unwrap_or_else(|| panic!("{name} пропала — тест сторожит не то"))
                .1;
            let (body, _) = body.split_once("\n}\n").expect("команда не закрыта");
            assert!(
                body.contains("poller.opened()"),
                "{name} кончается терминалом и обязана завести всплеск опроса"
            );
        }
    }

    /// Ветки, которые нового окна не открывают, всплеска не заводят.
    #[test]
    fn branches_without_a_new_window_do_not_start_a_burst() {
        let src = include_str!("main.rs");
        let (_, body) = src.split_once("fn spawn_url(").expect("spawn_url пропала");
        let (body, _) = body.split_once("\n}\n").expect("команда не закрыта");
        assert!(
            !body.contains("poller.opened()"),
            "spawn_url открывает папку и ссылку claude:// — состава окон это не меняет"
        );
    }
```

- [x] **Step 2: Убедиться, что тест падает**

Run: `cd src-tauri && cargo test every_branch_that_ends_in_a_terminal`
Expected: FAIL — `open_session_mqtt кончается терминалом и обязана завести всплеск опроса`.

- [x] **Step 3: Реализация**

В каждую из пяти функций добавить параметр (если его там ещё нет):

```rust
    poller: tauri::State<'_, poller::Poller>,
```

(у `async` команд время жизни обязательно; у синхронной `spawn_detached` — `tauri::State<poller::Poller>`)

и вызов **после** удачной отправки или запуска, перед `Ok(())`:

```rust
    // Расписание опроса, а не опрос: терминал поднимется через секунды, и
    // список обязан узнать о нём раньше, чем через минуту бэкоффа.
    poller.opened();
```

У `spawn_detached` вызов ставится после `spawn()`, вернувшего `Ok`: не запустилось — окна не будет, и всплеск гнал бы ssh впустую.

- [x] **Step 4: Тесты зелёные**

Run: `cd src-tauri && cargo test`
Expected: PASS.

- [x] **Step 5: Проверить, что фронтенд не сломан**

Run: `npm test`
Expected: PASS — `tauri::State` в аргументы `invoke` не входит, сигнатуры со стороны JS прежние.

- [x] **Step 6: Коммит**

```bash
git add src-tauri/src/main.rs
git commit -m "feat(picker): открытие терминала заводит всплеск опроса"
```

---

### Task 6: состояние сигнала видно человеку

**Files:**
- Modify: `src-tauri/src/main.rs` (новая команда + регистрация в `invoke_handler!`)
- Modify: `settings.html` (вкладка Window)
- Test: `test/settings-page.test.js`

**Interfaces:**
- Consumes: `tracker_signal::FILE`, `crate::state_path` (задача 3).
- Produces: команда `tracker_signal_status() -> {path: string, seen: bool, ageSec: number|null}`.

- [x] **Step 1: Написать падающий тест**

В `test/settings-page.test.js` добавить:

```js
test('вкладка Window показывает состояние сигнала трекера', () => {
  // Путь и формат сигнала живут в трёх репозиториях, а текстовым сторожем
  // через репозитории не дотянуться: разъедутся — сигнал молча перестанет
  // приходить, и отличить это от «ничего не менялось» будет нечем. Строка в
  // настройках — единственное, чем человек может это увидеть.
  assert.match(SETTINGS_HTML, /Tracker signal/, 'подпись на месте');
  assert.match(SETTINGS_HTML, /tracker_signal_status/, 'страница спрашивает состояние у Rust');
});
```

`SETTINGS_HTML` — уже готовая константа файла (`test/settings-page.test.js:23`), второго чтения того же файла заводить не надо.

- [x] **Step 2: Убедиться, что тест падает**

Run: `npm test -- test/settings-page.test.js`
Expected: FAIL — `подпись на месте`.

- [x] **Step 3: Реализация**

В `main.rs` рядом с остальными командами:

```rust
/// Что известно про сигнал оконного трекера этой машины.
///
/// Диагностика, а не настройка: ни ключа в конфиге, ни сохранения. Путь и
/// формат сигнала живут в трёх репозиториях сразу, и разъехавшись, они не дают
/// ни ошибки, ни следа — пикер просто возвращается к прежнему бэкоффу. Строка
/// здесь единственное, чем человек отличит «трекер молчит» от «ничего не
/// менялось».
#[tauri::command]
fn tracker_signal_status() -> serde_json::Value {
    let path = state_path(tracker_signal::FILE).ok();
    let age = path
        .as_ref()
        .and_then(|p| std::fs::metadata(p).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok())
        .map(|d| d.as_secs());
    serde_json::json!({
        "path": path.map(|p| p.display().to_string()).unwrap_or_default(),
        "seen": age.is_some(),
        "ageSec": age,
    })
}
```

Зарегистрировать `tracker_signal_status` в `invoke_handler![...]` рядом с соседями.

В `settings.html`, на вкладке **Window** под галками (подпись по-английски — её видит человек):

```html
<div class="row">
  <span class="label">Tracker signal</span>
  <span id="tracker-signal">…</span>
</div>
```

и в скрипте вкладки:

```js
// Диагностика, а не настройка: спрашивается один раз на открытие окна — файл
// трогает трекер, а окно настроек живёт секунды.
invoke('tracker_signal_status').then(s => {
  const node = document.getElementById('tracker-signal');
  node.textContent = s.seen ? `${s.ageSec}s ago` : 'never seen';
  node.title = s.path || '';
});
```

- [x] **Step 4: Тесты зелёные**

Run: `npm test && cd src-tauri && cargo test`
Expected: PASS оба.

- [x] **Step 5: Коммит**

```bash
git add src-tauri/src/main.rs settings.html test/settings-page.test.js
git commit -m "feat(settings): строка состояния сигнала трекера"
```

---

### Task 7: Windows-трекер роняет сигнал

**Files:**
- Modify: `windows11-manager/src/claude-wt/windows-file-helpers.js` (рядом с `windowsFingerprint`, ~134)
- Modify: `windows11-manager/src/claude-wt/index.js` (`publishWindows`, ~326)
- Test: `windows11-manager/src/claude-wt/windows-file-helpers.test.js`

**Interfaces:**
- Consumes: `payload` из `buildWindowsFile` — объект с полями `windows` (id → запись) и `projects` (массив `{cwd, name, hotkey}`).
- Produces: `signalPrint(payload) -> string`; `shouldWriteSignal({print, lastPrint}) -> boolean`; `signalPath() -> string`.

- [x] **Step 1: Написать падающие тесты**

В `windows11-manager/src/claude-wt/windows-file-helpers.test.js` дописать (импорты `describe/it/expect` там уже есть — добавить только недостающие имена в существующий импорт из `./windows-file-helpers.js`):

```js
import os from 'node:os';
import path from 'node:path';

const payload = (windows, projects = []) => ({ windows, projects });

describe('узкий отпечаток сигнала', () => {
  it('не замечает взгляда на окно', () => {
    // focusedAt меняется на каждый alt-tab. Войди он сюда — пикер ходил бы по
    // ssh десятки раз в минуту, то есть ровно то, от чего уходим.
    const a = payload({ s1: { focusedAt: 1, lastSeen: 10, title: 'a', app: 'wt', minimized: false } });
    const b = payload({ s1: { focusedAt: 999, lastSeen: 99, title: 'b', app: 'kitty', minimized: false } });
    expect(signalPrint(a)).toBe(signalPrint(b));
  });

  it('замечает новую привязку', () => {
    const a = payload({ s1: { minimized: false } });
    const b = payload({ s1: { minimized: false }, s2: { minimized: false } });
    expect(signalPrint(a)).not.toBe(signalPrint(b));
  });

  it('замечает закрывшееся окно', () => {
    const a = payload({ s1: { minimized: false }, s2: { minimized: false } });
    const b = payload({ s1: { minimized: false } });
    expect(signalPrint(a)).not.toBe(signalPrint(b));
  });

  it('замечает свёрнутое окно', () => {
    // Свёрнутое уходит из плитки, и снимок пикера обязан это знать.
    const a = payload({ s1: { minimized: false } });
    const b = payload({ s1: { minimized: true } });
    expect(signalPrint(a)).not.toBe(signalPrint(b));
  });

  it('замечает смену проектного хоткея', () => {
    const a = payload({}, [{ cwd: '/p', hotkey: 'Ctrl+F1' }]);
    const b = payload({}, [{ cwd: '/p', hotkey: 'Ctrl+F2' }]);
    expect(signalPrint(a)).not.toBe(signalPrint(b));
  });

  it('не зависит от порядка ключей', () => {
    const a = payload({ s1: { minimized: false }, s2: { minimized: false } });
    const b = payload({ s2: { minimized: false }, s1: { minimized: false } });
    expect(signalPrint(a)).toBe(signalPrint(b));
  });
});

describe('когда писать сигнал', () => {
  it('пишет первый раз', () => {
    expect(shouldWriteSignal({ print: 'a', lastPrint: null })).toBe(true);
  });

  it('пишет на смену отпечатка', () => {
    expect(shouldWriteSignal({ print: 'b', lastPrint: 'a' })).toBe(true);
  });

  it('сердцебиения у сигнала нет', () => {
    // У файла окон оно есть и там оправдано — читатель на другой машине должен
    // видеть, что трекер жив. Здесь наоборот: сердцебиение будило бы скрытый
    // пикер каждые полминуты впустую.
    expect(shouldWriteSignal({ print: 'a', lastPrint: 'a' })).toBe(false);
  });
});

describe('путь сигнала', () => {
  it('лежит в каталоге настроек пикера', () => {
    expect(signalPath()).toBe(
      path.join(os.homedir(), '.config', 'ccfzf-picker', 'tracker-signal.json'),
    );
  });
});
```

- [x] **Step 2: Убедиться, что тесты падают**

Run: `cd ../windows11-manager && npx vitest run src/claude-wt/windows-file-helpers.test.js`
Expected: FAIL — `signalPrint is not a function`.

- [x] **Step 3: Реализация**

В `windows-file-helpers.js` рядом с `windowsFingerprint`:

```js
/**
 * Узкий отпечаток — только то, из-за чего снимок скрытого пикера соврёт хоткею.
 *
 * Второй отпечаток рядом с `windowsFingerprint`, а не он сам: в тот входит
 * `focusedAt`, и сигналь мы по нему — пикер ходил бы по ssh на каждое
 * переключение фокуса. Сюда входит состав привязанных сессий, свёрнутость
 * (свёрнутое окно уходит из плитки) и проектные хоткеи (по ним пикер вешает
 * клавиши). Не входит: `focusedAt` и `lastSeen` — растут сами; `title` и `app`
 * — подпись и буква, хоткей их не спрашивает; снимки — их читают только при
 * открытом пикере.
 *
 * Состав, а не содержимое, — ещё и условие сходимости: опрос пикера освежает
 * дамп, трекер привязывает окно, сигнал зовёт опрос снова. Петля кончается
 * ровно потому, что привязка устоялась и состав перестал меняться.
 */
function signalPrint(payload) {
  const win = Object.entries(payload?.windows ?? {})
    .map(([id, w]) => `${id} ${w?.minimized ? 1 : 0}`)
    .sort()
    .join('|');
  const keys = (payload?.projects ?? [])
    .map(p => `${p?.cwd} ${p?.hotkey}`)
    .sort()
    .join('|');
  return `${win}//${keys}`;
}

/** Писать ли сигнал. Сердцебиения нет намеренно — см. signalPrint. */
function shouldWriteSignal({ print, lastPrint }) {
  return print !== lastPrint;
}

/**
 * Куда его класть. Каталог настроек пикера на этой же машине: трекер и пикер
 * живут рядом, и сетевого здесь нет ничего. `os.homedir()` на Windows и есть
 * `USERPROFILE` — тем же, каким пикер считает свой путь.
 */
function signalPath() {
  return path.join(os.homedir(), '.config', 'ccfzf-picker', 'tracker-signal.json');
}
```

Добавить импорты `os` и `path` в шапку файла, если их там нет, и три имени в `export { ... }`.

В `index.js`, в `publishWindows`, **до** гейта `shouldWriteWindowsFile` (у сигнала своё правило):

```js
  const signal = signalPrint(payload);
  if (shouldWriteSignal({ print: signal, lastPrint: lastSignalPrint })) {
    try {
      writeWindowsFile(signalPath(), {
        generated: Math.floor(nowMs / 1000),
        host: os.hostname(),
        pid: process.pid,
        print: signal,
      });
      lastSignalPrint = signal;
    } catch (e) {
      // Строка в лог и всё: сигнал это добавка, и ронять из-за него тик
      // слежения за окнами нельзя — без пометки человек проживёт, без
      // слежения нет.
      console.error(`[claude-wt] signal write failed: ${e.message}`);
    }
  }
```

Рядом с `lastWindowsFingerprint` завести `let lastSignalPrint = null;`, а `signalPrint`, `shouldWriteSignal`, `signalPath` добавить в существующий импорт из `./windows-file-helpers.js` (он уже идёт через `windows-file.js`, там же и `writeWindowsFile`).

`writeWindowsFile` переиспользуется намеренно: там уже tmp + rename и `mkdirSync` каталога — второй записи атомарного файла заводить не надо.

- [x] **Step 4: Тесты зелёные**

Run: `cd ../windows11-manager && npx vitest run src/claude-wt/ && npm run lint`
Expected: PASS.

- [x] **Step 5: Коммит**

```bash
cd ../windows11-manager
git add src/claude-wt/windows-file-helpers.js src/claude-wt/windows-file-helpers.test.js src/claude-wt/index.js
git commit -m "feat(claude-wt): сигнал пикеру о смене состава окон"
```

---

### Task 8: маковский трекер роняет сигнал

**Files:**
- Modify: `macos-windows-manager/crates/mwm-core/src/publish.rs` (рядом с `fingerprint`, ~144, и `mod tests`)
- Modify: `macos-windows-manager/src-tauri/src/main.rs` (~549, сразу после `let print = fingerprint(&bound, focus);`)

**Interfaces:**
- Consumes: `bound: &BTreeMap<String, Bound>` и `focus: bool` — обе уже в тике.
- Produces: `mwm_core::publish::signal_print(&BTreeMap<String, Bound>, bool) -> String`.

- [x] **Step 1: Написать падающие тесты**

В `crates/mwm-core/src/publish.rs`, в `mod tests`. Помощник `bound(title, last_seen_ms)`
и константа `SID` там уже есть (строки 184-197) — второго сборщика заводить не надо:

```rust
    #[test]
    fn a_narrow_print_ignores_a_look_at_the_window() {
        // То же правило и та же причина, что у Windows-трекера: focused_at
        // меняется на каждое переключение окна, и сигналь мы по нему — пикер
        // ходил бы по ssh десятки раз в минуту. Заголовок и терминал не входят
        // по той же мерке: это подпись и буква, а не «есть ли здесь окно».
        let a = bound("имя", 1_000);
        let mut b = bound("другой заголовок", 9_999);
        b.get_mut(SID).unwrap().focused_at_ms = 123;
        b.get_mut(SID).unwrap().app = "wezterm".to_string();
        assert_eq!(signal_print(&a, true), signal_print(&b, true));
    }

    #[test]
    fn a_narrow_print_notices_a_new_binding() {
        let a = bound("имя", 1_000);
        let mut b = bound("имя", 1_000);
        let mut second = b[SID].clone();
        second.session_id = "bbbbbbbb-1111-2222-3333-444444444444".to_string();
        b.insert(second.session_id.clone(), second);
        assert_ne!(signal_print(&a, true), signal_print(&b, true));
    }

    #[test]
    fn a_narrow_print_notices_a_minimized_window() {
        // Свёрнутое окно уходит из плитки, и снимок пикера обязан это знать.
        assert_ne!(
            signal_print(&bound("имя", 1_000), true),
            signal_print(&bound_minimized("имя", 1_000), true)
        );
    }

    #[test]
    fn a_narrow_print_notices_can_focus_flipping() {
        // От него зависит сама развилка Enter: выключился брокер — подъём окна
        // перестал быть возможен, а снимок пикера об этом не знает.
        let a = bound("имя", 1_000);
        assert_ne!(signal_print(&a, true), signal_print(&a, false));
    }
```

- [x] **Step 2: Убедиться, что тесты падают**

Run: `cd ../macos-windows-manager && cargo test -p mwm-core signal_print`
Expected: FAIL — `cannot find function signal_print in this scope`.

- [x] **Step 3: Реализация**

В `publish.rs` рядом с `fingerprint`:

```rust
/// Узкий отпечаток для сигнала пикеру — только то, из-за чего снимок скрытого
/// пикера соврёт хоткею.
///
/// Второй рядом с `fingerprint`, а не он сам: в тот входит `focused_at`, и
/// сигналь мы по нему — пикер ходил бы по ssh на каждое переключение окна.
/// Сюда входит состав привязанных сессий, свёрнутость (свёрнутое окно уходит
/// из плитки) и `can_focus` (от него зависит сама развилка Enter). Заголовок и
/// терминал не входят: это подпись и буква, а не ответ на вопрос «есть ли
/// здесь окно».
///
/// Проектных хоткеев здесь нет, и это не пропуск: их источник —
/// `claudeWt.projects` у windows11-manager, и маковский трекер о них не знает
/// ничего.
pub fn signal_print(bound: &BTreeMap<String, Bound>, can_focus: bool) -> String {
    let mut out = String::new();
    out.push(if can_focus { 'F' } else { 'f' });
    for (sid, b) in bound {
        out.push('|');
        out.push_str(sid);
        out.push(if b.minimized { 'm' } else { '.' });
    }
    out
}
```

В `src-tauri/src/main.rs`, сразу после `let print = fingerprint(&bound, focus);`:

```rust
        // Сигнал пикеру этой машины. Своё правило записи, а не гейт файла
        // окон: у того сердцебиение в полминуты, и оно будило бы скрытый пикер
        // впустую.
        let signal = mwm_core::publish::signal_print(&bound, focus);
        if last_signal.as_deref() != Some(signal.as_str()) {
            match write_tracker_signal(&signal, &cfg.host, pid, now) {
                Ok(()) => last_signal = Some(signal),
                Err(e) => mwm_log!("signal write failed: {e}"),
            }
        }
```

Рядом с `last_print` (там, где он объявлен перед циклом) завести `let mut last_signal: Option<String> = None;`.

Функция записи рядом с остальными помощниками `main.rs`:

```rust
/// Уронить сигнал в каталог настроек пикера этой машины.
///
/// Путь и имя ключа — единственное, что связывает нас с пикером; сам отпечаток
/// контрактом не является, его считает каждый трекер свой. Нет `HOME` — писать
/// некуда, и это не беда: пикера на такой машине нет тем более.
fn write_tracker_signal(print: &str, host: &str, pid: u32, now_ms: u64) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let dir = std::path::Path::new(&home).join(".config/ccfzf-picker");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let body = serde_json::json!({
        "generated": now_ms / 1000,
        "host": host,
        "pid": pid,
        "print": print,
    });
    mwm_core::state::write_atomic(&dir.join("tracker-signal.json").to_string_lossy(), &body)
        .map_err(|e| e.to_string())
}
```

Сигнатуру `write_atomic` сверить с её вызовом в этом же файле (там она зовётся для `state_path`, ~572) и подставить тот же вид аргументов.

- [x] **Step 4: Тесты зелёные**

Run: `cd ../macos-windows-manager && cargo test`
Expected: PASS.

- [x] **Step 5: Коммит**

```bash
cd ../macos-windows-manager
git add crates/mwm-core/src/publish.rs src-tauri/src/main.rs
git commit -m "feat(tracker): сигнал пикеру о смене состава окон"
```

---

### Task 9: спрос на индекс у Windows-трекера

**Files:**
- Modify: `windows11-manager/src/claude-wt/sessions.js:105-152` (`loadDump`, `loadSessionIndex`)
- Modify: `windows11-manager/src/claude-wt/index.js:134,157` (тик и `reportUnresolved`)
- Test: `windows11-manager/src/claude-wt/sessions.test.js`

**Interfaces:**
- Consumes: `unresolvedTitles(nextWindows)` из `tracker-helpers.js` — им уже пользуется `reportUnresolved` в том же файле.
- Produces: `loadSessionIndex(filePath, progressDir, nowMs, wanted)` — четвёртый аргумент, умолчание `false`.

- [x] **Step 1: Написать падающий тест**

В `windows11-manager/src/claude-wt/sessions.test.js`, внутрь существующего
`describe('loadSessionIndex', ...)`. Помощники `freshPath()`, `writeDump(path, dump, when)`,
`dumpWith(...titles)` и отметки `T0`/`T1` там уже есть (строки 40-57), `beforeEach` заводит
свой каталог — своих писать не надо:

```js
  it('re-reads within the age window when a title is wanted', () => {
    // Маковская развилка, портированная сюда: у окна, которого нет в индексе,
    // ждать пятнадцать секунд незачем — сессию за ним завели секунды назад.
    // Вхолостую спрос не возникает вовсе: окна не меняются часами.
    const p = freshPath();
    writeDump(p, dumpWith('ccfzf'), T0);
    const base = 1_000_000;
    loadSessionIndex(p, '', base);

    // Тот же mtime намеренно: ровно этот случай кэш и держит — на сетевом
    // диске statSync минутами отдаёт долгоживущему процессу прежнюю отметку.
    writeDump(p, dumpWith('home'), T0);

    expect(loadSessionIndex(p, '', base + 1000).home)
      .toBeUndefined();
    expect(loadSessionIndex(p, '', base + 1000, true).home)
      .toEqual({ id: 's0', cwd: '/p0', title: 'home', ambiguous: false });
  });

  it('keeps the age window when nothing is wanted', () => {
    // Спрос ускоряет, но не отменяет прежнего правила: без него всё как было.
    const p = freshPath();
    writeDump(p, dumpWith('ccfzf'), T0);
    const base = 2_000_000;
    loadSessionIndex(p, '', base);
    writeDump(p, dumpWith('home'), T0);
    expect(loadSessionIndex(p, '', base + 1000).home).toBeUndefined();
    expect(loadSessionIndex(p, '', base + 20000).home)
      .toEqual({ id: 's0', cwd: '/p0', title: 'home', ambiguous: false });
  });
```

- [x] **Step 2: Убедиться, что тест падает**

Run: `cd ../windows11-manager && npx vitest run src/claude-wt/sessions.test.js`
Expected: FAIL — четвёртый аргумент игнорируется, `вторая` не появляется.

- [x] **Step 3: Реализация**

В `sessions.js`:

```js
function loadDump(filePath, progressDir = '', nowMs = Date.now(), wanted = false) {
```

Условие кэша:

```js
  // `wanted` — тику попалось окно, чьего заголовка в индексе нет. Ждать срока
  // годности тогда незачем: сессию за этим окном завели секунды назад, и
  // пятнадцать секунд здесь — это пятнадцать секунд, которые окно простоит
  // непривязанным. Вхолостую спрос не возникает вовсе: окна не меняются часами.
  if (!wanted && cache.path === filePath && cache.mtimeMs === stat.mtimeMs
      && cache.stamp === stamp && nowMs - cache.readAt < MAX_AGE_MS) {
    return cache;
  }
```

```js
function loadSessionIndex(filePath, progressDir = '', nowMs = Date.now(), wanted = false) {
  return loadDump(filePath, progressDir, nowMs, wanted).index;
}
```

В `index.js` рядом с `reportedTitles`:

```js
// Было ли на прошлом тике окно без сессии. Индекс читается ДО step(), то есть
// про непривязанное окно мы узнаём на тик позже, — и это нормально: тик
// секундный, а второе чтение дампа в том же тике стоило бы сетевого чтения на
// каждом витке.
let wantedIndex = false;
```

В `claudeWtTick`:

```js
  const sessionIndex = loadSessionIndex(cfg.sessionsFile, cfg.progressDir, Date.now(), wantedIndex);
  wantedIndex = false;
```

и после `step(...)`, безусловно (а не только под `cfg.debug`):

```js
  // Спрос на следующий тик. Считается той же функцией, что и жалоба в лог:
  // второе правило «какое окно считать непривязанным» разошлось бы с первым.
  wantedIndex = unresolvedTitles(nextWindows).length > 0;
  if (cfg.debug) reportUnresolved(nextWindows);
```

Импортировать `unresolvedTitles` в `index.js`, если его там ещё нет в шапке (сейчас им пользуется `reportUnresolved` в этом же файле — проверить импорты).

- [x] **Step 4: Тесты зелёные**

Run: `cd ../windows11-manager && npx vitest run src/claude-wt/ && npm run lint`
Expected: PASS.

- [x] **Step 5: Коммит**

```bash
cd ../windows11-manager
git add src/claude-wt/sessions.js src/claude-wt/sessions.test.js src/claude-wt/index.js
git commit -m "feat(claude-wt): незнакомый заголовок перечитывает индекс мимо срока"
```

---

## Живая проверка после выкатки

Тестами это не ловится: половина правки — про то, что происходит, пока пикер скрыт.

- [x] Выкатить на все три машины (`BRANCH=<ветка> ./data/scripts/deploy-win.sh` и `BRANCH=<ветка> ./data/scripts/deploy-mac.sh --all`, параллельно и в фоне), трекеры — своими путями. Порядок не важен.
- [x] Скрыть пикер, подождать больше минуты, открыть терминал из пикера (`^N`). Открыть пикер: строка обязана быть с пометкой ▣ **сразу**, а не появиться через секунду после открытия.
- [x] Скрыть пикер, подождать больше минуты, закрыть окно сессии руками. Открыть пикер: пометки ▣ у строки быть не должно.
- [x] Скрыть пикер, нажать проектный хоткей каталога, у которого сессия уже открыта на этой машине. Второй сессии с тем же именем появиться не должно.
- [x] Окно настроек, вкладка **Log** (переехала туда по просьбе владельца, тикает раз в секунду): `Tracker signal` показывает секунды, а не `never seen`. Показывает `never seen` — разошёлся путь между репозиториями, смотреть Global Constraints.
- [x] Проверить, что alt-tab между терминалами **не** гонит опрос: при скрытом пикере переключение окон не должно вызывать обращений к ssh.
