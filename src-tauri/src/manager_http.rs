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
//! Развилку транспорта (звать этот модуль или `mqtt.rs`) заводит `transport_for`
//! в `main.rs` — она же зовёт все семь просьб ниже по шести командам и
//! хоткею плитки.

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
///
/// Маршрут разрешается раньше адреса — не по важности отказа, а ради теста:
/// отказ по кривому адресу называет в тексте и маршрут, каким шла просьба, а
/// значит опечатка в захардкоженном хвосте у любой из семи публичных функций
/// видна в тексте самого отказа, и ловит её тест без единого похода в сеть
/// (`every_public_request_carries_its_own_route` ниже).
fn post(endpoint: &str, topic_tail: &str, body: String) -> Result<(), String> {
    let route = route_for(topic_tail)
        .ok_or_else(|| format!("no http route for {topic_tail}"))?;
    let (host, port) = parse_endpoint(endpoint)
        .ok_or_else(|| format!("manager address is malformed: {endpoint} (route {route})"))?;
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
    place: Placement,
) -> Result<(), String> {
    post(endpoint, "/claude-session-open", open_payload(id, cwd, place))
}

/// Попросить открыть проект по каталогу — какую сессию, решит менеджер.
pub fn open_project(
    endpoint: &str,
    cwd: &str,
    place: Placement,
) -> Result<(), String> {
    post(
        endpoint,
        "/claude-session-open",
        open_project_payload(cwd, place),
    )
}

/// Попросить завести новую сессию в каталоге, не поднимая существующую.
pub fn open_new(
    endpoint: &str,
    cwd: &str,
    name: &str,
    place: Placement,
) -> Result<(), String> {
    post(
        endpoint,
        "/claude-session-open",
        open_new_payload(cwd, name, place),
    )
}

/// Попросить поднять раскладку снимка — целиком или одну её сессию.
pub fn restore(endpoint: &str, id: &str, session_ids: &[String]) -> Result<(), String> {
    post(endpoint, "/claude-snapshot-restore", restore_payload(id, session_ids))
}

/// Попросить разложить окна на машине менеджера.
pub fn place(endpoint: &str, mode: &str, ids: &[String]) -> Result<(), String> {
    place_body(endpoint, place_payload(mode, ids)?)
}

/// Готовое тело просьбы о раскладке — тем же путём, что у плитки. Им уходит
/// и раскладка группы (`mqtt::group_payload`): приёмник разбирает оба тела
/// одним роутером.
pub fn place_body(endpoint: &str, body: String) -> Result<(), String> {
    post(endpoint, "/claude-place", body)
}

/// Путь вопроса «какой терминал выбран у менеджера».
///
/// Не в `ROUTES`: там пары «хвост топика → путь», а у этого вопроса топика
/// нет — по MQTT ответа не бывает, и спрашивать там некого. Слушает его
/// `ROUTES` в `windows11-manager/src/http-server.js`, сверяет — тот же
/// `test/manager-routes.test.js`.
pub const TERMINAL_ROUTE: &str = "/claude-wt/terminal";

/// Потолок вопроса о терминале — секунда, а не общие пять.
///
/// Вопрос стоит перед каждым запуском терминала, и менеджер у него на своей же
/// машине: ответ приходит за миллисекунды, а молчание дольше секунды значит,
/// что менеджера нет, — тогда терминал берётся из пресета, и ждать его пять
/// секунд перед открытием окна незачем.
const TERMINAL_TIMEOUT: Duration = Duration::from_secs(1);

/// Терминал, выбранный у менеджера, в форме пресета пикера.
///
/// Поля названы как у `terminal` в `config.yaml` (`file`, `args`), а не как в
/// ответе менеджера (`command`): страница подставляет это значение на место
/// пресета, и вторая форма того же самого потребовала бы перевода в каждом
/// месте, где терминал встречается с командой.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct ManagerTerminal {
    /// Имя записи в `claudeWt.terminals` (`wt`, `wezterm`, своё) — для подписи
    /// в настройках, а не для запуска.
    pub name: String,
    pub file: String,
    pub args: Vec<String>,
}

/// Разобрать ответ менеджера. `None` — «терминала не назвал».
///
/// Разбор строгий: любое отступление от формы — пресет, а не догадка. Менеджер
/// отвечает без `command`, когда терминала у него нет (старый конфиг с
/// `claudeWt.launch.command`), и это законный ответ, а не поломка. А
/// полузапись вроде «команда без аргументов» запустила бы WezTerm без
/// `start --`, и тот принял бы `ssh` за свою подкоманду — молча, окно просто
/// не открылось бы.
pub fn parse_terminal(body: &str) -> Option<ManagerTerminal> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let name = v.get("name")?.as_str()?.trim();
    let file = v.get("command")?.as_str()?.trim();
    if name.is_empty() || file.is_empty() {
        return None;
    }
    let args = v
        .get("args")?
        .as_array()?
        .iter()
        .map(|a| a.as_str().map(str::to_string))
        .collect::<Option<Vec<_>>>()?;
    Some(ManagerTerminal { name: name.to_string(), file: file.to_string(), args })
}

/// Спросить менеджер своей машины, какой терминал у него выбран.
///
/// `Ok(None)` — менеджер ответил, но терминала не назвал. `Err` — не ответил
/// вовсе; зовущий в обоих случаях берёт пресет, а разница нужна логу.
///
/// Кеша нет намеренно: переключатель терминала должен остаться один —
/// `claudeWt.terminal`, — и правка там обязана менять следующее же окно, а не
/// окно после истечения срока кеша.
pub fn terminal(endpoint: &str) -> Result<Option<ManagerTerminal>, String> {
    let (host, port) = parse_endpoint(endpoint)
        .ok_or_else(|| format!("manager address is malformed: {endpoint} (route {TERMINAL_ROUTE})"))?;
    let url = format!("http://{host}:{port}{TERMINAL_ROUTE}");
    let agent = ureq::AgentBuilder::new().timeout(TERMINAL_TIMEOUT).build();
    let body = agent
        .post(&url)
        .set("Content-Type", "application/json")
        .send_string("{}")
        .map_err(|e| format!("manager at {host}:{port} refused {TERMINAL_ROUTE}: {e}"))?
        .into_string()
        .map_err(|e| format!("manager at {host}:{port} sent an unreadable {TERMINAL_ROUTE} reply: {e}"))?;
    Ok(parse_terminal(&body))
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

    /// Оба предполётных отказа `post()` — до всякого ввода-вывода, и текст у
    /// них человеческий: это то, что увидит статуслайн пикера.
    #[test]
    fn post_refuses_a_malformed_address_before_any_network() {
        assert_eq!(
            post("windows-box", "/claude-focus", "{}".to_string()),
            Err("manager address is malformed: windows-box (route /claude-wt/focus)".to_string()),
        );
    }

    #[test]
    fn post_refuses_an_unknown_route_before_any_network() {
        assert_eq!(
            post("windows-box:9722", "/claude-unknown", "{}".to_string()),
            Err("no http route for /claude-unknown".to_string()),
        );
    }

    /// Опечатка в захардкоженном хвосте у любой из семи публичных функций
    /// ловится здесь без похода в сеть: адрес нарочно кривой, `post()`
    /// отказывает раньше, чем дошёл бы до сети, а маршрут, которым шла
    /// просьба, виден в тексте самого отказа (см. комментарий у `post`).
    /// Разошлись бы хвост функции и хвост в `ROUTES` — текст назвал бы не тот
    /// маршрут, и `assert_eq!` это увидит.
    #[test]
    fn every_public_request_carries_its_own_route() {
        let placement = Placement::default();
        let cases: [(&str, Result<(), String>); 7] = [
            ("/claude-wt/focus", focus("bad", "id")),
            ("/claude-wt/session-unread", unread("bad", "id")),
            ("/claude-wt/session-open", open("bad", "id", "cwd", placement)),
            ("/claude-wt/session-open", open_project("bad", "cwd", placement)),
            ("/claude-wt/session-open", open_new("bad", "cwd", "name", placement)),
            ("/claude-wt/snapshot-restore", restore("bad", "id", &[])),
            ("/claude-wt/place", place("bad", "tile", &[])),
        ];
        for (route, result) in cases {
            let want = format!("manager address is malformed: bad (route {route})");
            assert_eq!(result, Err(want), "маршрут просьбы к {route} разошёлся с текстом отказа");
        }
    }

    /// Ответ менеджера по контракту — терминал в форме пресета пикера.
    #[test]
    fn manager_terminal_is_parsed_into_preset_shape() {
        assert_eq!(
            parse_terminal(r#"{"ok":true,"name":"wezterm","command":"wezterm-gui.exe","args":["start","--"]}"#),
            Some(ManagerTerminal {
                name: "wezterm".into(),
                file: "wezterm-gui.exe".into(),
                args: vec!["start".into(), "--".into()],
            }),
        );
        assert_eq!(
            parse_terminal(r#"{"ok":true,"name":"wt","command":"wt.exe","args":["-w","-1"]}"#)
                .map(|t| t.file),
            Some("wt.exe".to_string()),
        );
    }

    /// Всё, что не по форме, — «терминала не назвал», и зовущий берёт пресет.
    /// Полузапись тут опаснее отказа: WezTerm без `start --` принял бы `ssh`
    /// за свою подкоманду, и окно не открылось бы вовсе.
    #[test]
    fn anything_off_contract_means_no_manager_terminal() {
        for body in [
            r#"{"ok":true}"#,
            r#"{"ok":true,"name":"wezterm","command":"","args":[]}"#,
            r#"{"ok":true,"name":"","command":"wezterm-gui.exe","args":[]}"#,
            r#"{"ok":true,"name":"wezterm","command":"wezterm-gui.exe"}"#,
            r#"{"ok":true,"name":"wezterm","command":"wezterm-gui.exe","args":"start --"}"#,
            r#"{"ok":true,"name":"wezterm","command":"wezterm-gui.exe","args":["start",1]}"#,
            r#"{"ok":true,"name":"wezterm","command":7,"args":[]}"#,
            r#"{"error":"Not found"}"#,
            "not json",
            "",
        ] {
            assert_eq!(parse_terminal(body), None, "ответ {body:?} принят за терминал");
        }
    }

    /// Кривой адрес — отказ до сети, и маршрут назван в тексте, как у просьб.
    #[test]
    fn terminal_question_refuses_a_malformed_address_before_any_network() {
        assert_eq!(
            terminal("bad"),
            Err("manager address is malformed: bad (route /claude-wt/terminal)".to_string()),
        );
    }
}
