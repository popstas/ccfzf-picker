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

/// Метки heredoc, которыми bash отделяет python-программу от обёртки.
const PY_BEGIN: &str = "<<'PYEOF'";
const PY_END: &str = "\nPYEOF";

/// Python-программа, вырезанная из вшитой копии.
///
/// На Windows bash-обёртку исполнить нечем: единственный `bash` там — пускач
/// WSL, у которого свой `$HOME` и свой `~/.claude`. Зато сама программа —
/// обычный python, и запустить её можно напрямую.
///
/// Метки те же, по которым блок читает и сам bash, и `tests/harness.py` в
/// репозитории агрегатора. Открывающая ищется без перевода строки, а хвост её
/// строки отбрасывается отдельно: в скрипте она записана как
/// `read -r -d '' PY <<'PYEOF' || true`.
pub fn python_block(vendored: &str) -> Result<&str, String> {
    let (_, rest) = vendored
        .split_once(PY_BEGIN)
        .ok_or_else(|| "vendored ccfzf has no PYEOF marker".to_string())?;
    let (_, body) = rest
        .split_once('\n')
        .ok_or_else(|| "vendored ccfzf ends at its PYEOF marker".to_string())?;
    body.split_once(PY_END)
        .map(|(block, _)| block)
        .ok_or_else(|| "vendored ccfzf has no closing PYEOF marker".to_string())
}

/// Программа и её аргументы на Windows: интерпретатор и путь к вырезанному
/// блоку. Отдельной функцией, а не веткой внутри `choose`: ту проверяют на
/// Linux, и обе формы должны быть видны тестам одинаково.
pub fn choose_python(py_path: &str, interpreter: &str) -> (String, Vec<String>) {
    (interpreter.to_string(), vec![py_path.to_string()])
}

/// Есть ли программа в PATH. Своим перебором, а не крейтом `which`: дерево
/// зависимостей у пикера и так 323 крейта, а вопрос здесь на десять строк.
///
/// `is_file()` одного мало: неисполняемый `ccfzf`, случайно оказавшийся
/// раньше в PATH, побеждал бы вшитую копию — работающую — и спотыкался на
/// `Permission denied` при запуске, а причина отказа выглядела бы вообще
/// не связанной с PATH. Бит `x` проверяется только на unix — на других
/// системах, куда PATH ещё доедет, разбор бита не наш вопрос.
pub fn on_path(name: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| is_executable(&dir.join(name)))
}

fn is_executable(candidate: &std::path::Path) -> bool {
    if !candidate.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return std::fs::metadata(candidate)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }
    #[cfg(not(unix))]
    {
        true
    }
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
    // Вторым файлом — сама python-программа: на Windows обёртку исполнить
    // нечем. Пишется и там, где не нужна: разница в один `fs::write` раз за
    // запуск процесса, а ветка `cfg` здесь стоила бы непроверяемого кода.
    let py = crate::state_path("ccfzf.py")?;
    std::fs::write(&py, python_block(VENDORED)?)
        .map_err(|e| format!("cannot write {}: {e}", py.display()))?;
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
    if cfg!(target_os = "windows") {
        // Ветка PATH пропускается: `ccfzf`, найденный там, — тот же bash-скрипт.
        let interpreter = ["python", "python3"]
            .into_iter()
            .find(|name| on_path(name))
            .ok_or_else(|| "neither python nor python3 is on PATH".to_string())?;
        UNPACKED.get_or_init(unpack).as_ref().map_err(|e| e.clone())?;
        let py = crate::state_path("ccfzf.py")?;
        return Ok(choose_python(&py.to_string_lossy(), interpreter));
    }
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
    /// Блок вырезается по тем же меткам, по которым его читает и bash, и
    /// tests/harness.py в репозитории агрегатора. Третьего разбора заводить
    /// нельзя — он разошёлся бы молча, а отказ читался бы как
    /// «python: can't open file».
    #[test]
    fn python_block_is_cut_by_the_shell_heredoc_markers() {
        let vendored = "#!/usr/bin/env bash\nread -r -d '' PY <<'PYEOF' || true\nimport os\nPYEOF\necho done\n";
        assert_eq!(super::python_block(vendored).unwrap(), "import os");
    }

    #[test]
    fn a_copy_without_markers_is_a_named_failure() {
        assert!(super::python_block("#!/usr/bin/env bash\necho hi\n").is_err());
    }

    /// Настоящая вшитая копия обязана резаться — иначе местный источник на
    /// Windows молчал бы, а поймать это можно только здесь: на машине
    /// разработки эта ветка не исполняется.
    #[test]
    fn the_vendored_copy_still_carries_the_markers() {
        let block = super::python_block(super::VENDORED).expect("маркеры PYEOF");
        assert!(block.contains("def registry_records("), "блок вырезан не тот");
    }

    #[test]
    fn on_windows_the_block_runs_through_python() {
        assert_eq!(
            super::choose_python("/x/ccfzf.py", "python"),
            ("python".to_string(), vec!["/x/ccfzf.py".to_string()]),
        );
    }

    #[cfg(unix)]
    use super::is_executable;

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

    /// Свой файл на каждый тест в общем временном каталоге: параллельные
    /// прогоны не должны видеть чужие права.
    #[cfg(unix)]
    fn temp_file(tag: &str) -> std::path::PathBuf {
        static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!("ccfzf-picker-test-on-path-{}-{tag}-{n}", std::process::id()))
    }

    /// Файл есть, но бита `x` нет — `on_path` был бы обманут: программа
    /// в PATH нашлась бы, а запуск падал `Permission denied`, при том что
    /// рабочая вшитая копия рядом молчала бы неиспользованной.
    #[cfg(unix)]
    #[test]
    fn a_non_executable_file_does_not_count() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_file("no-x");
        std::fs::write(&path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!is_executable(&path));
        std::fs::remove_file(&path).ok();
    }

    /// Файл с битом `x` — засчитывается.
    #[cfg(unix)]
    #[test]
    fn an_executable_file_counts() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_file("x");
        std::fs::write(&path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(is_executable(&path));
        std::fs::remove_file(&path).ok();
    }

    /// Несуществующий путь — не панацея и не паника, просто «нет».
    #[cfg(unix)]
    #[test]
    fn a_missing_file_is_not_executable() {
        assert!(!is_executable(&temp_file("missing")));
    }
}
