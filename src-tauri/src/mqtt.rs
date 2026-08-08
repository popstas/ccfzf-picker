//! Просьбы к оконному трекеру — публикацией в MQTT.
//!
//! Прямой http до трекера есть не отовсюду, а брокер в этой установке слушают
//! обе машины. Топики и формат тела не наши: их уже слушает демон на
//! Windows-машине (`<base>/windows/claude-focus` и
//! `<base>/windows/claude-session-unread`, оба с `{"id": …}`,
//! `<base>/windows/claude-snapshot-restore` с телом `{"id": …}` и
//! необязательным `sessionIds`, и `<base>/windows/claude-session-open` с телом
//! `{"id": …, "action": "terminal"}`), и придумывать рядом свои значило бы
//! заводить приёмник, которого нет.
//!
//! Настройки брокера читаются здесь, из того же `config.yaml`, а не приходят
//! из фронтенда: иначе пароль ездил бы через мост в webview на каждое нажатие.

use std::time::{Duration, Instant};

use rumqttc::{Client, ConnectionError, Event, MqttOptions, Packet, QoS, RecvTimeoutError};

/// Потолок на всю операцию: подключиться, опубликовать, дождаться подтверждения.
/// Enter не должен залипать на недоступном брокере — человек в этот момент ждёт
/// окна, и лучше сказать «не вышло», чем молчать.
const TIMEOUT: Duration = Duration::from_secs(5);

/// Хвосты топиков. `base` из конфига — общий префикс установки; всё, что после
/// него, задано приёмником и меняться отсюда не может.
const FOCUS_TOPIC: &str = "/windows/claude-focus";
const UNREAD_TOPIC: &str = "/windows/claude-session-unread";
const RESTORE_TOPIC: &str = "/windows/claude-snapshot-restore";
/// Просьба к windows11-manager открыть сессию у себя. Отличается от
/// `FOCUS_TOPIC` тем, что окна может не быть вовсе: менеджер тогда поднимет
/// терминал с нужным профилем.
const OPEN_TOPIC: &str = "/windows/claude-session-open";

pub struct Broker {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub base: String,
}

impl Broker {
    /// Брокер настроен, если известны и адрес, и префикс топиков: без второго
    /// публиковать некуда, а угадывать чужой префикс нельзя.
    pub fn is_configured(&self) -> bool {
        !self.host.is_empty() && !self.base.is_empty()
    }
}

/// Разбор блока `mqtt:` из сырого конфига.
///
/// Отсутствующий блок и мусор в нём дают выключенный брокер, а не отказ: пикер
/// без подъёма окна работает, пикер, не открывшийся из-за опечатки в yaml, —
/// нет. То же правило, что и в `config-shape.js`.
pub fn broker_from_config(raw: &serde_json::Value) -> Broker {
    let block = raw.get("mqtt");
    let text = |key: &str| {
        block
            .and_then(|m| m.get(key))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    Broker {
        host: text("host"),
        port: block
            .and_then(|m| m.get("port"))
            .and_then(|v| v.as_u64())
            .and_then(|v| u16::try_from(v).ok())
            .unwrap_or(1883),
        user: text("user"),
        password: text("password"),
        base: text("base").trim_end_matches('/').to_string(),
    }
}

/// Попросить о подъёме окна сессии.
pub fn focus(broker: &Broker, id: &str) -> Result<(), String> {
    publish(broker, FOCUS_TOPIC, &serde_json::json!({ "id": id }).to_string())
}

/// Вернуть сессию в непрочитанное — у трекера, а не у себя.
///
/// Отметка о просмотре живёт в двух местах, и местная здесь не помогает: у
/// сессии с открытым окном отметка трекера почти всегда свежее и на следующем
/// же опросе вернула бы кружок в «просмотрено». Отматывать надо ту, что
/// перебивает, — это делает `markSessionUnread()` на стороне демона.
///
/// Шлётся независимо от того, своя ли это машина: `windowHost` отвечает на
/// вопрос «поднимать ли окно», а отметка о просмотре приезжает в список на
/// любой машине.
pub fn unread(broker: &Broker, id: &str) -> Result<(), String> {
    publish(broker, UNREAD_TOPIC, &serde_json::json!({ "id": id }).to_string())
}

/// Попросить открыть сессию на машине трекера.
///
/// Со своей же машины этого не просят: там Enter поднимает сессию через http
/// у windows11-manager напрямую (`openViaManager` в sessions.html), а этот
/// топик существует ровно для случая, когда трекер — не мы. Поддержано одно
/// действие, `terminal`: остальные (cursor, explorer, pr) осмысленны только
/// там, где стоит человек, а не там, где висит окно.
pub fn open(broker: &Broker, id: &str) -> Result<(), String> {
    publish(
        broker,
        OPEN_TOPIC,
        &serde_json::json!({ "id": id, "action": "terminal" }).to_string(),
    )
}

/// Тело просьбы о восстановлении.
///
/// Без `sessionIds` приёмник поднимает снимок целиком. Пустой массив он
/// прочитал бы как «поднять ноль сессий», поэтому при пустом списке ключа в
/// теле нет вовсе: разница между «все» и «никого» стоит целой раскладки.
fn restore_payload(id: &str, session_ids: &[String]) -> String {
    if session_ids.is_empty() {
        return serde_json::json!({ "id": id }).to_string();
    }
    serde_json::json!({ "id": id, "sessionIds": session_ids }).to_string()
}

/// Попросить поднять раскладку снимка — целиком или одну её сессию.
///
/// Ответа у просьбы нет, как и у фокуса: подписка на той стороне отчитывается
/// в свой лог. Заводить здесь приёмник ради отчёта значило бы держать
/// соединение и ждать — ровно то, чего вся эта дорога избегает. Не сработало
/// — видно на экране, окна там же.
pub fn restore(broker: &Broker, id: &str, session_ids: &[String]) -> Result<(), String> {
    publish(broker, RESTORE_TOPIC, &restore_payload(id, session_ids))
}

/// Полный топик: префикс установки плюс заданный приёмником хвост.
fn topic_of(broker: &Broker, tail: &str) -> String {
    format!("{}{}", broker.base, tail)
}

/// Опубликовать готовое тело в топик установки и дождаться подтверждения.
///
/// Ждём именно `PubAck`, а не просто отправки: без него «опубликовано» значит
/// лишь «сложено в очередь клиента», и брокер, до которого не дотянулись, был
/// бы неотличим от сработавшего.
fn publish(broker: &Broker, tail: &str, payload: &str) -> Result<(), String> {
    let mut options = MqttOptions::new(
        // Идентификатор с pid: два пикера этой установки (на маке и на Windows)
        // с одинаковым id выбивали бы друг друга из брокера.
        format!("ccfzf-picker-{}", std::process::id()),
        &broker.host,
        broker.port,
    );
    options.set_keep_alive(Duration::from_secs(5));
    if !broker.user.is_empty() {
        options.set_credentials(&broker.user, &broker.password);
    }

    let topic = topic_of(broker, tail);

    let (client, mut connection) = Client::new(options, 10);
    client
        .publish(&topic, QoS::AtLeastOnce, false, payload)
        .map_err(|e| format!("mqtt publish to {topic} failed: {e}"))?;

    let deadline = Instant::now() + TIMEOUT;
    let result = loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break Err(format!("mqtt broker {} did not confirm in time", broker.host));
        }
        match connection.recv_timeout(left) {
            Ok(Ok(Event::Incoming(Packet::PubAck(_)))) => break Ok(()),
            // Отказ соединения — единственная ошибка, которую стоит показать
            // целиком: в ней и «не тот пароль», и «машина спит».
            Ok(Err(ConnectionError::Io(e))) => break Err(format!("mqtt: {e}")),
            Ok(Err(e)) => break Err(format!("mqtt: {e}")),
            Err(RecvTimeoutError::Timeout) => {
                break Err(format!("mqtt broker {} did not answer", broker.host))
            }
            Err(RecvTimeoutError::Disconnected) => break Err("mqtt connection closed".to_string()),
            // Всё прочее — служебные пакеты по дороге к подтверждению.
            Ok(Ok(_)) => continue,
        }
    };

    // Разрыв в любом случае: клиент держит поток рантайма, а нам он больше не
    // нужен — следующее нажатие поднимет соединение заново.
    let _ = client.disconnect();
    result
}

#[cfg(test)]
mod tests {
    use super::{
        broker_from_config, restore_payload, topic_of, FOCUS_TOPIC, OPEN_TOPIC, RESTORE_TOPIC,
        UNREAD_TOPIC,
    };

    // Хвосты заданы приёмником — демоном на Windows-машине. Опечатка здесь
    // ничего не ломает на глаз: публикация проходит, PubAck приходит, а окно не
    // поднимается и отметка не отматывается, потому что никто не слушает.
    #[test]
    fn topics_are_the_ones_the_daemon_listens_to() {
        let broker = broker_from_config(&serde_json::json!({
            "mqtt": { "host": "broker", "base": "home/room/pc/" }
        }));
        assert_eq!(topic_of(&broker, FOCUS_TOPIC), "home/room/pc/windows/claude-focus");
        assert_eq!(
            topic_of(&broker, UNREAD_TOPIC),
            "home/room/pc/windows/claude-session-unread"
        );
    }

    #[test]
    fn missing_block_disables_the_broker() {
        let broker = broker_from_config(&serde_json::json!({}));
        assert!(!broker.is_configured());
        assert_eq!(broker.port, 1883);
    }

    #[test]
    fn host_without_base_is_not_enough() {
        // Публиковать было бы некуда: хвост топика наш, а префикс — чужой.
        let broker = broker_from_config(&serde_json::json!({ "mqtt": { "host": "broker" } }));
        assert!(!broker.is_configured());
    }

    #[test]
    fn trailing_slash_in_base_does_not_double() {
        let broker = broker_from_config(&serde_json::json!({
            "mqtt": { "host": "broker", "base": "home/room/pc/" }
        }));
        assert!(broker.is_configured());
        assert_eq!(broker.base, "home/room/pc");
    }

    #[test]
    fn junk_values_fall_back_to_defaults() {
        let broker = broker_from_config(&serde_json::json!({
            "mqtt": { "host": 42, "port": "хост", "base": "home" }
        }));
        assert_eq!(broker.host, "");
        assert_eq!(broker.port, 1883);
        assert!(!broker.is_configured());
    }

    // Хвост задан приёмником — подпиской в windows11-manager (Task 4). Опечатка
    // здесь ничего не ломает на глаз: публикация проходит, PubAck приходит, а
    // сессия не открывается, потому что никто не слушает.
    #[test]
    fn open_topic_is_under_windows() {
        let broker = broker_from_config(&serde_json::json!({
            "mqtt": { "host": "broker", "base": "home/room/pc/" }
        }));
        assert_eq!(
            topic_of(&broker, OPEN_TOPIC),
            "home/room/pc/windows/claude-session-open"
        );
    }

    // Хвост задан приёмником — подпиской в windows-mqtt. Опечатка здесь ничего
    // не ломает на глаз: публикация проходит, PubAck приходит, а раскладка не
    // поднимается, потому что никто не слушает.
    #[test]
    fn restore_topic_is_the_one_the_daemon_listens_to() {
        let broker = broker_from_config(&serde_json::json!({
            "mqtt": { "host": "broker", "base": "home/room/pc/" }
        }));
        assert_eq!(
            topic_of(&broker, RESTORE_TOPIC),
            "home/room/pc/windows/claude-snapshot-restore"
        );
    }

    // Без sessionIds приёмник поднимает снимок целиком. Пустой массив в теле
    // он прочитал бы как «поднять ноль сессий», поэтому ключа быть не должно
    // вовсе — разница между «все» и «никого» стоит целой раскладки.
    #[test]
    fn whole_snapshot_body_carries_no_session_ids() {
        assert_eq!(restore_payload("snap-1", &[]), r#"{"id":"snap-1"}"#);
    }

    #[test]
    fn single_session_body_names_it() {
        let body = restore_payload("snap-1", &["aaa".to_string()]);
        assert_eq!(body, r#"{"id":"snap-1","sessionIds":["aaa"]}"#);
    }
}
