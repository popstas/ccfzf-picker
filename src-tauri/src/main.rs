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

/// Когда окно погасло в последний раз. См. `picker_toggle`.
struct LastHidden(Mutex<Option<Instant>>);

/// Показывать ли окно по нажатию.
///
/// `just_hidden` — окно погасло только что, в пределах `DEBOUNCE`. Без этой
/// отметки иконка в трее перестаёт гасить пикер: клик по ней сначала уводит
/// фокус, окно гаснет по blur, и только потом до обработчика доходит
/// отпускание кнопки — которое видит уже скрытое окно и показывает его заново.
/// `DEBOUNCE` в `toggle_picker` этот случай не ловит: он считает промежутки
/// между самими нажатиями и о гашении по blur ничего не знает.
///
/// Цена — своя: намеренное «Esc, сразу клик по иконке» в пределах `DEBOUNCE`
/// не покажет окно. Жест редкий, а обратный случай — иконка, которая не гасит,
/// — встречается на каждом клике.
fn picker_toggle(visible: bool, just_hidden: bool) -> bool {
    !visible && !just_hidden
}

/// Окно скрыто — сказать об этом фронтенду.
///
/// Опрос `ccfzf --state` идёт по ssh на другую машину и должен прекращаться
/// вместе с показом. Само по себе скрытое окно webview этого не сообщает:
/// `visibilitychange` на скрытом окне Tauri не приходит, так что единственный
/// надёжный сигнал — этот. Отсюда и требование звать `hide_window` вместо
/// голого `window.hide()` в каждой ветке.
///
/// Уже скрытое окно не гасится повторно: иначе Esc даёт две посылки
/// `picker-hidden` — сначала от явного скрытия, потом от потери фокуса, которая
/// заходит сюда же.
fn hide_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("picker") else { return };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let _ = window.hide();
    let _ = app.emit("picker-hidden", ());
    if let Some(state) = app.try_state::<LastHidden>() {
        *state.0.lock().unwrap() = Some(Instant::now());
    }
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
    let just_hidden = app
        .try_state::<LastHidden>()
        .and_then(|s| *s.0.lock().unwrap())
        .is_some_and(|t| Instant::now().duration_since(t) < DEBOUNCE);
    if picker_toggle(window.is_visible().unwrap_or(false), just_hidden) {
        let _ = window.show();
        let _ = window.set_focus();
        // Список обновляется на показе: между открытиями он устаревает, а
        // опрашивать закрытый пикер незачем.
        let _ = app.emit("picker-shown", ());
    } else {
        hide_window(app);
    }
}

#[tauri::command]
fn hide_picker(app: tauri::AppHandle) {
    hide_window(&app);
}

/// Спросить агрегатор.
///
/// `async` и `spawn_blocking` здесь не украшение. Синхронную команду Tauri
/// исполняет в главном потоке, а внутри — ssh на другую машину секунд на
/// полсекунды: окно замирало на это время каждый опрос, то есть раз в секунду.
/// `async` уводит вызов в рантайм, `spawn_blocking` — на поток для блокирующей
/// работы, чтобы не занимать им рабочий поток рантайма.
#[tauri::command]
async fn fetch_state() -> Result<serde_json::Value, String> {
    // Хост зашит до Task 14, где появляется конфиг.
    tauri::async_runtime::spawn_blocking(|| state_source::fetch("example-host"))
        .await
        .map_err(|e| format!("fetch_state task failed: {e}"))?
}

/// Конфиг читается сырым и разбирается во фронтенде той же функцией, что и
/// тесты. Отсутствующий файл — не ошибка: умолчания рассчитаны на работу без
/// него.
/// Домашний каталог человека.
///
/// На Windows `HOME` обычно не выставлен — там эту роль играет `USERPROFILE`.
/// Без запасного варианта пикер на Windows не видел бы ни конфига, ни отметок
/// просмотра и молча жил бы на умолчаниях.
fn home_dir() -> Option<std::ffi::OsString> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
}

#[tauri::command]
fn load_config() -> Result<serde_json::Value, String> {
    let Some(home) = home_dir() else {
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

/// Утилита, забирающая буфер обмена со стандартного ввода.
///
/// Своя на каждой системе, но обе есть из коробки: pbcopy в macOS, clip.exe в
/// Windows. Плагин ради одной строки с командой не за что тянуть.
#[cfg(target_os = "windows")]
const CLIPBOARD_TOOL: &str = "clip";
#[cfg(not(target_os = "windows"))]
const CLIPBOARD_TOOL: &str = "pbcopy";

/// Положить текст в буфер обмена.
#[tauri::command]
fn copy_to_clipboard(text: String) -> Result<(), String> {
    use std::io::Write;
    let tool = CLIPBOARD_TOOL;
    let mut child = std::process::Command::new(tool)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn {tool}: {e}"))?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| format!("{tool} has no stdin"))?
        .write_all(text.as_bytes())
        .map_err(|e| format!("cannot write to {tool}: {e}"))?;
    // Ждать обязательно: утилита забирает буфер, только закончив читать stdin, а
    // открепившийся процесс мог бы не успеть до того, как человек нажмёт Cmd+V.
    let status = child.wait().map_err(|e| format!("{tool} failed: {e}"))?;
    if !status.success() {
        return Err(format!("{tool} exited with {status}"));
    }
    Ok(())
}

fn seen_path() -> Result<std::path::PathBuf, String> {
    let home = home_dir().ok_or("neither HOME nor USERPROFILE is set")?;
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

/// Хоткей пикера по умолчанию: `Cmd+Shift+C` на macOS, `Win+Shift+C` на Windows.
///
/// Умолчание живёт здесь, а не только в config-shape.js: без файла конфига
/// фронтенд его и не увидит, а окно поднимать всё равно чем-то надо.
///
/// Развилки по системам нет: `SUPER` — это Cmd на маке и Win на Windows, то
/// есть одна запись даёт обе комбинации. Прежнее умолчание с `T` так не могло:
/// `Win+Shift+T` система держит за собой (переключение окон в панели задач),
/// `RegisterHotKey` отвечал на него «already registered».
fn default_picker_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyC)
}

fn main() {
    tauri::Builder::default()
        .manage(LastToggle(Mutex::new(None)))
        .manage(LastHidden(Mutex::new(None)))
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

            // Клик мимо окна закрывает пикер. Окно безрамочное и всегда
            // поверх: не закрывшись само, оно осталось бы висеть над той
            // работой, ради которой его и открывали. Ключ в конфиге на случай,
            // когда список нужен рядом с терминалом — например, чтобы читать
            // из него pid, пока набираешь команду в другом окне.
            let hide_on_blur = config
                .get("hideOnBlur")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            if hide_on_blur {
                if let Some(window) = app.get_webview_window("picker") {
                    let handle = app.handle().clone();
                    window.on_window_event(move |event| {
                        if let tauri::WindowEvent::Focused(false) = event {
                            hide_window(&handle);
                        }
                    });
                }
            }

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
            // Занятый хоткей — не повод не запуститься. Клавишу мог отобрать и
            // сосед по системе, и сама система (так Windows держит за собой
            // `Win+Shift+T`, прежнее умолчание пикера), а
            // окно всё это время можно поднять из трея. Падение на старте
            // отняло бы и трей.
            if let Err(e) = app
                .global_shortcut()
                .on_shortcut(picker_shortcut, |app, _sc, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_picker(app);
                    }
                })
            {
                eprintln!(
                    "ccfzf-picker: cannot register picker hotkey: {e}; окно поднимается из трея"
                );
            }

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
                if let Err(e) = app.global_shortcut().on_shortcut(sc, move |_app, _sc, event| {
                    if event.state() == ShortcutState::Pressed {
                        let _ = handle.emit("project-hotkey", path.clone());
                    }
                }) {
                    eprintln!("ccfzf-picker: cannot register hotkey {hotkey}: {e}");
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ccfzf-picker");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Клик по иконке в трее гасит пикер, а не мигает им.
    ///
    /// Порядок событий на этом клике: сначала окно теряет фокус и гаснет по
    /// blur, потом до обработчика доходит отпускание кнопки. Третья строка
    /// таблицы — про этот случай: окно уже скрыто, но скрыто **только что**,
    /// и показывать его заново нельзя. Проверка здесь потому, что руками это
    /// ловится только глазами и только на живом трее.
    #[test]
    fn tray_click_hides_instead_of_reopening() {
        assert!(picker_toggle(false, false), "скрытое окно открывается");
        assert!(!picker_toggle(true, false), "видимое окно гасится");
        assert!(!picker_toggle(false, true), "только что погасшее не всплывает");
        // Видимое окно, погасшее «только что», — состояние противоречивое
        // (гашение отмечается уже после hide), но решение то же: не показывать.
        assert!(!picker_toggle(true, true));
    }

    /// Хоткеи из конфига разбираются той же строкой, какой их пишет человек.
    ///
    /// Проверка нужна потому, что в бою неразобранный хоткей только пишет в
    /// stderr и молча пропускается: приложение при этом работает, а клавиша
    /// не отзывается — заметить это можно лишь пальцами.
    #[test]
    fn config_hotkeys_parse() {
        for s in ["Cmd+Shift+C", "Cmd+Shift+1", "Cmd+Shift+2"] {
            assert!(s.parse::<Shortcut>().is_ok(), "не разобрался хоткей {s}");
        }
        assert_eq!("Cmd+Shift+C".parse::<Shortcut>().unwrap(), default_picker_shortcut());
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
