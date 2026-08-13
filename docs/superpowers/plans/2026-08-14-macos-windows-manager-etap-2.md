# Этап 2 macos-windows-manager: «Enter поднимает окно» — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enter в пикере на маке поднимает уже открытое окно сессии вместо того, чтобы открывать второй терминал.

**Architecture:** Просьбу о подъёме исполняет трей на маке — только он живёт в графической сессии и владеет реестром окон `AXUIElement`. Адрес просьбы называет сам трекер: в файле окон появляется `mqttBase`, агрегатор проносит его в ответ, пикер публикует по адресу машины той строки, на которой стоит человек. windows11-manager не меняется вовсе.

**Tech Stack:** Rust (Tauri 2, rumqttc, accessibility/objc2-app-kit), Python 3 (агрегатор `ccfzf`), ванильный JS без сборщика (фронтенд пикера).

**Spec:** `docs/superpowers/specs/2026-08-14-macos-windows-manager-etap-2-design.md` (в репозитории `ccfzf-picker`)

## Global Constraints

- **Три репозитория, коммиты в каждый свои.** Пикер `~/projects/js/ccfzf-picker` (ветка `windows-mqtt-migrate`), агрегатор `~/projects/shell/ccfzf` (ветка `main`), трекер `~/projects/js/macos-windows-manager` (ветка `master`). Ни одна задача не трогает больше одного репозитория, кроме последней.
- **Язык.** Всё, что видит человек, — по-английски. Комментарии, doc-комментарии, названия тестов и сообщения в `assert` — по-русски.
- **Имён машин в репозиториях нет.** В примерах и тестах — только `remote-host`, `mac-host`, `windows-box`. Сторож: `test/no-private-data.test.js` в пикере.
- **Тесты запускаются так и только так:** пикер — `npm test` (`node --test` на этих версиях Node не работает) и `cd src-tauri && cargo test`; агрегатор — `python3 tests/test_<имя>.py` по одному файлу; трекер — `cargo test -p mwm-core` и `cargo test -p macos-windows-manager`.
- **Предсуществующих падений нет.** На момент написания плана: пикер 406 + 86, `mwm-core` 32, `macos-windows-manager` 7, агрегатор `test_windows_file.py` 20/20 и `test_windows_merge.py` весь. Любое падение — своё.
- **Код под `#[cfg(target_os = "macos")]` на этой машине не компилируется вовсе.** `cargo test -p macos-windows-manager` собирает не-macOS ветку. Ошибки в macOS-ветке всплывут только на выкатке (задача 13) — так уже было на первом этапе с `CFType::from`. Поэтому в macOS-ветку не кладётся ничего, кроме вызовов платформы.
- **`;` в удалённой команде не ставить** — правило связки, одно на все репозитории.
- **Коммиты — conventional commits по-русски**, с подписью `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **`focus: true` — обещание.** Молчащий Enter хуже открытого терминала. Признак умения поднимать объявляется по живому соединению с брокером, а не по факту сборки.

---

## Структура файлов

**Агрегатор `ccfzf`:**
- Modify: `ccfzf` — `read_windows` (~436-537), `read_window_sources` (~562-600)
- Test: `tests/test_windows_file.py`, `tests/test_windows_merge.py`

**Трекер `macos-windows-manager`:**
- Modify: `crates/mwm-core/src/config.rs` — блок `mqtt:`
- Modify: `crates/mwm-core/src/publish.rs` — `mqttBase`, `openSession`
- Modify: `crates/mwm-core/src/tracker.rs` — `mark_unread`
- Create: `crates/mwm-core/src/request.rs` — имя команды из топика, разбор тела
- Create: `src-tauri/src/mqtt.rs` — подписка, канал просьб, признак живого соединения
- Modify: `src-tauri/src/ax.rs` — `raise`, владелец окна в реестре
- Modify: `src-tauri/src/main.rs` — `recv_timeout`, исполнение просьб, отказы в трей

**Пикер `ccfzf-picker`:**
- Modify: `frontend-src/session-windows.js` — `mqttBaseFor`, `openManager`
- Modify: `frontend-src/open-transport.js` — четыре функции принимают ответ `openManager`
- Modify: `src-tauri/src/mqtt.rs` — база публикации с просеиванием
- Modify: `src-tauri/src/main.rs` — команды принимают базу
- Modify: `sessions.html` — база едет в команды, имя в пункте меню
- Test: `test/session-windows.test.js`, `test/open-transport.test.js`

---

### Task 1: Агрегатор проносит `mqttBase` и `openSession`

**Repo:** `~/projects/shell/ccfzf`, ветка `main`

**Files:**
- Modify: `ccfzf` — `read_windows`, `read_window_sources`
- Test: `tests/test_windows_file.py`, `tests/test_windows_merge.py`

**Interfaces:**
- Produces: `read_windows(path, now)` возвращает восемь значений — `(windows, host, pid, snapshots, projects, focus, open_session, mqtt_base)`. `read_window_sources` кладёт `mqttBase` и в записи `windowHosts`, и в каждую запись окна; `openSession` — только в `windowHosts`.

**Контекст:** трекеров теперь несколько. `focus` (умеет ли трекер поднимать окно) уже проносится с первого этапа — новые поля повторяют его форму один в один, включая недоверие к файлу: мусор читается как отсутствие, а не заводит третью ветку поведения.

- [ ] **Step 1: Написать падающие тесты в `tests/test_windows_file.py`**

Сначала — новый помощник рядом с `_read` и `_read_projects`. Трогать `_read` нельзя: она отдаёт первые четыре значения, и на этой распаковке стоят все прежние тесты. Ровно по этой же причине в файле уже живёт отдельный `_read_projects` — повторяем его форму:

```python
def _read_caps(obj, now=NOW):
    """Седьмое и восьмое значения read_windows: берётся ли менеджер этой машины
    открывать сессии и по какому адресу его просить. Отдельным помощником, как
    и _read_projects: прежние тесты распаковывают четыре значения, и
    переписывать их ради новых полей незачем."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "windows.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(obj, fh)
        out = CC["read_windows"](path, now)
        return out[6], out[7]
```

Дописать в конец файла, перед блоком запуска:

```python
def test_mqtt_base_reaches_the_reader():
    # Адрес, по которому у этой машины просят поднять окно. Знать его отсюда
    # неоткуда: топик живёт в конфиге трекера, а публикует читатель.
    _, base = _read_caps(_payload({UUID_A: _win("ccfzf")}) | {"mqttBase": "home/room/mac/windows"})
    assert base == "home/room/mac/windows", base


def test_mqtt_base_missing_is_empty_not_absent():
    # Windows-трекер поля не пишет и не должен: пустая строка значит «спроси
    # свой конфиг», и читатель ведёт себя как до появления поля.
    _, base = _read_caps(_payload({UUID_A: _win("ccfzf")}))
    assert base == "", base


def test_junk_mqtt_base_reads_as_missing():
    # Недоверие к файлу то же, что у остальных полей: мусор стоит поля, а не
    # списка окон.
    _, base = _read_caps(_payload({UUID_A: _win("ccfzf")}) | {"mqttBase": 17})
    assert base == "", base


def test_open_session_defaults_to_yes():
    # Отсутствие поля — «берётся»: windows11-manager его не пишет и не должен,
    # открытие сессий там работало всегда.
    opens, _ = _read_caps(_payload({UUID_A: _win("ccfzf")}))
    assert opens is True, opens


def test_open_session_can_say_no():
    # Мак сессий не открывает — их открывает сам пикер. Без этого признака
    # пикер на маке назначил бы менеджером мак и получил молчащий Enter.
    opens, _ = _read_caps(_payload({UUID_A: _win("ccfzf")}) | {"openSession": False})
    assert opens is False, opens


def test_junk_open_session_reads_as_yes():
    opens, _ = _read_caps(_payload({UUID_A: _win("ccfzf")}) | {"openSession": "нет"})
    assert opens is True, opens
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `python3 tests/test_windows_file.py`
Expected: FAIL — `read_windows` отдаёт шесть значений, распаковка в восемь не выходит.

- [ ] **Step 3: Прочитать поля в `read_windows`**

В начале функции заменить строку пустого ответа:

```python
    empty = ({}, "", 0, [], [], True, True, "")
```

Рядом с чтением `focus` (сейчас ~528-536) дописать:

```python
    # Берётся ли менеджер этой машины открывать сессии и терминалы. Отсутствие
    # поля — «берётся», по той же причине, что и у `focus`: windows11-manager
    # его не пишет и не должен. Мак пишет False — терминалы там открывает сам
    # пикер, и просьба, ушедшая маку, не нашла бы разбирающего.
    open_session = o.get("openSession")
    if not isinstance(open_session, bool):
        open_session = True

    # Топик, на котором менеджер этой машины слушает просьбы. Пустая строка
    # значит «спроси свой конфиг» — так себя вёл читатель до появления поля, и
    # так он обязан вести себя с трекером прежней версии.
    mqtt_base = o.get("mqttBase")
    if not isinstance(mqtt_base, str):
        mqtt_base = ""
```

и поправить возврат:

```python
    return out, host, pid, snaps, projects, focus, open_session, mqtt_base
```

- [ ] **Step 4: Прогнать — тесты файла проходят**

Run: `python3 tests/test_windows_file.py`
Expected: PASS

- [ ] **Step 5: Написать падающие тесты слияния в `tests/test_windows_merge.py`**

Сначала расширить локальный помощник `_file` (около 21-й строки — сейчас его сигнатура `_file(host, windows, pid=42, focus=None, projects=None, snapshots=None)`), добавив `open_session=None, mqtt_base=None` тем же способом, каким там уже добавляется `focus`:

```python
    if open_session is not None:
        out["openSession"] = open_session
    if mqtt_base is not None:
        out["mqttBase"] = mqtt_base
```

Собирает источники помощник `_merge(legacy=None, dir_files=None, now=NOW)`; `read_window_sources` отдаёт шесть значений — `(windows, host, pid, snapshots, projects, hosts)`. Дописать тесты:

```python
def test_window_carries_the_address_of_its_own_tracker():
    # Подъём просят у той машины, где стоит окно, а адрес у каждой свой.
    # Верхнего поля тут не хватило бы: оно называет одну машину, а окна
    # приезжают от нескольких.
    windows, _, _, _, _, _ = _merge(
        legacy=_file("windows-box", {UUID_A: _win("ccfzf")},
                     mqtt_base="home/room/pc/windows"),
        dir_files={"mac-host.json": _file("mac-host", {UUID_B: _win("other")},
                                          mqtt_base="home/room/mac/windows")},
    )
    assert windows[UUID_A]["mqttBase"] == "home/room/pc/windows", windows[UUID_A]
    assert windows[UUID_B]["mqttBase"] == "home/room/mac/windows", windows[UUID_B]


def test_tracker_list_carries_address_and_open_ability():
    # Кто откроет терминал — вопрос про машину, и задаётся он этому списку.
    # У записи окна `openSession` не значил бы ничего: у строки проекта окна
    # нет вовсе, а спросить надо и про неё.
    _, _, _, _, _, hosts = _merge(
        legacy=_file("windows-box", {}, pid=42),
        dir_files={"mac-host.json": _file("mac-host", {}, pid=7,
                                          open_session=False,
                                          mqtt_base="home/room/mac/windows")},
    )
    assert hosts == [
        {"host": "windows-box", "pid": 42, "canFocus": True,
         "openSession": True, "mqttBase": ""},
        {"host": "mac-host", "pid": 7, "canFocus": True,
         "openSession": False, "mqttBase": "home/room/mac/windows"},
    ], hosts
```

Порядок записей в `hosts` задан порядком чтения источников (`window_sources`: сначала одиночный файл, потом каталог) — если он окажется другим, править ожидание в тесте, а не порядок чтения.

- [ ] **Step 6: Прогнать и убедиться, что падает**

Run: `python3 tests/test_windows_merge.py`
Expected: FAIL — в записях нет `mqttBase`, в `hosts` нет `openSession`.

- [ ] **Step 7: Пронести поля в `read_window_sources`**

```python
    for path in window_sources(file_path, dir_path):
        w, host, pid, sn, pr, focus, open_session, mqtt_base = read_windows(path, now)
        if not host:
            continue
        hosts.append({"host": host, "pid": pid, "canFocus": focus,
                      "openSession": open_session, "mqttBase": mqtt_base})
        ...
        for sid, rec in w.items():
            prev = windows.get(sid)
            if prev is not None and prev["lastSeen"] >= rec["lastSeen"]:
                continue
            windows[sid] = dict(rec, host=host, pid=pid, canFocus=focus,
                                mqttBase=mqtt_base)
```

В doc-комментарий функции дописать абзац:

```
    Адрес просьбы (`mqttBase`) приписывается и записи окна, и записи машины:
    по первому выбирается, куда просить о подъёме, по второму — куда просить
    об открытии сессии. `openSession` живёт только в записи машины: у строки
    проекта окна нет вовсе, а спросить «кто откроет терминал» надо и про неё.
```

- [ ] **Step 8: Прогнать оба файла**

Run: `python3 tests/test_windows_file.py && python3 tests/test_windows_merge.py`
Expected: PASS оба

- [ ] **Step 9: Коммит**

```bash
git add ccfzf tests/test_windows_file.py tests/test_windows_merge.py
git commit -m "$(cat <<'EOF'
feat(windows): трекер называет свой адрес и своё умение открывать сессии

mqttBase едет и в запись окна, и в запись машины: по первому просят подъёма,
по второму — открытия. openSession только в записи машины — у строки проекта
окна нет, а спросить надо и про неё.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Блок `mqtt:` в конфиге трекера

**Repo:** `~/projects/js/macos-windows-manager`, ветка `master`

**Files:**
- Modify: `crates/mwm-core/src/config.rs`

**Interfaces:**
- Produces: `pub struct MqttConfig { host: String, port: u16, user: String, password: String, base: String }` с методом `pub fn is_configured(&self) -> bool`; поле `pub mqtt: MqttConfig` в `Config`.

**Контекст:** разбор идёт по полям, а не документом целиком, и это правило уже оплачено на первом этапе: опечатка в одном ключе обнуляла `sshHost` и трекер молча переставал публиковать.

- [ ] **Step 1: Написать падающие тесты**

Дописать в `mod tests` файла `config.rs`:

```rust
    #[test]
    fn mqtt_block_is_read() {
        let c = parse_config(
            "sshHost: remote-host\nmqtt:\n  host: broker.lan\n  port: 8883\n  user: picker\n  password: secret\n  base: home/room/mac/windows\n",
            "mac-host",
        );
        assert_eq!(c.mqtt.host, "broker.lan");
        assert_eq!(c.mqtt.port, 8883);
        assert_eq!(c.mqtt.user, "picker");
        assert_eq!(c.mqtt.password, "secret");
        assert_eq!(c.mqtt.base, "home/room/mac/windows");
        assert!(c.mqtt.is_configured());
    }

    #[test]
    fn missing_mqtt_block_is_a_switched_off_broker() {
        // Трекер без брокера работает: он просто не объявляет умения поднимать
        // окно, и Enter на маке остаётся тем, чем был.
        let c = parse_config("sshHost: remote-host\n", "mac-host");
        assert!(!c.mqtt.is_configured());
        assert_eq!(c.mqtt.port, 1883, "порт по умолчанию нужен и выключенному");
    }

    #[test]
    fn mqtt_without_base_is_not_configured() {
        // Угадывать чужой префикс топиков нельзя: публиковать было бы некуда,
        // а выглядело бы это настроенным брокером.
        let c = parse_config("mqtt:\n  host: broker.lan\n", "mac-host");
        assert!(!c.mqtt.is_configured());
    }

    #[test]
    fn trailing_slash_in_base_is_cut() {
        // Топик склеивается как `<base>/claude-focus`; лишняя косая дала бы
        // двойную, и подписка разошлась бы с публикацией на один символ.
        let c = parse_config("mqtt:\n  host: broker.lan\n  base: home/room/mac/windows/\n", "mac-host");
        assert_eq!(c.mqtt.base, "home/room/mac/windows");
    }

    #[test]
    fn junk_in_one_mqtt_field_does_not_cost_the_others() {
        // То же правило, что и у остальных полей конфига: опечатка стоит поля,
        // а не всех настроек.
        let c = parse_config(
            "mqtt:\n  host: broker.lan\n  port: \"не число\"\n  base: home/room/mac/windows\n",
            "mac-host",
        );
        assert_eq!(c.mqtt.host, "broker.lan");
        assert_eq!(c.mqtt.port, 1883);
        assert!(c.mqtt.is_configured());
    }

    #[test]
    fn ssh_host_survives_a_broken_mqtt_block() {
        let c = parse_config("sshHost: remote-host\nmqtt: \"not-a-map\"\n", "mac-host");
        assert_eq!(c.ssh_host, "remote-host");
        assert!(!c.mqtt.is_configured());
    }
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `cd ~/projects/js/macos-windows-manager && cargo test -p mwm-core`
Expected: FAIL — «no field `mqtt` on type `Config`».

- [ ] **Step 3: Реализовать**

В `config.rs` над `Config` добавить:

```rust
/// Брокер, через который приезжают просьбы о подъёме окна и о пометке
/// непрочитанным.
///
/// Пароль живёт здесь, а не приезжает откуда-то ещё: у трея нет ни фронтенда,
/// ни аргументов командной строки, а argv виден в списке процессов.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MqttConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    /// Префикс топиков этой машины. Подписка идёт на `<base>/#`.
    pub base: String,
}

impl MqttConfig {
    /// Настроен, если известны и адрес, и префикс: без второго подписываться
    /// некуда, а угадывать чужой префикс нельзя. То же правило, что у
    /// `Broker::is_configured` в пикере.
    pub fn is_configured(&self) -> bool {
        !self.host.is_empty() && !self.base.is_empty()
    }
}
```

В `Config` добавить поле:

```rust
    /// Брокер просьб. Пустой блок значит «просьб не будет», и тогда трекер не
    /// объявляет умения поднимать окно.
    pub mqtt: MqttConfig,
```

В `parse_config` перед сборкой `Config`:

```rust
    // Блок читается по полям, как и всё остальное: опечатка в порту не должна
    // стоить адреса брокера. Отсутствующий или не-словарь блок даёт
    // выключенный брокер, а не отказ.
    let mqtt_map = map
        .get("mqtt")
        .and_then(|v| v.as_mapping())
        .cloned()
        .unwrap_or_default();
    let mqtt_text = |key: &str| {
        mqtt_map
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let mqtt = MqttConfig {
        host: mqtt_text("host"),
        port: mqtt_map
            .get("port")
            .and_then(|v| v.as_u64())
            .and_then(|v| u16::try_from(v).ok())
            .unwrap_or(1883),
        user: mqtt_text("user"),
        password: mqtt_map
            .get("password")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        base: mqtt_text("base").trim_end_matches('/').to_string(),
    };
```

и добавить `mqtt` в возвращаемый `Config`. Пароль, в отличие от остальных полей, не подрезается по краям: пробел в нём законен.

- [ ] **Step 4: Прогнать**

Run: `cargo test -p mwm-core`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add crates/mwm-core/src/config.rs
git commit -m "$(cat <<'EOF'
feat(config): блок mqtt — адрес брокера и префикс топиков этой машины

Разбор по полям, как и весь остальной конфиг: опечатка в порту не должна
стоить адреса. Без базы брокер считается ненастроенным — угадывать чужой
префикс нельзя.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Файл окон называет адрес и умение открывать

**Repo:** `~/projects/js/macos-windows-manager`

**Files:**
- Modify: `crates/mwm-core/src/publish.rs`
- Modify: `src-tauri/src/main.rs` (только вызов `build_file`)

**Interfaces:**
- Consumes: `MqttConfig` из задачи 2 не нужен — база приходит строкой.
- Produces: `build_file(bound: &BTreeMap<String, Bound>, host: &str, pid: u32, now_ms: u64, can_focus: bool, mqtt_base: &str) -> serde_json::Value`. В файле появляются ключи `mqttBase` (строка) и `openSession` (всегда `false`).

- [ ] **Step 1: Написать падающие тесты**

Дописать в `mod tests` файла `publish.rs`:

```rust
    #[test]
    fn file_names_the_address_of_this_machine() {
        // Читателю неоткуда узнать, куда просить о подъёме: топик живёт в
        // конфиге трекера, а публикует читатель. Поэтому адрес называет тот,
        // кто его знает.
        let v = build_file(&bound("ccfzf", 60_000), "mac-host", 7, 60_000, true,
                           "home/room/mac/windows");
        assert_eq!(v["mqttBase"], "home/room/mac/windows");
        assert_eq!(v["focus"], true);
    }

    #[test]
    fn this_machine_does_not_open_sessions() {
        // Терминалы на маке открывает сам пикер, и это работает. Объявив
        // обратное, трекер увёл бы к себе просьбу `claude-session-open`,
        // которую здесь никто не разбирает, — и Enter замолчал бы.
        let v = build_file(&bound("ccfzf", 60_000), "mac-host", 7, 60_000, true, "");
        assert_eq!(v["openSession"], false);
    }

    #[test]
    fn an_unset_broker_leaves_the_address_empty() {
        // Пустая строка читается агрегатором как «спроси свой конфиг» — так
        // себя вёл читатель до появления поля.
        let v = build_file(&bound("ccfzf", 60_000), "mac-host", 7, 60_000, false, "");
        assert_eq!(v["mqttBase"], "");
        assert_eq!(v["focus"], false);
    }
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `cargo test -p mwm-core`
Expected: FAIL — `build_file` принимает пять аргументов.

- [ ] **Step 3: Реализовать**

В `publish.rs` дописать параметр и два ключа:

```rust
pub fn build_file(
    bound: &BTreeMap<String, Bound>,
    host: &str,
    pid: u32,
    now_ms: u64,
    can_focus: bool,
    mqtt_base: &str,
) -> serde_json::Value {
```

в возвращаемый `json!`:

```rust
        "focus": can_focus,
        // Берётся ли этот менеджер открывать сессии и терминалы. Не берётся, и
        // это не заготовка на будущее: на маке терминал открывает сам пикер, и
        // открывает верно. Объяви трекер обратное — пикер на маке увёл бы к
        // нему `claude-session-open`, а разбирать её здесь некому.
        "openSession": false,
        // Куда просить. Пустая строка значит «спроси свой конфиг»: так вёл себя
        // читатель до появления поля, и так он обязан вести себя с трекером
        // прежней версии.
        "mqttBase": mqtt_base,
```

Doc-комментарий функции поправить: перечисление отличий от Windows-формата теперь называет и эти два ключа.

В `src-tauri/src/main.rs` поправить единственный вызов (пока — с пустой базой и прежним `false`, живое соединение появится в задаче 8):

```rust
            let payload = build_file(&bound, &cfg.host, pid, now, false, &cfg.mqtt.base);
```

- [ ] **Step 4: Прогнать**

Run: `cargo test -p mwm-core && cargo test -p macos-windows-manager`
Expected: PASS оба

- [ ] **Step 5: Коммит**

```bash
git add crates/mwm-core/src/publish.rs src-tauri/src/main.rs
git commit -m "$(cat <<'EOF'
feat(publish): файл окон называет свой адрес и отказ открывать сессии

openSession: false — не заготовка: терминал на маке открывает сам пикер, и
уведи трекер эту просьбу к себе, разбирать её было бы некому.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `mark_unread` в трекере

**Repo:** `~/projects/js/macos-windows-manager`

**Files:**
- Modify: `crates/mwm-core/src/tracker.rs`

**Interfaces:**
- Produces: `pub fn mark_unread(&mut self, session_id: &str)` у `Tracker`.

**Контекст:** отметок о просмотре две — своя в `seen.json` у пикера и трекерная `focusedAt`; в списке они складываются по максимуму. Отмотать только свою бесполезно: следующий опрос вернул бы кружок в «просмотрено».

- [ ] **Step 1: Написать падающие тесты**

```rust
    #[test]
    fn mark_unread_rewinds_the_focus_stamp() {
        // Своя отметка в seen.json у пикера бессильна: трекерная почти всегда
        // свежее и побеждает по максимуму. Отматывать надо ту, что перебивает.
        let mut t = Tracker::new(1);
        let idx = index(&[("ccfzf", SID)]);
        t.tick(&[Seen { id: 1, title: "ccfzf".into(), focused: true }], &idx, 5_000);
        assert_eq!(t.bound()[SID].focused_at_ms, 5_000);
        t.mark_unread(SID);
        assert_eq!(t.bound()[SID].focused_at_ms, 0, "отметка отмотана сразу, а не к следующему такту");
    }

    #[test]
    fn a_rewound_stamp_stays_rewound_while_the_window_is_not_watched() {
        // Слот переживает такт; не обнули мы его, следующий же тик вернул бы
        // прежнее значение, и отмотка выглядела бы сработавшей ровно на секунду.
        let mut t = Tracker::new(1);
        let idx = index(&[("ccfzf", SID)]);
        t.tick(&[Seen { id: 1, title: "ccfzf".into(), focused: true }], &idx, 5_000);
        t.mark_unread(SID);
        t.tick(&[seen(1, "ccfzf")], &idx, 6_000);
        assert_eq!(t.bound()[SID].focused_at_ms, 0);
    }

    #[test]
    fn looking_at_the_window_again_marks_it_seen_again() {
        // «Просмотрено» и значит «взгляд на нём сейчас». Возврат взгляда обязан
        // ставить отметку заново — иначе отмотка была бы не отметкой, а
        // запретом.
        let mut t = Tracker::new(1);
        let idx = index(&[("ccfzf", SID)]);
        t.tick(&[Seen { id: 1, title: "ccfzf".into(), focused: true }], &idx, 5_000);
        t.mark_unread(SID);
        t.tick(&[Seen { id: 1, title: "ccfzf".into(), focused: true }], &idx, 7_000);
        assert_eq!(t.bound()[SID].focused_at_ms, 7_000);
    }

    #[test]
    fn mark_unread_of_an_unknown_session_is_quiet() {
        // Просьба приезжает с чужой машины и может опоздать: сессию закрыли
        // между опросом и нажатием. Это норма, а не сбой.
        let mut t = Tracker::new(1);
        t.mark_unread("нет-такой");
        assert!(t.bound().is_empty());
    }
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `cargo test -p mwm-core`
Expected: FAIL — «no method named `mark_unread`».

- [ ] **Step 3: Реализовать**

В `impl Tracker`, рядом с `bound()`:

```rust
    /// Вернуть сессию в непрочитанное: обнулить отметку взгляда.
    ///
    /// Правится и слот, и текущая привязка. Слот — потому что он источник
    /// правды: `tick` собирает `bound` заново из слотов, и без обнуления слота
    /// отмотка прожила бы ровно один такт. `bound` — потому что порядок
    /// вызовов не наш: просьба приходит из другого потока в любой момент, и
    /// файл, записанный между отмоткой и следующим тиком, обязан её показывать.
    ///
    /// Отпечаток расклада считает `focused_at_ms`, поэтому просить о записи
    /// отдельно не нужно: `should_write` заметит изменение сам.
    ///
    /// Незнакомая сессия — молчание, а не ошибка: просьба едет с чужой машины,
    /// и окно могли закрыть, пока она ехала.
    pub fn mark_unread(&mut self, session_id: &str) {
        if let Some(slot) = self.slots.get_mut(session_id) {
            slot.focused_at_ms = 0;
        }
        if let Some(b) = self.bound.get_mut(session_id) {
            b.focused_at_ms = 0;
        }
    }
```

- [ ] **Step 4: Прогнать**

Run: `cargo test -p mwm-core`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add crates/mwm-core/src/tracker.rs
git commit -m "$(cat <<'EOF'
feat(tracker): mark_unread отматывает отметку взгляда

Правится и слот, и текущая привязка: слот — источник правды для следующего
тика, привязка — то, что уедет в файл, если он запишется раньше тика.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Разбор просьбы — `request.rs`

**Repo:** `~/projects/js/macos-windows-manager`

**Files:**
- Create: `crates/mwm-core/src/request.rs`
- Modify: `crates/mwm-core/src/lib.rs`

**Interfaces:**
- Produces:
  - `pub enum Request { Focus(String), Unread(String) }` (`#[derive(Debug, Clone, PartialEq)]`)
  - `pub fn command_from_topic<'a>(topic: &'a str, base: &str) -> Option<&'a str>`
  - `pub fn parse_request(command: &str, payload: &str) -> Option<Request>`

**Контекст:** та же форма, что у `commandFromTopic` в windows11-manager — имя команды это хвост топика после базы. Хвост с косой чертой отбрасывается: подписка идёт на `<base>/#`, и своё эхо (если оно когда-нибудь заведётся) не должно выглядеть просьбой.

- [ ] **Step 1: Написать падающий тест**

Создать `crates/mwm-core/src/request.rs` сразу с тестами и пустой реализацией нельзя — сначала тесты. Написать файл целиком в этом шаге, оставив тела функций `todo!()`:

```rust
//! Просьбы, приезжающие по MQTT: что просят и о какой сессии.
//!
//! Разбор живёт здесь, а не рядом с подпиской, по той же причине, по какой
//! здесь живёт весь `mwm-core`: тесты этого крейта гоняются на любой машине, а
//! на маке их гонять неудобно.

/// О чём просят.
#[derive(Debug, Clone, PartialEq)]
pub enum Request {
    /// Поднять окно этой сессии.
    Focus(String),
    /// Вернуть сессию в непрочитанное.
    Unread(String),
}

/// Имя команды — хвост топика после базы.
pub fn command_from_topic<'a>(topic: &'a str, base: &str) -> Option<&'a str> {
    todo!()
}

/// Просьба из имени команды и тела.
pub fn parse_request(command: &str, payload: &str) -> Option<Request> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "aaaaaaaa-1111-2222-3333-444444444444";
    const BASE: &str = "home/room/mac/windows";

    #[test]
    fn command_is_the_tail_of_the_topic() {
        assert_eq!(command_from_topic("home/room/mac/windows/claude-focus", BASE), Some("claude-focus"));
    }

    #[test]
    fn a_foreign_base_is_not_ours() {
        // Подписка стоит на своей базе, но брокер один на установку, и путать
        // соседнюю машину со своей нельзя: просьбу разобрали бы оба менеджера.
        assert_eq!(command_from_topic("home/room/pc/windows/claude-focus", BASE), None);
    }

    #[test]
    fn a_tail_with_a_slash_is_not_a_command() {
        // Подписка идёт на `<base>/#`. Всё, что глубже одного уровня, — не
        // просьба, а чьё-то эхо. То же правило, что у commandFromTopic в
        // windows11-manager.
        assert_eq!(command_from_topic("home/room/mac/windows/claude/slot/1", BASE), None);
    }

    #[test]
    fn the_base_itself_is_not_a_command() {
        assert_eq!(command_from_topic(BASE, BASE), None);
        assert_eq!(command_from_topic("home/room/mac/windows/", BASE), None);
    }

    #[test]
    fn focus_and_unread_are_understood() {
        let body = format!("{{\"id\":\"{SID}\"}}");
        assert_eq!(parse_request("claude-focus", &body), Some(Request::Focus(SID.to_string())));
        assert_eq!(parse_request("claude-session-unread", &body), Some(Request::Unread(SID.to_string())));
    }

    #[test]
    fn a_bare_string_body_is_understood_too() {
        // С панели openHASP на Windows-сторону прилетает сырая строка, а не
        // объект. Здесь такого источника пока нет, но разойтись с соседом в
        // разборе одного и того же топика — это отладка на двух машинах сразу.
        assert_eq!(parse_request("claude-focus", SID), Some(Request::Focus(SID.to_string())));
        assert_eq!(parse_request("claude-focus", &format!("\"{SID}\"")), Some(Request::Focus(SID.to_string())));
    }

    #[test]
    fn an_unknown_command_is_nothing() {
        // Молча: на своей базе может оказаться что угодно, и жаловаться на
        // каждое сообщение значит забить журнал.
        let body = format!("{{\"id\":\"{SID}\"}}");
        assert_eq!(parse_request("claude-snapshot-restore", &body), None);
    }

    #[test]
    fn a_body_without_an_id_is_nothing() {
        assert_eq!(parse_request("claude-focus", "{}"), None);
        assert_eq!(parse_request("claude-focus", "{\"id\":\"\"}"), None);
        assert_eq!(parse_request("claude-focus", "{\"id\":17}"), None);
        assert_eq!(parse_request("claude-focus", ""), None);
    }
}
```

В `crates/mwm-core/src/lib.rs` дописать `pub mod request;`.

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `cargo test -p mwm-core`
Expected: FAIL — паника `not yet implemented` в тестах.

- [ ] **Step 3: Реализовать**

```rust
pub fn command_from_topic<'a>(topic: &'a str, base: &str) -> Option<&'a str> {
    let rest = topic.strip_prefix(base)?.strip_prefix('/')?;
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    Some(rest)
}

pub fn parse_request(command: &str, payload: &str) -> Option<Request> {
    let id = id_from_payload(payload)?;
    match command {
        "claude-focus" => Some(Request::Focus(id)),
        "claude-session-unread" => Some(Request::Unread(id)),
        _ => None,
    }
}

/// Id сессии из тела: из объекта `{"id": …}`, из json-строки и из сырой строки.
///
/// Три вида, а не один, потому что топики у нас общие с windows11-manager, а
/// туда с панели openHASP прилетает сырая строка. Разойтись с соседом в разборе
/// одного и того же топика — это отладка сразу на двух машинах.
fn id_from_payload(payload: &str) -> Option<String> {
    let text = payload.trim();
    if text.is_empty() {
        return None;
    }
    let id = match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Object(map)) => map.get("id")?.as_str()?.trim().to_string(),
        Ok(serde_json::Value::String(s)) => s.trim().to_string(),
        // Не json вовсе — значит сырая строка, как её шлёт панель.
        _ => text.to_string(),
    };
    if id.is_empty() { None } else { Some(id) }
}
```

- [ ] **Step 4: Прогнать**

Run: `cargo test -p mwm-core`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add crates/mwm-core/src/request.rs crates/mwm-core/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(request): имя команды из топика и разбор тела просьбы

Хвост с косой чертой командой не считается — то же правило, что у
commandFromTopic в windows11-manager: подписка на `#` слышит и чужое эхо.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Подписка на брокера

**Repo:** `~/projects/js/macos-windows-manager`

**Files:**
- Create: `src-tauri/src/mqtt.rs`
- Modify: `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: `mwm_core::config::MqttConfig` (задача 2), `mwm_core::request::{command_from_topic, parse_request, Request}` (задача 5).
- Produces:
  - `pub struct Link { pub requests: std::sync::mpsc::Receiver<Request>, live: Arc<AtomicBool> }`
  - `impl Link { pub fn is_live(&self) -> bool }`
  - `pub fn spawn(cfg: &MqttConfig) -> Link`

**Контекст:** этот файл собирается и на Linux (rumqttc кроссплатформенный), значит компилятор здесь помогает. Платформенного кода в нём быть не должно.

- [ ] **Step 1: Добавить зависимость**

В `src-tauri/Cargo.toml`, в общий блок `[dependencies]` (не в macOS-блок):

```toml
rumqttc = "0.24"
```

Та же версия, что в пикере, — одна связка, один клиент.

- [ ] **Step 2: Написать `src-tauri/src/mqtt.rs`**

```rust
//! Подписка на просьбы: поднять окно, вернуть в непрочитанное.
//!
//! Слушает сам трей, а не пикер и не команда по ssh. Причин три, и все три
//! оплачены на выкатке первого этапа: ssh-сессия живёт в фоновом домене
//! безопасности и до графической не достаёт; подъём из пикера стоил бы второго
//! разрешения Accessibility на бинарь, который пересобирается чаще; а реестр
//! окон (`AXUIElement`) не `Send` и живёт в потоке трекера.
//!
//! Отсюда и форма: свой поток на соединение, канал наружу, исполняет просьбу
//! поток трекера.

use mwm_core::config::MqttConfig;
use mwm_core::request::{command_from_topic, parse_request, Request};
use rumqttc::{Client, Event, MqttOptions, Packet, QoS};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::Duration;

/// Пауза перед новой попыткой соединения. Брокер может лежать сколько угодно,
/// а трекер обязан продолжать публиковать окна: без паузы отказ соединения
/// крутился бы в горячем цикле и съел бы такт.
const RETRY: Duration = Duration::from_secs(5);

pub struct Link {
    pub requests: Receiver<Request>,
    live: Arc<AtomicBool>,
    /// Свой конец канала, который никуда не отдан. Он держит канал открытым:
    /// умри поток подписки, `recv_timeout` у читателя начал бы возвращать
    /// `Disconnected` мгновенно, и такт трекера превратился бы в горячий цикл.
    _keepalive: Sender<Request>,
}

impl Link {
    /// Установлено ли соединение прямо сейчас.
    ///
    /// По этому ответу трекер объявляет `focus` в файле окон. Объявить умение
    /// поднимать окно, не имея транспорта, значит подарить человеку молчащий
    /// Enter — а это хуже открытого терминала.
    pub fn is_live(&self) -> bool {
        self.live.load(Ordering::Relaxed)
    }
}

/// Поднять подписку. Ненастроенный брокер — не отказ: канал просто молчит, а
/// `is_live()` всегда отвечает «нет».
pub fn spawn(cfg: &MqttConfig) -> Link {
    let (tx, rx) = channel::<Request>();
    let live = Arc::new(AtomicBool::new(false));
    if !cfg.is_configured() {
        return Link { requests: rx, live, _keepalive: tx.clone() };
    }
    let worker_tx = tx.clone();
    let worker_live = live.clone();
    let cfg = cfg.clone();
    std::thread::spawn(move || run(cfg, worker_tx, worker_live));
    Link { requests: rx, live, _keepalive: tx }
}

fn run(cfg: MqttConfig, tx: Sender<Request>, live: Arc<AtomicBool>) {
    let base = cfg.base.clone();
    let filter = format!("{base}/#");
    loop {
        let mut opts = MqttOptions::new(format!("mwm-{}", std::process::id()), &cfg.host, cfg.port);
        opts.set_keep_alive(Duration::from_secs(30));
        if !cfg.user.is_empty() {
            opts.set_credentials(&cfg.user, &cfg.password);
        }
        let (client, mut connection) = Client::new(opts, 16);
        if let Err(e) = client.subscribe(&filter, QoS::AtMostOnce) {
            eprintln!("mwm: subscribe failed: {e}");
            live.store(false, Ordering::Relaxed);
            std::thread::sleep(RETRY);
            continue;
        }
        for event in connection.iter() {
            match event {
                // Живым соединение считается с подтверждения брокера, а не с
                // вызова `Client::new`: тот возвращает клиент сразу, до всякой
                // сети, и по нему трекер объявил бы умение, которого нет.
                Ok(Event::Incoming(Packet::ConnAck(_))) => {
                    live.store(true, Ordering::Relaxed);
                }
                Ok(Event::Incoming(Packet::Publish(p))) => {
                    let payload = String::from_utf8_lossy(&p.payload).to_string();
                    let Some(command) = command_from_topic(&p.topic, &base) else { continue };
                    // Незнакомая команда — молчание: на своей базе может
                    // оказаться что угодно, и жалоба на каждое сообщение забила
                    // бы журнал.
                    let Some(req) = parse_request(command, &payload) else { continue };
                    if tx.send(req).is_err() {
                        // Читателя не стало — трекер остановлен, и держать
                        // соединение больше не для кого.
                        return;
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    eprintln!("mwm: mqtt connection lost: {e}");
                    live.store(false, Ordering::Relaxed);
                    break;
                }
            }
        }
        live.store(false, Ordering::Relaxed);
        std::thread::sleep(RETRY);
    }
}
```

В `src-tauri/src/main.rs` дописать `mod mqtt;` рядом с остальными объявлениями модулей (сам вызов — в задаче 8).

- [ ] **Step 3: Собрать**

Run: `cargo test -p macos-windows-manager`
Expected: PASS (сборка проходит; тестов у этого файла нет — предупреждение о неиспользуемом `spawn` до задачи 8 допустимо)

Если компилятор ругается на форму `connection.iter()` или на имена пакетов, свериться с тем, как ровно тот же `rumqttc = "0.24"` вызывается в пикере: `ccfzf-picker/src-tauri/src/mqtt.rs`, функция `publish`.

- [ ] **Step 4: Коммит**

```bash
git add src-tauri/src/mqtt.rs src-tauri/src/main.rs src-tauri/Cargo.toml Cargo.lock
git commit -m "$(cat <<'EOF'
feat(mqtt): подписка на просьбы и признак живого соединения

Живым соединение считается с ConnAck, а не с создания клиента: по второму
трекер объявил бы умение поднимать окно, не имея транспорта.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `AXRaise` и активация приложения

**Repo:** `~/projects/js/macos-windows-manager`

**Files:**
- Modify: `src-tauri/src/ax.rs`

**Interfaces:**
- Produces: `pub fn raise(reg: &Registry, window_id: u64) -> Result<(), String>`; `Registry` запоминает pid владельца каждого окна.

**Контекст и предупреждение:** этот файл тестами не покрыт намеренно — проверять его нечем, кроме мака, и на этой машине macOS-ветка **не компилируется вовсе**. Ошибки в именах методов `accessibility` и `objc2-app-kit` всплывут только на выкатке (задача 13); так уже было на первом этапе. Поэтому: минимум кода, никакой логики, только вызовы платформы.

- [ ] **Step 1: Запомнить владельца окна в реестре**

В `mod imp` заменить объявление реестра:

```rust
    /// Кто есть кто между тактами.
    ///
    /// (прежний doc-комментарий оставить целиком)
    ///
    /// Рядом с номером хранится pid приложения-владельца. Спросить его у окна
    /// можно и потом, но здесь он уже известен даром — перечисление идёт по
    /// приложениям, — а подъёму он нужен обязательно: `AXRaise` поднимает окно
    /// внутри своего приложения, а вперёд приложение выводит уже AppKit.
    #[derive(Default)]
    pub struct Registry {
        known: Vec<(AXUIElement, u64)>,
        owners: std::collections::HashMap<u64, i32>,
        next: u64,
    }
```

В `id_of` пид не знают — поэтому в `list_windows`, сразу после `let id = reg.id_of(&w);`, дописать:

```rust
                reg.owners.insert(id, pid);
```

В `retain_seen` дочистить и владельцев. Метод сейчас берёт `&[AXUIElement]`; он вызывается один раз в конце `list_windows`, и там же под рукой список живых номеров:

```rust
        fn retain_seen(&mut self, seen: &[AXUIElement]) {
            self.known.retain(|(k, _)| seen.iter().any(|s| s == k));
            let live: std::collections::HashSet<u64> =
                self.known.iter().map(|(_, id)| *id).collect();
            self.owners.retain(|id, _| live.contains(id));
        }
```

- [ ] **Step 2: Написать `raise`**

В `mod imp` дописать:

```rust
    /// Поднять окно и вывести вперёд его приложение.
    ///
    /// Два действия, а не одно. `AXRaise` поднимает окно внутри своего
    /// приложения — среди чужих окон оно так и останется позади. Вперёд
    /// приложение выводит AppKit, и без этого шага человек не увидел бы
    /// ничего, а трекер отчитался бы об успехе.
    ///
    /// Грамоты на передний план, вокруг которой построена вся Windows-ветка,
    /// здесь нет и не нужно: macOS решила этот вопрос разрешением
    /// Accessibility, выданным человеком один раз.
    pub fn raise(reg: &Registry, window_id: u64) -> Result<(), String> {
        let el = reg
            .known
            .iter()
            .find(|(_, id)| *id == window_id)
            .map(|(el, _)| el.clone())
            .ok_or("window is gone")?;
        let pid = *reg.owners.get(&window_id).ok_or("window owner is unknown")?;
        let action = CFString::from_static_string("AXRaise");
        let err = unsafe {
            accessibility_sys::AXUIElementPerformAction(
                el.as_concrete_TypeRef(),
                action.as_concrete_TypeRef(),
            )
        };
        if err != accessibility_sys::kAXErrorSuccess {
            return Err(format!("AXRaise failed: {err}"));
        }
        let app = unsafe { NSRunningApplication::runningApplicationWithProcessIdentifier(pid) };
        let app = app.ok_or("owner application is gone")?;
        app.activate();
        Ok(())
    }
```

Дописать в `use` этого модуля `objc2_app_kit::NSRunningApplication` (там уже есть `NSWorkspace` — добавить вторым именем).

**Если на маке это не соберётся** (задача 13), пробовать по порядку, ничего больше не меняя:
1. `app.activate()` отсутствует в этой версии `objc2-app-kit` → `app.activateWithOptions(objc2_app_kit::NSApplicationActivationOptions::ActivateIgnoringOtherApps)`;
2. `runningApplicationWithProcessIdentifier` требует `unsafe` или не требует — снять или добавить по указанию компилятора, как это уже было сделано с обёртками `NSWorkspace` в коммите `1ad7cfe`;
3. `AXUIElementPerformAction` в `accessibility-sys` называется иначе → взять обёртку `el.perform_action(&action)` из крейта `accessibility`.

- [ ] **Step 3: Дописать заглушку для не-macOS**

В `mod imp` под `#[cfg(not(target_os = "macos"))]`:

```rust
    pub fn raise(_reg: &Registry, _window_id: u64) -> Result<(), String> {
        Err("raise is available on macOS only".to_string())
    }
```

и добавить `raise` в общий `pub use imp::{…}` в конце файла.

- [ ] **Step 4: Собрать не-macOS ветку**

Run: `cargo test -p macos-windows-manager`
Expected: PASS (собирается заглушка; macOS-ветка проверится только на выкатке)

- [ ] **Step 5: Коммит**

```bash
git add src-tauri/src/ax.rs
git commit -m "$(cat <<'EOF'
feat(ax): подъём окна — AXRaise плюс вывод приложения вперёд

Одного AXRaise мало: он поднимает окно внутри своего приложения, а среди
чужих окон оно так и осталось бы позади — и трекер отчитался бы об успехе.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Такт трекера исполняет просьбы

**Repo:** `~/projects/js/macos-windows-manager`

**Files:**
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `mqtt::spawn`, `Link::is_live` (задача 6); `ax::raise` (задача 7); `Tracker::mark_unread` (задача 4); `build_file(..., can_focus, mqtt_base)` (задача 3).

**Контекст:** реестр окон живёт в этом потоке и никуда не переносится, значит подъём исполняется здесь же. Сон между тактами меняется на ожидание просьбы: иначе Enter отзывался бы к следующему такту, а не сразу.

- [ ] **Step 1: Заменить сон на ожидание просьбы**

В `run_tracker`, после `let mut cache = dump::Cache::default();`:

```rust
    let link = mqtt::spawn(&cfg.mqtt);
    // Номер окна каждой сессии на прошлом такте: подъёму нужно окно, а `bound`
    // рассказывает про сессии. Держим рядом, потому что `Registry` знает
    // номера, а не сессии, и связать их может только тот, кто видел оба списка.
    let mut window_of: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
```

Заменить `std::thread::sleep(Duration::from_millis(cfg.tick_ms));` в начале цикла на:

```rust
        // Ожидание вместо сна: просьба исполняется сразу, а не к следующему
        // такту. Отсоединение канала (поток подписки умер) — тот же сон:
        // `recv_timeout` на закрытом канале возвращается мгновенно, и без
        // этой ветки такт превратился бы в горячий цикл.
        match link.requests.recv_timeout(Duration::from_millis(cfg.tick_ms)) {
            Ok(req) => {
                let mut pending = vec![req];
                // Разгребается вся очередь, а не одна просьба: иначе каждая
                // стоила бы полного такта с перечислением окон и, возможно,
                // походом за дампом по ssh.
                while let Ok(next) = link.requests.try_recv() {
                    pending.push(next);
                }
                for req in pending {
                    let note = serve(&req, &mut tracker, &registry, &window_of);
                    if let Some(note) = note {
                        eprintln!("mwm: {note}");
                        *status.0.lock().unwrap() = note;
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                std::thread::sleep(Duration::from_millis(cfg.tick_ms));
            }
        }
```

- [ ] **Step 2: Написать исполнителя просьб**

Рядом с `run_tracker` в том же файле:

```rust
/// Исполнить просьбу. Возвращает жалобу, если исполнить не вышло.
///
/// Отказ виден человеку — строкой в трее и в stderr, — но не пикеру: у
/// публикации нет ответа, и заводить его ради одного мака значило бы разойтись
/// с Windows-веткой. Цена известна и уплачена ещё там.
///
/// Английский в жалобе — правило проекта: её видит человек.
fn serve(
    req: &mwm_core::request::Request,
    tracker: &mut Tracker,
    registry: &ax::Registry,
    window_of: &std::collections::HashMap<String, u64>,
) -> Option<String> {
    use mwm_core::request::Request;
    match req {
        Request::Focus(id) => {
            // Просьба о сессии без живого окна сюда не приходит: пикер
            // предлагает подъём только строкам с полем `window`. Но гонка
            // возможна — окно закрыли между опросом и нажатием.
            let Some(window_id) = window_of.get(id) else {
                return Some(format!("focus: no window for session {id}"));
            };
            ax::raise(registry, *window_id).err().map(|e| format!("focus: {e}"))
        }
        Request::Unread(id) => {
            tracker.mark_unread(id);
            None
        }
    }
}
```

- [ ] **Step 3: Наполнять `window_of` и объявлять умение по соединению**

В теле такта, там, где сейчас `tracker.tick(&seen, &index, now);`, дописать сразу после него сбор соответствия сессий и окон. `Seen` знает номер окна и заголовок, `bound` — сессию и тот же заголовок после `strip_decoration`; связывает их заголовок:

```rust
        tracker.tick(&seen, &index, now);
        let bound = tracker.bound();
        // Сессия ↔ окно. Заголовок — единственное, что есть у обоих списков:
        // `Seen` знает номер окна, `Bound` — сессию, и оба знают, как окно
        // называется. У `Bound` заголовок уже очищен от значка состояния,
        // поэтому и здесь он чистится перед сравнением.
        window_of.clear();
        for (sid, b) in &bound {
            if let Some(w) = seen
                .iter()
                .find(|w| mwm_core::title::strip_decoration(&w.title) == b.title)
            {
                window_of.insert(sid.clone(), w.id);
            }
        }
```

(строку `let bound = tracker.bound();` ниже по функции убрать — она теперь выше).

Заменить вызов `build_file`:

```rust
            let payload = build_file(&bound, &cfg.host, pid, now, link.is_live(), &cfg.mqtt.base);
```

Проверить, что `mwm_core::title::strip_decoration` объявлен `pub` — если нет, сделать его таким.

- [ ] **Step 4: Собрать и прогнать**

Run: `cargo test -p mwm-core && cargo test -p macos-windows-manager`
Expected: PASS оба

- [ ] **Step 5: Коммит**

```bash
git add src-tauri/src/main.rs crates/mwm-core/src/title.rs
git commit -m "$(cat <<'EOF'
feat(tracker): такт ждёт просьбу, а не спит

Подъём исполняется в потоке трекера — реестр окон не Send. Умение поднимать
объявляется по живому соединению: обещание без транспорта дало бы молчащий
Enter, а это хуже открытого терминала.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Пикер знает адрес машины и её менеджера

**Repo:** `~/projects/js/ccfzf-picker`, ветка `windows-mqtt-migrate`

**Files:**
- Modify: `frontend-src/session-windows.js`
- Test: `test/session-windows.test.js`

**Interfaces:**
- Produces:
  - `mqttBaseFor(row, state)` → строка (`''`, если адреса нет)
  - `openManager(state, configHost)` → `{host, pid, canFocus, openSession, mqttBase}` либо `null`
  - оба добавляются в экспорт рядом с `canFocusRow`, `trackerHere`, `trackerHosts`, `focusPid`

- [ ] **Step 1: Написать падающие тесты**

Дописать в `test/session-windows.test.js` (форма файла — как у соседних тестов там же):

```js
test('адрес подъёма берётся у машины окна, а не у верхнего поля', () => {
  // Трекеров несколько, и адрес у каждого свой. Верхнее поле называет одну
  // машину — по нему просьба уехала бы поднимать окно на чужом экране.
  const state = {
    windowHost: 'windows-box',
    windowHosts: [{ host: 'windows-box', mqttBase: 'home/room/pc/windows' },
                  { host: 'mac-host', mqttBase: 'home/room/mac/windows' }],
  };
  const row = { window: { host: 'mac-host', pid: 7, canFocus: true, mqttBase: 'home/room/mac/windows' } };
  assert.equal(SessionWindows.mqttBaseFor(row, state), 'home/room/mac/windows');
});

test('строка без окна адреса не называет', () => {
  assert.equal(SessionWindows.mqttBaseFor({}, {}), '');
});

test('старый агрегатор адреса не даёт, и это пустая строка, а не поломка', () => {
  // Пустая строка значит «спроси свой конфиг» — так пикер вёл себя до
  // появления поля, и так он обязан вести себя со старым агрегатором.
  const state = { windowHost: 'windows-box', windowPid: 42 };
  assert.equal(SessionWindows.mqttBaseFor({ window: { title: 'ccfzf' } }, state), '');
});

test('менеджером берётся свой трекер, если он умеет открывать сессии', () => {
  const state = {
    windowHosts: [{ host: 'mac-host', pid: 7, openSession: false, mqttBase: 'home/room/mac/windows' },
                  { host: 'windows-box', pid: 42, mqttBase: 'home/room/pc/windows' }],
  };
  assert.equal(SessionWindows.openManager(state, 'windows-box').host, 'windows-box');
});

test('свой трекер, не берущийся открывать сессии, менеджером не считается', () => {
  // Иначе пикер на маке увёл бы просьбу к маку, где её никто не разбирает, —
  // и Enter замолчал бы. Молчащий Enter хуже открытого терминала.
  const state = {
    windowHosts: [{ host: 'mac-host', pid: 7, openSession: false, mqttBase: 'home/room/mac/windows' },
                  { host: 'windows-box', pid: 42, mqttBase: 'home/room/pc/windows' }],
  };
  assert.equal(SessionWindows.openManager(state, 'mac-host').host, 'windows-box');
});

test('свой трекер важнее чужого', () => {
  const state = {
    windowHosts: [{ host: 'windows-box', pid: 42 }, { host: 'other-box', pid: 43 }],
  };
  assert.equal(SessionWindows.openManager(state, 'windows-box').host, 'windows-box');
});

test('без трекеров менеджера нет', () => {
  assert.equal(SessionWindows.openManager({}, 'mac-host'), null);
});

test('старый агрегатор называет одну машину, и она же менеджер', () => {
  // Одного трекера хватало всегда, и пикер новее агрегатора обязан вести себя
  // как прежде, а не терять ветку менеджера.
  const state = { windowHost: 'windows-box', windowPid: 42 };
  assert.equal(SessionWindows.openManager(state, 'windows-box').host, 'windows-box');
});
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `npm test`
Expected: FAIL — `SessionWindows.mqttBaseFor is not a function`

- [ ] **Step 3: Реализовать**

В `frontend-src/session-windows.js`, после `canFocusRow`:

```js
  /**
   * Куда просить о подъёме окна этой строки.
   *
   * Адрес — свойство машины окна, а не всего ответа: трекеров несколько, и у
   * каждого свой топик. Пустая строка значит «спроси свой конфиг» — так пикер
   * вёл себя до появления поля, и так он обязан вести себя со старым
   * агрегатором и со старым трекером.
   */
  function mqttBaseFor(row, state) {
    const w = windowOf(row, state);
    const base = w && typeof w.mqttBase === 'string' ? w.mqttBase.trim() : '';
    return base;
  }

  /**
   * Трекер, чей менеджер берётся открывать сессии и терминалы.
   *
   * Вопрос про машину, а не про строку, и построчным он стать не может: у
   * строки проекта окна нет вовсе, а спросить «кто откроет терминал» надо и
   * про неё. Раньше на него отвечало верхнее поле `windowHost`, но с
   * несколькими трекерами оно значит «машина, чьи проектные хоткеи мы взяли»
   * (`lead` в `read_window_sources`), а вовсе не «машина, где стоит менеджер»:
   * упади Windows-трекер, верхним хостом стал бы мак.
   *
   * Свой раньше чужого: на машине с менеджером просьба уходит ему, на машине
   * без менеджера — остаётся имя чужой машины для пункта «Open on <host>».
   *
   * Отсутствующий `openSession` читается как «берётся» — то же правило, что у
   * `canFocus`: windows11-manager этого поля не пишет и не должен.
   */
  function openManager(state, configHost) {
    const able = trackerHosts(state).filter(e => e && e.openSession !== false);
    const mine = normHost(configHost);
    return able.find(e => normHost(e.host) === mine) || able[0] || null;
  }
```

и в возврат модуля добавить `mqttBaseFor, openManager`.

- [ ] **Step 4: Прогнать**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add frontend-src/session-windows.js test/session-windows.test.js
git commit -m "$(cat <<'EOF'
feat(picker): адрес просьбы берётся у машины окна, менеджер — у списка трекеров

Верхнее поле windowHost называет машину с хоткеями, а не машину с менеджером:
упади Windows-трекер, пикер на маке назначил бы менеджером мак.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Транспорт спрашивает про менеджера, а не про верхнее поле

**Repo:** `~/projects/js/ccfzf-picker`

**Files:**
- Modify: `frontend-src/open-transport.js`
- Test: `test/open-transport.test.js`

**Interfaces:**
- Consumes: ответ `openManager(state, configHost)` из задачи 9 — объект `{host, mqttBase, …}` либо `null`.
- Produces: четыре функции меняют первый «состояние»-аргумент на `manager`:
  - `chooseOpenTransport(manager, configHost, mqttConfigured)`
  - `canOpenRemote(row, manager, configHost, mqttConfigured)`
  - `chooseEnterAction(row, strategy, manager, configHost, mqttConfigured)`
  - `chooseProjectOpenAction(row, manager, configHost, mqttConfigured)`
  - `SESSION_ID_ROW_KINDS`, `trackerKnowsSession`, `rowProjectDir` не меняются

**Контекст:** разбор списка трекеров живёт в одном месте (`session-windows.js`) намеренно. Заведись он и здесь — два разбора разошлись бы на первой же правке; это то же правило, по которому у проектных хоткеев нет своего признака свежести.

- [ ] **Step 1: Переписать тесты под новую форму**

В `test/open-transport.test.js` заменить во всех существующих тестах передачу состояния на передачу менеджера: там, где сейчас `{ windowHost: 'windows-box' }`, теперь `{ host: 'windows-box' }`; там, где `{}` (трекера нет) — `null`. Дописать новые:

```js
test('менеджер на нашей машине — просьба уходит ему', () => {
  assert.equal(
    OpenTransport.chooseOpenTransport({ host: 'windows-box' }, 'windows-box', true),
    'manager',
  );
});

test('менеджера нет вовсе — открываем сами', () => {
  // На маке менеджера не существует, и просьба уехала бы открывать окно на
  // чужой машине.
  assert.equal(OpenTransport.chooseOpenTransport(null, 'mac-host', true), 'local');
});

test('менеджер на соседней машине — открываем сами', () => {
  assert.equal(
    OpenTransport.chooseOpenTransport({ host: 'windows-box' }, 'mac-host', true),
    'local',
  );
});

test('без брокера остаётся местная дорога', () => {
  // Иначе Enter вёл бы в ошибку там, где раньше открывал терминал, — на
  // машине, которой MQTT никогда не был нужен.
  assert.equal(
    OpenTransport.chooseOpenTransport({ host: 'windows-box' }, 'windows-box', false),
    'local',
  );
});

test('пункт «Open on <host>» предлагается только при чужом менеджере', () => {
  const row = { kind: 'interactive', id: 'abc' };
  assert.equal(OpenTransport.canOpenRemote(row, { host: 'windows-box' }, 'mac-host', true), true);
  assert.equal(OpenTransport.canOpenRemote(row, { host: 'windows-box' }, 'windows-box', true), false);
  assert.equal(OpenTransport.canOpenRemote(row, null, 'mac-host', true), false);
  assert.equal(OpenTransport.canOpenRemote(row, { host: 'windows-box' }, 'mac-host', false), false);
});
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `npm test`
Expected: FAIL — старая реализация читает `state.windowHost` у объекта, где такого поля нет.

- [ ] **Step 3: Реализовать**

В `frontend-src/open-transport.js` заменить `chooseOpenTransport`:

```js
  /**
   * Кто открывает сессию: 'manager' | 'local'.
   *
   * (прежний doc-комментарий сохранить целиком — он объясняет, почему на
   * машине трекера просьба уходит менеджеру, почему без брокера остаётся
   * местная дорога и почему `windowPid` здесь не смотрят.)
   *
   * Спрашивает не состояние, а готовый ответ `openManager` из
   * `session-windows.js`: разбор списка трекеров живёт там и только там.
   * Заведись он и здесь — два разбора разошлись бы на первой же правке.
   * Раньше здесь стояло верхнее поле `windowHost`, но с несколькими трекерами
   * оно называет машину с проектными хоткеями, а не машину с менеджером.
   */
  function chooseOpenTransport(manager, configHost, mqttConfigured) {
    const host = normHost((manager || {}).host);
    const mine = normHost(configHost);
    return host && host === mine && mqttConfigured ? 'manager' : 'local';
  }
```

`canOpenRemote`:

```js
  function canOpenRemote(row, manager, configHost, mqttConfigured) {
    if (!row || !SESSION_ID_ROW_KINDS.has(row.kind)) return false;
    if (!manager || !manager.host) return false;
    if (!mqttConfigured) return false;
    return chooseOpenTransport(manager, configHost, mqttConfigured) === 'local';
  }
```

В `chooseEnterAction` и `chooseProjectOpenAction` заменить параметр `state` на `manager` и передать его дальше в `chooseOpenTransport`. Тела в остальном не трогать: порядок проверок в `chooseEnterAction` оплачен починенными поломками, и его doc-комментарий остаётся как есть.

- [ ] **Step 4: Прогнать**

Run: `npm test`
Expected: FAIL — `sessions.html` ещё зовёт эти функции по-старому, но её тесты этого не видят; падать должны только те тесты, которые не поправлены в шаге 1. Если падает что-то ещё — читать и чинить, это регрессия.

- [ ] **Step 5: Прогнать ещё раз, чисто**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Коммит**

```bash
git add frontend-src/open-transport.js test/open-transport.test.js
git commit -m "$(cat <<'EOF'
refactor(picker): транспорт спрашивает про менеджера, а не про верхнее поле

Разбор списка трекеров остаётся в session-windows.js: заведись он и здесь,
два разбора разошлись бы на первой же правке.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Команды пикера принимают базу

**Repo:** `~/projects/js/ccfzf-picker`

**Files:**
- Modify: `src-tauri/src/mqtt.rs`
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Produces:
  - `pub fn resolve_base(broker: &Broker, asked: &str) -> String` в `mqtt.rs`
  - `focus`, `unread`, `open`, `open_project`, `open_new`, `restore` принимают вторым аргументом `base: &str` (уже разрешённую базу)
  - команды Tauri `focus_window_mqtt`, `unread_session_mqtt`, `open_session_mqtt`, `open_project_mqtt`, `new_session_mqtt`, `restore_snapshot_mqtt` принимают дополнительный аргумент `base: Option<String>`

**Контекст:** база приезжает из фронтенда, то есть в конечном счёте из файла на чужой машине. Просеивается тем же способом, что `remoteDir` в `deliver.rs` у трекера: кавычить было бы половиной защиты. `#` и `+` — подстановочные знаки MQTT: публикация по такому топику ушла бы не туда, где её ждут.

- [ ] **Step 1: Написать падающие тесты в `src-tauri/src/mqtt.rs`**

В `mod tests` этого файла дописать:

```rust
    #[test]
    fn an_asked_base_wins_over_the_configured_one() {
        // Трекеров несколько, у каждого свой топик. Своя база из конфига
        // отвечает только за ту машину, где пикер настраивали руками.
        let b = broker("home/room/pc");
        assert_eq!(resolve_base(&b, "home/room/mac/windows"), "home/room/mac/windows");
    }

    #[test]
    fn no_asked_base_falls_back_to_the_config() {
        // Старый трекер и старый агрегатор адреса не называют. Пикер обязан
        // вести себя как прежде, а не молчать.
        let b = broker("home/room/pc");
        assert_eq!(resolve_base(&b, ""), "home/room/pc/windows");
        assert_eq!(resolve_base(&b, "   "), "home/room/pc/windows");
    }

    #[test]
    fn wildcards_and_junk_fall_back_to_the_config() {
        // `#` и `+` — подстановочные знаки MQTT: публикация по такому топику
        // ушла бы мимо всех, кто её ждёт. Строка приезжает из файла на чужой
        // машине, и доверять ей нечего.
        let b = broker("home/room/pc");
        assert_eq!(resolve_base(&b, "home/#"), "home/room/pc/windows");
        assert_eq!(resolve_base(&b, "home/+/windows"), "home/room/pc/windows");
        assert_eq!(resolve_base(&b, "/room/pc"), "home/room/pc/windows");
        assert_eq!(resolve_base(&b, "home//room"), "home/room/pc/windows");
        assert_eq!(resolve_base(&b, "home/room/$(whoami)"), "home/room/pc/windows");
    }

    #[test]
    fn the_topic_is_built_from_the_resolved_base() {
        let b = broker("home/room/pc");
        assert_eq!(
            topic_of(&resolve_base(&b, "home/room/mac/windows"), FOCUS_TOPIC),
            "home/room/mac/windows/claude-focus"
        );
    }
```

Отдельного помощника `broker(base)` в этом `mod tests` нет — брокер там собирается по месту через `broker_from_config`. Завести его рядом с тестами:

```rust
    fn broker(base: &str) -> super::Broker {
        broker_from_config(&serde_json::json!({ "mqtt": { "host": "broker", "base": base } }))
    }
```

и дописать `resolve_base` в список имён в `use super::{…}` наверху `mod tests`.

**Существующий тест `topics_are_the_ones_the_daemon_listens_to` придётся поправить:** он зовёт `topic_of(&broker, FOCUS_TOPIC)`, а `topic_of` меняет первый параметр на разрешённую базу. Новая форма — `topic_of(&resolve_base(&broker, ""), FOCUS_TOPIC)`, и ожидания в нём остаются прежними: своя база из конфига плюс `/windows` даёт ровно тот топик, что и раньше. Это и есть доказательство, что запасной ход не сдвинул поведение.

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `cd src-tauri && cargo test`
Expected: FAIL — `resolve_base` не объявлена, `topic_of` принимает `&Broker`.

- [ ] **Step 3: Реализовать разрешение базы**

В `src-tauri/src/mqtt.rs` заменить `topic_of` и дописать `resolve_base`:

```rust
/// Полный топик: разрешённая база плюс заданный приёмником хвост.
fn topic_of(base: &str, tail: &str) -> String {
    format!("{base}{tail}")
}

/// Куда публиковать: адрес, названный трекером, либо своя база из конфига.
///
/// Названный адрес приезжает из ответа агрегатора, то есть из файла, который
/// написали на чужой машине. Кавычить такую строку было бы половиной защиты —
/// её и не кавычат: подходит белый список, как у `remoteDir` в трекере.
/// Отдельно про `#` и `+`: это подстановочные знаки MQTT, и публикация по
/// такому топику ушла бы мимо всех, кто её ждёт. Пустой сегмент и ведущая
/// косая — то же самое, только тише.
///
/// Отказ откатывает на базу из конфига, а не роняет просьбу: подъём окна
/// важнее строгости, и старый трекер адреса не называет вовсе.
pub fn resolve_base(broker: &Broker, asked: &str) -> String {
    let fallback = format!("{}/windows", broker.base);
    let s = asked.trim();
    if s.is_empty() {
        return fallback;
    }
    let ok = !s.starts_with('/')
        && !s.ends_with('/')
        && !s.contains("//")
        && s.split('/').all(|seg| {
            !seg.is_empty()
                && seg
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        });
    if ok { s.to_string() } else { fallback }
}
```

**Внимание на форму хвостов.** Сейчас `FOCUS_TOPIC` — это `"/windows/claude-focus"`, то есть «своё» `/windows` спрятано в хвосте. После правки `/windows` уезжает в базу, значит все пять констант укорачиваются:

```rust
const FOCUS_TOPIC: &str = "/claude-focus";
const UNREAD_TOPIC: &str = "/claude-session-unread";
const RESTORE_TOPIC: &str = "/claude-snapshot-restore";
const OPEN_TOPIC: &str = "/claude-session-open";
```

Doc-комментарий в шапке файла (он перечисляет топики целиком) поправить: топики теперь `<база машины>/claude-focus` и так далее, а `<config.base>/windows` — только запасной ход.

- [ ] **Step 4: Пронести базу через публикующие функции**

Каждая из `focus`, `unread`, `open`, `open_project`, `open_new`, `restore` получает вторым параметром `base: &str` и передаёт его в `publish`. Сигнатура `publish` меняется так же: `fn publish(broker: &Broker, base: &str, tail: &str, payload: &str)`, внутри — `topic_of(base, tail)`.

Тела и doc-комментарии в остальном не трогать.

- [ ] **Step 5: Пронести базу через команды в `main.rs`**

Каждая из шести команд получает `base: Option<String>` и разрешает её один раз:

```rust
#[tauri::command]
async fn focus_window_mqtt(id: String, base: Option<String>) -> Result<(), String> {
    // До публикации, а не после: право должно быть на той стороне к моменту,
    // когда там дойдут до подъёма окна.
    allow_any_foreground();
    let broker = configured_broker()?;
    // Адрес называет трекер той машины, где стоит окно; свой из конфига —
    // запасной ход для трекера прежней версии.
    let base = mqtt::resolve_base(&broker, base.unwrap_or_default().trim());
    tauri::async_runtime::spawn_blocking(move || mqtt::focus(&broker, &base, &id))
        .await
        .map_err(|e| format!("focus_window_mqtt task failed: {e}"))?
}
```

Остальные пять — тем же образом. `Option` здесь по той же причине, по какой он у `cwd` в `open_session_mqtt`: непереданный ключ должен значить «адреса не знаем», а не рушить вызов на мосту.

`project_hotkeys.rs` не трогать: он публикует из Rust, состояния не видит и базу берёт из конфига — правку туда пришлось бы тащить вместе с ответом агрегатора, которого у него нет.

- [ ] **Step 6: Прогнать**

Run: `cd src-tauri && cargo test`
Expected: PASS

- [ ] **Step 7: Коммит**

```bash
git add src-tauri/src/mqtt.rs src-tauri/src/main.rs
git commit -m "$(cat <<'EOF'
feat(mqtt): просьба уходит по адресу машины, а не по своей базе

Адрес приезжает из файла на чужой машине, поэтому просеивается белым списком:
`#` и `+` — подстановочные знаки, публикация по ним ушла бы мимо всех.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Страница передаёт адрес

**Repo:** `~/projects/js/ccfzf-picker`

**Files:**
- Modify: `sessions.html`

**Interfaces:**
- Consumes: `SessionWindows.mqttBaseFor`, `SessionWindows.openManager` (задача 9); новая форма `OpenTransport.*` (задача 10); аргумент `base` у команд (задача 11).

**Контекст:** это задача-сшивка. Логики в ней нет — вся она уже написана и покрыта тестами; здесь только вызовы.

- [ ] **Step 1: Завести местного помощника рядом с `trackerIsHere` и `rowCanFocus`**

```js
  /**
   * Трекер, чей менеджер откроет сессию. Ответ на вопрос про машину, а не про
   * строку: у строки проекта окна нет вовсе.
   */
  function openManagerHere() {
    return window.SessionWindows.openManager(lastState, CONFIG.windowHost);
  }

  /** Куда просить о подъёме окна этой строки. Пусто — спросим свой конфиг. */
  function focusBase(row) {
    return window.SessionWindows.mqttBaseFor(row, lastState);
  }

  /** Куда просить об открытии сессии. Пусто — спросим свой конфиг. */
  function managerBase() {
    return (openManagerHere() || {}).mqttBase || '';
  }
```

- [ ] **Step 2: Передать адрес в подъём и в пометку непрочитанным**

В `focusSession` (около строки 1005):

```js
      await invoke('focus_window_mqtt', { id: row.id, base: focusBase(row) });
```

В `markUnread` (около строки 979):

```js
    invoke('unread_session_mqtt', { id: row.id, base: focusBase(row) })
```

Дописать в doc-комментарий `markUnread` абзац:

```
   * Адрес берётся у машины окна, а не у своего конфига: отметку ставит тот
   * трекер, который видел взгляд, а он может стоять на соседней машине.
   * Строка без окна адреса не назовёт — тогда просьба уходит по своей базе,
   * как раньше: слот в windows11-manager переживает закрытие окна, и такую
   * сессию он всё ещё может знать по id.
```

- [ ] **Step 3: Передать менеджера в четыре развилки**

Все четыре вызова `OpenTransport.*` получают `openManagerHere()` вместо `lastState`:

- `chooseEnterAction` (около 1056);
- `canOpenRemote` (около 1245), и там же метка пункта меню становится
  `` label: `Open on ${(openManagerHere() || {}).host}` `` — имя берётся у того, кому просьба и уйдёт, а не у верхнего поля;
- `chooseProjectOpenAction` (около 1361 и 1403).

- [ ] **Step 4: Передать адрес в остальные просьбы**

`open_session_mqtt`, `open_project_mqtt`, `new_session_mqtt` получают `base: managerBase()`. `restore_snapshot_mqtt` — `base: (window.SessionWindows.trackerHere(lastState, CONFIG.windowHost) || {}).mqttBase || ''`: снимки живут у трекера своей машины, и режим снимков уже закрыт этим же вопросом (`trackerIsHere`).

- [ ] **Step 5: Прогнать**

Run: `npm test && cd src-tauri && cargo test`
Expected: PASS оба

Если падает сторож глифов меню или сторож порядка `test/hide-before-request.test.js` — читать и чинить: это регрессия, а не устаревший тест.

- [ ] **Step 6: Коммит**

```bash
git add sessions.html
git commit -m "$(cat <<'EOF'
feat(picker): страница называет адрес машины в каждой просьбе

Подъём и пометка непрочитанным едут по адресу машины окна, открытие — по
адресу менеджера. Имя в пункте «Open on <host>» берётся у того, кому просьба
и уйдёт.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Выкатка, проверка вживую, документация

**Repos:** все три

**Files:**
- Modify: `macos-windows-manager/README.md` — раздел «Правила, за которые уже заплачено»
- Modify: `ccfzf-picker/CLAUDE.md` — раздел «Правила, за которые уже заплачено»

**Контекст:** здесь впервые компилируется macOS-ветка. Ошибки в именах методов `accessibility` и `objc2-app-kit` — ожидаемая часть этой задачи, а не сюрприз: на первом этапе так же не собрался `CFType::from`.

- [ ] **Step 1: Запушить все три репозитория**

Выкатка первым шагом делает `git pull` на целевой машине — выкатывается запушенное, а не то, что в рабочем каталоге.

```bash
cd ~/projects/shell/ccfzf && git push
cd ~/projects/js/macos-windows-manager && git push
cd ~/projects/js/ccfzf-picker && git push
```

- [ ] **Step 2: Дописать блок `mqtt:` в конфиг трекера на маке**

Файл `~/.config/macos-windows-manager/config.yaml` на маке. Ключи: `host`, `port`, `user`, `password`, `base`. База — своя, не совпадающая с базой Windows-менеджера; пример: `home/room/mac/windows`.

Взять адрес и пароль брокера из конфига пикера на этой машине (`~/.config/ccfzf-picker/config.yaml`, блок `mqtt`).

- [ ] **Step 3: Собрать и выкатить на мак**

Run: `cd ~/projects/js/macos-windows-manager && MWM_HOST=<хост мака> ./data/scripts/deploy-mac.sh`
Expected: сборка проходит, подпись проходит, задача перезапускается

Ошибки компиляции macOS-ветки чинить по подсказкам компилятора (порядок проб — в задаче 7, шаг 2), коммитить и выкатывать заново. Помнить про грабли выкатки: одинарных кавычек внутрь `run()` не класть; `;` в удалённой команде не ставить; ждать подписи по результату, а не по часам.

- [ ] **Step 4: Проверить файл окон**

На машине агрегатора:

```bash
python3 -c "import json;o=json.load(open('$HOME/.ccfzf/windows/<имя мака>.json'));print(o['focus'], o['openSession'], o['mqttBase'])"
```

Expected: `True False home/room/mac/windows`

Если `focus` — `False`, соединения нет: смотреть строку в трее и `Console.app`.

- [ ] **Step 5: Проверить ответ агрегатора**

```bash
ccfzf --state | python3 -c "import json,sys;o=json.load(sys.stdin);print(o['windowHosts'])"
```

Expected: две записи, у каждой свои `mqttBase`, `canFocus`, `openSession`

- [ ] **Step 6: Выкатить пикер на Windows и проверить, что он не изменился**

Run: `cd ~/projects/js/ccfzf-picker && ./data/scripts/deploy-win.sh`

Проверить руками: Enter на строке с окном поднимает окно; `^N` заводит сессию; снимки (`^S`) открываются; проектные хоткеи работают; пункт «Open on <host>» на месте.

- [ ] **Step 7: Проверить пикер на маке**

Собрать и запустить пикер на маке (или выкатить, если для мака есть свой скрипт — `data/scripts/deploy-mac.sh` в репозитории пикера). Проверить:

1. Enter на строке с ▣ — окно терминала выходит вперёд, а не открывается второе;
2. «Mark unread» — кружок возвращается и не гаснет следующим опросом;
3. Enter на строке без окна — открывается терминал, как раньше;
4. Enter на строке проекта — терминал, как раньше;
5. подсказки `^S` нет (снимков на маке не бывает).

- [ ] **Step 8: Проверить отказ**

Остановить брокера (или испортить пароль в конфиге трекера на маке и перезапустить задачу). Через полминуты: `focus` в файле окон становится `False`, а Enter на маке снова открывает терминал вместо подъёма. Вернуть настройки.

- [ ] **Step 9: Записать добытое**

В `macos-windows-manager/README.md`, в раздел «Правила, за которые уже заплачено», дописать то, что выяснилось на этой выкатке. Кандидаты (писать только то, что подтвердилось):

- почему подъёма мало без активации приложения;
- почему `focus` объявляется по соединению, а не по сборке;
- что именно не собралось из `accessibility`/`objc2-app-kit` и чем заменено.

В `ccfzf-picker/CLAUDE.md`, в тот же раздел, дописать про адрес просьбы: почему он приезжает от трекера, а не берётся из конфига, и почему `openSession` — отдельное поле, а не вывод из `focus`.

- [ ] **Step 10: Прогнать все тесты в трёх репозиториях**

```bash
cd ~/projects/js/ccfzf-picker && npm test && (cd src-tauri && cargo test)
cd ~/projects/js/macos-windows-manager && cargo test -p mwm-core && cargo test -p macos-windows-manager
cd ~/projects/shell/ccfzf && python3 tests/test_windows_file.py && python3 tests/test_windows_merge.py
```

Expected: всё зелёное

- [ ] **Step 11: Коммит документации**

```bash
cd ~/projects/js/macos-windows-manager
git add README.md
git commit -m "$(cat <<'EOF'
docs: правила, добытые на выкатке подъёма окна

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"

cd ~/projects/js/ccfzf-picker
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: адрес просьбы называет трекер, а не конфиг пикера

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Порядок и зависимости

Задачи 1–5 независимы друг от друга и могут идти в любом порядке. Задача 6 требует 2 и 5. Задача 7 самостоятельна. Задача 8 требует 3, 4, 6, 7. Задачи 9 и 10 независимы, 10 требует формы ответа из 9 только на бумаге. Задача 11 самостоятельна. Задача 12 требует 9, 10 и 11. Задача 13 требует всего.

Пикер после задачи 10 и до задачи 12 не работает: `sessions.html` зовёт функции по-старому. Это ожидаемо и живёт ровно две задачи; выкатывать пикер в этом промежутке нельзя.
