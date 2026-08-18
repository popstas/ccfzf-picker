//! Чем звать `ccfzf` на этой машине.

/// Копия агрегатора, вшитая в бинарь.
///
/// Файл, а не зависимость: `ccfzf` живёт своим репозиторием (подмодуль
/// `vendor/ccfzf`), и человеку, поставившему пикер рядом с обычным claude,
/// ставить его отдельно негде. Приём тот же, что у `TERMINAL_HELPER`: файл —
/// продолжение бинаря и расходиться с ним не должен, поэтому пишется он на
/// каждый спрос, а не однажды.
const VENDORED: &str = include_str!("../../vendor/ccfzf/ccfzf");

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
pub fn resolve() -> Result<(String, Vec<String>), String> {
    if on_path("ccfzf") {
        return choose(true, None);
    }
    let unpacked = unpack().ok();
    choose(false, unpacked.as_deref())
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
