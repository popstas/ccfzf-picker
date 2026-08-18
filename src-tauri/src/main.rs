#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{Local, NaiveDate, NaiveDateTime, TimeZone};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
// GlobalShortcutExt — тот самый трейт, без которого `app.global_shortcut()`
// не резолвится.
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

mod config_file;
mod icons;
mod mqtt;
mod poller;
mod proc;
mod project_hotkeys;
mod scrim;
mod state_source;

/// Кнопка, снятая неровно, даёт две посылки подряд, и вторая закрывала бы
/// только что открытое окно. Тот же ограничитель стоит в соседнем пикере.
const DEBOUNCE: Duration = Duration::from_millis(400);

struct LastToggle(Mutex<Option<Instant>>);

/// Когда окно погасло в последний раз. См. `picker_toggle`.
struct LastHidden(Mutex<Option<Instant>>);

/// Гасить ли пикер по потере фокуса — текущее значение `hideOnBlur`.
///
/// Живёт в разделяемом состоянии, а не в замыкании обработчика, потому что
/// снять уже зарегистрированный `on_window_event` в Tauri нечем. Обработчик
/// ставится один раз и навсегда, а решение принимает по этому флагу, который
/// переставляет `apply_config`. Регистрируй его по условию — и переключатель в
/// окне настроек молчал бы до перезапуска: выключение не сняло бы уже
/// поставленный обработчик, включение не добавило бы недостающий.
struct HideOnBlur(AtomicBool);

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

/// `hideOnBlur` из конфига. Умолчание — «гасить»: так пикер вёл себя всегда, и
/// отсутствие ключа не должно оставлять окно висеть поверх чужой работы.
fn hide_on_blur(config: &serde_json::Value) -> bool {
    config
        .get("hideOnBlur")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// То же значение, но действующее прямо сейчас.
///
/// Спрашивается в обработчике потери фокуса, а не при его регистрации, потому
/// что снять уже поставленный `on_window_event` в Tauri нечем: решай при
/// регистрации — и переключатель в окне настроек молчал бы до перезапуска.
/// Обработчик поэтому стоит всегда и на каждое событие смотрит на флаг, который
/// переставляет `apply_config` (см. `HideOnBlur`).
///
/// Состояния может не быть только до конца `setup`; тогда действует то же
/// умолчание, что и у конфига, — «гасить».
fn hide_on_blur_now(app: &tauri::AppHandle) -> bool {
    app.try_state::<HideOnBlur>()
        .map(|s| s.0.load(Ordering::Relaxed))
        .unwrap_or(true)
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
    // Подложка гасится безусловно, не спрашивая флаги: пикер спрятан — ни
    // одна раскладка не оправдывает затемнённый стол без списка над ним.
    if let Err(e) = scrim::set_visible(app, false) {
        eprintln!("ccfzf-picker: {e}");
    }
    let _ = app.emit("picker-hidden", ());
    if let Some(state) = app.try_state::<LastHidden>() {
        *state.0.lock().unwrap() = Some(Instant::now());
    }
    if let Some(poller) = app.try_state::<poller::Poller>() {
        poller.hidden();
    }
}

fn toggle_picker(app: &tauri::AppHandle) {
    toggle_window(app, None);
}

/// Второй хоткей: то же переключение, но открывшееся окно встаёт в режим
/// проектов.
///
/// Переключение, а не «только показать»: повторное нажатие обязано погасить
/// окно — того же ждут от любого хоткея пикера, и второй, ведущий себя иначе,
/// был бы неожиданностью. Дребезг у обоих общий (`LastToggle`), поэтому два
/// хоткея подряд не откроют окно дважды.
fn toggle_projects(app: &tauri::AppHandle) {
    toggle_window(app, Some(MODE_MENU[0].1));
}

/// Показать пикер в названном режиме — без переключения.
///
/// Так ведут себя все четыре пункта-режима в трее, и это не то же, что хоткей.
/// Хоткей нажимают вслепую, поэтому он переключает: повторное нажатие обязано
/// погасить окно. В меню же режим выбирают глазами, уже открыв трей, — выбрав
/// `History`, ждут историю, а не гашения окна, которое ради этого выбора и
/// открыли.
fn show_in_mode(app: &tauri::AppHandle, mode: &str) {
    show_picker(app);
    emit_mode(app, mode);
}

/// Сказать странице, с каким режимом открыться.
///
/// Режим живёт префиксом в строке поиска, а не флагом, и выставить его может
/// только страница — Rust про строку поиска не знает ничего. Отсюда два хода:
/// показать окно и назвать режим.
///
/// Событие одно на все режимы, с именем в теле, а не по событию на режим:
/// четыре имени событий на одной стороне и четыре подписки на другой — это
/// два списка, которые разошлись бы молча.
///
/// Уходит оно **после** `picker-shown`, и порядок этот обязателен: по
/// `picker-shown` страница чистит строку поиска (`beginShow`), и приди режим
/// раньше, префикс стёрло бы тем же показом, ради которого его и ставили.
fn emit_mode(app: &tauri::AppHandle, mode: &str) {
    let _ = app.emit("picker-mode", mode);
}

fn toggle_window(app: &tauri::AppHandle, mode: Option<&str>) {
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
        show_picker(app);
        if let Some(mode) = mode {
            emit_mode(app, mode);
        }
    } else {
        hide_window(app);
    }
}

/// Показать окно, не спрашивая, показано ли оно уже.
///
/// Отдельно от `toggle_picker` ради второго хоткея: тот открывает пикер сразу
/// в режиме проектов, и переключение там было бы неверным — нажатие на уже
/// открытом пикере обязано сменить режим, а не погасить окно, которое только
/// что открыли первым хоткеем.
fn show_picker(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("picker") else { return };
    let _ = window.show();
    // Раскладка на момент показа — та, что запомнена с прошлого раза
    // (`SizeRequest.fullscreen`); просьба о размере ниже может её сменить, но
    // подложка не обязана ждать: `apply_scrim` из `set_picker_size` перекроет
    // это значение, если страница вслед за показом попросит другой режим.
    apply_scrim(app, current_fullscreen(app));
    // Отложенный размер применяется здесь и только после `show()`: просьба,
    // пришедшая по скрытому окну, была отложена именно потому, что экрана у
    // такого окна нет. См. `SizeRequest`. Отказ стоит строки в stderr, а не
    // возврата: показ окна дороже размера, и не показать его из-за неудавшейся
    // центровки было бы хуже, чем показать не той ширины.
    if let Some(fullscreen) = app
        .try_state::<PickerSize>()
        .and_then(|state| state.0.lock().unwrap().shown())
    {
        if let Err(e) = apply_picker_size(&window, fullscreen, picker_scale_now(app)) {
            eprintln!("ccfzf-picker: {e}");
        }
    }
    let _ = window.set_focus();
    // Список обновляется на показе: между открытиями он устаревает, а
    // опрашивать закрытый пикер незачем.
    let _ = app.emit("picker-shown", ());
    if let Some(poller) = app.try_state::<poller::Poller>() {
        poller.shown();
    }
}

#[tauri::command]
fn hide_picker(app: tauri::AppHandle) {
    hide_window(&app);
}

/// Версия для шапки справочника клавиш (F1) на странице.
///
/// Номер уже читает пункт-подпись трея (`version_item_label` ниже) — здесь
/// та же константа компиляции, а не второе поле в конфиге: разошлась бы с
/// `Cargo.toml` при следующем релизе, и заметить это было бы нечем.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Размеры окна пикера.
///
/// Узкий обязан совпадать с `tauri.conf.json` — с ним пикер открывается, к
/// нему же возвращается выход из широкого режима; сторожит это тест.
/// Широкий — не весь экран намеренно: окно `alwaysOnTop`, и под ним должно
/// остаться видно, что было. По той же причине он ещё и зажимается по экрану:
/// 1400×900 на тринадцатидюймовом маке (логические 1440×900) закрывают экран
/// целиком и залезают под строку меню, а отступить некуда — окно без декораций
/// и drag-region, мышью его не подвинуть вовсе. Отсюда `SCREEN_FILL`: желаемое
/// или доля экрана, что меньше.
const NARROW_SIZE: (f64, f64) = (900.0, 640.0);
const WIDE_SIZE: (f64, f64) = (1400.0, 900.0);

/// Доля экрана, больше которой широкое окно не берёт. Остаток — та самая
/// полоса, по которой видно, что было под пикером.
const SCREEN_FILL: f64 = 0.9;

/// Размер окна настроек.
///
/// Высота 720 подходит теперь: предыдущая задача распределила поля вкладки
/// General по новым вкладкам и свернула Terminal / Terminal arguments в
/// `<details>`, поэтому самая длинная вкладка теперь короче. 720 держит окно
/// под экраном 1080p с запасом, поэтому `fit_to_screen` ничего не зажимает.
const SETTINGS_SIZE: (f64, f64) = (820.0, 720.0);

/// Зажать желаемый размер по логическому размеру экрана.
///
/// Чистая и отдельная от команды намеренно: монитора в тестах нет, а
/// арифметику проверить и нужно, и можно.
fn fit_to_screen(want: (f64, f64), screen: (f64, f64)) -> (f64, f64) {
    (fit_axis(want.0, screen.0), fit_axis(want.1, screen.1))
}

/// Ноль, отрицательное и NaN значат «сторона экрана неизвестна»: зажимать не
/// по чему, и отдать здесь долю такого экрана значило бы схлопнуть окно в
/// точку. Желаемое в этом случае честнее.
fn fit_axis(want: f64, screen: f64) -> f64 {
    if screen <= 0.0 || screen.is_nan() {
        return want;
    }
    want.min(screen * SCREEN_FILL)
}

/// Стороны окна, названные человеком, — по стороне на каждую раскладку.
///
/// Ноль значит «взять встроенный размер», и он же — умолчание: ключа в
/// `config.yaml` может не быть вовсе. Число `1..=100` — доля экрана в
/// процентах, а не пиксели: вопрос у человека обычно не «сколько точек», а
/// «сколько сессий влезет», и число пикселей, верное на одной машине, на
/// второй с другим экраном значит другое. Но иногда точный размер и нужен —
/// например, под конкретный монитор или чтобы вплотную поместить окно рядом с
/// другим приложением, — и для этого случая `101` и выше читаются буквально,
/// пикселями (см. `scale_axis`).
#[derive(Default, Clone, Copy, PartialEq, Debug)]
struct PickerScale {
    narrow: (f64, f64),
    wide: (f64, f64),
}

/// Одна сторона из конфига.
///
/// Принимается `0` (встроенный размер), `1..=100` (доля экрана в процентах)
/// или `101` и выше (пиксели — тот же счётчик без верхней границы). Зазор
/// между долей и пикселями, `(100..101)`, отрицательное, `Infinity`/`NaN` и
/// не-число читаются как мусор и откатываются на встроенный размер — со
/// строкой в stderr: правку руками надо либо исполнить, либо объяснить, а
/// молчаливый откат выглядит потерянной настройкой. Дробное внутри рабочих
/// диапазонов (`65.5`, `1400.5`) принимается как есть: округлять его не для
/// чего — экран в конце концов зажимает `wanted_size`, а точность выбора
/// человека дробность не портит.
///
/// Диапазон обязан совпадать с тем, что проверяет `normalizePickerSize` на
/// странице (`frontend-src/config-shape.js`): иначе форма показывала бы
/// значение, которое здесь молча отклоняется, и окно выходило бы не того
/// размера без единого объяснения на экране. Сторож —
/// «границы доли те же, по которым судит Rust» в `test/config-shape.test.js`.
fn scale_axis(node: Option<&serde_json::Value>, name: &str) -> f64 {
    let Some(value) = node else { return 0.0 };
    if value.is_null() {
        return 0.0;
    }
    let Some(pct) = value.as_f64() else {
        eprintln!("ccfzf-picker: pickerSize.{name} is not a number, using the built-in size");
        return 0.0;
    };
    if pct == 0.0 {
        return 0.0;
    }
    // `is_finite()` в самом условии, а не отдельной веткой раньше: `Infinity`
    // и `NaN` — тот же «не подошло ни под одно из трёх правил» случай, что и
    // зазор между долей и пикселями, и вторая строка в stderr для них ничего
    // не добавила бы. На практике сюда они и не доходят — serde_json не умеет
    // хранить нецелое число как `Number` вовсе (`Value::from(f64::INFINITY)`
    // становится `Null` и отсекается веткой выше), но проверка здесь — это
    // документированная гарантия правила, а не защита от конкретного пути.
    if pct.is_finite() && ((1.0..=100.0).contains(&pct) || pct >= 101.0) {
        return pct;
    }
    eprintln!(
        "ccfzf-picker: pickerSize.{name} = {pct} must be 0 (Default), 1-100 (percent of screen), or 101 or more (pixels); using the built-in size"
    );
    0.0
}

/// `pickerSize` из конфига.
fn picker_scale(config: &serde_json::Value) -> PickerScale {
    let axes = |half: &str| {
        let node = config.get("pickerSize").and_then(|v| v.get(half));
        (
            scale_axis(node.and_then(|v| v.get("width")), &format!("{half}.width")),
            scale_axis(node.and_then(|v| v.get("height")), &format!("{half}.height")),
        )
    };
    PickerScale { narrow: axes("narrow"), wide: axes("wide") }
}

/// Желаемый размер окна под режим списка.
///
/// Чистая и отдельная от `apply_picker_size` по той же причине, что и
/// `fit_to_screen`: монитора в тестах нет, а арифметику проверить и нужно, и
/// можно.
///
/// **Названная доля обходит `SCREEN_FILL`, а встроенный размер и пиксели —
/// нет**, и это не оплошность. Зажим защищает абсолютное число от маленького
/// экрана: 1400×900 закрывают тринадцатидюймовый мак целиком, и названные
/// человеком пиксели ничем не лучше — зажимаются они той же `fit_to_screen`,
/// что и встроенный широкий размер. Доля же в экран влезает по построению, и
/// зажми мы и её, выбранные человеком 95% молча стали бы 90% — пункт списка,
/// обещающий не то, что делает.
///
/// Экран неизвестен (`None`) — ни доли, ни пиксели не считаются вовсе:
/// `NaN * 0.8` уронил бы окно в точку, а зажать пиксели без экрана нечем.
/// Откат на встроенное, то есть на прежнее поведение.
///
/// Оси независимы: доля по высоте при встроенной ширине — обычный случай, за
/// которым задача и заводилась, а пиксели по одной стороне и доля по другой —
/// тот же случай для точного размера.
fn wanted_size(fullscreen: bool, scale: PickerScale, screen: Option<(f64, f64)>) -> (f64, f64) {
    let (base, val) = if fullscreen {
        (WIDE_SIZE, scale.wide)
    } else {
        (NARROW_SIZE, scale.narrow)
    };
    let Some(screen) = screen else { return base };
    // Встроенный размер широкой раскладки зажимается по экрану, и зажимает его
    // всё та же `fit_to_screen`. Узкое окно встроенным размером не зажималось
    // никогда — оно заведомо меньше любого экрана, на котором пикер
    // запускают, — и менять это здесь незачем: сторож
    // `narrow_size_matches_the_window_config` держится за то, что при выборе
    // `Default` окно открывается ровно размером из `tauri.conf.json`.
    let fitted = if fullscreen { fit_to_screen(base, screen) } else { base };
    let axis = |fitted: f64, val: f64, screen: f64| {
        if val >= 101.0 && screen > 0.0 && !screen.is_nan() {
            // Пиксели: абсолютное число зажимается так же, как встроенный
            // широкий размер, — иначе оно закрыло бы маленький экран целиком.
            return fit_axis(val, screen);
        }
        if val > 0.0 && val <= 100.0 && screen > 0.0 && !screen.is_nan() {
            // Доля: в экран влезает по построению, зажим тут только испортил
            // бы выбранное человеком число.
            return screen * val / 100.0;
        }
        fitted
    };
    (
        axis(fitted.0, val.0, screen.0),
        axis(fitted.1, val.1, screen.1),
    )
}

/// Монитор, по которому считаются размер и место окна.
///
/// `current_monitor` отвечает `Result<Option<_>>` — монитора может не быть
/// вовсе (дисплей отключили, окно ещё не выведено), и это не ошибка, а
/// «считать не по чему». Запасной ход на `primary_monitor` оставлен нарочно:
/// у tao на macOS `current_monitor` — это `ns_window.screen()`, а у
/// невыведенного окна он `nil`. Спрашивают отсюда теперь только по показанному
/// окну (`SizeRequest`), так что до запасного хода дело доходить не должно, —
/// но выйди оно иначе, зажим обязан считаться, а не пропасть: незажатое окно
/// закрывает маленький мак целиком, и поймать это можно только глазами.
/// Размер окна настроек, зажатый по экрану.
///
/// Монитор спрашивается у приложения, а не у окна: окна ещё нет вовсе, а у
/// пикера, только что погашенного, монитора на macOS не бывает — `current_monitor`
/// там `ns_window.screen()`, и у выведенного из показа окна он `nil`. Не
/// назвался и он — берётся желаемое: зажимать не по чему, а схлопывать окно в
/// точку хуже, чем отдать его высоким.
fn settings_size(app: &tauri::AppHandle) -> (f64, f64) {
    let Some(screen) = app
        .primary_monitor()
        .ok()
        .flatten()
        .as_ref()
        .and_then(monitor_logical_size)
    else {
        return SETTINGS_SIZE;
    };
    fit_to_screen(SETTINGS_SIZE, screen)
}

fn picker_monitor(window: &tauri::WebviewWindow) -> Option<tauri::window::Monitor> {
    window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
}

/// Логический размер монитора.
///
/// `size()` физический, поэтому делится на `scale_factor()`: `set_size` ниже
/// принимает логический. Отрицательный, нулевой и NaN масштаб — это «монитор
/// не назвался»: делить на такое нельзя, а зажимать не по чему.
fn monitor_logical_size(monitor: &tauri::window::Monitor) -> Option<(f64, f64)> {
    let scale = monitor.scale_factor();
    if scale <= 0.0 || scale.is_nan() {
        return None;
    }
    let size = monitor.size();
    Some((size.width as f64 / scale, size.height as f64 / scale))
}

/// Левый верхний угол окна, поставленного посреди рабочей области, в
/// физических точках.
///
/// Считается сам, а не `center()`, и место здесь считается по каждой стороне
/// отдельно — как и зажим размера. Отрицательной доли не бывает: окно шире
/// рабочей области прижимается к её началу, а не уезжает за левый край, где
/// его не достать ни мышью, ни глазами.
///
/// Вырожденный масштаб (ноль, отрицательный, NaN) читается как единица:
/// `as i64` от NaN даёт нуль, и окно уехало бы в угол, будто оно нулевого
/// размера. Сравнение `scale > 0.0` ложно и для NaN — это и есть проверка.
fn center_axis(want: f64, scale: f64, area_pos: i32, area_len: u32) -> i32 {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let window = (want * scale).round() as i64;
    let free = (area_len as i64 - window).max(0) / 2;
    area_pos.saturating_add(free as i32)
}

/// Размер и место окна под режим списка.
///
/// Размер меняет Rust, а не страница: у окна нет декораций
/// (`decorations: false`), и `window.resizeTo` в webview на таком окне не
/// работает. Пересчёт места после смены размера обязателен — без него окно
/// растёт вправо и вниз от прежнего верхнего левого угла и уезжает за край
/// экрана.
///
/// **Место ставится своим `set_position`, а не `center()`, и это не вкусовщина
/// — на macOS `center()` в этой паре работать не может.** `set_size` у tao
/// уходит в `set_content_size_async` — `dispatch_async` на главную очередь, то
/// есть исполняется не сейчас, а следующим витком. `center()` же — это
/// `NSWindow.center()` (в tao функции `center` нет вовсе, вся реализация
/// платформенная), и зовётся он **сразу**: `send_user_message` в
/// tauri-runtime-wry, увидев главный поток, исполняет просьбу на месте, а
/// показ и хоткей идут ровно с главного потока. Порядок выходит обратный
/// написанному: окно центруется по **прежнему** размеру, и только потом
/// меняет размер — а `setContentSize` держит верхний левый угол, так что
/// разница уезжает вправо и вниз. На маке это и намеряно живьём: 1323×861 при
/// левом крае 312 = 55 + (1415 − 900) / 2, то есть центровка считала ширину
/// узкого окна.
///
/// Своё `set_position` от порядка не зависит вовсе: оно уходит в ту же
/// очередь, что и размер (`set_frame_top_left_point_async`), встаёт в ней
/// следом, а угол считается по новому размеру — какой бы из двух вызовов ни
/// исполнился первым, окно окажется там, где считано.
///
/// Считается по рабочей области, а не по всему экрану: строка меню и Dock на
/// маке, панель задач на Windows. Тем же считает место и сам Tauri при
/// создании окна с `center: true` — расходиться с ним на смене размера
/// незачем.
///
/// Зовётся только по показанному окну, см. `SizeRequest`.
fn apply_picker_size(
    window: &tauri::WebviewWindow,
    fullscreen: bool,
    scale: PickerScale,
) -> Result<(), String> {
    let monitor = picker_monitor(window);
    let (w, h) = wanted_size(
        fullscreen,
        scale,
        monitor.as_ref().and_then(monitor_logical_size),
    );
    window
        .set_size(tauri::LogicalSize::new(w, h))
        .map_err(|e| format!("cannot resize picker: {e}"))?;
    // Монитор не назвался — просим систему сделать что может: место без
    // экрана не посчитать, а оставить окно там, где оно выросло, хуже.
    let Some(monitor) = monitor else {
        return window
            .center()
            .map_err(|e| format!("cannot center picker: {e}"));
    };
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let x = center_axis(w, scale, area.position.x, area.size.width);
    let y = center_axis(h, scale, area.position.y, area.size.height);
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| format!("cannot center picker: {e}"))
}

/// Судьба просьбы о размере: применить сейчас или запомнить до показа.
///
/// Скрытому окну размер не ставится вовсе. Окно пикера создаётся скрытым
/// (`visible: false` в `tauri.conf.json`), а страница просит размер при каждой
/// своей загрузке — то есть по окну, которого ещё нет на экране. Экрана у
/// такого окна нет и в буквальном смысле: у tao на macOS `current_monitor` —
/// это `ns_window.screen()`, а у невыведенного окна он `nil`. И размер, и
/// место пришлось бы считать по главному монитору наугад — на второй машине с
/// внешним экраном это и есть «наугад», а посчитанное по чужому экрану окно
/// заедет за край своего.
///
/// Отсюда разделение: `set_picker_size` записывает названный режим и применяет
/// его только по показанному окну, `show_picker` применяет запомненное сразу
/// после `show()` — считать надо по тому экрану, на котором окно уже стоит.
/// Решает это Rust, а не страница: у скрытого окна webview умеет усыплять её
/// целиком, и «страница по событию `picker-shown` перепросит размер» замолчала
/// бы ровно в том случае, ради которого затевалось.
///
/// Само по себе это тот баг на маке — узкое окно в углу, широкое за правым
/// краем — не чинит: там дело в порядке двух вызовов внутри
/// `apply_picker_size`, разбор там же. Здесь — второе условие правильного
/// счёта, свой экран.
///
/// Применённое перестаёт быть отложенным: второй показ подряд, между которыми
/// никто размера не просил, окна не трогает — лишний перескок на глазах хуже,
/// чем ничего.
#[derive(Default, Clone, Copy, PartialEq, Eq, Debug)]
struct SizeRequest {
    /// Последний названный страницей режим списка.
    fullscreen: bool,
    /// Названный, но ещё не применённый: просьба пришла по скрытому окну.
    pending: bool,
}

impl SizeRequest {
    /// Страница назвала режим. Отвечает режимом, если ставить размер надо
    /// сейчас, и `None`, если просьба отложена до показа.
    fn asked(&mut self, fullscreen: bool, visible: bool) -> Option<bool> {
        self.fullscreen = fullscreen;
        self.pending = !visible;
        visible.then_some(fullscreen)
    }

    /// Окно показали. Отвечает отложенным режимом — один раз на просьбу.
    fn shown(&mut self) -> Option<bool> {
        if !self.pending {
            return None;
        }
        self.pending = false;
        Some(self.fullscreen)
    }
}

/// Отложенная просьба о размере. См. `SizeRequest`.
#[derive(Default)]
struct PickerSize(Mutex<SizeRequest>);

/// Доли экрана, действующие прямо сейчас.
///
/// Живут отдельным состоянием ровно затем же, зачем `HideOnBlur`: конфиг
/// перечитывает `apply_config`, а размер ставится в другом месте и в другое
/// время. Читать `config.yaml` с диска на каждый показ окна незачем.
#[derive(Default)]
struct WindowScale(Mutex<PickerScale>);

/// Доли, действующие прямо сейчас.
///
/// Состояния может не быть только до конца `setup`; тогда действуют встроенные
/// размеры — то же умолчание, что и у пустого конфига.
fn picker_scale_now(app: &tauri::AppHandle) -> PickerScale {
    app.try_state::<WindowScale>()
        .map(|s| *s.0.lock().unwrap())
        .unwrap_or_default()
}

/// `scrim` из конфига — по флагу на каждую раскладку, оба ложью по умолчанию:
/// подложка — вещь, которую человек включает сам, а не то, чем пикер решил
/// его удивить после обновления.
fn scrim_flags(config: &serde_json::Value) -> (bool, bool) {
    let flag = |name: &str| {
        config
            .get("scrim")
            .and_then(|v| v.get(name))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    };
    (flag("narrow"), flag("wide"))
}

/// Флаги подложки, действующие прямо сейчас — тем же приёмом и по той же
/// причине, что и `WindowScale`: конфиг перечитывает `apply_config`, а
/// подложку показывают в других местах и в другое время.
#[derive(Default)]
struct ScrimFlags(Mutex<(bool, bool)>);

fn scrim_flags_now(app: &tauri::AppHandle) -> (bool, bool) {
    app.try_state::<ScrimFlags>()
        .map(|s| *s.0.lock().unwrap())
        .unwrap_or_default()
}

/// Режим списка, названный последним, — тот же, по которому `apply_picker_size`
/// считает размер (`SizeRequest.fullscreen`). Подложка обязана затемнять под
/// той же раскладкой, какую видит человек, а второй счётчик режима завёл бы
/// второй источник правды рядом с уже существующим.
fn current_fullscreen(app: &tauri::AppHandle) -> bool {
    app.try_state::<PickerSize>()
        .map(|s| s.0.lock().unwrap().fullscreen)
        .unwrap_or(false)
}

/// Показать или скрыть подложку под текущую раскладку.
///
/// Отказ не роняет вызывающего: показ и размер самого пикера дороже
/// затемнения стола позади него, та же расстановка приоритетов, что и у
/// `apply_picker_size` в `show_picker`.
fn apply_scrim(app: &tauri::AppHandle, fullscreen: bool) {
    let (narrow, wide) = scrim_flags_now(app);
    let show = scrim::scrim_wanted(fullscreen, narrow, wide);
    if let Err(e) = scrim::set_visible(app, show) {
        eprintln!("ccfzf-picker: {e}");
    }
}

#[tauri::command]
fn set_picker_size(app: tauri::AppHandle, fullscreen: bool) -> Result<(), String> {
    let Some(window) = app.get_webview_window("picker") else {
        return Err("picker window is gone".into());
    };
    // Не смогли спросить — считаем окно скрытым: отложенная просьба применится
    // на ближайшем показе, а применённая по скрытому окну не применится
    // никогда.
    let visible = window.is_visible().unwrap_or(false);
    let apply = match app.try_state::<PickerSize>() {
        Some(state) => state.0.lock().unwrap().asked(fullscreen, visible),
        // Состояния нет только до конца `setup`, а страница до него не
        // загружается; правило при этом то же самое.
        None => visible.then_some(fullscreen),
    };
    match apply {
        Some(fullscreen) => {
            let result = apply_picker_size(&window, fullscreen, picker_scale_now(&app));
            // Подложка пересчитывается тут же, а не ждёт следующего показа:
            // `^F` меняет раскладку у уже открытого окна, и без этого вызова
            // затемнение осталось бы от прежнего режима до следующего
            // закрытия-открытия пикера.
            apply_scrim(&app, fullscreen);
            result
        }
        None => Ok(()),
    }
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
        .expect("icons/favicon.png does not parse as an image")
}

/// Хост берётся из конфига, а не зашит: список и открытие сессии обязаны
/// ходить на одну машину. Раньше здесь стоял литерал, а `open-strategy.js`
/// читал `sshHost` из конфига, и правка конфига молча разводила их по разным
/// хостам.
fn check_ssh_host(ssh_host: &str) -> Result<(), String> {
    if ssh_host.trim().is_empty() {
        return Err(
            "sshHost is not set: copy config.example.yml to ~/.config/ccfzf-picker/config.yaml"
                .to_string(),
        );
    }
    Ok(())
}

/// Записать комментарий к сессии на машине агрегатора.
///
/// Ходит по ssh на тот же `sshHost`, что и список: файл комментариев лежит
/// там, и общим он выходит именно поэтому — `--state` этой машины читают
/// пикеры всех машин сразу.
///
/// `async` обязателен: ssh идёт до пяти секунд (`ConnectTimeout`), а
/// синхронную команду Tauri выполняет в потоке цикла событий — окно замерло бы
/// на всё это время, включая отрисовку самого оверлея, из которого её позвали.
///
/// Имя своей машины уезжает вместе с текстом: на той стороне его не угадать —
/// ssh приходит с любой из машин, а `$HOSTNAME` назвал бы агрегатора.
#[tauri::command]
async fn set_comment(
    ssh_host: String,
    id: String,
    text: String,
    from: String,
) -> Result<(), String> {
    check_ssh_host(&ssh_host)?;
    tauri::async_runtime::spawn_blocking(move || {
        state_source::set_comment(&ssh_host, &id, &text, &from)
    })
    .await
    .map_err(|e| format!("comment task failed: {e}"))?
}

/// Отдать фронтенду то, что уже известно, и подтолкнуть опрос.
///
/// Зовётся один раз, сразу после подписки на событие `state`: поток мог
/// ответить раньше, чем фронтенд успел подписаться, и без этого толчка первый
/// кадр ждал бы целого такта.
#[tauri::command]
fn poll_now(poller: tauri::State<poller::Poller>) -> serde_json::Value {
    poller.nudge();
    poller.snapshot()
}

/// Отдать право занять передний план тому, кто выполнит просьбу.
///
/// Windows позволяет вызвать `SetForegroundWindow` только процессу, который
/// передним планом уже владеет либо получил последнее событие ввода. Ни один из
/// тех, кто исполняет наши просьбы, не таков: к этому моменту они просто слушают
/// брокера. Право передаёт пикер, и именно сейчас: нажатие, из-за которого мы
/// здесь, было последним событием ввода, и оно наше.
///
/// Право уходит всем (`ASFW_ANY`), а не названному pid, и это исправление, а не
/// послабление. Названный pid у нас был один — `windowPid` из ответа
/// агрегатора, — но кладёт его в файл трекера демон `claude-wt watch`, а окна
/// поднимает и терминал запускает служба MQTT: с переезда claude-wt из
/// windows-mqtt в windows11-manager это два разных дочерних процесса трея, и
/// грамота по pid всё это время уходила не тому. Третьего же — только что
/// запущенный `wt.exe` — по pid не назвать вовсе: в момент выдачи его не
/// существует, а свернувшееся окно нового терминала было именно его отказом.
/// Правка действует до следующего ввода человека, то есть секунды.
///
/// Отказ не фатален и значит ровно то же, что и отсутствие грамоты, — окно не
/// поднимется само. Уже открытое окно менеджер поднимает и без неё:
/// `bringToTop()` в node-window-manager подцепляет свой ввод к потоку переднего
/// окна (`AttachThreadInput`), а такой подъём Windows не запрещает.
#[cfg(target_os = "windows")]
fn allow_any_foreground() {
    use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};
    if let Err(e) = unsafe { AllowSetForegroundWindow(ASFW_ANY) } {
        eprintln!("ccfzf-picker: cannot grant foreground: {e}");
    }
}

#[cfg(not(target_os = "windows"))]
fn allow_any_foreground() {}

/// Брокер из конфига или внятный отказ.
///
/// Общий для всех команд, публикующих просьбы: шесть копий одной проверки
/// разошлись бы в тексте отказа, а его читает человек в строке ошибки пикера.
fn configured_broker() -> Result<mqtt::Broker, String> {
    Ok(configured_broker_and_terminal()?.0)
}

/// То же самое плюс имя выбранного терминала — одним чтением конфига.
///
/// Отдельная функция, а не второй `load_config()` рядом: файл читается с диска,
/// а зовут это на каждое нажатие Enter. Имя нужно только тем трём просьбам, что
/// кончаются терминалом, — остальным (фокус, отметка, восстановление) хватает
/// брокера, и грузить их лишним полем незачем.
fn configured_broker_and_terminal() -> Result<(mqtt::Broker, String), String> {
    let raw = load_config()?;
    let broker = mqtt::broker_from_config(&raw);
    if !broker.is_configured() {
        return Err("mqtt is not configured: host and base are required in config.yaml".to_string());
    }
    let terminal = mqtt::terminal_name(&raw);
    Ok((broker, terminal))
}

/// Поднять окно сессии через MQTT.
///
/// Зовётся вместо `spawn_detached` у стратегии `focus`: окно уже открыто, и
/// заводить рядом второй процесс на том же транскрипте незачем.
///
/// Просьба уходит публикацией — тело и топик те, что уже слушает демон на
/// Windows-машине. Ответа у неё нет: приёмник отчитывается в свой лог. Так
/// вышло не от хорошей жизни — http-сервер, у которого ответ был, вешал демона
/// на той стороне, — но цена оказалась мала: отказ («сессия неизвестна», «окна
/// нет») человек и так увидел бы уже после того, как пикер погас.
#[tauri::command]
async fn focus_window_mqtt(id: String, base: Option<String>) -> Result<(), String> {
    // До публикации, а не после: право должно быть на той стороне к моменту,
    // когда там дойдут до подъёма окна.
    allow_any_foreground();
    let broker = configured_broker()?;
    // Адрес называет трекер той машины, где стоит окно; свой из конфига —
    // запасной ход для трекера прежней версии.
    let base = mqtt::resolve_base(&broker, base.unwrap_or_default().trim());
    tauri::async_runtime::spawn_blocking(move || mqtt::focus(&broker, &base, &id))
        .await
        .map_err(|e| format!("focus_window_mqtt task failed: {e}"))?
}

/// Вернуть сессию в непрочитанное у оконных трекеров.
///
/// Отметок о просмотре две: своя, в `seen.json`, и трекерная — она приезжает
/// полем `focusedAt` внутри `window` и в списке побеждает по максимуму. Отмотать
/// только свою бесполезно: у сессии с открытым окном трекерная почти всегда
/// свежее и вернула бы кружок в «просмотрено» на следующем же опросе.
///
/// Окон у сессии бывает несколько — её открывают на нескольких машинах сразу, —
/// и отмотать надо у каждого трекера: отмотай у одного, и второй вернёт
/// «просмотрено» тем же способом. Права на передний план здесь не выдаётся:
/// окно никто не поднимает. Пикер по этой команде не гаснет — список
/// перерисовывается раз в секунду, и кружок оранжевеет на глазах.
///
/// Каждая база получает свою попытку независимо от исхода предыдущих: ранний
/// выход на первой же ошибке оставлял бы вторую машину неотмотанной — ровно
/// половинчатую отмотку, ради ухода от которой список баз и завели. Наружу
/// уходит первая случившаяся ошибка, но только после того, как испробованы все.
#[tauri::command]
async fn unread_session_mqtt(id: String, bases: Vec<String>) -> Result<(), String> {
    let broker = configured_broker()?;
    // Адрес называет трекер той машины, где стоит окно, и машин этих бывает
    // несколько: сессию открывают на всех сразу. Пустой список — трекер
    // прежней версии или строка без окон, тогда остаётся база своего конфига.
    let bases = mqtt::unread_bases(&broker, &bases);
    tauri::async_runtime::spawn_blocking(move || {
        let mut first_err: Option<String> = None;
        for base in &bases {
            if let Err(e) = mqtt::unread(&broker, base, &id) {
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
        }
        match first_err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    })
    .await
    .map_err(|e| format!("unread_session_mqtt task failed: {e}"))?
}

/// Попросить поднять раскладку снимка.
///
/// Пустой `session_ids` значит «весь снимок». Права на передний план здесь не
/// выдаётся: восстановление открывает новые окна, а не поднимает существующее,
/// и `AllowSetForegroundWindow` тут не при чём.
#[tauri::command]
async fn restore_snapshot_mqtt(
    id: String,
    session_ids: Vec<String>,
    base: Option<String>,
) -> Result<(), String> {
    let broker = configured_broker()?;
    // Адрес называет трекер той машины, где стоит окно; свой из конфига —
    // запасной ход для трекера прежней версии.
    let base = mqtt::resolve_base(&broker, base.unwrap_or_default().trim());
    tauri::async_runtime::spawn_blocking(move || mqtt::restore(&broker, &base, &id, &session_ids))
        .await
        .map_err(|e| format!("restore_snapshot_mqtt task failed: {e}"))?
}

/// Попросить трекер открыть сессию у себя.
///
/// Зовётся и с машины, которая не является трекером — пункт меню «Open on
/// <host>» появляется только там, где `canOpenRemote` разрешил, — и со своей же
/// машины, где Enter вызывает эту же команду напрямую, когда `chooseEnterAction`
/// отдал `manager`. Транспорт один и тот же в обоих случаях: HTTP здесь не
/// сработал бы даже на своей машине — webview Tauri режет такой запрос как
/// cross-origin ещё до отправки. Ответа у просьбы нет по той же причине, что и
/// у фокуса: приёмник отчитывается в свой лог, а не нам.
///
/// Право на передний план выдаётся и здесь: просьба кончается либо подъёмом
/// окна, либо новым терминалом, и оба на той стороне упираются в одно и то же
/// разрешение Windows. Раньше его тут не выдавали, потому что выдавали по pid, а
/// pid эта команда не принимает; `allow_any_foreground` никакого pid и не ждёт.
/// Разводит подъём и открытие `chooseEnterAction` во фронтенде — по причинам,
/// которые с грамотой не связаны вовсе.
///
/// `cwd` — каталог проекта строки, и он необязателен только по форме: без него
/// менеджер умеет открыть лишь сессию, которую сам же и помнит слотом, а
/// список пикера приезжает от ccfzf с ssh-хоста и знает сессии, которых на
/// Windows не открывали ни разу. `Option` — чтобы непереданный ключ значил
/// «каталога нет», а не рушил вызов на мосту: у `String` его отсутствие стало
/// бы ошибкой разбора, и Enter отчитался бы человеку про аргументы команды.
#[tauri::command]
async fn open_session_mqtt(
    id: String,
    cwd: Option<String>,
    base: Option<String>,
) -> Result<(), String> {
    allow_any_foreground();
    let (broker, terminal) = configured_broker_and_terminal()?;
    let cwd = cwd.unwrap_or_default().trim().to_string();
    // Адрес называет трекер той машины, где стоит окно; свой из конфига —
    // запасной ход для трекера прежней версии.
    let base = mqtt::resolve_base(&broker, base.unwrap_or_default().trim());
    tauri::async_runtime::spawn_blocking(move || mqtt::open(&broker, &base, &id, &cwd, &terminal))
        .await
        .map_err(|e| format!("open_session_mqtt task failed: {e}"))?
}

/// Попросить менеджера открыть проект по каталогу.
///
/// `id` в теле нет вовсе: у строки проекта сессии ещё не существует, есть
/// только каталог, и что с ним делать — поднять окно этого проекта или завести
/// сессию с его профилем — решает `openClaudeProject` на той стороне. Ту же
/// просьбу шлёт проектный хоткей из `project_hotkeys.rs`; здесь она нужна
/// затем, что у страницы своего входа к ней не было.
///
/// Грамота — как у хоткея, и по той же причине: оба исхода просьбы кончаются
/// окном, которому нужен передний план.
#[tauri::command]
async fn open_project_mqtt(cwd: String, base: Option<String>) -> Result<(), String> {
    allow_any_foreground();
    let (broker, terminal) = configured_broker_and_terminal()?;
    // У строки проекта окна нет вовсе: адрес называет трекер машины
    // менеджера, а не машины окна. Свой из конфига — запасной ход для
    // трекера прежней версии.
    let base = mqtt::resolve_base(&broker, base.unwrap_or_default().trim());
    tauri::async_runtime::spawn_blocking(move || {
        mqtt::open_project(&broker, &base, &cwd, &terminal)
    })
    .await
    .map_err(|e| format!("open_project_mqtt task failed: {e}"))?
}

/// Попросить менеджера завести новую сессию в каталоге.
///
/// Отдельная команда, а не флаг у `open_project_mqtt`: на мосту в webview флаг
/// стал бы необязательным аргументом, а различает он две разные просьбы с
/// разными телами. Имя считает пикер и присылает готовым — менеджер списка
/// занятых имён не ведёт.
#[tauri::command]
async fn new_session_mqtt(cwd: String, name: String, base: Option<String>) -> Result<(), String> {
    allow_any_foreground();
    let (broker, terminal) = configured_broker_and_terminal()?;
    // Окна ещё нет — сессия только заводится: адрес называет трекер машины
    // менеджера, а не машины окна. Свой из конфига — запасной ход для
    // трекера прежней версии.
    let base = mqtt::resolve_base(&broker, base.unwrap_or_default().trim());
    tauri::async_runtime::spawn_blocking(move || {
        mqtt::open_new(&broker, &base, &cwd, &name, &terminal)
    })
    .await
    .map_err(|e| format!("new_session_mqtt task failed: {e}"))?
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

/// Путь к config.yaml.
///
/// Общий для чтения (`load_config`) и записи (`save_config`/`write_config`):
/// разойдись они в построении пути двумя копиями, один читал бы не тот файл,
/// что другой пишет.
fn config_path() -> Result<std::path::PathBuf, String> {
    let home = home_dir().ok_or("neither HOME nor USERPROFILE is set")?;
    Ok(std::path::Path::new(&home).join(".config/ccfzf-picker/config.yaml"))
}

#[tauri::command]
fn load_config() -> Result<serde_json::Value, String> {
    // Нет ни HOME, ни USERPROFILE — не ошибка, а работа на умолчаниях, как и
    // раньше: без этого предохранителя пикер на такой системе не поднялся бы
    // вовсе.
    let Ok(path) = config_path() else {
        return Ok(serde_json::Value::Null);
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(serde_json::Value::Null),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    serde_yaml::from_str(&text).map_err(|e| format!("bad yaml in {}: {e}", path.display()))
}

/// Патч, обнуляющий ключ, отклоняется явно — на любой глубине.
///
/// `merge_patch` вложенные отображения сливает по ключам, а `null` считает
/// «не отображением» и подменяет блок целиком — так пропал бы `mqtt.password`,
/// которого форма настроек никогда не загружает и не присылает обратно.
/// Сегодняшняя форма такого патча не пришлёт, но если пришлёт когда-нибудь —
/// лучше внятный отказ здесь, чем молча стёртый пароль.
///
/// Проверка рекурсивная именно из-за пароля: страшен не столько `mqtt: null`
/// на верхнем уровне, сколько `{"mqtt": {"password": null}}` — тот стирает
/// ровно тот ключ, ради которого всё слияние и написано.
fn reject_null_values(patch: &serde_json::Value) -> Result<(), String> {
    if let Some(fields) = patch.as_object() {
        for (key, value) in fields {
            if value.is_null() {
                return Err(format!(
                    "patch cannot null out key {key}: null would replace the whole block and wipe what the form did not send (mqtt.password, for one)"
                ));
            }
            reject_null_values(value)?;
        }
    }
    Ok(())
}

/// Закрыть файл от всех, кроме владельца.
///
/// В конфиге лежит `mqtt.password`, а заводит файл теперь не человек своими
/// руками, а окно настроек: с обычным umask пароль оказался бы читаем всей
/// машине. Отказ не фатален — сохранить настройки важнее, чем выставить
/// режим, — но и молчать о нём нельзя.
///
/// На Windows этого API нет, и права там устроены иначе: файл лежит в профиле
/// пользователя, куда посторонний и так не ходит.
#[cfg(unix)]
fn restrict_permissions(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        eprintln!("ccfzf-picker: cannot restrict {}: {e}", path.display());
    }
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &std::path::Path) {}

/// Слить патч в config.yaml на диске.
///
/// Отдельно от `save_config`: чистая файловая операция без `AppHandle`, её
/// можно накрыть тестами во временном каталоге, не поднимая Tauri.
///
/// Бэкап кладётся один раз, перед первой перезаписью: комментарии человека
/// после неё не восстановить ничем, а класть `.bak` на каждое сохранение
/// значило бы затирать его же вчерашним состоянием.
fn write_config(path: &std::path::Path, patch: &serde_json::Value) -> Result<(), String> {
    reject_null_values(patch)?;

    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let existing = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };

    let mut doc: serde_yaml::Value = if existing.trim().is_empty() {
        serde_yaml::Value::Null
    } else {
        serde_yaml::from_str(&existing).map_err(|e| format!("bad yaml in {}: {e}", path.display()))?
    };
    config_file::merge_patch(&mut doc, patch)?;

    // Тем же условием, что и разбор чуть выше: файл из одних пробелов и
    // переводов строки тоже «был пустым», и бэкапить в нём нечего — иначе он
    // занял бы единственный слот `.bak` навсегда.
    let backup = path.with_extension("yaml.bak");
    if !existing.trim().is_empty() && !backup.exists() {
        std::fs::write(&backup, &existing)
            .map_err(|e| format!("cannot write {}: {e}", backup.display()))?;
        restrict_permissions(&backup);
    }

    // Через временный файл и переименование, как save_json: читатель никогда
    // не видит половину файла.
    let text = format!("{}{}", config_file::HEADER, config_file::render(&doc)?);
    let tmp = path.with_extension("yaml.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    // До переименования, а не после: иначе у конфига был бы промежуток, в
    // который пароль уже на месте, а права ещё общие.
    restrict_permissions(&tmp);
    if let Err(e) = std::fs::rename(&tmp, path) {
        // Rename не удался — не оставлять временный файл валяться на диске.
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("cannot rename onto {}: {e}", path.display()));
    }
    Ok(())
}

/// Сохранить настройки, присланные окном настроек.
///
/// Патч, а не файл целиком: окно знает не про все ключи (`actions` оно только
/// показывает), и перезапись целиком стёрла бы остальное. Слияние — в
/// `config_file::merge_patch`, файловая часть — в `write_config`.
///
/// Возвращает, встал ли хоткей пикера после применения и на какой
/// комбинации: форма настроек (задача C6) обязана показать отказ на месте,
/// если новую комбинацию уже занял кто-то другой. Событие `config-changed`
/// этот факт нарочно не несёт — на его прежнее тело рассчитывает задача C7.
#[tauri::command]
fn save_config(app: tauri::AppHandle, patch: serde_json::Value) -> Result<serde_json::Value, String> {
    let path = config_path()?;
    write_config(&path, &patch)?;
    let out = apply_config(&app);
    Ok(serde_json::json!({
        "hotkeyRegistered": out.picker_registered,
        "hotkeyAccelerator": out.picker_accelerator,
        "projectsHotkeyRegistered": out.projects_registered,
        "projectsHotkeyAccelerator": out.projects_accelerator,
    }))
}

/// Поставить хоткей пикера из конфига.
///
/// Общая для старта (`setup`) и для сохранения настроек (`apply_config`):
/// раньше это были две независимые копии с разной обработкой отказа, и
/// правка одной не факт что дошла бы до другой.
fn register_picker_hotkey(app: &tauri::AppHandle, config: &serde_json::Value) -> (bool, String) {
    let (picker_shortcut, accelerator) = picker_hotkey(config);
    let registered = match app.global_shortcut().on_shortcut(picker_shortcut, |app, _sc, event| {
        if event.state() == ShortcutState::Pressed {
            toggle_picker(app);
        }
    }) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("ccfzf-picker: cannot register picker hotkey: {e}");
            false
        }
    };
    (registered, accelerator)
}

/// Поставить хоткей режима проектов.
///
/// Отдельная функция, а не второй аргумент к `register_picker_hotkey`:
/// обработчики у них разные по существу — один переключает окно, другой
/// открывает его в режиме и переключением быть не может.
fn register_projects_hotkey(app: &tauri::AppHandle, config: &serde_json::Value) -> (bool, String) {
    let (shortcut, accelerator) = projects_hotkey(config);
    let registered = match app.global_shortcut().on_shortcut(shortcut, |app, _sc, event| {
        if event.state() == ShortcutState::Pressed {
            toggle_projects(app);
        }
    }) {
        Ok(()) => true,
        Err(e) => {
            // Отказ не фатален и обязан быть виден — то же правило, что у
            // проектных хоткеев: молчащая клавиша выглядит сломанным конфигом.
            eprintln!("ccfzf-picker: cannot register projects hotkey: {e}");
            false
        }
    };
    (registered, accelerator)
}

/// Комбинация так, как её показывают человеку: `Super` — это `Win`.
///
/// Клавиша на клавиатуре подписана `Win`, а muda пишет её словом `Windows`, и
/// `Windows+Shift+C` длиннее самого пункта меню. Своё имя модификатора здесь
/// не выдумывается: `Cmd`, `Command` и `Meta` — те же имена, которые понимает
/// разбор хоткея, и человек мог написать в `config.yaml` любое из них.
///
/// Прочие части строки идут как есть, а не приводятся к какому-нибудь общему
/// виду: в колонке показывается ровно то, что человек написал в конфиге, — и
/// это лучше канонической формы, потому что искать глазами он будет своё.
#[cfg_attr(not(windows), allow(dead_code))]
fn accelerator_text(accelerator: &str) -> String {
    accelerator
        .split('+')
        .map(|part| {
            let part = part.trim();
            match part.to_ascii_lowercase().as_str() {
                "super" | "meta" | "cmd" | "command" | "win" | "windows" => "Win".to_string(),
                _ => part.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join("+")
}

/// Подпись пункта и то, что уходит в нативный слот акселератора.
///
/// На Windows слот не используется вовсе, и это единственный способ показать
/// `Win` вместо `Windows`: слово зашито в `Display` самого muda
/// (`platform_impl/windows/accelerator.rs`), и подменить его нечем. Взамен
/// комбинация пишется в подпись через `\t` — ровно тем приёмом, каким её
/// кладёт туда и сам muda (`format!("{text}\t{}", accelerator)`): выравнивание
/// по табуляции делает Win32, и колонка выходит та же самая. Без акселератора
/// muda отдаёт подпись в меню как есть, так что табуляция доезжает до Win32
/// нетронутой.
///
/// Цена — запись в таблице акселераторов меню, которую muda завёл бы рядом. Но
/// она и была украшением: работает настоящий хоткей, глобальный, а меню трея
/// клавиш не слушает вовсе. Ровно поэтому же отказ регистрации называет
/// подпись, а не колонка.
///
/// На маке ничего не меняется: NSMenuItem рисует ⌘⇧C сам, и табуляция в
/// заголовке была бы литеральной.
fn menu_item_parts(label: &str, accelerator: &str) -> (String, Option<String>) {
    #[cfg(windows)]
    {
        (format!("{label}\t{}", accelerator_text(accelerator)), None)
    }
    #[cfg(not(windows))]
    {
        (label.to_string(), Some(accelerator.to_string()))
    }
}

/// Пункт трея «показать»: хранится в состоянии приложения, чтобы
/// `apply_config` мог поправить его подпись и акселератор после смены
/// хоткея из окна настроек. Без этого трей продолжал бы обещать комбинацию,
/// которая уже не слушается.
struct ShowMenuItem(MenuItem<tauri::Wry>);

/// Пункт трея «проекты» — по той же причине и с той же судьбой.
struct ProjectsMenuItem(MenuItem<tauri::Wry>);

/// Подпись и акселератор пункта трея — по тому же правилу, что и на старте:
/// акселератор — украшение и показывается всегда, а работает ли клавиша на
/// самом деле, говорит подпись (`show_item_label`).
fn update_show_item(item: &MenuItem<tauri::Wry>, registered: bool, accelerator: &str) {
    update_menu_item(item, show_item_label(registered), accelerator);
}

/// Общая часть на два пункта трея: подпись и акселератор.
///
/// Отказ здесь не роняет ничего: акселератор — украшение, и строку, которую
/// не понял muda, пункт переживает без правой колонки.
///
/// Что именно уходит в подпись, а что в слот, решает `menu_item_parts`: на
/// Windows комбинация едет в подписи, и слот обязан быть очищен — иначе muda
/// приписал бы к нашей табуляции свою вторую, со словом `Windows`.
fn update_menu_item(item: &MenuItem<tauri::Wry>, label: &str, accelerator: &str) {
    let (text, accel) = menu_item_parts(label, accelerator);
    if let Err(e) = item.set_text(&text) {
        eprintln!("ccfzf-picker: cannot update tray label: {e}");
    }
    if let Err(e) = item.set_accelerator(accel.as_deref()) {
        eprintln!("ccfzf-picker: cannot show hotkey {accelerator} in tray menu: {e}");
    }
}

/// Что делает свежий конфиг действующим прямо сейчас.
///
/// Перезапуск ради настройки — плохая цена, а хоткеи и хост опроса меняются
/// без него. Хоткеи снимаются все разом: следить, какой именно из них поменял
/// человек, значило бы держать вторую копию списка рядом с конфигом.
///
/// Возвращает то же, что и `register_picker_hotkey`: встал ли хоткей пикера
/// и на какой комбинации — этим отчитывается `save_config` перед формой
/// настроек.
/// Чем кончилась постановка глобальных хоткеев: по паре «встал ли» и «на какой
/// комбинации» на каждый. Структурой, а не четырьмя значениями в кортеже:
/// перепутать местами два `bool` и две строки — вопрос времени, а форма
/// настроек по этим полям красит отказ.
struct HotkeyOutcome {
    picker_registered: bool,
    picker_accelerator: String,
    projects_registered: bool,
    projects_accelerator: String,
}

fn apply_config(app: &tauri::AppHandle) -> HotkeyOutcome {
    let config = match load_config() {
        Ok(c) => c,
        Err(e) => {
            // Прежде здесь молча подставлялся Null: пустой sshHost уводит
            // поток опроса в простой, а хоткеи откатываются на умолчания —
            // и без этой строки узнать о причине можно было бы только по
            // внезапно замолчавшему списку.
            eprintln!("ccfzf-picker: bad config.yaml, falling back to defaults: {e}");
            serde_json::Value::Null
        }
    };

    if let Some(poller) = app.try_state::<poller::Poller>() {
        let ssh_host = config
            .get("sshHost")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let background = config
            .get("backgroundRefresh")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        poller.set_config(ssh_host, background);
    }

    // Гашение по потере фокуса — тоже без перезапуска: обработчик стоит всегда
    // и смотрит на этот флаг (см. `HideOnBlur`).
    if let Some(state) = app.try_state::<HideOnBlur>() {
        state.0.store(hide_on_blur(&config), Ordering::Relaxed);
    }

    // Размер — тоже без перезапуска, но применяется он не здесь, а на ближайшем
    // показе окна: пикер в этот момент скрыт (он гасит себя перед открытием
    // настроек), а скрытому окну размер не ставится вовсе — экрана у него нет,
    // см. `SizeRequest`. Отсюда пометка `pending`.
    //
    // Перепросить размер со страницы по событию `config-changed` нельзя по той
    // же причине, по какой опрос живёт в Rust: у скрытого окна WebView2 умеет
    // усыплять страницу целиком, и просьба замолчала бы ровно в том случае,
    // ради которого затевалась.
    if let Some(state) = app.try_state::<WindowScale>() {
        *state.0.lock().unwrap() = picker_scale(&config);
        if let Some(size) = app.try_state::<PickerSize>() {
            size.0.lock().unwrap().pending = true;
        }
    }

    // Подложка — тем же приёмом: флаги переставляются здесь, а видимость
    // трогает только показанное окно. Пикер в этот момент скрыт (см. выше про
    // размер), так что пересчитывать её сейчас нечего — она и так спрятана
    // вместе с окном.
    if let Some(state) = app.try_state::<ScrimFlags>() {
        *state.0.lock().unwrap() = scrim_flags(&config);
    }

    let _ = app.global_shortcut().unregister_all();
    let (registered, accelerator) = register_picker_hotkey(app, &config);
    let (projects_registered, projects_accelerator) = register_projects_hotkey(app, &config);
    project_hotkeys::reapply(app);

    if let Some(item) = app.try_state::<ShowMenuItem>() {
        update_show_item(&item.0, registered, &accelerator);
    }
    if let Some(item) = app.try_state::<ProjectsMenuItem>() {
        update_menu_item(
            &item.0,
            projects_item_label(projects_registered),
            &projects_accelerator,
        );
    }

    let _ = app.emit("config-changed", ());
    HotkeyOutcome {
        picker_registered: registered,
        picker_accelerator: accelerator,
        projects_registered,
        projects_accelerator,
    }
}

/// Открыть окно настроек.
///
/// Создаётся лениво: второй webview на старте стоил бы памяти каждому, кто в
/// настройки не заходит. `hideOnBlur` к нему не привязан намеренно — в
/// настройках переключаются между окнами, и гаснущая форма теряла бы
/// незаписанное.
///
/// `async` здесь не украшение и не задел на будущее. Синхронную команду Tauri
/// выполняет прямо в потоке цикла событий, а создание webview на Windows этот
/// же цикл и ждёт: `build()` возвращает Ok, окно появляется, а страница в нём
/// не загружается никогда — белый прямоугольник с рамкой и без содержимого.
/// `async` уводит команду в пул, цикл остаётся свободен, и webview
/// дозревает. Заодно это единственная причина, по которой команда не может
/// брать `&AppHandle`.
///
/// Пикер гасится первым и всегда. Он `alwaysOnTop` и центрирован, окно
/// настроек тоже центрируется и выходит уже него — то есть ложится ровно
/// под пикер и им закрывается: ни прочитать, ни нажать крестик.
/// Гашение идёт до создания окна, пока фокус ещё наш, — иначе система отдала
/// бы передний план не настройкам. К `hideOnBlur` это отношения не имеет: тот
/// про потерю фокуса, а здесь пикер уходит по своей же команде.
#[tauri::command]
async fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    hide_window(&app);
    if let Some(window) = app.get_webview_window("settings") {
        // Свёрнутое окно один `show()` с `set_focus()` на Windows не
        // поднимает — надо явно снять минимизацию.
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let (width, height) = settings_size(&app);
    tauri::WebviewWindowBuilder::new(
        &app,
        "settings",
        tauri::WebviewUrl::App("settings.html".into()),
    )
    .title("ccfzf-picker Settings")
    .inner_size(width, height)
    .center()
    .resizable(true)
    .build()
    .map_err(|e| format!("cannot open settings window: {e}"))?;
    Ok(())
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
pub(crate) fn load_json(name: &str) -> Result<serde_json::Value, String> {
    let path = state_path(name)?;
    match std::fs::read_to_string(&path) {
        Ok(t) => serde_json::from_str(&t).map_err(|e| format!("bad json in {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Запись через временный файл и переименование: читатель никогда не видит
/// половину файла.
pub(crate) fn save_json(name: &str, value: &serde_json::Value) -> Result<(), String> {
    let path = state_path(name)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string(value).map_err(|e| format!("cannot serialize {name}: {e}"))?;
    std::fs::write(&tmp, text).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("cannot rename onto {}: {e}", path.display()))
}

/// Помощник, разворачивающий команду на месте.
///
/// Заведён ради терминала, которому нельзя отдать ни одной кавычки: токенизатор
/// iTerm2 обрабатывает `\` и внутри одинарных кавычек, и `'\''` у него
/// рассыпается (разбор — в правиле про iTerm2 в CLAUDE.md). Поэтому терминал
/// получает два токена без единого опасного знака — путь этого файла и base64
/// команды, — а кавычки разбирает уже настоящий шелл, здесь.
///
/// `eval` не роскошь: развёрнутое — это готовая командная строка с кавычками
/// (`'ssh' '-t' 'host' '<команда>'`), и её надо именно разобрать, а не
/// выполнить как одно имя программы.
///
/// Хвост `exec $SHELL -i` держит окно открытым после сессии. Без него профиль
/// iTerm2 по умолчанию закрывает окно вместе с агентом, и чем тот кончился —
/// не прочитать: ровно та слепота, из-за которой поломку с токенизатором
/// искали дольше, чем следовало. Забота та же, что у kitty с `--hold`.
const TERMINAL_HELPER: &str = r#"#!/bin/sh
# Пишется пикером: правки здесь переживут ровно до следующего запуска.
eval "$(printf %s "$1" | base64 -d)"
exec "${SHELL:-/bin/sh}" -i
"#;

/// Положить помощника на место и назвать путь.
///
/// Переписывается на каждый спрос, а не только при отсутствии: файл этот —
/// продолжение бинаря, и разойтись с ним он не должен. Дёшево: спрашивают его
/// лишь те терминалы, у которых в аргументах стоит `{helper}`.
#[tauri::command]
fn terminal_helper() -> Result<String, String> {
    let path = state_path("open-terminal.sh")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    std::fs::write(&path, TERMINAL_HELPER)
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("cannot chmod {}: {e}", path.display()))?;
    }
    Ok(path.to_string_lossy().into_owned())
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

/// Какие проектные хоткеи не встали — то же тело, что несёт событие
/// `project-hotkeys`, но спрошенное один раз при загрузке страницы.
///
/// Клавиши вешаются в `setup()`, раньше, чем webview исполнил свой JS, а
/// `emit` не буферизуется для слушателя, который подпишется позже: без этой
/// команды первый отказ, случившийся до подписки, не показался бы никогда —
/// а следующий `project-hotkeys` придёт только при смене списка, то есть,
/// возможно, никогда за весь запуск. Пустое состояние (ничего ещё не
/// применялось) — пустой список, не ошибка: `Registered::default()` уже
/// такой.
///
/// `async` здесь по той же причине, что и у `open_settings`, но с обратной
/// стороны: синхронную команду Tauri исполняет прямо в потоке цикла событий, а
/// эта команда ждёт мьютекс, который в это же время может держать поток
/// поллера, вешающий клавиши. Плагин хоткеев вешает их через главный поток —
/// и цикл замкнулся бы: страница спросила бы «что не встало», главный поток
/// встал бы на мьютексе, а державший мьютекс — на главном потоке. Приложение
/// при этом не падает, а тихо перестаёт отвечать на что бы то ни было.
#[tauri::command]
async fn project_hotkeys_taken(
    state: tauri::State<'_, project_hotkeys::Registered>,
) -> Result<Vec<serde_json::Value>, String> {
    let taken = state.state.lock().unwrap().taken.clone();
    Ok(project_hotkeys::taken_json(&taken))
}

/// Иконки пунктов меню. Список собирает страница: Rust про меню не знает.
///
/// `async` — по той же причине, что и у `project_hotkeys_taken`: синхронная
/// команда выполняется в потоке цикла событий, а тут поход в файловую систему
/// за четырьмя иконками.
#[tauri::command]
async fn action_icons(
    specs: Vec<icons::IconSpec>,
    cache: tauri::State<'_, icons::Cache>,
) -> Result<std::collections::HashMap<String, String>, String> {
    Ok(icons::icons_for(&specs, &cache))
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

/// Умолчание второго хоткея — открыть пикер сразу в режиме проектов.
///
/// Развилка по системам здесь есть, в отличие от первого хоткея: `SUPER`
/// объединяет Cmd и Win, но объединять тут нечего — комбинации выбраны разные
/// (`Win+Shift+F10` против `Option+Cmd+Shift+C`), и одной записью они не
/// сходятся. Что обе половины развилки не разъехались с записями для меню,
/// сторожит тест — но только на своей системе: другая ветка на ней не
/// собирается вовсе.
#[cfg(target_os = "macos")]
fn default_projects_shortcut() -> Shortcut {
    Shortcut::new(
        Some(Modifiers::ALT | Modifiers::SUPER | Modifiers::SHIFT),
        Code::KeyC,
    )
}

#[cfg(not(target_os = "macos"))]
fn default_projects_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::F10)
}

/// То же умолчание записью для меню трея — и по той же причине рядом:
/// разойдись они, меню обещало бы одну клавишу, а слушалась бы другая. Что
/// это одна и та же комбинация, сторожит тест.
#[cfg(target_os = "macos")]
const DEFAULT_PROJECTS_ACCELERATOR: &str = "Alt+Super+Shift+C";

#[cfg(not(target_os = "macos"))]
const DEFAULT_PROJECTS_ACCELERATOR: &str = "Super+Shift+F10";

/// Действующий хоткей пикера и запись, которой его показывать в меню.
///
/// Запись нельзя взять у самого `Shortcut`: его `Display` печатает
/// `shift+super+KeyC` — форма для разбора, а не для человека. Поэтому наружу
/// идёт строка из конфига как написана, а при откате к умолчанию — запись
/// умолчания. Показывается именно действующий хоткей: непонятая строка в меню
/// обещала бы клавишу, которой никто не слушает.
pub(crate) fn picker_hotkey(config: &serde_json::Value) -> (Shortcut, String) {
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

/// Действующий хоткей режима проектов и запись для меню.
///
/// Тем же устройством, что и `picker_hotkey`, и по тем же причинам: строка из
/// конфига идёт наружу как написана, непонятая — откатывается на умолчание,
/// а показывается всегда действующая.
/// Пустая строка читается как «ключа нет», а не как испорченная комбинация:
/// умолчание здесь своё на каждой системе и живёт только тут, поэтому в
/// `config.yaml` и в окне настроек пустое поле значит «взять встроенное». У
/// первого хоткея такой развилки нет — там умолчание одно на обе системы, и
/// окно настроек пишет его строкой.
pub(crate) fn projects_hotkey(config: &serde_json::Value) -> (Shortcut, String) {
    if let Some(s) = config
        .get("projectsHotkey")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
    {
        match s.parse::<Shortcut>() {
            Ok(sc) => return (sc, s.to_string()),
            Err(_) => eprintln!("ccfzf-picker: cannot parse projectsHotkey {s}, using default"),
        }
    }
    (
        default_projects_shortcut(),
        DEFAULT_PROJECTS_ACCELERATOR.to_string(),
    )
}

/// Время сборки этого бинаря, если оно в него вшито.
///
/// `None` у релизной сборки: её называет версия, а штамп там лишний. Ноль в
/// штампе значит именно это — см. `build.rs`.
fn build_time() -> Option<NaiveDateTime> {
    let secs: i64 = env!("CCFZF_BUILD_UNIX").parse().ok()?;
    if secs == 0 {
        return None;
    }
    Some(Local.timestamp_opt(secs, 0).single()?.naive_local())
}

/// Подпись неактивного пункта меню: какая сборка сейчас запущена.
///
/// Дата опускается, когда сборка сегодняшняя, — чаще всего так и есть, а
/// повторять сегодняшнее число в трее незачем. «Сегодня» считается от запуска
/// пикера, а не от открытия меню: меню строится один раз при старте, и у
/// процесса, прожившего в трее сутки, подпись устареет — покажет время без
/// даты у вчерашней сборки. Цена известна и принята: пикер, проживший сутки,
/// перезапускали не сегодня, и вопрос «то ли собралось» к нему не стоит.
fn version_item_label(version: &str, built: Option<NaiveDateTime>, today: NaiveDate) -> String {
    let Some(built) = built else {
        return format!("v{version}");
    };
    if built.date() == today {
        format!("v{version} · {}", built.format("%H:%M"))
    } else {
        format!("v{version} · {}", built.format("%Y-%m-%d %H:%M"))
    }
}

/// Пункты трея, открывающие пикер в названном режиме: id пункта, имя режима,
/// подпись.
///
/// Одна таблица на сборку меню и на разбор нажатия. Два списка разошлись бы
/// молча и самым тихим отказом из возможных: пункт в меню есть, нажатие
/// проходит через `on_menu_event` и не находит своей ветки — ни ошибки, ни
/// следа, просто ничего не происходит. Та же причина, по которой у пикера одна
/// таблица `PREFIXES` на разбор, снятие и вставку префикса.
///
/// Имена режимов здесь — те же, что в `PREFIXES` (`frontend-src/picker-mode.js`):
/// они уезжают на страницу телом события `picker-mode` и там ищутся в этой
/// таблице. Опечатка стоит молчащего пункта меню, и поймать её можно только
/// сверкой двух файлов — сторож `test/tray-modes.test.js`.
///
/// Слова `Show` в подписях нет намеренно: оно было бы одинаковым у всех пяти
/// пунктов и потому не различало бы ничего.
const MODE_MENU: [(&str, &str, &str); 4] = [
    ("show-projects", "projects", "Projects"),
    ("show-remote", "remote", "Remote"),
    ("show-history", "history", "History"),
    ("show-snapshots", "snapshots", "Snapshots"),
];

/// Режим, который открывает пункт меню с таким id.
fn mode_for_menu_id(id: &str) -> Option<&'static str> {
    MODE_MENU
        .iter()
        .find(|(item_id, _, _)| *item_id == id)
        .map(|(_, mode, _)| *mode)
}

/// Подпись пункта «показать» в меню трея.
///
/// Про занятый хоткей говорит подпись, а не правая колонка: колонка — нативный
/// слот акселератора, и произвольный текст туда не положить. Сама комбинация
/// при этом остаётся на месте — человеку надо видеть, какая именно клавиша не
/// сработала, а не только то, что что-то не сработало.
fn show_item_label(hotkey_registered: bool) -> &'static str {
    if hotkey_registered {
        "Sessions"
    } else {
        "Hotkey is taken, click here"
    }
}

/// Подпись пункта «проекты» — по тому же правилу, что и у «показать»: отказ
/// регистрации называет подпись, а комбинация остаётся в правой колонке.
/// Своя строка, а не общая с `show_item_label`: у двух хоткеев отказ разный,
/// и «Hotkey is taken» под обоими пунктами не сказало бы, какой именно.
///
/// Рабочую подпись берёт из `MODE_MENU`, а не пишет вторично: пункт «проекты»
/// — такой же пункт-режим, как три соседних, и разойдись эти два написания,
/// меню называло бы один и тот же режим по-разному в зависимости от того,
/// встал ли хоткей.
fn projects_item_label(hotkey_registered: bool) -> &'static str {
    if hotkey_registered {
        MODE_MENU[0].2
    } else {
        "Projects hotkey is taken, click here"
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
            hide_picker, app_version, set_picker_size, poll_now, spawn_detached, load_seen, save_seen, load_config,
            terminal_helper,
            copy_to_clipboard, load_ui, save_ui, focus_window_mqtt, unread_session_mqtt,
            restore_snapshot_mqtt, open_session_mqtt, open_project_mqtt, new_session_mqtt,
            save_config, open_settings, project_hotkeys_taken, action_icons,
            set_comment
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

            // Опросом владеет Rust, а не страница: у скрытого окна webview
            // тормозит таймеры, а WebView2 у свёрнутого умеет усыплять
            // страницу целиком. Фон на setInterval замолчал бы, и узнать об
            // этом было бы неоткуда — панель просто перестала бы обновляться.
            let ssh_host = config
                .get("sshHost")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let background = config
                .get("backgroundRefresh")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            app.manage(poller::Poller::start(app.handle().clone(), ssh_host, background));

            // Клик мимо окна закрывает пикер. Окно безрамочное и всегда
            // поверх: не закрывшись само, оно осталось бы висеть над той
            // работой, ради которой его и открывали. Ключ в конфиге на случай,
            // когда список нужен рядом с терминалом — например, чтобы читать
            // из него pid, пока набираешь команду в другом окне.
            //
            // Обработчик ставится всегда, а решает по флагу: см. `HideOnBlur`.
            app.manage(HideOnBlur(AtomicBool::new(hide_on_blur(&config))));
            // Доли экрана — тем же приёмом и по той же причине: их
            // переставляет `apply_config`, а читает `apply_picker_size`.
            app.manage(WindowScale(Mutex::new(picker_scale(&config))));
            // Флаги подложки — тем же приёмом: их переставляет `apply_config`,
            // а читает `apply_scrim`.
            app.manage(ScrimFlags(Mutex::new(scrim_flags(&config))));
            // Список хоткеев приезжает ответом агрегатора, а не из конфига:
            // единственный его источник — claudeWt.projects у
            // windows11-manager. До первого ответа висит список прошлого
            // запуска.
            app.manage(project_hotkeys::Registered::default());
            // Просьба о размере, пришедшая по скрытому окну, ждёт здесь до
            // показа: центровать окно, у которого нет экрана, нечем. См.
            // `SizeRequest`.
            app.manage(PickerSize::default());
            // Иконки меню читаются из exe на первый показ и держатся до
            // перезапуска: ключ кеша знает mtime, так что обновившийся exe
            // перечитается сам.
            app.manage(icons::Cache::default());
            if let Some(window) = app.get_webview_window("picker") {
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(false) = event {
                        if hide_on_blur_now(&handle) {
                            hide_window(&handle);
                        }
                    }
                });
            }

            // Хоткей пикера ставится общей с `apply_config` функцией: раньше
            // здесь была вторая копия того же кода со своей обработкой
            // отказа, и любая будущая правка регистрации требовала бы двух
            // правок.
            //
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
            let (hotkey_registered, hotkey_accelerator) =
                register_picker_hotkey(app.handle(), &config);
            let (projects_registered, projects_accelerator) =
                register_projects_hotkey(app.handle(), &config);

            // Меню трея строится здесь, а не в начале setup: ему нужны и
            // хоткей, и то, чем кончилась его регистрация.
            //
            // Акселератор — украшение, и разбирает его не тот код, что хоткей
            // (muda против global-hotkey). Строку, которую muda не понял,
            // `with_id` вернёт ошибкой, а `?` уронил бы приложение на старте —
            // из-за подписи в меню. Поэтому отказ означает пункт без правой
            // колонки, а не отсутствие трея.
            let (show_text, show_accel) =
                menu_item_parts(show_item_label(hotkey_registered), &hotkey_accelerator);
            let show_item = match MenuItem::with_id(
                app,
                "show",
                &show_text,
                true,
                show_accel.as_deref(),
            ) {
                Ok(item) => item,
                Err(e) => {
                    eprintln!(
                        "ccfzf-picker: cannot show hotkey {hotkey_accelerator} in tray menu: {e}"
                    );
                    MenuItem::with_id(app, "show", &show_text, true, None::<&str>)?
                }
            };
            // Сохраняется в состоянии, чтобы `apply_config` мог поправить эту
            // же подпись и акселератор после сохранения настроек — без
            // пересборки всего меню на каждое сохранение.
            app.manage(ShowMenuItem(show_item.clone()));
            // Второй пункт — вход в режим проектов, тем же устройством, что и
            // первый: подпись говорит об отказе, акселератор показывается
            // всегда, а строку, которую muda не понял, пункт переживает без
            // правой колонки.
            let (projects_text, projects_accel) = menu_item_parts(
                projects_item_label(projects_registered),
                &projects_accelerator,
            );
            let projects_item = match MenuItem::with_id(
                app,
                "show-projects",
                &projects_text,
                true,
                projects_accel.as_deref(),
            ) {
                Ok(item) => item,
                Err(e) => {
                    eprintln!(
                        "ccfzf-picker: cannot show hotkey {projects_accelerator} in tray menu: {e}"
                    );
                    MenuItem::with_id(app, "show-projects", &projects_text, true, None::<&str>)?
                }
            };
            app.manage(ProjectsMenuItem(projects_item.clone()));
            // Остальные пункты-режимы — из той же таблицы, что и проектный, но
            // без акселератора и без подписи об отказе: хоткея у этих трёх
            // режимов нет вовсе, и отказываться нечему. Строятся циклом, а не
            // тремя вызовами подряд: список пунктов уже есть в `MODE_MENU`, и
            // второй, написанный руками здесь, разошёлся бы с ним молча.
            let mode_items = MODE_MENU[1..]
                .iter()
                .map(|(id, _, label)| MenuItem::with_id(app, *id, *label, true, None::<&str>))
                .collect::<Result<Vec<_>, _>>()?;
            // Настройки — второй пункт, между показом и выходом. Из трея они
            // достижимы и тогда, когда до шестерёнки в статуслайне не добраться:
            // хоткей не встал, а пикер не открывается по той самой настройке,
            // которую надо и поправить.
            let settings_item =
                MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            // Неактивный пункт: он не действие, а подпись. Стоит последним,
            // под «Quit», — читают его редко, а два верхних пункта нажимают
            // каждый день, и сдвигать их ради подписи нельзя.
            let version_item = MenuItem::with_id(
                app,
                "version",
                version_item_label(
                    env!("CARGO_PKG_VERSION"),
                    build_time(),
                    Local::now().date_naive(),
                ),
                false,
                None::<&str>,
            )?;
            // Порядок пунктов — порядок `MODE_MENU`: сперва общий список, за
            // ним режимы, и лишь потом служебное. Пункты-режимы нажимают
            // каждый день, «Settings…» и «Quit» — редко.
            let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
                vec![&show_item, &projects_item];
            items.extend(
                mode_items
                    .iter()
                    .map(|item| item as &dyn tauri::menu::IsMenuItem<tauri::Wry>),
            );
            items.push(&settings_item);
            items.push(&quit_item);
            items.push(&version_item);
            let tray_menu = Menu::with_items(app, &items)?;
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
                    // Через spawn, а не вызовом на месте: обработчик меню
                    // крутится в потоке цикла событий, а webview на Windows
                    // дозревает через этот же цикл. Занятый цикл — то самое
                    // окно настроек, которое появляется белым прямоугольником и
                    // не загружает страницу никогда; ровно ради этого
                    // `open_settings` и сделан `async`.
                    "settings" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = open_settings(app).await {
                                eprintln!("ccfzf-picker: {e}");
                            }
                        });
                    }
                    "quit" => app.exit(0),
                    // Пункты-режимы разбираются таблицей, а не веткой на
                    // каждый: ветка, забытая при заведении пятого режима, дала
                    // бы пункт меню, который молча ничего не делает.
                    id => {
                        if let Some(mode) = mode_for_menu_id(id) {
                            show_in_mode(app, mode);
                        }
                    }
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

            project_hotkeys::apply_cached(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ccfzf-picker");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(y: i32, m: u32, d: u32, hh: u32, mm: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(hh, mm, 0)
            .unwrap()
    }

    /// Релизную сборку называет версия — штампа у неё нет вовсе.
    #[test]
    fn version_item_names_the_release_by_version_alone() {
        let today = NaiveDate::from_ymd_opt(2026, 8, 14).unwrap();
        assert_eq!(version_item_label("0.1.0", None, today), "v0.1.0");
    }

    /// Сегодняшняя сборка — без даты: повторять сегодняшнее число незачем.
    #[test]
    fn version_item_drops_todays_date() {
        let today = NaiveDate::from_ymd_opt(2026, 8, 14).unwrap();
        assert_eq!(
            version_item_label("0.1.0", Some(at(2026, 8, 14, 14, 32)), today),
            "v0.1.0 · 14:32"
        );
    }

    /// Вчерашняя — с датой: без неё «14:32» читалось бы как сегодняшнее время,
    /// то есть врало бы ровно в том случае, ради которого пункт и заведён.
    #[test]
    fn version_item_keeps_an_older_date() {
        let today = NaiveDate::from_ymd_opt(2026, 8, 14).unwrap();
        assert_eq!(
            version_item_label("0.1.0", Some(at(2026, 8, 13, 14, 32)), today),
            "v0.1.0 · 2026-08-13 14:32"
        );
    }

    /// Свой каталог во временной директории на каждый тест: `write_config`
    /// трогает реальную файловую систему, и тесты не должны видеть файлы друг
    /// друга при параллельном запуске.
    fn temp_config_path(tag: &str) -> std::path::PathBuf {
        static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir()
            .join(format!("ccfzf-picker-test-{}-{tag}-{n}", std::process::id()))
            .join("config.yaml")
    }

    /// Конфига нет вовсе — `write_config` создаёт и каталог, и файл, а не
    /// падает на отсутствующем `.config/ccfzf-picker`.
    #[test]
    fn write_config_creates_missing_directory_and_file() {
        let path = temp_config_path("missing-dir");
        assert!(!path.parent().unwrap().exists());
        write_config(&path, &serde_json::json!({"sshHost": "host"})).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("host"), "{text}");
    }

    /// Нетронутое (в том числе `actions`, для которого редактора ещё нет)
    /// переживает запись через `write_config` — не только через голый
    /// `merge_patch`, который тестирует C3.
    #[test]
    fn write_config_keeps_untouched_keys() {
        let path = temp_config_path("untouched");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "sshHost: old\nactions:\n  - id: finder\n    argv: ['open']\n").unwrap();
        write_config(&path, &serde_json::json!({"sshHost": "new"})).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("new"), "{text}");
        assert!(!text.contains("old"), "{text}");
        assert!(text.contains("finder"), "чужой ключ пережил запись: {text}");
    }

    /// Бэкап кладётся один раз и не затирается вторым сохранением: иначе
    /// второе сохранение стёрло бы единственную копию исходного файла
    /// собственным, уже применённым, состоянием.
    #[test]
    fn write_config_backs_up_once() {
        let path = temp_config_path("backup-once");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "sshHost: original\n").unwrap();

        write_config(&path, &serde_json::json!({"sshHost": "first"})).unwrap();
        let backup = path.with_extension("yaml.bak");
        let backup_text = std::fs::read_to_string(&backup).unwrap();
        assert!(backup_text.contains("original"), "{backup_text}");

        write_config(&path, &serde_json::json!({"sshHost": "second"})).unwrap();
        let backup_text = std::fs::read_to_string(&backup).unwrap();
        assert!(
            backup_text.contains("original"),
            "второе сохранение не должно тронуть бэкап: {backup_text}"
        );
    }

    /// Файл из одних пробелов — тоже «был пустым»: бэкап ему не полагается,
    /// как и файлу, которого нет вовсе.
    #[test]
    fn write_config_does_not_back_up_whitespace_only_file() {
        let path = temp_config_path("whitespace-only");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "   \n\n").unwrap();
        write_config(&path, &serde_json::json!({"sshHost": "host"})).unwrap();
        assert!(!path.with_extension("yaml.bak").exists());
    }

    /// `mqtt: null` в патче отклоняется, а не подменяет блок целиком — иначе
    /// `merge_patch` стёр бы `mqtt.password` молча.
    #[test]
    fn write_config_rejects_null_top_level_value() {
        let path = temp_config_path("null-patch");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "mqtt:\n  host: broker\n  password: secret\n").unwrap();
        let err = write_config(&path, &serde_json::json!({"mqtt": null})).unwrap_err();
        assert!(err.contains("mqtt"), "{err}");
        // Файл не тронут отказавшимся патчем — пароль на месте.
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("secret"), "{text}");
    }

    /// `null` во вложенном ключе отклоняется так же, как в верхнем.
    ///
    /// Проверка верхнего уровня пропускала `{"mqtt": {"password": null}}` —
    /// патч, который стирает ровно тот ключ, ради которого написано слияние по
    /// ключам. Сегодняшняя форма такого не собирает, но цена ошибки — пароль.
    #[test]
    fn write_config_rejects_null_at_any_depth() {
        let path = temp_config_path("null-nested");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "mqtt:\n  host: broker\n  password: secret\n").unwrap();
        let err = write_config(&path, &serde_json::json!({"mqtt": {"password": null}})).unwrap_err();
        assert!(err.contains("password"), "{err}");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("secret"), "пароль пережил отказ: {text}");
    }

    /// Конфиг и его бэкап читает только владелец: в файле лежит
    /// `mqtt.password`, а заводит файл теперь окно настроек, а не человек.
    #[cfg(unix)]
    #[test]
    fn write_config_keeps_files_private() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_config_path("permissions");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // Права нарочно шире нужных: сохранение обязано их сузить, а не
        // унаследовать.
        std::fs::write(&path, "mqtt:\n  password: secret\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        write_config(&path, &serde_json::json!({"sshHost": "host"})).unwrap();
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600, "config.yaml");
        assert_eq!(mode(&path.with_extension("yaml.bak")), 0o600, "config.yaml.bak");
    }

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

    /// `hideOnBlur` читается одной функцией — той же на старте и в
    /// `apply_config`.
    ///
    /// Раньше значение читалось только в `setup`, и переключатель в окне
    /// настроек молчал до перезапуска. Теперь его читают дважды, и разойтись
    /// эти чтения не должны: умолчание «гасить», а не «оставить окно висеть».
    #[test]
    fn hide_on_blur_defaults_to_hiding() {
        assert!(hide_on_blur(&serde_json::json!({})));
        assert!(hide_on_blur(&serde_json::Value::Null));
        assert!(hide_on_blur(&serde_json::json!({"hideOnBlur": "нет"})));
        assert!(hide_on_blur(&serde_json::json!({"hideOnBlur": true})));
        assert!(!hide_on_blur(&serde_json::json!({"hideOnBlur": false})));
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

    /// То же про второй хоткей, и сторож нужен ему сильнее: у него умолчаний
    /// два, по одному на систему, и собирается на каждой из них только своё —
    /// разъехавшуюся пару увидит лишь та машина, где её и завели.
    #[test]
    fn default_projects_accelerator_matches_default_shortcut() {
        assert_eq!(
            DEFAULT_PROJECTS_ACCELERATOR.parse::<Shortcut>().unwrap(),
            default_projects_shortcut()
        );
    }

    /// Два умолчания не совпадают: второй хоткей открывает другой режим, и
    /// одна комбинация на оба означала бы, что один из них не работает вовсе.
    #[test]
    fn two_global_hotkeys_do_not_collide() {
        assert_ne!(default_projects_shortcut(), default_picker_shortcut());
    }

    /// Про занятый второй хоткей меню тоже говорит подписью, и подпись эта
    /// своя: «Hotkey is taken» под обоими пунктами не сказало бы, какой из
    /// двух не встал.
    #[test]
    fn tray_label_tells_which_hotkey_is_taken() {
        assert_eq!(projects_item_label(true), "Projects");
        assert_ne!(projects_item_label(false), projects_item_label(true));
        assert_ne!(projects_item_label(false), show_item_label(false));
    }

    /// Нажатие на каждый пункт-режим доходит до режима.
    ///
    /// Сторож про таблицу, а не про поведение: пункт меню, чей id никуда не
    /// разбирается, — самый тихий отказ из возможных. Нажатие проходит, ветки
    /// себе не находит, и ни ошибки, ни следа не остаётся.
    #[test]
    fn every_mode_menu_item_resolves_to_a_mode() {
        for (id, mode, label) in MODE_MENU {
            assert_eq!(mode_for_menu_id(id), Some(mode), "пункт {id} без режима");
            assert!(!label.is_empty(), "пункт {id} без подписи");
        }
        assert_eq!(mode_for_menu_id("quit"), None);
        assert_eq!(mode_for_menu_id("show"), None);
    }

    /// Слова `Show` в подписях нет: одинаковое у всех пяти пунктов, оно не
    /// различало бы ничего. Проверяются и пункт «Sessions», и все режимы —
    /// правка одной подписи не должна тихо разъехаться с остальными.
    #[test]
    fn tray_labels_name_the_mode_without_show() {
        assert_eq!(show_item_label(true), "Sessions");
        for (_, _, label) in MODE_MENU {
            assert!(!label.contains("Show"), "подпись {label} со словом Show");
        }
    }

    /// Клавиша Win зовётся `Win`, как она и подписана на клавиатуре.
    ///
    /// muda пишет её словом `Windows` — хардкод в его `Display`, — и
    /// `Windows+Shift+C` длиннее самого пункта меню. Проверяются все имена
    /// модификатора, которые понимает разбор хоткея: человек мог написать в
    /// `config.yaml` любое из них, и колонка обязана называть клавишу одинаково
    /// независимо от того, какое он выбрал.
    #[test]
    fn the_super_key_is_shown_as_win() {
        for written in [
            "Super+Shift+C", "super+shift+c", "Cmd+Shift+C", "Command+Shift+C",
            "Meta+Shift+C", "Win+Shift+C", "Windows+Shift+C",
        ] {
            let shown = accelerator_text(written);
            assert!(shown.starts_with("Win+"), "{written} показан как {shown}");
            assert!(!shown.contains("Windows"), "{written} показан как {shown}");
        }
        assert_eq!(accelerator_text("Alt+Super+Shift+C"), "Alt+Win+Shift+C");
    }

    /// Прочие части строки идут как есть: в колонке человек ищет глазами то,
    /// что сам написал в конфиге, а не каноническую форму.
    #[test]
    fn other_parts_of_the_combination_are_left_alone() {
        assert_eq!(accelerator_text("Ctrl+Shift+F10"), "Ctrl+Shift+F10");
        assert_eq!(accelerator_text(""), "");
    }

    /// Комбинация уезжает либо в подпись, либо в нативный слот — но не в оба
    /// сразу и не в никуда.
    ///
    /// Оба разом означали бы две колонки в одной строке: свою через табуляцию и
    /// мудовскую поверх неё. Ни одного — пункт без комбинации вовсе, а человеку
    /// надо видеть, какая именно клавиша не сработала.
    #[test]
    fn the_combination_goes_to_exactly_one_place() {
        let (text, accel) = menu_item_parts("Sessions", "Super+Shift+C");
        let in_label = text.contains("Win+Shift+C");
        let in_slot = accel.is_some();
        assert!(in_label != in_slot, "подпись {text:?}, слот {accel:?}");
        // Подпись пункта остаётся первой частью до табуляции — по ней muda
        // читает её обратно (`text.split('\t').next()`).
        assert_eq!(text.split('\t').next(), Some("Sessions"));
    }

    /// Ни id, ни имена режимов не повторяются: одинаковый id означал бы, что
    /// один из двух пунктов недостижим, а `mode_for_menu_id` вернула бы для
    /// него чужой режим.
    #[test]
    fn mode_menu_ids_and_modes_are_unique() {
        for (i, (id, mode, _)) in MODE_MENU.iter().enumerate() {
            for (other_id, other_mode, _) in MODE_MENU.iter().skip(i + 1) {
                assert_ne!(id, other_id, "повторённый id {id}");
                assert_ne!(mode, other_mode, "повторённый режим {mode}");
            }
        }
    }

    /// Второй хоткей обязан переключать окно, а не только показывать.
    ///
    /// Сначала он был сделан показывающим, и на живом пикере это прочиталось
    /// поломкой: от хоткея пикера ждут, что повторное нажатие погасит окно.
    /// Поведением не поймать — нужен настоящий цикл событий и окно, — поэтому
    /// сторожится форма, как у `tray_opens_settings_off_the_event_loop`.
    #[test]
    fn projects_hotkey_toggles_the_window() {
        let src = include_str!("main.rs");
        let body = src
            .split_once("fn toggle_projects(app: &tauri::AppHandle) {")
            .expect("toggle_projects пропал — тест сторожит не то")
            .1;
        let (body, _) = body.split_once("\n}").expect("тело toggle_projects не закрыто");
        assert!(
            body.contains("toggle_window"),
            "второй хоткей обязан идти через общее переключение, а не показывать окно"
        );
    }

    /// Второй хоткей читается из своего ключа и откатывается по тем же трём
    /// развилкам, что и первый.
    #[test]
    fn projects_hotkey_shows_what_is_listened_to() {
        let own = serde_json::json!({ "projectsHotkey": "Cmd+Shift+T" });
        let (sc, accel) = projects_hotkey(&own);
        assert_eq!(sc, "Cmd+Shift+T".parse::<Shortcut>().unwrap());
        assert_eq!(accel, "Cmd+Shift+T");

        for config in [
            serde_json::json!({ "projectsHotkey": "не хоткей" }),
            serde_json::json!({}),
            serde_json::Value::Null,
            // Пустое поле в окне настроек значит «взять встроенное»: умолчание
            // здесь своё на каждой системе, и записать его строкой окно не
            // может — оно не знает, на какой системе окажется конфиг.
            serde_json::json!({ "projectsHotkey": "" }),
            serde_json::json!({ "projectsHotkey": "   " }),
            // Ключ соседа второму хоткею не указ: перепутай их местами — и оба
            // повисли бы на одной комбинации.
            serde_json::json!({ "hotkey": "Cmd+Shift+T" }),
        ] {
            let (sc, accel) = projects_hotkey(&config);
            assert_eq!(sc, default_projects_shortcut(), "конфиг {config}");
            assert_eq!(accel, DEFAULT_PROJECTS_ACCELERATOR, "конфиг {config}");
        }
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
        assert_eq!(show_item_label(true), "Sessions");
        assert_ne!(show_item_label(false), show_item_label(true));
    }

    /// Пункт «Настройки…» из трея не открывает окно в потоке цикла событий.
    ///
    /// `on_menu_event` вызывается из этого потока, а webview на Windows
    /// дозревает через него же: вызов `open_settings` на месте вернул бы белый
    /// прямоугольник без страницы — ровно ту поломку, ради которой команда и
    /// сделана `async`. Поведением это не поймать: окно есть только на Windows
    /// и только в настоящем цикле событий, а `build()` в обоих случаях
    /// отвечает `Ok`. Поэтому сторожится форма — как у `hidden_command` ниже.
    #[test]
    fn tray_opens_settings_off_the_event_loop() {
        let src = include_str!("main.rs");
        let handler = src
            .split_once("\"settings\" => {")
            .expect("пункт settings пропал из меню трея — тест сторожит не то")
            .1;
        let (handler, _) = handler.split_once("\"quit\" =>").expect("обработчик settings не закрыт");
        assert!(
            handler.contains("async_runtime::spawn"),
            "открытие настроек из трея должно уходить в пул, а не в цикл событий"
        );
    }

    /// Команда о занятых клавишах обязана быть `async`.
    ///
    /// Синхронную Tauri исполняет в потоке цикла событий, а она ждёт мьютекс
    /// проектных хоткеев — тот самый, который держит поток поллера, пока
    /// плагин вешает клавиши через главный поток. Синхронной она замыкала бы
    /// круг: страница спросила бы «что не встало», главный поток встал бы на
    /// мьютексе, державший мьютекс — на главном потоке, и приложение
    /// перестало бы отвечать целиком. Поведением это не поймать без живого
    /// приложения, поэтому сторожится форма.
    #[test]
    fn taken_command_runs_off_the_event_loop() {
        let src = include_str!("main.rs");
        // Иголка склеена по той же причине, что и у соседа ниже: литерал лежал
        // бы в файле, который `include_str!` и затягивает, и сторож находил бы
        // себя же. Проверено: с синхронной командой он оставался зелёным.
        let needle = format!("async fn {}", "project_hotkeys_taken");
        assert!(
            src.contains(&needle),
            "project_hotkeys_taken должна быть async — иначе взаимный замок с поллером"
        );
    }

    /// Извлечение иконок не должно ехать в потоке цикла событий: там же
    /// дозревает webview, и синхронная команда, полезшая в четыре exe за
    /// иконками, придержала бы отрисовку окна. Поведением это не поймать —
    /// на быстрой машине разницы не видно, — поэтому сторожится форма.
    #[test]
    fn action_icons_runs_off_the_event_loop() {
        let src = include_str!("main.rs");
        // Иголка склеена, а не написана литералом: `include_str!` затягивает и
        // сам этот файл, и сторож с литералом находил бы себя же — зелёный без
        // команды. Проверено: до появления `action_icons` он так и проходил.
        let needle = format!("async fn {}", "action_icons");
        assert!(
            src.contains(&needle),
            "action_icons должна быть async — иначе извлечение держит цикл событий"
        );
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

    /// Опрос агрегатора не виснет на ssh навсегда.
    ///
    /// С тех пор как опрос переехал в фоновый поток (`poller.rs`), это
    /// единственный поток, который его крутит: повисший `ssh` не просто
    /// задерживает кадр, а не даёт разобрать ни одного сигнала (показ,
    /// скрытие, смену настроек), пока сам не отвалится. Проверить таймаут
    /// поведением здесь дорого — пришлось бы правда вешать соединение;
    /// сторожится форма, как и у `hidden_command` выше.
    #[test]
    fn state_poll_has_ssh_timeouts() {
        let src = include_str!("state_source.rs");
        for opt in [
            "BatchMode=yes",
            "ConnectTimeout=5",
            "ServerAliveInterval=5",
            "ServerAliveCountMax=2",
        ] {
            assert!(src.contains(opt), "у ssh должна быть опция {opt}");
        }
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
actions:
  - label: Open folder
    hotkey: Ctrl+O
    file: open
"#;
        let v: serde_json::Value = serde_yaml::from_str(text).unwrap();
        assert_eq!(v["sshHost"].as_str(), Some("example-host"));
        assert_eq!(v["caps"]["reptyr"].as_bool(), Some(true));
        assert_eq!(v["terminal"]["file"].as_str(), Some("open"));
        assert_eq!(v["terminal"]["args"].as_array().unwrap().len(), 3);
        // Массив объектов — образцом взяты `actions`: проектные хоткеи из
        // конфига ушли к менеджеру, и ключа `projects` здесь больше нет.
        let actions = v["actions"].as_array().unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0]["hotkey"].as_str(), Some("Ctrl+O"));
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

    /// Каталог фронтенда обязан быть объявлен входом сборочного скрипта.
    ///
    /// Поймать это поведением нельзя: cargo решает про `build.rs` до того, как
    /// хоть что-то из нашего кода начнёт выполняться, — и сборка без этой
    /// строки проходит успешно, просто со штампом от прошлого раза. Полдня
    /// на «деплой прошёл, а подпись в трее прежняя» уже потрачены.
    #[test]
    fn build_script_watches_the_frontend() {
        let script = include_str!("../build.rs");
        assert!(
            script.contains("cargo:rerun-if-changed=../frontend"),
            "штамп сборки застынет на прошлой выкатке"
        );
        // Путь тот же, что в конфиге: разойдись они, скрипт следил бы за
        // каталогом, из которого статику никто не берёт.
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["build"]["frontendDist"].as_str().unwrap(), "../frontend");
    }

    /// Помощник обязан разворачивать base64 и держать окно после сессии.
    ///
    /// Обе строки — плата за уже случившееся. Без разбора base64 терминалу
    /// пришлось бы отдавать кавычки, а их токенизатор iTerm2 понимает не так,
    /// как шелл. Без `exec $SHELL` профиль закрыл бы окно вместе с агентом, и
    /// причину отказа снова стало бы не прочитать — слепота, из-за которой
    /// поломку искали дольше, чем следовало.
    #[test]
    fn terminal_helper_decodes_and_holds_the_window() {
        assert!(TERMINAL_HELPER.contains("base64 -d"), "{TERMINAL_HELPER}");
        assert!(TERMINAL_HELPER.contains("eval "), "{TERMINAL_HELPER}");
        assert!(TERMINAL_HELPER.contains("exec \"${SHELL:-/bin/sh}\" -i"), "{TERMINAL_HELPER}");
        // Первой строкой — шебанг: файл зовут по пути, а не через `sh <файл>`.
        assert!(TERMINAL_HELPER.starts_with("#!/bin/sh\n"), "{TERMINAL_HELPER}");
    }

    /// Узкий размер обязан совпадать с тем, что стоит в tauri.conf.json:
    /// разойдись они, выход из режима давал бы окно не того размера, с
    /// которым пикер открылся, и поймать это можно было бы только глазами.
    #[test]
    fn narrow_size_matches_the_window_config() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let window = &conf["app"]["windows"][0];
        assert_eq!(window["width"].as_f64().unwrap(), NARROW_SIZE.0);
        assert_eq!(window["height"].as_f64().unwrap(), NARROW_SIZE.1);
    }

    /// Широкий шире узкого — иначе режим не делает того, ради чего заведён.
    #[test]
    fn wide_size_is_wider_than_narrow() {
        assert!(WIDE_SIZE.0 > NARROW_SIZE.0);
        assert!(WIDE_SIZE.1 > NARROW_SIZE.1);
    }

    /// На большом экране зажимать нечего: человек просил широкое окно, он его
    /// и получает. Зажми оно и здесь, широкий режим на внешнем мониторе стал
    /// бы меньше, чем задумано, без всякой на то причины.
    #[test]
    fn big_screen_gives_the_wanted_size() {
        assert_eq!(fit_to_screen(WIDE_SIZE, (2560.0, 1440.0)), WIDE_SIZE);
    }

    /// ≥101 — пиксели, а не доля: число едет как есть и зажимается только
    /// экраном, как встроенный размер. Смешанная сторона (ширина в пикселях,
    /// высота в процентах) — рабочий случай: оси считаются независимо.
    #[test]
    fn pixels_are_absolute_then_fitted() {
        let conf = serde_json::json!({"pickerSize": {"narrow": {"width": 1400.0, "height": 65.0}}});
        let scale = picker_scale(&conf);
        assert_eq!(scale.narrow.0, 1400.0);
        assert_eq!(scale.narrow.1, 65.0);
        let (w, h) = wanted_size(false, scale, Some((2560.0, 1440.0)));
        assert_eq!(w, 1400.0);
        assert_eq!(h, 1440.0 * 0.65);
    }

    /// 100% — это `scale_axis` = 100, доля экрана, а не `set_fullscreen`: окно
    /// встаёт вровень с экраном по числам, а не переходит в системный
    /// полноэкранный режим, который отобрал бы у Windows панель задач, а у
    /// мака — место под вырезом.
    #[test]
    fn hundred_percent_is_the_screen_not_fullscreen() {
        let conf = serde_json::json!({"pickerSize": {"narrow": {"width": 100.0, "height": 100.0}}});
        let (w, h) = wanted_size(false, picker_scale(&conf), Some((1920.0, 1080.0)));
        assert_eq!((w, h), (1920.0, 1080.0));
    }

    /// Тринадцатидюймовый мак: логические 1440×900 меньше желаемых 1400×900 по
    /// высоте и почти равны по ширине. Окно обязано выйти строго меньше экрана
    /// по обеим сторонам — иначе оно закроет экран целиком и залезет под
    /// строку меню, а подвинуть его нечем.
    #[test]
    fn small_screen_leaves_something_visible() {
        let screen = (1440.0, 900.0);
        let (w, h) = fit_to_screen(WIDE_SIZE, screen);
        assert!(w < screen.0, "ширина {w} не оставила полосы на экране {screen:?}");
        assert!(h < screen.1, "высота {h} не оставила полосы на экране {screen:?}");
        assert!(w > 0.0 && h > 0.0, "зажатое окно схлопнулось: {w}×{h}");
    }

    /// Окно настроек высокое, и ровно на распространённом экране 1920×1080 его
    /// высота совпадает с высотой экрана. Незажатым оно ушло бы под панель
    /// задач — вместе с кнопкой сохранения, которая в нём внизу.
    #[test]
    fn settings_window_fits_a_1080p_screen() {
        let screen = (1920.0, 1080.0);
        let (w, h) = fit_to_screen(SETTINGS_SIZE, screen);
        assert_eq!(w, SETTINGS_SIZE.0, "ширину зажимать не за что: {w}");
        assert!(h < screen.1, "высота {h} не оставила полосы на экране {screen:?}");
    }

    /// Пустой конфиг — встроенные размеры, и это умолчание. Ключа `pickerSize`
    /// у большинства нет вовсе, и он не должен ничего менять.
    #[test]
    fn empty_config_keeps_the_built_in_size() {
        assert_eq!(picker_scale(&serde_json::json!({})), PickerScale::default());
        assert_eq!(picker_scale(&serde_json::Value::Null), PickerScale::default());
    }

    /// Ноль — это и есть «взять встроенный размер», и пишет его окно настроек:
    /// удалить ключ из `config.yaml` нечем — `merge_patch` только вставляет.
    #[test]
    fn zero_means_the_built_in_size() {
        let conf = serde_json::json!({"pickerSize": {"narrow": {"width": 0, "height": 0}}});
        assert_eq!(picker_scale(&conf), PickerScale::default());
    }

    /// Испорченное и вышедшее из диапазона откатывается на встроенное, а не
    /// роняет запуск и не растягивает окно на десять экранов. 300 из этого
    /// списка ушёл: с приходом пикселей это больше не мусор, а валидный
    /// размер — см. `pixels_are_absolute_then_fitted` и тест ниже. Мусором
    /// остался только зазор между долей и пикселями, `(100..101)`.
    #[test]
    fn broken_scale_falls_back_to_the_built_in_size() {
        let scale = |v: serde_json::Value| {
            picker_scale(&serde_json::json!({"pickerSize": {"narrow": {"height": v}}})).narrow.1
        };
        assert_eq!(scale(serde_json::json!("восемьдесят")), 0.0);
        assert_eq!(scale(serde_json::json!(null)), 0.0);
        assert_eq!(scale(serde_json::json!(0)), 0.0);
        assert_eq!(scale(serde_json::json!(-10)), 0.0);
        assert_eq!(scale(serde_json::json!(100.5)), 0.0);
        // Границы диапазона — рабочие значения, а не отказ.
        assert_eq!(scale(serde_json::json!(1)), 1.0);
        assert_eq!(scale(serde_json::json!(100)), 100.0);
    }

    /// ≥101 — рабочие пиксели, не мусор: тот же счётчик без верхней границы,
    /// см. `pixels_are_absolute_then_fitted` для сборки размера целиком.
    #[test]
    fn pixels_above_100_are_accepted_by_scale_axis() {
        let scale = |v: serde_json::Value| {
            picker_scale(&serde_json::json!({"pickerSize": {"narrow": {"width": v}}})).narrow.0
        };
        assert_eq!(scale(serde_json::json!(101)), 101.0);
        assert_eq!(scale(serde_json::json!(1400)), 1400.0);
    }

    /// Список — источник истины для Rust; тот же список по смыслу живёт в
    /// JS (`SIZE_BOUNDARY_TABLE` в `test/config-shape.test.js`) и обязан
    /// давать те же ответы на каждое число. Прежний сторож на JS-стороне
    /// сверял только текст исходника (упоминание `101.0`) — этот список
    /// гоняет оба конца по одним числам и ловит расхождение в поведении, а
    /// не в тексте: разошедшийся диапазон читался бы формой как принятое
    /// значение, а Rust'ом — как отвергнутое, и окно вышло бы не того
    /// размера без единого объяснения на экране.
    #[test]
    fn scale_axis_boundary_table_matches_js() {
        let width = |v: serde_json::Value| {
            picker_scale(&serde_json::json!({"pickerSize": {"narrow": {"width": v}}})).narrow.0
        };
        let cases: &[(serde_json::Value, f64)] = &[
            (serde_json::json!(0), 0.0),               // встроенный размер
            (serde_json::json!(0.5), 0.0),              // дробное меньше единицы
            (serde_json::json!(1), 1.0),                // нижняя граница доли
            (serde_json::json!(100), 100.0),            // верхняя граница доли
            (serde_json::json!(100.5), 0.0),            // зазор между долей и пикселями
            (serde_json::json!(101), 101.0),            // нижняя граница пикселей
            (serde_json::json!(1400), 1400.0),          // рабочий размер в пикселях
            (serde_json::json!(-10), 0.0),              // отрицательное
            (serde_json::json!(f64::INFINITY), 0.0),    // не конечное
            (serde_json::json!(f64::NAN), 0.0),         // не число
        ];
        for (raw, expected) in cases {
            assert_eq!(width(raw.clone()), *expected, "{raw:?}");
        }
    }

    /// Половинки конфига свои у каждой раскладки и у каждой стороны: одна
    /// названная доля не должна утаскивать за собой три остальные.
    #[test]
    fn scale_halves_are_read_separately() {
        let conf = serde_json::json!({"pickerSize": {
            "narrow": {"height": 80},
            "wide": {"width": 95},
        }});
        assert_eq!(picker_scale(&conf), PickerScale { narrow: (0.0, 80.0), wide: (95.0, 0.0) });
    }

    /// Названная доля считается от экрана, и считается по стороне: доля высоты
    /// при встроенной ширине — тот самый случай, ради которого всё затевалось
    /// (в узкий список на большом экране входит куда меньше сессий, чем могло).
    #[test]
    fn a_named_share_is_measured_off_the_screen() {
        let scale = PickerScale { narrow: (0.0, 80.0), ..Default::default() };
        let (w, h) = wanted_size(false, scale, Some((2560.0, 1440.0)));
        assert_eq!(w, NARROW_SIZE.0, "ширину не просили — она встроенная");
        assert_eq!(h, 1152.0, "80% от 1440");
    }

    /// **Доля обходит `SCREEN_FILL`, а встроенный размер — нет.** Зажим
    /// защищает абсолютное число от маленького экрана; доля в экран влезает по
    /// построению, и зажми мы её, выбранные человеком 95% молча стали бы 90% —
    /// пункт списка, обещающий не то, что делает.
    #[test]
    fn a_named_share_is_not_clamped_by_screen_fill() {
        let screen = (1440.0, 900.0);
        let scale = PickerScale { wide: (95.0, 95.0), ..Default::default() };
        assert_eq!(wanted_size(true, scale, Some(screen)), (1368.0, 855.0));
        // А встроенный размер на том же экране зажимается, как и прежде.
        assert_eq!(
            wanted_size(true, PickerScale::default(), Some(screen)),
            fit_to_screen(WIDE_SIZE, screen),
        );
    }

    /// Экран неизвестен — доли не считаются вовсе: `NaN * 0.8` уронил бы окно в
    /// точку, а «сколько это в пикселях» без экрана не ответить. Откат на
    /// встроенное, то есть на прежнее поведение.
    #[test]
    fn no_screen_means_the_built_in_size() {
        let scale = PickerScale { narrow: (50.0, 80.0), wide: (50.0, 80.0) };
        assert_eq!(wanted_size(false, scale, None), NARROW_SIZE);
        assert_eq!(wanted_size(true, scale, None), WIDE_SIZE);
        // Вырожденная сторона экрана — то же самое, и по стороне отдельно.
        let (w, h) = wanted_size(false, scale, Some((0.0, 1440.0)));
        assert_eq!(w, NARROW_SIZE.0);
        assert_eq!(h, 1152.0);
    }

    /// Раскладки не путаются: доля, названная узкой, широкого окна не трогает.
    #[test]
    fn each_layout_takes_its_own_share() {
        let screen = (2560.0, 1440.0);
        let scale = PickerScale { narrow: (0.0, 80.0), wide: (0.0, 0.0) };
        assert_eq!(wanted_size(true, scale, Some(screen)), fit_to_screen(WIDE_SIZE, screen));
    }

    /// Зажимается каждая сторона своя: экран ниже желаемого, но шире, обязан
    /// урезать только высоту. Считай мы по одной стороне, широкий режим на
    /// низком широком мониторе терял бы ширину ни за что.
    #[test]
    fn axes_are_clamped_independently() {
        let (w, h) = fit_to_screen(WIDE_SIZE, (3440.0, 800.0));
        assert_eq!(w, WIDE_SIZE.0);
        assert!(h < 800.0, "высота {h} не зажалась под экран 800");
    }

    /// Тот самый мак: рабочая область 1415×923 при масштабе 2 и Dock слева
    /// (её начало по x — 55), широкое окно после зажима — 1323×860.4
    /// логических. Окно обязано встать посреди рабочей области, а не там, где
    /// его оставил прежний размер: при `center()` намеряно было 312 по левому
    /// краю — центровка считала ширину узкого окна.
    #[test]
    fn a_window_lands_in_the_middle_of_the_work_area() {
        // Рабочая область в физических точках — такой её и отдаёт монитор.
        let x = center_axis(1323.0, 2.0, 110, 2830);
        let y = center_axis(860.4, 2.0, 66, 1846);
        assert_eq!(x, 110 + (2830 - 2646) / 2, "левый край: {x}");
        assert_eq!(y, 66 + (1846 - 1721) / 2, "верхний край: {y}");
    }

    /// Начало рабочей области — не всегда ноль: второй монитор стоит правее
    /// первого, и окно обязано встать посреди своего, а не первого.
    #[test]
    fn the_second_monitor_starts_where_it_starts() {
        assert_eq!(center_axis(900.0, 1.0, 1920, 1920), 1920 + 510);
    }

    /// Окно шире рабочей области прижимается к её началу. Отрицательная доля
    /// увела бы его за левый край экрана, где ни мышью не достать, ни увидеть,
    /// — а окно у нас без декораций, подвинуть его нечем.
    #[test]
    fn a_window_wider_than_the_screen_stays_at_the_edge() {
        assert_eq!(center_axis(1400.0, 1.0, 0, 1000), 0);
        assert_eq!(center_axis(1400.0, 1.0, 55, 1000), 55);
    }

    /// Вырожденный масштаб — «монитор не назвался», а не «окно нулевого
    /// размера»: `as i64` от NaN даёт нуль, и окно уехало бы в угол рабочей
    /// области, будто ширины у него нет вовсе.
    #[test]
    fn a_degenerate_scale_does_not_shrink_the_window_to_a_point() {
        let sane = center_axis(900.0, 1.0, 0, 1920);
        assert_eq!(center_axis(900.0, f64::NAN, 0, 1920), sane);
        assert_eq!(center_axis(900.0, 0.0, 0, 1920), sane);
        assert_eq!(center_axis(900.0, -2.0, 0, 1920), sane);
    }

    /// Показанному окну размер ставится на месте и ничего не откладывает:
    /// `^F` на открытом пикере обязан сработать тем же нажатием, а не ждать
    /// следующего показа.
    #[test]
    fn a_shown_window_gets_the_size_at_once() {
        let mut req = SizeRequest::default();
        assert_eq!(req.asked(true, true), Some(true));
        assert_eq!(req.shown(), None, "применённое не должно применяться дважды");
    }

    /// Скрытому — откладывается: центровать окно, у которого нет экрана,
    /// нечем, и просьба со страницы при загрузке приходит именно по такому.
    #[test]
    fn a_hidden_window_remembers_the_size_until_it_is_shown() {
        let mut req = SizeRequest::default();
        assert_eq!(req.asked(true, false), None);
        assert_eq!(req.shown(), Some(true));
    }

    /// Второй показ подряд окна не трогает: перескок на глазах у человека
    /// хуже, чем ничего, а размер с прошлого показа никуда не делся.
    #[test]
    fn a_second_show_moves_nothing() {
        let mut req = SizeRequest::default();
        req.asked(true, false);
        assert_eq!(req.shown(), Some(true));
        assert_eq!(req.shown(), None);
    }

    /// Просьбы к скрытому окну накапливаются последней: страница может
    /// перечитать `ui.json` дважды (загрузка и `ui-changed`), и применить на
    /// показе надо тот режим, который она назвала последним.
    #[test]
    fn the_last_request_to_a_hidden_window_wins() {
        let mut req = SizeRequest::default();
        assert_eq!(req.asked(true, false), None);
        assert_eq!(req.asked(false, false), None);
        assert_eq!(req.shown(), Some(false));
    }

    /// Просьба к показанному окну снимает отложенную: размер уже поставлен, и
    /// применять на следующем показе нечего.
    #[test]
    fn a_request_to_a_shown_window_clears_the_pending_one() {
        let mut req = SizeRequest::default();
        req.asked(true, false);
        assert_eq!(req.asked(false, true), Some(false));
        assert_eq!(req.shown(), None);
    }

    /// Вырожденный экран — это «монитор не назвался», а не «экран нулевой».
    /// Отдай мы тут долю такого экрана, окно схлопнулось бы в точку или ушло в
    /// отрицательный размер, и пикер пропал бы с глаз без единой ошибки.
    #[test]
    fn degenerate_screen_falls_back_to_the_wanted_size() {
        assert_eq!(fit_to_screen(WIDE_SIZE, (0.0, 0.0)), WIDE_SIZE);
        assert_eq!(fit_to_screen(WIDE_SIZE, (-1920.0, -1080.0)), WIDE_SIZE);
        assert_eq!(fit_to_screen(WIDE_SIZE, (f64::NAN, f64::NAN)), WIDE_SIZE);
        // Одна сторона известна, другая нет — зажимается только известная.
        let (w, h) = fit_to_screen(WIDE_SIZE, (1000.0, 0.0));
        assert!(w < 1000.0, "известная сторона обязана зажаться: {w}");
        assert_eq!(h, WIDE_SIZE.1);
    }
}
