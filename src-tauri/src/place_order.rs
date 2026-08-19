//! Порядок сессий для просьбы о раскладке — посчитанный здесь, а не страницей.
//!
//! Хоткей плитки жмут ровно тогда, когда пикер скрыт, а у скрытого окна
//! WebView2 усыпляет страницу целиком: спросить у неё `placeIds` нельзя, как
//! нельзя спросить и имя терминала (`mqtt::terminal_name`) — та же причина и
//! тот же размен. Пустой список слать тоже нельзя: пустой `ids` и есть
//! сегодняшнее поведение трекеров, ради ухода от которого хоткей и забирается
//! себе — каждый из них раскладывает окна своим порядком.
//!
//! Отсюда вторая копия правил, живущих на странице: `compareSessions`,
//! `recentKey` и `missingLast` из `frontend-src/session-groups.js`, отбор окна
//! своей машины из `frontend-src/session-windows.js`, подстановка полей
//! фонового форка из `frontend-src/session-agent.js`. Прецедент такой копии в
//! проекте один — `terminal_name` в `mqtt.rs`, — и держит его текстовый сторож
//! (`test/terminal-name.test.js`); здесь сторож такой же
//! (`test/place-order.test.js`), и по той же причине: разошедшийся порядок
//! поведением не поймать вовсе — окна просто встанут не так, а ответа у
//! публикации нет.
//!
//! **Три расхождения с `^K` известны и приняты**, потому что чинятся они
//! только переносом всей сборки строк в Rust:
//!
//! - здесь сортируются **сессии ответа**, а на странице — **строки**
//!   (`buildSessionList` даёт карточку на окно). Порядок от этого не
//!   меняется: карточки одной сессии совпадают по всем ключам, кроме машины
//!   окна, а `placeIds` всё равно оставляет от сессии один id. Поэтому
//!   `windowHost` третьим ключом `tieBreak` сюда не перенесён — разводить им
//!   тут нечего;
//! - имя строки на странице — `label` (`title` плюс пометка тёзки), здесь —
//!   голый `title`. Разойдутся они только под сортировкой `name` и только у
//!   сессий-тёзок;
//! - сравнение имён здесь побайтовое, а на странице `localeCompare`. Видно
//!   это опять же только под `name` и только на именах не из ASCII.
//!
//! И одно расхождение по существу: запроса с фильтрами здесь не видно вовсе.
//! `^K` после `/l foo` раскладывает найденное, а хоткей разложит все окна
//! своей машины — на скрытом пикере строки поиска нет и быть не может.

use std::cmp::Ordering;
use std::collections::HashMap;

use serde_json::Value;

/// Те же режимы и то же умолчание, что у `SORT_MODES` в
/// `frontend-src/session-groups.js`. Порядок в списке значения не имеет —
/// `^O` крутит его на странице, сюда приезжает уже выбранное имя.
pub const SORT_MODES: [&str; 5] = ["cost", "oldest", "newest", "recent", "name"];

/// Умолчание сортировки — то же `recent`, что и на странице. Незнакомое имя
/// откатывается на него, а не отбрасывает просьбу: `ui.json` правит и человек.
pub const DEFAULT_SORT: &str = "recent";

pub fn normalize_sort(mode: &str) -> &'static str {
    SORT_MODES
        .iter()
        .copied()
        .find(|m| *m == mode)
        .unwrap_or(DEFAULT_SORT)
}

/// Имя машины — в сравнимый вид: та же формула, что у `normHost` на странице и
/// у `norm_host` в `project_hotkeys.rs`. Одна сторона сравнения приезжает из
/// файла чужой машины, другую набрал человек в `config.yaml`.
fn norm_host(value: Option<&Value>) -> String {
    value
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase()
}

/// pid трекера; ноль значит «трекера не слышно».
///
/// Порядок полей тот же, что у `focusPid`: `pid` у записи окна, `windowPid` у
/// верхних полей старого ответа. Нечисловой `pid` не отменяет `windowPid` —
/// на странице проверка тоже по типу, а не по наличию ключа.
fn focus_pid(src: &Value) -> f64 {
    let pid = match src.get("pid") {
        Some(v) if v.is_number() => Some(v),
        _ => src.get("windowPid"),
    };
    pid.and_then(|v| v.as_f64())
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(0.0)
}

/// Окна строки, дополненные сведениями о машине, — порт `windowsOf`.
///
/// Обе ветви совместимости обязательны и здесь: пикер и агрегатор
/// выкатываются порознь. Старый ответ несёт одно `window`, совсем старый не
/// кладёт в него машину — её называют верхние поля ответа.
fn windows_of(row: &Value, state: &Value) -> Vec<Value> {
    if let Some(arr) = row.get("windows").and_then(|v| v.as_array()) {
        if !arr.is_empty() {
            return arr.clone();
        }
    }
    let Some(w) = row.get("window").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    if !norm_host(w.get("host")).is_empty() {
        return vec![Value::Object(w.clone())];
    }
    let mut o = w.clone();
    o.insert(
        "host".into(),
        state.get("windowHost").cloned().unwrap_or(Value::Null),
    );
    o.insert(
        "pid".into(),
        state.get("windowPid").cloned().unwrap_or(Value::Null),
    );
    o.insert("canFocus".into(), Value::Bool(true));
    vec![Value::Object(o)]
}

/// Стоит ли хоть одно окно строки на нашей машине — те же три условия, что у
/// `focusWindowOf`: машина совпала, трекер умеет поднимать, pid ненулевой.
///
/// На странице карточка одна на окно, и `placeIds` спрашивает про её
/// единственное окно; здесь строка одна на сессию, и вопрос тот же самый
/// задан всему списку её окон. Отбор от этого не меняется: `placeIds`
/// оставляет от сессии один id, каким бы из её окон он ни был добыт.
fn has_own_window(windows: &[Value], mine: &str) -> bool {
    windows.iter().any(|w| {
        w.is_object()
            && w.get("canFocus") != Some(&Value::Bool(false))
            && norm_host(w.get("host")) == mine
            && focus_pid(w) > 0.0
    })
}

/// Кто на самом деле работает в сессии — она сама или её фоновый форк.
///
/// Порт `activeAgent`. Нужен здесь целиком, а не ради одного поля: от него
/// зависят и ключ сортировки (`updated`, `costUsd` берутся у работающего), и
/// список окон — фоновое задание занимает собой терминал, и трекер привязывает
/// окно к **его** id. Без подстановки сессия с работающим форком не попала бы
/// в раскладку вовсе, хотя её окно на экране стоит.
struct Active {
    id: String,
    agent: Value,
    background: bool,
}

fn agent_updated(agent: &Value) -> f64 {
    agent.get("updated").and_then(|v| v.as_f64()).unwrap_or(0.0)
}

fn active_agent(session: &Value, by_id: &HashMap<&str, &Value>) -> Active {
    let own_id = session
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut best = Active {
        id: own_id.clone(),
        agent: session.get("agent").cloned().unwrap_or(Value::Null),
        background: false,
    };
    for child in by_id.values() {
        if child.get("kind").and_then(|v| v.as_str()) != Some("background") {
            continue;
        }
        if child.get("parent").and_then(|v| v.as_str()) != Some(own_id.as_str()) {
            continue;
        }
        let Some(agent) = child.get("agent").filter(|v| v.is_object()) else {
            continue;
        };
        if agent_updated(agent) <= agent_updated(&best.agent) {
            continue;
        }
        best = Active {
            id: child
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            agent: agent.clone(),
            background: true,
        };
    }
    best
}

/// Ключи сортировки одной строки. Считаются один раз на сессию: `sort_by`
/// зовёт сравнение много раз, а лазить за ними в `serde_json` каждый раз —
/// значит платить разбором за каждую пару.
struct Row {
    id: String,
    name: String,
    live: bool,
    cost: f64,
    started: f64,
    last_activity: f64,
}

/// Пустой и нулевой ключ тонут в конце — порт `missingLast`. Ноль здесь и
/// значит «поля нет»: на странице проверка `!aVal` ловит и `0`, и `undefined`
/// одинаково, и разделять их тут было бы расхождением, а не строгостью.
fn missing_last(a: f64, b: f64, asc: bool) -> Ordering {
    let (a_missing, b_missing) = (a == 0.0, b == 0.0);
    match (a_missing, b_missing) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => {
            if asc {
                a.partial_cmp(&b).unwrap_or(Ordering::Equal)
            } else {
                b.partial_cmp(&a).unwrap_or(Ordering::Equal)
            }
        }
    }
}

/// Ключ сортировки `recent` — минута последней активности, а не секунда.
///
/// Причина та же, по которой округляет страница: `updated` двигает каждый
/// вызов инструмента, а их десятки в минуту. `Math.max(1, …)` тоже не для
/// красоты — без нижней границы сессия моложе минуты давала бы ноль и тонула
/// бы к строкам без активности вовсе.
fn recent_key(t: f64) -> f64 {
    if t == 0.0 {
        0.0
    } else {
        (t / 60.0).floor().max(1.0)
    }
}

/// Живость — ключ старше выбранной сортировки, и это не отсебятина, а порт
/// порядка секций. `placeIds` идёт по **нарисованному** списку, а тот разложен
/// по секциям: живые сессии этой машины стоят в `Active sessions`, а
/// остановленная — в `History`, то есть ниже всех живых, какой бы свежей она
/// ни была. Сортируй мы плоско, такая строка встала бы среди живых, и порядок
/// разошёлся бы с тем, что человек видит глазами.
fn compare(a: &Row, b: &Row, mode: &str) -> Ordering {
    if a.live != b.live {
        return if a.live { Ordering::Less } else { Ordering::Greater };
    }
    let primary = match mode {
        "cost" => missing_last(a.cost, b.cost, false),
        "oldest" => missing_last(a.started, b.started, true),
        "newest" => missing_last(a.started, b.started, false),
        "recent" => missing_last(recent_key(a.last_activity), recent_key(b.last_activity), false),
        "name" => a.name.cmp(&b.name),
        _ => Ordering::Equal,
    };
    primary
        .then_with(|| a.name.cmp(&b.name))
        .then_with(|| a.id.cmp(&b.id))
}

fn number_at(src: &Value, key: &str) -> f64 {
    src.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0)
}

/// Затемнение строк, каким его видит раскладка.
///
/// Порт `staleSettings()` со страницы: `enabled` — галка `dim stale` из
/// `ui.json`, а не ключ конфига, потому что конфиг решает только умолчание
/// галки; `session_hours` — порог возраста из конфига. `now_s` передаётся, а
/// не спрашивается у часов внутри: иначе тест про порог зависел бы от минуты,
/// в которую его запустили.
#[derive(Debug, Clone, Copy, Default)]
pub struct Stale {
    pub enabled: bool,
    pub session_hours: f64,
    pub now_s: f64,
}

impl Stale {
    /// Тускла ли строка: свёрнута здесь или молчит дольше порога.
    ///
    /// Порт `StaleItems.isStale`, и порядок проверок тот же: свёрнутость —
    /// факт, а не догадка по времени, и возраст у свёрнутой строки не
    /// спрашивается вовсе. Выключенная галка гасит оба правила: строка,
    /// выпадающая из раскладки вопреки снятой галке, выглядела бы поломкой
    /// хоткея.
    fn hides(&self, minimized: bool, last_activity: f64) -> bool {
        if !self.enabled {
            return false;
        }
        if minimized {
            return true;
        }
        let threshold = self.session_hours * 3600.0;
        threshold.is_finite()
            && threshold > 0.0
            && last_activity > 0.0
            && self.now_s >= last_activity
            && self.now_s - last_activity >= threshold
    }
}

/// Свёрнуто ли окно строки на **этой** машине — порт `minimizedHere`.
///
/// Своих окон бывает больше одного (сессию открывали здесь дважды), и
/// свёрнутой строка считается, когда свёрнуты все: одно развёрнутое окно
/// стоит на экране, и прятать строку не за что. Нет своих окон — `false`:
/// раскладывать нечего, но и прятать нечего тоже.
fn minimized_here(windows: &[Value], mine: &str) -> bool {
    let mut own = windows.iter().filter(|w| norm_host(w.get("host")) == mine).peekable();
    own.peek().is_some() && own.all(|w| w.get("minimized") == Some(&Value::Bool(true)))
}

/// Сессии, чьи окна стоят на этой машине, в порядке выбранной сортировки.
///
/// Пустое имя машины значит «фокуса не бывает» — то же умолчание, что у
/// `canFocus`: пустой `windowHost` в конфиге, и просить раскладку не о чем.
///
/// Тусклые строки в раскладку не идут — тем же правилом, каким пикер гасит их
/// в списке (`stale-items.js`): клетка сетки, отданная свёрнутому или давно
/// молчащему окну, ужимает те, на которые человек смотрит. Согласие двух
/// реализаций держит общая фикстура — см. `test/place-order.test.js`.
pub fn tile_ids(state: &Value, config_host: &str, sort: &str, stale: &Stale) -> Vec<String> {
    let mine = config_host.trim().to_lowercase();
    if mine.is_empty() {
        return Vec::new();
    }
    let empty = Vec::new();
    let list = state
        .get("sessions")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);

    let mut by_id: HashMap<&str, &Value> = HashMap::new();
    for s in list {
        if let Some(id) = s.get("id").and_then(|v| v.as_str()).filter(|i| !i.is_empty()) {
            by_id.insert(id, s);
        }
    }

    let mut rows: Vec<Row> = Vec::new();
    for s in list {
        let Some(id) = s.get("id").and_then(|v| v.as_str()).filter(|i| !i.is_empty()) else {
            continue;
        };
        // Форк своей строки не получает — его поля подставляются в строку
        // родителя. То же правило, что в `buildSessionList`.
        if s.get("kind").and_then(|v| v.as_str()) == Some("background") {
            continue;
        }
        let active = active_agent(s, &by_id);
        let worker = if active.background {
            by_id.get(active.id.as_str()).copied().unwrap_or(s)
        } else {
            s
        };
        // Свои окна главнее окон форка, а не складываются с ними: одно и то же
        // окно, привязанное разными трекерами к разным id, дало бы на одной
        // машине две записи.
        let own = windows_of(s, state);
        let windows = if own.is_empty() {
            windows_of(worker, state)
        } else {
            own
        };
        if !has_own_window(&windows, &mine) {
            continue;
        }
        if stale.hides(minimized_here(&windows, &mine), agent_updated(&active.agent)) {
            continue;
        }
        rows.push(Row {
            id: id.to_string(),
            // Живость складывается, а не подменяется: форк кончился, родитель
            // работает — строка обязана остаться живой. То же в
            // `buildSessionList`.
            live: s.get("live").and_then(|v| v.as_bool()).unwrap_or(false)
                || (active.background
                    && worker.get("live").and_then(|v| v.as_bool()).unwrap_or(false)),
            name: s
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            cost: number_at(&active.agent, "costUsd"),
            // `started` — про саму сессию, а не про того, кто её на время
            // увёл: единственное поле из четырёх, взятое не у активного
            // агента. То же самое и в `session-list.js`.
            started: number_at(
                s.get("agent").unwrap_or(&Value::Null),
                "started",
            ),
            last_activity: agent_updated(&active.agent),
        });
    }

    let mode = normalize_sort(sort);
    rows.sort_by(|a, b| compare(a, b, mode));

    let mut out: Vec<String> = Vec::new();
    for r in rows {
        if !out.contains(&r.id) {
            out.push(r.id);
        }
    }
    out
}

/// Топик машины, на которой стоят раскладываемые окна.
///
/// Адрес называет трекер, а не конфиг пикера, — то же правило, что у подъёма
/// окна: трекеров несколько, у каждого свой префикс. Ищется запись **своей**
/// машины теми же тремя условиями, что и `trackerHere`. Пустая строка значит
/// «спроси свой конфиг»: старый трекер `mqttBase` не называет вовсе, и на
/// такой ветке `resolve_base` откатывается на `<config.base>/windows`.
pub fn tracker_base(state: &Value, config_host: &str) -> String {
    let mine = config_host.trim().to_lowercase();
    if mine.is_empty() {
        return String::new();
    }
    let hosts = match state.get("windowHosts").and_then(|v| v.as_array()) {
        Some(arr) => arr.clone(),
        // Старый агрегатор списка не отдаёт, но одну машину называет верхними
        // полями — из них и собирается список на одного.
        None => match state.get("windowHost") {
            Some(h) if !norm_host(Some(h)).is_empty() => vec![serde_json::json!({
                "host": h.clone(),
                "pid": state.get("windowPid").cloned().unwrap_or(Value::Null),
                "canFocus": true,
            })],
            _ => Vec::new(),
        },
    };
    hosts
        .iter()
        .find(|e| {
            norm_host(e.get("host")) == mine
                && e.get("canFocus") != Some(&Value::Bool(false))
                && focus_pid(e) > 0.0
        })
        .and_then(|e| e.get("mqttBase"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Затемнение выключено: так пикер открывается по умолчанию, и так вёл
    /// себя порядок до появления отсева.
    const OFF: Stale = Stale { enabled: false, session_hours: 0.0, now_s: 0.0 };

    /// Сессия с окном на нашей машине — с полями, которых просит сортировка.
    fn session(id: &str, host: &str, pid: i64, updated: i64) -> Value {
        json!({
            "id": id,
            "title": id,
            "windows": [{ "host": host, "pid": pid }],
            "agent": { "updated": updated },
        })
    }

    fn state(sessions: Vec<Value>) -> Value {
        json!({ "sessions": sessions })
    }

    /// Вход у этого теста общий с JS-сторожем (`test/place-order.test.js`), и
    /// файл один намеренно: две копии фикстуры разошлись бы на первой же
    /// правке, после чего оба теста продолжали бы зеленеть на разных данных —
    /// то есть сторожить перестали бы молча.
    const FIXTURE: &str = include_str!("../../test/fixtures/place-order.json");

    /// Тот же порядок, что даёт страница, — на всех пяти сортировках сразу.
    ///
    /// Проверяются заодно все развилки, которые фикстура и несёт: окно
    /// соседней машины, живая сессия без окна, окно фонового форка и
    /// закончившаяся сессия со свежайшей записью — та обязана стоять
    /// последней, потому что в списке она в History, ниже всех живых.
    #[test]
    fn the_shared_fixture_gives_the_order_the_page_gives() {
        let f: Value = serde_json::from_str(FIXTURE).expect("фикстура не разобралась");
        let state = &f["state"];
        let host = f["configHost"].as_str().unwrap();
        let expected = f["expected"].as_object().expect("в фикстуре нет expected");
        assert!(!expected.is_empty(), "в фикстуре не задано ни одной сортировки");
        for (mode, ids) in expected {
            let want: Vec<String> = ids
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            assert_eq!(tile_ids(state, host, mode, &OFF), want, "сортировка {mode}");
        }
        // Адрес просьбы — из той же фикстуры: топик называет трекер своей
        // машины, а не конфиг пикера.
        assert_eq!(
            tracker_base(state, host),
            f["expectedBase"].as_str().unwrap()
        );
    }

    #[test]
    fn minimized_asks_about_windows_of_this_machine_only() {
        // Свёрнутое окно соседней машины к этому экрану не относится: её окна
        // эта машина не раскладывает вовсе.
        let mine = json!([{ "host": "pc", "pid": 1, "minimized": true }]);
        let theirs = json!([{ "host": "laptop", "pid": 1, "minimized": true }]);
        assert!(minimized_here(mine.as_array().unwrap(), "pc"));
        assert!(!minimized_here(theirs.as_array().unwrap(), "pc"));
    }

    #[test]
    fn one_open_window_here_keeps_the_row_visible() {
        // Сессию открывали на этой машине дважды: одно окно на экране стоит.
        let both = json!([
            { "host": "pc", "pid": 1, "minimized": true },
            { "host": "pc", "pid": 1, "minimized": false },
        ]);
        assert!(!minimized_here(both.as_array().unwrap(), "pc"));
        // Ни окон здесь, ни признака вовсе — прятать нечего. Второе — это
        // агрегатор прежней версии: поля он не пропускает.
        assert!(!minimized_here(&[], "pc"));
        let silent = json!([{ "host": "pc", "pid": 1 }]);
        assert!(!minimized_here(silent.as_array().unwrap(), "pc"));
    }

    #[test]
    fn the_age_threshold_matches_the_page() {
        // Порог — не «больше», а «не меньше»: страница считает так же
        // (`now - lastActivity >= sessionHours * 3600`), и разойдись они,
        // строка на самой границе гасла бы в списке и раскладывалась бы
        // клавишей.
        let stale = Stale { enabled: true, session_hours: 2.0, now_s: 10_000.0 };
        assert!(!stale.hides(false, 10_000.0 - 7_199.0));
        assert!(stale.hides(false, 10_000.0 - 7_200.0));
        // Ноль — «времени нет», а не «бесконечно старая»: то же правило, что
        // на странице.
        assert!(!stale.hides(false, 0.0));
        // Будущее время — тоже неизвестное.
        assert!(!stale.hides(false, 20_000.0));
        // Свёрнутость возраста не спрашивает вовсе.
        assert!(stale.hides(true, 10_000.0));
        // Выключенная галка гасит оба правила.
        let off = Stale { enabled: false, ..stale };
        assert!(!off.hides(true, 0.0));
    }

    /// Тот же отсев тусклых строк, что делает страница, — на том же входе.
    ///
    /// Развилки фикстуры здесь две: у `ccc` окно свёрнуто (факт от трекера, и
    /// возраст у неё свежайший), а `aaa` молчит дольше порога. Обе обязаны
    /// выпасть, и обе — в обеих реализациях: разошедшийся отсев так же тих,
    /// как разошедшийся порядок.
    #[test]
    fn the_shared_fixture_hides_the_same_rows_the_page_hides() {
        let f: Value = serde_json::from_str(FIXTURE).expect("фикстура не разобралась");
        let state = &f["state"];
        let host = f["configHost"].as_str().unwrap();
        let stale = Stale {
            enabled: f["stale"]["enabled"].as_bool().expect("в фикстуре нет stale.enabled"),
            session_hours: f["stale"]["sessionHours"]
                .as_f64()
                .expect("в фикстуре нет stale.sessionHours"),
            now_s: f["nowSec"].as_f64().expect("в фикстуре нет nowSec"),
        };
        let expected = f["expectedStale"].as_object().expect("в фикстуре нет expectedStale");
        assert!(!expected.is_empty(), "в фикстуре не задано ни одной сортировки");
        for (mode, ids) in expected {
            let want: Vec<String> = ids
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            assert_eq!(tile_ids(state, host, mode, &stale), want, "сортировка {mode}");
        }
        // Снятая галка возвращает всех: правило гасится целиком, как и
        // затемнение в списке.
        let off = Stale { enabled: false, ..stale };
        for (mode, ids) in f["expected"].as_object().unwrap() {
            let want: Vec<String> = ids
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            assert_eq!(tile_ids(state, host, mode, &off), want, "сортировка {mode} без галки");
        }
    }

    /// Окна соседней машины трекер этой всё равно не ведёт, а порядок сдвинули
    /// бы: раскладывается только своё.
    #[test]
    fn only_windows_of_this_machine_are_asked_for() {
        let s = state(vec![
            session("mine", "pc", 10, 100),
            session("theirs", "mac", 10, 200),
        ]);
        assert_eq!(tile_ids(&s, "pc", "recent", &OFF), vec!["mine".to_string()]);
    }

    /// Регистр и пробелы в имени машины не значат ничего — одну сторону
    /// сравнения набирает человек в `config.yaml`.
    #[test]
    fn host_comparison_ignores_case_and_spaces() {
        let s = state(vec![session("a", "POPSTAS-PC", 10, 100)]);
        assert_eq!(tile_ids(&s, "  popstas-pc ", "recent", &OFF), vec!["a".to_string()]);
    }

    /// Пустой `windowHost` в конфиге значит «фокуса не бывает»: просить
    /// раскладку не о чем, и пустой ответ здесь честнее выдуманного порядка.
    #[test]
    fn an_empty_config_host_asks_for_nothing() {
        let s = state(vec![session("a", "pc", 10, 100)]);
        assert!(tile_ids(&s, "", "recent", &OFF).is_empty());
    }

    /// Трекер, не умеющий поднимать, и нулевой pid — признаки мёртвой или
    /// чужой записи: те же три условия, что у `focusWindowOf`.
    #[test]
    fn a_dead_tracker_gives_no_windows() {
        let no_focus = json!({
            "id": "a", "title": "a",
            "windows": [{ "host": "pc", "pid": 10, "canFocus": false }],
        });
        let no_pid = json!({
            "id": "b", "title": "b",
            "windows": [{ "host": "pc", "pid": 0 }],
        });
        assert!(tile_ids(&state(vec![no_focus, no_pid]), "pc", "recent", &OFF).is_empty());
    }

    /// Свежайшее первым, а строка без активности — в конце, а не в начале:
    /// иначе нулевой ключ всплыл бы выше всех работающих.
    #[test]
    fn recent_puts_the_freshest_first_and_the_silent_last() {
        let s = state(vec![
            session("old", "pc", 10, 60),
            session("silent", "pc", 10, 0),
            session("fresh", "pc", 10, 6000),
        ]);
        assert_eq!(
            tile_ids(&s, "pc", "recent", &OFF),
            vec!["fresh".to_string(), "old".to_string(), "silent".to_string()]
        );
    }

    /// Округление до минуты — то самое, ради которого ключ и заведён: две
    /// сессии в одной минуте разводит имя, а не то, кто дёрнулся последним.
    #[test]
    fn recent_rounds_to_the_minute() {
        let s = state(vec![
            session("bbb", "pc", 10, 6059),
            session("aaa", "pc", 10, 6000),
        ]);
        assert_eq!(
            tile_ids(&s, "pc", "recent", &OFF),
            vec!["aaa".to_string(), "bbb".to_string()]
        );
    }

    /// Метка моложе минуты не превращается в ноль — иначе сессия, работавшая
    /// полминуты назад, утонула бы к строкам без активности вовсе.
    #[test]
    fn half_a_minute_of_work_is_not_silence() {
        let s = state(vec![
            session("silent", "pc", 10, 0),
            session("young", "pc", 10, 30),
        ]);
        assert_eq!(
            tile_ids(&s, "pc", "recent", &OFF),
            vec!["young".to_string(), "silent".to_string()]
        );
    }

    /// Прочие режимы сортировки берутся из `ui.json` как есть, а незнакомое
    /// имя откатывается на `recent`: файл правит и человек.
    #[test]
    fn the_other_sort_modes_work_and_a_stranger_falls_back() {
        let cheap = json!({
            "id": "cheap", "title": "cheap",
            "windows": [{ "host": "pc", "pid": 10 }],
            "agent": { "updated": 100, "costUsd": 1.0, "started": 50 },
        });
        let pricey = json!({
            "id": "pricey", "title": "pricey",
            "windows": [{ "host": "pc", "pid": 10 }],
            "agent": { "updated": 200, "costUsd": 9.0, "started": 10 },
        });
        let s = state(vec![cheap, pricey]);
        assert_eq!(
            tile_ids(&s, "pc", "cost", &OFF),
            vec!["pricey".to_string(), "cheap".to_string()]
        );
        assert_eq!(
            tile_ids(&s, "pc", "oldest", &OFF),
            vec!["pricey".to_string(), "cheap".to_string()]
        );
        assert_eq!(
            tile_ids(&s, "pc", "newest", &OFF),
            vec!["cheap".to_string(), "pricey".to_string()]
        );
        assert_eq!(
            tile_ids(&s, "pc", "name", &OFF),
            vec!["cheap".to_string(), "pricey".to_string()]
        );
        // Незнакомое имя — тот же ответ, что и у `recent`.
        assert_eq!(tile_ids(&s, "pc", "mosaic", &OFF), tile_ids(&s, "pc", "recent", &OFF));
    }

    /// У фонового форка бывает окно, и достаётся оно строке родителя: сам
    /// форк своей строки не получает. Без этого сессия с работающим форком в
    /// раскладку не попала бы вовсе, хотя её окно стоит на экране.
    #[test]
    fn a_background_fork_lends_its_window_to_the_parent() {
        let parent = json!({ "id": "parent", "title": "parent", "agent": { "updated": 10 } });
        let fork = json!({
            "id": "fork", "title": "fork", "kind": "background", "parent": "parent",
            "windows": [{ "host": "pc", "pid": 10 }],
            "agent": { "updated": 500 },
        });
        assert_eq!(
            tile_ids(&state(vec![parent, fork]), "pc", "recent", &OFF),
            vec!["parent".to_string()]
        );
    }

    /// Свои окна главнее окон форка: одно и то же окно, привязанное разными
    /// трекерами к разным id, дало бы на одной машине две записи.
    #[test]
    fn own_windows_win_over_the_forks() {
        let parent = json!({
            "id": "parent", "title": "parent",
            "windows": [{ "host": "pc", "pid": 10 }],
            "agent": { "updated": 10 },
        });
        let fork = json!({
            "id": "fork", "title": "fork", "kind": "background", "parent": "parent",
            "windows": [{ "host": "mac", "pid": 10 }],
            "agent": { "updated": 500 },
        });
        assert_eq!(
            tile_ids(&state(vec![parent, fork]), "pc", "recent", &OFF),
            vec!["parent".to_string()]
        );
    }

    /// Старый ответ несёт одно `window` без машины — её называют верхние поля.
    /// Пикер новее агрегатора обязан вести себя как прежде, а не гасить
    /// раскладку.
    #[test]
    fn the_old_answer_names_the_machine_by_its_top_fields() {
        let s = json!({
            "windowHost": "pc",
            "windowPid": 42,
            "sessions": [{ "id": "a", "title": "a", "window": { "slot": 1 }, "agent": { "updated": 1 } }],
        });
        assert_eq!(tile_ids(&s, "pc", "recent", &OFF), vec!["a".to_string()]);
    }

    /// Адрес просьбы называет трекер своей машины, а не конфиг пикера:
    /// у каждого трекера свой префикс топиков.
    #[test]
    fn the_topic_comes_from_our_own_tracker() {
        let s = json!({
            "windowHosts": [
                { "host": "mac", "pid": 7, "mqttBase": "home/mac/windows" },
                { "host": "pc", "pid": 9, "mqttBase": "home/pc/windows" },
            ],
            "sessions": [],
        });
        assert_eq!(tracker_base(&s, "pc"), "home/pc/windows");
        assert_eq!(tracker_base(&s, "mac"), "home/mac/windows");
    }

    /// Трекер адреса не назвал — пустая строка, то есть «спроси свой конфиг».
    /// Ронять просьбу нельзя: на старом трекере пикер обязан вести себя как
    /// прежде.
    #[test]
    fn a_tracker_without_an_address_falls_back_to_the_config() {
        let old = json!({ "windowHost": "pc", "windowPid": 42, "sessions": [] });
        assert_eq!(tracker_base(&old, "pc"), "");
        let dead = json!({ "windowHosts": [{ "host": "pc", "pid": 0, "mqttBase": "home/pc/windows" }] });
        assert_eq!(tracker_base(&dead, "pc"), "");
    }
}
