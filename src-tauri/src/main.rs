#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
// GlobalShortcutExt — тот самый трейт, без которого `app.global_shortcut()`
// не резолвится.
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

mod proc;
mod state_source;
mod window_source;

/// Кнопка, снятая неровно, даёт две посылки подряд, и вторая закрывала бы
/// только что открытое окно. Тот же ограничитель стоит в соседнем пикере.
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

/// Иконка трея.
///
/// Отдельная от иконки приложения: `default_window_icon` — это `icon.png`
/// 512×512, и система ужимала его до размера строки меню, размазывая детали.
/// `favicon.png` нарисован сразу под 16×16. Вшивается в бинарь на компиляции,
/// а не читается с диска: иначе иконка зависела бы от рабочего каталога и
/// пропадала бы в собранном приложении.
fn tray_icon() -> tauri::image::Image<'static> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/favicon.png"))
        .expect("icons/favicon.png не разбирается как изображение")
}

/// Хост берётся из конфига, а не зашит: список и открытие сессии обязаны
/// ходить на одну машину. Раньше здесь стоял литерал, а `open-strategy.js`
/// читал `sshHost` из конфига, и правка конфига молча разводила их по разным
/// хостам.
fn check_ssh_host(ssh_host: &str) -> Result<(), String> {
    if ssh_host.trim().is_empty() {
        return Err(
            "sshHost не задан: скопируйте config.example.yml в ~/.config/ccfzf-picker/config.yaml"
                .to_string(),
        );
    }
    Ok(())
}

/// Спросить агрегатор.
///
/// `async` и `spawn_blocking` здесь не украшение. Синхронную команду Tauri
/// исполняет в главном потоке, а внутри — ssh на другую машину секунд на
/// полсекунды: окно замирало на это время каждый опрос, то есть раз в секунду.
/// `async` уводит вызов в рантайм, `spawn_blocking` — на поток для блокирующей
/// работы, чтобы не занимать им рабочий поток рантайма.
#[tauri::command]
async fn fetch_state(ssh_host: String) -> Result<serde_json::Value, String> {
    check_ssh_host(&ssh_host)?;
    tauri::async_runtime::spawn_blocking(move || state_source::fetch(&ssh_host))
        .await
        .map_err(|e| format!("fetch_state task failed: {e}"))?
}

/// Спросить оконный трекер, у какой сессии открыто окно терминала.
///
/// `async` + `spawn_blocking` по той же причине, что и у `fetch_state`: вызов
/// уходит по сети и тикает раз в секунду, а синхронная команда исполнялась бы
/// в главном потоке и подвешивала окно на каждый опрос.
#[tauri::command]
async fn fetch_windows(url: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || window_source::fetch(&url))
        .await
        .map_err(|e| format!("fetch_windows task failed: {e}"))?
}

/// Выдать процессу трекера право занять передний план.
///
/// Windows позволяет вызвать `SetForegroundWindow` только процессу, который
/// передним планом уже владеет либо получил последнее событие ввода. Демон
/// трекера — не тот и не другой: к моменту запроса он просто отвечает на http.
/// Право ему передаёт пикер, и именно сейчас: нажатие, из-за которого мы здесь,
/// было последним событием ввода, и оно наше. Без этого `bringToTop()` на той
/// стороне отчитается об успехе, а на экране мигнёт кнопка на таскбаре.
///
/// `pid` берётся из ответа `/claude-wt/status` — трекер кладёт туда свой.
/// Отказ не фатален: он значит ровно то же, что и отсутствие грамоты, — окно
/// не поднимется, а пикер об этом узнает из ответа трекера.
#[cfg(target_os = "windows")]
fn allow_tracker_foreground(pid: u32) {
    use windows::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;
    if let Err(e) = unsafe { AllowSetForegroundWindow(pid) } {
        eprintln!("ccfzf-picker: cannot grant foreground to pid {pid}: {e}");
    }
}

#[cfg(not(target_os = "windows"))]
fn allow_tracker_foreground(_pid: u32) {}

/// Поднять окно сессии через трекер.
///
/// Зовётся вместо `spawn_detached` у стратегии `focus`: окно уже открыто, и
/// заводить рядом второй процесс на том же транскрипте незачем.
#[tauri::command]
async fn focus_window(url: String, id: String, pid: u32) -> Result<serde_json::Value, String> {
    // До запроса, а не после: право должно быть у трекера к моменту, когда он
    // дойдёт до подъёма окна.
    allow_tracker_foreground(pid);
    tauri::async_runtime::spawn_blocking(move || window_source::focus(&url, &id))
        .await
        .map_err(|e| format!("focus_window task failed: {e}"))?
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
///
/// Единственное место, которое сознательно идёт мимо `proc::hidden_command`:
/// здесь окно и есть цель. Спрятать его значило бы открыть сессию, которую
/// человек не увидит.
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
///
/// Утилита поднимается через `proc::hidden_command`: `clip` — консольная
/// программа, и без флага она мигала бы своим окном на каждое копирование.
#[tauri::command]
fn copy_to_clipboard(text: String) -> Result<(), String> {
    use std::io::Write;
    let tool = CLIPBOARD_TOOL;
    let mut child = proc::hidden_command(tool)
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

fn state_path(name: &str) -> Result<std::path::PathBuf, String> {
    let home = home_dir().ok_or("neither HOME nor USERPROFILE is set")?;
    Ok(std::path::Path::new(&home).join(".config/ccfzf-picker").join(name))
}

/// Отсутствующий файл — пустой объект, а не отказ: до первого сохранения его и
/// не должно быть.
fn load_json(name: &str) -> Result<serde_json::Value, String> {
    let path = state_path(name)?;
    match std::fs::read_to_string(&path) {
        Ok(t) => serde_json::from_str(&t).map_err(|e| format!("bad json in {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Запись через временный файл и переименование: читатель никогда не видит
/// половину файла.
fn save_json(name: &str, value: &serde_json::Value) -> Result<(), String> {
    let path = state_path(name)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string(value).map_err(|e| format!("cannot serialize {name}: {e}"))?;
    std::fs::write(&tmp, text).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("cannot rename onto {}: {e}", path.display()))
}

/// Отметки «эту сессию человек уже видел», id -> epoch-секунды.
#[tauri::command]
fn load_seen() -> Result<serde_json::Value, String> {
    load_json("seen.json")
}

#[tauri::command]
fn save_seen(seen: serde_json::Value) -> Result<(), String> {
    save_json("seen.json", &seen)
}

/// Вид списка: сортировка и чекбоксы statusline.
///
/// Отдельным файлом, а не в config.yaml: конфиг пишет человек, а это пикер
/// меняет на каждый клик — переписывая чужой файл, он затирал бы комментарии.
/// На Windows то же самое помнит бэкенд соседнего пикера, здесь бэкенда нет.
#[tauri::command]
fn load_ui() -> Result<serde_json::Value, String> {
    load_json("ui.json")
}

#[tauri::command]
fn save_ui(ui: serde_json::Value) -> Result<(), String> {
    save_json("ui.json", &ui)
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

/// То же умолчание в записи для меню трея.
///
/// Лежит рядом с `default_picker_shortcut`, потому что разойтись им нельзя:
/// меню обещало бы одну клавишу, а слушалась бы другая. Что это одна и та же
/// комбинация, сторожит тест.
const DEFAULT_HOTKEY_ACCELERATOR: &str = "Super+Shift+C";

/// Действующий хоткей пикера и запись, которой его показывать в меню.
///
/// Запись нельзя взять у самого `Shortcut`: его `Display` печатает
/// `shift+super+KeyC` — форма для разбора, а не для человека. Поэтому наружу
/// идёт строка из конфига как написана, а при откате к умолчанию — запись
/// умолчания. Показывается именно действующий хоткей: непонятая строка в меню
/// обещала бы клавишу, которой никто не слушает.
fn picker_hotkey(config: &serde_json::Value) -> (Shortcut, String) {
    if let Some(s) = config.get("hotkey").and_then(|v| v.as_str()) {
        match s.parse::<Shortcut>() {
            Ok(sc) => return (sc, s.to_string()),
            Err(_) => eprintln!("ccfzf-picker: cannot parse hotkey {s}, using default"),
        }
    }
    (
        default_picker_shortcut(),
        DEFAULT_HOTKEY_ACCELERATOR.to_string(),
    )
}

/// Подпись пункта «показать» в меню трея.
///
/// Про занятый хоткей говорит подпись, а не правая колонка: колонка — нативный
/// слот акселератора, и произвольный текст туда не положить. Сама комбинация
/// при этом остаётся на месте — человеку надо видеть, какая именно клавиша не
/// сработала, а не только то, что что-то не сработало.
fn show_item_label(hotkey_registered: bool) -> &'static str {
    if hotkey_registered {
        "Показать список"
    } else {
        "Хоткей занят, жмите сюда"
    }
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
            copy_to_clipboard, load_ui, save_ui, fetch_windows, focus_window
        ])
        .setup(move |app| {
            // Пикер живёт в строке меню, а не в Dock: его вызывают хоткеем из
            // любого приложения, окно у него одно и то безрамочное. Иконка в
            // Dock обещала бы окно, которое можно найти мышью, — а найти его
            // можно только клавишей. Accessory снимает и иконку, и пункт в
            // переключателе задач.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

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

            let (picker_shortcut, hotkey_accelerator) = picker_hotkey(&config);
            // Занятый хоткей — не повод не запуститься. Клавишу мог отобрать и
            // сосед по системе, и сама система (так Windows держит за собой
            // `Win+Shift+T`, прежнее умолчание пикера), а
            // окно всё это время можно поднять из трея. Падение на старте
            // отняло бы и трей.
            //
            // Ответ запоминается: меню трея ниже говорит им, работает клавиша
            // или окно осталось только на иконке. Сообщение в stderr эту
            // разницу тоже пишет, но stderr у приложения из Finder не читает
            // никто.
            let hotkey_registered = match app
                .global_shortcut()
                .on_shortcut(picker_shortcut, |app, _sc, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_picker(app);
                    }
                }) {
                Ok(()) => true,
                Err(e) => {
                    eprintln!(
                        "ccfzf-picker: cannot register picker hotkey: {e}; окно поднимается из трея"
                    );
                    false
                }
            };

            // Меню трея строится здесь, а не в начале setup: ему нужны и
            // хоткей, и то, чем кончилась его регистрация.
            //
            // Акселератор — украшение, и разбирает его не тот код, что хоткей
            // (muda против global-hotkey). Строку, которую muda не понял,
            // `with_id` вернёт ошибкой, а `?` уронил бы приложение на старте —
            // из-за подписи в меню. Поэтому отказ означает пункт без правой
            // колонки, а не отсутствие трея.
            let label = show_item_label(hotkey_registered);
            let show_item = match MenuItem::with_id(
                app,
                "show",
                label,
                true,
                Some(hotkey_accelerator.as_str()),
            ) {
                Ok(item) => item,
                Err(e) => {
                    eprintln!(
                        "ccfzf-picker: cannot show hotkey {hotkey_accelerator} in tray menu: {e}"
                    );
                    MenuItem::with_id(app, "show", label, true, None::<&str>)?
                }
            };
            let quit_item = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            TrayIconBuilder::new()
                .icon(tray_icon())
                // Иконка одноцветная и просвечивает фоном: система сама красит
                // её под светлую и тёмную строку меню. Без template-режима
                // белый глиф пропадал бы на светлом фоне.
                .icon_as_template(true)
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

    /// Запись умолчания для меню — та же клавиша, что и само умолчание.
    ///
    /// Два значения живут рядом и меняются порознь: поправив одно, легко забыть
    /// второе, и тогда меню обещает клавишу, которой никто не слушает.
    #[test]
    fn default_accelerator_matches_default_shortcut() {
        assert_eq!(
            DEFAULT_HOTKEY_ACCELERATOR.parse::<Shortcut>().unwrap(),
            default_picker_shortcut()
        );
    }

    /// В меню показывается тот хоткей, который слушается на самом деле.
    ///
    /// Развилок три, и врать нельзя ни в одной: своя строка из конфига, откат к
    /// умолчанию на мусоре и откат при отсутствии ключа. Непонятая строка,
    /// доехавшая до меню, обещала бы несуществующую клавишу.
    #[test]
    fn picker_hotkey_shows_what_is_listened_to() {
        let own = serde_json::json!({ "hotkey": "Cmd+Shift+T" });
        let (sc, accel) = picker_hotkey(&own);
        assert_eq!(sc, "Cmd+Shift+T".parse::<Shortcut>().unwrap());
        assert_eq!(accel, "Cmd+Shift+T");

        for config in [
            serde_json::json!({ "hotkey": "не хоткей" }),
            serde_json::json!({}),
            serde_json::Value::Null,
        ] {
            let (sc, accel) = picker_hotkey(&config);
            assert_eq!(sc, default_picker_shortcut(), "конфиг {config}");
            assert_eq!(accel, DEFAULT_HOTKEY_ACCELERATOR, "конфиг {config}");
        }
    }

    /// Про занятый хоткей меню говорит подписью, и подписи эти разные.
    #[test]
    fn tray_label_tells_when_hotkey_is_taken() {
        assert_eq!(show_item_label(true), "Показать список");
        assert_ne!(show_item_label(false), show_item_label(true));
    }

    /// Опрос агрегатора не поднимает процессов мимо `proc::hidden_command`.
    ///
    /// Сторожит ту самую поломку, ради которой `proc.rs` и появился: на Windows
    /// `Command::new("ssh")` из GUI-процесса всплывал консольным окном на
    /// каждый опрос — раз в секунду, — уводил фокус, и `hideOnBlur` гасил
    /// пикер. Поймать это тестом поведения нельзя: флаги `Command` обратно не
    /// читаются, а окно есть только на Windows и только в release. Поэтому
    /// сторожится форма: в файле опроса не должно остаться голого
    /// `Command::new`.
    #[test]
    fn state_poll_spawns_ssh_without_console() {
        let src = include_str!("state_source.rs");
        assert!(
            src.contains("hidden_command(\"ssh\")"),
            "опрос должен поднимать ssh через proc::hidden_command"
        );
        // Ищется форма вызова, а не слово: `Command::new` упоминается в
        // тамошнем комментарии, и проверка на подстроку без скобки ловила бы
        // его же.
        assert!(
            !src.contains("Command::new("),
            "в state_source.rs остался голый Command::new( — вернётся консольное окно"
        );
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

    /// Пустой `sshHost` — это ненастроенный конфиг, а не «сходи в никуда».
    /// Без этой проверки ssh звался бы с пустым первым аргументом и человек
    /// увидел бы невнятную ошибку ssh вместо «настройте config.yaml».
    #[test]
    fn empty_ssh_host_is_a_config_error() {
        let err = check_ssh_host("").unwrap_err();
        assert!(err.contains("config.yaml"), "{err}");
        assert!(check_ssh_host("example-host").is_ok());
        assert!(check_ssh_host("  ").is_err(), "пробелы — тот же пустой хост");
    }
}
