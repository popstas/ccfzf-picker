//! Автокомпакт простаивающих сессий.
//!
//! Кэш промпта живёт час. Сессия, простоявшая почти час с большим
//! контекстом, на следующем ходе заплатит полную цену за весь контекст; сжатая
//! на 58-й минуте — сожмётся по тёплому кэшу и дальше пойдёт с маленьким.
//! Решения Стаса 27.11.2026 (1a, 3a, 4a): таймер живёт в пикере, сессии без
//! окна WezTerm на этой машине пропускаются с причиной в журнале, сжатие тихое
//! и не чаще раза за простой.
//!
//! Решение «кому слать» — чистая функция [`Memory::plan`] над ответом
//! агрегатора; поток [`start`] только зовёт её раз в минуту и исполняет шаги.
//! Отправку делает `claude-wt session compact` на машине агрегатора: он
//! проверяет готовность сессии и поле ввода сам, пикер выбирает только кого.

use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// Срок кэша промпта. После него сжатие уже не дешевле — сессию не трогаем.
pub const CACHE_TTL_SEC: i64 = 3600;
const DEFAULT_THRESHOLD: i64 = 16;
const DEFAULT_AFTER: i64 = 58;
/// Такт таймера. Окно между `after` и концом кэша — две минуты по умолчанию,
/// и минутный такт попадает в него хотя бы раз.
const TICK: std::time::Duration = std::time::Duration::from_secs(60);

/// Ключ `autoCompact` конфига пикера. Те же правила, что у
/// `normalizeAutoCompact` в `frontend-src/config-shape.js`: форма настроек
/// показывает ровно то, по чему живёт таймер.
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub enabled: bool,
    /// Проценты контекста, с которых сессию стоит сжимать.
    pub threshold: i64,
    /// Минуты простоя от последнего ответа с кэш-токенами.
    pub after: i64,
}

/// Целое в границах, иначе умолчание. Строка с числом тоже число: так её
/// понимает и страница (`normalizeCacheWarnMinutes` — тот же приём).
fn whole_in(value: Option<&Value>, lo: i64, hi: i64, default: i64) -> i64 {
    let number = match value {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    match number {
        Some(f) if f.fract() == 0.0 && f >= lo as f64 && f <= hi as f64 => f as i64,
        _ => default,
    }
}

pub fn settings_from(config: &Value) -> Settings {
    let src = config.get("autoCompact");
    let field = |k: &str| src.and_then(|s| s.get(k));
    Settings {
        // Включает только явное `true`: режим шлёт текст в чужие окна, и
        // включаться он должен только по прямой просьбе.
        enabled: field("enabled").and_then(|v| v.as_bool()) == Some(true),
        threshold: whole_in(field("threshold"), 1, 100, DEFAULT_THRESHOLD),
        // Больше 59 не бывает: после часа кэш мёртв, и окно отправки пустое.
        after: whole_in(field("after"), 1, 59, DEFAULT_AFTER),
    }
}

/// Что таймер сделает с сессией на этом такте.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Send {
        source: String,
        id: String,
        cache_at: i64,
        name: String,
        context: i64,
        idle_min: i64,
    },
    Skip {
        id: String,
        name: String,
        reason: String,
    },
}

/// Память «этот простой уже обработан» и «эту строку журнала уже писали».
///
/// Простой опознаётся парой `(id, cacheAt)`: новый ответ агента сдвигает
/// `cacheAt`, и это уже другой простой. Живёт в памяти потока — перезапуск
/// пикера её теряет, но второго `/compact` от этого не будет: после сжатия
/// `cacheAt` у сессии пропадает (граница `compact_boundary` в ccfzf), а до
/// ответа команды простой сверяет её `--min-idle`.
#[derive(Default)]
pub struct Memory {
    done: HashMap<String, i64>,
    noted: HashSet<(String, i64, String)>,
}

/// Имя машины — в сравнимый вид, той же формулой, что `norm_host` в
/// `place_order.rs`: одна сторона из файла трекера, другая набрана руками.
fn norm_host(value: &str) -> String {
    value.trim().to_lowercase()
}

fn number(v: Option<&Value>) -> Option<f64> {
    v.and_then(|v| v.as_f64())
}

fn short(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

fn name_of(session: &Value, id: &str) -> String {
    session
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| short(id).to_string())
}

/// Окна сессии: весь `windows[]`, а без него — одно `window`. Лучшее окно
/// (`window`) может стоять на чужой машине, когда на этой открыто второе.
fn windows_of(session: &Value) -> Vec<&Value> {
    let list: Vec<&Value> = session
        .get("windows")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter(|w| w.is_object()).collect())
        .unwrap_or_default();
    if !list.is_empty() {
        return list;
    }
    session.get("window").filter(|w| w.is_object()).into_iter().collect()
}

/// Причина не слать сессии, которую иначе отправили бы. `None` — слать.
fn skip_reason(session: &Value, window_host: &str) -> Option<String> {
    if session.get("source").and_then(|v| v.as_str()) == Some(crate::state_source::LOCAL_LABEL) {
        return Some("local source".into());
    }
    let mine = norm_host(window_host);
    if mine.is_empty() {
        return Some("windowHost is not set".into());
    }
    let windows = windows_of(session);
    if windows.is_empty() {
        return Some("no window".into());
    }
    let host = |w: &Value| w.get("host").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let app = |w: &Value| w.get("app").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
    let here: Vec<&Value> = windows.iter().copied().filter(|w| norm_host(&host(w)) == mine).collect();
    if here.is_empty() {
        let elsewhere = host(windows[0]);
        return Some(if elsewhere.is_empty() {
            "window has no host".into()
        } else {
            format!("window is on {elsewhere}")
        });
    }
    if here.iter().any(|w| app(w).contains("wezterm")) {
        return None;
    }
    let other = app(here[0]);
    Some(if other.contains("windowsterminal") {
        "Windows Terminal, not WezTerm".into()
    } else if other.is_empty() {
        "terminal unknown, not WezTerm".into()
    } else {
        format!("{other} is not WezTerm")
    })
}

impl Memory {
    /// Шаги на этот такт.
    ///
    /// Сначала тихие фильтры — живость, состояние, контекст, окно времени,
    /// флаг сессии, уже обработанный простой, — и только потом причины
    /// пропуска: иначе журнал раз в час называл бы каждую сессию без окна,
    /// хотя слать ей и так было нечего.
    ///
    /// Пропуск закрывает простой сразу, отправка — нет: её закрывает исход
    /// ([`Memory::settle`]), потому что отказ `min-idle` повторяется на
    /// следующем такте.
    pub fn plan(&mut self, state: &Value, s: &Settings, window_host: &str, now: i64) -> Vec<Step> {
        self.done.retain(|_, cache_at| now - *cache_at < CACHE_TTL_SEC);
        self.noted.retain(|(_, cache_at, _)| now - *cache_at < CACHE_TTL_SEC);
        let mut out = Vec::new();
        let Some(sessions) = state.get("sessions").and_then(|v| v.as_array()) else {
            return out;
        };
        for session in sessions {
            if session.get("live").and_then(|v| v.as_bool()) != Some(true) {
                continue;
            }
            let Some(id) = session.get("id").and_then(|v| v.as_str()) else { continue };
            if !crate::state_source::looks_like_session_id(id) {
                continue;
            }
            let agent = session.get("agent");
            let agent_state = agent.and_then(|a| a.get("state")).and_then(|v| v.as_str());
            // Законченный ход, в том числе непросмотренный. Работающую трогать
            // нельзя, ждущую ответа на вопрос — тем более.
            if !matches!(agent_state, Some("idle") | Some("review")) {
                continue;
            }
            let Some(context) = number(agent.and_then(|a| a.get("contextPct"))) else { continue };
            if context < s.threshold as f64 {
                continue;
            }
            // Часы — `cacheAt`, а не `updated`: idle-уведомление и хук `fail`
            // двигают `updated` без запроса к API (правило «Таймер кеша
            // промпта», docs/rules/list-rows.md).
            let Some(cache_at) = number(agent.and_then(|a| a.get("cacheAt"))).map(|f| f as i64) else {
                continue;
            };
            let idle = now - cache_at;
            if idle < s.after * 60 || idle >= CACHE_TTL_SEC {
                continue;
            }
            if session.get("autoCompact").and_then(|v| v.as_bool()) == Some(false) {
                continue;
            }
            if self.done.get(id) == Some(&cache_at) {
                continue;
            }
            let name = name_of(session, id);
            match skip_reason(session, window_host) {
                Some(reason) => {
                    self.done.insert(id.to_string(), cache_at);
                    out.push(Step::Skip { id: id.to_string(), name, reason });
                }
                None => out.push(Step::Send {
                    source: session.get("source").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    id: id.to_string(),
                    cache_at,
                    name,
                    context: context.round() as i64,
                    idle_min: idle / 60,
                }),
            }
        }
        out
    }

    /// Простой закрыт исходом отправки: больше в него не слать.
    pub fn settle(&mut self, id: &str, cache_at: i64) {
        self.done.insert(id.to_string(), cache_at);
    }

    /// Писали ли уже строку `what` за этот простой: повтор `min-idle` идёт
    /// каждую минуту, а в журнале ему место одно.
    pub fn note_once(&mut self, id: &str, cache_at: i64, what: &str) -> bool {
        self.noted.insert((id.to_string(), cache_at, what.to_string()))
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.done.len() + self.noted.len()
    }
}

pub fn skip_line(name: &str, id: &str, reason: &str) -> String {
    format!("auto-compact: skipped {name} ({}): {reason}", short(id))
}

/// Исход `claude-wt session compact … --json`.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    /// Закрыть ли простой. Не закрывают его только отказы из [`RETRIED`].
    pub settled: bool,
    /// Ключ строки журнала для [`Memory::note_once`].
    pub what: String,
    pub line: String,
}

/// Отказы, после которых простой остаётся открытым и следующий такт пробует
/// снова. `min-idle` — часы команды и пикера разошлись на секунды; `ssh` и
/// `state` — связь до окна или чтение состояния, то есть ничего не отправлено
/// и сессия тут ни при чём. Прочие отказы говорят о самой сессии (поле занято,
/// окна нет, флаг выключен) — повтор в тот же простой ничего не изменит.
const RETRIED: [&str; 3] = ["min-idle", "ssh", "state"];

/// Разобрать ответ команды. JSON — последняя строка, начинающаяся с `{`:
/// интерактивный шелл мог напечатать что-то своё раньше, а stderr команды
/// приклеен следом и с `{` не начинается.
///
/// Коды — конвенция claude-wt: 0 ok, 1 отказ, 2 не найдено, 3 исход
/// неизвестен. Третий закрывает простой так же, как успех: `/compact` мог
/// уже встать в поле, и повтор вслепую удвоил бы его.
pub fn outcome(name: &str, id: &str, code: Option<i32>, output: &str, detail: &str) -> Outcome {
    let json: Option<Value> = output
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with('{'))
        .and_then(|l| serde_json::from_str(l).ok());
    let who = format!("{name} ({})", short(id));
    let field = |k: &str| {
        json.as_ref()
            .and_then(|j| j.get(k))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let (reason, error) = (field("reason"), field("error"));
    let why = [reason.as_str(), error.as_str()]
        .iter()
        .filter(|s| !s.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" ");
    match (code, json.is_some()) {
        (Some(0), _) => Outcome {
            settled: true,
            what: "sent".into(),
            line: format!("auto-compact: sent /compact to {who}{detail}"),
        },
        (Some(3), _) => Outcome {
            settled: true,
            what: "unknown".into(),
            line: format!("auto-compact: {who}: outcome unknown, not retrying: {why}{detail}"),
        },
        (_, true) if RETRIED.contains(&reason.as_str()) => Outcome {
            settled: false,
            what: reason.clone(),
            line: format!("auto-compact: {who} refused: {why}{detail}; will retry until the cache expires"),
        },
        (_, true) => Outcome {
            settled: true,
            what: if reason.is_empty() { "refused".into() } else { reason.clone() },
            line: format!("auto-compact: {who} refused: {why}{detail}"),
        },
        (_, false) => {
            let status = code.map_or("killed by a signal".to_string(), |c| format!("exit {c}"));
            let tail: String = output.trim().lines().last().unwrap_or("").chars().take(200).collect();
            Outcome {
                settled: true,
                what: "no-answer".into(),
                line: format!("auto-compact: {who}: {status}, no answer from claude-wt: {tail}{detail}"),
            }
        }
    }
}

fn now_sec() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Один такт: свежий опрос, шаги, отправки.
fn tick(app: &tauri::AppHandle, memory: &mut Memory) {
    use tauri::Manager;
    // Битый конфиг — молча: о нём и так говорит статуслайн пикера.
    let Ok(config) = crate::load_config() else { return };
    let s = settings_from(&config);
    if !s.enabled {
        return;
    }
    let text = |k: &str| config.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let (window_host, ssh_host) = (text("windowHost"), text("sshHost"));
    let Some(poller) = app.try_state::<crate::poller::Poller>() else { return };
    // Свежий опрос, а не снимок: на скрытом пикере снимок отстаёт до восьми
    // минут, а запас до конца кэша — две.
    let state = poller.fresh_state("auto-compact");
    for step in memory.plan(&state, &s, &window_host, now_sec()) {
        match step {
            Step::Skip { id, name, reason } => ccfzf_log!("{}", skip_line(&name, &id, &reason)),
            Step::Send { source, id, cache_at, name, context, idle_min } => {
                // Отправки идут подряд, и каждая держит поток до десятков
                // секунд: последняя в очереди могла уже выйти за час.
                if now_sec() - cache_at >= CACHE_TTL_SEC {
                    memory.settle(&id, cache_at);
                    ccfzf_log!("{}", skip_line(&name, &id, "the cache expired before its turn"));
                    continue;
                }
                // Строка без `source` — старый ответ одного источника: адрес у
                // него тот же, каким страница шлёт комментарий.
                let label = if source.is_empty() { ssh_host.clone() } else { source };
                let src = crate::state_source::Source::from_label(&label);
                let detail = format!(", context {context}%, idle {idle_min}m");
                match crate::state_source::run_compact(&src, &id, s.after) {
                    Ok((code, output)) => {
                        let o = outcome(&name, &id, code, &output, &detail);
                        if o.settled {
                            memory.settle(&id, cache_at);
                        }
                        if memory.note_once(&id, cache_at, &o.what) {
                            ccfzf_log!("{}", o.line);
                        }
                    }
                    Err(e) => {
                        if memory.note_once(&id, cache_at, "error") {
                            ccfzf_log!("auto-compact: cannot send to {name} ({}): {e}", short(&id));
                        }
                    }
                }
            }
        }
    }
}

/// Поток таймера: раз в минуту, независимо от бэкоффа поллера.
pub fn start(app: tauri::AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("auto-compact".into())
        .spawn(move || {
            let mut memory = Memory::default();
            loop {
                // Спит остаток минуты, а не минуту после работы: опрос и
                // отправки занимают секунды, и при `after: 59` окно в одну
                // минуту дрейфующий такт мог бы перешагнуть целиком.
                let started = std::time::Instant::now();
                tick(&app, &mut memory);
                std::thread::sleep(TICK.saturating_sub(started.elapsed()).max(std::time::Duration::from_secs(1)));
            }
        });
    if let Err(e) = spawned {
        ccfzf_log!("auto-compact: cannot start the timer: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_800_000_000;
    const ID: &str = "b5a54ce3-a022-4c9a-aa91-e306d75bdc76";

    fn on() -> Settings {
        Settings { enabled: true, threshold: 16, after: 58 }
    }

    /// Сессия, которой положено получить `/compact`; `patch` правит поля
    /// верхнего уровня и `agent` поверх умолчаний.
    fn session(patch: Value) -> Value {
        let mut s = json!({
            "id": ID,
            "title": "work",
            "live": true,
            "source": "remote-host",
            "agent": {"state": "idle", "contextPct": 20, "cacheAt": NOW - 58 * 60},
            "window": {"host": "this-host", "app": "wezterm-gui.exe"},
        });
        for (k, v) in patch.as_object().unwrap() {
            if k == "agent" {
                for (ak, av) in v.as_object().unwrap() {
                    s["agent"][ak] = av.clone();
                }
            } else {
                s[k] = v.clone();
            }
        }
        s
    }

    fn plan(sessions: Vec<Value>) -> Vec<Step> {
        Memory::default().plan(&json!({"sessions": sessions}), &on(), "this-host", NOW)
    }

    fn sent(steps: &[Step]) -> bool {
        matches!(steps, [Step::Send { .. }])
    }

    fn skipped(steps: &[Step]) -> Option<String> {
        match steps {
            [Step::Skip { reason, .. }] => Some(reason.clone()),
            _ => None,
        }
    }

    #[test]
    fn podkhodyashchaya_sessiya_poluchaet_compact() {
        assert_eq!(
            plan(vec![session(json!({}))]),
            vec![Step::Send {
                source: "remote-host".into(),
                id: ID.into(),
                cache_at: NOW - 58 * 60,
                name: "work".into(),
                context: 20,
                idle_min: 58,
            }]
        );
    }

    #[test]
    fn review_tozhe_prostoy_a_rabota_i_vopros_net() {
        assert!(sent(&plan(vec![session(json!({"agent": {"state": "review"}}))])));
        for busy in ["active", "question", "waiting"] {
            assert!(plan(vec![session(json!({"agent": {"state": busy}}))]).is_empty(), "{busy} не трогаем");
        }
    }

    #[test]
    fn malo_konteksta_molchit() {
        assert!(plan(vec![session(json!({"agent": {"contextPct": 15}}))]).is_empty());
        assert!(sent(&plan(vec![session(json!({"agent": {"contextPct": 16}}))])), "порог включительно");
    }

    #[test]
    fn granitsy_prostoya() {
        let at = |idle: i64| plan(vec![session(json!({"agent": {"cacheAt": NOW - idle}}))]);
        assert!(at(58 * 60 - 1).is_empty(), "раньше 58-й минуты рано");
        assert!(sent(&at(58 * 60)));
        assert!(sent(&at(3599)));
        assert!(at(3600).is_empty(), "после часа кэш мёртв, сжатие не дешевле");
    }

    #[test]
    fn bez_cache_at_ne_kandidat() {
        // После `/compact` метки нет: граница сжатия закрывает её поиск.
        let mut s = session(json!({}));
        s["agent"].as_object_mut().unwrap().remove("cacheAt");
        assert!(plan(vec![s]).is_empty());
    }

    #[test]
    fn vyklyuchennyy_flag_molchit() {
        assert!(plan(vec![session(json!({"autoCompact": false}))]).is_empty());
        assert!(sent(&plan(vec![session(json!({"autoCompact": true}))])));
    }

    #[test]
    fn ne_zhivaya_molchit() {
        assert!(plan(vec![session(json!({"live": false}))]).is_empty());
    }

    #[test]
    fn odin_raz_za_prostoy() {
        let mut m = Memory::default();
        let state = json!({"sessions": [session(json!({}))]});
        assert!(sent(&m.plan(&state, &on(), "this-host", NOW)));
        // Без исхода простой не закрыт: отказ min-idle повторяется.
        assert!(sent(&m.plan(&state, &on(), "this-host", NOW)));
        m.settle(ID, NOW - 58 * 60);
        assert!(m.plan(&state, &on(), "this-host", NOW).is_empty());
        // Новый ответ агента — новый простой: через полминуты он тоже дожил
        // до 58-й минуты.
        let next = json!({"sessions": [session(json!({"agent": {"cacheAt": NOW - 58 * 60 + 30}}))]});
        assert!(sent(&m.plan(&next, &on(), "this-host", NOW + 30)));
    }

    #[test]
    fn propusk_tozhe_odin_raz() {
        let mut m = Memory::default();
        let state = json!({"sessions": [session(json!({"window": {"host": "this-host", "app": "WindowsTerminal.exe"}}))]});
        assert_eq!(
            skipped(&m.plan(&state, &on(), "this-host", NOW)).as_deref(),
            Some("Windows Terminal, not WezTerm")
        );
        assert!(m.plan(&state, &on(), "this-host", NOW).is_empty());
    }

    #[test]
    fn tikhie_filtry_ran_she_propuska() {
        // Слать было нечего — значит, и называть причину незачем.
        let s = session(json!({"agent": {"contextPct": 5}, "window": {"host": "this-host", "app": "WindowsTerminal.exe"}}));
        assert!(plan(vec![s]).is_empty());
    }

    #[test]
    fn okno_ishchetsya_v_windows() {
        let s = session(json!({
            "window": {"host": "other-host", "app": "wezterm-gui.exe"},
            "windows": [
                {"host": "other-host", "app": "wezterm-gui.exe"},
                {"host": "This-Host", "app": "wezterm-gui.exe"},
            ],
        }));
        assert!(sent(&plan(vec![s])));
    }

    #[test]
    fn prichiny_propuska() {
        assert_eq!(skipped(&plan(vec![session(json!({"window": null}))])).as_deref(), Some("no window"));
        assert_eq!(
            skipped(&plan(vec![session(json!({"window": {"host": "other-host", "app": "wezterm-gui.exe"}}))])).as_deref(),
            Some("window is on other-host")
        );
        assert_eq!(skipped(&plan(vec![session(json!({"source": "local"}))])).as_deref(), Some("local source"));
        let steps = Memory::default().plan(&json!({"sessions": [session(json!({}))]}), &on(), " ", NOW);
        assert_eq!(skipped(&steps).as_deref(), Some("windowHost is not set"));
    }

    #[test]
    fn nastroyki_s_musorom_berut_umolchaniya() {
        assert_eq!(settings_from(&Value::Null), Settings { enabled: false, threshold: 16, after: 58 });
        assert_eq!(
            settings_from(&json!({"autoCompact": {"enabled": "yes", "threshold": "x", "after": 75}})),
            Settings { enabled: false, threshold: 16, after: 58 }
        );
        assert_eq!(
            settings_from(&json!({"autoCompact": {"enabled": true, "threshold": 30, "after": "50"}})),
            Settings { enabled: true, threshold: 30, after: 50 }
        );
        for bad in [json!(0), json!(101), json!(16.5)] {
            assert_eq!(settings_from(&json!({"autoCompact": {"threshold": bad}})).threshold, 16);
        }
        for bad in [json!(0), json!(60), json!(58.5)] {
            assert_eq!(settings_from(&json!({"autoCompact": {"after": bad}})).after, 58);
        }
    }

    #[test]
    fn pamyat_chistitsya() {
        let mut m = Memory::default();
        m.settle(ID, NOW - 58 * 60);
        assert!(m.note_once(ID, NOW - 58 * 60, "sent"));
        assert!(!m.note_once(ID, NOW - 58 * 60, "sent"), "вторая такая же строка не пишется");
        m.plan(&json!({"sessions": []}), &on(), "this-host", NOW + 3600);
        assert_eq!(m.len(), 0);
    }

    #[test]
    fn iskhod_komandy() {
        let o = outcome("work", ID, Some(0), "{\"code\":0,\"result\":\"sent\"}\n", ", context 20%");
        assert!(o.settled);
        assert!(o.line.contains("sent /compact to work (b5a54ce3), context 20%"), "{}", o.line);

        let o = outcome(
            "work",
            ID,
            Some(1),
            "noise\n{\"code\":1,\"result\":\"refused\",\"reason\":\"input-busy\",\"error\":\"field not empty\"}\nclaude-wt: field not empty",
            "",
        );
        assert!(o.settled);
        assert_eq!(o.what, "input-busy");
        assert!(o.line.contains("refused: input-busy field not empty"), "{}", o.line);

        let o = outcome("work", ID, Some(1), "{\"code\":1,\"reason\":\"min-idle\",\"error\":\"idle 57m\"}", "");
        assert!(!o.settled, "min-idle повторяется на следующем такте");
        for retried in ["ssh", "state"] {
            let o = outcome("work", ID, Some(1), &format!("{{\"code\":1,\"reason\":\"{retried}\"}}"), "");
            assert!(!o.settled, "{retried}: ничего не отправлено, повтор на следующем такте");
            assert_eq!(o.what, retried, "строка журнала — раз за простой на причину");
        }
        let o = outcome("work", ID, Some(2), "{\"code\":2,\"reason\":\"no-window\"}", "");
        assert!(o.settled, "окна нет — в этот простой его и не будет");

        let o = outcome("work", ID, Some(3), "{\"code\":3,\"error\":\"ssh dropped\"}", "");
        assert!(o.settled, "исход неизвестен — не повторять");
        assert!(o.line.contains("outcome unknown"));

        let o = outcome("work", ID, Some(255), "", "");
        assert!(o.settled);
        assert!(o.line.contains("exit 255"), "{}", o.line);
    }

    /// Сухой прогон по живому ответу агрегатора, без отправки:
    /// `AUTO_COMPACT_STATE=<дамп ccfzf --state> AUTO_COMPACT_HOST=<windowHost>
    /// cargo test dry_run_from_env -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn dry_run_from_env() {
        let path = std::env::var("AUTO_COMPACT_STATE").expect("AUTO_COMPACT_STATE");
        let host = std::env::var("AUTO_COMPACT_HOST").unwrap_or_default();
        let state: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let now = now_sec();
        let mut wide = on();
        // Окно шире настоящего — увидеть, кто попал бы в ближайший час.
        wide.after = 1;
        for step in Memory::default().plan(&state, &wide, &host, now) {
            println!("{step:?}");
        }
    }
}
