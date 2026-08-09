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
