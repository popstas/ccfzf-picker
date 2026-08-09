#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
// GlobalShortcutExt — тот самый трейт, без которого `app.global_shortcut()`
// не резолвится.
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

mod config_file;
mod mqtt;
mod poller;
mod proc;
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
    let _ = app.emit("picker-hidden", ());
    if let Some(state) = app.try_state::<LastHidden>() {
        *state.0.lock().unwrap() = Some(Instant::now());
    }
    if let Some(poller) = app.try_state::<poller::Poller>() {
        poller.hidden();
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
        if let Some(poller) = app.try_state::<poller::Poller>() {
            poller.shown();
        }
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

/// Выдать процессу трекера право занять передний план.
///
/// Windows позволяет вызвать `SetForegroundWindow` только процессу, который
/// передним планом уже владеет либо получил последнее событие ввода. Демон
/// трекера — не тот и не другой: к моменту просьбы он просто слушает брокера.
/// Право ему передаёт пикер, и именно сейчас: нажатие, из-за которого мы здесь,
/// было последним событием ввода, и оно наше. Без этого `bringToTop()` на той
/// стороне отчитается об успехе, а на экране мигнёт кнопка на таскбаре.
///
/// `pid` приезжает полем `windowPid` в ответе агрегатора: трекер кладёт свой pid
/// в файл, который тот читает. Отказ не фатален и значит ровно то же, что и
/// отсутствие грамоты, — окно не поднимется.
#[cfg(target_os = "windows")]
fn allow_tracker_foreground(pid: u32) {
    use windows::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;
    if let Err(e) = unsafe { AllowSetForegroundWindow(pid) } {
        eprintln!("ccfzf-picker: cannot grant foreground to pid {pid}: {e}");
    }
}

#[cfg(not(target_os = "windows"))]
fn allow_tracker_foreground(_pid: u32) {}

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
async fn focus_window_mqtt(id: String, pid: u32) -> Result<(), String> {
    // До публикации, а не после: право должно быть у трекера к моменту, когда
    // он дойдёт до подъёма окна.
    allow_tracker_foreground(pid);
    let raw = load_config()?;
    let broker = mqtt::broker_from_config(&raw);
    if !broker.is_configured() {
        return Err("mqtt не настроен: нужны host и base в config.yaml".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || mqtt::focus(&broker, &id))
        .await
        .map_err(|e| format!("focus_window_mqtt task failed: {e}"))?
}

/// Вернуть сессию в непрочитанное у оконного трекера.
///
/// Отметок о просмотре две: своя, в `seen.json`, и трекерная — она приезжает
/// полем `focusedAt` внутри `window` и в списке побеждает по максимуму. Отмотать
/// только свою бесполезно: у сессии с открытым окном трекерная почти всегда
/// свежее и вернула бы кружок в «просмотрено» на следующем же опросе.
///
/// Права на передний план здесь не выдаётся: окно никто не поднимает. Пикер по
/// этой команде не гаснет — список перерисовывается раз в секунду, и кружок
/// оранжевеет на глазах.
#[tauri::command]
async fn unread_session_mqtt(id: String) -> Result<(), String> {
    let raw = load_config()?;
    let broker = mqtt::broker_from_config(&raw);
    if !broker.is_configured() {
        return Err("mqtt не настроен: нужны host и base в config.yaml".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || mqtt::unread(&broker, &id))
        .await
        .map_err(|e| format!("unread_session_mqtt task failed: {e}"))?
}

/// Попросить поднять раскладку снимка.
///
/// Пустой `session_ids` значит «весь снимок». Права на передний план здесь не
/// выдаётся: восстановление открывает новые окна, а не поднимает существующее,
/// и `AllowSetForegroundWindow` тут не при чём.
#[tauri::command]
async fn restore_snapshot_mqtt(id: String, session_ids: Vec<String>) -> Result<(), String> {
    let raw = load_config()?;
    let broker = mqtt::broker_from_config(&raw);
    if !broker.is_configured() {
        return Err("mqtt не настроен: нужны host и base в config.yaml".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || mqtt::restore(&broker, &id, &session_ids))
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
/// Права на передний план, в отличие от `focus_window_mqtt`, не выдаётся — его
/// и некому выдать: pid эта команда не принимает. Поэтому подъём уже открытого
/// окна ей не поручают: без `AllowSetForegroundWindow` трекер отчитается об
/// успехе, а на экране мигнёт кнопка на таскбаре. Разводит эти два случая
/// `chooseEnterAction` во фронтенде.
///
/// `cwd` — каталог проекта строки, и он необязателен только по форме: без него
/// менеджер умеет открыть лишь сессию, которую сам же и помнит слотом, а
/// список пикера приезжает от ccfzf с ssh-хоста и знает сессии, которых на
/// Windows не открывали ни разу. `Option` — чтобы непереданный ключ значил
/// «каталога нет», а не рушил вызов на мосту: у `String` его отсутствие стало
/// бы ошибкой разбора, и Enter отчитался бы человеку про аргументы команды.
#[tauri::command]
async fn open_session_mqtt(id: String, cwd: Option<String>) -> Result<(), String> {
    let raw = load_config()?;
    let broker = mqtt::broker_from_config(&raw);
    if !broker.is_configured() {
        return Err("mqtt не настроен: нужны host и base в config.yaml".to_string());
    }
    let cwd = cwd.unwrap_or_default().trim().to_string();
    tauri::async_runtime::spawn_blocking(move || mqtt::open(&broker, &id, &cwd))
        .await
        .map_err(|e| format!("open_session_mqtt task failed: {e}"))?
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
                    "патч не может обнулять ключ {key}: null заменил бы блок целиком и стёр бы то, чего форма не прислала (например, mqtt.password)"
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
    let (hotkey_registered, hotkey_accelerator) = apply_config(&app);
    Ok(serde_json::json!({
        "hotkeyRegistered": hotkey_registered,
        "hotkeyAccelerator": hotkey_accelerator,
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

/// Пункт трея «показать»: хранится в состоянии приложения, чтобы
/// `apply_config` мог поправить его подпись и акселератор после смены
/// хоткея из окна настроек. Без этого трей продолжал бы обещать комбинацию,
/// которая уже не слушается.
struct ShowMenuItem(MenuItem<tauri::Wry>);

/// Подпись и акселератор пункта трея — по тому же правилу, что и на старте:
/// акселератор — украшение и показывается всегда, а работает ли клавиша на
/// самом деле, говорит подпись (`show_item_label`).
fn update_show_item(item: &MenuItem<tauri::Wry>, registered: bool, accelerator: &str) {
    if let Err(e) = item.set_text(show_item_label(registered)) {
        eprintln!("ccfzf-picker: cannot update tray label: {e}");
    }
    if let Err(e) = item.set_accelerator(Some(accelerator)) {
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
fn apply_config(app: &tauri::AppHandle) -> (bool, String) {
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

    let _ = app.global_shortcut().unregister_all();
    let (registered, accelerator) = register_picker_hotkey(app, &config);
    register_project_hotkeys(app, &config);

    if let Some(item) = app.try_state::<ShowMenuItem>() {
        update_show_item(&item.0, registered, &accelerator);
    }

    let _ = app.emit("config-changed", ());
    (registered, accelerator)
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
/// настроек тоже центрируется и выходит чуть меньше — то есть ложится ровно
/// под пикер и целиком им закрывается: ни прочитать, ни нажать крестик.
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
    tauri::WebviewWindowBuilder::new(
        &app,
        "settings",
        tauri::WebviewUrl::App("settings.html".into()),
    )
    .title("Настройки ccfzf-picker")
    .inner_size(820.0, 600.0)
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

/// Проектный хоткей открывает новую сессию мимо списка, поэтому окно пикера не
/// поднимается: наружу уходит только событие.
fn register_project_hotkeys(app: &tauri::AppHandle, config: &serde_json::Value) {
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
        let handle = app.clone();
        let path = path.to_string();
        if let Err(e) = app.global_shortcut().on_shortcut(sc, move |_app, _sc, event| {
            if event.state() == ShortcutState::Pressed {
                let _ = handle.emit("project-hotkey", path.clone());
            }
        }) {
            eprintln!("ccfzf-picker: cannot register hotkey {hotkey}: {e}");
        }
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
            hide_picker, poll_now, spawn_detached, load_seen, save_seen, load_config,
            copy_to_clipboard, load_ui, save_ui, focus_window_mqtt, unread_session_mqtt,
            restore_snapshot_mqtt, open_session_mqtt, save_config, open_settings
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
            // Сохраняется в состоянии, чтобы `apply_config` мог поправить эту
            // же подпись и акселератор после сохранения настроек — без
            // пересборки всего меню на каждое сохранение.
            app.manage(ShowMenuItem(show_item.clone()));
            // Настройки — второй пункт, между показом и выходом. Из трея они
            // достижимы и тогда, когда до шестерёнки в статуслайне не добраться:
            // хоткей не встал, а пикер не открывается по той самой настройке,
            // которую надо и поправить.
            let settings_item =
                MenuItem::with_id(app, "settings", "Настройки…", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &settings_item, &quit_item])?;
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

            register_project_hotkeys(app.handle(), &config);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ccfzf-picker");
}

#[cfg(test)]
mod tests {
    use super::*;

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
