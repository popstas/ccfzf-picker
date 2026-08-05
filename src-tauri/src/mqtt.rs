//! Второй способ попросить о подъёме окна — публикация в MQTT.
//!
//! Прямой http до трекера есть не отовсюду, а брокер в этой установке слушают
//! обе машины. Топик и формат тела не наши: их уже слушает демон на
//! Windows-машине (`<base>/windows/claude-focus` с `{"id": …}`), и придумывать
//! рядом второй значило бы заводить приёмник, которого нет.
//!
//! Настройки брокера читаются здесь, из того же `config.yaml`, а не приходят
//! из фронтенда: иначе пароль ездил бы через мост в webview на каждое нажатие.

use std::time::{Duration, Instant};

use rumqttc::{Client, ConnectionError, Event, MqttOptions, Packet, QoS, RecvTimeoutError};

/// Потолок на всю операцию: подключиться, опубликовать, дождаться подтверждения.
/// Enter не должен залипать на недоступном брокере — человек в этот момент ждёт
/// окна, и лучше сказать «не вышло», чем молчать.
const TIMEOUT: Duration = Duration::from_secs(5);

/// Хвост топика. `base` из конфига — общий префикс установки; всё, что после
/// него, задано приёмником и меняться отсюда не может.
const FOCUS_TOPIC: &str = "/windows/claude-focus";

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
///
/// Ждём именно `PubAck`, а не просто отправки: без него «опубликовано» значит
/// лишь «сложено в очередь клиента», и брокер, до которого не дотянулись, был
/// бы неотличим от сработавшего.
pub fn focus(broker: &Broker, id: &str) -> Result<(), String> {
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

    let topic = format!("{}{}", broker.base, FOCUS_TOPIC);
    let payload = serde_json::json!({ "id": id }).to_string();

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
    use super::broker_from_config;

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
}
