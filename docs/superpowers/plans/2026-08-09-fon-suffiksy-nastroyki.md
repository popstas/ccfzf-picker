# Фоновый опрос, суффиксы имён и окно настроек — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Опрос ccfzf переезжает в Rust и продолжается при закрытом окне с бэкоффом 1→2→4→8 минут; новые сессии получают имена `-2`/`-3` при совпадении с живой тёзкой; настройки переезжают в отдельное окно, которое пишет `config.yaml` и `ui.json`.

**Архитектура:** Три независимые части. Часть A переносит владение опросом из `sessions.html` в новый `src-tauri/src/poller.rs`; фронтенд становится подписчиком события `state`. Часть B добавляет чистую функцию выбора свободного имени и зовёт её из двух мест — пикера и ccfzf. Часть C заводит второе окно Tauri со страницей `settings.html`, двухосную модель галок в `ui.json` и запись `config.yaml` через `serde_yaml` с разовым бэкапом.

**Tech Stack:** Tauri 2 (Rust), ванильный JS без сборщика (UMD-модули в `frontend-src/`), `node --test`, `cargo test`, ccfzf — zsh + встроенный Python 3.

## Global Constraints

- **`;` в удалённой команде не ставить.** Для Windows Terminal это разделитель панелей; команда развалится на панели ещё до шелла.
- **Все удалённые запуски агента идут через `inDir`** (`exec $SHELL -ic 'cd -- <cwd> && <cmd>'`) — без интерактивного шелла не отрабатывает хук `chpwd`, и телеметрия уходит без `project=`.
- **Имена машин в репозиторий не возвращать.** Хост берётся из `~/.config/ccfzf-picker/config.yaml`; `test/no-private-data.test.js` это сторожит.
- **Новые файлы `frontend-src/*.js` обязаны попасть в `scripts/prepare-frontend.js`** — иначе в собранном приложении их не будет, а `npm test` пройдёт.
- **Модули `frontend-src/` пишутся UMD-шимом** ровно той же формы, что у соседей: `(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Имя = factory(); })(typeof self !== 'undefined' ? self : this, function () { ... });`
- Тесты фронтенда запускаются только как `npm test` (он же `node --test`), из корня репозитория. `node --test test/` на этих версиях Node не работает.
- Тесты Rust: `cd src-tauri && cargo test`.
- Комментарии в коде — по-русски, как у соседей, и объясняют «почему», а не «что».

---

## Структура файлов

**Часть A — фоновый опрос**

| Файл | Ответственность |
|---|---|
| `src-tauri/src/poller.rs` (создать) | Отпечаток состояния, формула такта, поток опроса, кэш последнего ответа |
| `src-tauri/src/main.rs` (править) | Регистрация модуля, команды `poll_now`, сигналы показа/скрытия |
| `frontend-src/config-shape.js` (править) | Новый ключ `backgroundRefresh` |
| `config.example.yml` (править) | Описание ключа |
| `sessions.html` (править) | `refresh()` → подписчик события `state` |

**Часть B — суффиксы имён**

| Файл | Ответственность |
|---|---|
| `frontend-src/session-name.js` (создать) | `uniqueSessionName(base, taken)` — чистая |
| `frontend-src/open-strategy.js` (править) | `newSessionName`, `newSessionCommand` с набором занятых |
| `sessions.html` (править) | Сбор занятых имён, память о выданных |
| `~/projects/shell/ccfzf/ccfzf` (править, другой репозиторий) | Режим `newname` и ветка `__new__` |

**Часть C — окно настроек**

| Файл | Ответственность |
|---|---|
| `frontend-src/ui-state.js` (править) | Двухосная модель галок и миграция старой формы |
| `settings.html` (создать) | Страница настроек: вкладки слева, формы справа |
| `frontend-src/settings-form.js` (создать) | Чистое: конфиг ⇄ поля формы, сбор патча, проверка формы |
| `src-tauri/src/config_file.rs` (создать) | Слияние патча в YAML-документ, шапка, бэкап |
| `src-tauri/src/main.rs` (править) | `open_settings`, `save_config`, перерегистрация хоткеев |
| `src-tauri/capabilities/default.json` (править) | Окно `settings` в списке |
| `scripts/prepare-frontend.js` (править) | Новые файлы в сборку |
| `sessions.html` (править) | Шестерёнка, `Ctrl+,`, рисование галок по оси `statusline` |

---

# Часть A — фоновый опрос ccfzf

### Task A1: Отпечаток состояния

Отпечаток решает, была ли активность. Ответ агрегатора целиком для этого не годится: `generated` наверху и `age` у каждой сессии считаются от «сейчас» и отличаются на каждом опросе — бэкофф на таком сравнении не включился бы никогда.

**Files:**
- Create: `src-tauri/src/poller.rs`
- Modify: `src-tauri/src/main.rs` (одна строка `mod poller;`)

**Interfaces:**
- Consumes: ничего.
- Produces: `pub fn fingerprint(state: &serde_json::Value) -> String`

- [ ] **Step 1: Создать модуль с тестом, который падает**

Создать `src-tauri/src/poller.rs`:

```rust
//! Фоновый опрос агрегатора: отпечаток, такт и поток.

#[cfg(test)]
mod tests {
    use super::*;

    /// Два ответа, отличающиеся только временем, — одно и то же состояние.
    ///
    /// Проверка здесь потому, что ошибка невидима: сравнивая ответы целиком,
    /// бэкофф не включился бы никогда — `generated` и `age` считаются от
    /// «сейчас» и отличаются на каждом опросе. Выглядело бы это как
    /// работающая функция.
    #[test]
    fn time_alone_is_not_a_change() {
        let a = serde_json::json!({
            "generated": 1000,
            "sessions": [{"id": "s1", "mtime": 500, "age": "1m", "live": true}],
        });
        let b = serde_json::json!({
            "generated": 2000,
            "sessions": [{"id": "s1", "mtime": 500, "age": "17m", "live": true}],
        });
        assert_eq!(fingerprint(&a), fingerprint(&b));
    }

    /// Настоящая активность отпечаток меняет.
    #[test]
    fn real_activity_changes_the_fingerprint() {
        let base = serde_json::json!({
            "generated": 1000,
            "sessions": [{"id": "s1", "mtime": 500, "age": "1m", "live": true}],
        });
        let touched = serde_json::json!({
            "generated": 1000,
            "sessions": [{"id": "s1", "mtime": 900, "age": "1m", "live": true}],
        });
        let died = serde_json::json!({
            "generated": 1000,
            "sessions": [{"id": "s1", "mtime": 500, "age": "1m", "live": false}],
        });
        assert_ne!(fingerprint(&base), fingerprint(&touched));
        assert_ne!(fingerprint(&base), fingerprint(&died));
    }

    /// Окна и снимки — тоже активность: их приносит тот же ответ.
    #[test]
    fn windows_and_snapshots_count() {
        let a = serde_json::json!({"generated": 1, "sessions": [], "snapshots": []});
        let b = serde_json::json!({
            "generated": 1, "sessions": [],
            "snapshots": [{"id": "snap1", "created": 5}],
        });
        assert_ne!(fingerprint(&a), fingerprint(&b));
    }

    /// Ответ не той формы отпечаток не роняет: чинить его здесь нечем, а
    /// поток обязан пережить любой мусор с той стороны.
    #[test]
    fn junk_does_not_panic() {
        assert_eq!(fingerprint(&serde_json::json!(null)), fingerprint(&serde_json::json!(null)));
        assert_ne!(fingerprint(&serde_json::json!("строка")), fingerprint(&serde_json::json!(7)));
    }
}
```

Добавить в `src-tauri/src/main.rs` рядом с `mod mqtt;` (строка 12):

```rust
mod poller;
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd src-tauri && cargo test poller`
Expected: FAIL — `cannot find function 'fingerprint' in this scope`.

- [ ] **Step 3: Реализовать**

Вставить в `src-tauri/src/poller.rs` **перед** блоком `#[cfg(test)] mod tests`:

```rust
/// Отпечаток состояния: то же ли это, что в прошлый раз.
///
/// Из ответа выброшены `generated` и все `age` — они считаются от «сейчас» и
/// отличаются на каждом опросе. Остальное (`mtime`, `live`, `title`, окна,
/// снимки, проекты) и есть активность.
///
/// Строка, а не хэш: сравнение идёт раз в минуту, экономить не на чем, а
/// увидеть разницу в отладке по строке можно, по хэшу — нет. Порядок ключей
/// стабилен сам: `serde_json::Map` без фичи `preserve_order` — это BTreeMap.
pub fn fingerprint(state: &serde_json::Value) -> String {
    let mut copy = state.clone();
    if let Some(obj) = copy.as_object_mut() {
        obj.remove("generated");
        if let Some(sessions) = obj.get_mut("sessions").and_then(|v| v.as_array_mut()) {
            for session in sessions {
                if let Some(fields) = session.as_object_mut() {
                    fields.remove("age");
                }
            }
        }
    }
    copy.to_string()
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd src-tauri && cargo test poller`
Expected: PASS, 4 теста.

- [ ] **Step 5: Коммит**

```bash
git add src-tauri/src/poller.rs src-tauri/src/main.rs
git commit -m "feat(poller): отпечаток состояния без времени

Сравнивать ответ целиком нельзя: generated и age считаются от «сейчас»
и отличаются на каждом опросе — бэкофф не включился бы никогда."
```

---

### Task A2: Формула такта

**Files:**
- Modify: `src-tauri/src/poller.rs`

**Interfaces:**
- Consumes: ничего.
- Produces: `pub const VISIBLE_TICK: Duration`, `pub const BACKGROUND_MIN: Duration`, `pub const BACKGROUND_MAX: Duration`, `pub fn next_delay(visible: bool, changed: bool, prev: Duration) -> Duration`

- [ ] **Step 1: Написать падающий тест**

Добавить в `mod tests` в `src-tauri/src/poller.rs`:

```rust
    /// Тишина растит такт до потолка, активность сбрасывает его на минуту.
    #[test]
    fn silence_doubles_activity_resets() {
        let mut d = BACKGROUND_MIN;
        for expected in [2u64, 4, 8, 8, 8] {
            d = next_delay(false, false, d);
            assert_eq!(d, Duration::from_secs(expected * 60), "такт после тишины");
        }
        assert_eq!(next_delay(false, true, d), BACKGROUND_MIN, "активность сбрасывает");
    }

    /// Показанное окно опрашивается раз в секунду при любой предыстории.
    #[test]
    fn visible_window_always_ticks_every_second() {
        assert_eq!(next_delay(true, false, BACKGROUND_MAX), VISIBLE_TICK);
        assert_eq!(next_delay(true, true, VISIBLE_TICK), VISIBLE_TICK);
    }

    /// Секундный такт, доставшийся от показанного окна, не удваивается в
    /// секунды: скрытое окно начинает с минуты, что бы ни стояло до него.
    #[test]
    fn hidden_window_never_ticks_faster_than_a_minute() {
        assert_eq!(next_delay(false, false, VISIBLE_TICK), BACKGROUND_MIN);
    }
```

`Duration` в `mod tests` отдельно не импортировать: `use super::*` уже приносит его из импорта модуля, который ставит следующий шаг, а второй `use` дал бы E0252.

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd src-tauri && cargo test poller`
Expected: FAIL — `cannot find value 'BACKGROUND_MIN'`.

- [ ] **Step 3: Реализовать**

Добавить в `src-tauri/src/poller.rs` над `fingerprint`:

```rust
use std::time::Duration;

/// Показанное окно опрашивается раз в секунду — как было до фонового режима.
pub const VISIBLE_TICK: Duration = Duration::from_secs(1);
/// Нижний такт скрытого окна.
pub const BACKGROUND_MIN: Duration = Duration::from_secs(60);
/// Потолок бэкоффа. Восемь минут — из задачи; выше подниматься нельзя:
/// этим же опросом живёт панель openHASP, и такт — это её отставание.
pub const BACKGROUND_MAX: Duration = Duration::from_secs(8 * 60);

/// Сколько ждать до следующего опроса.
///
/// Смена видимости в формулу не входит: её обрабатывает поток, подменяя
/// `prev`. Поэтому нижняя граница проверяется здесь явно — секундный такт,
/// доставшийся от показанного окна, не должен удвоиться в две секунды.
pub fn next_delay(visible: bool, changed: bool, prev: Duration) -> Duration {
    if visible {
        return VISIBLE_TICK;
    }
    if changed {
        return BACKGROUND_MIN;
    }
    let doubled = prev.saturating_mul(2);
    doubled.clamp(BACKGROUND_MIN, BACKGROUND_MAX)
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd src-tauri && cargo test poller`
Expected: PASS, 7 тестов.

- [ ] **Step 5: Коммит**

```bash
git add src-tauri/src/poller.rs
git commit -m "feat(poller): такт опроса с бэкоффом 1-2-4-8 минут"
```

---

### Task A3: Ключ `backgroundRefresh` в конфиге

**Files:**
- Modify: `frontend-src/config-shape.js:35` (после `hideOnBlur` в `DEFAULTS`), `frontend-src/config-shape.js:144` (в `normalizeConfig`)
- Modify: `config.example.yml:35` (после `hideOnBlur`)
- Test: `test/config-shape.test.js`

**Interfaces:**
- Consumes: ничего.
- Produces: `CONFIG.backgroundRefresh` — булево, умолчание `true`. Rust читает тот же ключ сырым.

- [ ] **Step 1: Написать падающий тест**

Добавить в конец `test/config-shape.test.js`:

```js
test('backgroundRefresh по умолчанию включён', () => {
  // Умолчание true, а не false: фоновый опрос кормит панель openHASP, и
  // выключенным по умолчанию он молча лишал бы её обновлений.
  assert.strictEqual(normalizeConfig({}).backgroundRefresh, true);
  assert.strictEqual(normalizeConfig(null).backgroundRefresh, true);
  assert.strictEqual(normalizeConfig({ backgroundRefresh: false }).backgroundRefresh, false);
  // Нелогическое значение — умолчание, как у соседних ключей.
  assert.strictEqual(normalizeConfig({ backgroundRefresh: 'нет' }).backgroundRefresh, true);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm test`
Expected: FAIL — `undefined !== true`.

- [ ] **Step 3: Реализовать**

В `frontend-src/config-shape.js`, в объекте `DEFAULTS` сразу после `hideOnBlur: true,`:

```js
    // Опрос продолжается при закрытом окне. Он не только держит список тёплым
    // к следующему открытию: `ccfzf --state` переписывает свой дамп, а с того
    // дампа живёт экспорт в Home Assistant и панель openHASP. Закрытый пикер,
    // который перестал спрашивать, останавливает и панель.
    //
    // Выключать это стоит там, где панели нет: на маке фон — ssh раз в минуту
    // без выгоды.
    backgroundRefresh: true,
```

В `normalizeConfig`, сразу после строки с `hideOnBlur`:

```js
      backgroundRefresh: typeof src.backgroundRefresh === 'boolean'
        ? src.backgroundRefresh
        : DEFAULTS.backgroundRefresh,
```

В `config.example.yml` после блока `hideOnBlur: true`:

```yaml
# Опрашивать агрегатор и при закрытом окне: раз в минуту, а при тишине реже —
# 2, 4, 8 минут, — и снова раз в минуту, как только что-то изменилось.
#
# Нужно это не только ради тёплого списка к следующему открытию. `ccfzf --state`
# переписывает свой дамп, а с того дампа живут экспорт в Home Assistant и
# панель openHASP: закрытый пикер, который перестал спрашивать, останавливает и
# панель. Там, где панели нет, это лишний ssh раз в минуту — выключайте.
backgroundRefresh: true
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add frontend-src/config-shape.js config.example.yml test/config-shape.test.js
git commit -m "feat(config): ключ backgroundRefresh"
```

---

### Task A4: Поток опроса в Rust

**Files:**
- Modify: `src-tauri/src/poller.rs`
- Modify: `src-tauri/src/main.rs` (`setup`, `hide_window`, `toggle_picker`, `invoke_handler`)

**Interfaces:**
- Consumes: `fingerprint`, `next_delay`, `VISIBLE_TICK`, `BACKGROUND_MIN` из Task A1/A2; `crate::state_source::fetch`.
- Produces:
  - `pub struct Poller` с методами `pub fn start(app: tauri::AppHandle, ssh_host: String, background: bool) -> Poller`, `pub fn shown(&self)`, `pub fn hidden(&self)`, `pub fn nudge(&self)`, `pub fn set_config(&self, ssh_host: String, background: bool)`
  - Событие `state` с телом `{"state": <ответ агрегатора | null>, "error": <строка>}`
  - Команда `poll_now(poller: State<Poller>)`

- [ ] **Step 1: Написать реализацию потока**

Дописать в `src-tauri/src/poller.rs` над `mod tests`:

```rust
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

/// Что поток узнаёт извне.
enum Signal {
    /// Окно показано: отдать кэш немедленно и перейти на секундный такт.
    Shown,
    /// Окно скрыто: вернуться на минутный такт, а не на накопленный бэкофф —
    /// человек только что смотрел на список, и первый фоновый опрос должен
    /// быть скорым.
    Hidden,
    /// Опросить сейчас (первая подписка фронтенда, смена настроек).
    Nudge,
}

/// Последнее, что известно об агрегаторе.
///
/// Отказ хранится рядом с ответом, а не вместо него: оборвавшийся ssh в
/// закрытом окне сообщать некому, а выбрасывать из-за него уже показанный
/// список — значит гасить работающий пикер из-за чужой сети.
#[derive(Default)]
struct Cache {
    state: Option<serde_json::Value>,
    error: String,
}

/// Отправитель под мьютексом, а не голый.
///
/// `tauri::State` требует `Send + Sync`, а `Sender` стал `Sync` только в
/// Rust 1.72 — на более раннем тулчейне сборка падала бы с непонятной
/// ошибкой о трейте. Мьютекс здесь ничего не стоит: отправка идёт на нажатие
/// клавиши, а не в цикле.
pub struct Poller {
    tx: Mutex<Sender<Signal>>,
    cache: Arc<Mutex<Cache>>,
    settings: Arc<Mutex<(String, bool)>>,
}

fn payload(cache: &Cache) -> serde_json::Value {
    serde_json::json!({
        "state": cache.state.clone(),
        "error": cache.error.clone(),
    })
}

impl Poller {
    /// Поднять поток опроса. Окно на старте скрыто.
    pub fn start(app: tauri::AppHandle, ssh_host: String, background: bool) -> Poller {
        let (tx, rx) = channel::<Signal>();
        let cache = Arc::new(Mutex::new(Cache::default()));
        let settings = Arc::new(Mutex::new((ssh_host, background)));

        let thread_cache = Arc::clone(&cache);
        let thread_settings = Arc::clone(&settings);
        std::thread::spawn(move || {
            let mut visible = false;
            let mut delay = BACKGROUND_MIN;
            let mut prev_fingerprint: Option<String> = None;

            loop {
                let (host, background) = thread_settings.lock().unwrap().clone();

                // Спрашивать нечего и некого: без хоста ssh не собрать, а
                // выключенный фон при скрытом окне означает «стоим до показа».
                let idle = host.trim().is_empty() || (!visible && !background);
                if !idle {
                    let changed = match crate::state_source::fetch(&host) {
                        Ok(state) => {
                            let fp = fingerprint(&state);
                            let changed = prev_fingerprint.as_deref() != Some(fp.as_str());
                            prev_fingerprint = Some(fp);
                            let mut cache = thread_cache.lock().unwrap();
                            cache.state = Some(state);
                            cache.error.clear();
                            let _ = app.emit("state", payload(&cache));
                            changed
                        }
                        Err(e) => {
                            let mut cache = thread_cache.lock().unwrap();
                            cache.error = e;
                            // Показанному окну об отказе говорим сразу;
                            // скрытому — некому, и оно узнает при показе.
                            if visible {
                                let _ = app.emit("state", payload(&cache));
                            }
                            // Отказ — это «не изменилось»: сеть, лежащая
                            // десять минут, не повод десять минут долбить ssh.
                            false
                        }
                    };
                    delay = next_delay(visible, changed, delay);
                }

                // Спящий поток ждёт либо срока, либо сигнала. `recv_timeout`
                // на закрытом канале выходит из цикла: приложение кончилось.
                let wait = if idle { Duration::from_secs(3600) } else { delay };
                match rx.recv_timeout(wait) {
                    Ok(Signal::Shown) => {
                        visible = true;
                        delay = VISIBLE_TICK;
                        // Кэш отдаётся до опроса: ради этого фон и заведён —
                        // список рисуется, не дожидаясь ssh.
                        let cache = thread_cache.lock().unwrap();
                        let _ = app.emit("state", payload(&cache));
                    }
                    Ok(Signal::Hidden) => {
                        visible = false;
                        delay = BACKGROUND_MIN;
                    }
                    Ok(Signal::Nudge) => {
                        let cache = thread_cache.lock().unwrap();
                        let _ = app.emit("state", payload(&cache));
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
        });

        Poller { tx: Mutex::new(tx), cache, settings }
    }

    fn signal(&self, signal: Signal) {
        let _ = self.tx.lock().unwrap().send(signal);
    }

    pub fn shown(&self) {
        self.signal(Signal::Shown);
    }

    pub fn hidden(&self) {
        self.signal(Signal::Hidden);
    }

    pub fn nudge(&self) {
        self.signal(Signal::Nudge);
    }

    /// Новые настройки подхватываются следующим тактом: рвать текущий ssh
    /// незачем, он всё равно вот-вот кончится.
    pub fn set_config(&self, ssh_host: String, background: bool) {
        *self.settings.lock().unwrap() = (ssh_host, background);
        self.signal(Signal::Nudge);
    }

    /// Что известно прямо сейчас — для команды `poll_now`.
    pub fn snapshot(&self) -> serde_json::Value {
        payload(&self.cache.lock().unwrap())
    }
}
```

- [ ] **Step 2: Собрать и убедиться, что компилируется**

Run: `cd src-tauri && cargo build`
Expected: сборка проходит (предупреждения о неиспользуемых методах допустимы — они уйдут на следующем шаге).

- [ ] **Step 3: Подключить поток в `main.rs`**

В `src-tauri/src/main.rs`:

а) В `hide_window` (после `let _ = app.emit("picker-hidden", ());`, строка ~59) добавить:

```rust
    if let Some(poller) = app.try_state::<poller::Poller>() {
        poller.hidden();
    }
```

б) В `toggle_picker`, в ветке показа (после `let _ = app.emit("picker-shown", ());`, строка ~88):

```rust
            if let Some(poller) = app.try_state::<poller::Poller>() {
                poller.shown();
            }
```

в) Новая команда рядом с `fetch_state` (после строки 138):

```rust
/// Отдать фронтенду то, что уже известно, и подтолкнуть опрос.
///
/// Зовётся один раз, сразу после подписки на событие `state`: поток мог
/// ответить раньше, чем фронтенд успел подписаться, и без этого толчка первый
/// кадр ждал бы целого такта.
#[tauri::command]
fn poll_now(poller: tauri::State<poller::Poller>) -> serde_json::Value {
    poller.nudge();
    poller.snapshot()
}
```

г) В `invoke_handler` добавить `poll_now` к списку команд.

д) В `setup`, после чтения `let config = load_config()...` (строка ~482) и **до** регистрации хоткеев:

```rust
            // Опросом владеет Rust, а не страница: у скрытого окна webview
            // тормозит таймеры, а WebView2 у свёрнутого умеет усыплять
            // страницу целиком. Фон на setInterval замолчал бы, и узнать об
            // этом было бы неоткуда — панель просто перестала бы обновляться.
            let ssh_host = config
                .get("sshHost")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let background = config
                .get("backgroundRefresh")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            app.manage(poller::Poller::start(app.handle().clone(), ssh_host, background));
```

- [ ] **Step 4: Собрать и прогнать тесты**

Run: `cd src-tauri && cargo test`
Expected: PASS, сборка без ошибок.

- [ ] **Step 5: Коммит**

```bash
git add src-tauri/src/poller.rs src-tauri/src/main.rs
git commit -m "feat(poller): опрос агрегатора живёт в Rust и продолжается при закрытом окне

Такт: секунда на показанном окне, 1-2-4-8 минут на скрытом. Кэш отдаётся
на показе — список рисуется, не дожидаясь ssh."
```

---

### Task A5: Фронтенд становится подписчиком

**Files:**
- Modify: `sessions.html` (функция `refresh` ~740-777, `startPolling`/`stopPolling` 783-792, подписки 1449-1460, загрузка 1406 и 1475)

**Interfaces:**
- Consumes: событие `state` с телом `{state, error}` и команду `poll_now` из Task A4.
- Produces: ничего наружу.

- [ ] **Step 1: Заменить `refresh` на обработчик события**

В `sessions.html` заменить всю функцию `async function refresh() { ... }` (строки 740-777) на:

```js
  /**
   * Ответ агрегатора приехал.
   *
   * Опрос идёт в Rust: у скрытого окна webview тормозит таймеры, а WebView2 у
   * свёрнутого умеет усыплять страницу целиком — фон на setInterval замолчал
   * бы молча. Здесь остаётся только разбор ответа, тот же, что был.
   */
  function applyState(payload) {
    const state = payload && payload.state;
    if (!state) {
      // Отказ без единого удачного ответа — показывать нечего, кроме отказа.
      if (payload && payload.error) error = String(payload.error);
      render();
      return;
    }
    const problems = window.StateShape.validateState(state);
    if (problems.length) {
      error = problems[0];
      render();
      return;
    }
    // Претензии к записям projects опрос не отбрасывают: агрегатор обновляется
    // сам по себе, и переименованное там поле проекта заморозило бы список
    // сессий, к проектам отношения не имеющий. Кривые записи выбросит
    // buildProjectList, а человек узнаёт о потере из той же строки отказа, что
    // и обо всём остальном, — она показывается и поверх непустого списка.
    //
    // Претензии к записям снимков — по той же причине и в ту же строку. Первая
    // непустая строка отказа побеждает: показывается всё равно одна.
    //
    // Отказ ssh стоит первым: он про то, что список устарел целиком, а
    // остальные — про отдельные записи в нём.
    error = (payload && payload.error ? String(payload.error) : '')
      || window.StateShape.projectProblems(state)[0]
      || window.StateShape.snapshotProblems(state)[0] || '';
    lastSessions = state.sessions;
    // Поля может не быть — старый агрегатор на той стороне. Тогда режим /a
    // покажет пустой список, и это честный ответ, а не поломка.
    projectRows = window.ProjectList.buildProjectList(state);
    // То же самое про снимки и режим /s.
    snapshotRows = Array.isArray(state.snapshots) ? state.snapshots : [];
    lastState = state;
    regroup();
  }
```

- [ ] **Step 2: Убрать таймер**

Заменить блок `startPolling`/`stopPolling` (строки 779-792, вместе с комментарием про `picker-shown`/`picker-hidden` и `let timer = null;`) на:

```js
  // Опрос идёт в Rust и не останавливается вместе с показом: он же держит
  // свежим дамп агрегатора, с которого живёт панель openHASP. Границы показа
  // приходят туда же событиями picker-shown/picker-hidden — они меняют такт,
  // а не включают и выключают опрос.
```

- [ ] **Step 3: Переписать подписки**

В блоке загрузки (строки ~1449-1460) заменить подписки `picker-shown` / `picker-hidden` и вызов `startPolling()` на:

```js
    // Ответ агрегатора приезжает событием: опросом распоряжается Rust.
    await listen('state', (event) => applyState(event.payload));

    // Fired by Rust every time the window is shown.
    await listen('picker-shown', beginShow);

    await listen('picker-hidden', () => {
      closeMenu();
      closeInfo();
    });

    // Подписка готова — забрать то, что поток успел узнать до неё, и
    // подтолкнуть свежий опрос.
    applyState(await invoke('poll_now'));
```

Убрать вызов `startPolling();` на строке 1406 и, если он там был, из `beginShow`.

- [ ] **Step 4: Проверить**

Run: `npm test`
Expected: PASS (тесты фронтенда `sessions.html` не грузят напрямую, но `test/frontend-load.test.js` проверяет разметку — он должен остаться зелёным).

Run: `cd src-tauri && cargo test && cargo build`
Expected: PASS.

Ручная проверка: `npm run tauri dev` (или как принято в проекте), открыть пикер — список появляется сразу, без пустого кадра; закрыть окно и через полторы минуты убедиться, что дамп на удалённой стороне обновился (`ssh <host> 'stat -c %y ~/.ccfzf.sessions.json'` до и после).

- [ ] **Step 5: Коммит**

```bash
git add sessions.html
git commit -m "feat(picker): список приезжает событием, а не опросом со страницы"
```

---

# Часть B — суффиксы `-2`, `-3` у имён новых сессий

### Task B1: Чистая функция выбора свободного имени

**Files:**
- Create: `frontend-src/session-name.js`
- Create: `test/session-name.test.js`
- Modify: `scripts/prepare-frontend.js` (список `FILES`)

**Interfaces:**
- Consumes: ничего.
- Produces: `SessionName.uniqueSessionName(base, taken) -> string`

- [ ] **Step 1: Написать падающий тест**

Создать `test/session-name.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { uniqueSessionName } = require('../frontend-src/session-name');

test('свободное имя берётся как есть', () => {
  assert.strictEqual(uniqueSessionName('ccfzf-picker', []), 'ccfzf-picker');
  assert.strictEqual(uniqueSessionName('ccfzf-picker', ['другая']), 'ccfzf-picker');
});

test('занятое имя получает -2, следующее -3', () => {
  assert.strictEqual(uniqueSessionName('api', ['api']), 'api-2');
  assert.strictEqual(uniqueSessionName('api', ['api', 'api-2']), 'api-3');
  // Дыра в середине занимается, а не перепрыгивается: номер — не счётчик
  // сессий, а первое свободное имя.
  assert.strictEqual(uniqueSessionName('api', ['api', 'api-3']), 'api-2');
});

test('нумерация начинается с двух, а не с единицы', () => {
  // `api-1` человеку читается как «первая из многих», а первая называется
  // просто `api` — иначе имена разъезжаются с тем, что уже открыто.
  assert.notStrictEqual(uniqueSessionName('api', ['api']), 'api-1');
});

test('мусор в списке занятых не мешает', () => {
  // Список собирается из ответа агрегатора: там бывают и пустые заголовки, и
  // не строки вовсе. Уронить на этом выбор имени нельзя — пикер остался бы
  // без новой сессии.
  assert.strictEqual(uniqueSessionName('api', [null, 42, '', '  ', 'api']), 'api-2');
  assert.strictEqual(uniqueSessionName('api', null), 'api');
  assert.strictEqual(uniqueSessionName('api', 'строка'), 'api');
});

test('пустое базовое имя остаётся пустым', () => {
  // Суффикс к пустоте дал бы имя `-2`, и оно ничего не значит. Пустое имя —
  // забота вызывающего: он и решает, запускать ли такую сессию.
  assert.strictEqual(uniqueSessionName('', ['']), '');
  assert.strictEqual(uniqueSessionName(null, []), '');
});

test('лишние пробелы в занятых не создают ложной свободы', () => {
  // Заголовок окна приезжает с той стороны и мог быть записан с пробелом.
  assert.strictEqual(uniqueSessionName('api', [' api ']), 'api-2');
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm test`
Expected: FAIL — `Cannot find module '../frontend-src/session-name'`.

- [ ] **Step 3: Реализовать**

Создать `frontend-src/session-name.js`:

```js
// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SessionName = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Свободное имя для новой сессии.
   *
   * Занято — `-2`, дальше `-3`, и так далее, без потолка. Нумерация с двойки,
   * а не с единицы: первая сессия называется просто именем каталога, и
   * `имя-1` рядом с ней читалось бы как другая сессия.
   *
   * Занятыми считаются имена **живых** сессий — решает это вызывающий. Имя
   * здесь не украшение: по заголовку окна оконный трекер привязывает сессию к
   * слоту, и мешают друг другу именно живые тёзки. Мёртвая сессия с тем же
   * именем не мешает никому.
   *
   * Мусор в списке занятых выбрасывается молча: список собирается из ответа
   * агрегатора, а тот меняется сам по себе — отказ здесь оставил бы человека
   * без новой сессии из-за чужого поля.
   *
   * Пустое базовое имя возвращается пустым: суффикс к пустоте дал бы `-2`,
   * имя, которое ничего не значит. Что делать с пустотой, решает вызывающий.
   */
  function uniqueSessionName(base, taken) {
    const name = String(base == null ? '' : base).trim();
    if (!name) return '';
    const used = new Set(
      (Array.isArray(taken) ? taken : [])
        .filter(t => typeof t === 'string')
        .map(t => t.trim())
        .filter(Boolean),
    );
    if (!used.has(name)) return name;
    // Цикл конечен: занятых конечное число, и каждый шаг пробует новое имя.
    for (let n = 2; ; n += 1) {
      const candidate = `${name}-${n}`;
      if (!used.has(candidate)) return candidate;
    }
  }

  return { uniqueSessionName };
});
```

В `scripts/prepare-frontend.js` добавить в массив `FILES`:

```js
  'frontend-src/session-name.js',
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add frontend-src/session-name.js test/session-name.test.js scripts/prepare-frontend.js
git commit -m "feat(picker): выбор свободного имени для новой сессии"
```

---

### Task B2: `newSessionCommand` учитывает занятые имена

**Files:**
- Modify: `frontend-src/open-strategy.js:95-100` (`newSessionCommand`) и блок экспорта в конце файла
- Test: `test/open-strategy.test.js`

**Interfaces:**
- Consumes: `SessionName.uniqueSessionName` из Task B1.
- Produces: `OpenStrategy.newSessionName(cwd, taken) -> string`, `OpenStrategy.newSessionCommand(cwd, taken) -> string`

- [ ] **Step 1: Написать падающий тест**

Добавить в `test/open-strategy.test.js`:

```js
test('новая сессия в занятом имени получает суффикс', () => {
  const cmd = newSessionCommand('/home/user/projects/api', ['api']);
  assert.match(cmd, /claude -n 'api-2'/);
});

test('свободное имя остаётся без суффикса', () => {
  const cmd = newSessionCommand('/home/user/projects/api', ['другая']);
  assert.match(cmd, /claude -n 'api'/);
});

test('без списка занятых поведение прежнее', () => {
  // Аргумент необязателен: вызов без него не должен ломаться — так зовут из
  // тестов соседних функций и из старого кода.
  assert.match(newSessionCommand('/home/user/projects/api'), /claude -n 'api'/);
});

test('newSessionName отдаёт то же имя, что попадает в команду', () => {
  // Имя нужно вызывающему отдельно: он помнит выданные имена, чтобы два ^N
  // подряд не дали тёзок. Разойтись этим двум нельзя.
  const taken = ['api'];
  const name = newSessionName('/home/user/projects/api', taken);
  assert.strictEqual(name, 'api-2');
  assert.ok(newSessionCommand('/home/user/projects/api', taken).includes(`-n '${name}'`));
});

test('путь с точкой с запятой отказывает и по имени тоже', () => {
  // Отказ остаётся первым: Windows Terminal порежет такую команду на панели
  // ещё до шелла, и никакое имя этого не спасает.
  assert.strictEqual(newSessionCommand('/home/user/a;b', ['a;b']), '');
  assert.strictEqual(newSessionName('/home/user/a;b', []), '');
});
```

Дописать `newSessionName` в деструктуризацию импорта вверху файла теста (рядом с `newSessionCommand`).

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm test`
Expected: FAIL — `newSessionName is not a function`, и суффикс не появляется.

- [ ] **Step 3: Реализовать**

В `frontend-src/open-strategy.js`, сразу после шима (после строки `})(typeof self !== 'undefined' ? self : this, function () {`) добавить получение соседнего модуля тем же приёмом, что в `ui-state.js`:

```js
  // globalThis, а не `root`: тот виден только внешней функции шима, а внутрь
  // factory не передаётся.
  const nameApi = typeof module === 'object' && module.exports
    ? require('./session-name')
    : globalThis.SessionName;
```

Заменить `newSessionCommand` (строки 95-100) на:

```js
  /**
   * Имя новой сессии в каталоге, с оглядкой на занятые.
   *
   * Отдаётся отдельно от команды, потому что вызывающему оно нужно само по
   * себе: он помнит выданные имена минуту, иначе два `^N` подряд — быстрее
   * опроса — дали бы двух тёзок. Разойтись с именем в команде эта функция не
   * может: команда её и зовёт.
   *
   * Путь с `;` — пустая строка, тот же отказ, что и у команды.
   */
  function newSessionName(cwd, taken) {
    const path = String(cwd == null ? '' : cwd).replace(/\/+$/, '');
    if (path.includes(';')) return '';
    const base = path.split('/').pop() || path;
    return nameApi.uniqueSessionName(base, taken);
  }

  function newSessionCommand(cwd, taken) {
    const path = String(cwd == null ? '' : cwd).replace(/\/+$/, '');
    if (path.includes(';')) return '';
    const name = newSessionName(path, taken);
    return inDir(path, `claude -n ${q(name)}`);
  }
```

Комментарий над `newSessionCommand` (строки 76-94) оставить на месте, дописав в него абзац:

```js
   * Тёзки различаются суффиксом: имя занятой живой сессии получает `-2`,
   * следующее `-3`. Занятые приходят аргументом — знать, что сейчас живо,
   * может только вызывающий.
```

В блоке экспорта в конце файла добавить `newSessionName,` рядом с `newSessionCommand,`.

Добавить `frontend-src/session-name.js` в `sessions.html` тегом `<script>` **перед** `open-strategy.js` (порядок важен: `open-strategy` берёт модуль в момент загрузки).

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add frontend-src/open-strategy.js sessions.html test/open-strategy.test.js
git commit -m "feat(picker): имя новой сессии обходит живых тёзок"
```

---

### Task B3: Пикер собирает занятые имена

**Files:**
- Modify: `sessions.html` (функция `newSession` ~1133-1157)

**Interfaces:**
- Consumes: `OpenStrategy.newSessionName`, `OpenStrategy.newSessionCommand` из Task B2; `lastSessions`.
- Produces: ничего наружу.

- [ ] **Step 1: Написать реализацию**

В `sessions.html` над функцией `newSession` добавить:

```js
  /**
   * Имена, которые сейчас нельзя занимать.
   *
   * Две части. Первая — заголовки живых сессий из последнего ответа: имя
   * сессии и есть заголовок её окна, по нему оконный трекер привязывает
   * сессию к слоту, и мешают друг другу именно живые тёзки.
   *
   * Вторая — имена, которые пикер выдал сам за последнюю минуту. Без неё два
   * `^N` подряд, быстрее опроса, дали бы одно имя дважды: ответ агрегатора
   * ещё не знает о первой сессии. Минута взята по верхнему такту фонового
   * опроса — за это время сессия попадает в ответ при любом раскладе.
   */
  const issuedNames = new Map();
  const ISSUED_TTL_MS = 60_000;

  function takenSessionNames() {
    const now = Date.now();
    for (const [name, at] of issuedNames) {
      if (now - at > ISSUED_TTL_MS) issuedNames.delete(name);
    }
    const live = lastSessions
      .filter(s => s && s.live)
      .map(s => s && s.title)
      .filter(t => typeof t === 'string' && t);
    return live.concat(Array.from(issuedNames.keys()));
  }
```

Заменить тело `newSession` (строки 1133-1157) на:

```js
  async function newSession(cwd) {
    if (!cwd || sshHostMissing()) return;
    const taken = takenSessionNames();
    // Пустая команда — отказ OpenStrategy, а не поломка: путь с `;` Windows
    // Terminal порежет на панели ещё до шелла. Сказать об этом обязательно —
    // иначе кнопка молча ничего не делает.
    const remote = window.OpenStrategy.newSessionCommand(cwd, taken);
    if (!remote) {
      error = `В пути есть «;», такой каталог открыть нечем: ${cwd}`;
      render();
      return;
    }
    const argv = [
      CONFIG.terminal.file, ...CONFIG.terminal.args,
      'ssh', '-t', CONFIG.sshHost,
      remote,
    ];
    try {
      await invoke('spawn_detached', { argv });
    } catch (e) {
      error = String(e);
      render();
      return;
    }
    // Имя запоминается только после удачного запуска: занять его на отказе
    // значило бы отдать следующей сессии `-2` без всякой первой.
    const name = window.OpenStrategy.newSessionName(cwd, taken);
    if (name) issuedNames.set(name, Date.now());
    invoke('hide_picker');
  }
```

- [ ] **Step 2: Проверить**

Run: `npm test`
Expected: PASS.

Ручная проверка: открыть пикер, нажать `^N` на строке проекта дважды подряд — второй терминал должен подняться с именем `<проект>-2`.

- [ ] **Step 3: Коммит**

```bash
git add sessions.html
git commit -m "feat(picker): ^N не заводит живых тёзок

Занятыми считаются заголовки живых сессий и имена, выданные самим пикером
за последнюю минуту: ответ агрегатора не успевает узнать о только что
запущенной сессии."
```

---

### Task B4: Та же правка в ccfzf

Отдельный репозиторий: `~/projects/shell/ccfzf`. Коммит туда же, в PR этого проекта не входит.

**Files:**
- Modify: `~/projects/shell/ccfzf/ccfzf` — питоновская часть (функция рядом с `tail_facts`, ветка режимов после `elif mode == "state":`) и шелловская ветка `__new__` (строка ~1659)
- Create: `~/projects/shell/ccfzf/tests/test_session_name.py`

**Interfaces:**
- Consumes: `index.json` (ключи `dirs`, `live`), функции `tail_facts`, `clean` — уже есть в файле; `tests/harness.py`.
- Produces: `free_session_name(base, taken)` в питоновском блоке и режим `python3 -c "$PY" newname <index> <basename>`, печатающий одно имя в stdout.

- [ ] **Step 1: Написать падающий тест**

Правило выносится отдельной функцией, а не живёт внутри ветки режима: ветку тестовый харнесс намеренно не выполняет (`sys.argv` из одного элемента), а правило проверить надо — оно должно совпадать с пикером.

Создать `~/projects/shell/ccfzf/tests/test_session_name.py`:

```python
"""Свободное имя новой сессии. Запуск: python3 tests/test_session_name.py"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness

CC = harness.load()


def test_free_name_is_taken_as_is():
    assert CC["free_session_name"]("api", set()) == "api"
    assert CC["free_session_name"]("api", {"other"}) == "api"


def test_taken_name_gets_a_suffix():
    assert CC["free_session_name"]("api", {"api"}) == "api-2"
    assert CC["free_session_name"]("api", {"api", "api-2"}) == "api-3"


def test_the_gap_is_filled_not_skipped():
    # Номер — это первое свободное имя, а не счётчик сессий.
    assert CC["free_session_name"]("api", {"api", "api-3"}) == "api-2"


def test_numbering_starts_at_two():
    # Первая сессия называется просто именем каталога, и `api-1` рядом с ней
    # читался бы как ещё одна из многих. То же правило в ccfzf-picker.
    assert CC["free_session_name"]("api", {"api"}) != "api-1"


if __name__ == "__main__":
    fails = 0
    names = [n for n in globals() if n.startswith("test_")]
    for name in sorted(names):
        try:
            globals()[name]()
            print("ok   " + name)
        except AssertionError as e:
            fails += 1
            print("FAIL " + name + ": " + str(e))
    print("%d/%d passed" % (len(names) - fails, len(names)))
    sys.exit(1 if fails else 0)
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd ~/projects/shell/ccfzf && python3 tests/test_session_name.py`
Expected: FAIL — `KeyError: 'free_session_name'`.

- [ ] **Step 3: Написать функцию и режим `newname`**

В `~/projects/shell/ccfzf/ccfzf`, в питоновской части рядом с `tail_facts` (то есть среди определений, до разбора режимов), добавить:

```python
def free_session_name(base, taken):
    """Свободное имя новой сессии: занято — `-2`, дальше `-3`.

    Нумерация с двойки: первая сессия называется просто именем каталога, и
    `имя-1` рядом с ней читался бы как другая сессия.

    Правило то же, что у uniqueSessionName в ccfzf-picker
    (frontend-src/session-name.js). Общего кода нет — языки разные, и держать
    их в согласии приходится этим комментарием и парой одинаковых тестов.
    """
    name = base
    n = 2
    while name in taken:
        name = "%s-%d" % (base, n)
        n += 1
    return name
```

Ветку режима добавить рядом с остальными, после блока `elif mode == "state":`:

```python
elif mode == "newname":
    # Занятыми считаются заголовки живых сессий: имя сессии — это заголовок её
    # окна, по нему оконный трекер привязывает сессию к слоту, и мешают друг
    # другу именно живые тёзки. Мёртвая сессия с тем же именем не мешает
    # никому. Живых немного, и чтение их хвостов ничего не стоит рядом с двумя
    # сотнями в дампе.
    index_path = sys.argv[2]
    base = sys.argv[3]

    with open(index_path, encoding="utf-8") as fh:
        index = json.load(fh)
    live = set(index["live"])

    taken = set()
    for entry in index["dirs"]:
        for path, _mtime in entry["files"]:
            sid = os.path.basename(path)[:-6]
            if sid not in live:
                continue
            title = clean(tail_facts(path)[0])
            if title:
                taken.add(title.strip())

    print(free_session_name(base, taken))
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `cd ~/projects/shell/ccfzf && python3 tests/test_session_name.py`
Expected: `4/4 passed`.

- [ ] **Step 5: Подставить режим в ветку `__new__`**

Заменить строку 1659 в `~/projects/shell/ccfzf/ccfzf`:

```sh
    # Name the session after the project folder so WT titles and the
    # project hotkeys can find it without waiting for /rename.
    #
    # Живая тёзка получает суффикс: два окна с одинаковым заголовком оконный
    # трекер путает между собой. Отказ python3 не должен отнимать новую
    # сессию — тогда имя остаётся прежним, как было до суффиксов.
    __new__)
      new_name=$(python3 -c "$PY" newname "$index" "$(basename "$dir")" 2>/dev/null)
      [[ -n $new_name ]] || new_name=$(basename "$dir")
      cmd="$CLAUDE_CMD -n $(printf '%q' "$new_name")$claude_tail" ;;
```

- [ ] **Step 6: Прогнать все тесты репозитория**

Run: `cd ~/projects/shell/ccfzf && for t in tests/test_*.py; do python3 "$t" || exit 1; done`
Expected: каждый файл печатает `N/N passed`, выход 0.

Ручная проверка: в проекте с одной живой сессией `demo` выбрать «[+] new session» — новый терминал должен называться `demo-2`.

- [ ] **Step 7: Коммит**

```bash
cd ~/projects/shell/ccfzf
git add ccfzf tests/test_session_name.py
git commit -m "feat: суффикс -2 у имени новой сессии при живой тёзке

Имя сессии — заголовок её окна, по нему оконный трекер привязывает
сессию к слоту; два одинаковых заголовка он путает. То же правило в
ccfzf-picker, frontend-src/session-name.js."
```

---

# Часть C — окно настроек

### Task C1: Двухосная модель галок в `ui.json`

**Files:**
- Modify: `frontend-src/ui-state.js`
- Test: `test/ui-state.test.js`

**Interfaces:**
- Consumes: `SessionGroups.normalizeSort` (как сейчас).
- Produces: `UiState.normalizeUiState(raw, defaults)` с `toggles[key] = {list: boolean, statusline: boolean}`; `UiState.uiStateToSave(sort, toggles)`; `UiState.listColumns(toggles) -> {[key]: boolean}`.

- [ ] **Step 1: Написать падающий тест**

Переписать `test/ui-state.test.js`, заменив `DEFAULTS` и добавив тесты:

```js
const DEFAULTS = {
  sort: 'recent',
  toggles: {
    showPrompt: { list: true, statusline: true },
    showId: { list: false, statusline: true },
    showCost: { list: true, statusline: false },
  },
};
```

Существующие тесты поправить под новую форму (`toggles: { showPrompt: { list: false, statusline: true }, ... }`) и добавить:

```js
test('старая плоская форма поднимается, а не выбрасывается', () => {
  // Главный тест этой правки. Не поняв старый ui.json, первый же запуск после
  // обновления сбросил бы человеку все колонки — и выглядело бы это как
  // потеря настроек, а не как несовместимость.
  const old = { sort: 'name', toggles: { showPrompt: false, showId: true, showCost: false } };
  const ui = normalizeUiState(old, DEFAULTS);
  assert.strictEqual(ui.sort, 'name');
  // Значение старой галки — это ось list: она и значила «показывать колонку».
  assert.strictEqual(ui.toggles.showPrompt.list, false);
  assert.strictEqual(ui.toggles.showId.list, true);
  // Ось statusline в старом файле не записана ничем — берётся умолчание ключа.
  assert.strictEqual(ui.toggles.showPrompt.statusline, true);
  assert.strictEqual(ui.toggles.showCost.statusline, false);
});

test('половина записанной оси не роняет вторую', () => {
  // Файл правят руками, и половина пары там встречается чаще целой.
  const ui = normalizeUiState({ toggles: { showId: { statusline: false } } }, DEFAULTS);
  assert.deepStrictEqual(ui.toggles.showId, { list: false, statusline: false });
});

test('нелогические оси заменяются умолчаниями своего ключа', () => {
  const ui = normalizeUiState({ toggles: { showPrompt: { list: 'да', statusline: 0 } } }, DEFAULTS);
  assert.deepStrictEqual(ui.toggles.showPrompt, { list: true, statusline: true });
});

test('listColumns отдаёт плоскую карту для отрисовки', () => {
  // Рисовальщики строк (session-glyph) знают только «показывать колонку или
  // нет» и не должны узнавать про статуслайн: у них другая забота.
  const ui = normalizeUiState({}, DEFAULTS);
  assert.deepStrictEqual(listColumns(ui.toggles), {
    showPrompt: true, showId: false, showCost: true,
  });
});

test('в файл уходит ровно то, что читается обратно', () => {
  const toggles = {
    showPrompt: { list: false, statusline: true },
    showId: { list: true, statusline: false },
    showCost: { list: true, statusline: false },
  };
  const saved = uiStateToSave('name', toggles);
  assert.deepStrictEqual(saved, { sort: 'name', toggles });
  assert.deepStrictEqual(normalizeUiState(saved, DEFAULTS), saved);
});
```

Импорт вверху файла дополнить: `const { normalizeUiState, uiStateToSave, listColumns } = require('../frontend-src/ui-state');`

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npm test`
Expected: FAIL — `listColumns is not a function` и несовпадение формы `toggles`.

- [ ] **Step 3: Реализовать**

В `frontend-src/ui-state.js` заменить `normalizeUiState` и `uiStateToSave` на:

```js
  /**
   * Умолчания одной галки в двух осях.
   *
   * `list` — показывать ли колонку в строке списка (это и значила старая
   * плоская галка). `statusline` — выносить ли галку в статуслайн: место там
   * кончилось, и решать, что туда попадёт, стал человек.
   */
  function axesOf(fallback) {
    if (typeof fallback === 'boolean') return { list: fallback, statusline: false };
    const base = fallback && typeof fallback === 'object' ? fallback : {};
    return { list: Boolean(base.list), statusline: Boolean(base.statusline) };
  }

  /**
   * Одна галка из файла.
   *
   * Булево значение — это старая форма ui.json, и понимать её обязательно:
   * иначе первый же запуск после обновления сбросил бы человеку все колонки, и
   * выглядело бы это потерей настроек, а не сменой формата. Значение старой
   * галки кладётся в `list` — она ровно это и значила.
   */
  function normalizeToggle(saved, fallback) {
    const def = axesOf(fallback);
    if (typeof saved === 'boolean') return { list: saved, statusline: def.statusline };
    if (!saved || typeof saved !== 'object') return def;
    return {
      list: typeof saved.list === 'boolean' ? saved.list : def.list,
      statusline: typeof saved.statusline === 'boolean' ? saved.statusline : def.statusline,
    };
  }

  function normalizeUiState(raw, defaults) {
    const base = defaults || {};
    const baseToggles = base.toggles || {};
    const src = raw && typeof raw === 'object' ? raw : {};
    const srcToggles = src.toggles && typeof src.toggles === 'object' ? src.toggles : {};

    const toggles = {};
    for (const key of Object.keys(baseToggles)) {
      toggles[key] = normalizeToggle(srcToggles[key], baseToggles[key]);
    }
    return {
      sort: groupsApi.normalizeSort(src.sort),
      toggles,
    };
  }

  /**
   * Что уходит в файл. Ровно то же, что читается: лишнего в ui.json пикер не
   * пишет — файл маленький и человекочитаемый, и заглянувший в него не должен
   * гадать, что из этого пикер и правда помнит.
   */
  function uiStateToSave(sort, toggles) {
    return normalizeUiState({ sort, toggles }, { toggles: toggles || {} });
  }

  /**
   * Плоская карта «показывать ли колонку» для рисовальщиков строк.
   *
   * Отдельная функция, а не второе поле состояния: рисовальщикам
   * (session-glyph) про статуслайн знать незачем, а держать две карты в
   * рассинхроне — вернейший способ показать колонку, которую выключили.
   */
  function listColumns(toggles) {
    const out = {};
    for (const key of Object.keys(toggles || {})) out[key] = Boolean((toggles[key] || {}).list);
    return out;
  }

  return { normalizeUiState, uiStateToSave, listColumns };
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add frontend-src/ui-state.js test/ui-state.test.js
git commit -m "feat(ui): две оси у галки — колонка в списке и галка в статуслайне

Старая плоская форма ui.json поднимается в list: не поняв её, обновление
сбросило бы человеку все колонки."
```

---

### Task C2: Статуслайн рисует только вынесенные галки

**Files:**
- Modify: `sessions.html` — `TOGGLE_CHECKS` (357-368), умолчания `toggles` (373-388), построение чекбоксов (443-460), `paintToggles` (462-469), все чтения `toggles.*` при отрисовке (525, 576, 611, 617, 619, 626-630, 700), загрузка `ui.json` (~1434)

**Interfaces:**
- Consumes: `UiState.normalizeUiState`, `UiState.listColumns` из Task C1.
- Produces: `columns` — плоская карта в области видимости `sessions.html`; функция `renderChecks()`, пригодная к повторному вызову.

- [ ] **Step 1: Перевести умолчания на две оси**

В `sessions.html` заменить блок `let toggles = { ... }` (строки 373-388) на:

```js
  // Умолчания. Ось `list` — как было: выключены те колонки, что отвечают на
  // вопрос «как эта сессия дошла до жизни такой», а не «стоит ли в неё
  // заходить». Ось `statusline` решает, попадёт ли галка в строку внизу; там
  // место кончилось, и по умолчанию вынесены только пять самых частых.
  // Остальные правятся в окне настроек.
  let toggles = {
    showPrompt: { list: true, statusline: true },
    showAnswer: { list: true, statusline: true },
    showPaths: { list: true, statusline: true },
    showHotkey: { list: true, statusline: false },
    showEvent: { list: false, statusline: false },
    showId: { list: false, statusline: true },
    showCost: { list: false, statusline: false },
    showContext: { list: true, statusline: true },
    showWindow: { list: true, statusline: false },
    // Выключен: список без трекера и так весь без окон, и включённый фильтр
    // показал бы пустоту вместо сессий — с виду неотличимо от сломанного ssh.
    onlyWindow: { list: false, statusline: false },
  };
  // Плоская карта «показывать ли колонку»: её читают рисовальщики строк.
  // Пересчитывается из toggles одной функцией, чтобы две формы не разъехались.
  let columns = window.UiState.listColumns(toggles);
```

- [ ] **Step 2: Сделать чекбоксы перерисовываемыми**

Заменить блок построения чекбоксов (строки 443-460, от `const toggleInputs = new Map();` до закрывающей скобки цикла) на:

```js
  // Чекбоксы статуслайна и их обработчики — из одной таблицы. Клик по самому
  // чекбоксу не должен всплывать до statusline: там висит смена сортировки.
  //
  // Строится функцией, а не один раз при загрузке: набор вынесенных галок
  // меняется из окна настроек, и разметка обязана перестраиваться на месте —
  // иначе новая галка появлялась бы только после перезапуска.
  const toggleInputs = new Map();

  function renderChecks() {
    toggleInputs.clear();
    const shown = TOGGLE_CHECKS.filter(({ key }) => (toggles[key] || {}).statusline);
    // Отбивка между группами — на первом чекбоксе каждой следующей: отдельный
    // пустой элемент-разделитель пришлось бы ещё и прятать, когда группа пуста.
    statusChecks.innerHTML = shown.map(({ key, label, side }, i) => {
      const gap = i > 0 && shown[i - 1].side !== side ? ' gap' : '';
      return `<label class="status-check${gap}"><input type="checkbox" data-toggle="${key}"> ${escapeHtml(label)}</label>`;
    }).join('');
    for (const input of statusChecks.querySelectorAll('input[data-toggle]')) {
      const key = input.dataset.toggle;
      toggleInputs.set(key, input);
      input.addEventListener('click', (e) => {
        e.stopPropagation();
      });
      input.addEventListener('change', () => {
        // Галка в статуслайне правит ось list: она и значит «показывать
        // колонку». Второй осью распоряжается только окно настроек.
        toggles[key] = { ...toggles[key], list: input.checked };
        columns = window.UiState.listColumns(toggles);
        render();
        saveUi();
      });
    }
  }

  renderChecks();
```

- [ ] **Step 3: Поправить `paintToggles` и чтения колонок**

В `paintToggles` (строка 462) заменить первую строку на:

```js
    for (const [key, input] of toggleInputs) input.checked = !!(toggles[key] || {}).list;
```

Заменить все чтения колонок при отрисовке на `columns.*`:
- строки 525, 576, 611: `toggles.showPaths` → `columns.showPaths`
- строка 617: `toggles.showPrompt` → `columns.showPrompt`
- строка 619: `toggles.showAnswer` → `columns.showAnswer`
- строка 626: `windowHtml(session, toggles.showWindow)` → `windowHtml(session, columns.showWindow)`
- строка 627: `stateHtml(session, toggles.showEvent)` → `stateHtml(session, columns.showEvent)`
- строка 628: `sessionIdHtml(session, toggles.showId)` → `sessionIdHtml(session, columns.showId)`
- строка 629: `hotkeyHtml(session, toggles.showHotkey)` → `hotkeyHtml(session, columns.showHotkey)`
- строка 630: `usageHtml(session, toggles)` → `usageHtml(session, columns)`
- строка 700: `onlyWindow: toggles.onlyWindow` → `onlyWindow: columns.onlyWindow`

- [ ] **Step 4: Поправить загрузку `ui.json`**

В блоке загрузки (строка ~1434) заменить присваивание на:

```js
      sortMode = ui.sort;
      toggles = ui.toggles;
      columns = window.UiState.listColumns(toggles);
      renderChecks();
```

- [ ] **Step 5: Проверить**

Run: `npm test`
Expected: PASS.

Ручная проверка: запустить пикер — в статуслайне остаются пять галок (prompt, answer, paths, context, id); колонки `hotkeys` и `window` рисуются, хотя галок у них больше нет; клик по галке по-прежнему прячет колонку и переживает перезапуск.

- [ ] **Step 6: Коммит**

```bash
git add sessions.html
git commit -m "feat(picker): в статуслайне остаются только вынесенные галки

Набор задаётся осью statusline и меняется из окна настроек, поэтому
разметка строится функцией, а не один раз при загрузке."
```

---

### Task C3: Слияние патча в `config.yaml`

**Files:**
- Create: `src-tauri/src/config_file.rs`
- Modify: `src-tauri/src/main.rs` (`mod config_file;`)

**Interfaces:**
- Consumes: ничего.
- Produces:
  - `pub const HEADER: &str`
  - `pub fn merge_patch(doc: &mut serde_yaml::Value, patch: &serde_json::Value) -> Result<(), String>`
  - `pub fn render(doc: &serde_yaml::Value) -> Result<String, String>`

- [ ] **Step 1: Написать падающий тест**

Создать `src-tauri/src/config_file.rs`:

```rust
//! Запись config.yaml из окна настроек.

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(yaml: &str) -> serde_yaml::Value {
        serde_yaml::from_str(yaml).unwrap()
    }

    /// Нетронутые ключи переживают запись.
    ///
    /// Ради этого патч и слияние: окно настроек не знает про `actions` вовсе,
    /// а перезапись целиком стёрла бы их человеку молча.
    #[test]
    fn untouched_keys_survive() {
        let mut d = doc("sshHost: old\nactions:\n  - id: finder\n    argv: ['open', '{localPath}']\n");
        merge_patch(&mut d, &serde_json::json!({"sshHost": "new"})).unwrap();
        let out = render(&d).unwrap();
        assert!(out.contains("new"), "новое значение записано: {out}");
        assert!(!out.contains("old"), "старое значение заменено: {out}");
        assert!(out.contains("finder"), "чужой ключ на месте: {out}");
    }

    /// Вложенное отображение сливается по ключам, а не заменяется целиком.
    ///
    /// Из-за пароля: окно настроек не показывает его и не присылает обратно —
    /// замена блока целиком стирала бы пароль на каждом сохранении.
    #[test]
    fn nested_maps_merge_key_by_key() {
        let mut d = doc("mqtt:\n  host: broker\n  base: home/room/pc\n  password: secret\n");
        merge_patch(&mut d, &serde_json::json!({"mqtt": {"host": "other"}})).unwrap();
        let out = render(&d).unwrap();
        assert!(out.contains("other"));
        assert!(out.contains("secret"), "пароль не тронут: {out}");
        assert!(out.contains("home/room/pc"), "префикс топиков не тронут: {out}");
    }

    /// Списки заменяются целиком: слить два списка проектов по ключам нечем,
    /// а «дописать» — не то, чего хочет человек, убравший строку из формы.
    #[test]
    fn lists_are_replaced_whole() {
        let mut d = doc("projects:\n  - path: /a\n    hotkey: Cmd+Shift+1\n  - path: /b\n");
        merge_patch(&mut d, &serde_json::json!({
            "projects": [{"path": "/a", "hotkey": "Cmd+Shift+9"}]
        })).unwrap();
        let out = render(&d).unwrap();
        assert!(out.contains("Cmd+Shift+9"));
        assert!(!out.contains("/b"), "убранный проект не воскресает: {out}");
    }

    /// Пустой документ — не отказ: конфига могло не быть вовсе.
    #[test]
    fn empty_document_becomes_a_mapping() {
        let mut d = serde_yaml::Value::Null;
        merge_patch(&mut d, &serde_json::json!({"sshHost": "host"})).unwrap();
        assert!(render(&d).unwrap().contains("host"));
    }

    /// Патч не той формы — отказ, а не молчаливая порча файла.
    #[test]
    fn non_object_patch_is_refused() {
        let mut d = doc("sshHost: old\n");
        assert!(merge_patch(&mut d, &serde_json::json!("строка")).is_err());
        assert!(merge_patch(&mut d, &serde_json::json!([1, 2])).is_err());
    }

    /// Шапка — комментарий, и обратно она не читается: значит, на следующем
    /// сохранении не удвоится.
    #[test]
    fn header_is_a_comment_and_does_not_accumulate() {
        let once = format!("{HEADER}sshHost: host\n");
        let parsed: serde_yaml::Value = serde_yaml::from_str(&once).unwrap();
        let twice = format!("{HEADER}{}", render(&parsed).unwrap());
        assert_eq!(twice.matches("окно настроек").count(), HEADER.matches("окно настроек").count());
    }
}
```

Добавить в `src-tauri/src/main.rs` рядом с `mod mqtt;`:

```rust
mod config_file;
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd src-tauri && cargo test config_file`
Expected: FAIL — `cannot find function 'merge_patch'`.

- [ ] **Step 3: Реализовать**

Вставить в `src-tauri/src/config_file.rs` над `mod tests`:

```rust
/// Шапка переписанного конфига.
///
/// Записывается затем, что перезапись через serde_yaml теряет комментарии — а
/// в config.yaml они и есть документация. Человек, открывший файл после
/// первого сохранения, должен сразу понимать, куда делись его пометки и где
/// лежит прежний файл. Сама шапка — комментарий, разбор её выбрасывает, и на
/// следующем сохранении она не удваивается.
pub const HEADER: &str = "\
# Этот файл ведёт окно настроек ccfzf-picker: при сохранении он переписывается
# целиком, и комментарии в нём не сохраняются. Прежний файл лежит рядом —
# config.yaml.bak. Описание всех ключей — в config.example.yml репозитория.
";

/// Влить патч в документ.
///
/// Отображения сливаются по ключам, всё остальное заменяется целиком. Разница
/// не косметическая: `mqtt.password` окно настроек не показывает и обратно не
/// присылает, и замена блока целиком стирала бы пароль на каждом сохранении.
/// Списки, наоборот, заменяются: слить два списка проектов по ключам нечем, а
/// «дописать» — не то, чего хочет человек, убравший строку из формы.
pub fn merge_patch(doc: &mut serde_yaml::Value, patch: &serde_json::Value) -> Result<(), String> {
    let Some(fields) = patch.as_object() else {
        return Err("настройки пришли не объектом".into());
    };
    if doc.is_null() {
        *doc = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
    }
    let Some(map) = doc.as_mapping_mut() else {
        return Err("config.yaml — не отображение, править его нечем".into());
    };
    for (key, value) in fields {
        let key = serde_yaml::Value::String(key.clone());
        // Решение принимается до `get_mut`: заимствование от него живёт до
        // конца ветки, и `insert` в соседней уже не собрался бы.
        let nested = value.as_object().is_some()
            && map.get(&key).map(|v| v.is_mapping()).unwrap_or(false);
        if nested {
            // `unwrap` безопасен: `nested` истинно только когда ключ есть.
            merge_patch(map.get_mut(&key).unwrap(), value)?;
        } else {
            let incoming: serde_yaml::Value =
                serde_yaml::to_value(value).map_err(|e| format!("не перевести значение: {e}"))?;
            map.insert(key, incoming);
        }
    }
    Ok(())
}

/// Документ в текст, без шапки: её ставит вызывающий.
pub fn render(doc: &serde_yaml::Value) -> Result<String, String> {
    serde_yaml::to_string(doc).map_err(|e| format!("не собрать yaml: {e}"))
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd src-tauri && cargo test config_file`
Expected: PASS, 6 тестов.

- [ ] **Step 5: Коммит**

```bash
git add src-tauri/src/config_file.rs src-tauri/src/main.rs
git commit -m "feat(config): слияние патча настроек в config.yaml

Отображения сливаются по ключам: mqtt.password окно не показывает и не
присылает обратно, замена блока целиком стирала бы его при каждом
сохранении."
```

---

### Task C4: Команда `save_config` и окно настроек

**Files:**
- Modify: `src-tauri/src/main.rs` (новые команды, `invoke_handler`)
- Modify: `src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: `config_file::{HEADER, merge_patch, render}` из Task C3; `poller::Poller` из Task A4.
- Produces: команды `save_config(patch, app)`, `open_settings(app)`; событие `config-changed`.

- [ ] **Step 1: Реализовать команды**

В `src-tauri/src/main.rs` добавить рядом с `load_config` (после строки 286):

```rust
fn config_path() -> Result<std::path::PathBuf, String> {
    let home = home_dir().ok_or("neither HOME nor USERPROFILE is set")?;
    Ok(std::path::Path::new(&home).join(".config/ccfzf-picker/config.yaml"))
}

/// Сохранить настройки, присланные окном настроек.
///
/// Патч, а не файл целиком: окно знает не про все ключи (`actions` оно только
/// показывает), и перезапись целиком стёрла бы остальное. Слияние — в
/// `config_file::merge_patch`.
///
/// Бэкап кладётся один раз, перед первой перезаписью: комментарии человека
/// после неё не восстановить ничем, а класть `.bak` на каждое сохранение
/// значило бы затирать его же вчерашним состоянием.
#[tauri::command]
fn save_config(app: tauri::AppHandle, patch: serde_json::Value) -> Result<(), String> {
    let path = config_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let existing = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };

    let mut doc: serde_yaml::Value = if existing.trim().is_empty() {
        serde_yaml::Value::Null
    } else {
        serde_yaml::from_str(&existing).map_err(|e| format!("bad yaml in {}: {e}", path.display()))?
    };
    config_file::merge_patch(&mut doc, &patch)?;

    let backup = path.with_extension("yaml.bak");
    if !existing.is_empty() && !backup.exists() {
        std::fs::write(&backup, &existing)
            .map_err(|e| format!("cannot write {}: {e}", backup.display()))?;
    }

    // Через временный файл и переименование, как save_json: читатель никогда
    // не видит половину файла.
    let text = format!("{}{}", config_file::HEADER, config_file::render(&doc)?);
    let tmp = path.with_extension("yaml.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("cannot rename onto {}: {e}", path.display()))?;

    apply_config(&app);
    Ok(())
}

/// Что делает свежий конфиг действующим прямо сейчас.
///
/// Перезапуск ради настройки — плохая цена, а хоткеи и хост опроса меняются
/// без него. Хоткеи снимаются все разом: следить, какой именно из них поменял
/// человек, значило бы держать вторую копию списка рядом с конфигом.
fn apply_config(app: &tauri::AppHandle) {
    let config = load_config().unwrap_or(serde_json::Value::Null);

    if let Some(poller) = app.try_state::<poller::Poller>() {
        let ssh_host = config
            .get("sshHost")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let background = config
            .get("backgroundRefresh")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        poller.set_config(ssh_host, background);
    }

    let _ = app.global_shortcut().unregister_all();
    let (picker_shortcut, _) = picker_hotkey(&config);
    if let Err(e) = app.global_shortcut().on_shortcut(picker_shortcut, |app, _sc, event| {
        if event.state() == ShortcutState::Pressed {
            toggle_picker(app);
        }
    }) {
        eprintln!("ccfzf-picker: cannot re-register picker hotkey: {e}");
    }
    register_project_hotkeys(app, &config);

    let _ = app.emit("config-changed", ());
}

/// Открыть окно настроек.
///
/// Создаётся лениво: второй webview на старте стоил бы памяти каждому, кто в
/// настройки не заходит. `hideOnBlur` к нему не привязан намеренно — в
/// настройках переключаются между окнами, и гаснущая форма теряла бы
/// незаписанное.
#[tauri::command]
fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "settings",
        tauri::WebviewUrl::App("settings.html".into()),
    )
    .title("Настройки ccfzf-picker")
    .inner_size(820.0, 600.0)
    .center()
    .resizable(true)
    .build()
    .map_err(|e| format!("cannot open settings window: {e}"))?;
    Ok(())
}
```

- [ ] **Step 2: Вынести регистрацию проектных хоткеев в функцию**

Вырезать из `setup` цикл по `projects` (строки ~585-611) и оформить функцией рядом с `apply_config`:

```rust
/// Проектный хоткей открывает новую сессию мимо списка, поэтому окно пикера не
/// поднимается: наружу уходит только событие.
fn register_project_hotkeys(app: &tauri::AppHandle, config: &serde_json::Value) {
    let projects = config
        .get("projects")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();
    for item in projects {
        let (Some(path), Some(hotkey)) = (
            item.get("path").and_then(|v| v.as_str()),
            item.get("hotkey").and_then(|v| v.as_str()),
        ) else { continue };
        if hotkey.is_empty() { continue }
        let Ok(sc) = hotkey.parse::<Shortcut>() else {
            eprintln!("ccfzf-picker: cannot parse hotkey {hotkey}");
            continue;
        };
        let handle = app.clone();
        let path = path.to_string();
        if let Err(e) = app.global_shortcut().on_shortcut(sc, move |_app, _sc, event| {
            if event.state() == ShortcutState::Pressed {
                let _ = handle.emit("project-hotkey", path.clone());
            }
        }) {
            eprintln!("ccfzf-picker: cannot register hotkey {hotkey}: {e}");
        }
    }
}
```

В `setup` вместо вырезанного цикла поставить:

```rust
            register_project_hotkeys(app.handle(), &config);
```

- [ ] **Step 3: Зарегистрировать команды и окно**

В `invoke_handler` добавить `save_config, open_settings`.

В `src-tauri/capabilities/default.json` дописать окно — без этого страница настроек не сможет позвать ни одной команды:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "picker and settings windows",
  "windows": ["picker", "settings"],
  "permissions": ["core:default", "shell:allow-execute"]
}
```

- [ ] **Step 4: Проверить**

Run: `cd src-tauri && cargo test && cargo build`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src-tauri/src/main.rs src-tauri/capabilities/default.json
git commit -m "feat(settings): команды save_config и open_settings

Сохранение перерегистрирует хоткеи и обновляет хост опроса: перезапуск
ради настройки — плохая цена."
```

---

### Task C5: Форма настроек — чистая часть

**Files:**
- Create: `frontend-src/settings-form.js`
- Create: `test/settings-form.test.js`
- Modify: `scripts/prepare-frontend.js`

**Interfaces:**
- Consumes: ничего.
- Produces:
  - `SettingsForm.PAGES` — описание страниц и полей
  - `SettingsForm.configToFields(config) -> {[fieldId]: value}`
  - `SettingsForm.fieldsToPatch(fields, original) -> object` — только изменённое; пустой пароль не уезжает

- [ ] **Step 1: Написать падающий тест**

Создать `test/settings-form.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { PAGES, configToFields, fieldsToPatch } = require('../frontend-src/settings-form');

test('страницы перечисляют поля без повторов', () => {
  // Одно поле на двух страницах означало бы два источника правды для одного
  // ключа: сохранив одну страницу, человек молча откатил бы вторую.
  const ids = PAGES.flatMap(p => p.fields.map(f => f.id));
  assert.deepStrictEqual([...new Set(ids)], ids);
  assert.deepStrictEqual(PAGES.map(p => p.id), ['general', 'ui', 'hotkeys', 'integrations']);
});

test('конфиг раскладывается по полям формы', () => {
  const fields = configToFields({
    sshHost: 'host',
    terminal: { file: '/usr/bin/wt', args: ['-w', '0'] },
    onlyLive: false,
    mqtt: { host: 'broker', port: 1883, base: 'home/room/pc', password: 'secret' },
  });
  assert.strictEqual(fields.sshHost, 'host');
  assert.strictEqual(fields['terminal.file'], '/usr/bin/wt');
  // Аргументы редактируются строкой по одному на строку: массив в поле ввода
  // не положить, а запятая встречается в самих аргументах.
  assert.strictEqual(fields['terminal.args'], '-w\n0');
  assert.strictEqual(fields.onlyLive, false);
  assert.strictEqual(fields['mqtt.port'], 1883);
  // Пароль в форму не кладётся вовсе: он ездил бы через мост в webview на
  // каждое открытие настроек, а показывать его незачем.
  assert.strictEqual(fields['mqtt.password'], '');
});

test('в патч уходит только изменённое', () => {
  const original = { sshHost: 'host', onlyLive: true };
  const fields = configToFields(original);
  assert.deepStrictEqual(fieldsToPatch(fields, original), {});
  assert.deepStrictEqual(
    fieldsToPatch({ ...fields, sshHost: 'other' }, original),
    { sshHost: 'other' },
  );
});

test('пустой пароль не уезжает в патч', () => {
  // Иначе первое же сохранение стёрло бы настроенный пароль брокера — а
  // заметить это можно только по молчащему Enter на чужой машине.
  const original = { mqtt: { host: 'broker', base: 'home/room/pc' } };
  const fields = configToFields(original);
  assert.deepStrictEqual(fieldsToPatch(fields, original), {});
  const patch = fieldsToPatch({ ...fields, 'mqtt.password': 'новый' }, original);
  assert.deepStrictEqual(patch, { mqtt: { password: 'новый' } });
});

test('строка аргументов возвращается массивом', () => {
  const original = { terminal: { file: '/usr/bin/wt', args: [] } };
  const patch = fieldsToPatch({ ...configToFields(original), 'terminal.args': '-w\n0' }, original);
  assert.deepStrictEqual(patch, { terminal: { args: ['-w', '0'] } });
});

test('проекты редактируются списком', () => {
  const original = { projects: [{ path: '/a', hotkey: 'Cmd+Shift+1' }] };
  const fields = configToFields(original);
  assert.deepStrictEqual(fields.projects, [{ path: '/a', hotkey: 'Cmd+Shift+1' }]);
  const patch = fieldsToPatch({ ...fields, projects: [{ path: '/b', hotkey: '' }] }, original);
  assert.deepStrictEqual(patch, { projects: [{ path: '/b', hotkey: '' }] });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npm test`
Expected: FAIL — модуля нет.

- [ ] **Step 3: Реализовать**

Создать `frontend-src/settings-form.js`:

```js
// Loaded twice: as a <script> in settings.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SettingsForm = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Страницы настроек и поля на них.
   *
   * Одна таблица на всё: по ней страница рисуется, по ней же собирается патч.
   * Поле, попавшее на две страницы, означало бы два источника правды для
   * одного ключа — сохранив одну страницу, человек молча откатил бы вторую;
   * это сторожит тест.
   *
   * `id` поля — это путь в конфиге через точку. Разбор пути тут же, ниже:
   * заводить ради двух уровней вложенности схему было бы дороже.
   *
   * Страница `ui` полей не имеет: она правит ui.json, а не config.yaml, и
   * рисуется своим кодом в settings.html — таблицей галок по двум осям.
   */
  const PAGES = [
    {
      id: 'general',
      title: 'General',
      fields: [
        { id: 'sshHost', label: 'Хост с сессиями', type: 'text',
          hint: 'Любая форма, понятная ssh. Без него список брать неоткуда.' },
        { id: 'terminal.file', label: 'Терминал', type: 'text' },
        { id: 'terminal.args', label: 'Аргументы терминала', type: 'lines',
          hint: 'По одному на строку — запятая встречается в самих аргументах.' },
        { id: 'onlyLive', label: 'Только работающие сессии', type: 'bool' },
        { id: 'hideOnBlur', label: 'Гасить окно при потере фокуса', type: 'bool' },
        { id: 'backgroundRefresh', label: 'Опрашивать при закрытом окне', type: 'bool',
          hint: 'Держит свежим дамп агрегатора: с него живёт панель openHASP.' },
        { id: 'caps.reptyr', label: 'Разрешить перенос процесса (reptyr)', type: 'bool' },
        { id: 'caps.takeover', label: 'Разрешить перехват сессии', type: 'bool' },
      ],
    },
    { id: 'ui', title: 'UI', fields: [] },
    {
      id: 'hotkeys',
      title: 'Hotkeys',
      fields: [
        { id: 'hotkey', label: 'Показать пикер', type: 'text',
          hint: 'SUPER — это Cmd на маке и Win на Windows.' },
        { id: 'projects', label: 'Проектные хоткеи', type: 'projects' },
      ],
    },
    {
      id: 'integrations',
      title: 'Integrations',
      fields: [
        { id: 'windowHost', label: 'Имя этой машины', type: 'text',
          hint: 'Совпало с windowHost из ответа — Enter поднимает окно.' },
        { id: 'mqtt.host', label: 'Брокер MQTT', type: 'text' },
        { id: 'mqtt.port', label: 'Порт брокера', type: 'number' },
        { id: 'mqtt.user', label: 'Пользователь', type: 'text' },
        { id: 'mqtt.password', label: 'Пароль', type: 'password',
          hint: 'Пусто — оставить прежний.' },
        { id: 'mqtt.base', label: 'Префикс топиков', type: 'text' },
        { id: 'pathMap.remote', label: 'Каталог на удалённом хосте', type: 'text' },
        { id: 'pathMap.local', label: 'Он же здесь', type: 'text' },
      ],
    },
  ];

  const FIELDS = PAGES.flatMap(page => page.fields);

  function at(source, path) {
    return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), source);
  }

  function put(target, path, value) {
    const keys = path.split('.');
    let node = target;
    for (const key of keys.slice(0, -1)) {
      if (!node[key] || typeof node[key] !== 'object') node[key] = {};
      node = node[key];
    }
    node[keys[keys.length - 1]] = value;
  }

  function emptyFor(type) {
    if (type === 'bool') return false;
    if (type === 'number') return '';
    if (type === 'projects') return [];
    return '';
  }

  /** Значение конфига в том виде, в каком его держит поле формы. */
  function toField(field, value) {
    // Пароль в форму не кладётся вовсе: он ездил бы через мост в webview на
    // каждое открытие настроек, а показывать его незачем. Пустое поле значит
    // «оставить прежний» — так и написано в подсказке.
    if (field.type === 'password') return '';
    if (value === undefined || value === null) return emptyFor(field.type);
    if (field.type === 'bool') return Boolean(value);
    if (field.type === 'lines') return (Array.isArray(value) ? value : []).join('\n');
    if (field.type === 'projects') {
      return (Array.isArray(value) ? value : [])
        .filter(p => p && typeof p === 'object')
        .map(p => ({ path: String(p.path || ''), hotkey: String(p.hotkey || '') }));
    }
    return value;
  }

  /** Значение поля формы в том виде, в каком оно ложится в конфиг. */
  function fromField(field, value) {
    if (field.type === 'lines') {
      return String(value == null ? '' : value)
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);
    }
    if (field.type === 'number') {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    if (field.type === 'bool') return Boolean(value);
    if (field.type === 'projects') {
      return (Array.isArray(value) ? value : [])
        .filter(p => p && String(p.path || '').trim())
        .map(p => ({ path: String(p.path).trim(), hotkey: String(p.hotkey || '').trim() }));
    }
    return String(value == null ? '' : value);
  }

  function configToFields(config) {
    const src = config && typeof config === 'object' ? config : {};
    const fields = {};
    for (const field of FIELDS) fields[field.id] = toField(field, at(src, field.id));
    return fields;
  }

  /**
   * Патч: только то, что человек и правда поменял.
   *
   * Не весь конфиг, потому что окно знает не про все ключи, и не «всё, что
   * есть в форме», потому что пустой пароль значит «оставить прежний», а не
   * «стереть». Стёртый пароль брокера заметить можно только по молчащему
   * Enter на чужой машине.
   */
  function fieldsToPatch(fields, original) {
    const before = configToFields(original);
    const patch = {};
    for (const field of FIELDS) {
      const value = fields[field.id];
      if (field.type === 'password') {
        if (String(value || '')) put(patch, field.id, String(value));
        continue;
      }
      if (JSON.stringify(value) === JSON.stringify(before[field.id])) continue;
      const converted = fromField(field, value);
      if (converted === undefined) continue;
      put(patch, field.id, converted);
    }
    return patch;
  }

  return { PAGES, configToFields, fieldsToPatch };
});
```

В `scripts/prepare-frontend.js` добавить `'frontend-src/settings-form.js',`.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add frontend-src/settings-form.js test/settings-form.test.js scripts/prepare-frontend.js
git commit -m "feat(settings): описание страниц и сбор патча из формы"
```

- [ ] **Step 6: Написать падающий тест проверки формы**

Добавить в `test/settings-form.test.js`:

```js
const { validate } = require('../frontend-src/settings-form');

test('пустой хост — отказ, а не пустой список', () => {
  // Без sshHost список брать неоткуда, и сохранить такое молча значит отдать
  // человеку пикер, который не работает и не говорит почему.
  const problems = validate({ ...configToFields({}), sshHost: '  ' });
  assert.ok(problems.some(p => p.includes('sshHost')), problems.join('; '));
});

test('комбинация, занятая самим окном пикера, не проходит', () => {
  // Ctrl+K — меню сессии внутри окна. Настроенный на неё глобальный хоткей
  // молча не сработал бы: окно забирает нажатие себе.
  const problems = validate({ ...configToFields({ sshHost: 'h' }), hotkey: 'Ctrl+K' });
  assert.ok(problems.some(p => p.includes('Ctrl+K')), problems.join('; '));
});

test('точка с запятой в пути проекта не проходит', () => {
  // Windows Terminal режет свою командную строку по `;` до всякого шелла:
  // сессия в таком каталоге развалилась бы на панели вместо запуска.
  const fields = { ...configToFields({ sshHost: 'h' }), projects: [{ path: '/a;b', hotkey: '' }] };
  assert.ok(validate(fields).some(p => p.includes('/a;b')));
});

test('исправная форма претензий не вызывает', () => {
  assert.deepStrictEqual(validate(configToFields({ sshHost: 'host' })), []);
});
```

- [ ] **Step 7: Убедиться, что тест падает**

Run: `npm test`
Expected: FAIL — `validate is not a function`.

- [ ] **Step 8: Реализовать**

В `frontend-src/settings-form.js` взять соседний модуль тем же приёмом, что `open-strategy.js` берёт `session-name` (сразу после шима):

```js
  const hotkeyApi = typeof module === 'object' && module.exports
    ? require('./action-hotkey')
    : globalThis.ActionHotkey;
```

Добавить перед `return`:

```js
  /**
   * Что не даст сохранить.
   *
   * Проверки те же, что уже стоят на пути конфига, и переписывать их здесь
   * нельзя: разойдясь, форма разрешила бы то, что пикер потом молча выбросит.
   * Отсюда и список — три случая, каждый из которых иначе виден только
   * пальцами: неработающий список, неотзывающаяся клавиша, команда,
   * развалившаяся на панели Windows Terminal.
   */
  function validate(fields) {
    const problems = [];
    if (!String(fields.sshHost || '').trim()) {
      problems.push('sshHost не задан: список брать неоткуда');
    }
    const hotkey = String(fields.hotkey || '').trim();
    // isReserved, а не свой разбор строки: комбинации, которые окно пикера
    // забирает себе, перечислены там, и второй список разошёлся бы с первым.
    if (hotkey && hotkeyApi.isReserved(hotkeyApi.parseHotkey(hotkey))) {
      problems.push(`${hotkey} занята самим окном пикера — внутри него она не отзовётся`);
    }
    for (const project of (Array.isArray(fields.projects) ? fields.projects : [])) {
      const path = String((project || {}).path || '');
      if (path.includes(';')) {
        problems.push(`в пути ${path} есть «;» — Windows Terminal порежет команду на панели`);
      }
    }
    return problems;
  }
```

Дописать `validate` в возвращаемый объект: `return { PAGES, configToFields, fieldsToPatch, validate };`

`parseHotkey` и `isReserved` уже экспортируются из `frontend-src/action-hotkey.js` (строка 156) — проверять нечего.

- [ ] **Step 9: Убедиться, что тесты проходят**

Run: `npm test`
Expected: PASS.

- [ ] **Step 10: Коммит**

```bash
git add frontend-src/settings-form.js test/settings-form.test.js
git commit -m "feat(settings): проверка формы теми же правилами, что и конфига"
```

---

### Task C6: Страница `settings.html`

**Files:**
- Create: `settings.html`
- Modify: `scripts/prepare-frontend.js` (копировать `settings.html` в `frontend/`)
- Test: `test/frontend-load.test.js` (добавить проверку разметки)

**Interfaces:**
- Consumes: `SettingsForm.PAGES/configToFields/fieldsToPatch` (Task C5), `UiState.normalizeUiState/uiStateToSave` (Task C1), команды `load_config`, `save_config`, `load_ui`, `save_ui`.
- Produces: событие `ui-changed`, рассылаемое страницей после записи `ui.json`.

- [ ] **Step 1: Написать падающий тест разметки**

Добавить в `test/frontend-load.test.js` (по образцу существующих проверок `sessions.html`):

```js
test('settings.html грузит те же модули, что и зовёт', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');
  // Модуль, забытый в разметке, даёт пустую страницу настроек и ошибку в
  // консоли, которую в отдельном окне никто не видит.
  for (const src of ['settings-form.js', 'ui-state.js', 'session-groups.js', 'action-hotkey.js']) {
    assert.ok(html.includes(`src="${src}"`), `нет тега ${src}`);
  }
  // Вкладки и контейнер страницы — по ним рисование находит своё место.
  assert.ok(html.includes('id="tabs"'));
  assert.ok(html.includes('id="page"'));
});

test('settings.html попадает в сборку', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'prepare-frontend.js'), 'utf8');
  // Страница, не попавшая в frontend/, откроется пустым окном в собранном
  // приложении, а npm test при этом останется зелёным.
  assert.ok(script.includes('settings.html'), 'settings.html не копируется');
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm test`
Expected: FAIL — `ENOENT: settings.html`.

- [ ] **Step 3: Создать страницу**

Создать `settings.html`. Разметка: две колонки, вкладки слева, форма справа; стили — в том же стиле, что `sessions.html` (тёмная тема, системный шрифт).

```html
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Настройки ccfzf-picker</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; display: flex; height: 100vh;
    font: 13px -apple-system, "Segoe UI", system-ui, sans-serif;
    background: #1c1c1e; color: #e6e6e6;
  }
  #tabs { width: 170px; flex: none; padding: 12px 0; background: #232326; border-right: 1px solid #333; }
  .tab { padding: 7px 16px; cursor: pointer; }
  .tab.active { background: #3a3a3e; }
  #page { flex: 1; overflow-y: auto; padding: 18px 22px; }
  .field { margin-bottom: 14px; }
  .field label { display: block; margin-bottom: 4px; }
  .field input[type=text], .field input[type=password], .field input[type=number], .field textarea {
    width: 100%; box-sizing: border-box; padding: 5px 7px;
    background: #2a2a2e; color: inherit; border: 1px solid #444; border-radius: 4px;
    font: inherit;
  }
  .hint { color: #999; margin-top: 3px; }
  #bar { position: sticky; bottom: 0; padding: 12px 0 0; background: #1c1c1e; }
  #status { color: #999; margin-left: 10px; }
  #status.bad { color: #ff7b72; }
  table.axes { border-collapse: collapse; }
  table.axes th, table.axes td { padding: 3px 12px 3px 0; text-align: left; font-weight: normal; }
</style>
</head>
<body>
<div id="tabs"></div>
<div id="page"></div>
<script src="session-groups.js"></script>
<script src="ui-state.js"></script>
<!-- action-hotkey до settings-form: тот берёт из него список занятых окном
     комбинаций в момент загрузки. -->
<script src="action-hotkey.js"></script>
<script src="settings-form.js"></script>
<script>
(async function () {
  const { PAGES, configToFields, fieldsToPatch, validate } = window.SettingsForm;
  const invoke = (cmd, args) => (window.__TAURI__
    ? window.__TAURI__.core.invoke(cmd, args)
    : Promise.resolve());

  // Набор ключей галок и их умолчания повторяют sessions.html. Второй список
  // здесь неизбежен — страницы это разные окна, общего состояния у них нет, —
  // но расходиться ему не дают нормализация в ui-state.js (незнакомый ключ
  // выбрасывается) и подписи, взятые отсюда же.
  const TOGGLE_LABELS = {
    showPrompt: 'prompt', showAnswer: 'answer', showPaths: 'paths',
    showHotkey: 'hotkeys', showEvent: 'events', showId: 'id',
    showCost: 'cost', showContext: 'context', showWindow: 'window',
  };
  const FILTER_LABELS = { onlyWindow: 'только сессии с окном' };
  const UI_DEFAULTS = {
    sort: 'recent',
    toggles: {
      showPrompt: { list: true, statusline: true },
      showAnswer: { list: true, statusline: true },
      showPaths: { list: true, statusline: true },
      showHotkey: { list: true, statusline: false },
      showEvent: { list: false, statusline: false },
      showId: { list: false, statusline: true },
      showCost: { list: false, statusline: false },
      showContext: { list: true, statusline: true },
      showWindow: { list: true, statusline: false },
      onlyWindow: { list: false, statusline: false },
    },
  };

  let config = {};
  let fields = {};
  let ui = UI_DEFAULTS;
  let current = 'general';
  const tabs = document.getElementById('tabs');
  const page = document.getElementById('page');

  const esc = (s) => String(s).replace(/[&<>"]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function renderTabs() {
    tabs.innerHTML = PAGES.map(p =>
      `<div class="tab${p.id === current ? ' active' : ''}" data-page="${p.id}">${esc(p.title)}</div>`
    ).join('');
    for (const tab of tabs.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => { current = tab.dataset.page; renderTabs(); renderPage(); });
    }
  }

  function fieldHtml(field) {
    const value = fields[field.id];
    const hint = field.hint ? `<div class="hint">${esc(field.hint)}</div>` : '';
    if (field.type === 'bool') {
      return `<div class="field"><label><input type="checkbox" data-field="${field.id}"${
        value ? ' checked' : ''}> ${esc(field.label)}</label>${hint}</div>`;
    }
    if (field.type === 'lines') {
      return `<div class="field"><label>${esc(field.label)}</label>`
        + `<textarea rows="3" data-field="${field.id}">${esc(value)}</textarea>${hint}</div>`;
    }
    if (field.type === 'projects') {
      const rows = (value || []).concat([{ path: '', hotkey: '' }]).map((p, i) =>
        `<div class="field"><input type="text" data-project="${i}" data-part="path" `
        + `placeholder="/путь/на/удалённом/хосте" value="${esc(p.path)}">`
        + `<input type="text" data-project="${i}" data-part="hotkey" `
        + `placeholder="Cmd+Shift+1" value="${esc(p.hotkey)}"></div>`).join('');
      return `<div class="field"><label>${esc(field.label)}</label>${rows}${hint}</div>`;
    }
    const type = field.type === 'password' ? 'password' : (field.type === 'number' ? 'number' : 'text');
    return `<div class="field"><label>${esc(field.label)}</label>`
      + `<input type="${type}" data-field="${field.id}" value="${esc(value)}">${hint}</div>`;
  }

  function axesTableHtml() {
    const row = (key, label) => `<tr><td>${esc(label)}</td>`
      + `<td><input type="checkbox" data-axis="statusline" data-key="${key}"${
        ui.toggles[key].statusline ? ' checked' : ''}></td>`
      + `<td><input type="checkbox" data-axis="list" data-key="${key}"${
        ui.toggles[key].list ? ' checked' : ''}></td></tr>`;
    return '<table class="axes"><tr><th>Колонка</th><th>statusline</th><th>list</th></tr>'
      + Object.entries(TOGGLE_LABELS).map(([k, l]) => row(k, l)).join('')
      + '</table>'
      + '<div class="field"><label>Фильтры</label><table class="axes">'
      + '<tr><th></th><th>statusline</th><th>включён</th></tr>'
      + Object.entries(FILTER_LABELS).map(([k, l]) => row(k, l)).join('')
      + '</table><div class="hint">Фильтр решает, какие строки попадут в список, '
      + 'а не какие колонки видны.</div></div>';
  }

  function actionsListHtml() {
    const actions = Array.isArray(config.actions) ? config.actions : [];
    if (!actions.length) return '';
    // Только на чтение: редактор argv с плейсхолдерами — отдельная работа, а
    // форма, которая делает вид, что правит их, врала бы.
    return '<div class="field"><label>Действия открытия папки</label><ul>'
      + actions.map(a => `<li>${esc(a && a.id)} — <code>${esc(JSON.stringify(a && a.argv))}</code></li>`).join('')
      + '</ul><div class="hint">Правятся в config.yaml — окно их только показывает.</div></div>';
  }

  function renderPage() {
    const def = PAGES.find(p => p.id === current);
    const body = current === 'ui'
      ? axesTableHtml()
      : def.fields.map(fieldHtml).join('') + (current === 'integrations' ? actionsListHtml() : '');
    page.innerHTML = body
      + '<div id="bar"><button id="save">Сохранить</button><span id="status"></span></div>';

    for (const input of page.querySelectorAll('[data-field]')) {
      input.addEventListener('input', () => {
        fields[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value;
      });
      if (input.type === 'checkbox') {
        input.addEventListener('change', () => { fields[input.dataset.field] = input.checked; });
      }
    }
    for (const input of page.querySelectorAll('[data-project]')) {
      input.addEventListener('input', () => {
        const rows = (fields.projects || []).slice();
        const i = Number(input.dataset.project);
        while (rows.length <= i) rows.push({ path: '', hotkey: '' });
        rows[i] = { ...rows[i], [input.dataset.part]: input.value };
        fields.projects = rows;
      });
    }
    for (const input of page.querySelectorAll('[data-axis]')) {
      input.addEventListener('change', () => {
        const key = input.dataset.key;
        ui.toggles[key] = { ...ui.toggles[key], [input.dataset.axis]: input.checked };
      });
    }
    document.getElementById('save').addEventListener('click', save);
  }

  async function save() {
    const status = document.getElementById('status');
    status.className = '';
    status.textContent = 'сохраняю…';
    try {
      if (current === 'ui') {
        await invoke('save_ui', { ui: window.UiState.uiStateToSave(ui.sort, ui.toggles) });
        // Пикер — другое окно, своего ui.json он не перечитает. Событие
        // рассылается всем окнам, и подписан на него только он.
        if (window.__TAURI__) await window.__TAURI__.event.emit('ui-changed');
      } else {
        // Проверка до записи: сохранённый пустой sshHost оставил бы человека
        // с пикером, который не работает и не говорит почему.
        const problems = validate(fields);
        if (problems.length) {
          status.className = 'bad';
          status.textContent = problems.join('; ');
          return;
        }
        const patch = fieldsToPatch(fields, config);
        await invoke('save_config', { patch });
        config = await invoke('load_config') || {};
        fields = configToFields(config);
      }
      status.textContent = 'сохранено';
    } catch (e) {
      status.className = 'bad';
      status.textContent = String(e);
    }
  }

  try {
    config = await invoke('load_config') || {};
  } catch (e) {
    config = {};
  }
  fields = configToFields(config);
  try {
    ui = window.UiState.normalizeUiState(await invoke('load_ui'), UI_DEFAULTS);
  } catch (e) {
    ui = window.UiState.normalizeUiState({}, UI_DEFAULTS);
  }
  renderTabs();
  renderPage();
})();
</script>
</body>
</html>
```

В `scripts/prepare-frontend.js` после копирования `sessions.html` добавить:

```js
fs.copyFileSync(path.join(ROOT, 'settings.html'), path.join(OUT, 'settings.html'));
```

и поправить строку отчёта на `console.log(\`prepared ${FILES.length + 2} files\`);`.

- [ ] **Step 4: Проверить**

Run: `npm test`
Expected: PASS.

Run: `node scripts/prepare-frontend.js && ls frontend/settings.html`
Expected: файл на месте.

- [ ] **Step 5: Коммит**

```bash
git add settings.html scripts/prepare-frontend.js test/frontend-load.test.js
git commit -m "feat(settings): страница настроек с вкладками"
```

---

### Task C7: Вход в настройки и подхват изменений в пикере

**Files:**
- Modify: `sessions.html` — разметка статуслайна (243-250), обработчик клавиш, подписки на события

**Interfaces:**
- Consumes: команда `open_settings` (Task C4), события `config-changed` (Task C4) и `ui-changed` (Task C6), `UiState.listColumns` (Task C1), `renderChecks` (Task C2).
- Produces: ничего наружу.

- [ ] **Step 1: Добавить шестерёнку**

В `sessions.html`, в блок `<div id="statusline">` после `<span class="status-checks" id="status-checks"></span>` добавить:

```html
  <!-- Справа и последним: это не часть ряда галок, а выход в другое окно. -->
  <span id="settings-button" title="Настройки (Ctrl+,)"><span class="icon">⚙</span></span>
```

В стили `#statusline` добавить:

```css
#settings-button { margin-left: auto; cursor: pointer; padding: 0 2px; }
```

- [ ] **Step 2: Повесить обработчики**

Рядом с прочими элементами (после `const statusChecks = ...`, строка ~415) добавить:

```js
  const settingsButton = document.getElementById('settings-button');
```

После `renderChecks();` добавить:

```js
  // Клик по шестерёнке не должен всплывать до statusline: там висит смена
  // сортировки, и открытие настроек заодно крутило бы её.
  settingsButton.addEventListener('click', (e) => {
    e.stopPropagation();
    invoke('open_settings').catch((err) => { error = String(err); render(); });
  });
```

В обработчик нажатий клавиш (там же, где разбираются `^K` и прочие) добавить ветку перед разбором действий:

```js
    // `,` вместе с Ctrl или Cmd — общесистемная привычка открывать настройки.
    // Сверяется e.code: в русской раскладке на этой клавише «б», и e.key
    // пришёл бы им.
    if ((e.ctrlKey || e.metaKey) && e.code === 'Comma') {
      e.preventDefault();
      invoke('open_settings').catch((err) => { error = String(err); render(); });
      return;
    }
```

- [ ] **Step 3: Подписаться на изменения**

В блок подписок (рядом с `await listen('state', ...)`) добавить:

```js
    // Настройки правит другое окно, и своего ui.json пикер сам не перечитает.
    await listen('ui-changed', async () => {
      const saved = window.UiState.normalizeUiState(await invoke('load_ui'), {
        sort: sortMode, toggles,
      });
      sortMode = saved.sort;
      toggles = saved.toggles;
      columns = window.UiState.listColumns(toggles);
      // Набор вынесенных галок мог измениться — разметку строки надо собрать
      // заново, а не просто проставить отметки.
      renderChecks();
      regroup();
    });

    // Хоткеи и хост опроса Rust уже переставил сам; здесь остаётся то, что
    // читает страница, — терминал, пути, действия, caps.
    await listen('config-changed', async () => {
      try {
        CONFIG = window.ConfigShape.normalizeConfig(await invoke('load_config'));
      } catch (e) {
        error = String(e);
      }
      regroup();
    });
```

- [ ] **Step 4: Проверить**

Run: `npm test && (cd src-tauri && cargo test)`
Expected: PASS.

Ручная проверка (собранное приложение):
1. Открыть пикер, нажать `Ctrl+,` — открывается окно настроек.
2. На вкладке UI снять галку `statusline` у `context` и сохранить — галка исчезает из статуслайна пикера без перезапуска, колонка остаётся.
3. На вкладке General поменять `sshHost` на заведомо неверный и сохранить — в статуслайне пикера появляется ошибка ssh на следующем такте; вернуть обратно.
4. Проверить, что рядом с `config.yaml` появился `config.yaml.bak` с прежним содержимым и комментариями, а в новом файле стоит шапка.
5. На вкладке Hotkeys поменять глобальный хоткей и сохранить — новая комбинация поднимает пикер без перезапуска.

- [ ] **Step 5: Коммит**

```bash
git add sessions.html
git commit -m "feat(picker): шестерёнка и Ctrl+, открывают настройки

Изменения подхватываются событиями: ui.json перечитывается по ui-changed,
config.yaml — по config-changed, который шлёт Rust после перерегистрации
хоткеев."
```

---

### Task C8: Документация

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `config.example.yml`

- [ ] **Step 1: Дописать README**

В `README.md` добавить раздел (место — после описания хоткеев пикера):

```markdown
## Настройки

Окно настроек открывается шестерёнкой справа в статуслайне или `Ctrl+,`
(`Cmd+,` на маке). Слева вкладки, справа страница:

- **General** — хост с сессиями, терминал, показывать ли только работающие
  сессии, гасить ли окно при потере фокуса, опрашивать ли при закрытом окне.
- **UI** — по каждой колонке две галки: `list` — рисовать ли колонку в строке,
  `statusline` — выносить ли её галку в строку внизу. Место в статуслайне
  ограничено, и что туда попадёт, решаете вы.
- **Hotkeys** — глобальный хоткей пикера и проектные хоткеи.
- **Integrations** — имя этой машины, брокер MQTT, соответствие каталогов.
  Действия открытия папки показываются, но правятся только в `config.yaml`.

Сохранение вкладки UI пишет `~/.config/ccfzf-picker/ui.json`, остальных —
`~/.config/ccfzf-picker/config.yaml`. Изменения применяются сразу, включая
хоткеи: перезапуск не нужен.

**`config.yaml` после первого сохранения из окна теряет комментарии.** Файл
переписывается целиком, и сохранить пометки при этом нечем. Прежний файл
остаётся рядом как `config.yaml.bak`, а описание всех ключей всегда лежит в
`config.example.yml`.

## Фоновое обновление

Пикер опрашивает агрегатор и при закрытом окне: раз в минуту, а при тишине
реже — 2, 4, 8 минут, — и снова раз в минуту, как только что-то изменилось.
Так список готов к следующему открытию, а `ccfzf --state` держит свежим свой
дамп, с которого живут экспорт в Home Assistant и панель openHASP. Выключается
ключом `backgroundRefresh: false`.
```

- [ ] **Step 2: Дописать CLAUDE.md**

Добавить в раздел «Правила, за которые уже заплачено» три записи:

```markdown
- **Опрос живёт в Rust, а не на странице.** У скрытого окна webview тормозит
  таймеры, а WebView2 у свёрнутого умеет усыплять страницу целиком: фон на
  `setInterval` замолчал бы, и узнать об этом было бы неоткуда. Такт считает
  `next_delay` в `src-tauri/src/poller.rs` — секунда на показанном окне,
  1→2→4→8 минут на скрытом. Фон нужен не только ради тёплого списка:
  `ccfzf --state` переписывает свой дамп, а с того дампа живут экспорт в Home
  Assistant и панель openHASP — закрытый пикер, переставший спрашивать,
  останавливает и панель.

- **Отпечаток состояния считается без времени.** `generated` наверху ответа и
  `age` у каждой сессии считаются от «сейчас» и отличаются на каждом опросе:
  сравнивая ответ целиком, бэкофф не включился бы никогда, а выглядело бы это
  как работающая функция. `fingerprint` в `poller.rs` их выбрасывает.

- **Галка в списке имеет две оси, и старую форму `ui.json` надо понимать.**
  `list` — показывать ли колонку (это и значила плоская галка), `statusline` —
  выносить ли галку в строку внизу. `normalizeUiState` поднимает булево
  значение в `list`: не поняв старый файл, первый же запуск после обновления
  сбросил бы человеку все колонки, и выглядело бы это потерей настроек.

- **`config.yaml` после первого сохранения из окна настроек ведёт окно.**
  Перезапись через `serde_yaml` теряет комментарии — а они и есть
  документация. Смягчение одно и разовое: `config.yaml.bak` перед первой
  перезаписью и шапка-предупреждение в новом файле. Патч сливается по ключам
  (`config_file::merge_patch`), иначе окно стирало бы `actions`, про которые не
  знает, и `mqtt.password`, который не показывает.
```

- [ ] **Step 3: Проверить**

Run: `npm test`
Expected: PASS — в том числе `test/no-private-data.test.js` (в примерах не должно появиться настоящих имён машин).

- [ ] **Step 4: Коммит**

```bash
git add README.md CLAUDE.md config.example.yml
git commit -m "docs: фоновый опрос, суффиксы имён и окно настроек"
```

---

## Порядок и независимость

Части A, B и C не зависят друг от друга и мержатся по отдельности. Внутри частей порядок обязателен: A1→A2→A4→A5, B1→B2→B3, C1→C2 и C3→C4→C5→C6→C7. A3 можно делать в любой момент до A4. B4 — другой репозиторий, к PR этого проекта отношения не имеет.

Отметить в `docs/TODO.md` выполненными все три задачи раздела `# next` — коммитом вместе с последней правкой соответствующей части.
