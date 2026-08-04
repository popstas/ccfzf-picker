#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
// GlobalShortcutExt — тот самый трейт, без которого `app.global_shortcut()`
// не резолвится.
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

mod state_source;

/// Кнопка, снятая неровно, даёт две посылки подряд, и вторая закрывала бы
/// только что открытое окно. Тот же ограничитель стоит в neighbor-picker.
const DEBOUNCE: Duration = Duration::from_millis(400);

struct LastToggle(Mutex<Option<Instant>>);

/// Окно скрыто — сказать об этом фронтенду.
///
/// Опрос `ccfzf --state` идёт по ssh на другую машину и должен прекращаться
/// вместе с показом. Само по себе скрытое окно webview этого не сообщает:
/// `visibilitychange` на скрытом окне Tauri не приходит, так что единственный
/// надёжный сигнал — этот. Отсюда и требование звать `hide_window` вместо
/// голого `window.hide()` в каждой ветке.
fn hide_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("picker") else { return };
    let _ = window.hide();
    let _ = app.emit("picker-hidden", ());
}

fn toggle_picker(app: &tauri::AppHandle) {
    let state = app.state::<LastToggle>();
    {
        let mut last = state.0.lock().unwrap();
        let now = Instant::now();
        if let Some(prev) = *last {
            if now.duration_since(prev) < DEBOUNCE {
                return;
            }
        }
        *last = Some(now);
    }

    let Some(window) = app.get_webview_window("picker") else { return };
    if window.is_visible().unwrap_or(false) {
        hide_window(app);
    } else {
        let _ = window.show();
        let _ = window.set_focus();
        // Список обновляется на показе: между открытиями он устаревает, а
        // опрашивать закрытый пикер незачем.
        let _ = app.emit("picker-shown", ());
    }
}

#[tauri::command]
fn hide_picker(app: tauri::AppHandle) {
    hide_window(&app);
}

#[tauri::command]
fn fetch_state() -> Result<serde_json::Value, String> {
    // Хост зашит до Task 14, где появляется конфиг.
    state_source::fetch("example-host")
}

/// Конфиг читается сырым и разбирается во фронтенде той же функцией, что и
/// тесты. Отсутствующий файл — не ошибка: умолчания рассчитаны на работу без
/// него.
#[tauri::command]
fn load_config() -> Result<serde_json::Value, String> {
    let Some(home) = std::env::var_os("HOME") else {
        return Ok(serde_json::Value::Null);
    };
    let path = std::path::Path::new(&home).join(".config/ccfzf-picker/config.yaml");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(serde_json::Value::Null),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    serde_yaml::from_str(&text).map_err(|e| format!("bad yaml in {}: {e}", path.display()))
}

/// Запуск терминала. Открепляется сразу: пикер не ждёт, пока человек
/// закончит работать в сессии, и не держит его вывод.
#[tauri::command]
fn spawn_detached(argv: Vec<String>) -> Result<(), String> {
    let Some((file, args)) = argv.split_first() else {
        return Err("empty argv".into());
    };
    std::process::Command::new(file)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to spawn {file}: {e}"))
}

/// Положить текст в буфер обмена.
///
/// Через pbcopy, а не плагином: единственное, что пикеру нужно от буфера, —
/// отдать человеку строку с командой, и ради этого тянуть ещё одну зависимость
/// не за что. pbcopy есть в любой macOS.
#[tauri::command]
fn copy_to_clipboard(text: String) -> Result<(), String> {
    use std::io::Write;
    let mut child = std::process::Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn pbcopy: {e}"))?;
    child
        .stdin
        .as_mut()
        .ok_or("pbcopy has no stdin")?
        .write_all(text.as_bytes())
        .map_err(|e| format!("cannot write to pbcopy: {e}"))?;
    // Ждать обязательно: pbcopy забирает буфер, только закончив читать stdin, а
    // открепившийся процесс мог бы не успеть до того, как человек нажмёт Cmd+V.
    let status = child.wait().map_err(|e| format!("pbcopy failed: {e}"))?;
    if !status.success() {
        return Err(format!("pbcopy exited with {status}"));
    }
    Ok(())
}

fn seen_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    Ok(std::path::Path::new(&home).join(".config/ccfzf-picker/seen.json"))
}

/// Отметки «эту сессию человек уже видел», id -> epoch-секунды.
/// Отсутствующий файл — это пустая карта, а не отказ: до первого открытия
/// сессии его и не должно быть.
#[tauri::command]
fn load_seen() -> Result<serde_json::Value, String> {
    let path = seen_path()?;
    match std::fs::read_to_string(&path) {
        Ok(t) => serde_json::from_str(&t).map_err(|e| format!("bad json in {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Запись через временный файл и переименование: читатель никогда не видит
/// половину карты.
#[tauri::command]
fn save_seen(seen: serde_json::Value) -> Result<(), String> {
    let path = seen_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string(&seen).map_err(|e| format!("cannot serialize seen: {e}"))?;
    std::fs::write(&tmp, text).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("cannot rename onto {}: {e}", path.display()))
}

/// Хоткей пикера по умолчанию: `Cmd+Shift+T`.
///
/// Умолчание живёт здесь, а не только в config-shape.js: без файла конфига
/// фронтенд его и не увидит, а окно поднимать всё равно чем-то надо.
fn default_picker_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyT)
}

fn main() {
    tauri::Builder::default()
        .manage(LastToggle(Mutex::new(None)))
        .plugin(tauri_plugin_shell::init())
        // Без общего with_handler: он зовётся на каждый зарегистрированный
        // хоткей, и одна ветка внутри него разбирала бы, чей это был. Здесь у
        // каждого хоткея свой обработчик — пикерный поднимает окно, проектный
        // шлёт событие, и перепутать их нечем.
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            hide_picker, fetch_state, spawn_detached, load_seen, save_seen, load_config,
            copy_to_clipboard
        ])
        .setup(move |app| {
            // Пикер живёт в строке меню, а не в Dock: его вызывают хоткеем из
            // любого приложения, окно у него одно и то безрамочное. Иконка в
            // Dock обещала бы окно, которое можно найти мышью, — а найти его
            // можно только клавишей. Accessory снимает и иконку, и пункт в
            // переключателе задач.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let show_item = MenuItem::with_id(app, "show", "Показать список", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                // Левая кнопка переключает окно, меню — под правой. Иначе
                // самый частый жест (показать список) требовал бы двух
                // движений вместо одного.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => toggle_picker(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_picker(tray.app_handle());
                    }
                })
                .build(app)?;

            // Испорченный конфиг не должен оставлять человека без пикера:
            // отказ читается как «конфига нет», и дальше идут умолчания. О
            // самой поломке фронтенд скажет отдельно — он читает тот же файл
            // и печатает ошибку в статуслайн.
            let config = load_config().unwrap_or(serde_json::Value::Null);

            let picker_shortcut = config
                .get("hotkey")
                .and_then(|v| v.as_str())
                .and_then(|s| match s.parse::<Shortcut>() {
                    Ok(sc) => Some(sc),
                    Err(_) => {
                        eprintln!("ccfzf-picker: cannot parse hotkey {s}, using default");
                        None
                    }
                })
                .unwrap_or_else(default_picker_shortcut);
            app.global_shortcut()
                .on_shortcut(picker_shortcut, |app, _sc, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_picker(app);
                    }
                })?;

            // Проектный хоткей открывает новую сессию мимо списка, поэтому
            // окно пикера не поднимается: наружу уходит только событие.
            let projects = config
                .get("projects")
                .and_then(|p| p.as_array())
                .cloned()
                .unwrap_or_default();
            for item in projects {
                let (Some(path), Some(hotkey)) = (
                    item.get("path").and_then(|v| v.as_str()),
                    item.get("hotkey").and_then(|v| v.as_str()),
                ) else { continue };
                if hotkey.is_empty() { continue }
                let Ok(sc) = hotkey.parse::<Shortcut>() else {
                    eprintln!("ccfzf-picker: cannot parse hotkey {hotkey}");
                    continue;
                };
                let handle = app.handle().clone();
                let path = path.to_string();
                app.global_shortcut().on_shortcut(sc, move |_app, _sc, event| {
                    if event.state() == ShortcutState::Pressed {
                        let _ = handle.emit("project-hotkey", path.clone());
                    }
                })?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ccfzf-picker");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Хоткеи из конфига разбираются той же строкой, какой их пишет человек.
    ///
    /// Проверка нужна потому, что в бою неразобранный хоткей только пишет в
    /// stderr и молча пропускается: приложение при этом работает, а клавиша
    /// не отзывается — заметить это можно лишь пальцами.
    #[test]
    fn config_hotkeys_parse() {
        for s in ["Cmd+Shift+T", "Cmd+Shift+1", "Cmd+Shift+2"] {
            assert!(s.parse::<Shortcut>().is_ok(), "не разобрался хоткей {s}");
        }
        assert_eq!("Cmd+Shift+T".parse::<Shortcut>().unwrap(), default_picker_shortcut());
        assert!("не хоткей".parse::<Shortcut>().is_err());
    }

    /// Конфиг доезжает до фронтенда теми же типами, какими написан.
    ///
    /// Разбирает его serde_yaml, а решения по нему принимает normalizeConfig в
    /// JS, и между ними стоит перевод yaml -> json. Приедь `reptyr` строкой
    /// «true» или `args` не массивом — normalizeConfig молча вернул бы
    /// умолчания, и единственным следом была бы клавиша, которая не работает.
    #[test]
    fn config_yaml_keeps_its_types() {
        let text = r#"
sshHost: example-host
hotkey: Cmd+Shift+T
caps:
  reptyr: true
terminal:
  file: open
  args: ['-na', 'kitty', '--args']
projects:
  - path: /home/user/projects/demo
    hotkey: Cmd+Shift+1
"#;
        let v: serde_json::Value = serde_yaml::from_str(text).unwrap();
        assert_eq!(v["sshHost"].as_str(), Some("example-host"));
        assert_eq!(v["caps"]["reptyr"].as_bool(), Some(true));
        assert_eq!(v["terminal"]["file"].as_str(), Some("open"));
        assert_eq!(v["terminal"]["args"].as_array().unwrap().len(), 3);
        let projects = v["projects"].as_array().unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0]["hotkey"].as_str(), Some("Cmd+Shift+1"));
    }
}
