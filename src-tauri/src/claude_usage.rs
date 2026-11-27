//! Usage лимитов Claude для статуслайна: json по адресу `claudeUsageUrl`.
//!
//! Качает Rust, а не страница: у webview пикера CSP, и `fetch` на чужой
//! адрес она не пропустит. Свой поток, раз в минуту, пока пикер жив, — опрос
//! агрегатора тут ни при чём: у скрытого пикера он уходит в бэкофф до восьми
//! минут, а блок обещает минутную точность.
//!
//! Качает системный `curl`, а не `ureq`: тот собран без TLS (см. `Cargo.toml`
//! — rustls стоил бы времени каждой выкатки), а адрес бывает `https://`.
//! `curl` есть на Windows 10+ (`System32\curl.exe`), на маке и в Linux.
//!
//! Форматирует и красит страница (`frontend-src/claude-usage.js`): здесь только
//! «последнее удачное значение» и «последняя попытка не удалась». Ошибка не
//! стирает прошлое значение — блок сереет, но цифры остаются.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

/// Как часто качать. Раз в минуту — решение Стаса (5a).
const TICK: Duration = Duration::from_secs(60);

/// Тишина после толчка, после которой адрес перечитывается: толчки идут на
/// каждое сохранение настроек, а оно — на паузу в наборе.
const SETTLE: Duration = Duration::from_secs(2);

/// Потолок на всю загрузку: поток один, и висящий запрос съел бы следующие такты.
const FETCH_TIMEOUT_SECS: &str = "20";

/// Что знает страница: адрес, последнее удачное значение, удалась ли
/// последняя попытка.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub url: String,
    pub data: Option<Value>,
    pub failed: bool,
}

/// Состояние потока. Отдельным типом — ради тестов: переходы и строки журнала
/// проверяются без сети и без глобальной ячейки.
#[derive(Debug, Default)]
pub struct UsageState {
    snapshot: UsageSnapshot,
    /// Ключ последней ошибки (`error_key`) — чтобы писать в журнал на переходе, а не раз в
    /// минуту: в кольце лога тысяча строк, а ошибка может держаться сутками.
    error: Option<String>,
}

impl UsageState {
    pub fn snapshot(&self) -> &UsageSnapshot {
        &self.snapshot
    }

    /// Адрес из конфига на этом такте. Сменился — прошлые данные не про него:
    /// сбрасываются, иначе блок показывал бы чужой источник до первой удачи.
    /// Возвращает строку журнала, если адрес сменился.
    pub fn on_url(&mut self, url: &str) -> Option<String> {
        if self.snapshot.url == url {
            return None;
        }
        let was = std::mem::take(&mut self.snapshot.url);
        self.snapshot = UsageSnapshot { url: url.to_string(), data: None, failed: false };
        self.error = None;
        match (was.is_empty(), url.is_empty()) {
            (_, true) => Some("claude usage: off (claudeUsageUrl is empty)".into()),
            (true, false) => Some(format!("claude usage: fetching {url} every minute")),
            (false, false) => Some(format!("claude usage: url changed to {url}")),
        }
    }

    /// Итог загрузки. Строка журнала — только на переходе: первая ошибка,
    /// другой текст ошибки, восстановление.
    pub fn on_fetch(&mut self, result: Result<Value, String>) -> Option<String> {
        match result {
            Ok(data) => {
                self.snapshot.data = Some(data);
                self.snapshot.failed = false;
                self.error.take().map(|_| "claude usage: recovered".to_string())
            }
            Err(e) => {
                self.snapshot.failed = true;
                let key = error_key(&e);
                if self.error.as_deref() == Some(key.as_str()) {
                    return None;
                }
                self.error = Some(key);
                Some(format!("claude usage: {e}; keeping the last values"))
            }
        }
    }
}

/// По чему ошибки считаются «той же». У curl — по коду выхода из начала
/// строки (`curl: (28) …`), а не по тексту: в таймауте стоят миллисекунды
/// (`after 1001 milliseconds`, следующим тактом — `after 1000`), и сравнение
/// текстом писало бы строку в журнал каждую минуту, пока сеть лежит. Код 22 —
/// ответ HTTP ≥ 400 — различается по статусу, он в тексте и стабилен: 404 и
/// 500 — разные поломки. Прочее (разбор json, запуск curl) — по тексту.
fn error_key(e: &str) -> String {
    if let Some(rest) = e.strip_prefix("curl: (") {
        if let Some((code, _)) = rest.split_once(')') {
            if code != "22" {
                return format!("curl {code}");
            }
        }
    }
    e.to_string()
}

/// Тело ответа → данные. Объект с `fiveHour` или `weekly`, иначе ошибка:
/// страница-заглушка с кодом 200 или пустое тело не должны затирать прошлое
/// удачное значение.
pub fn parse_usage(body: &str) -> Result<Value, String> {
    let value: Value =
        serde_json::from_str(body).map_err(|e| format!("bad json: {e}"))?;
    let has = |key: &str| value.get(key).is_some_and(Value::is_object);
    if has("fiveHour") || has("weekly") {
        Ok(value)
    } else {
        Err("json has neither fiveHour nor weekly".into())
    }
}

/// `claudeUsageUrl` из сырого конфига; пробелы срезаются, не-строка — пусто.
pub fn config_url(config: &Value) -> String {
    config
        .get("claudeUsageUrl")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// Скачать. `-q` — мимо чужого `.curlrc`, `-f` — код ≥ 400 считается ошибкой,
/// `--proto` — только http(s): адрес приходит из конфига, и `file://` тут не
/// к месту. `--` перед адресом — чтобы он не читался ключом.
fn fetch(url: &str) -> Result<Value, String> {
    let out = crate::proc::hidden_command("curl")
        .args(["-q", "-fsSL", "--max-time", FETCH_TIMEOUT_SECS, "--proto", "=http,https", "--"])
        .arg(url)
        .output()
        .map_err(|e| format!("cannot run curl: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        return Err(if err.is_empty() { format!("curl exited with {}", out.status) } else { err.to_string() });
    }
    parse_usage(&String::from_utf8_lossy(&out.stdout))
}

fn state() -> &'static Mutex<UsageState> {
    static STATE: OnceLock<Mutex<UsageState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(UsageState::default()))
}

fn kick() -> &'static OnceLock<Mutex<Sender<()>>> {
    static KICK: OnceLock<Mutex<Sender<()>>> = OnceLock::new();
    &KICK
}

/// Завести поток. `load_url` читает адрес из конфига на каждом такте — так
/// смена в окне настроек действует без перезапуска; `on_change` получает
/// снимок, когда тот изменился (страница слушает событие).
pub fn spawn<L, F>(load_url: L, on_change: F)
where
    L: Fn() -> String + Send + 'static,
    F: Fn(&UsageSnapshot) + Send + 'static,
{
    let (tx, rx): (Sender<()>, Receiver<()>) = mpsc::channel();
    let _ = kick().set(Mutex::new(tx));
    std::thread::spawn(move || loop {
        let url = load_url();
        let before = lock().snapshot.clone();
        if let Some(line) = lock().on_url(&url) {
            crate::log::write(&line);
        }
        if !url.is_empty() {
            // Загрузка — мимо замка: страница спрашивает `claude_usage` в любой
            // момент, и ждать сети ей незачем.
            let result = fetch(&url);
            if let Some(line) = lock().on_fetch(result) {
                crate::log::write(&line);
            }
        }
        let after = lock().snapshot.clone();
        if after != before {
            on_change(&after);
        }
        match rx.recv_timeout(TICK) {
            // Толчок — дождаться, пока толчки стихнут: окно настроек сохраняет
            // поле через 400 мс после ввода, и без паузы каждый недописанный
            // адрес стал бы запросом и строкой «url changed» в журнале.
            Ok(()) => while rx.recv_timeout(SETTLE).is_ok() {},
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
    });
}

fn lock() -> std::sync::MutexGuard<'static, UsageState> {
    state().lock().unwrap_or_else(|e| e.into_inner())
}

/// То, что поток уже знает, — на гонку страницы с подпиской на событие: первый
/// снимок мог уйти раньше, чем она подписалась.
#[tauri::command]
pub fn claude_usage() -> UsageSnapshot {
    lock().snapshot.clone()
}

/// Толкнуть поток сейчас, не дожидаясь такта. Зовёт Rust рядом с
/// `config-changed` (`apply_config` в main.rs), а не страница: у скрытого окна
/// WebView2 усыпляет страницу, а настройки правят как раз при скрытом пикере.
/// Стёртый адрес обязан убрать блок сразу, новый — показать.
#[tauri::command]
pub fn claude_usage_refresh() {
    if let Some(tx) = kick().get() {
        let _ = tx.lock().unwrap_or_else(|e| e.into_inner()).send(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn usage_json_with_limits_is_accepted() {
        let v = parse_usage(r#"{"fiveHour":{"usedPercent":55},"updated_at":"x"}"#).unwrap();
        assert_eq!(v["fiveHour"]["usedPercent"], 55);
        assert!(parse_usage(r#"{"weekly":{}}"#).is_ok());
    }

    #[test]
    fn page_or_empty_body_is_an_error_not_data() {
        assert!(parse_usage("<html>").is_err());
        assert!(parse_usage("").is_err());
        assert!(parse_usage("{}").is_err());
        assert!(parse_usage(r#"{"fiveHour":3}"#).is_err());
    }

    #[test]
    fn failure_keeps_the_last_values_and_logs_once() {
        let mut s = UsageState::default();
        s.on_url("https://example.com/u.json");
        assert_eq!(s.on_fetch(Ok(json!({"fiveHour":{}}))), None, "первая удача — не восстановление");
        let line = s.on_fetch(Err("timeout".into()));
        assert!(line.unwrap().contains("timeout"));
        assert!(s.snapshot().failed);
        assert_eq!(s.snapshot().data, Some(json!({"fiveHour":{}})), "прошлое значение осталось");
        assert_eq!(s.on_fetch(Err("timeout".into())), None, "та же ошибка — без новой строки");
        assert!(s.on_fetch(Err("404".into())).is_some(), "другая ошибка — новая строка");
        assert_eq!(s.on_fetch(Ok(json!({"weekly":{}}))).as_deref(), Some("claude usage: recovered"));
        assert!(!s.snapshot().failed);
    }

    // Тексты сняты с настоящего curl: таймаут меняет число миллисекунд от
    // такта к такту, и журнал не должен получать строку на каждый.
    #[test]
    fn timeouts_differing_only_in_milliseconds_log_once() {
        let mut s = UsageState::default();
        s.on_url("https://example.com/u.json");
        assert!(s.on_fetch(Err("curl: (28) Connection timed out after 20001 milliseconds".into())).is_some());
        assert_eq!(s.on_fetch(Err("curl: (28) Connection timed out after 20000 milliseconds".into())), None);
        assert!(s.on_fetch(Err("curl: (6) Could not resolve host: example.com".into())).is_some());
        assert!(s.on_fetch(Err("curl: (22) The requested URL returned error: 404".into())).is_some());
        assert!(s.on_fetch(Err("curl: (22) The requested URL returned error: 500".into())).is_some(),
            "другой статус HTTP — другая поломка");
    }

    #[test]
    fn cleared_or_changed_url_drops_the_old_data() {
        let mut s = UsageState::default();
        assert!(s.on_url("https://example.com/a.json").is_some());
        s.on_fetch(Ok(json!({"fiveHour":{}})));
        assert_eq!(s.on_url("https://example.com/a.json"), None);
        assert!(s.on_url("https://example.com/b.json").unwrap().contains("changed"));
        assert_eq!(s.snapshot().data, None);
        s.on_fetch(Ok(json!({"fiveHour":{}})));
        assert!(s.on_url("").unwrap().contains("off"));
        assert_eq!(s.snapshot(), &UsageSnapshot::default());
    }

    #[test]
    fn empty_url_from_the_start_says_nothing() {
        let mut s = UsageState::default();
        assert_eq!(s.on_url(""), None);
    }

    #[test]
    fn config_url_is_trimmed_and_typed() {
        assert_eq!(config_url(&json!({"claudeUsageUrl":"  https://example.com/u.json "})), "https://example.com/u.json");
        assert_eq!(config_url(&json!({"claudeUsageUrl":5})), "");
        assert_eq!(config_url(&Value::Null), "");
    }

    #[test]
    fn snapshot_reaches_the_page_in_camel_case() {
        let v = serde_json::to_value(UsageSnapshot { url: "u".into(), data: None, failed: true }).unwrap();
        assert_eq!(v, json!({"url":"u","data":null,"failed":true}));
    }
}
