//! Сигнал оконного трекера этой машины.
//!
//! Трекер и пикер живут на одной машине, поэтому дорога тут файловая, а не
//! сетевая: ни брокера, ни подписки, ни соединения. Трекер роняет файл, когда
//! меняется **состав** привязанных окон, — то самое, из-за чего снимок
//! скрытого пикера врёт проектному хоткею. Отпечаток внутри файла каждый
//! трекер считает свой; контракт — путь, имя ключа и правило «пишется только
//! на смену», сердцебиения у файла нет.

/// Имя файла в `~/.config/ccfzf-picker/`.
pub const FILE: &str = "tracker-signal.json";

/// Отпечаток из текста файла.
///
/// Пустой, не разбирается, нет поля, поле не строка — всё это «сигнала нет», а
/// не отказ.
pub fn print_of(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    Some(value.get("print")?.as_str()?.to_string())
}

/// Значит ли прочитанное «опроси сейчас».
///
/// Отдельно от чтения файла, потому что правил здесь три и все три
/// молчаливые: первое чтение не считается изменением, «сигнала нет» не стирает
/// запомненное, и только непустой, отличающийся отпечаток значит «опроси».
pub fn decide(last: &mut Option<String>, started: &mut bool, fresh: Option<String>) -> bool {
    let Some(fresh) = fresh else { return false };
    let changed = *started && last.as_deref() != Some(fresh.as_str());
    *last = Some(fresh);
    *started = true;
    changed
}

/// Сторож файла: помнит прошлый отпечаток и жалуется на порченый файл однажды.
pub struct Watcher {
    path: Option<std::path::PathBuf>,
    last: Option<String>,
    started: bool,
    warned: bool,
}

impl Watcher {
    pub fn new(path: Option<std::path::PathBuf>) -> Watcher {
        Watcher { path, last: None, started: false, warned: false }
    }

    /// Изменился ли состав окон с прошлого спроса.
    pub fn changed(&mut self) -> bool {
        let Some(path) = self.path.clone() else { return false };
        let text = std::fs::read_to_string(&path).ok();
        let fresh = text.as_deref().and_then(print_of);
        // Жалоба однажды: файл читается раз в секунду, и непрерывная ругань
        // была бы своей собственной бедой.
        if fresh.is_none() && text.is_some() && !self.warned {
            self.warned = true;
            eprintln!("[picker] tracker signal at {} has unrecognized content", path.display());
        }
        decide(&mut self.last, &mut self.started, fresh)
    }

    /// Сколько секунд назад трекер трогал файл.
    ///
    /// Для строки в окне настроек: разъедься путь между репозиториями, сигнал
    /// молча перестал бы приходить, и отличить это от «ничего не менялось»
    /// было бы нечем.
    pub fn age_secs(&self) -> Option<u64> {
        let modified = std::fs::metadata(self.path.as_ref()?).ok()?.modified().ok()?;
        Some(modified.elapsed().ok()?.as_secs())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn отпечаток_достаётся_из_поля_print() {
        assert_eq!(
            print_of(r#"{"print":"abc","generated":1}"#),
            Some("abc".to_string())
        );
    }

    #[test]
    fn порченый_файл_это_отсутствие_сигнала_а_не_отказ() {
        // Четыре входа, и все четыре значат одно: сказать нечего. Отказ здесь
        // был бы хуже молчания — сигнал это добавка, а не условие работы.
        assert_eq!(print_of(""), None);
        assert_eq!(print_of("не json"), None);
        assert_eq!(print_of(r#"{"generated":1}"#), None);
        assert_eq!(print_of(r#"{"print":42}"#), None);
    }

    #[test]
    fn первое_чтение_не_считается_изменением() {
        // Иначе каждый старт пикера начинался бы с лишнего похода по ssh.
        let (mut last, mut started) = (None, false);
        assert!(!decide(&mut last, &mut started, Some("a".into())));
        assert_eq!(last, Some("a".to_string()));
    }

    #[test]
    fn другой_отпечаток_значит_опроси_сейчас() {
        let (mut last, mut started) = (None, false);
        decide(&mut last, &mut started, Some("a".into()));
        assert!(decide(&mut last, &mut started, Some("b".into())));
    }

    #[test]
    fn тот_же_отпечаток_ничего_не_значит() {
        let (mut last, mut started) = (None, false);
        decide(&mut last, &mut started, Some("a".into()));
        assert!(!decide(&mut last, &mut started, Some("a".into())));
    }

    #[test]
    fn пропавший_файл_не_стирает_запомненное() {
        // Трекер переписывает файл через tmp+rename, и чтение попадает в эту
        // щель. Считай мы пропажу изменением — каждая перезапись стоила бы
        // двух опросов вместо одного.
        let (mut last, mut started) = (None, false);
        decide(&mut last, &mut started, Some("a".into()));
        assert!(!decide(&mut last, &mut started, None));
        assert_eq!(last, Some("a".to_string()));
        assert!(!decide(&mut last, &mut started, Some("a".into())));
    }

    #[test]
    fn без_пути_сторож_молчит() {
        // Ни HOME, ни USERPROFILE — функция выключена целиком, как и всё
        // прочее, что живёт в этом каталоге.
        let mut w = Watcher::new(None);
        assert!(!w.changed());
        assert_eq!(w.age_secs(), None);
    }

    /// Свой файл во временном каталоге на каждый тест: `Watcher::changed`
    /// трогает реальную файловую систему, и тесты не должны видеть файлы друг
    /// друга при параллельном запуске. Тот же приём, что у `temp_config_path`
    /// в `main.rs`.
    fn temp_signal_path(tag: &str) -> std::path::PathBuf {
        static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "ccfzf-picker-test-tracker-signal-{}-{tag}-{n}",
            std::process::id()
        ))
    }

    #[test]
    fn путь_задан_но_файла_на_диске_нет_сторож_молчит() {
        // Путь у сторожа есть — трекер на этой машине просто ещё не разу не
        // писал файл. Отличается от «без_пути_сторож_молчит»: там функция
        // выключена контрактом, здесь путь рабочий, а файла ещё нет.
        let path = temp_signal_path("missing");
        let mut w = Watcher::new(Some(path));
        assert!(!w.changed());
        assert!(!w.changed(), "повторный вызов на всё ещё отсутствующем файле");
    }

    #[test]
    fn реальный_файл_меняется_по_отпечатку() {
        // Три состояния подряд, как их видел бы поток опроса: первое чтение,
        // другой отпечаток, тот же отпечаток.
        let path = temp_signal_path("real");
        std::fs::write(&path, r#"{"print":"a"}"#).unwrap();
        let mut w = Watcher::new(Some(path.clone()));
        assert!(!w.changed(), "первое чтение реального файла — не изменение");

        std::fs::write(&path, r#"{"print":"b"}"#).unwrap();
        assert!(w.changed(), "другой отпечаток на диске — опроси сейчас");

        std::fs::write(&path, r#"{"print":"b"}"#).unwrap();
        assert!(!w.changed(), "тот же отпечаток — снова ничего не значит");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn испорченный_файл_на_диске_не_стирает_запомненное() {
        let path = temp_signal_path("corrupt");
        std::fs::write(&path, r#"{"print":"a"}"#).unwrap();
        let mut w = Watcher::new(Some(path.clone()));
        assert!(!w.changed());

        std::fs::write(&path, "не json").unwrap();
        assert!(!w.changed(), "порча на диске — не сигнал к опросу");

        std::fs::write(&path, r#"{"print":"a"}"#).unwrap();
        assert!(
            !w.changed(),
            "прежний отпечаток после порчи — по-прежнему тот же, не изменение"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn жалоба_на_испорченный_файл_только_один_раз() {
        // `eprintln!` в самом коде не заглушить и не перехватить тестом, но
        // ровно на нём и держится правило «однажды»: второе и третье порченые
        // чтения обязаны идти по ветке `!self.warned` и не печатать снова.
        // Флаг `warned` — приватное поле `Watcher`, но `tests` вложен в тот же
        // модуль, что и структура, и Rust открывает приватность потомкам —
        // отдельного геттера ради теста заводить не пришлось.
        let path = temp_signal_path("warn");
        std::fs::write(&path, "не json").unwrap();
        let mut w = Watcher::new(Some(path.clone()));
        assert!(!w.warned);

        w.changed();
        assert!(w.warned, "первое порченое чтение обязано взвести флаг");

        w.changed();
        w.changed();
        assert!(w.warned, "флаг остаётся взведённым — вторая жалоба не нужна");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn age_secs_на_реальном_файле_есть_а_после_удаления_снова_нет() {
        let path = temp_signal_path("age");
        std::fs::write(&path, r#"{"print":"a"}"#).unwrap();
        let age = Watcher::new(Some(path.clone())).age_secs();
        assert!(matches!(age, Some(s) if s < 5), "{age:?}");

        let _ = std::fs::remove_file(&path);
        assert_eq!(Watcher::new(Some(path)).age_secs(), None);
    }
}
