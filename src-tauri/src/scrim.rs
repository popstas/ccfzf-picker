//! Подложка позади пикера — приглушённый прямоугольник на весь экран,
//! показанный, пока список открыт.
//!
//! Это нативное окно самой системы, а не второй webview Tauri: второй
//! рендерер стоил бы памяти и запуска ради прямоугольника одного цвета, а
//! свой webview завёл бы вторую страницу, вторую цепочку фокуса и вторую
//! причину, по которой пикер мог бы не закрыться вовремя. Сторож —
//! `test/scrim.test.js`: он грепает этот файл на строитель webview-окон Tauri
//! (его тут быть не должно вовсе) и сверяет список меток таких окон во всём
//! крейте с единственной законной — окном настроек. Из-за первой проверки
//! этому файлу нельзя даже упоминать в тексте название того строителя.
//!
//! Подложка принимает клик, а не пропускает его насквозь — общее для обеих
//! платформ правило: на Windows это отказ от `WS_EX_TRANSPARENT`, на macOS —
//! `setIgnoresMouseEvents(false)`. Пропусти она клик, тот ушёл бы окну под
//! ней — рабочему столу или чужому приложению, — то есть нажал бы кнопку в
//! чужой программе, которую человек и не думал нажимать: он метил в
//! затемнение.
//!
//! **Пикер по этому клику гасит не потеря фокуса, а сама подложка.** Спека
//! обещала обратное — «клик уводит фокус, при включённом `hideOnBlur` пикер
//! гаснет сам, отдельного обработчика не нужно», — и это оказалось неверно;
//! doc-комментарий на этом месте предполагал ошибку по чтению флагов, а живая
//! проверка владельца на Windows и на macOS её подтвердила: клик по
//! затемнению не делал ничего **ни в одной раскладке**. Причина ровно та, что
//! была названа. Windows-сторона создаёт подложку с `WS_EX_NOACTIVATE`
//! (`CreateWindowExW` в `win::ensure_window`) — это по определению запрет окну
//! становиться foreground по клику; на macOS `NSWindow` со стилем `Borderless`
//! без переопределённого `canBecomeKeyWindow` key-окном не становится. Фокус
//! у пикера не отбирается, `Focused(false)` не приходит, гасить некому.
//!
//! Отсюда свой обработчик на каждой платформе: `wnd_proc` ловит
//! `WM_*BUTTONDOWN`, `ScrimView::mouseDown:` — клик по вьюхе, и оба зовут одну
//! `dismiss`. Оконные флаги при этом не тронуты намеренно: менять стили
//! вслепую значило бы обменять известную ошибку на неизвестную — подложка
//! начала бы перехватывать фокус там, где раньше не перехватывала.
//!
//! Гасится пикер **безусловно, не спрашивая `hideOnBlur`**, и это решение, а
//! не упущение. `hideOnBlur` — про уход в чужую программу; включённая
//! подложка делает список модальным на вид, а у модального затемнения ровно
//! одно значение клика: «закрыть». Обратная развилка («с выключенным
//! `hideOnBlur` клик по подложке не делает ничего») вернула бы ровно тот
//! симптом, из-за которого правка и затеяна, — молчащее затемнение.
//!
//! **Публичный `set_visible` внизу файла обязан быть безопасен с любого
//! потока.** И Win32-окна, и весь AppKit — собственность потока, который их
//! создал; трогать их с чужого потока — от тихой порчи состояния до крэша.
//! А вызывающие здесь бывают на любом потоке: `open_settings` в `main.rs`
//! нарочно `async` и потому крутится вне цикла событий (см. CLAUDE.md), и
//! именно она гасит пикер (`hide_window` → `scrim::set_visible(false)`) на
//! пути «открыть настройки». Решает это не проверка на входе, а
//! `app.run_on_main_thread` — тот же приём, которым уже пользуются
//! `set_size`/`center` в `main.rs`: на главном потоке он исполняет сразу,
//! синхронно, с любого другого — откладывает на ближайший тик цикла событий.
//! Платформенные `apply()` ниже поэтому вправе полагаться на то, что они уже
//! на главном потоке, а не проверять это как первое, на что можно
//! понадеяться.

/// Какой из двух флагов конфига применяется сейчас.
///
/// Раскладка одна и та же ось, что решает размер окна (`fullscreen` — это тот
/// же флаг, что ведёт `wanted_size` в `main.rs`): широкий режим просит
/// `wide`, узкий — `narrow`. Второго источника правды тут нет — иначе
/// подложка могла бы не совпасть с тем, что человек видит в окне настроек.
pub fn scrim_wanted(fullscreen: bool, narrow: bool, wide: bool) -> bool {
    if fullscreen {
        wide
    } else {
        narrow
    }
}

/// Хендл приложения для платформенных обработчиков клика.
///
/// Мышиное событие приходит не в наш вызов, а в оконную процедуру (Windows) и
/// в `mouseDown:` вьюхи (macOS): подписи у обеих задала система, и аргумента
/// туда не передать. Хендл поэтому кладётся сюда на первом же `set_visible` —
/// то есть заведомо раньше первого клика: нажать можно только показанную
/// подложку, а показывает её тот же вызов.
///
/// `OnceLock`, а не `Mutex`: значение ставится один раз и живёт до конца
/// процесса, а читается из обработчика клика, которому блокировка была бы
/// лишним способом встать насмерть.
#[cfg(any(windows, target_os = "macos"))]
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// Клик по подложке: погасить пикер.
///
/// Общая на обе платформы — расходиться этим двум обработчикам нельзя, а
/// разойтись они могли бы только молча: ни один из них не собирается на этой
/// машине. `hide_window` гасит и саму подложку (`scrim::set_visible(false)` у
/// себя внутри), так что второго шага здесь нет и быть не должно.
///
/// Тишина на неизвестном хендле намеренна: до первого показа подложки кликать
/// не по чему, и жаловаться в stderr значило бы писать о невозможном.
#[cfg(any(windows, target_os = "macos"))]
fn dismiss() {
    let Some(app) = APP.get() else { return };
    crate::hide_window(app);
}

/// Выполнить платформенную работу на главном потоке, откуда бы её ни попросили.
///
/// Общий для Windows и macOS: `run_on_main_thread` берёт замыкание `Send`,
/// значит платформенная ошибка не может уехать обратно синхронным `Result`
/// — её некому было бы вернуть, случись вызов не с главного потока. Поэтому
/// она просто логируется тут же, тем же приёмом, которым остальной код файла
/// уже жертвует синхронным `Result` ради того, чтобы показ и размер самого
/// пикера не зависели от подложки.
#[cfg(any(windows, target_os = "macos"))]
fn on_main_thread(
    app: &tauri::AppHandle,
    f: impl FnOnce(&tauri::AppHandle) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    // Обработчикам клика хендл иначе взять неоткуда — см. `APP`. Ставится он
    // здесь, на общей дороге обеих платформ: у `set_visible` их две, и вторая
    // копия строки разошлась бы с первой.
    let _ = APP.set(app.clone());
    let app = app.clone();
    // `run_on_main_thread` берёт `&self`, а замыкание ниже забирает `app` в
    // себя целиком (`move`) — один и тот же биндинг не может быть и тем, что
    // заимствуется для вызова, и тем, что перемещается в аргумент. Лишний
    // `clone()` перед вызовом решает это дешевле, чем заводить вторую
    // переменную под то же значение: `AppHandle` внутри — счётчик ссылок,
    // клонирование стоит одного инкремента.
    app.clone()
        .run_on_main_thread(move || {
            if let Err(e) = f(&app) {
                ccfzf_log!("{e}");
            }
        })
        .map_err(|e| format!("cannot schedule the scrim: {e}"))
}

#[cfg(windows)]
mod win {
    //! `CreateWindowExW` напрямую, а не через Tauri: Tauri создаёт только
    //! webview-окна, а нам нужно ровно противоположное — окно без страницы
    //! внутри. Крейт `windows` уже в дереве (`icons.rs`, `allow_any_foreground`
    //! в `main.rs`), и его типы буквально те же, что отдаёт `WebviewWindow::hwnd()`
    //! — Cargo резолвит один и тот же `windows 0.61.3` на оба потребителя,
    //! так что z-order пикера можно поднять тем же типом `HWND` без
    //! конвертации.
    use std::sync::Mutex;
    // `get_webview_window` — метод трейта `Manager`, а не инструментального
    // AppHandle: `main.rs` его импортирует у себя, а этот модуль — свой,
    // отдельная область видимости, свой импорт. Модуль целиком под
    // `#[cfg(windows)]`, поэтому на Linux этой строки не существует вовсе —
    // и предупреждения о неиспользованном импорте здесь взяться неоткуда.
    use tauri::Manager;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::CreateSolidBrush;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, RegisterClassW, SetLayeredWindowAttributes, SetWindowPos,
        ShowWindow, CS_HREDRAW, CS_VREDRAW, HCURSOR, HICON, HWND_TOPMOST, LWA_ALPHA, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, SW_HIDE, SW_SHOWNOACTIVATE, WM_LBUTTONDOWN, WM_MBUTTONDOWN,
        WM_RBUTTONDOWN, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
    };
    use windows::Win32::Foundation::COLORREF;

    /// HWND подложки, если она уже создана — окно живёт до конца процесса и
    /// пересоздаётся никогда не будет.
    ///
    /// `HWND` не `Send`, а хранить его надо между вызовами `apply` (которые
    /// приходят уже с главного потока — это гарантирует `on_main_thread` в
    /// родительском модуле, — но сам `HWND` от этого `Send` не становится);
    /// значение поэтому лежит числом, тем же приёмом, каким на macOS-стороне
    /// этого же файла хранится указатель на `NSWindow`.
    static SCRIM_HWND: Mutex<isize> = Mutex::new(0);

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        // Цвет красит фон класса (`hbrBackground` в `ensure_window`), а
        // разбирать подложке остаётся ровно одно — нажатие мыши: по нему
        // гаснет пикер. Сам собой он не погаснет, `WS_EX_NOACTIVATE`
        // запрещает окну забирать передний план, то есть `hideOnBlur` у
        // пикера не срабатывает вовсе (см. doc-комментарий модуля).
        //
        // Ловится нажатие, а не отпускание: до `WM_LBUTTONUP` дело может и не
        // дойти — человек нажал и увёл мышь, — а гасить надо по жесту, а не
        // по его аккуратному завершению. Все три кнопки, потому что «мимо
        // списка» значит одно и то же любой из них; правая своего меню у
        // подложки не открывает, так что перехватывать нечего.
        //
        // `LRESULT(0)` вместо `DefWindowProcW`: сообщение разобрано, и
        // передавать его дальше незачем — умолчание всё равно попыталось бы
        // окно активировать.
        if msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN || msg == WM_MBUTTONDOWN {
            super::dismiss();
            return LRESULT(0);
        }
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    fn class_name() -> Vec<u16> {
        wide("ccfzf-picker-scrim")
    }

    /// Модуль текущего процесса — `hInstance` для класса и самого окна.
    fn module_handle() -> Result<HINSTANCE, String> {
        unsafe { GetModuleHandleW(PCWSTR::null()) }
            .map(HINSTANCE::from)
            .map_err(|e| format!("cannot get module handle for the scrim: {e}"))
    }

    /// Прямоугольник монитора пикера в физических точках экрана — тех же,
    /// которые понимает `CreateWindowExW`.
    fn monitor_rect(app: &tauri::AppHandle) -> Option<(i32, i32, i32, i32)> {
        let window = app.get_webview_window("picker")?;
        let monitor = window
            .current_monitor()
            .ok()
            .flatten()
            .or_else(|| window.primary_monitor().ok().flatten())?;
        let pos = monitor.position();
        let size = monitor.size();
        Some((pos.x, pos.y, size.width as i32, size.height as i32))
    }

    /// Создать (лениво, один раз на процесс) или вернуть уже созданное окно.
    fn ensure_window() -> Result<HWND, String> {
        let mut guard = SCRIM_HWND.lock().unwrap();
        if *guard != 0 {
            return Ok(HWND(*guard as _));
        }

        let hinstance = module_handle()?;
        let class_name = class_name();
        let class = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            // Ни то ни другое не derive(Default) в крейте `windows` — оба
            // сводятся к тому же нулевому указателю, только явно.
            hIcon: HICON(std::ptr::null_mut()),
            hCursor: HCURSOR(std::ptr::null_mut()),
            // Чёрный сплошной — единственный цвет, который умеет подложка;
            // прозрачность даёт не он, а `SetLayeredWindowAttributes` ниже.
            // `DeleteObject` на кисть не зовётся нигде: она живёт вместе с
            // классом окна, то есть весь процесс, — то же намеренное
            // нежелание чистить за собой, что и у `Retained::into_raw` на
            // macOS-стороне этого файла.
            hbrBackground: unsafe { CreateSolidBrush(COLORREF(0)) },
            lpszMenuName: PCWSTR::null(),
            lpszClassName: PCWSTR(class_name.as_ptr()),
        };
        // Атом 0 у первой в процессе регистрации значит настоящий отказ:
        // окна с этим именем в процессе ещё не было, и «уже существует» тут
        // не бывает.
        if unsafe { RegisterClassW(&class) } == 0 {
            return Err("cannot register the scrim window class".to_string());
        }

        // Место и размер не важны на создании — их до показа всё равно
        // переставит `apply` по свежему монитору пикера; здесь только самая
        // скромная заглушка, чтобы не заказывать окно нулевого размера до
        // того, как что-то попросит его показать.
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                PCWSTR(class_name.as_ptr()),
                PCWSTR::null(),
                WS_POPUP,
                0,
                0,
                1,
                1,
                None,
                None,
                Some(hinstance),
                None,
            )
        }
        .map_err(|e| format!("cannot create the scrim window: {e}"))?;

        // ~0.45: доля фиксирована в задаче, настройки на неё нет и не будет.
        unsafe { SetLayeredWindowAttributes(hwnd, COLORREF(0), 115, LWA_ALPHA) }
            .map_err(|e| format!("cannot set scrim opacity: {e}"))?;

        *guard = hwnd.0 as isize;
        Ok(hwnd)
    }

    /// Пикер держит свой топмост, выставленный при создании окна (Tauri),
    /// живым и после того, как подложка вставила себя в ту же полосу
    /// топмост-окон: `SetWindowPos(HWND_TOPMOST, …)` у подложки иначе мог бы
    /// задвинуть пикер под неё — Windows кладёт только что топнутое окно
    /// наверх полосы, а какое из двух топнуто позже, решает порядок вызовов,
    /// а не то, что пикер топмостнее «по смыслу».
    ///
    /// Обе ветки отказа логируются, а не молчат: молчание здесь означало бы
    /// пикер, осевший под подложкой, — без единого следа в stderr искать
    /// такое пришлось бы глазами на экране, а не по логу.
    fn reassert_picker_on_top(app: &tauri::AppHandle) {
        let Some(window) = app.get_webview_window("picker") else {
            ccfzf_log!("cannot reassert the picker on top of the scrim: no picker window");
            return;
        };
        let Ok(hwnd) = window.hwnd() else {
            ccfzf_log!("cannot reassert the picker on top of the scrim: no hwnd");
            return;
        };
        unsafe {
            if let Err(e) = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            ) {
                ccfzf_log!("cannot reassert the picker on top of the scrim: {e}");
            }
        }
    }

    /// Настоящая работа — вызывается уже на главном потоке, гарантию даёт
    /// `on_main_thread` в родительском модуле.
    pub(super) fn apply(app: &tauri::AppHandle, show: bool) -> Result<(), String> {
        if !show {
            let guard = SCRIM_HWND.lock().unwrap();
            if *guard != 0 {
                // `ShowWindow` возвращает `BOOL` с `#[must_use]` — не про
                // ошибку, а про то, было ли окно видимо *до* вызова; прятать
                // уже спрятанное не ошибка, и разбирать здесь нечего.
                let _ = unsafe { ShowWindow(HWND(*guard as _), SW_HIDE) };
            }
            return Ok(());
        }

        let hwnd = ensure_window()?;
        let (x, y, w, h) = monitor_rect(app).unwrap_or((0, 0, 1, 1));
        unsafe {
            SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, w, h, SWP_NOACTIVATE)
                .map_err(|e| format!("cannot place the scrim window: {e}"))?;
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
        reassert_picker_on_top(app);
        Ok(())
    }
}

#[cfg(windows)]
pub fn set_visible(app: &tauri::AppHandle, show: bool) -> Result<(), String> {
    on_main_thread(app, move |app| win::apply(app, show))
}

#[cfg(target_os = "macos")]
mod mac {
    //! Borderless `NSWindow`, а не Tauri: тем же приёмом, что и на Windows,
    //! Tauri умеет создавать только webview-окна.
    use std::sync::Mutex;
    // Та же причина, что у Windows-стороны этого файла: `get_webview_window`
    // из трейта `Manager`, модуль под своим `#[cfg(target_os = "macos")]`,
    // импорт свой — на Linux этот код не компилируется вовсе.
    use tauri::Manager;
    use objc2::rc::Retained;
    use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSBackingStoreType, NSColor, NSEvent, NSFloatingWindowLevel, NSScreen, NSView, NSWindow,
        NSWindowStyleMask,
    };

    define_class!(
        // SAFETY: у `NSView` нет требований к наследованию, кроме главного
        // потока — он и объявлен `MainThreadOnly`. Своих ivars у класса нет,
        // `Drop` он не реализует.
        #[unsafe(super(NSView))]
        #[thread_kind = MainThreadOnly]
        // Имя в рантайме Objective-C одно на процесс, поэтому названо явно и с
        // приставкой проекта: класс с общим именем столкнулся бы с чужим в том
        // же процессе — а в процессе живёт ещё и весь AppKit.
        #[name = "CcfzfPickerScrimView"]
        struct ScrimView;

        impl ScrimView {
            /// Нажали по затемнению — гасим пикер.
            ///
            /// Своей работы у вьюхи больше нет вовсе: цвет красит окно
            /// (`setBackgroundColor`), а рисовать ей нечего. Заведена она
            /// ровно ради этого метода — принять клик, который иначе ушёл бы
            /// в никуда: `NSWindow` ключевым не становится, и `hideOnBlur`
            /// пикера не срабатывает (см. doc-комментарий модуля).
            #[unsafe(method(mouseDown:))]
            fn mouse_down(&self, _event: &NSEvent) {
                super::dismiss();
            }

            /// Первый клик в неактивное окно AppKit по умолчанию съедает:
            /// `acceptsFirstMouse:` отвечает `NO`, и нажатие только
            /// активирует окно, до вьюхи не доходя. Подложка ключевым окном
            /// не становится **никогда** (borderless), то есть каждый её клик
            /// — «первый», и без этого переопределения `mouseDown:` не позвался
            /// бы ни разу.
            #[unsafe(method(acceptsFirstMouse:))]
            fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
                true
            }
        }
    );

    /// Адрес уже созданного окна, числом — `Retained<NSWindow>` не `Send`, а
    /// нам нужно держать его между вызовами `apply`. Ссылка не освобождается
    /// никогда: подложка живёт весь процесс, `into_raw` отпускает её
    /// из-под учёта ARC намеренно, а не по забывчивости.
    static SCRIM_PTR: Mutex<usize> = Mutex::new(0);

    /// Экран, на котором сейчас стоит пикер, — не монитор, названный Tauri
    /// (у него нет способа спросить «какой это `NSScreen`»), а прямой
    /// вопрос к самому `NSWindow` пикера: тот и так это знает.
    ///
    /// `ns_window()` у Tauri отдаёт голый `*mut c_void` — тот же объект
    /// Cocoa, каким его видит и `objc2-app-kit`, просто через другую
    /// обёртку; каст `*mut NSWindow` и последующий вызов `screen()` через
    /// разыменование указателя — стандартный приём межбиблиотечного FFI
    /// поверх одного и того же `id`, не создающий второго объекта. `None` —
    /// то же самое, чем окно ещё не показано или Tauri не смог отдать
    /// хендл; в обоих случаях вызывающий откатывается на главный экран.
    fn picker_screen(app: &tauri::AppHandle) -> Option<Retained<NSScreen>> {
        let window = app.get_webview_window("picker")?;
        let ptr = window.ns_window().ok()? as *mut NSWindow;
        // safety: см. doc-комментарий выше — указатель на настоящий, живой
        // NSWindow пикера (окно создаётся в `setup` и живёт весь процесс), а
        // `screen()` дальше — безопасный по сигнатуре метод.
        unsafe { ptr.as_ref() }?.screen()
    }

    /// Создать (лениво, один раз на процесс) или вернуть уже созданное окно.
    ///
    /// Место здесь — только заготовка под `initWithContentRect`: настоящее
    /// ставит `apply` перед каждым показом (`picker_screen` там же), так что
    /// какой это `NSScreen` на создании — не важно, лишь бы был.
    fn ensure_window(mtm: MainThreadMarker) -> Result<*mut NSWindow, String> {
        let mut guard = SCRIM_PTR.lock().unwrap();
        if *guard != 0 {
            return Ok(*guard as *mut NSWindow);
        }

        let screen = NSScreen::mainScreen(mtm)
            .ok_or_else(|| "no screen to put the scrim on".to_string())?;

        let alloc = mtm.alloc::<NSWindow>();
        // unsafe: конструкторы NSWindow помечены unsafe самим objc2-app-kit —
        // вне контроллера окна забота о памяти на нас, отсюда
        // `setReleasedWhenClosed(false)` следующей строкой, как велит
        // doc-комментарий у класса.
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                alloc,
                screen.frame(),
                NSWindowStyleMask::Borderless,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        unsafe { window.setReleasedWhenClosed(false) };
        window.setOpaque(false);
        window.setHasShadow(false);
        // false, а не true: клик обязан попасть в подложку, а не пройти
        // насквозь в чужую программу — см. doc-комментарий модуля `scrim` про
        // запрет `WS_EX_TRANSPARENT` на Windows, здесь та же причина.
        window.setIgnoresMouseEvents(false);
        // Принять клик мало — его должно быть кому разобрать: гасит пикер сама
        // подложка, потому что фокуса она не отбирает и `hideOnBlur` не
        // сработает. Голый `NSView` нажатие проглотил бы молча.
        let view: Retained<ScrimView> = unsafe { msg_send![ScrimView::alloc(mtm), init] };
        window.setContentView(Some(&view));
        let color = NSColor::blackColor().colorWithAlphaComponent(0.45);
        window.setBackgroundColor(Some(&color));
        // Пикер поднимается на `NSFloatingWindowLevel` — так его ставит tao
        // (`platform_impl/macos/window.rs`, `set_always_on_top`), а Tauri
        // включает эту опцию окну пикера полем `alwaysOnTop` в
        // `tauri.conf.json`. Подложка на единицу ниже: видна над обычными
        // окнами стола, но остаётся под пикером.
        window.setLevel(NSFloatingWindowLevel - 1);

        let raw = Retained::into_raw(window);
        *guard = raw as usize;
        Ok(raw)
    }

    /// Настоящая работа — вызывается уже на главном потоке, гарантию даёт
    /// `on_main_thread` в родительском модуле. `MainThreadMarker::new()`
    /// здесь всё равно спрашивается: не как единственная защита (ей теперь
    /// служит `on_main_thread`), а как дешёвая подстраховка на случай, если
    /// будущая правка когда-нибудь вызовет `apply` в обход него.
    pub(super) fn apply(app: &tauri::AppHandle, show: bool) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or_else(|| {
            "scrim ended up off the main thread despite on_main_thread — this should not happen"
                .to_string()
        })?;

        if !show {
            let guard = SCRIM_PTR.lock().unwrap();
            if *guard != 0 {
                let window = unsafe { &*(*guard as *const NSWindow) };
                window.orderOut(None);
            }
            return Ok(());
        }

        let raw = ensure_window(mtm)?;
        let window = unsafe { &*raw };
        // Место пересчитывается на каждый показ, не только на создании:
        // пикер мог переехать на другой экран с прошлого раза — тем же
        // приёмом, каким Windows-сторона (`win::monitor_rect` +
        // `SetWindowPos`) переставляет подложку на актуальный монитор при
        // каждом вызове.
        if let Some(screen) = picker_screen(app).or_else(|| NSScreen::mainScreen(mtm)) {
            window.setFrame_display(screen.frame(), false);
        }
        window.orderFront(None);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub fn set_visible(app: &tauri::AppHandle, show: bool) -> Result<(), String> {
    on_main_thread(app, move |app| mac::apply(app, show))
}

/// Linux (и любая третья платформа): подложки не бывает, флаги хранятся и
/// молча игнорируются — то же умолчание, что у `icons::extract` вне Windows.
#[cfg(not(any(windows, target_os = "macos")))]
pub fn set_visible(_app: &tauri::AppHandle, _show: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::scrim_wanted;

    #[test]
    fn scrim_wanted_picks_the_flag_of_the_shown_layout() {
        assert_eq!(scrim_wanted(false, false, false), false);
        assert_eq!(scrim_wanted(false, true, false), true, "узкий берёт narrow");
        assert_eq!(scrim_wanted(false, false, true), false, "узкий не смотрит на wide");
        assert_eq!(scrim_wanted(true, false, false), false);
        assert_eq!(scrim_wanted(true, false, true), true, "широкий берёт wide");
        assert_eq!(scrim_wanted(true, true, false), false, "широкий не смотрит на narrow");
        assert_eq!(scrim_wanted(true, true, true), true);
        assert_eq!(scrim_wanted(false, true, true), true);
    }
}
