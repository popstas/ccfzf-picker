//! Проектные хоткеи: список приезжает ответом агрегатора, а не из конфига.

/// Проект с хоткеем — ровно то, что читателю нужно от ответа.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Project {
    pub cwd: String,
    pub hotkey: String,
}

/// Чего хочет ответ агрегатора.
///
/// `None` — «трогать нечего»: либо ответ про окна ничего не знает (пустой
/// `windowHost`: `read_windows` на той стороне на любой отказ возвращает
/// пустоту целиком), либо окна на чужой машине. Различить «менеджер убрал
/// хоткей» и «трекер лежит» больше нечем: строки `projects` в ответе есть
/// всегда, они собираются из закладок ccfzf.
///
/// `Some(vec![])` — это «хоткеев нет», и он честно снимает регистрации:
/// живой трекер сказал, что в конфиге пусто.
pub fn wanted_from_state(state: &serde_json::Value, own_host: &str) -> Option<Vec<Project>> {
    let host = state.get("windowHost").and_then(|v| v.as_str()).unwrap_or("");
    let own = own_host.trim();
    if host.is_empty() || own.is_empty() || host != own {
        return None;
    }
    let mut out = Vec::new();
    for row in state
        .get("projects")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        let (Some(cwd), Some(hotkey)) = (
            row.get("path").and_then(|v| v.as_str()),
            row.get("hotkey").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        if cwd.is_empty() || hotkey.trim().is_empty() {
            continue;
        }
        out.push(Project {
            cwd: cwd.to_string(),
            hotkey: hotkey.trim().to_string(),
        });
    }
    Some(out)
}

/// Отпечаток списка: то же ли это, что уже висит.
///
/// Считается по паре «каталог + клавиша» и по порядку: порядок решает, кому
/// достанется дважды названная комбинация, и его смена — настоящее изменение.
pub fn fingerprint(list: &[Project]) -> String {
    list.iter()
        .map(|p| format!("{}\u{0}{}", p.cwd, p.hotkey))
        .collect::<Vec<_>>()
        .join("\u{1}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(host: &str, projects: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "windowHost": host, "projects": projects })
    }

    /// Пустой `windowHost` значит «ответ про окна ничего не знает».
    ///
    /// Различить «менеджер убрал хоткей» и «трекер лежит» больше нечем:
    /// строки `projects` в ответе есть всегда, они собираются из закладок
    /// ccfzf. Спутав эти случаи, пикер снимал бы клавиши на каждую ночь, когда
    /// Windows-машина выключена, — и молча.
    #[test]
    fn a_silent_answer_changes_nothing() {
        let s = state("", serde_json::json!([{"path": "/p/one", "hotkey": "Ctrl+F11"}]));
        assert_eq!(wanted_from_state(&s, "tracker-host"), None);
    }

    /// Чужая машина ничего не регистрирует: клавиши там принадлежат её хозяину.
    #[test]
    fn another_machine_registers_nothing() {
        let s = state("tracker-host", serde_json::json!([{"path": "/p/one", "hotkey": "Ctrl+F11"}]));
        assert_eq!(wanted_from_state(&s, "other-host"), None);
        assert_eq!(wanted_from_state(&s, ""), None);
    }

    /// Живой трекер с пустым списком — это «хоткеев нет», и он их снимает.
    #[test]
    fn a_live_tracker_with_no_hotkeys_clears_them() {
        let s = state("tracker-host", serde_json::json!([{"path": "/p/one"}]));
        assert_eq!(wanted_from_state(&s, "tracker-host"), Some(vec![]));
    }

    #[test]
    fn hotkeys_arrive_in_the_order_the_answer_gave_them() {
        let s = state("tracker-host", serde_json::json!([
            {"path": "/p/one", "hotkey": "Ctrl+F11"},
            {"path": "/p/two", "hotkey": " Ctrl+F12 "},
            {"path": "", "hotkey": "Ctrl+F9"},
        ]));
        assert_eq!(
            wanted_from_state(&s, "tracker-host"),
            Some(vec![
                Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() },
                Project { cwd: "/p/two".into(), hotkey: "Ctrl+F12".into() },
            ])
        );
    }

    /// Отпечаток нужен затем же, зачем и у состояния: перевешивать клавиши на
    /// каждый секундный опрос — значит снимать и ставить регистрацию в системе
    /// шестьдесят раз в минуту.
    #[test]
    fn the_same_list_has_the_same_fingerprint() {
        let a = vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() }];
        let b = vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() }];
        assert_eq!(fingerprint(&a), fingerprint(&b));
    }

    #[test]
    fn a_changed_key_changes_the_fingerprint() {
        let a = vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() }];
        let b = vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F12".into() }];
        assert_ne!(fingerprint(&a), fingerprint(&b));
        assert_ne!(fingerprint(&a), fingerprint(&[]));
    }
}
