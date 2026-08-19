//! Имя новой сессии — вторая копия правила, живущего на странице.
//!
//! Считает его `newSessionName` в `frontend-src/open-strategy.js` (поверх
//! `uniqueSessionName` из `session-name.js`), и до появления ветки «проектный
//! хоткей заводит новую сессию» этого хватало: имя нужно было ровно там, где
//! человек нажал Enter в открытом пикере. Хоткей же жмут при **скрытом**
//! пикере, а у скрытого окна WebView2 усыпляет страницу целиком — спросить у
//! неё нечего.
//!
//! Отдать имя менеджеру нельзя: списка занятых он не ведёт и взял бы basename
//! каталога — то самое имя, которое уже носит открытая сессия, — а два окна с
//! одним заголовком оконный трекер привяжет к одному слоту.
//!
//! Прецедент такой копии не первый: так же живут `terminal_name` (`mqtt.rs`) и
//! `place_order`, и держатся они одинаково — общей фикстурой
//! `test/fixtures/session-name.json` и двумя сторожами над ней. Поведением
//! расхождение не поймать вовсе: просьба уходит, брокер подтверждает, окно
//! открывается — просто имя у сессии другое, а ответа у публикации нет.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Свободное имя: занято — `-2`, дальше `-3`, и так далее.
///
/// Нумерация с двойки, а не с единицы: первая сессия называется просто именем
/// каталога, и `имя-1` рядом с ней читалось бы как другая сессия.
///
/// Занятыми считаются имена **живых** сессий — решает это вызывающий. Мёртвая
/// тёзка никому не мешает: заголовком окна её уже нет.
///
/// Пустое базовое имя возвращается пустым: суффикс к пустоте дал бы `-2` —
/// имя, которое ничего не значит.
pub fn unique_session_name(base: &str, taken: &[String]) -> String {
    let name = base.trim();
    if name.is_empty() {
        return String::new();
    }
    // Пробелы по краям снимаются и у занятых: заголовок окна приезжает с той
    // стороны и мог быть записан с ними — то же, что делает страница.
    let used: Vec<&str> = taken
        .iter()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .collect();
    if !used.iter().any(|t| *t == name) {
        return name.to_string();
    }
    // Цикл конечен: занятых конечное число, и каждый шаг пробует новое имя.
    for n in 2u32.. {
        let candidate = format!("{name}-{n}");
        if !used.iter().any(|t| *t == candidate) {
            return candidate;
        }
    }
    unreachable!("занятых имён конечное число")
}

/// Имя сессии для каталога: basename плюс суффикс тёзки.
///
/// Путь с `;` — отказ, пустая строка. Для шелла такой путь безопасен, а вот
/// Windows Terminal разбирает свою командную строку **до** всякого шелла и
/// режет её по `;` на панели. Правило то же, что у `newSessionName` на
/// странице, и по той же причине: вычистить знак нельзя — вышла бы сессия в
/// чужом каталоге, и молча.
pub fn new_session_name(cwd: &str, taken: &[String]) -> String {
    let path = cwd.trim_end_matches('/');
    if path.contains(';') {
        return String::new();
    }
    let base = path.rsplit('/').next().unwrap_or(path);
    unique_session_name(base, taken)
}

/// Имена живых сессий из ответа агрегатора.
///
/// Имя сессии и есть заголовок её окна — по нему оконный трекер привязывает
/// сессию к слоту, и мешают друг другу именно живые тёзки. Отбор тот же, что
/// у `takenSessionNames` на странице.
pub fn live_names(state: &serde_json::Value) -> Vec<String> {
    state
        .get("sessions")
        .and_then(|v| v.as_array())
        .map(|rows| {
            rows.iter()
                .filter(|s| s.get("live").and_then(|v| v.as_bool()).unwrap_or(false))
                .filter_map(|s| s.get("title").and_then(|v| v.as_str()))
                .filter(|t| !t.trim().is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Сколько имя, выданное хоткеем, считается занятым.
///
/// У страницы тот же счёт идёт минуту (`ISSUED_TTL_MS`), и минуты ей хватает:
/// `^N` жмут при открытом окне, а открытому опрос идёт раз в секунду. Хоткей —
/// наоборот, нажимают ровно при скрытом, где такт уходит в бэкофф до восьми
/// минут (`poller::BACKGROUND_MAX`). Возьми мы минуту и здесь — второе нажатие
/// через две получило бы то же имя, потому что ответ агрегатора о первой
/// сессии ещё не знает.
///
/// Минута сверх потолка — на сам опрос: ssh отвечает не мгновенно.
fn issued_ttl() -> Duration {
    crate::poller::BACKGROUND_MAX + Duration::from_secs(60)
}

/// Имена, выданные хоткеем и ещё не доехавшие до ответа агрегатора.
///
/// Своя память, а не общая со страницей: у той свой `issuedNames` в JS, и
/// поделить их нечем — на странице это переменная модуля. Цена известна:
/// `^N` и хоткей, нажатые в одну минуту по одному каталогу, могут дать одно
/// имя дважды. Случай узкий (пикер при хоткее скрыт, при `^N` показан) и
/// платой за него была бы дорога данных между Rust и усыплённой страницей —
/// ровно та, которой здесь и избегают.
static ISSUED: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

/// Занять имя за собой.
pub fn issue(name: &str) {
    if name.is_empty() {
        return;
    }
    let mut guard = ISSUED.lock().unwrap_or_else(|e| e.into_inner());
    let store = guard.get_or_insert_with(HashMap::new);
    let now = Instant::now();
    prune(store, now, issued_ttl());
    store.insert(name.to_string(), now);
}

/// Что занято прямо сейчас — с чисткой протухшего заодно.
pub fn issued(now: Instant) -> Vec<String> {
    let mut guard = ISSUED.lock().unwrap_or_else(|e| e.into_inner());
    let store = guard.get_or_insert_with(HashMap::new);
    prune(store, now, issued_ttl());
    store.keys().cloned().collect()
}

/// Выбросить протухшее.
///
/// Отдельной функцией ради теста: `Instant` вперёд не переводится, а назад
/// (`checked_sub`) — переводится.
fn prune(store: &mut HashMap<String, Instant>, now: Instant, ttl: Duration) {
    store.retain(|_, at| now.duration_since(*at) <= ttl);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// Вход у этого теста общий с JS-сторожем (`test/session-name.test.js`), и
    /// файл один намеренно: две копии фикстуры разошлись бы на первой же
    /// правке, после чего оба теста продолжали бы зеленеть на разных данных —
    /// то есть сторожить перестали бы молча.
    const FIXTURE: &str = include_str!("../../test/fixtures/session-name.json");

    #[test]
    fn the_shared_fixture_gives_the_name_the_page_gives() {
        let f: Value = serde_json::from_str(FIXTURE).expect("фикстура не разобралась");
        let cases = f["cases"].as_array().expect("в фикстуре нет cases");
        assert!(!cases.is_empty(), "в фикстуре не задано ни одного случая");
        for c in cases {
            let taken: Vec<String> = c["taken"]
                .as_array()
                .expect("taken — список строк")
                .iter()
                .map(|v| v.as_str().expect("в taken только строки").to_string())
                .collect();
            assert_eq!(
                new_session_name(c["cwd"].as_str().unwrap(), &taken),
                c["expected"].as_str().unwrap(),
                "{}",
                c["why"].as_str().unwrap_or("")
            );
        }
    }

    /// Занятыми считаются только живые: мёртвая тёзка заголовком окна уже не
    /// висит, и отдавать ей имя незачем.
    #[test]
    fn only_live_sessions_take_a_name() {
        let state = json!({
            "sessions": [
                { "title": "api", "live": true },
                { "title": "api-2", "live": false },
                { "title": "   ", "live": true },
                { "live": true },
            ]
        });
        assert_eq!(live_names(&state), vec!["api".to_string()]);
        // Ответ прежней версии или отказ источника — не повод падать: список
        // занятых просто пуст, и новая сессия получит basename.
        assert!(live_names(&Value::Null).is_empty());
        assert!(live_names(&json!({ "sessions": "не список" })).is_empty());
    }

    /// Выданное имя занято, пока не протухло: второе нажатие хоткея по тому же
    /// каталогу обязано получить `-2`, а не то же самое имя.
    #[test]
    fn an_issued_name_expires_by_the_poll_backoff() {
        let mut store = HashMap::new();
        let now = Instant::now();
        let ttl = issued_ttl();
        store.insert("fresh".to_string(), now);
        store.insert(
            "stale".to_string(),
            now.checked_sub(ttl + Duration::from_secs(1)).unwrap(),
        );
        prune(&mut store, now, ttl);
        assert!(store.contains_key("fresh"));
        assert!(!store.contains_key("stale"), "протухшее имя осталось занятым");
        // Потолок бэкоффа — не случайное число: столько может пройти между
        // нажатием и первым ответом, знающим о новой сессии.
        assert!(ttl > crate::poller::BACKGROUND_MAX);
    }
}
