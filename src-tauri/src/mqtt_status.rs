//! Связь с брокером — для значка и меню трея.
//!
//! Просьбы пикер публикует короткими соединениями (`mqtt::publish`): поднял,
//! дождался подтверждения, разорвал. Между нажатиями соединения нет, и
//! сломанный доступ — сменённый пароль, просроченный сертификат, брокер за
//! VPN — не виден нигде, пока человек не нажмёт Enter и не получит отказ.
//! Сторож держит своё соединение ровно ради ответа на вопрос «дотягиваемся
//! ли»: ничего не публикует и ни на что не подписан.
//!
//! Конфиг перечитывается на каждом такте: окно настроек пишет `config.yaml`,
//! и соединение по старому паролю показывало бы старый ответ.

use std::time::Duration;

use rumqttc::{Client, ConnectReturnCode, ConnectionError, Event, MqttOptions, Packet, RecvTimeoutError};

use crate::mqtt::{self, Broker};

/// Такт: столько ждём события от брокера, прежде чем перечитать конфиг.
/// Больше пяти секунд, которые rumqttc отводит на подключение, — иначе такт
/// обрывал бы рукопожатие TLS посреди дороги.
const TICK: Duration = Duration::from_secs(10);

/// Пауза после отказа. Без неё неверный пароль превращался бы в непрерывный
/// поток подключений к брокеру — rumqttc переподключается на первом же
/// следующем опросе.
const RETRY: Duration = Duration::from_secs(20);

/// Keep-alive сторожа: брокер, пропавший молча (ноутбук ушёл из сети),
/// заметен не позже чем через полтора таких интервала.
const KEEP_ALIVE: Duration = Duration::from_secs(30);

/// Длинную причину режем: она ложится в пункт меню, а не в лог.
const REASON_MAX: usize = 60;

#[derive(Clone, PartialEq, Debug)]
pub enum Link {
    /// Брокер не настроен: нет хоста или базы. Метки нет — пикеру без брокера
    /// MQTT не нужен вовсе (менеджер достижим по http).
    Off,
    Connecting,
    Connected,
    /// Связи нет, в строке — почему.
    Down(String),
}

impl Link {
    pub fn menu_label(&self) -> String {
        match self {
            Link::Off => "MQTT: not configured".to_string(),
            Link::Connecting => "MQTT: connecting…".to_string(),
            Link::Connected => "MQTT: connected".to_string(),
            Link::Down(reason) => format!("MQTT: disconnected — {reason}"),
        }
    }

    pub fn tooltip(&self) -> String {
        match self {
            Link::Down(reason) => format!("ccfzf-picker — MQTT disconnected: {reason}"),
            _ => "ccfzf-picker".to_string(),
        }
    }

    /// Метка на значке — только у обрыва. «Подключаемся» длится секунды при
    /// старте, и мигать меткой на каждом запуске незачем.
    pub fn badged(&self) -> bool {
        matches!(self, Link::Down(_))
    }
}

/// Ошибка соединения → короткая причина для меню.
pub fn reason(e: &ConnectionError) -> String {
    let text = match e {
        ConnectionError::ConnectionRefused(ConnectReturnCode::NotAuthorized) => {
            "not authorized".to_string()
        }
        ConnectionError::ConnectionRefused(ConnectReturnCode::BadUserNamePassword) => {
            "bad user name or password".to_string()
        }
        ConnectionError::ConnectionRefused(code) => format!("refused ({code:?})"),
        ConnectionError::NetworkTimeout | ConnectionError::FlushTimeout => "timeout".to_string(),
        // Обрыв уже установленного соединения: брокер ушёл, сеть пропала.
        // Внутри — отладочный вид ошибки сокета, в меню он нечитаем.
        ConnectionError::MqttState(_) => "connection lost".to_string(),
        ConnectionError::Io(io) => io.to_string(),
        other => other.to_string(),
    };
    shorten(&text)
}

fn shorten(text: &str) -> String {
    if text.chars().count() <= REASON_MAX {
        return text.to_string();
    }
    let cut: String = text.chars().take(REASON_MAX - 1).collect();
    format!("{}…", cut.trim_end())
}

/// Значок с меткой обрыва: красная точка в правом нижнем углу, обведённая
/// прозрачным кольцом.
///
/// Кольцо — ради мака: там значок шаблонный, система красит его целиком в
/// цвет строки меню, и красный становится тем же цветом, что и глиф. Точку
/// тогда отделяет от глифа только вырезанное вокруг неё кольцо — форма
/// читается и в монохроме. На Windows кольцо отделяет красное от белого глифа.
///
/// Размеры — доли стороны: `favicon.png` 16×16, но картинку могут и
/// перерисовать, и точка, рассчитанная в пикселях, потерялась бы.
pub fn badge(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut out = rgba.to_vec();
    let side = width.min(height) as f32;
    let dot = side * 0.25;
    let ring = dot + (side / 16.0).max(1.0);
    let cx = width as f32 - dot - 0.5;
    let cy = height as f32 - dot - 0.5;
    for y in 0..height {
        for x in 0..width {
            let dx = x as f32 + 0.5 - (cx + 0.5);
            let dy = y as f32 + 0.5 - (cy + 0.5);
            let d = (dx * dx + dy * dy).sqrt();
            let i = ((y * width + x) * 4) as usize;
            if d <= dot {
                out[i..i + 4].copy_from_slice(&[0xE5, 0x39, 0x35, 0xFF]);
            } else if d <= ring {
                out[i + 3] = 0;
            }
        }
    }
    out
}

/// Завести сторожа в своём потоке. `load` читает брокера из конфига,
/// `on_change` зовётся на каждую смену состояния — и только на смену.
pub fn spawn<L, F>(load: L, on_change: F)
where
    L: Fn() -> Broker + Send + 'static,
    F: Fn(&Link) + Send + 'static,
{
    std::thread::spawn(move || {
        let mut shown: Option<Link> = None;
        let mut set = |link: Link| {
            if shown.as_ref() != Some(&link) {
                ccfzf_log!("mqtt link: {}", link.menu_label());
                on_change(&link);
                shown = Some(link);
            }
        };
        loop {
            let broker = load();
            if !broker.is_configured() {
                set(Link::Off);
                std::thread::sleep(TICK);
                continue;
            }
            set(Link::Connecting);
            watch(&broker, &load, &mut set);
        }
    });
}

/// Держать соединение, пока конфиг не поменяется.
fn watch<L>(broker: &Broker, load: &L, set: &mut dyn FnMut(Link))
where
    L: Fn() -> Broker,
{
    let mut options = MqttOptions::new(
        // Свой id, не тот, что у публикации: брокер выбивает второго клиента
        // с тем же id, и сторож рвал бы просьбу посреди дороги.
        format!("ccfzf-picker-status-{}", std::process::id()),
        &broker.host,
        broker.port,
    );
    options.set_keep_alive(KEEP_ALIVE);
    match mqtt::transport(broker) {
        Ok(t) => {
            options.set_transport(t);
        }
        Err(e) => {
            // Корень не читается — это не пройдёт, пока конфиг не поправят.
            set(Link::Down(shorten(&e)));
            wait_for_change(broker, load);
            return;
        }
    }
    if !broker.user.is_empty() {
        options.set_credentials(&broker.user, &broker.password);
    }
    let (client, mut connection) = Client::new(options, 10);
    loop {
        match connection.recv_timeout(TICK) {
            Ok(Ok(Event::Incoming(Packet::ConnAck(_)))) => set(Link::Connected),
            Ok(Ok(_)) | Err(RecvTimeoutError::Timeout) => {}
            Ok(Err(e)) => {
                set(Link::Down(reason(&e)));
                std::thread::sleep(RETRY);
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if load() != *broker {
            break;
        }
    }
    let _ = client.disconnect();
}

fn wait_for_change<L: Fn() -> Broker>(broker: &Broker, load: &L) {
    while load() == *broker {
        std::thread::sleep(TICK);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_broken_link_gets_the_badge() {
        assert!(Link::Down("timeout".into()).badged());
        assert!(!Link::Connected.badged());
        assert!(!Link::Connecting.badged());
        assert!(!Link::Off.badged());
    }

    #[test]
    fn menu_names_the_reason_of_a_broken_link() {
        assert_eq!(
            Link::Down("not authorized".into()).menu_label(),
            "MQTT: disconnected — not authorized"
        );
        assert_eq!(Link::Connected.menu_label(), "MQTT: connected");
        assert_eq!(Link::Off.menu_label(), "MQTT: not configured");
    }

    #[test]
    fn tooltip_speaks_only_about_a_broken_link() {
        assert_eq!(Link::Connected.tooltip(), "ccfzf-picker");
        assert!(Link::Down("timeout".into()).tooltip().contains("timeout"));
    }

    #[test]
    fn refused_connection_reads_as_a_short_word() {
        let e = ConnectionError::ConnectionRefused(ConnectReturnCode::NotAuthorized);
        assert_eq!(reason(&e), "not authorized");
        let e = ConnectionError::ConnectionRefused(ConnectReturnCode::BadUserNamePassword);
        assert_eq!(reason(&e), "bad user name or password");
        assert_eq!(reason(&ConnectionError::NetworkTimeout), "timeout");
    }

    #[test]
    fn dropped_connection_reads_as_lost() {
        let io = std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "closed by peer");
        let e = ConnectionError::MqttState(rumqttc::StateError::Io(io));
        assert_eq!(reason(&e), "connection lost");
    }

    #[test]
    fn long_reason_is_cut_for_the_menu() {
        let io = std::io::Error::new(std::io::ErrorKind::Other, "x".repeat(200));
        let text = reason(&ConnectionError::Io(io));
        assert_eq!(text.chars().count(), REASON_MAX);
        assert!(text.ends_with('…'));
    }

    fn white(side: u32) -> Vec<u8> {
        vec![0xFF; (side * side * 4) as usize]
    }

    fn pixel(rgba: &[u8], side: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * side + x) * 4) as usize;
        [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
    }

    #[test]
    fn badge_puts_an_opaque_red_dot_in_the_corner() {
        let out = badge(&white(16), 16, 16);
        let [r, g, b, a] = pixel(&out, 16, 12, 12);
        assert_eq!(a, 0xFF);
        assert!(r > 0xC0 && g < 0x60 && b < 0x60, "точка в углу не красная");
    }

    #[test]
    fn badge_cuts_a_transparent_ring_around_the_dot() {
        let out = badge(&white(16), 16, 16);
        // Между точкой и глифом — прозрачная полоса: на шаблонном значке мака
        // только она и отделяет метку от глифа.
        assert!((0..16).any(|x| pixel(&out, 16, x, 12)[3] == 0), "кольца нет");
    }

    #[test]
    fn badge_leaves_the_rest_of_the_glyph_alone() {
        let out = badge(&white(16), 16, 16);
        assert_eq!(pixel(&out, 16, 2, 2), [0xFF; 4]);
        assert_eq!(pixel(&out, 16, 8, 2), [0xFF; 4]);
        assert_eq!(out.len(), white(16).len());
    }

    #[test]
    fn badge_scales_with_the_icon() {
        let out = badge(&white(64), 64, 64);
        assert_eq!(pixel(&out, 64, 50, 50)[3], 0xFF);
        assert_eq!(pixel(&out, 64, 50, 50)[1], 0x39);
        assert_eq!(pixel(&out, 64, 10, 10), [0xFF; 4]);
    }
}
