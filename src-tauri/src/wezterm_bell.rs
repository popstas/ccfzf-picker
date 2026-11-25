//! Звук звонка WezTerm: режим для кнопки в статуслайне.
//!
//! Звонок WezTerm на Windows — свой обработчик `wezterm.on('bell', …)` в
//! `~/.wezterm.lua` (живёт в windows11-manager, `wezterm/wezterm.lua`): на BEL он
//! запускает скрытый powershell с `Media.SoundPlayer`. Пикер с этим процессом
//! не разговаривает вовсе — ни транспорта, ни перезагрузки конфига: обработчик
//! на каждый звонок смотрит на два флаг-файла в профиле и решает по ним.
//!
//! Режимов три, файлов два, и читаются они по старшинству:
//!
//! - `~/.wezterm-bell-off` есть → `off`, не звенит никто (как до режимов: старые
//!   установки с этим файлом не ломаются);
//! - иначе `~/.wezterm-bell-children-off` есть → `noChildren`, звенят все, кроме
//!   дочерних сессий (их список пишет windows11-manager, не пикер);
//! - иначе → `all`.
//!
//! Имена файлов — контракт двух репозиториев, и меняются они в обоих сразу.
//!
//! Нет файлов — звук есть. Так умолчание остаётся тем, что было до кнопки, и
//! WezTerm, поставленный без пикера, звонит как звонил. Тот же выбор и на
//! ошибке: файл, который не прочитался, флагом не считается (fail-open) —
//! лишний звонок дешевле замолчавшей обычной сессии.
//!
//! Состояние не держится в памяти: его единственный источник — сами файлы, и
//! человек может снять их руками. Поэтому и чтение, и запись отвечают тем, что
//! лежит на диске после операции, а не тем, о чём просили.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Имя флага «не звенит никто». То же имя читает `wezterm.lua`.
pub const FLAG_NAME: &str = ".wezterm-bell-off";

/// Имя флага «не звенят дочерние». То же имя читает `wezterm.lua`.
pub const CHILDREN_FLAG_NAME: &str = ".wezterm-bell-children-off";

/// Что лежит в файлах: только объяснение для того, кто найдёт их в профиле.
/// Обработчик смотрит на само существование файла, содержимое ему не важно.
const FLAG_TEXT: &str = "WezTerm bell is muted by ccfzf-picker. Delete this file to turn the sound back on.\n";
const CHILDREN_FLAG_TEXT: &str =
    "WezTerm bell is muted for child sessions by ccfzf-picker. Delete this file to hear them again.\n";

/// Режим звонка. Слова — те же, что приходят странице (`"all"`,
/// `"noChildren"`, `"off"`), и других она не знает.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BellMode {
    All,
    NoChildren,
    Off,
}

/// Режим по файлам на диске. `is_file` на любой ошибке отвечает `false` —
/// отсюда fail-open без отдельной ветки.
pub fn mode_in(dir: &Path) -> BellMode {
    if dir.join(FLAG_NAME).is_file() {
        BellMode::Off
    } else if dir.join(CHILDREN_FLAG_NAME).is_file() {
        BellMode::NoChildren
    } else {
        BellMode::All
    }
}

fn put(path: &Path, text: &str) -> Result<(), String> {
    std::fs::write(path, text).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// Снять уже снятый флаг — не ошибка: две кнопки двух окон пикера (или кнопка
/// и человек с проводником) не должны спорить, кто убрал файл первым.
fn drop_flag(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("cannot remove {}: {e}", path.display())),
    }
}

/// Поставить режим и вернуть то, что вышло на диске.
///
/// На диске после этого ровно одно состояние: `all` — нет обоих файлов,
/// `noChildren` — только второй, `off` — только первый. Порядок шагов выбран
/// так, чтобы промежуточное состояние было тише конечного, а не громче: сначала
/// кладётся новый флаг, потом снимается прежний — звонок посреди переключения
/// не прорвётся туда, где его просили убрать.
pub fn set_mode_in(dir: &Path, mode: BellMode) -> Result<BellMode, String> {
    let off = dir.join(FLAG_NAME);
    let children = dir.join(CHILDREN_FLAG_NAME);
    match mode {
        BellMode::Off => {
            put(&off, FLAG_TEXT)?;
            drop_flag(&children)?;
        }
        BellMode::NoChildren => {
            put(&children, CHILDREN_FLAG_TEXT)?;
            drop_flag(&off)?;
        }
        BellMode::All => {
            drop_flag(&children)?;
            drop_flag(&off)?;
        }
    }
    Ok(mode_in(dir))
}

/// Каталог флагов — тот, который WezTerm называет `wezterm.home_dir`.
///
/// На Windows это профиль (`USERPROFILE`), а не `home_dir()` из `main.rs`: тот
/// сначала берёт `HOME`, и при выставленном `HOME` (Git Bash, MSYS) пикер писал
/// бы флаг не туда, где его ищет Lua, — кнопка горела бы, звук играл.
///
/// Вне Windows — `None`: звонок своим звуком заведён только там
/// (`powershell … SoundPlayer`), и на маке кнопка выключала бы то, чего нет.
fn flag_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    } else {
        None
    }
}

/// Режим для кнопки: `None` — выключателя на этой машине нет, кнопка прячется.
#[tauri::command]
pub fn wezterm_bell() -> Option<BellMode> {
    flag_dir().map(|dir| mode_in(&dir))
}

/// Поставить режим. Ответ — перечитанное с диска, им и красится кнопка.
/// Неизвестное слово до сюда не доходит: его отвергает разбор аргумента, и
/// диск остаётся нетронутым.
#[tauri::command]
pub fn set_wezterm_bell(mode: BellMode) -> Result<Option<BellMode>, String> {
    match flag_dir() {
        Some(dir) => set_mode_in(&dir, mode).map(Some),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccfzf-bell-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Какие из двух файлов лежат на диске: (первый, второй).
    fn flags(dir: &Path) -> (bool, bool) {
        (dir.join(FLAG_NAME).exists(), dir.join(CHILDREN_FLAG_NAME).exists())
    }

    #[test]
    fn no_flag_means_sound_on() {
        let dir = tmp("default");
        assert_eq!(mode_in(&dir), BellMode::All, "без флагов звенят все — это умолчание до кнопки");
    }

    #[test]
    fn off_flag_wins_over_children_flag() {
        // Старшинство: первый файл значит «никто» даже при лежащем втором —
        // так старая установка с одним `.wezterm-bell-off` читается как раньше.
        let dir = tmp("both");
        std::fs::write(dir.join(FLAG_NAME), "").unwrap();
        std::fs::write(dir.join(CHILDREN_FLAG_NAME), "").unwrap();
        assert_eq!(mode_in(&dir), BellMode::Off);
        std::fs::remove_file(dir.join(FLAG_NAME)).unwrap();
        assert_eq!(mode_in(&dir), BellMode::NoChildren);
    }

    #[test]
    fn each_mode_leaves_exactly_one_state_on_disk() {
        let dir = tmp("exact");
        // Начинаем с худшего — оба файла, — чтобы каждый режим сам убирал лишнее.
        for mode in [BellMode::Off, BellMode::NoChildren, BellMode::All] {
            std::fs::write(dir.join(FLAG_NAME), "").unwrap();
            std::fs::write(dir.join(CHILDREN_FLAG_NAME), "").unwrap();
            assert_eq!(set_mode_in(&dir, mode), Ok(mode));
            let want = match mode {
                BellMode::Off => (true, false),
                BellMode::NoChildren => (false, true),
                BellMode::All => (false, false),
            };
            assert_eq!(flags(&dir), want, "после {mode:?} на диске не то состояние");
        }
    }

    #[test]
    fn full_cycle_round_trip() {
        // Ровно тот круг, которым идёт кнопка: all → noChildren → off → all.
        let dir = tmp("cycle");
        for mode in [BellMode::NoChildren, BellMode::Off, BellMode::All] {
            assert_eq!(set_mode_in(&dir, mode), Ok(mode));
            assert_eq!(mode_in(&dir), mode, "чтение после {mode:?} разошлось с записью");
        }
        assert_eq!(flags(&dir), (false, false), "после круга остался файл — звук не вернётся");
    }

    #[test]
    fn repeating_any_mode_is_not_an_error() {
        let dir = tmp("repeat");
        for mode in [BellMode::All, BellMode::NoChildren, BellMode::Off] {
            assert_eq!(set_mode_in(&dir, mode), Ok(mode), "первая установка {mode:?}");
            assert_eq!(set_mode_in(&dir, mode), Ok(mode), "повтор {mode:?} — не ошибка");
        }
    }

    #[test]
    fn state_is_read_from_disk_not_memory() {
        // Человек снял файл руками: следующий вопрос обязан это увидеть.
        let dir = tmp("manual");
        set_mode_in(&dir, BellMode::Off).unwrap();
        std::fs::remove_file(dir.join(FLAG_NAME)).unwrap();
        assert_eq!(mode_in(&dir), BellMode::All);
        set_mode_in(&dir, BellMode::NoChildren).unwrap();
        std::fs::remove_file(dir.join(CHILDREN_FLAG_NAME)).unwrap();
        assert_eq!(mode_in(&dir), BellMode::All);
    }

    #[test]
    fn unreadable_flag_dir_means_all() {
        // Fail-open: каталога нет вовсе — звенят все, а не молчат.
        let dir = std::env::temp_dir().join(format!("ccfzf-bell-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(mode_in(&dir), BellMode::All);
    }

    #[test]
    fn mode_words_match_the_page() {
        // Слова, которые шлёт и ждёт sessions.html (`bellModeOf`, `nextBellMode`).
        for (mode, word) in [
            (BellMode::All, "\"all\""),
            (BellMode::NoChildren, "\"noChildren\""),
            (BellMode::Off, "\"off\""),
        ] {
            assert_eq!(serde_json::to_string(&mode).unwrap(), word);
            assert_eq!(serde_json::from_str::<BellMode>(word).unwrap(), mode);
        }
        assert!(
            serde_json::from_str::<BellMode>("\"on\"").is_err(),
            "неизвестное слово обязано отвергаться разбором, а не становиться режимом"
        );
    }

    #[test]
    fn flag_name_matches_wezterm_lua() {
        // Контракт двух репозиториев: wezterm.lua в windows11-manager ищет
        // ровно это имя в wezterm.home_dir.
        assert_eq!(FLAG_NAME, ".wezterm-bell-off");
    }

    #[test]
    fn children_flag_name_matches_wezterm_lua() {
        // Тот же контракт для второго флага: wezterm.lua молчит о дочерних,
        // пока лежит файл ровно с этим именем.
        assert_eq!(CHILDREN_FLAG_NAME, ".wezterm-bell-children-off");
    }
}
