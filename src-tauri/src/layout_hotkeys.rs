//! Две клавиши раскладки окон: плитка (`tileHotkey`) и группа head
//! (`groupTileHotkey`).
//!
//! Разрешаются вместе, потому что на Windows делят одну комбинацию:
//! `Ctrl+Win+F10` был у плитки, а по решению владельца (2026-11-11) перешёл к
//! раскладке группы. Плитка осталась без клавиши, но с кнопкой, MQTT и CLI.
//!
//! У обоих ключей три состояния, а не два, как у соседних хоткеев:
//! пусто — «взять встроенное» (своё на каждой системе и известное только
//! здесь), `none` — «выключить», остальное — комбинация. Третье понадобилось
//! потому, что у каждой из двух клавиш на одной из систем встроенного нет, и
//! выключить её на другой иначе было бы нечем.

use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

/// Клавиша и её запись для показа — ровно то, что человек написал в конфиге,
/// либо запись встроенного умолчания.
pub type Hotkey = (Shortcut, String);

/// Чем кончилось разрешение двух клавиш.
pub struct LayoutHotkeys {
    /// `None` — клавиши нет: выключена, встроенной нет или отдана группе.
    pub tile: Option<Hotkey>,
    pub group: Option<Hotkey>,
    /// Строка `tileHotkey`, совпавшая с клавишей группы. Окно настроек
    /// называет её не вставшей: молча отобранная клавиша выглядела бы
    /// сломанной.
    pub tile_lost: Option<String>,
}

/// `none` в поле хоткея — «выключить». Та же формула, что `isOff` в
/// `frontend-src/settings-form.js`.
pub fn is_off(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("none")
}

/// Встроенная клавиша плитки. На маке — прежняя `Ctrl+Option+Cmd+C`: это та
/// комбинация, которую пикер забрал у `macos-windows-manager`, и мак не
/// должен терять рабочую клавишу. На Windows её нет: `Ctrl+Win+F10` у группы.
#[cfg(target_os = "macos")]
pub fn default_tile() -> Option<Hotkey> {
    Some((
        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER), Code::KeyC),
        "Control+Alt+Super+C".to_string(),
    ))
}

#[cfg(not(target_os = "macos"))]
pub fn default_tile() -> Option<Hotkey> {
    None
}

/// Встроенная клавиша группы. На маке её нет: раскладки группы там нет, и
/// `macos-windows-manager` незнакомый режим молча отбрасывает.
#[cfg(target_os = "macos")]
pub fn default_group() -> Option<Hotkey> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn default_group() -> Option<Hotkey> {
    Some((
        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SUPER), Code::F10),
        "Control+Super+F10".to_string(),
    ))
}

/// Одна клавиша из конфига: пусто — встроенная, `none` — никакой, мусор —
/// встроенная с жалобой в журнал, как у `projects_hotkey`.
fn optional_hotkey(config: &serde_json::Value, key: &str, default: Option<Hotkey>) -> Option<Hotkey> {
    let Some(s) = config
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
    else {
        return default;
    };
    if is_off(s) {
        return None;
    }
    match s.parse::<Shortcut>() {
        Ok(sc) => Some((sc, s.to_string())),
        Err(_) => {
            ccfzf_log!("cannot parse {key} {s}, using default");
            default
        }
    }
}

/// Обе клавиши раскладки разом.
///
/// Совпали — клавишу получает группа. Сравниваются разобранные комбинации:
/// `Ctrl+Super+F10` и `Control+Super+F10` строками разные, а клавиша одна, и
/// вторая регистрация на неё проиграла бы молча.
pub fn layout_hotkeys(config: &serde_json::Value) -> LayoutHotkeys {
    let group = optional_hotkey(config, "groupTileHotkey", default_group());
    let mut tile = optional_hotkey(config, "tileHotkey", default_tile());
    let mut tile_lost = None;
    if let (Some(t), Some(g)) = (&tile, &group) {
        if t.0 == g.0 {
            ccfzf_log!("tileHotkey {} is the same as groupTileHotkey, the group layout takes it", t.1);
            tile_lost = Some(t.1.clone());
            tile = None;
        }
    }
    LayoutHotkeys { tile, group, tile_lost }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Умолчания свои на каждой системе: на Windows `Ctrl+Win+F10` перешёл к
    /// группе, а плитка осталась без клавиши; на маке группы нет, плитка
    /// держит прежнюю комбинацию.
    #[test]
    fn defaults_differ_by_system() {
        let h = layout_hotkeys(&json!({}));
        #[cfg(not(target_os = "macos"))]
        {
            assert!(h.tile.is_none(), "плитка на Windows без клавиши");
            assert_eq!(h.group.as_ref().unwrap().1, "Control+Super+F10");
        }
        #[cfg(target_os = "macos")]
        {
            assert_eq!(h.tile.as_ref().unwrap().1, "Control+Alt+Super+C");
            assert!(h.group.is_none(), "группы на маке нет");
        }
        assert!(h.tile_lost.is_none());
    }

    /// Запись умолчания разбирается в ту же клавишу: разойдись они, показано
    /// было бы одно, а слушалось другое.
    #[test]
    fn built_in_records_parse_into_their_keys() {
        for (sc, accel) in [default_tile(), default_group()].into_iter().flatten() {
            assert_eq!(accel.parse::<Shortcut>().unwrap(), sc, "{accel}");
        }
    }

    /// Пусто — «взять встроенное», как у всех хоткеев пикера; `none` —
    /// «выключить», без учёта регистра и пробелов.
    #[test]
    fn empty_means_built_in_and_none_means_off() {
        let empty = layout_hotkeys(&json!({ "tileHotkey": "  ", "groupTileHotkey": "" }));
        let dflt = layout_hotkeys(&json!({}));
        assert_eq!(empty.group.map(|h| h.1), dflt.group.map(|h| h.1));
        assert_eq!(empty.tile.map(|h| h.1), dflt.tile.map(|h| h.1));
        let off = layout_hotkeys(&json!({ "tileHotkey": " None ", "groupTileHotkey": "none" }));
        assert!(off.tile.is_none() && off.group.is_none() && off.tile_lost.is_none());
        assert!(is_off(" NONE "));
        assert!(!is_off(""));
        assert!(!is_off("Ctrl+N"));
    }

    /// Одна клавиша на две раскладки — вторая регистрация молча проиграла бы.
    /// Клавишу забирает группа; сравниваются разобранные комбинации, а не
    /// строки: `Ctrl` и `Control` — одна и та же клавиша.
    #[test]
    fn the_same_key_goes_to_the_group_layout() {
        for tile in ["Ctrl+Super+F10", "Control+Super+F10"] {
            let h = layout_hotkeys(&json!({ "tileHotkey": tile, "groupTileHotkey": "Control+Super+F10" }));
            assert!(h.tile.is_none(), "{tile}: плитка обязана уступить");
            assert_eq!(h.group.unwrap().1, "Control+Super+F10");
            assert_eq!(h.tile_lost.as_deref(), Some(tile));
        }
    }

    /// Свои клавиши слушаются; мусор откатывается на встроенное, как у
    /// соседних хоткеев.
    #[test]
    fn own_keys_are_listened_to_and_garbage_falls_back() {
        let h = layout_hotkeys(&json!({ "tileHotkey": "Cmd+Shift+T", "groupTileHotkey": "не хоткей" }));
        let tile = h.tile.unwrap();
        assert_eq!(tile.0, "Cmd+Shift+T".parse::<Shortcut>().unwrap());
        assert_eq!(tile.1, "Cmd+Shift+T");
        assert_eq!(h.group.map(|g| g.1), layout_hotkeys(&json!({})).group.map(|g| g.1));
        // Чужие ключи этим двум не указ.
        let other = layout_hotkeys(&json!({ "hotkey": "Cmd+Shift+T", "historyHotkey": "Cmd+Shift+Y" }));
        assert_eq!(other.tile.map(|h| h.1), layout_hotkeys(&json!({})).tile.map(|h| h.1));
    }
}
