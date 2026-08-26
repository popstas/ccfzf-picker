//! Простой человека за этой машиной.
//!
//! Вопрос один — сколько прошло с последнего нажатия клавиши или движения
//! мыши, — и отвечает на него система, а не пикер: своего счётчика ввода у
//! приложения из трея нет и быть не может, окон оно почти всё время не
//! показывает.
//!
//! Нужен ответ ради фонового опроса: пока человека за машиной нет, тянуть
//! состояние себе в кэш незачем — смотреть на список некому, — а вот дамп на
//! агрегаторе освежать надо по-прежнему, им живёт панель openHASP. Решение
//! про это — в `poller.rs`, здесь только отметка.
//!
//! **`None` — это «спросить не у кого», и значит оно «человек за машиной».**
//! Систем, где отметки не достать, две: Linux (пикера там не стоит) и любая
//! будущая; отказ самого вызова — третий случай того же рода. Обратное
//! умолчание было бы молчаливой поломкой: невиданная система разом перестала
//! бы опрашивать агрегатора, и выглядело бы это лежащим ssh, а не выключенным
//! опросом.

use std::time::Duration;

/// Простаивает ли машина дольше порога.
///
/// Отдельно от чтения отметки, потому что решение проверяемое, а системный
/// вызов — нет: на машине, где идут тесты, ввода не бывает вовсе.
pub fn is_away(since: Option<Duration>, after: Duration) -> bool {
    since.is_some_and(|s| s >= after)
}

/// Простаивает ли машина прямо сейчас.
pub fn away(after: Duration) -> bool {
    is_away(since_input(), after)
}

/// Сколько прошло с последнего ввода человека на этой машине.
#[cfg(windows)]
pub fn since_input() -> Option<Duration> {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    let mut info = LASTINPUTINFO {
        // Размер структуры — часть протокола вызова: без него функция
        // отказывает, а не читает мусор.
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // Заблокированный экран считается простоем сам собой: на защищённом
    // рабочем столе ввод идёт мимо этой отметки, и она стоит на месте с
    // момента блокировки. Это ровно то, что нужно.
    if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        return None;
    }
    // Обе величины — миллисекунды от старта системы в 32 битах, то есть раз
    // в 49,7 суток они переполняются. `wrapping_sub` даёт верную разность и
    // на переходе через ноль; вычитание в лоб дало бы там панику в отладке и
    // 49 суток простоя в релизе.
    let ms = unsafe { GetTickCount() }.wrapping_sub(info.dwTime);
    Some(Duration::from_millis(ms as u64))
}

/// Сколько прошло с последнего ввода человека на этой машине.
#[cfg(target_os = "macos")]
pub fn since_input() -> Option<Duration> {
    // Голым `extern`, а не крейтом биндинга: вопрос здесь в одну функцию, а
    // дерево зависимостей у пикера и так 323 крейта — время сборки в этом
    // проекте посчитано таблицей в `Cargo.toml`.
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    }
    // 1 — `kCGEventSourceStateHIDSystemState`: отметка самой системы ввода, а
    // не своего события приложения. `kCGAnyInputEventType` (0xFFFFFFFF) —
    // «любое»: считать надо и клавиши, и мышь, и трекпад.
    let secs = unsafe { CGEventSourceSecondsSinceLastEventType(1, 0xFFFF_FFFF) };
    // Отрицательного и бесконечного здесь быть не должно, но `from_secs_f64`
    // на таком паникует — а это фоновый поток, единственный.
    (secs.is_finite() && secs >= 0.0).then(|| Duration::from_secs_f64(secs))
}

/// Сколько прошло с последнего ввода человека на этой машине.
#[cfg(not(any(windows, target_os = "macos")))]
pub fn since_input() -> Option<Duration> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_machine_nobody_touched_for_longer_than_the_threshold_is_away() {
        let after = Duration::from_secs(300);
        assert!(!is_away(Some(Duration::ZERO), after));
        assert!(!is_away(Some(Duration::from_secs(299)), after));
        // Ровно порог — уже простой: иначе граница зависела бы от того, в
        // какую миллисекунду попал такт.
        assert!(is_away(Some(Duration::from_secs(300)), after));
        assert!(is_away(Some(Duration::from_secs(3600)), after));
    }

    #[test]
    fn no_answer_means_the_human_is_here() {
        // Умолчание молчаливое, и неверное было бы дороже: система, у которой
        // отметки не спросить, разом перестала бы опрашивать агрегатора — а
        // выглядело бы это лежащим ssh.
        assert!(!is_away(None, Duration::from_secs(300)));
        assert!(!is_away(None, Duration::ZERO));
    }

    /// На Linux отметки нет вовсе, и это не отказ.
    #[cfg(not(any(windows, target_os = "macos")))]
    #[test]
    fn a_system_without_the_mark_never_goes_away() {
        assert_eq!(since_input(), None);
        assert!(!away(Duration::from_secs(300)));
    }
}
