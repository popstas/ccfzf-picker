//! Просьбы к оконному трекеру — публикацией в MQTT.
//!
//! Прямой http до трекера есть не отовсюду, а брокер в этой установке слушают
//! обе машины. Топики и формат тела не наши: их уже слушает демон на
//! Windows-машине (`<база машины>/claude-focus` и
//! `<база машины>/claude-session-unread`, оба с `{"id": …}`,
//! `<база машины>/claude-snapshot-restore` с телом `{"id": …}` и
//! необязательным `sessionIds`, и `<база машины>/claude-session-open` с телом
//! `{"action": "terminal"}`, где необязательны оба опознавателя — `id`
//! известной сессии и `cwd` проекта, а необязательный `cursor` с точкой
//! `{x, y}` просит поставить новое окно на тот экран, где эта точка), и придумывать
//! рядом свои значило бы заводить приёмник, которого нет. Пятая просьба,
//! `<база машины>/claude-place` с телом `{"mode": …, "ids": [...]}`, говорит
//! не о сессии, а обо всём экране: её слушают обе машины — каждая на своей базе,
//! протокол выписан в `docs/window-layouts.md`.
//!
//! Базу называет трекер той машины, куда адресована просьба, — она приезжает
//! в ответе агрегатора. `<config.base>/windows` — только запасной ход: на
//! него откатывается пустая или не прошедшая просеивание строка, то есть
//! трекер прежней версии либо испорченный файл на чужой машине.
//!
//! Настройки брокера читаются здесь, из того же `config.yaml`, а не приходят
//! из фронтенда: иначе пароль ездил бы через мост в webview на каждое нажатие.

use std::time::{Duration, Instant};

use rumqttc::{Client, ConnectionError, Event, MqttOptions, Packet, QoS, RecvTimeoutError};

/// Потолок на всю операцию: подключиться, опубликовать, дождаться подтверждения.
/// Enter не должен залипать на недоступном брокере — человек в этот момент ждёт
/// окна, и лучше сказать «не вышло», чем молчать.
const TIMEOUT: Duration = Duration::from_secs(5);

/// Хвосты топиков. База — адрес конкретной машины, разрешённый `resolve_base`;
/// всё, что после неё, задано приёмником и меняться отсюда не может.
const FOCUS_TOPIC: &str = "/claude-focus";
const UNREAD_TOPIC: &str = "/claude-session-unread";
const RESTORE_TOPIC: &str = "/claude-snapshot-restore";
/// Просьба к windows11-manager открыть сессию у себя. Отличается от
/// `FOCUS_TOPIC` тем, что ни окна, ни самой сессии у трекера может не быть
/// вовсе: по каталогу проекта менеджер поднимет терминал с нужным профилем.
const OPEN_TOPIC: &str = "/claude-session-open";
/// Просьба разложить окна — плиткой или каскадом. Единственная из всех, что
/// говорит не об одной сессии, а обо всём экране машины: расставляет окна сам
/// трекер, а пикер называет лишь порядок.
const PLACE_TOPIC: &str = "/claude-place";

/// Раскладки, которые понимает приёмник (`parse_arrange` в `mwm-core`).
/// Незнакомую он отбрасывает молча — расставить окна наугад хуже, чем не
/// расставить, — поэтому отказ случается на нашей стороне.
const LAYOUT_MODES: [&str; 2] = ["tile", "cascade"];

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

/// «Чем открывают» → семейное имя терминала.
///
/// Имя уезжает в теле просьбы к менеджеру окон, чтобы выбранное в пикере
/// главенствовало и на машине, где терминал открывает не пикер. Словарь общий с
/// реестром менеджера (`claudeWt.terminals` в windows11-manager); источник
/// правды — таблица `PRESETS` в `frontend-src/terminal-presets.js`, здесь её
/// копия, и сверяет их `test/terminal-name.test.js`.
///
/// Копия эта неизбежна: ту же просьбу шлёт проектный хоткей
/// (`project_hotkeys.rs`), а у него webview спит и спросить страницу не у кого.
/// Своего ключа в конфиге у пресета нет намеренно (см. `matchPreset`), поэтому
/// имя и считается от полей, а не читается готовым.
///
/// **Ключ — имя файла без каталога, а не путь целиком и не путь с
/// аргументами.** У `matchPreset` в окне настроек правило строже, и разница
/// намеренная: там вопрос «показать ли в выпадашке пресет или Custom», и
/// дописанный руками флаг обязан честно дать Custom; здесь вопрос другой —
/// «какой это терминал», и на него дописанный флаг не влияет. Путь целиком не
/// годится по той же причине: у msi, portable-распаковки и scoop он разный, а
/// терминал один. Незнакомое имя — пустая строка: поля в просьбе не будет
/// вовсе, и менеджер возьмёт свой дефолт.
///
/// `osascript` здесь стоит за iTerm2, и это единственная неточная запись:
/// AppleScript сам по себе терминала не называет. Другого признака у пресета
/// iTerm2 нет — путь у него как раз к `osascript`, — а цена ошибки сегодня
/// нулевая: просьбы об открытии сессии на маке не принимает никто.
const TERMINAL_NAMES: &[(&str, &str)] = &[
    ("wt.exe", "wt"),
    ("wezterm-gui.exe", "wezterm"),
    ("wezterm", "wezterm"),
    ("kitty", "kitty"),
    ("ghostty", "ghostty"),
    ("osascript", "iterm2"),
];

/// Имя терминала из сырого конфига — то, что поедет в теле просьбы.
///
/// Пустая строка значит «назвать нечем»: терминал не настроен вовсе либо
/// набран руками («Custom»). Врать тут нельзя — назови мы чужое имя, менеджер
/// открыл бы не то, что стоит у человека в поле.
pub fn terminal_name(raw: &serde_json::Value) -> String {
    let file = raw
        .get("terminal")
        .and_then(|t| t.get("file"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    // Разделителя два: конфиг с Windows несёт `\`, а с мака и Linux — `/`.
    let base = file
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    TERMINAL_NAMES
        .iter()
        .find(|(exe, _)| *exe == base)
        .map(|(_, name)| (*name).to_string())
        .unwrap_or_default()
}

/// Тело просьбы о подъёме окна — и об отметке «непросмотрено»: у обеих один
/// и тот же снаряд, `{"id": …}`.
///
/// Общая точка сборки для обоих транспортов (`manager_http.rs` зовёт её же):
/// разойдись тело по транспортам, одна и та же просьба значила бы разное в
/// зависимости от дороги, а поймать это можно было бы только на живой машине.
pub(crate) fn focus_body(id: &str) -> String {
    serde_json::json!({ "id": id }).to_string()
}

/// Попросить о подъёме окна сессии.
pub fn focus(broker: &Broker, base: &str, id: &str) -> Result<(), String> {
    publish(broker, base, FOCUS_TOPIC, &focus_body(id))
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
pub fn unread(broker: &Broker, base: &str, id: &str) -> Result<(), String> {
    publish(broker, base, UNREAD_TOPIC, &focus_body(id))
}

/// Попросить открыть сессию на машине трекера.
///
/// Зовётся и с чужой машины (пункт меню «Open on <host>»), и со своей же —
/// там Enter вызывает ту же команду `open_session_mqtt` напрямую, когда
/// `chooseOpenTransport` отдал `manager`. Отдельного HTTP-пути к
/// windows11-manager на своей машине не было и быть не могло: webview Tauri
/// режет такой запрос как cross-origin ещё до отправки. Поддержано одно
/// действие, `terminal`: остальные (cursor, explorer, pr) осмысленны только
/// там, где стоит человек, а не там, где висит окно.
pub fn open(
    broker: &Broker,
    base: &str,
    id: &str,
    cwd: &str,
    terminal: &str,
    place: Placement,
) -> Result<(), String> {
    publish(broker, base, OPEN_TOPIC, &open_payload(id, cwd, terminal, place))
}

/// Необязательный ключ: пустое значение в тело не кладётся вовсе.
///
/// Правило одно на `cwd`, `terminal` и `sessionIds`: приёмник читает пустую
/// строку как «не знаем», а отсутствие ключа говорит то же самое честнее — и
/// проверка `!== undefined` на той стороне на пустой строке сломалась бы молча.
fn put_if_set(body: &mut serde_json::Map<String, serde_json::Value>, key: &str, value: &str) {
    if !value.is_empty() {
        body.insert(key.to_string(), serde_json::Value::String(value.to_string()));
    }
}

/// Точка курсора в теле просьбы — «новое окно поставь на этот экран».
///
/// Точка, а не номер монитора, и это решение. У приёмника нумераций экранов
/// три сразу — своя в конфиге, hMonitor и FancyZones, — и договориться о
/// какой-то одной значило бы завести общий словарь на два репозитория, где
/// расхождение видно не было бы вовсе: окно встало бы не на тот экран, а
/// ответа у публикации нет. Точку же он переводит в монитор сам
/// (`findMonitorByPoint`), тем же кодом, каким делает это для своих раскладок.
///
/// Округляется до целого: точка приезжает в физических пикселях, и доля
/// пикселя не значит ничего ни для одного читателя.
///
/// Отсутствие ключа значит «ставь как ставил» — то же правило, что у
/// `put_if_set`: приёмник прежней версии поля не знает вовсе, и просьба обязана
/// сработать у него по-старому.
fn put_cursor(
    body: &mut serde_json::Map<String, serde_json::Value>,
    cursor: Option<(f64, f64)>,
) {
    let Some((x, y)) = cursor else { return };
    let mut point = serde_json::Map::new();
    point.insert("x".to_string(), serde_json::json!(x.round() as i64));
    point.insert("y".to_string(), serde_json::json!(y.round() as i64));
    body.insert("cursor".to_string(), serde_json::Value::Object(point));
}

/// Как ставить новое окно: куда и кто им потом распоряжается.
///
/// Два поля вместе, а не два аргумента подряд у пяти функций: вопрос у них
/// один, и приезжают они всегда из одного места — `cursor_hint` рядом с
/// признаком Ctrl. Пустая `Placement` значит «ставь как ставил»: ни одного
/// ключа в теле, и приёмник прежней версии ведёт себя как раньше.
#[derive(Clone, Copy, Default)]
pub struct Placement {
    pub cursor: Option<(f64, f64)>,
    pub no_autoplace: bool,
}

/// Точка курсора и просьба не расставлять окно — в тело просьбы.
///
/// `noAutoplace` кладётся только истинным: ложь и отсутствие ключа значат для
/// приёмника одно и то же — «расставляй как обычно», — а лишний ключ в теле
/// обещал бы, что о нём спрашивали.
///
/// Без курсора флага не бывает вовсе, и следит за этим вызывающий
/// (`open_session_mqtt` и соседи): пометку приёмник ставит на той же дороге,
/// какой ставит окно по курсору, и просьба «не двигай» без «поставь сюда»
/// молча не сделала бы ничего.
fn put_placement(body: &mut serde_json::Map<String, serde_json::Value>, place: Placement) {
    put_cursor(body, place.cursor);
    if place.no_autoplace {
        body.insert("noAutoplace".to_string(), serde_json::Value::Bool(true));
    }
}

/// Тело просьбы об открытии.
///
/// `cwd` — каталог проекта, и он тут не украшение: id менеджер ищет среди
/// своих слотов, а список пикера приезжает от ccfzf с ssh-хоста и знает
/// сессии, которых на Windows не открывали ни разу. По каталогу менеджер
/// поднимает терминал с профилем из `claudeWt.projects` — то, чего собранная
/// в пикере команда `wt.exe` не умеет.
///
/// `terminal` — семейное имя выбранного в пикере терминала (`terminal_name`).
/// Оно тут главнее дефолта менеджера: настройку пикера человек видит, а конфиг
/// менеджера — нет, и молча открытый чужой терминал выглядит проигнорированной
/// настройкой. Незнакомый пикеру терминал имени не имеет, и тогда ключа в теле
/// нет — менеджер берёт свой.
///
/// Пустого ключа в теле нет вовсе: приёмник читает пустую строку как «каталога
/// не знаем», а отсутствие ключа говорит то же самое честнее — то же правило,
/// что у `restore_payload`.
pub(crate) fn open_payload(id: &str, cwd: &str, terminal: &str, place: Placement) -> String {
    let mut body = serde_json::Map::new();
    body.insert("id".to_string(), serde_json::Value::String(id.to_string()));
    body.insert(
        "action".to_string(),
        serde_json::Value::String("terminal".to_string()),
    );
    put_if_set(&mut body, "cwd", cwd);
    put_if_set(&mut body, "terminal", terminal);
    put_placement(&mut body, place);
    serde_json::Value::Object(body).to_string()
}

/// Попросить открыть проект по каталогу — какую сессию, решит менеджер.
///
/// Отличается от `open()` тем, чего в теле нет: `id`. Проектный хоткей знает
/// только каталог, а какая сессия в нём последняя — вопрос к живым окнам
/// Windows, и отвечает на него `openClaudeProject` у менеджера, а не список
/// пикера: у скрытого окна тот отстаёт до восьми минут (бэкофф в `poller.rs`),
/// а при выключенном фоновом опросе не обновляется вовсе.
pub fn open_project(
    broker: &Broker,
    base: &str,
    cwd: &str,
    terminal: &str,
    place: Placement,
) -> Result<(), String> {
    publish(broker, base, OPEN_TOPIC, &open_project_payload(cwd, terminal, place))
}

/// Тело просьбы об открытии проекта: действие и каталог, без `id`.
///
/// Пустой `id` сюда класть не надо, хотя приёмник его и переживёт: ключ без
/// значения — это тело, которое врёт о том, что знает. Ровно по этому правилу
/// здесь же выброшен пустой `cwd` в `open_payload`.
pub(crate) fn open_project_payload(cwd: &str, terminal: &str, place: Placement) -> String {
    let mut body = serde_json::Map::new();
    body.insert(
        "action".to_string(),
        serde_json::Value::String("terminal".to_string()),
    );
    body.insert("cwd".to_string(), serde_json::Value::String(cwd.to_string()));
    put_if_set(&mut body, "terminal", terminal);
    put_placement(&mut body, place);
    serde_json::Value::Object(body).to_string()
}

/// Попросить завести новую сессию в каталоге, не поднимая существующую.
///
/// Отличается от `open_project` не топиком, а действием: топик отвечает на
/// вопрос «о чём просьба» — открыть сессию, — а не «каким способом». Отдельное
/// значение `action`, а не флаг рядом с прежним `terminal`, выбрано по тому,
/// как ошибётся старый приёмник на незнакомом входе. Флаг рядом с `terminal`
/// он пропустил бы молча и поднял старое окно — сделал бы ровно обратное
/// просьбе, и никто бы не узнал. Незнакомое же `action` он отклоняет: делает
/// хотя бы ничего и жалуется (`unsupported action` в журнал). Уведомлением —
/// только начиная с версии менеджера, где сделана правка № 1 по итогам
/// финального ревью; уже выкаченная на момент этого коммита версия шлёт отказ
/// только в журнал, честнее сказать это прямо, чем утверждать за неё лишнее.
pub fn open_new(
    broker: &Broker,
    base: &str,
    cwd: &str,
    name: &str,
    terminal: &str,
    place: Placement,
) -> Result<(), String> {
    publish(broker, base, OPEN_TOPIC, &open_new_payload(cwd, name, terminal, place))
}

/// Тело просьбы о новой сессии: действие, каталог и имя.
///
/// Имя обязательно и пустым не бывает: без него приёмник взял бы basename
/// каталога — то самое имя, которое уже занято открытой сессией. Пустую строку
/// сюда класть нельзя по тому же правилу, по которому её нет в `open_payload`:
/// ключ без значения — это тело, которое врёт о том, что знает.
pub(crate) fn open_new_payload(cwd: &str, name: &str, terminal: &str, place: Placement) -> String {
    let mut body = serde_json::Map::new();
    body.insert(
        "action".to_string(),
        serde_json::Value::String("terminal-new".to_string()),
    );
    body.insert("cwd".to_string(), serde_json::Value::String(cwd.to_string()));
    body.insert("name".to_string(), serde_json::Value::String(name.to_string()));
    put_if_set(&mut body, "terminal", terminal);
    put_placement(&mut body, place);
    serde_json::Value::Object(body).to_string()
}

/// Тело просьбы о восстановлении.
///
/// Без `sessionIds` приёмник поднимает снимок целиком. Пустой массив он
/// прочитал бы как «поднять ноль сессий», поэтому при пустом списке ключа в
/// теле нет вовсе: разница между «все» и «никого» стоит целой раскладки.
pub(crate) fn restore_payload(id: &str, session_ids: &[String]) -> String {
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
pub fn restore(broker: &Broker, base: &str, id: &str, session_ids: &[String]) -> Result<(), String> {
    publish(broker, base, RESTORE_TOPIC, &restore_payload(id, session_ids))
}

/// Тело просьбы о раскладке.
///
/// `ids` — сессии в том порядке, в каком они стоят **в списке пикера**. Это и
/// есть смысл поля: порядок знает только тот, кто список показывает, и на
/// стороне трекера его не восстановить.
///
/// Пустой список ключа не получает вовсе: у приёмника «нет ключа» значит «все
/// ведомые окна, порядком той машины», а `"ids": []` он прочитал бы как
/// «разложить ноль окон». Та же разница между «все» и «никого», что у
/// `restore_payload`, и стоит она целой раскладки.
///
/// Незнакомая раскладка — отказ, а не публикация: приёмник её отбрасывает
/// молча, и ошибка выглядела бы сработавшей просьбой. Страница шлёт только
/// свои две константы, но команда Tauri — второй вход в ту же дорогу.
pub(crate) fn place_payload(mode: &str, ids: &[String]) -> Result<String, String> {
    if !LAYOUT_MODES.contains(&mode) {
        return Err(format!("unknown layout mode: {mode}"));
    }
    if ids.is_empty() {
        return Ok(serde_json::json!({ "mode": mode }).to_string());
    }
    Ok(serde_json::json!({ "mode": mode, "ids": ids }).to_string())
}

/// Попросить разложить окна на машине трекера.
///
/// Ответа у просьбы нет, как и у подъёма окна: трекер отчитывается своему
/// человеку строкой в трее. Отказ виден на экране — окна там же.
pub fn place(broker: &Broker, base: &str, mode: &str, ids: &[String]) -> Result<(), String> {
    publish(broker, base, PLACE_TOPIC, &place_payload(mode, ids)?)
}

/// Полный топик: разрешённая база плюс заданный приёмником хвост.
fn topic_of(base: &str, tail: &str) -> String {
    format!("{base}{tail}")
}

/// Куда публиковать: адрес, названный трекером, либо своя база из конфига.
///
/// Названный адрес приезжает из ответа агрегатора, то есть из файла, который
/// написали на чужой машине. Кавычить такую строку было бы половиной защиты —
/// её и не кавычат: подходит белый список, как у `remoteDir` в трекере.
/// Отдельно про `#` и `+`: это подстановочные знаки MQTT, и публикация по
/// такому топику ушла бы мимо всех, кто её ждёт. Пустой сегмент и ведущая
/// косая — то же самое, только тише.
///
/// Отказ откатывает на базу из конфига, а не роняет просьбу: подъём окна
/// важнее строгости, и старый трекер адреса не называет вовсе.
pub fn resolve_base(broker: &Broker, asked: &str) -> String {
    let fallback = format!("{}/windows", broker.base);
    let s = asked.trim();
    if s.is_empty() {
        return fallback;
    }
    let ok = !s.starts_with('/')
        && !s.ends_with('/')
        && !s.contains("//")
        && s.split('/').all(|seg| {
            !seg.is_empty()
                && seg
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        });
    if ok {
        s.to_string()
    } else {
        // Непустая строка, не прошедшая белый список, — это чужая (или
        // повреждённая) запись трекера, а не законный «спроси свой конфиг»
        // (тот кодируется пустой строкой и сюда не попадает). Просьба всё
        // равно уйдёт — на другую машину, — и без единого слова это неотличимо
        // от намеренного адреса. Молчащий откат такого рода уже стоил здесь
        // полдня расследования: `Ctrl+F11` в `project_hotkeys.rs`.
        ccfzf_log!("resolve_base: '{s}' is not in the whitelist, falling back to {fallback}");
        fallback
    }
}

/// Адреса, по которым отматывается отметка «просмотрено».
///
/// Окон у сессии бывает несколько, отметка складывается по максимуму всех, и
/// отмотать надо у каждого трекера: отмотай у одного — второй вернёт
/// «просмотрено» на следующем же опросе.
///
/// Каждая база просеивается тем же белым списком, что и одиночная: строка
/// приезжает из файла, написанного на чужой машине. Совпавшие после
/// просеивания складываются — две публикации в один топик это два одинаковых
/// сообщения, а не две отметки. Пустой список даёт базу своего конфига: так
/// пикер вёл себя до появления нескольких трекеров.
pub fn unread_bases(broker: &Broker, asked: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for base in asked.iter().map(|a| resolve_base(broker, a.trim())) {
        if !out.contains(&base) {
            out.push(base);
        }
    }
    if out.is_empty() {
        out.push(resolve_base(broker, ""));
    }
    out
}

/// Опубликовать готовое тело в топик установки и дождаться подтверждения.
///
/// Ждём именно `PubAck`, а не просто отправки: без него «опубликовано» значит
/// лишь «сложено в очередь клиента», и брокер, до которого не дотянулись, был
/// бы неотличим от сработавшего.
fn publish(broker: &Broker, base: &str, tail: &str, payload: &str) -> Result<(), String> {
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

    let topic = topic_of(base, tail);

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
        broker_from_config, open_new_payload, open_payload, open_project_payload, place_payload,
        resolve_base, restore_payload, terminal_name, topic_of, unread_bases, Placement,
        FOCUS_TOPIC,
        OPEN_TOPIC, PLACE_TOPIC, RESTORE_TOPIC, UNREAD_TOPIC,
    };

    fn broker(base: &str) -> super::Broker {
        broker_from_config(&serde_json::json!({ "mqtt": { "host": "broker", "base": base } }))
    }

    // Хвосты заданы приёмником — демоном на Windows-машине. Опечатка здесь
    // ничего не ломает на глаз: публикация проходит, PubAck приходит, а окно не
    // поднимается и отметка не отматывается, потому что никто не слушает.
    #[test]
    fn topics_are_the_ones_the_daemon_listens_to() {
        let broker = broker_from_config(&serde_json::json!({
            "mqtt": { "host": "broker", "base": "home/room/pc/" }
        }));
        assert_eq!(
            topic_of(&resolve_base(&broker, ""), FOCUS_TOPIC),
            "home/room/pc/windows/claude-focus"
        );
        assert_eq!(
            topic_of(&resolve_base(&broker, ""), UNREAD_TOPIC),
            "home/room/pc/windows/claude-session-unread"
        );
    }

    #[test]
    fn an_asked_base_wins_over_the_configured_one() {
        // Трекеров несколько, у каждого свой топик. Своя база из конфига
        // отвечает только за ту машину, где пикер настраивали руками.
        let b = broker("home/room/pc");
        assert_eq!(resolve_base(&b, "home/room/mac/windows"), "home/room/mac/windows");
    }

    #[test]
    fn no_asked_base_falls_back_to_the_config() {
        // Старый трекер и старый агрегатор адреса не называют. Пикер обязан
        // вести себя как прежде, а не молчать.
        let b = broker("home/room/pc");
        assert_eq!(resolve_base(&b, ""), "home/room/pc/windows");
        assert_eq!(resolve_base(&b, "   "), "home/room/pc/windows");
    }

    #[test]
    fn wildcards_and_junk_fall_back_to_the_config() {
        // `#` и `+` — подстановочные знаки MQTT: публикация по такому топику
        // ушла бы мимо всех, кто её ждёт. Строка приезжает из файла на чужой
        // машине, и доверять ей нечего.
        let b = broker("home/room/pc");
        assert_eq!(resolve_base(&b, "home/#"), "home/room/pc/windows");
        assert_eq!(resolve_base(&b, "home/+/windows"), "home/room/pc/windows");
        assert_eq!(resolve_base(&b, "/room/pc"), "home/room/pc/windows");
        assert_eq!(resolve_base(&b, "home//room"), "home/room/pc/windows");
        assert_eq!(resolve_base(&b, "home/room/$(whoami)"), "home/room/pc/windows");
    }

    #[test]
    fn the_topic_is_built_from_the_resolved_base() {
        let b = broker("home/room/pc");
        assert_eq!(
            topic_of(&resolve_base(&b, "home/room/mac/windows"), FOCUS_TOPIC),
            "home/room/mac/windows/claude-focus"
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
            topic_of(&resolve_base(&broker, ""), OPEN_TOPIC),
            "home/room/pc/windows/claude-session-open"
        );
    }

    // Имена ключей заданы приёмником: claude-commands.js менеджера читает
    // `id`, `action` и `cwd`. Опечатка в любом из них не видна на глаз —
    // публикация проходит, PubAck приходит, а терминал не открывается.
    #[test]
    fn open_body_carries_the_project_dir() {
        assert_eq!(
            open_payload("s1", "/p/site", "", NOWHERE),
            r#"{"action":"terminal","cwd":"/p/site","id":"s1"}"#
        );
    }

    // Выбранный в пикере терминал главнее дефолта менеджера, и уезжает он
    // именем в теле. Без этого поля на машине с менеджером настройка пикера не
    // читается вовсе: терминал открывает не пикер, и `terminal` из
    // `config.yaml` остаётся только на запасной местной дороге.
    #[test]
    fn open_body_names_the_terminal() {
        assert_eq!(
            open_payload("s1", "/p/site", "wezterm", NOWHERE),
            r#"{"action":"terminal","cwd":"/p/site","id":"s1","terminal":"wezterm"}"#
        );
    }

    // «Custom» имени не имеет: набранное руками нам неизвестно, и назови мы его
    // чужим именем — менеджер открыл бы не то, что стоит в поле. Тогда ключа в
    // теле нет вовсе, и менеджер берёт свой дефолт — то же правило, что у
    // пустого `cwd`.
    #[test]
    fn a_nameless_terminal_carries_no_key() {
        assert_eq!(
            open_payload("s1", "", "", NOWHERE),
            r#"{"action":"terminal","id":"s1"}"#
        );
        assert_eq!(
            open_project_payload("/p/site", "", NOWHERE),
            r#"{"action":"terminal","cwd":"/p/site"}"#
        );
        assert_eq!(
            open_new_payload("/p/site", "site-2", "", NOWHERE),
            r#"{"action":"terminal-new","cwd":"/p/site","name":"site-2"}"#
        );
    }

    // Все три просьбы, кончающиеся терминалом, обязаны нести имя: Enter на
    // сессии, Enter на строке проекта (та же дорога у проектного хоткея) и
    // `^N`. Забудь любую — выбор пикера действовал бы через раз, и объяснить
    // это человеку было бы нечем.
    #[test]
    fn every_terminal_request_names_it() {
        assert!(open_payload("s1", "/p/site", "wt", NOWHERE).contains(r#""terminal":"wt""#));
        assert!(open_project_payload("/p/site", "wt", NOWHERE).contains(r#""terminal":"wt""#));
        assert!(open_new_payload("/p/site", "site-2", "wt", NOWHERE).contains(r#""terminal":"wt""#));
    }

    /// Просьба без единой оговорки про место: как ставили, так и ставьте.
    const NOWHERE: Placement = Placement {
        cursor: None,
        no_autoplace: false,
    };

    /// «Поставь на этот экран» — то, что даёт галка `openOnActiveDisplay`.
    fn at(x: f64, y: f64) -> Placement {
        Placement {
            cursor: Some((x, y)),
            no_autoplace: false,
        }
    }

    /// Ctrl на строке списка: «поставь сюда и больше не двигай».
    fn pinned(x: f64, y: f64) -> Placement {
        Placement {
            cursor: Some((x, y)),
            no_autoplace: true,
        }
    }

    // Точка курсора — просьба «поставь новое окно на этот экран». Ключ
    // необязательный: выключенная галка и приёмник прежней версии обязаны
    // вести себя как раньше, и различает эти два случая только отсутствие
    // ключа целиком.
    #[test]
    fn the_cursor_point_rides_along_when_asked() {
        assert_eq!(
            open_payload("s1", "", "", at(2560.0, 300.0)),
            r#"{"action":"terminal","cursor":{"x":2560,"y":300},"id":"s1"}"#
        );
        assert_eq!(
            open_project_payload("/p/site", "", at(-1920.0, 12.0)),
            r#"{"action":"terminal","cursor":{"x":-1920,"y":12},"cwd":"/p/site"}"#
        );
        assert_eq!(
            open_new_payload("/p/site", "site-2", "", at(0.0, 0.0)),
            r#"{"action":"terminal-new","cursor":{"x":0,"y":0},"cwd":"/p/site","name":"site-2"}"#
        );
    }

    // Доля пикселя не значит ничего ни для одного читателя, а в JSON выглядела
    // бы `2559.6` — числом, которое приёмник сравнивает с целыми границами
    // мониторов. Округление, а не усечение: экран слева от главного даёт
    // отрицательную точку, и усечение уводило бы её от края наружу.
    #[test]
    fn the_cursor_point_is_whole_pixels() {
        assert!(open_payload("s1", "", "", at(2559.6, -0.4))
            .contains(r#""cursor":{"x":2560,"y":0}"#));
    }

    // Все три просьбы, кончающиеся терминалом, обязаны уметь нести точку — по
    // той же причине, по какой все три несут имя терминала: забудь любую, и
    // галка работала бы через раз, а поймать это нечем — ответа у публикации
    // нет.
    #[test]
    fn every_terminal_request_can_carry_the_cursor() {
        let point = at(10.0, 20.0);
        assert!(open_payload("s1", "/p/site", "wt", point).contains(r#""cursor""#));
        assert!(open_project_payload("/p/site", "wt", point).contains(r#""cursor""#));
        assert!(open_new_payload("/p/site", "site-2", "wt", point).contains(r#""cursor""#));
    }

    // Выключенная галка не должна отличаться от пикера прежней версии ни одним
    // знаком: приёмник читает отсутствие ключа как «ставь как ставил».
    #[test]
    fn no_cursor_means_no_key() {
        assert!(!open_payload("s1", "/p/site", "wt", NOWHERE).contains("cursor"));
        assert!(!open_project_payload("/p/site", "wt", NOWHERE).contains("cursor"));
        assert!(!open_new_payload("/p/site", "s-2", "wt", NOWHERE).contains("cursor"));
    }

    // Ctrl на строке списка: окно встаёт под курсором и остаётся там. Ключ
    // едет всеми тремя просьбами, кончающимися терминалом, — забудь любую, и
    // модификатор работал бы через раз, а поймать это нечем: ответа у
    // публикации нет.
    #[test]
    fn every_terminal_request_can_ask_to_skip_autoplacement() {
        assert_eq!(
            open_payload("s1", "", "", pinned(2560.0, 300.0)),
            r#"{"action":"terminal","cursor":{"x":2560,"y":300},"id":"s1","noAutoplace":true}"#
        );
        assert!(open_project_payload("/p/site", "wt", pinned(10.0, 20.0)).contains(r#""noAutoplace":true"#));
        assert!(
            open_new_payload("/p/site", "site-2", "wt", pinned(10.0, 20.0))
                .contains(r#""noAutoplace":true"#)
        );
    }

    // Ложь и отсутствие ключа значат для приёмника одно и то же, а лишний ключ
    // обещал бы, что о нём спрашивали. Обычное открытие обязано выглядеть
    // ровно так же, как у пикера прежней версии.
    #[test]
    fn no_mark_means_no_key() {
        assert!(!open_payload("s1", "/p/site", "wt", NOWHERE).contains("noAutoplace"));
        assert!(!open_payload("s1", "/p/site", "wt", at(10.0, 20.0)).contains("noAutoplace"));
        assert!(!open_project_payload("/p/site", "wt", at(10.0, 20.0)).contains("noAutoplace"));
        assert!(!open_new_payload("/p/site", "s-2", "wt", at(10.0, 20.0)).contains("noAutoplace"));
    }

    // Имя считается от `terminal.file` в конфиге — по имени файла без каталога:
    // у msi, portable-распаковки и scoop путь разный, а терминал один.
    #[test]
    fn the_terminal_name_comes_from_the_configured_file() {
        let named = |file: &str| {
            terminal_name(&serde_json::json!({ "terminal": { "file": file } }))
        };
        assert_eq!(named("wezterm-gui.exe"), "wezterm");
        // Обратный слэш разбирается наравне с прямым: конфиг с Windows несёт
        // его. Диск в пути не назван намеренно — буква диска запрещена
        // `test/no-private-data.test.js`, а к разбору она ничего не добавляет.
        assert_eq!(named("Program Files\\WezTerm\\wezterm-gui.exe"), "wezterm");
        assert_eq!(named("wt.exe"), "wt");
        assert_eq!(named("/opt/homebrew/bin/kitty"), "kitty");
        assert_eq!(named("/usr/bin/kitty"), "kitty");
        assert_eq!(named("/Applications/Ghostty.app/Contents/MacOS/ghostty"), "ghostty");
        assert_eq!(named("/usr/bin/osascript"), "iterm2");
    }

    // Незнакомое и ненастроенное — пустая строка, а не выдуманное имя. Врать
    // тут нельзя: менеджер открыл бы не то, что стоит у человека в поле.
    #[test]
    fn an_unknown_terminal_has_no_name() {
        assert_eq!(terminal_name(&serde_json::json!({})), "");
        assert_eq!(
            terminal_name(&serde_json::json!({ "terminal": { "file": "/usr/bin/xterm" } })),
            ""
        );
        assert_eq!(
            terminal_name(&serde_json::json!({ "terminal": { "file": "  " } })),
            ""
        );
    }

    // Каталога может не быть: у сессии, чей транскрипт не прочитался, поле
    // пустое. Тогда ключа в теле нет вовсе — приёмник ищет сессию по id, а
    // отсутствие каталога отличает от «каталог — пустая строка».
    #[test]
    fn open_body_without_a_dir_carries_no_key() {
        assert_eq!(open_payload("s1", "", "", NOWHERE), r#"{"action":"terminal","id":"s1"}"#);
    }

    // Тело просьбы проектного хоткея: каталог есть, `id` нет вовсе. Пустую
    // строку приёмник сегодня прочитал бы как «id нет» и просьбу не сломал бы,
    // но тело перестало бы говорить правду — то же правило, по которому здесь
    // же выброшен пустой `cwd`. А проверка `id !== undefined` на той стороне
    // сломала бы просьбу молча и не на глаз.
    #[test]
    fn open_project_body_carries_no_id() {
        assert_eq!(
            open_project_payload("/p/site", "", NOWHERE),
            r#"{"action":"terminal","cwd":"/p/site"}"#
        );
    }

    // Тело просьбы «заведи ещё одну»: каталог, имя и отдельное действие.
    // Имя здесь не украшение — его считает пикер (`uniqueSessionName`), потому
    // что basename каталога уже занят открытой сессией, а два окна с одним
    // заголовком трекер привязал бы к одной сессии.
    //
    // `id` не едет и сюда, даже когда нажали на строке живой сессии: с ним
    // приёмник поднял бы ровно ту сессию, рядом с которой просили открыть
    // новую.
    #[test]
    fn open_new_body_names_the_session() {
        assert_eq!(
            open_new_payload("/p/site", "site-2", "", NOWHERE),
            r#"{"action":"terminal-new","cwd":"/p/site","name":"site-2"}"#
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
            topic_of(&resolve_base(&broker, ""), RESTORE_TOPIC),
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

    // Хвост задан приёмником — `mwm-core` разбирает его в `parse_request`.
    // Опечатка здесь тиха вдвойне: публикация проходит, PubAck приходит, а
    // окна остаются как стояли, потому что команду никто не узнал.
    #[test]
    fn place_topic_is_the_one_the_tracker_listens_to() {
        let broker = broker("home/room/mac");
        assert_eq!(
            topic_of(&resolve_base(&broker, ""), PLACE_TOPIC),
            "home/room/mac/windows/claude-place"
        );
    }

    // Порядок в `ids` — тот, в каком строки стоят в списке пикера, и это
    // единственный смысл поля: на стороне трекера его не восстановить.
    // Порядок ключей в объекте алфавитный — так их складывает serde_json, и
    // приёмнику он безразличен. Значим порядок **внутри** `ids`, его и
    // сверяем.
    #[test]
    fn place_body_carries_the_order_of_the_list() {
        let body = place_payload("tile", &["aaa".to_string(), "bbb".to_string()]).unwrap();
        assert_eq!(body, r#"{"ids":["aaa","bbb"],"mode":"tile"}"#);
    }

    // Пустой список значит «все ведомые окна, порядком той машины», и говорит
    // это отсутствие ключа: `"ids": []` приёмник прочитал бы как «разложить
    // ноль окон». То же правило, что у `restore_payload`.
    #[test]
    fn place_body_without_ids_means_all_windows() {
        assert_eq!(place_payload("cascade", &[]).unwrap(), r#"{"mode":"cascade"}"#);
    }

    // Незнакомую раскладку приёмник отбрасывает молча — расставить окна наугад
    // хуже, чем не расставить, — и потому отказ обязан случиться здесь.
    // Страница шлёт только свои две константы, но команда Tauri — второй вход,
    // и опечатка в нём иначе выглядела бы сработавшей просьбой.
    #[test]
    fn an_unknown_layout_mode_is_refused() {
        assert!(place_payload("mosaic", &[]).is_err());
        assert!(place_payload("", &[]).is_err());
    }

    #[test]
    fn unread_bases_resolves_each_and_drops_duplicates() {
        // Две базы просеиваются порознь, а совпавшие после просеивания
        // складываются в одну: две публикации в один топик — это два
        // одинаковых сообщения, а не две отметки.
        let b = broker("home/room/pc");
        let got = unread_bases(&b, &["home/room/mac/windows".into(),
                                     "home/room/mac/windows".into()]);
        assert_eq!(got, vec!["home/room/mac/windows".to_string()]);
    }

    #[test]
    fn unread_bases_drops_duplicates_created_by_the_whitelist_itself() {
        // Здесь совпадают не сырые строки (это уже проверено выше), а то, во
        // что их превращает белый список: обе не проходят его и откатываются
        // на одну и ту же базу конфига. Дедуп «до просеивания» такой повтор
        // не поймал бы вовсе — строки на входе разные, — а «после» обязан
        // схлопнуть их в одну: без этого на одну и ту же машину улетели бы
        // две одинаковые публикации.
        let b = broker("home/room/pc");
        let got = unread_bases(&b, &["home/#".into(), "home/+/windows".into()]);
        assert_eq!(got, vec![resolve_base(&b, "")]);
    }

    #[test]
    fn unread_bases_falls_back_to_the_config_base() {
        // Строка без окон баз не называет, и просьба обязана уйти по своей:
        // слот в менеджере переживает закрытие окна.
        let b = broker("home/room/pc");
        assert_eq!(unread_bases(&b, &[]), vec![resolve_base(&b, "")]);
    }

    #[test]
    fn unread_bases_sifts_out_wildcards() {
        // Строка приезжает из файла, написанного на чужой машине, а `#` и `+`
        // в MQTT — подстановочные знаки: публикация по такому топику ушла бы
        // мимо всех.
        let b = broker("home/room/pc");
        assert_eq!(unread_bases(&b, &["home/+/windows".into()]),
                   vec![resolve_base(&b, "")]);
    }
}
