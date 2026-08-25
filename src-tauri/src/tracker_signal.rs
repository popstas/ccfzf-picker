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
            eprintln!("[picker] tracker signal at {} is unreadable", path.display());
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
}
