//! Фоновый опрос агрегатора: отпечаток, такт и поток.

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
pub fn poll_once(sources: &[Source], fresh_dump: bool) -> (Option<serde_json::Value>, String) {
    let parts = sources
        .iter()
        .map(|s| (s.clone(), crate::state_source::fetch(s, fresh_dump)))
        .collect();
    combine(parts)
}

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
    settings: Arc<Mutex<(Vec<Source>, bool)>>,
}

fn payload(cache: &Cache) -> serde_json::Value {
    serde_json::json!({
        "state": cache.state.clone(),
        "error": cache.error.clone(),
    })
}

impl Poller {
    /// Поднять поток опроса. Окно на старте скрыто.
    pub fn start(app: tauri::AppHandle, sources: Vec<Source>, background: bool) -> Poller {
        let (tx, rx) = channel::<Signal>();
        let cache = Arc::new(Mutex::new(Cache::default()));
        let settings = Arc::new(Mutex::new((sources, background)));

        let thread_cache = Arc::clone(&cache);
        let thread_settings = Arc::clone(&settings);
        std::thread::spawn(move || {
            let mut visible = false;
            let mut delay = BACKGROUND_MIN;
            let mut prev_fingerprint: Option<String> = None;

            loop {
                let (sources, background) = thread_settings.lock().unwrap().clone();

                // Спрашивать некого — единственная проверка ненастроенности.
                // Раньше их было две, и вторая молчала бы, разойдясь с первой.
                let idle = sources.is_empty() || (!visible && !background);
                if sources.is_empty() {
                    let mut cache = thread_cache.lock().unwrap();
                    // Текст общий на все три места, где он виден человеку
                    // (здесь, sessions.html и settings-form.js), — намеренно
                    // дословно один и тот же: разная формулировка одной и той
                    // же беды читалась бы как две разных.
                    cache.error =
                        "no source: set the host with sessions, or turn on sessions from this machine"
                            .to_string();
                    if visible {
                        let body = payload(&cache);
                        drop(cache);
                        let _ = app.emit("state", body);
                    }
                }
                if !idle {
                    // Всплеск, заставляющий агрегатор переписать дамп немедленно,
                    // приезжает задачей 4 — здесь опрос всегда обычный.
                    let (state, error) = poll_once(&sources, false);
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
                        let body = payload(&cache);
                        drop(cache);
                        let _ = app.emit("state", body);
                    }
                    Ok(Signal::Hidden) => {
                        visible = false;
                        delay = BACKGROUND_MIN;
                    }
                    Ok(Signal::Nudge) => {
                        let cache = thread_cache.lock().unwrap();
                        let body = payload(&cache);
                        drop(cache);
                        let _ = app.emit("state", body);
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
    pub fn set_config(&self, sources: Vec<Source>, background: bool) {
        *self.settings.lock().unwrap() = (sources, background);
        self.signal(Signal::Nudge);
    }

    /// Что известно прямо сейчас — для команды `poll_now`.
    pub fn snapshot(&self) -> serde_json::Value {
        payload(&self.cache.lock().unwrap())
    }
}

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
}
