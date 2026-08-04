#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::time::{Duration, Instant};

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

fn main() {
    let picker_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyT);
    // Отдельный экземпляр под хендлер: он уезжает в замыкание плагина, а
    // регистрация в setup ниже забирает исходный.
    let handled_shortcut = picker_shortcut;

    tauri::Builder::default()
        .manage(LastToggle(Mutex::new(None)))
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    // Хендлер плагина общий на все зарегистрированные хоткеи, а
                    // не только на свой. Без сверки проектные хоткеи из Task 14
                    // поднимали бы окно пикера — ровно то, чего они делать не
                    // должны: они открывают сессию мимо списка.
                    if shortcut == &handled_shortcut && event.state() == ShortcutState::Pressed {
                        toggle_picker(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![hide_picker, fetch_state])
        .setup(move |app| {
            app.global_shortcut().register(picker_shortcut)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ccfzf-picker");
}
