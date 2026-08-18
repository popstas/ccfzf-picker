//! Слияние ответов нескольких агрегаторов в один документ.

use crate::state_source::Source;
use serde_json::{Map, Value};

/// Списки, которые складываются, и ключ, по которому у каждого считается
/// двойник. Ключ у каждого свой: общего `id` тут нет, и таблица эта одна —
/// второй список разошёлся бы с первым молча, а видно это было бы только
/// пропавшей строкой.
const LISTS: [(&str, &str); 5] = [
    ("sessions", "id"),
    ("projects", "path"),
    ("snapshots", "id"),
    ("zellij", "name"),
    ("windowHosts", "host"),
];

/// Пометить строки источником — все списки, кроме `windowHosts`.
///
/// `windowHosts` — запись машины, а не строка списка: у неё уже есть своё
/// имя, и вопрос «кто про неё рассказал» к ней не задают.
fn tag(state: &mut Value, label: &str) {
    let Some(obj) = state.as_object_mut() else { return };
    for (list, _) in LISTS.iter().filter(|(l, _)| *l != "windowHosts") {
        let Some(rows) = obj.get_mut(*list).and_then(|v| v.as_array_mut()) else { continue };
        for row in rows {
            if let Some(fields) = row.as_object_mut() {
                fields.insert("source".to_string(), Value::String(label.to_string()));
            }
        }
    }
}

/// Ключ записи как строка, или None — такую запись не с чем сравнивать, и она
/// проходит как есть.
fn key_of(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// Склеить `windows` двойника. Окна не выбрасываются: карточка рисуется на
/// окно, и потерянное окно — это исчезнувшая карточка. Повторы отсеиваются по
/// самой записи целиком: своего ключа у окна нет.
fn join_windows(into: &mut Value, from: &Value) {
    let Some(extra) = from.get("windows").and_then(|v| v.as_array()) else { return };
    let mut merged = into
        .get("windows")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for w in extra {
        if !merged.contains(w) {
            merged.push(w.clone());
        }
    }
    if let Some(fields) = into.as_object_mut() {
        fields.insert("windows".to_string(), Value::Array(merged));
    }
}

/// Дописать список `incoming` к `out`, пропуская двойников.
fn merge_list(out: &mut Map<String, Value>, incoming: &Value, list: &str, key: &str) {
    let Some(rows) = incoming.get(list).and_then(|v| v.as_array()) else { return };
    let mut acc = out
        .get(list)
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for row in rows {
        match key_of(row, key) {
            Some(k) => match acc.iter_mut().find(|e| key_of(e, key).as_deref() == Some(k.as_str())) {
                // Первый источник побеждает: скалярные поля остаются его.
                Some(existing) => join_windows(existing, row),
                None => acc.push(row.clone()),
            },
            None => acc.push(row.clone()),
        }
    }
    out.insert(list.to_string(), Value::Array(acc));
}

/// Слить ответы в документ прежней формы.
///
/// Форма не меняется намеренно: страница живёт полями `lastState`
/// (`lastState.windowHosts`, `.snapshots`, `.windowHost`, `openIdsFromState`), и
/// отдай Rust два документа — правок было бы не десять, а сто, и каждая из
/// них молчаливая.
///
/// Верхние поля берутся у первого источника, включая легаси-пару
/// `windowHost`/`windowPid` (окно одно на весь ответ у старого агрегатора):
/// второй источник этой дороги не касается.
pub fn merge_states(parts: &[(Source, Value)]) -> Value {
    let mut tagged: Vec<Value> = parts
        .iter()
        .map(|(source, state)| {
            let mut copy = state.clone();
            tag(&mut copy, &source.label());
            copy
        })
        .collect();

    let mut out = match tagged.iter().find(|v| v.is_object()) {
        Some(first) => first.as_object().cloned().unwrap_or_default(),
        None => Map::new(),
    };
    // Первый объектный кусок уже лёг в out целиком — второй раз его списки
    // сливать не надо, иначе окна двойника склеились бы сами с собой.
    let mut seen_first = false;
    for state in tagged.iter_mut() {
        if !state.is_object() {
            continue;
        }
        if !seen_first {
            seen_first = true;
            continue;
        }
        for (list, key) in LISTS {
            merge_list(&mut out, state, list, key);
        }
    }

    // Возраст ответа — по самому старому куску: максимум соврал бы про
    // свежесть всей половины.
    let oldest = tagged
        .iter()
        .filter_map(|v| v.get("generated").and_then(|g| g.as_i64()))
        .min();
    if let Some(g) = oldest {
        out.insert("generated".to_string(), Value::from(g));
    }

    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::merge_states;
    use crate::state_source::Source;

    fn remote() -> Source { Source::Ssh("remote-host".into()) }

    fn state(generated: i64, ids: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "generated": generated,
            "sessions": ids.iter().map(|id| serde_json::json!({"id": id})).collect::<Vec<_>>(),
        })
    }

    /// Каждой строке проставляется её источник: по нему потом выбирается
    /// транспорт действия и подставляется машина строке без окна.
    #[test]
    fn every_row_gets_its_source() {
        let out = merge_states(&[
            (remote(), state(10, &["a"])),
            (Source::Local, state(20, &["b"])),
        ]);
        let sessions = out["sessions"].as_array().unwrap();
        assert_eq!(sessions[0]["source"], "remote-host");
        assert_eq!(sessions[1]["source"], "local");
    }

    /// Пикер, стоящий на машине агрегатора, получит от обоих источников один и
    /// тот же список целиком. Без дедупа человек увидел бы каждую строку
    /// дважды — и это единственная причина, по которой отдельной проверки «а не
    /// та ли это машина» не заводится.
    #[test]
    fn the_same_id_appears_once() {
        let out = merge_states(&[
            (remote(), state(10, &["a", "b"])),
            (Source::Local, state(10, &["a", "b"])),
        ]);
        assert_eq!(out["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(out["sessions"][0]["source"], "remote-host", "первый источник побеждает");
    }

    /// Окна у сессии-двойника складываются, а не теряются: карточка рисуется
    /// на окно, и выброшенное окно — это исчезнувшая карточка.
    #[test]
    fn windows_of_a_duplicate_are_joined() {
        let a = serde_json::json!({
            "generated": 1,
            "sessions": [{"id": "a", "windows": [{"host": "host-a"}]}],
        });
        let b = serde_json::json!({
            "generated": 1,
            "sessions": [{"id": "a", "windows": [{"host": "host-b"}]}],
        });
        let out = merge_states(&[(remote(), a), (Source::Local, b)]);
        let windows = out["sessions"][0]["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 2);
    }

    /// Возраст ответа — по самому старому куску: максимум соврал бы про
    /// свежесть всей половины.
    #[test]
    fn generated_is_the_oldest_part() {
        let out = merge_states(&[(remote(), state(10, &["a"])), (Source::Local, state(20, &["b"]))]);
        assert_eq!(out["generated"], 10);
    }

    /// Проекты, снимки, зелийные строки и записи машин — те же правила, свои
    /// ключи. Ключ у каждого списка свой, и общего «id» тут нет.
    ///
    /// Список машин здесь назван `windowHosts`, а не `hosts`, — потому что
    /// именно это имя шлёт агрегатор (`vendor/ccfzf/ccfzf`), и только его
    /// читает страница (`trackerHosts` в session-windows.js). Тест с
    /// вымышленным именем списка ничего не проверил бы: `LISTS` мог назвать
    /// список как угодно, а слияние всё равно ни разу не сработало бы на
    /// настоящем ответе.
    #[test]
    fn every_list_merges_by_its_own_key() {
        let a = serde_json::json!({
            "generated": 1, "sessions": [],
            "projects": [{"path": "/p"}],
            "snapshots": [{"id": "s"}],
            "zellij": [{"name": "z"}],
            "windowHosts": [{"host": "host-a"}],
        });
        let b = serde_json::json!({
            "generated": 1, "sessions": [],
            "projects": [{"path": "/p"}, {"path": "/q"}],
            "snapshots": [{"id": "s"}, {"id": "t"}],
            "zellij": [{"name": "z"}],
            "windowHosts": [{"host": "host-b"}],
        });
        let out = merge_states(&[(remote(), a), (Source::Local, b)]);
        assert_eq!(out["projects"].as_array().unwrap().len(), 2);
        assert_eq!(out["snapshots"].as_array().unwrap().len(), 2);
        assert_eq!(out["zellij"].as_array().unwrap().len(), 1);
        assert_eq!(
            out["windowHosts"].as_array().unwrap().len(), 2,
            "имя списка обязано совпадать с тем, что шлёт агрегатор — иначе слияние молчит",
        );
    }

    /// Старый агрегатор не отдаёт ни `projects`, ни `snapshots`, и это не
    /// ошибка: пикер и агрегатор выкатываются порознь.
    #[test]
    fn a_missing_list_is_not_an_error() {
        let out = merge_states(&[
            (remote(), serde_json::json!({"generated": 1, "sessions": [{"id": "a"}]})),
            (Source::Local, serde_json::json!({"generated": 1, "sessions": [{"id": "b"}], "projects": [{"path": "/p"}]})),
        ]);
        assert_eq!(out["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(out["projects"].as_array().unwrap().len(), 1);
    }

    /// Один источник — документ как приехал, плюс метка. Это самая частая
    /// дорога: `localSource` выключен у всех, кто не просил обратного.
    #[test]
    fn one_source_passes_through() {
        let out = merge_states(&[(remote(), serde_json::json!({
            "generated": 7, "sessions": [{"id": "a"}], "windowHost": "host-a", "windowPid": 42,
        }))]);
        assert_eq!(out["windowHost"], "host-a");
        assert_eq!(out["windowPid"], 42);
        assert_eq!(out["generated"], 7);
        assert_eq!(out["sessions"][0]["source"], "remote-host");
    }

    /// Мусор с той стороны не роняет поток: ответ не той формы просто не
    /// приносит строк.
    #[test]
    fn junk_does_not_panic() {
        let out = merge_states(&[
            (remote(), serde_json::json!("строка")),
            (Source::Local, serde_json::json!({"generated": 1, "sessions": [{"id": "a"}]})),
        ]);
        assert_eq!(out["sessions"].as_array().unwrap().len(), 1);
    }
}
