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
                let host_missing = host.trim().is_empty();
                let idle = host_missing || (!visible && !background);
                if host_missing {
                    // До A5 то же самое говорила ошибка `fetch_state`, которую
                    // читал фронтенд. После A5 команда для показа списка
                    // больше не зовётся, и без этой строки ненастроенный
                    // пикер молча показывал бы пустой список без единого
                    // слова о причине. Текст держим здесь же литералом:
                    // прежде его отдавал `check_ssh_host`, но Задача 5
                    // перепишет этот цикл целиком под несколько источников,
                    // и заводить под временный текст отдельную функцию смысла
                    // нет.
                    let msg = "sshHost is not set: copy config.example.yml to ~/.config/ccfzf-picker/config.yaml".to_string();
                    let mut cache = thread_cache.lock().unwrap();
                    cache.error = msg;
                    if visible {
                        let body = payload(&cache);
                        drop(cache);
                        let _ = app.emit("state", body);
                    }
                }
                if !idle {
                    let changed = match crate::state_source::fetch(&crate::state_source::Source::Ssh(host.clone())) {
                        Ok(state) => {
                            let fp = fingerprint(&state);
                            let changed = prev_fingerprint.as_deref() != Some(fp.as_str());
                            prev_fingerprint = Some(fp);
                            // Хоткеи вешает Rust, а не страница: у скрытого
                            // окна WebView2 умеет усыплять её целиком, и
                            // клавиши вставали бы только при открытом пикере.
                            crate::project_hotkeys::apply_from_state(&app, &state);
                            let mut cache = thread_cache.lock().unwrap();
                            cache.state = Some(state);
                            cache.error.clear();
                            let body = payload(&cache);
                            drop(cache);
                            let _ = app.emit("state", body);
                            changed
                        }
                        Err(e) => {
                            let mut cache = thread_cache.lock().unwrap();
                            cache.error = e;
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
    pub fn set_config(&self, ssh_host: String, background: bool) {
        *self.settings.lock().unwrap() = (ssh_host, background);
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
}
