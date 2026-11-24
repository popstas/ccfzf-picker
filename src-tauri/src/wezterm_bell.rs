//! Звук звонка WezTerm: выключатель для кнопки в статуслайне.
//!
//! Звонок WezTerm на Windows — свой обработчик `wezterm.on('bell', …)` в
//! `~/.wezterm.lua` (живёт в windows11-manager, `wezterm/wezterm.lua`): на BEL он
//! запускает скрытый powershell с `Media.SoundPlayer`. Пикер с этим процессом
//! не разговаривает вовсе — ни транспорта, ни перезагрузки конфига: обработчик
//! первой строкой проверяет флаг-файл `~/.wezterm-bell-off` и молчит, пока тот
//! есть. Имя файла — контракт двух репозиториев, и меняется оно в обоих сразу.
//!
//! Нет файла — звук есть. Так умолчание остаётся тем, что было до кнопки, и
//! WezTerm, поставленный без пикера, звонит как звонил.
//!
//! Состояние не держится в памяти: его единственный источник — сам файл, и
//! человек может снять его руками. Поэтому и чтение, и запись отвечают тем, что
//! лежит на диске после операции, а не тем, о чём просили.

use std::path::{Path, PathBuf};

/// Имя флага в домашнем каталоге. То же имя читает `wezterm.lua`.
pub const FLAG_NAME: &str = ".wezterm-bell-off";

/// Что лежит в файле: только объяснение для того, кто найдёт его в профиле.
/// Обработчик смотрит на само существование файла, содержимое ему не важно.
const FLAG_TEXT: &str = "WezTerm bell is muted by ccfzf-picker. Delete this file to turn the sound back on.\n";

/// Звук сейчас выключен? Ровно «файл существует».
pub fn muted_in(dir: &Path) -> bool {
    dir.join(FLAG_NAME).is_file()
}

/// Поставить состояние и вернуть то, что вышло на диске.
///
/// Снять уже снятый флаг — не ошибка: две кнопки двух окон пикера (или кнопка
/// и человек с проводником) не должны спорить, кто убрал файл первым.
pub fn set_muted_in(dir: &Path, muted: bool) -> Result<bool, String> {
    let path = dir.join(FLAG_NAME);
    if muted {
        std::fs::write(&path, FLAG_TEXT).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    } else {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("cannot remove {}: {e}", path.display())),
        }
    }
    Ok(muted_in(dir))
}

/// Каталог флага — тот, который WezTerm называет `wezterm.home_dir`.
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

/// Состояние для кнопки: `None` — выключателя на этой машине нет, кнопка
/// прячется; `Some(true)` — звук выключен.
#[tauri::command]
pub fn wezterm_bell() -> Option<bool> {
    flag_dir().map(|dir| muted_in(&dir))
}

/// Поставить состояние. Ответ — перечитанное с диска, им и красится кнопка.
#[tauri::command]
pub fn set_wezterm_bell(muted: bool) -> Result<Option<bool>, String> {
    match flag_dir() {
        Some(dir) => set_muted_in(&dir, muted).map(Some),
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

    #[test]
    fn no_flag_means_sound_on() {
        let dir = tmp("default");
        assert!(!muted_in(&dir), "без флага звук обязан играть — это умолчание до кнопки");
    }

    #[test]
    fn mute_writes_flag_unmute_removes_it() {
        let dir = tmp("toggle");
        assert_eq!(set_muted_in(&dir, true), Ok(true));
        assert!(dir.join(FLAG_NAME).is_file(), "файл, который ищет wezterm.lua, не появился");
        assert_eq!(set_muted_in(&dir, false), Ok(false));
        assert!(!dir.join(FLAG_NAME).exists(), "файл остался — звук не вернётся");
    }

    #[test]
    fn repeating_either_side_is_not_an_error() {
        let dir = tmp("repeat");
        assert_eq!(set_muted_in(&dir, false), Ok(false), "снять несуществующий флаг — не ошибка");
        assert_eq!(set_muted_in(&dir, true), Ok(true));
        assert_eq!(set_muted_in(&dir, true), Ok(true), "второе выключение — не ошибка");
    }

    #[test]
    fn state_is_read_from_disk_not_memory() {
        // Человек снял файл руками: следующий вопрос обязан это увидеть.
        let dir = tmp("manual");
        set_muted_in(&dir, true).unwrap();
        std::fs::remove_file(dir.join(FLAG_NAME)).unwrap();
        assert!(!muted_in(&dir));
    }

    #[test]
    fn flag_name_matches_wezterm_lua() {
        // Контракт двух репозиториев: wezterm.lua в windows11-manager ищет
        // ровно это имя в wezterm.home_dir.
        assert_eq!(FLAG_NAME, ".wezterm-bell-off");
    }
}
