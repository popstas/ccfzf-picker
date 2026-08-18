//! Чем звать `ccfzf` на этой машине.

use std::sync::OnceLock;

/// Копия агрегатора, вшитая в бинарь.
///
/// Файл, а не зависимость: `ccfzf` живёт своим репозиторием (подмодуль
/// `vendor/ccfzf`), и человеку, поставившему пикер рядом с обычным claude,
/// ставить его отдельно негде.
const VENDORED: &str = include_str!("../../vendor/ccfzf/ccfzf");

/// Путь распакованной копии — считается один раз за запуск процесса.
///
/// Раньше это было в комментарии у `unpack`: приём тот же, что у
/// `TERMINAL_HELPER`, файл пишется на каждый спрос. Довод там неверен —
/// `TERMINAL_HELPER` пишется по человеческому действию (клик, попытка
/// открыть терминал), а `unpack` звал `resolve()`, который дёргает поллер
/// раз в секунду. Настоящая беда — гонка: `set_comment` пишет файл на
/// blocking-таске одновременно с тем, как поллер читает вшитую копию
/// шеллом (`bash … --state`), и `fs::write` обрезает файл под читающим
/// шеллом — отказ виден один раз, невоспроизводимо, как поломанный JSON.
///
/// Свежесть копии при этом не страдает: бинарь и вшитая в него копия
/// меняются вместе, одной пересборкой, — записи один раз на старте
/// процесса достаточно, чтобы файл никогда не был старой копией из
/// прошлой сборки.
static UNPACKED: OnceLock<Result<String, String>> = OnceLock::new();

/// Программа и её первые аргументы. Чистая: настоящий PATH и настоящий
/// домашний каталог в тесте не подделать.
pub fn choose(in_path: bool, vendored: Option<&str>) -> Result<(String, Vec<String>), String> {
    if in_path {
        return Ok(("ccfzf".to_string(), vec![]));
    }
    match vendored {
        Some(path) => Ok(("bash".to_string(), vec![path.to_string()])),
        None => Err(
            "ccfzf not found: install it, or check that the bundled copy can be written to the config directory"
                .to_string(),
        ),
    }
}

/// Есть ли программа в PATH. Своим перебором, а не крейтом `which`: дерево
/// зависимостей у пикера и так 323 крейта, а вопрос здесь на десять строк.
pub fn on_path(name: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| {
        let candidate = dir.join(name);
        candidate.is_file()
    })
}

/// Распаковать вшитую копию рядом с конфигом и вернуть путь к ней.
fn unpack() -> Result<String, String> {
    let path = crate::state_path("ccfzf")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    std::fs::write(&path, VENDORED).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("cannot chmod {}: {e}", path.display()))?;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Настоящее разрешение: PATH, иначе распакованная копия.
///
/// Распаковка — не на каждый вызов: `resolve` дёргает поллер раз в секунду,
/// пока окно показано, а `unpack()` — это `fs::write` полных 171 КБ плюс
/// `chmod`. `UNPACKED` считает её один раз за жизнь процесса и дальше отдаёт
/// готовый путь или готовую ошибку.
///
/// Ошибку не глотаем: `unpack()` называет причину («cannot write …:
/// Permission denied»), а подмена её на общий «ccfzf not found» через
/// `choose(false, None)` эту причину стирала бы — человек читал бы про
/// отсутствие программы там, где программа есть, но её некуда записать.
pub fn resolve() -> Result<(String, Vec<String>), String> {
    if on_path("ccfzf") {
        return choose(true, None);
    }
    match UNPACKED.get_or_init(unpack) {
        Ok(path) => choose(false, Some(path)),
        Err(e) => Err(e.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::choose;

    /// PATH первым — и это не вкусовщина. На машине, где `ccfzf` уже стоит,
    /// он же переписывает `~/.ccfzf.sessions.json`, с которого живут оконный
    /// трекер, экспорт в Home Assistant и панель. Две разные версии над одним
    /// файлом были бы бедой, которую видно не сразу и не здесь.
    #[test]
    fn path_wins_over_the_bundled_copy() {
        assert_eq!(choose(true, Some("/tmp/ccfzf")).unwrap(), ("ccfzf".to_string(), vec![]));
    }

    /// Нет в PATH — зовём вшитую копию, и зовём её через bash: `ccfzf` это
    /// bash-обёртка вокруг встроенной python-программы, а не исполняемый
    /// питон.
    #[test]
    fn the_bundled_copy_runs_through_bash() {
        assert_eq!(
            choose(false, Some("/tmp/ccfzf")).unwrap(),
            ("bash".to_string(), vec!["/tmp/ccfzf".to_string()])
        );
    }

    /// Ни того, ни другого — отказ со словами. Молчание тут читалось бы как
    /// «местных сессий нет», а это другое утверждение.
    #[test]
    fn without_either_it_says_so() {
        let err = choose(false, None).unwrap_err();
        assert!(err.contains("ccfzf"), "текст обязан называть, чего не нашлось: {err}");
    }
}
