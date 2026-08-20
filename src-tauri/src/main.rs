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
mod desktop_store;
mod icons;
mod local_ccfzf;
// `#[macro_use]`, а не `use` по файлам: `ccfzf_log!` зовут четыре модуля из
// пяти ниже, и все они объявлены после этой строки — макрос виден им всем.
#[macro_use]
mod log;
mod merge_state;
mod mqtt;
mod place_order;
mod poller;
mod proc;
mod project_hotkeys;
mod scrim;
mod session_name;
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
        ccfzf_log!("{e}");
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
    // Раскладка на момент показа — та, что запомнена с прошлого раза
    // (`SizeRequest.fullscreen`); просьба о размере со страницы может её
    // сменить уже после показа, и тогда `set_picker_size` пересчитает и размер,
    // и подложку сам.
    let fullscreen = current_fullscreen(app);
    // Размер и место ставятся **до** `show()` и на каждом показе — не только по
    // отложенной просьбе, как было раньше. Считать по скрытому окну теперь
    // можно: монитор называет приложение, а не окно (`target_monitor`), а
    // невозможность спросить экран у невыведенного окна и была единственной
    // причиной откладывать. До показа — потому что переезд на соседний экран
    // после `show()` человек видел бы рывком: окно появилось бы там, где
    // стояло, и прыгнуло.
    //
    // Отказ стоит строки в stderr, а не возврата: показ окна дороже размера, и
    // не показать его из-за неудавшейся центровки было бы хуже, чем показать не
    // той ширины.
    if let Err(e) = apply_picker_size(app, &window, fullscreen, picker_scale_now(app)) {
        ccfzf_log!("{e}");
    }
    let _ = window.show();
    // Подложка — после показа: монитор она берёт у самого окна пикера
    // (`scrim::monitor_rect`), а у скрытого его нет — та же слепота, из-за
    // которой геометрия считается выше по монитору приложения.
    apply_scrim(app, fullscreen);
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
        ccfzf_log!("pickerSize.{name} is not a number, using the built-in size");
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
    ccfzf_log!(
        "pickerSize.{name} = {pct} must be 0 (Default), 1-100 (percent of screen), or 101 or more (pixels); using the built-in size"
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

/// Монитор, на котором открывать пикер.
///
/// Спрашивается **у приложения**, а не у окна, и это условие всей затеи:
/// геометрия считается до `show()`, а у скрытого окна экрана нет — на macOS
/// `current_monitor` это `ns_window.screen()`, и у невыведенного окна он
/// `nil`. `primary_monitor` и `monitor_from_point` про окно не спрашивают
/// ничего.
///
/// Выключенная галка — главный монитор, и это умолчание: место окна должно
/// быть одним и тем же, чтобы рука вела глаз туда, где список появится.
/// Включённая — экран под курсором: хоткей жмут с клавиатуры, но мышь почти
/// всегда лежит на том экране, куда человек смотрит, а второго признака
/// «активного» экрана без платформенного кода нет (передним окном пришлось бы
/// спрашивать `GetForegroundWindow` на Windows и AX на macOS — две ветки под
/// `cfg`, ни одна из которых не собирается на машине разработки).
///
/// Откат на `current_monitor` окна оставлен последним ходом: не назвался ни
/// курсор, ни главный монитор — считаем по тому экрану, где окно уже стоит.
/// Это ровно то, как пикер вёл себя до появления галки, и хуже прежнего от
/// такого отката не станет.
fn target_monitor(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Option<tauri::window::Monitor> {
    let by_cursor = || {
        let point = app.cursor_position().ok()?;
        app.monitor_from_point(point.x, point.y).ok().flatten()
    };
    let wanted = if show_on_active_display_now(app) { by_cursor() } else { None };
    wanted
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
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
/// Зовётся и по скрытому окну — из `show_picker`, до самого показа: монитор
/// называет приложение (`target_monitor`), а не окно, так что считать есть по
/// чему. Второе место — `set_picker_size`, и вот оно уже только по показанному:
/// просьба со страницы приходит и по скрытому, а ставить размер там нечему,
/// см. `SizeRequest`.
fn apply_picker_size(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    fullscreen: bool,
    scale: PickerScale,
) -> Result<(), String> {
    let monitor = target_monitor(app, window);
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

/// Раскладка, названная страницей последней, и судьба самой просьбы.
///
/// Скрытому окну размер не ставится вовсе. Окно пикера создаётся скрытым
/// (`visible: false` в `tauri.conf.json`), а страница просит размер при каждой
/// своей загрузке — то есть по окну, которого ещё нет на экране. Ставить его
/// там нечему: `set_size` у tao на macOS считает от левого нижнего угла, и
/// невыведенное окно осталось бы у прежнего угла, растянувшись вправо и вниз —
/// именно так это и выглядело живьём, узким окном в углу и широким за правым
/// краем экрана.
///
/// Отсюда разделение: `set_picker_size` применяет размер только по показанному
/// окну, а по скрытому лишь запоминает режим — геометрию поставит `show_picker`
/// перед тем, как окно показать. Решает это Rust, а не страница: у скрытого
/// окна webview умеет усыплять её целиком, и «страница по событию
/// `picker-shown` перепросит размер» замолчала бы ровно в том случае, ради
/// которого затевалось.
///
/// Пометки «отложено» здесь больше нет, и это не упрощение ради краткости.
/// `show_picker` ставит геометрию **на каждом** показе, а не только по
/// отложенной просьбе: монитор ему называет приложение (`target_monitor`), то
/// есть окно на каждом показе обязано ещё и приехать на нужный экран — с
/// галкой «Show on active display» тот меняется без всякой просьбы о размере.
/// Прежний довод против («второй показ подряд — лишний перескок на глазах»)
/// умер вместе с причиной: считается всё до `show()`, и человек видит уже
/// вставшее на место окно.
#[derive(Default, Clone, Copy, PartialEq, Eq, Debug)]
struct SizeRequest {
    /// Последний названный страницей режим списка.
    fullscreen: bool,
}

impl SizeRequest {
    /// Страница назвала режим. Отвечает режимом, если ставить размер надо
    /// сейчас, и `None`, если ставить его некуда — окно скрыто, и геометрию
    /// посчитает ближайший показ.
    fn asked(&mut self, fullscreen: bool, visible: bool) -> Option<bool> {
        self.fullscreen = fullscreen;
        visible.then_some(fullscreen)
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

/// `showOnActiveDisplay` из конфига — ложью по умолчанию.
///
/// Ложь значит «всегда на главном мониторе», и умолчание это, а не
/// отступление: место окна должно быть одним и тем же от открытия к открытию.
/// Не-булево читается как отсутствие ключа и молча: в отличие от `pickerSize`,
/// диапазона тут нет вовсе, а «галка стоит не в том положении» человек видит
/// в окне настроек сразу — объяснять в stderr нечего.
fn show_on_active_display(config: &serde_json::Value) -> bool {
    config
        .get("showOnActiveDisplay")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// `openOnActiveDisplay` из конфига — ложью по умолчанию.
///
/// Галка соседняя с `showOnActiveDisplay`, но не её половинка: та про окно
/// списка, эта про окно терминала, и связывать их нельзя — вопросы разные.
/// Умолчание ложь по той же причине, по какой оно ложь у соседки: пока человек
/// не попросил, окна ставит тот, кто их всегда ставил.
fn open_on_active_display(config: &serde_json::Value) -> bool {
    config
        .get("openOnActiveDisplay")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Спрашивать ли курсор вообще: галка либо нажатый модификатор.
///
/// Чистой и отдельно от `cursor_hint` — ту не проверить вовсе, у неё в
/// аргументах живое приложение, а правило «Ctrl главнее выключенной галки»
/// сломать легко и молча: курсора не будет, окно уедет в запомненный слот, и
/// выглядеть это будет не отказом, а обычным открытием.
fn wants_cursor(config: &serde_json::Value, forced: bool) -> bool {
    forced || open_on_active_display(config)
}

/// Точка курсора для просьбы об открытии сессии — или `None`.
///
/// `None` значит «ключа в теле не будет», и это ровно то, чего мы хотим от
/// выключенной галки: приёмник поставит окно так, как ставил всегда.
///
/// `forced` — Ctrl на строке списка: «открой там, куда я смотрю, и не двигай
/// дальше». Галку он не спрашивает, и это не оплошность: она отвечает на
/// вопрос «как открывать всегда», а нажатый модификатор — на вопрос «как
/// открыть вот эту». Второй развилки по месту заводить нельзя — курсор
/// спрашивают четыре входа, и разошлись бы они молча.
///
/// Курсор спрашивается **у приложения**, тем же ходом, что и в
/// `target_monitor`, — и по той же причине, по какой имя терминала и порядок
/// плитки считает Rust, а не страница: ту же просьбу шлёт проектный хоткей, а
/// его жмут ровно тогда, когда пикер скрыт и webview усыплён.
///
/// На главный поток при этом не переходим намеренно. `run_on_main_thread`
/// отсюда звали бы и из потока поллера (`project_hotkeys::press`), а это тот
/// самый ход, на котором уже стояли: плагин хоткеев блокируется на ответе
/// главного потока, и приложение вставало насмерть. `cursor_position` у
/// приложения такого перехода не требует.
pub(crate) fn cursor_hint(
    app: &tauri::AppHandle,
    config: &serde_json::Value,
    forced: bool,
) -> Option<(f64, f64)> {
    if !wants_cursor(config, forced) {
        return None;
    }
    let point = app.cursor_position().ok()?;
    Some((point.x, point.y))
}

/// Куда ставить новое окно и кто им потом распоряжается — одним ответом.
///
/// `no_autoplace` приходит от Ctrl на строке списка, и без курсора он не
/// уезжает: пометку приёмник ставит на той же дороге, какой ставит окно по
/// курсору (`placeByCursor` в windows11-manager), и просьба «не двигай» без
/// «поставь сюда» молча не сделала бы ничего. Отказ курсора при этом
/// называется в журнале: ответа у публикации нет, и промолчав, мы отдали бы
/// человеку просьбу, выглядящую сработавшей.
pub(crate) fn placement(
    app: &tauri::AppHandle,
    config: &serde_json::Value,
    no_autoplace: bool,
) -> mqtt::Placement {
    let cursor = cursor_hint(app, config, no_autoplace);
    if no_autoplace && cursor.is_none() {
        ccfzf_log!("no cursor position: asking to open without the noAutoplace mark");
    }
    mqtt::Placement {
        cursor,
        no_autoplace: no_autoplace && cursor.is_some(),
    }
}

/// Галка «на активном экране», действующая прямо сейчас — тем же приёмом и по
/// той же причине, что `WindowScale` и `ScrimFlags`: конфиг перечитывает
/// `apply_config`, а монитор выбирают в другом месте и в другое время.
#[derive(Default)]
struct ActiveDisplay(Mutex<bool>);

fn show_on_active_display_now(app: &tauri::AppHandle) -> bool {
    app.try_state::<ActiveDisplay>()
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
        ccfzf_log!("{e}");
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
            let result = apply_picker_size(&app, &window, fullscreen, picker_scale_now(&app));
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

/// Записать комментарий к сессии на машине её источника.
///
/// Адрес называет строка, а не конфиг: с двумя источниками `CONFIG.sshHost`
/// перестал быть адресом чего бы то ни было — комментарий к местной сессии
/// уехал бы на удалённую машину, где такой сессии нет.
///
/// `async` обязателен: ssh идёт до пяти секунд (`ConnectTimeout`), а
/// синхронную команду Tauri выполняет в потоке цикла событий — окно замерло бы
/// на всё это время.
#[tauri::command]
async fn set_comment(
    source: String,
    id: String,
    text: String,
    from: String,
) -> Result<(), String> {
    let source = state_source::Source::from_label(&source);
    tauri::async_runtime::spawn_blocking(move || {
        state_source::set_comment(&source, &id, &text, &from)
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
        ccfzf_log!("cannot grant foreground: {e}");
    }
}

#[cfg(not(target_os = "windows"))]
fn allow_any_foreground() {}

/// Вывести вперёд себя — маковская половина того же вопроса, который на
/// Windows решает `allow_any_foreground`.
///
/// Пикер живёт в трее и объявлен `ActivationPolicy::Accessory`: у такого
/// приложения нет ни значка в доке, ни очереди на передний план, и показанное
/// им окно остаётся за тем, из которого человек полез в трей, — за терминалом.
/// `set_focus` тут не помогает: он двигает окно внутри приложения, а какое
/// приложение впереди, решает AppKit. Отсюда явная активация.
///
/// Набор параметров пустой: `NSApplicationActivationOptions::ActivateIgnoringOtherApps`
/// с macOS 14 объявлен ничего не делающим. Тем же приёмом и по той же причине
/// поднимает себя `ax::activate_self` у соседнего macos-windows-manager.
///
/// Отказ не фатален и в `Result` не уезжает: окно к этому моменту уже создано
/// и показано, и отвечать на это ошибкой значило бы пугать человека тем, что
/// он и так видит. Но и молчать нельзя — строка в журнал.
#[cfg(target_os = "macos")]
fn activate_self() {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    let app = NSRunningApplication::currentApplication();
    if !app.activateWithOptions(NSApplicationActivationOptions::empty()) {
        ccfzf_log!("cannot bring the application forward");
    }
}

#[cfg(not(target_os = "macos"))]
fn activate_self() {}

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
fn configured_broker_and_terminal() -> Result<(mqtt::Broker, String, serde_json::Value), String> {
    let raw = load_config()?;
    let broker = mqtt::broker_from_config(&raw);
    if !broker.is_configured() {
        return Err("mqtt is not configured: host and base are required in config.yaml".to_string());
    }
    let terminal = mqtt::terminal_name(&raw);
    // Сырой конфиг отдаётся третьим, а не читается вторым разом: кроме брокера
    // и терминала из него же спрашивается `openOnActiveDisplay` (`cursor_hint`),
    // и два чтения одного файла на одно нажатие разошлись бы ровно тогда, когда
    // человек правит настройки при открытом пикере.
    Ok((broker, terminal, raw))
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

/// Попросить трекер разложить окна — плиткой или каскадом.
///
/// Единственная просьба, говорящая не об одной сессии, а обо всём экране
/// машины: что расставлять, трекер знает сам, а пикер называет порядок —
/// `ids` в том виде, в каком строки стоят у него в списке.
///
/// Право на передний план выдаётся, как у подъёма окна: разложенные окна
/// трекер выводит наверх (macos-windows-manager v0.4.0), то есть ветка
/// кончается окном. Выдаётся оно до публикации, пока нажатие ещё наше, —
/// гашение пикера страница делает там же и по той же причине.
///
/// Незнакомую раскладку отвергает `mqtt::place`, а не эта команда: приёмник
/// такое тело отбрасывает молча, и отказ обязан случиться до публикации.
#[tauri::command]
async fn place_windows_mqtt(
    mode: String,
    ids: Vec<String>,
    base: Option<String>,
) -> Result<(), String> {
    allow_any_foreground();
    let broker = configured_broker()?;
    // Адрес называет трекер той машины, чьи окна раскладываем; свой из
    // конфига — запасной ход для трекера прежней версии.
    let base = mqtt::resolve_base(&broker, base.unwrap_or_default().trim());
    tauri::async_runtime::spawn_blocking(move || mqtt::place(&broker, &base, &mode, &ids))
        .await
        .map_err(|e| format!("place_windows_mqtt task failed: {e}"))?
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
/// `sameMachine` — та ли это машина, на которой стоит пикер. Единственный из
/// аргументов, который команда не пересылает, а которым решает: точку курсора
/// прикладывать можно только к просьбе, адресованной своей же машине. У этого
/// входа два повода (Enter здесь и пункт «Open on <host>» оттуда), и во втором
/// курсор мака уехал бы Windows-менеджеру координатой чужого стола. Считает
/// признак та же `chooseOpenTransport`, что выбирает транспорт, — второе
/// правило про то же самое разошлось бы с первым молча. Отсутствие ключа
/// читается как «не своя»: забытый аргумент обязан выключать оговорку, а не
/// включать её.
/// `noAutoplace` — Ctrl на строке: «открой там, куда я смотрю, и не двигай
/// дальше». Едет он той же оговоркой, что и курсор, и по той же причине:
/// просьба к чужой машине не знает ни нашего стола, ни того, куда там
/// смотрят.
#[tauri::command]
async fn open_session_mqtt(
    app: tauri::AppHandle,
    id: String,
    cwd: Option<String>,
    base: Option<String>,
    same_machine: Option<bool>,
    no_autoplace: Option<bool>,
) -> Result<(), String> {
    allow_any_foreground();
    let (broker, terminal, raw) = configured_broker_and_terminal()?;
    let cwd = cwd.unwrap_or_default().trim().to_string();
    let place = if same_machine.unwrap_or(false) {
        placement(&app, &raw, no_autoplace.unwrap_or(false))
    } else {
        mqtt::Placement::default()
    };
    // Адрес называет трекер той машины, где стоит окно; свой из конфига —
    // запасной ход для трекера прежней версии.
    let base = mqtt::resolve_base(&broker, base.unwrap_or_default().trim());
    tauri::async_runtime::spawn_blocking(move || {
        mqtt::open(&broker, &base, &id, &cwd, &terminal, place)
    })
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
async fn open_project_mqtt(
    app: tauri::AppHandle,
    cwd: String,
    base: Option<String>,
    no_autoplace: Option<bool>,
) -> Result<(), String> {
    allow_any_foreground();
    let (broker, terminal, raw) = configured_broker_and_terminal()?;
    // Оговорки «своя ли машина» здесь нет и не нужно: `chooseProjectOpenAction`
    // отдаёт ветку менеджера только на машине самого менеджера.
    let place = placement(&app, &raw, no_autoplace.unwrap_or(false));
    // У строки проекта окна нет вовсе: адрес называет трекер машины
    // менеджера, а не машины окна. Свой из конфига — запасной ход для
    // трекера прежней версии.
    let base = mqtt::resolve_base(&broker, base.unwrap_or_default().trim());
    tauri::async_runtime::spawn_blocking(move || {
        mqtt::open_project(&broker, &base, &cwd, &terminal, place)
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
async fn new_session_mqtt(
    app: tauri::AppHandle,
    cwd: String,
    name: String,
    base: Option<String>,
    no_autoplace: Option<bool>,
) -> Result<(), String> {
    allow_any_foreground();
    let (broker, terminal, raw) = configured_broker_and_terminal()?;
    // Как и у `open_project_mqtt`: до этой команды доходят только со своей
    // машины — ветку выбирает `chooseProjectOpenAction`.
    let place = placement(&app, &raw, no_autoplace.unwrap_or(false));
    // Окна ещё нет — сессия только заводится: адрес называет трекер машины
    // менеджера, а не машины окна. Свой из конфига — запасной ход для
    // трекера прежней версии.
    let base = mqtt::resolve_base(&broker, base.unwrap_or_default().trim());
    tauri::async_runtime::spawn_blocking(move || {
        mqtt::open_new(&broker, &base, &cwd, &name, &terminal, place)
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
        ccfzf_log!("cannot restrict {}: {e}", path.display());
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
        "tileHotkeyRegistered": out.tile_registered,
        "tileHotkeyAccelerator": out.tile_accelerator,
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
            ccfzf_log!("cannot register picker hotkey: {e}");
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
            ccfzf_log!("cannot register projects hotkey: {e}");
            false
        }
    };
    (registered, accelerator)
}

/// Поставить хоткей плитки.
///
/// Третья такая функция, и третья отдельная по той же причине, что и вторая:
/// обработчики разные по существу. Этот не показывает окно вовсе — он гасит
/// пикер и уходит просьбой к трекеру.
fn register_tile_hotkey(app: &tauri::AppHandle, config: &serde_json::Value) -> (bool, String) {
    let (shortcut, accelerator) = tile_hotkey(config);
    let registered = match app.global_shortcut().on_shortcut(shortcut, |app, _sc, event| {
        if event.state() == ShortcutState::Pressed {
            tile_press(app);
        }
    }) {
        Ok(()) => true,
        Err(e) => {
            // Отказ не фатален и обязан быть виден — то же правило, что у двух
            // соседей: молчащая клавиша выглядит сломанным конфигом. Здесь оно
            // стоит дороже прочего: комбинацию только что освободил трекер, и
            // «занята» тут значит «трекер ещё не выкачен».
            ccfzf_log!("cannot register tile hotkey: {e}");
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

/// Пункт трея «плитка» — туда же и затем же: смена `tileHotkey` в настройках
/// обязана переписать и правую колонку, и подпись об отказе.
struct TileMenuItem(MenuItem<tauri::Wry>);

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
        ccfzf_log!("cannot update tray label: {e}");
    }
    if let Err(e) = item.set_accelerator(accel.as_deref()) {
        ccfzf_log!("cannot show hotkey {accelerator} in tray menu: {e}");
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
    tile_registered: bool,
    tile_accelerator: String,
}

fn apply_config(app: &tauri::AppHandle) -> HotkeyOutcome {
    let config = match load_config() {
        Ok(c) => c,
        Err(e) => {
            // Прежде здесь молча подставлялся Null: пустой sshHost уводит
            // поток опроса в простой, а хоткеи откатываются на умолчания —
            // и без этой строки узнать о причине можно было бы только по
            // внезапно замолчавшему списку.
            ccfzf_log!("bad config.yaml, falling back to defaults: {e}");
            serde_json::Value::Null
        }
    };

    if let Some(poller) = app.try_state::<poller::Poller>() {
        let sources = state_source::sources_from(&config);
        let background = config
            .get("backgroundRefresh")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        poller.set_config(sources, background);
    }

    // Гашение по потере фокуса — тоже без перезапуска: обработчик стоит всегда
    // и смотрит на этот флаг (см. `HideOnBlur`).
    if let Some(state) = app.try_state::<HideOnBlur>() {
        state.0.store(hide_on_blur(&config), Ordering::Relaxed);
    }

    // Размер — тоже без перезапуска, но применяется он не здесь, а на ближайшем
    // показе окна: пикер в этот момент скрыт (он гасит себя перед открытием
    // настроек), а скрытому окну размер не ставится вовсе, см. `SizeRequest`.
    // Помечать просьбу отложенной больше не нужно: геометрию `show_picker`
    // считает на каждом показе, по свежим долям из этого самого состояния.
    //
    // Перепросить размер со страницы по событию `config-changed` нельзя по той
    // же причине, по какой опрос живёт в Rust: у скрытого окна WebView2 умеет
    // усыплять страницу целиком, и просьба замолчала бы ровно в том случае,
    // ради которого затевалась.
    if let Some(state) = app.try_state::<WindowScale>() {
        *state.0.lock().unwrap() = picker_scale(&config);
    }

    // Подложка — тем же приёмом: флаги переставляются здесь, а видимость
    // трогает только показанное окно. Пикер в этот момент скрыт (см. выше про
    // размер), так что пересчитывать её сейчас нечего — она и так спрятана
    // вместе с окном.
    if let Some(state) = app.try_state::<ScrimFlags>() {
        *state.0.lock().unwrap() = scrim_flags(&config);
    }

    // Галка «на активном экране» — тем же приёмом: её переставляют здесь, а
    // читает `target_monitor` на ближайшем показе. Двигать окно сейчас
    // незачем — оно скрыто, и место ему посчитают перед тем, как показать.
    if let Some(state) = app.try_state::<ActiveDisplay>() {
        *state.0.lock().unwrap() = show_on_active_display(&config);
    }

    let _ = app.global_shortcut().unregister_all();
    let (registered, accelerator) = register_picker_hotkey(app, &config);
    let (projects_registered, projects_accelerator) = register_projects_hotkey(app, &config);
    let (tile_registered, tile_accelerator) = register_tile_hotkey(app, &config);
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
    if let Some(item) = app.try_state::<TileMenuItem>() {
        update_menu_item(&item.0, tile_item_label(tile_registered), &tile_accelerator);
    }

    let _ = app.emit("config-changed", ());
    HotkeyOutcome {
        picker_registered: registered,
        picker_accelerator: accelerator,
        projects_registered,
        projects_accelerator,
        tile_registered,
        tile_accelerator,
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
/// Отдать вкладке Log то, что накопилось в буфере.
///
/// Не `Result`: читать тут нечего — буфер живёт в памяти этого же процесса, и
/// отказать он может разве что паникой соседнего потока, которую `log::lines`
/// и переживает молча. Отказ, который нельзя показать иначе как в том же
/// логе, показывать было бы негде.
#[tauri::command]
fn read_log() -> Vec<String> {
    log::lines()
}

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
    } else {
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
    }
    // Обе ветки проходят через активацию, и ветки объединены ради неё: с
    // прежним ранним `return` одна из двух дорог рано или поздно её потеряла
    // бы. На Windows это пустой вызов — там передний план пикер уже отдал себе
    // сам, погасив список; чинится маковская сторона, где показанное окно
    // Accessory-приложения остаётся за терминалом.
    activate_self();
    Ok(())
}

/// Запуск терминала. Открепляется сразу: пикер не ждёт, пока человек
/// закончит работать в сессии, и не держит его вывод.
///
/// Единственное место, которое сознательно идёт мимо `proc::hidden_command`:
/// здесь окно и есть цель. Спрятать его значило бы открыть сессию, которую
/// человек не увидит.
#[tauri::command]
fn spawn_detached(argv: Vec<String>, cwd: Option<String>) -> Result<(), String> {
    let Some((file, args)) = argv.split_first() else {
        return Err("empty argv".into());
    };
    let mut command = std::process::Command::new(file);
    command.args(args);
    // Каталог ставится процессу, а не собирается в команду: у местной строки
    // на Windows шелла нет, и `cd` было бы негде выполнить.
    if let Some(dir) = cwd.as_deref().filter(|d| !d.is_empty()) {
        command.current_dir(dir);
    }
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to spawn {file}: {e}"))
}

/// Ссылка, поднимающая сессию в приложении Claude Desktop.
///
/// Маршрут у приложения свой и единственный: `claude://resume?session=<id>`
/// — оно импортирует по нему транскрипт с **этой** машины и показывает
/// сессию у себя. Оговорку «с этой машины» держит страница (`isDesktopRow` в
/// open-transport.js): строка, приехавшая от `sshHost`, увела бы приложение в
/// ошибку «transcript is not on disk», о которой пикеру не узнать — ответа у
/// ссылки нет.
///
/// Форма id проверяется той же `looks_like_session_id`, что стоит на пути
/// ssh-команды, а не второй копией: строка уходит наружу, и разошедшиеся
/// проверки разошлись бы ровно там, где это дороже всего.
fn desktop_session_url(id: &str) -> Result<String, String> {
    if !state_source::looks_like_session_id(id) {
        return Err(format!("not a session id: {id}"));
    }
    // Маршрута два, и берётся тот, что не плодит двойников: `cowork` открывает
    // сессию, которую приложение уже завело, а `resume` **импортирует**
    // транскрипт — то есть для сессии самого приложения заводит рядом вторую,
    // безымянную. Своё имя сессии приложение держит у себя, и связь с нашим id
    // записана там же полем `cliSessionId` (см. desktop_store).
    let records = desktop_store::store_root()
        .map(|root| desktop_store::read_store(&root))
        .unwrap_or_default();
    Ok(desktop_store::session_url(id, desktop_store::pick_session(&records, id)))
}

/// Чем система открывает ссылку.
///
/// Развилка по системе, а не `cfg`: веток три, а собирается на машине
/// разработки одна — под `cfg` две остальные не проверил бы даже компилятор.
/// На Windows это `cmd /c start ""` — единственная форма, которой там
/// открывают и папки (см. `{localPathSlash}` в правилах проекта); пустая
/// кавычка обязательна, иначе `start` примет ссылку за заголовок окна.
fn url_opener(url: &str) -> Vec<String> {
    if cfg!(target_os = "macos") {
        vec!["open".into(), url.into()]
    } else if cfg!(target_os = "windows") {
        vec!["cmd".into(), "/c".into(), "start".into(), String::new(), url.into()]
    } else {
        vec!["xdg-open".into(), url.into()]
    }
}

/// Открыть сессию в приложении Claude Desktop.
#[tauri::command]
fn open_desktop_session(id: String) -> Result<(), String> {
    let url = desktop_session_url(&id)?;
    spawn_detached(url_opener(&url), None)
}

/// Как звать редактор, чтобы он открыл файл.
///
/// На macOS голое имя уходит в `open -a`, и это не удобство, а единственная
/// работающая дорога. Проверено на живом маке (2026-08-18): CLI `cursor` там не
/// установлен вовсе — `which cursor` пуст даже в логин-шелле, — зато
/// `/Applications/Cursor.app` на месте, и `open -a` находит приложение по
/// имени в любом регистре (`id of app "cursor"` и `"Cursor"` дают один и тот же
/// bundle id). Прямой запуск при этом падал `unable to spawn cursor`, и правкой
/// PATH это не лечится: программы, о которой идёт речь, на диске нет.
///
/// Имя с разделителем каталогов — это путь, и его зовут напрямую: человек
/// назвал файл, а не приложение, и `open -a` такой строке не обрадуется.
///
/// На Windows и Linux ветки нет: там редактор и есть программа в PATH.
fn editor_argv(editor: &str, path: &str) -> Vec<String> {
    let editor = editor.trim();
    #[cfg(target_os = "macos")]
    if !editor.is_empty() && !editor.contains('/') {
        return vec![
            "open".to_string(),
            "-a".to_string(),
            editor.to_string(),
            path.to_string(),
        ];
    }
    vec![editor.to_string(), path.to_string()]
}

/// Пускач ли это — то есть программа, которая сама сразу завершится.
///
/// Разница не косметическая: у `open -a` отказ приходит **кодом возврата**, а
/// не отказом запуска. «Приложение не найдено», «файл не открылся» — всё это
/// успешно запущенный `open`, который через миг вернёт единицу и напишет
/// причину в stderr. Не дождавшись его, пикер отвечает Ok на неудачу.
///
/// Прямой запуск редактора — противоположный случай: там процесс и есть
/// редактор, он живёт, пока человек работает, и ждать его значило бы
/// подвесить пикер до закрытия окна.
fn editor_is_launcher(argv: &[String]) -> bool {
    argv.first().map(String::as_str) == Some("open")
}

/// Открыть спеку или план в редакторе.
///
/// Отдельная команда, а не `spawn_detached` с готовым argv со страницы:
/// страница системы не знает и знать не должна — то же правило, по которому
/// умолчание второго хоткея живёт в Rust, а не в `config-shape.js`.
///
/// Отказ обязан быть виден. Прежде здесь стоял один `spawn_detached`, и он
/// отвечал Ok, едва процесс родился: страница по этому Ok гасила окно, а
/// человек оставался с закрытым пикером и не открывшимся редактором — то
/// есть с отказом, не сказавшим о себе ничего. Поймано на маке 2026-08-18
/// живьём.
#[tauri::command]
fn open_in_editor(editor: String, path: String) -> Result<(), String> {
    if editor.trim().is_empty() {
        return Err("editor is not set".into());
    }
    if path.trim().is_empty() {
        return Err("nothing to open".into());
    }
    let argv = editor_argv(&editor, &path);
    if !editor_is_launcher(&argv) {
        return spawn_detached(argv, None);
    }
    let (file, args) = argv.split_first().expect("argv пускача не бывает пустым");
    let out = std::process::Command::new(file)
        .args(args)
        .output()
        .map_err(|e| format!("failed to spawn {file}: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    // Причину называет сам пускач, и она короткая («Unable to find application
    // named …»). Пустой stderr бывает тоже — тогда остаётся код.
    let said = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if said.is_empty() {
        format!("{file} failed: {}", out.status)
    } else {
        said
    })
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
            Err(_) => ccfzf_log!("cannot parse hotkey {s}, using default"),
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
            Err(_) => ccfzf_log!("cannot parse projectsHotkey {s}, using default"),
        }
    }
    (
        default_projects_shortcut(),
        DEFAULT_PROJECTS_ACCELERATOR.to_string(),
    )
}

/// Умолчание третьего хоткея — попросить трекер разложить окна плиткой.
///
/// Развилка по системам есть, как и у второго хоткея, и по той же причине:
/// объединять нечего, комбинации выбраны разные. Взяты они не с потолка — это
/// ровно те клавиши, которые освобождают трекеры, отдавая раскладку пикеру:
/// `Cmd+Alt+Ctrl+C` у `macos-windows-manager` и `Ctrl+Win+F10` у
/// `windows11-manager`. Клавиша у человека уже в пальцах, и менять её заодно
/// со сменой владельца значило бы менять две вещи разом.
#[cfg(target_os = "macos")]
fn default_tile_shortcut() -> Shortcut {
    Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER),
        Code::KeyC,
    )
}

#[cfg(not(target_os = "macos"))]
fn default_tile_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SUPER), Code::F10)
}

/// То же умолчание записью — и рядом по той же причине, что у двух соседей:
/// разойдись они, показано было бы одно, а слушалось другое.
#[cfg(target_os = "macos")]
const DEFAULT_TILE_ACCELERATOR: &str = "Control+Alt+Super+C";

#[cfg(not(target_os = "macos"))]
const DEFAULT_TILE_ACCELERATOR: &str = "Control+Super+F10";

/// Действующий хоткей плитки и запись для показа.
///
/// Устройством — как `projects_hotkey`, включая пустую строку: умолчание здесь
/// тоже своё на каждой системе и живёт только в Rust, поэтому пустое поле в
/// окне настроек значит «взять встроенное», а не «выключить». Запиши окно
/// комбинацию строкой — и, сохранённое на другой системе, оно увезло бы в
/// `config.yaml` чужую клавишу.
pub(crate) fn tile_hotkey(config: &serde_json::Value) -> (Shortcut, String) {
    if let Some(s) = config
        .get("tileHotkey")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
    {
        match s.parse::<Shortcut>() {
            Ok(sc) => return (sc, s.to_string()),
            Err(_) => ccfzf_log!("cannot parse tileHotkey {s}, using default"),
        }
    }
    (
        default_tile_shortcut(),
        DEFAULT_TILE_ACCELERATOR.to_string(),
    )
}

/// Нажали хоткей плитки.
///
/// Живёт в Rust, а не на странице, по той же причине, по какой там же живут
/// опрос и проектный хоткей: клавишу жмут ровно тогда, когда пикер скрыт, а у
/// скрытого окна WebView2 умеет усыплять страницу целиком — просьба замолчала
/// бы именно в том случае, ради которого затевалась.
///
/// Гашение идёт **до** просьбы, как на пяти соседних ветках, кончающихся
/// окном: разложенные окна трекер выводит на передний план, и гашение после
/// отбирало бы у них фокус сразу после того, как они его получили. Оттуда же
/// и грамота на передний план — выдаётся, пока нажатие ещё наше.
///
/// Отметки «просмотрено» здесь нет намеренно, как и у пунктов `^K`: окна
/// встали по местам, но ни в одно из них человек не смотрел.
///
/// Ответа у просьбы нет — трекер отчитывается своему человеку строкой в трее.
fn tile_press(app: &tauri::AppHandle) {
    // Идемпотентно: уже скрытое окно повторно не гасит.
    hide_window(app);

    // Молчаливый откат на `Null` выглядел бы как «брокер не настроен» и для
    // битого конфига, и для настоящего отсутствия mqtt. Та же строка, за
    // которую уже заплачено расследованием занятого `Ctrl+F11`.
    let raw = match load_config() {
        Ok(v) => v,
        Err(e) => {
            ccfzf_log!("cannot read config, not asking for a tile layout: {e}");
            return;
        }
    };
    let broker = mqtt::broker_from_config(&raw);
    if !broker.is_configured() {
        // Запасной дороги у раскладки нет: разложить окна сам пикер не умеет
        // ни на одной системе — этим занят трекер. Молчать нельзя, иначе
        // ненастроенный брокер неотличим от сломанной клавиши.
        ccfzf_log!("mqtt broker is not configured, cannot ask for a tile layout");
        return;
    }

    let host = raw
        .get("windowHost")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // Ответ агрегатора берётся у поллера — того же, что кормит страницу. На
    // скрытом окне он отстаёт до восьми минут (бэкофф в `poller.rs`), и это
    // приемлемо: окно, открытое минуту назад, разложится следующим нажатием,
    // а порядок в списке всё равно называет человек глазами.
    let state = app
        .try_state::<poller::Poller>()
        .map(|p| p.snapshot())
        .and_then(|s| s.get("state").cloned())
        .unwrap_or(serde_json::Value::Null);

    // Режим сортировки — тот, что человек выбрал в пикере (`^O`). Читается из
    // `ui.json`, а не спрашивается у страницы, по той же причине, что и всё
    // остальное здесь.
    let sort = load_json("ui.json")
        .ok()
        .and_then(|ui| ui.get("sort").and_then(|v| v.as_str()).map(str::to_string))
        .unwrap_or_default();

    // Затемнение строк — то же, каким его видит страница (`staleSettings`):
    // галка `dim stale` из `ui.json`, а порог — из конфига. Тусклые строки
    // раскладка пропускает, и правило это обязано совпадать с тем, по
    // которому человек видит их гашёными: клавиша, раскладывающая не то, что
    // показано, объяснению не поддаётся.
    //
    // Галки в `ui.json` может не быть вовсе — пикер ни разу не сохранял
    // состояние, — и тогда решает умолчание из конфига, ровно как
    // `toggleDefaults()` на странице.
    let stale_config = raw.get("stale").cloned().unwrap_or(serde_json::Value::Null);
    let stale_default = stale_config
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let dim_stale = load_json("ui.json")
        .ok()
        .and_then(|ui| {
            ui.get("toggles")
                .and_then(|t| t.get("dimStale"))
                .and_then(|t| t.get("list"))
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(stale_default);
    let stale = place_order::Stale {
        enabled: dim_stale,
        // Умолчание то же, что в `config-shape.js`: два числа разошлись бы, и
        // хоткей отсеивал бы не по тому порогу, по которому гаснет список.
        session_hours: stale_config
            .get("sessionHours")
            .and_then(|v| v.as_f64())
            .filter(|h| h.is_finite() && *h > 0.0)
            .unwrap_or(2.0),
        now_s: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as f64)
            .unwrap_or(0.0),
    };

    let ids = place_order::tile_ids(&state, &host, &sort, &stale);
    if ids.is_empty() {
        // Пустой `ids` приёмник читает как «все ведомые окна, порядком той
        // машины» — то самое поведение, ради ухода от которого хоткей и
        // забран у трекеров. Промолчать честнее: раскладывать нечего, а
        // просьба разложила бы всё чужим порядком.
        ccfzf_log!("no windows of this machine are known, not asking for a tile layout");
        return;
    }

    // Адрес называет трекер строки, а не конфиг: у каждой машины свой префикс
    // топиков. Пустое имя откатывает `resolve_base` на `<config.base>/windows`
    // — так пикер вёл себя до появления поля и обязан вести себя со старым
    // трекером.
    let base = mqtt::resolve_base(&broker, &place_order::tracker_base(&state, &host));

    // Грамота уходит до публикации: нажатие хоткея — последнее событие ввода,
    // и оно наше. Кому именно — не выбираем, см. `allow_any_foreground`.
    allow_any_foreground();

    // Публикация ждёт подтверждения брокера до пяти секунд — держать на этом
    // поток, из которого плагин зовёт обработчик, нельзя.
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = mqtt::place(&broker, &base, "tile", &ids) {
            ccfzf_log!("cannot ask for a tile layout: {e}");
        }
    });
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
/// Что делает клик по иконке трея: значение конфига и подпись для настроек.
///
/// Одна таблица на всё — список в окне настроек, разбор значения из конфига и
/// развилка нажатия. Второй список разошёлся бы с первым самым тихим отказом
/// из возможных: клик проходит, ветки себе не находит, ни ошибки, ни следа.
///
/// Взять `MODE_MENU` целиком нельзя: `tile` — действие, а не режим, списка
/// оно не показывает вовсе. Поэтому режимы и действия перечислены здесь
/// вместе, а не собраны из соседней таблицы.
///
/// Жестов два: левая кнопка (умолчание `sessions` — сегодняшнее поведение) и
/// средняя (умолчание `tile`). Правая занята меню трея, и отдать её нельзя —
/// это единственная дорога к настройкам, выходу и режимам. Двойного клика
/// здесь нет намеренно: `TrayIconEvent::DoubleClick` эмитится только на
/// Windows (`platform_impl/windows/mod.rs` в крейте tray-icon), а на маке
/// такого события не бывает вовсе — поле в настройках обещало бы жест,
/// которого там не будет. Долгого нажатия в API нет ни на одной системе.
const TRAY_CLICK_ACTIONS: [(&str, &str); 3] = [
    ("sessions", "Show the picker"),
    ("projects", "Show the picker on projects"),
    ("tile", "Tile the windows on this machine"),
];

/// Что делает выбор проекта: значение конфига и подпись для настроек.
///
/// Таблица одна на всё, ровно как `TRAY_CLICK_ACTIONS`: список в окне
/// настроек, разбор значения из конфига и обе развилки — Enter на строке
/// проекта (страница) и проектный хоткей (Rust). Вторая половина живёт в
/// `frontend-src/settings-form.js`, а согласие держит
/// `test/project-open-actions.test.js`: общего кода между двумя языками нет.
///
/// Ключей два — `projectOpenAction` и `projectHotkeyAction`, — и умолчания у
/// них разные (`new` и `focus`). Разные потому, что поводы разные: строку
/// проекта выбирают глазами, уже открыв пикер, и просят ею начать работу;
/// хоткей жмут вслепую, чтобы вернуться туда, где работа идёт. Умолчания
/// названы у самих нажатий, а не здесь: таблица отвечает на вопрос «что
/// бывает», а не «что по умолчанию у этого входа».
///
/// Ветку `focus` держит на той стороне `openClaudeProject` у
/// windows11-manager: он ищет открытое окно каталога и заводит новую сессию,
/// только если не нашёл. То есть `focus` — не «подними и всё», а «подними,
/// если есть».
const PROJECT_OPEN_ACTIONS: [(&str, &str); 2] = [
    ("new", "Always start a new session"),
    ("focus", "Raise the last session of the project if it is open"),
];

/// Значение конфига, приведённое к известному действию из таблицы.
///
/// Незнакомое, пустое и отсутствующее читаются как умолчание, а незнакомое
/// вдобавок пишет строку в журнал: молчать нельзя — мёртвая иконка выглядит
/// сломанным приложением, а не опечаткой в `config.yaml`.
///
/// Одна функция на две таблицы, а не по разбору на каждую: правило тут ровно
/// одно, и второй его экземпляр разошёлся бы с первым — например, перестав
/// прощать регистр, который человек правит руками.
fn config_choice(
    config: &serde_json::Value,
    key: &str,
    fallback: &'static str,
    table: &[(&'static str, &str)],
) -> &'static str {
    let raw = config
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if raw.is_empty() {
        return fallback;
    }
    match table.iter().find(|(id, _)| id.eq_ignore_ascii_case(&raw)) {
        Some((id, _)) => id,
        None => {
            ccfzf_log!("unknown {key} {raw}, falling back to {fallback}");
            fallback
        }
    }
}

fn tray_action(config: &serde_json::Value, key: &str, fallback: &'static str) -> &'static str {
    config_choice(config, key, fallback, &TRAY_CLICK_ACTIONS)
}

/// Что делать с выбранным проектом: `new` | `focus`.
///
/// Зовётся из двух мест с разными ключами и разными умолчаниями — со страницы
/// её не спрашивают вовсе: `projectOpenAction` разбирает `config-shape.js`,
/// потому что Enter нажимают при показанном окне. Здесь ключ один,
/// `projectHotkeyAction`, и читается он на каждом нажатии — как и всё
/// остальное в этой дороге, чтобы смена настройки не требовала перезапуска.
pub fn project_open_action(
    config: &serde_json::Value,
    key: &str,
    fallback: &'static str,
) -> &'static str {
    config_choice(config, key, fallback, &PROJECT_OPEN_ACTIONS)
}

/// Сделать то, что назвал конфиг.
///
/// Ветка на каждое значение `TRAY_CLICK_ACTIONS`; сторож —
/// `every_tray_click_action_is_handled`. Значение без ветки нажатие бы
/// проглотило: ни ошибки, ни следа.
fn run_tray_action(app: &tauri::AppHandle, action: &str) {
    match action {
        "sessions" => toggle_picker(app),
        // Переключение, а не показ, — в отличие от пункта меню и по той же
        // причине, по какой переключает хоткей: клик по иконке делают не
        // глядя в список, и повторный обязан погасить окно. Сегодняшний клик
        // тоже переключает, и менять это заодно было бы второй правкой.
        "projects" => toggle_projects(app),
        "tile" => tile_press(app),
        other => {
            // Сюда не доезжает ничего: `tray_action` уже привела значение к
            // известному. Ветка всё равно обязана быть — `match` без неё не
            // собрался бы, а промолчать на клике нельзя.
            ccfzf_log!("unknown tray action {other}, showing the sessions list");
            toggle_picker(app);
        }
    }
}

/// Нажали кнопкой по иконке трея.
///
/// Конфиг читается на каждом нажатии, а не запоминается на старте: иначе
/// смена настройки требовала бы перезапуска пикера. Так же поступает и
/// `tile_press`. Нечитаемый конфиг откатывает на умолчание, а не роняет
/// нажатие: мёртвый клик по иконке — худший из ответов.
fn tray_press(app: &tauri::AppHandle, key: &str, fallback: &'static str) {
    let raw = match load_config() {
        Ok(v) => v,
        Err(e) => {
            ccfzf_log!("cannot read config, using the built-in tray action: {e}");
            serde_json::Value::Null
        }
    };
    run_tray_action(app, tray_action(&raw, key, fallback));
}

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

/// Подпись пункта трея «плитка» — и она же говорит, слушается ли хоткей.
///
/// Правило то же, что у двух соседей: комбинация показывается всегда (её рисует
/// правая колонка), а встала ли она на самом деле, колонка знать не может —
/// занять сочетание могло любое чужое приложение. Здесь это стоит дороже, чем у
/// соседей: клавишу пикер только что отобрал у оконного трекера, и «занята»
/// значит «трекер ещё не выкачен» — самый ожидаемый отказ из трёх.
///
/// Сам пункт от отказа не страдает: раскладку он просит по нажатию, а не по
/// клавише, — поэтому подпись говорит про хоткей, а не про пункт.
fn tile_item_label(hotkey_registered: bool) -> &'static str {
    if hotkey_registered {
        "Tile windows"
    } else {
        "Tile windows (hotkey is taken)"
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
            restore_snapshot_mqtt, place_windows_mqtt, open_session_mqtt, open_project_mqtt,
            new_session_mqtt,
            save_config, open_settings, project_hotkeys_taken, action_icons,
            set_comment, open_in_editor, read_log, open_desktop_session
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
            let sources = state_source::sources_from(&config);
            let background = config
                .get("backgroundRefresh")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            app.manage(poller::Poller::start(app.handle().clone(), sources, background));

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
            // Галка «на активном экране» — тем же приёмом: её переставляет
            // `apply_config`, а читает `target_monitor`.
            app.manage(ActiveDisplay(Mutex::new(show_on_active_display(&config))));
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
            let (tile_registered, tile_accelerator) =
                register_tile_hotkey(app.handle(), &config);

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
                    ccfzf_log!(
                        "cannot show hotkey {hotkey_accelerator} in tray menu: {e}"
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
                    ccfzf_log!(
                        "cannot show hotkey {projects_accelerator} in tray menu: {e}"
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
            // Плитка — действие, а не режим, поэтому она не в `MODE_MENU` и
            // стоит под пунктами-режимами: те открывают список, а этот трогает
            // окна на экране и списка не показывает вовсе. Комбинация здесь
            // тоже украшение — меню трея клавиш не слушает, — и едет она тем же
            // `menu_item_parts`: на Windows в подпись, на маке в слот.
            let (tile_text, tile_accel) =
                menu_item_parts(tile_item_label(tile_registered), &tile_accelerator);
            let tile_item = match MenuItem::with_id(
                app,
                "tile",
                &tile_text,
                true,
                tile_accel.as_deref(),
            ) {
                Ok(item) => item,
                Err(e) => {
                    ccfzf_log!("cannot show hotkey {tile_accelerator} in tray menu: {e}");
                    MenuItem::with_id(app, "tile", &tile_text, true, None::<&str>)?
                }
            };
            app.manage(TileMenuItem(tile_item.clone()));
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
            items.push(&tile_item);
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
                                ccfzf_log!("{e}");
                            }
                        });
                    }
                    // Та же работа, что и у хоткея, той же функцией: второй
                    // сбор просьбы разошёлся бы с первым молча — публикация
                    // прошла бы, а окна встали бы не в том порядке.
                    //
                    // Вызовом на месте, а не через spawn, в отличие от
                    // «Settings…»: окна эта ветка не создаёт, а гашение пикера
                    // и чтение конфига цикл событий не занимают. Публикация и
                    // так уходит в `spawn_blocking` внутри.
                    "tile" => tile_press(app),
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
                        button,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        // Правой кнопке действия не достаётся: под ней меню
                        // трея, и это единственная дорога к настройкам,
                        // выходу и режимам.
                        let (key, fallback) = match button {
                            MouseButton::Left => ("trayClickAction", "sessions"),
                            MouseButton::Middle => ("trayMiddleClickAction", "tile"),
                            MouseButton::Right => return,
                        };
                        tray_press(tray.app_handle(), key, fallback);
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

    /// Каталог запуска — аргумент команды, а не `cd` внутри неё: у местной
    /// строки на Windows шелла нет вовсе, и склеивать команду было бы нечем.
    #[test]
    fn spawn_takes_a_working_directory() {
        let dir = std::env::temp_dir();
        let argv = if cfg!(target_os = "windows") {
            vec!["cmd".to_string(), "/c".to_string(), "cd".to_string()]
        } else {
            vec!["pwd".to_string()]
        };
        assert!(super::spawn_detached(argv, Some(dir.to_string_lossy().into_owned())).is_ok());
    }

    #[test]
    fn ssylka_na_sessiyu_sobiraetsya_marshrutom_prilozheniya() {
        // Форма обоих маршрутов снята с самого приложения: ветка `Resume`
        // читает `searchParams.get("session")` и проверяет id формой UUID, а
        // `Cowork` уходит путём `/cowork/<id>` в само окно. Проверено живьём
        // на маке — окно поднялось на нужной сессии.
        //
        // Здесь проверяется только то, что не зависит от машины: какой из двух
        // маршрутов чему соответствует. Выбор записи и чтение хранилища — в
        // `desktop_store`, там же и их тесты: на машине разработки приложения
        // нет вовсе, и `desktop_session_url` целиком отвечала бы тем, что
        // хранилища не нашлось.
        assert_eq!(
            super::desktop_store::session_url("8b84d15e-fce9-4847-b3d0-39b37a3c48c1", None),
            "claude://resume?session=8b84d15e-fce9-4847-b3d0-39b37a3c48c1".to_string(),
        );
    }

    #[test]
    fn ssylka_ne_sobiraetsya_iz_chego_popalo() {
        // Строка уходит наружу аргументом процесса, и на Windows её ещё и
        // разбирает `cmd`. Отказ — с сообщением: молчащий Enter человек
        // принял бы за поломку пикера.
        for bad in ["", "../../etc/passwd", "8b84d15e-fce9-4847-b3d0-39b37a3c48c1 x"] {
            assert!(super::desktop_session_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn ssylku_otkryvaet_ta_programma_kotoruyu_znaet_sistema() {
        let argv = super::url_opener("claude://resume?session=x");
        if cfg!(target_os = "macos") {
            assert_eq!(argv, vec!["open", "claude://resume?session=x"]);
        } else if cfg!(target_os = "windows") {
            // Пустая кавычка перед ссылкой обязательна: без неё `start`
            // примет её за заголовок окна и не откроет ничего.
            assert_eq!(argv, vec!["cmd", "/c", "start", "", "claude://resume?session=x"]);
        } else {
            assert_eq!(argv, vec!["xdg-open", "claude://resume?session=x"]);
        }
    }

    #[test]
    fn redaktor_na_make_zovetsya_cherez_open_a() {
        // Живая проверка на маке (2026-08-18): CLI `cursor` там не установлен
        // вовсе, а /Applications/Cursor.app есть. Прямой запуск падал
        // `unable to spawn cursor`, и правкой PATH это не лечится —
        // программы на диске нет. `open -a` находит приложение по имени.
        let got = super::editor_argv("cursor", "/x/plan.md");
        if cfg!(target_os = "macos") {
            assert_eq!(got, vec!["open", "-a", "cursor", "/x/plan.md"]);
        } else {
            assert_eq!(got, vec!["cursor", "/x/plan.md"]);
        }
    }

    #[test]
    fn nazvannyy_put_zovetsya_napryamuyu_na_lyuboy_sisteme() {
        // Разделитель каталогов значит, что человек назвал файл, а не
        // приложение: `open -a /usr/local/bin/cursor` такой строке не
        // обрадуется.
        assert_eq!(
            super::editor_argv("/usr/local/bin/cursor", "/x/plan.md"),
            vec!["/usr/local/bin/cursor", "/x/plan.md"]
        );
    }

    #[test]
    fn otkaz_puskacha_dohodit_slovami_a_ne_teryaetsya() {
        // `open` завершается сразу, и отказ у него — код возврата, а не отказ
        // запуска. Не дождись его пикер, он ответил бы Ok на неудачу, страница
        // погасила бы окно, и человек остался бы без редактора и без слова о
        // причине. Ветка только для пускача: прямой запуск — это сам редактор,
        // и ждать его значило бы висеть до закрытия окна.
        assert!(super::editor_is_launcher(&[
            "open".to_string(),
            "-a".to_string(),
            "cursor".to_string(),
        ]));
        assert!(!super::editor_is_launcher(&[
            "/usr/local/bin/cursor".to_string(),
            "/x/plan.md".to_string(),
        ]));
        assert!(!super::editor_is_launcher(&[]));
        // Тот же вход, каким страница зовёт редактор на маке, — argv обязан
        // опознаваться пускачом, иначе ветка ожидания не включится вовсе.
        assert_eq!(
            super::editor_is_launcher(&super::editor_argv("cursor", "/x/plan.md")),
            cfg!(target_os = "macos")
        );
    }

    #[test]
    fn pustoy_redaktor_i_pustoy_put_otkazyvayut_slovami() {
        // Пустой argv[0] превратился бы в попытку запустить пустую строку, а
        // отказ у неё невнятный. Человеку это видно строкой ошибки в
        // статуслайне, и она обязана называть причину.
        assert!(super::open_in_editor("  ".into(), "/x/plan.md".into()).is_err());
        assert!(super::open_in_editor("cursor".into(), " ".into()).is_err());
    }
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

    /// То же про третий хоткей — и сторож ему нужен ровно так же, как
    /// второму: умолчаний два, по одному на систему, и разъехавшуюся пару
    /// увидит лишь та машина, где её и завели.
    #[test]
    fn default_tile_accelerator_matches_default_shortcut() {
        assert_eq!(
            DEFAULT_TILE_ACCELERATOR.parse::<Shortcut>().unwrap(),
            default_tile_shortcut()
        );
    }

    /// Три умолчания попарно различны. Совпадение стоило бы молчащей клавиши:
    /// вторую регистрацию на ту же комбинацию плагин отвергает, а какая из
    /// двух функций досталась человеку — из отказа не видно.
    #[test]
    fn three_global_hotkeys_do_not_collide() {
        assert_ne!(default_tile_shortcut(), default_picker_shortcut());
        assert_ne!(default_tile_shortcut(), default_projects_shortcut());
    }

    /// Показывается тот хоткей, который слушается на самом деле, — те же три
    /// развилки, что у соседей: своя строка, откат на мусоре, откат при
    /// отсутствии ключа. Пустая строка здесь тоже значит «взять встроенное»:
    /// умолчание своё на каждой системе, и окно настроек его не знает.
    #[test]
    fn tile_hotkey_shows_what_is_listened_to() {
        let own = serde_json::json!({ "tileHotkey": "Cmd+Shift+T" });
        let (sc, accel) = tile_hotkey(&own);
        assert_eq!(sc, "Cmd+Shift+T".parse::<Shortcut>().unwrap());
        assert_eq!(accel, "Cmd+Shift+T");

        for config in [
            serde_json::json!({ "tileHotkey": "не хоткей" }),
            serde_json::json!({}),
            serde_json::Value::Null,
            serde_json::json!({ "tileHotkey": "" }),
            serde_json::json!({ "tileHotkey": "   " }),
            // Ключи соседей третьему хоткею не указ: перепутай их местами — и
            // два из трёх повисли бы на одной комбинации.
            serde_json::json!({ "hotkey": "Cmd+Shift+T" }),
            serde_json::json!({ "projectsHotkey": "Cmd+Shift+T" }),
        ] {
            let (sc, accel) = tile_hotkey(&config);
            assert_eq!(sc, default_tile_shortcut(), "конфиг {config}");
            assert_eq!(accel, DEFAULT_TILE_ACCELERATOR, "конфиг {config}");
        }
    }

    /// Всё, что записывает контрол хоткея в окне настроек, разбирается здесь.
    ///
    /// Вторая половина сторожа над `test/fixtures/hotkey-codes.json`; первая —
    /// «каждый код фикстуры годится в комбинацию» в `test/action-hotkey.test.js`.
    /// Приём тот же, что у `terminal-name` и `place-order`, и по той же
    /// причине: расхождение поведением не поймать вовсе — окно настроек
    /// ответит «saved», строка ляжет в `config.yaml`, а `tile_hotkey` и
    /// соседи молча откатятся на встроенное умолчание. То есть записанная
    /// человеком клавиша просто не сработает, и объяснить это будет нечем.
    ///
    /// Имя клавиши идёт без приставки `Key`/`Digit` — ровно так его пишет
    /// `comboFromEvent`, и ровно так написаны сами `DEFAULT_*_ACCELERATOR`.
    #[test]
    fn hotkey_codes_all_parse() {
        const FIXTURE: &str = include_str!("../../test/fixtures/hotkey-codes.json");
        let doc: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        let codes = doc["codes"].as_array().expect("в фикстуре нет codes");
        assert!(codes.len() > 50, "фикстура подозрительно короткая");
        for code in codes {
            let code = code.as_str().unwrap();
            let key = code
                .strip_prefix("Key")
                .or_else(|| code.strip_prefix("Digit"))
                .unwrap_or(code);
            let combo = format!("Control+Alt+Super+Shift+{key}");
            assert!(
                combo.parse::<Shortcut>().is_ok(),
                "код {code} записался бы строкой {combo}, которую разбор не понимает",
            );
        }
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

    /// Открытие настроек выводит вперёд само приложение.
    ///
    /// У `Accessory`-приложения показанное окно остаётся за тем, из которого
    /// человек полез в трей: `set_focus` двигает окно внутри приложения, а
    /// какое приложение впереди, решает AppKit. Веток у открытия две — окно
    /// уже есть и окна ещё нет, — и потерять активацию могла бы любая, поэтому
    /// сторож смотрит на всю команду целиком.
    ///
    /// Сторож текстовый: вызов уходит в AppKit, на машине разработки этой
    /// ветки нет вовсе, а `build()` отвечает `Ok` и с активацией, и без неё.
    #[test]
    fn opening_the_settings_window_brings_the_application_forward() {
        let src = include_str!("main.rs");
        let open = src
            .split_once("async fn open_settings(app: tauri::AppHandle)")
            .expect("команда открытия настроек пропала — тест сторожит не то")
            .1;
        let (open, _) = open.split_once("\n}\n").expect("команда не закрыта");
        assert!(
            open.contains("activate_self()"),
            "открытие настроек обязано выводить приложение вперёд"
        );
    }

    /// Пункт трея без своей ветки в `on_menu_event` — самый тихий отказ из
    /// возможных: нажатие проходит, ветки не находит, ни ошибки, ни следа. То
    /// же правило, за которое в `sessions.html` уже заплачено сторожем «каждый
    /// встроенный пункт меню обработан в runAction». Поведением не поймать
    /// вовсе — `build()` отвечает `Ok` и с пунктом, и без него.
    #[test]
    fn every_active_tray_item_is_handled() {
        let src = include_str!("main.rs");
        let handler = src
            .split_once(".on_menu_event(|app, event| match event.id.as_ref() {")
            .expect("обработчик меню трея пропал — тест сторожит не то")
            .1;
        let (handler, _) = handler
            .split_once(".on_tray_icon_event")
            .expect("обработчик меню не закрыт");
        // `version` сюда не входит намеренно: он заведён неактивным (подпись,
        // а не действие), и ветки ему не полагается.
        for id in ["show", "show-projects", "tile", "settings", "quit"] {
            assert!(
                handler.contains(&format!("\"{id}\"")) || mode_for_menu_id(id).is_some(),
                "пункт трея {id} не разобран в on_menu_event — нажатие молча не сделает ничего"
            );
        }
    }

    /// У каждого значения таблицы есть своя ветка.
    ///
    /// Тот же приём и та же причина, что у `every_active_tray_item_is_handled`:
    /// значение без ветки — самый тихий отказ из возможных. Клик проходит,
    /// `tray_action` отдаёт его как известное, ветки оно себе не находит и
    /// уезжает в общую — ни ошибки, ни следа, просто не то действие.
    ///
    /// Сторож текстовый, потому что поведением его не поймать: настоящий
    /// вызов требует `AppHandle`, которого в тестах нет.
    #[test]
    fn every_tray_click_action_is_handled() {
        let src = include_str!("main.rs");
        let body = src
            .split_once("fn run_tray_action(app: &tauri::AppHandle, action: &str) {")
            .expect("развилка действий трея пропала — тест сторожит не то")
            .1;
        let (body, _) = body.split_once("\n}\n").expect("развилка не закрыта");
        for (id, _) in TRAY_CLICK_ACTIONS {
            assert!(
                body.contains(&format!("\"{id}\" =>")),
                "действие трея {id} не разобрано в run_tray_action — клик молча сделает не то"
            );
        }
    }

    /// Проектный хоткей знает оба действия поимённо.
    ///
    /// Значение без ветки — самый тихий отказ из возможных: конфиг прочитан,
    /// нажатие прошло, `match` свалился в общую ветку, и клавиша сделала не
    /// то, что выбрано. Ни ошибки, ни следа: ответа у публикации нет.
    ///
    /// Сторож текстовый по той же причине, что и соседний: настоящий вызов
    /// требует `AppHandle`, которого в тестах нет.
    #[test]
    fn every_project_open_action_is_handled() {
        let src = include_str!("project_hotkeys.rs");
        let body = src
            .split_once("let name = match action {")
            .expect("развилка действия проектного хоткея пропала — тест сторожит не то")
            .1;
        let (body, _) = body.split_once("\n    };\n").expect("развилка не закрыта");
        for (id, _) in PROJECT_OPEN_ACTIONS {
            assert!(
                body.contains(&format!("\"{id}\" =>")),
                "действие {id} не разобрано в project_hotkeys::press — клавиша молча сделает не то"
            );
        }
    }

    /// Незнакомое, пустое и отсутствующее значение — это умолчание входа, а не
    /// мёртвая клавиша.
    ///
    /// Умолчания у входов разные (строка списка заводит новую сессию, хоткей
    /// поднимает открытое окно), и берутся они из места нажатия, а не из
    /// таблицы: та отвечает на вопрос «что бывает», а не «что по умолчанию у
    /// этого входа».
    #[test]
    fn unknown_project_open_action_falls_back_to_the_default() {
        for config in [
            serde_json::json!({ "projectHotkeyAction": "не действие" }),
            serde_json::json!({ "projectHotkeyAction": "" }),
            serde_json::json!({ "projectHotkeyAction": "   " }),
            serde_json::json!({}),
            serde_json::Value::Null,
            // Ключ соседнего входа этому не указ: перепутай их — и хоткей
            // делал бы то, что выбрано для строки списка.
            serde_json::json!({ "projectOpenAction": "new" }),
        ] {
            assert_eq!(
                project_open_action(&config, "projectHotkeyAction", "focus"),
                "focus",
                "конфиг {config} увёл хоткей с умолчания"
            );
        }
        // Названное действие берётся как есть, а регистр не важен: человек
        // правит `config.yaml` руками, и `New` там столь же вероятно, сколько
        // `new`.
        assert_eq!(
            project_open_action(
                &serde_json::json!({ "projectHotkeyAction": " New " }),
                "projectHotkeyAction",
                "focus"
            ),
            "new"
        );
    }

    /// Незнакомое, пустое и отсутствующее значение — это умолчание жеста, а
    /// не мёртвая иконка.
    ///
    /// Умолчания у жестов разные (левая кнопка показывает список, средняя
    /// раскладывает окна), и берутся они из места нажатия, а не из таблицы:
    /// таблица отвечает на вопрос «что бывает», а не «что по умолчанию у
    /// этой кнопки».
    #[test]
    fn unknown_tray_action_falls_back_to_the_gesture_default() {
        for config in [
            serde_json::json!({ "trayClickAction": "не действие" }),
            serde_json::json!({ "trayClickAction": "" }),
            serde_json::json!({ "trayClickAction": "   " }),
            serde_json::json!({}),
            serde_json::Value::Null,
            // Ключ соседнего жеста этому не указ: перепутай их — и обе
            // кнопки делали бы одно и то же.
            serde_json::json!({ "trayMiddleClickAction": "projects" }),
        ] {
            assert_eq!(
                tray_action(&config, "trayClickAction", "sessions"),
                "sessions",
                "конфиг {config}"
            );
        }
        assert_eq!(
            tray_action(&serde_json::json!({}), "trayMiddleClickAction", "tile"),
            "tile"
        );
    }

    /// Названное действие берётся как есть, а регистр значения не важен:
    /// человек правит `config.yaml` руками, и `Tile` там столь же вероятно,
    /// сколько `tile`.
    #[test]
    fn tray_action_reads_every_value_of_the_table() {
        for (id, _) in TRAY_CLICK_ACTIONS {
            let config = serde_json::json!({ "trayClickAction": id });
            assert_eq!(tray_action(&config, "trayClickAction", "sessions"), id);
            let config = serde_json::json!({ "trayClickAction": id.to_uppercase() });
            assert_eq!(tray_action(&config, "trayClickAction", "sessions"), id);
        }
    }

    /// Про занятый хоткей плитки говорит подпись пункта, а не правая колонка:
    /// колонка рисует комбинацию в обоих случаях и отличить их не может.
    ///
    /// Стоит это дороже, чем у соседей: клавишу пикер отобрал у оконного
    /// трекера, и «занята» здесь значит «трекер ещё не выкачен».
    #[test]
    fn tile_label_tells_when_the_hotkey_is_taken() {
        assert_eq!(tile_item_label(true), "Tile windows");
        assert_ne!(tile_item_label(false), tile_item_label(true));
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

    /// Умолчание — главный монитор: место окна должно быть одним и тем же от
    /// открытия к открытию. То же правило, что и у `normalizeConfig` на
    /// странице (`frontend-src/config-shape.js`): разойдись они, галка в окне
    /// настроек обещала бы одно, а окно вставало бы по другому.
    #[test]
    fn the_picker_opens_on_the_main_display_by_default() {
        assert!(!show_on_active_display(&serde_json::json!({})));
        assert!(!show_on_active_display(&serde_json::json!({"showOnActiveDisplay": null})));
        assert!(!show_on_active_display(&serde_json::json!({"showOnActiveDisplay": "yes"})));
    }

    #[test]
    fn the_active_display_flag_is_taken_as_is() {
        assert!(show_on_active_display(&serde_json::json!({"showOnActiveDisplay": true})));
        assert!(!show_on_active_display(&serde_json::json!({"showOnActiveDisplay": false})));
    }

    /// Вторая галка живёт своим ключом и умолчание у неё то же — «ставит окна
    /// тот, кто ставил всегда».
    #[test]
    fn sessions_open_where_they_opened_by_default() {
        assert!(!open_on_active_display(&serde_json::json!({})));
        assert!(!open_on_active_display(&serde_json::json!({"openOnActiveDisplay": null})));
        assert!(!open_on_active_display(&serde_json::json!({"openOnActiveDisplay": "yes"})));
        assert!(open_on_active_display(&serde_json::json!({"openOnActiveDisplay": true})));
    }

    /// Галки независимы, и это проверяется прямо: они стоят рядом в окне
    /// настроек и отвечают на похожие вопросы, но одна про окно списка, другая
    /// про окно терминала. Свяжи их кто-нибудь потом — ошибку было бы видно
    /// только глазами и только на машине с двумя мониторами.
    #[test]
    fn the_two_display_flags_do_not_touch_each_other() {
        let shown_only = serde_json::json!({"showOnActiveDisplay": true});
        assert!(show_on_active_display(&shown_only));
        assert!(!open_on_active_display(&shown_only));

        let opened_only = serde_json::json!({"openOnActiveDisplay": true});
        assert!(!show_on_active_display(&opened_only));
        assert!(open_on_active_display(&opened_only));
    }

    // Ctrl на строке списка главнее выключенной галки: она отвечает на вопрос
    // «как открывать всегда», а модификатор — «как открыть вот эту». Без
    // курсора просьба уехала бы обычной, и окно встало бы в запомненный слот —
    // ровно то, о чём человек попросил не делать.
    #[test]
    fn ctrl_asks_for_the_cursor_with_the_checkbox_off() {
        let off = serde_json::json!({});
        assert!(!wants_cursor(&off, false));
        assert!(wants_cursor(&off, true));
        let on = serde_json::json!({"openOnActiveDisplay": true});
        assert!(wants_cursor(&on, false));
        assert!(wants_cursor(&on, true));
    }

    /// Показанному окну размер ставится на месте: `^F` на открытом пикере
    /// обязан сработать тем же нажатием, а не ждать следующего показа.
    #[test]
    fn a_shown_window_gets_the_size_at_once() {
        let mut req = SizeRequest::default();
        assert_eq!(req.asked(true, true), Some(true));
    }

    /// Скрытому — не ставится вовсе: `set_size` по невыведенному окну на macOS
    /// растягивает его от прежнего угла, а просьба со страницы при загрузке
    /// приходит именно по такому окну. Режим при этом обязан запомниться —
    /// геометрию по нему посчитает `show_picker`.
    #[test]
    fn a_hidden_window_remembers_the_mode_instead() {
        let mut req = SizeRequest::default();
        assert_eq!(req.asked(true, false), None);
        assert_eq!(req.fullscreen, true);
    }

    /// Просьбы к скрытому окну накапливаются последней: страница может
    /// перечитать `ui.json` дважды (загрузка и `ui-changed`), и на показе
    /// действует тот режим, который она назвала последним.
    #[test]
    fn the_last_request_to_a_hidden_window_wins() {
        let mut req = SizeRequest::default();
        assert_eq!(req.asked(true, false), None);
        assert_eq!(req.asked(false, false), None);
        assert_eq!(req.fullscreen, false);
    }

    /// Показ геометрию ставит всегда, а не по отложенной просьбе, — значит
    /// запомненный режим её переживает: второе открытие подряд обязано открыть
    /// пикер той же раскладкой, что и первое.
    #[test]
    fn the_mode_survives_a_show() {
        let mut req = SizeRequest::default();
        req.asked(true, false);
        assert_eq!(req.fullscreen, true, "показ режима не съедает");
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
