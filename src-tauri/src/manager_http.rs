//! Просьбы к оконному менеджеру — прямым http-запросом.
//!
//! Второй транспорт тех же пяти просьб, что уже уходят публикацией в MQTT
//! (`mqtt.rs`). Пути и тела не наши: их слушает `ROUTES` в
//! `windows11-manager/src/http-server.js`, и разбирает тем же роутером, каким
//! разбирает пришедшее по MQTT. Придумывать рядом свои значило бы заводить
//! приёмник, которого нет.
//!
//! Выбор между транспортами — по наличию адреса, одной попыткой. Ретраев по
//! второму транспорту нет намеренно: таймаут на задумавшемся сервере
//! неотличим от падения, а `claude-session-open` не идемпотентна — повтор
//! открыл бы человеку второй терминал.
//!
//! У этой дороги, в отличие от публикации, **есть ответ**, и отказ доезжает до
//! статуслайна пикера. Тело ответа при этом не разбирается: рассказать
//! человеку, что именно не так, — отдельная задача.
//!
//! Развилку транспорта (звать этот модуль или `mqtt.rs`) заводит следующая
//! задача плана — здесь только модуль и его семь просьб. До той развилки
//! функции ниже не зовёт никто, кроме тестов, отсюда `allow(dead_code)`.

#![allow(dead_code)]

use std::time::Duration;

use crate::mqtt::{
    focus_body, open_new_payload, open_payload, open_project_payload, place_payload,
    restore_payload, Placement,
};

/// Тот же потолок, что у публикации в MQTT: Enter не должен залипать на
/// недоступном менеджере — человек в этот момент ждёт окна.
const TIMEOUT: Duration = Duration::from_secs(5);

/// Хвост топика → путь у приёмника. Общего источника правды у этих пар нет,
/// как нет его и у имён команд; согласие держит сторож
/// `test/manager-routes.test.js`.
pub const ROUTES: [(&str, &str); 5] = [
    ("/claude-focus", "/claude-wt/focus"),
    ("/claude-session-unread", "/claude-wt/session-unread"),
    ("/claude-session-open", "/claude-wt/session-open"),
    ("/claude-snapshot-restore", "/claude-wt/snapshot-restore"),
    ("/claude-place", "/claude-wt/place"),
];

fn route_for(topic_tail: &str) -> Option<&'static str> {
    ROUTES.iter().find(|(t, _)| *t == topic_tail).map(|(_, r)| *r)
}

/// `"host:port"` → пара, либо отказ **до** запроса.
///
/// Кривой адрес, отправленный как есть, выглядел бы у человека как «менеджер
/// не отвечает» и увёл бы расследование к сети вместо файла трекера.
fn parse_endpoint(raw: &str) -> Option<(String, u16)> {
    let s = raw.trim();
    let (host, port) = s.rsplit_once(':')?;
    let host = host.trim();
    let port: u16 = port.trim().parse().ok()?;
    if host.is_empty() || port == 0 {
        return None;
    }
    Some((host.to_string(), port))
}

/// Общий ход всех пяти просьб.
fn post(endpoint: &str, topic_tail: &str, body: String) -> Result<(), String> {
    let (host, port) = parse_endpoint(endpoint)
        .ok_or_else(|| format!("manager address is malformed: {endpoint}"))?;
    let route = route_for(topic_tail)
        .ok_or_else(|| format!("no http route for {topic_tail}"))?;
    let url = format!("http://{host}:{port}{route}");
    let agent = ureq::AgentBuilder::new().timeout(TIMEOUT).build();
    agent
        .post(&url)
        .set("Content-Type", "application/json")
        .send_string(&body)
        .map(|_| ())
        .map_err(|e| format!("manager at {host}:{port} refused {route}: {e}"))
}

/// Попросить о подъёме окна сессии.
pub fn focus(endpoint: &str, id: &str) -> Result<(), String> {
    post(endpoint, "/claude-focus", focus_body(id))
}

/// Вернуть сессию в непрочитанное — у менеджера, а не у себя.
pub fn unread(endpoint: &str, id: &str) -> Result<(), String> {
    post(endpoint, "/claude-session-unread", focus_body(id))
}

/// Попросить открыть сессию на машине менеджера.
pub fn open(
    endpoint: &str,
    id: &str,
    cwd: &str,
    terminal: &str,
    place: Placement,
) -> Result<(), String> {
    post(endpoint, "/claude-session-open", open_payload(id, cwd, terminal, place))
}

/// Попросить открыть проект по каталогу — какую сессию, решит менеджер.
pub fn open_project(
    endpoint: &str,
    cwd: &str,
    terminal: &str,
    place: Placement,
) -> Result<(), String> {
    post(
        endpoint,
        "/claude-session-open",
        open_project_payload(cwd, terminal, place),
    )
}

/// Попросить завести новую сессию в каталоге, не поднимая существующую.
pub fn open_new(
    endpoint: &str,
    cwd: &str,
    name: &str,
    terminal: &str,
    place: Placement,
) -> Result<(), String> {
    post(
        endpoint,
        "/claude-session-open",
        open_new_payload(cwd, name, terminal, place),
    )
}

/// Попросить поднять раскладку снимка — целиком или одну её сессию.
pub fn restore(endpoint: &str, id: &str, session_ids: &[String]) -> Result<(), String> {
    post(endpoint, "/claude-snapshot-restore", restore_payload(id, session_ids))
}

/// Попросить разложить окна на машине менеджера.
pub fn place(endpoint: &str, mode: &str, ids: &[String]) -> Result<(), String> {
    post(endpoint, "/claude-place", place_payload(mode, ids)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Адрес разбирается ровно в том виде, в каком его собрал фронтенд, и
    /// мусор отвергается **до** запроса: попытка по кривому адресу выглядела бы
    /// как «менеджер не отвечает» и увела бы расследование не туда.
    #[test]
    fn endpoint_is_parsed_or_refused() {
        assert_eq!(parse_endpoint("windows-box:9722"), Some(("windows-box".to_string(), 9722)));
        assert_eq!(parse_endpoint(" windows-box:9722 "), Some(("windows-box".to_string(), 9722)));
        assert_eq!(parse_endpoint(""), None);
        assert_eq!(parse_endpoint("windows-box"), None);
        assert_eq!(parse_endpoint("windows-box:0"), None);
        assert_eq!(parse_endpoint("windows-box:abc"), None);
    }

    /// Пути не наши: их слушает уже написанный сервер на той стороне
    /// (`ROUTES` в `windows11-manager/src/http-server.js`). Тела просьб те же,
    /// что у публикации, — приёмник разбирает их одним и тем же роутером.
    #[test]
    fn routes_match_the_receiver() {
        assert_eq!(route_for("/claude-focus"), Some("/claude-wt/focus"));
        assert_eq!(route_for("/claude-session-unread"), Some("/claude-wt/session-unread"));
        assert_eq!(route_for("/claude-session-open"), Some("/claude-wt/session-open"));
        assert_eq!(route_for("/claude-snapshot-restore"), Some("/claude-wt/snapshot-restore"));
        assert_eq!(route_for("/claude-place"), Some("/claude-wt/place"));
        assert_eq!(route_for("/claude-unknown"), None);
    }

    /// Тело собирается тем же кодом, что и для публикации: разойдись они —
    /// одна и та же просьба значила бы разное в зависимости от транспорта, и
    /// поймать это можно было бы только на живой машине.
    #[test]
    fn focus_body_is_the_same_as_the_published_one() {
        assert_eq!(focus_body("aaa"), r#"{"id":"aaa"}"#);
    }
}
