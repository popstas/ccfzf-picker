//! Какой редактор открывает папку сессии, спеку и план.
//!
//! Ключ `editor` в config.yaml знает три вида значений. Пусто (и умолчание) —
//! «найди сам»: первый установленный из `KNOWN` по порядку. Имя из `KNOWN`
//! (`zed`, `vscode`, `cursor`) — этот редактор, а где он лежит, ищет тот же
//! детект. Всё прочее — «other»: имя приложения или путь, и зовётся оно как
//! прежде, без поиска.
//!
//! Поиск идёт по файлам, а не по PATH одним только: на маке CLI редактора
//! может не быть вовсе (`which cursor` пуст, а Cursor.app на месте —
//! проверено 2026-08-18), а на Windows в PATH лежат `code.cmd` и `cursor.cmd`,
//! которые без `cmd /c` не запускаются, а через него мелькнуло бы окно
//! консоли. Поэтому на Windows ищется сам `.exe` по известным местам установки.

use std::path::{Path, PathBuf};

/// Система, под которую ищем. Параметром, а не `cfg!`: тогда пути всех трёх
/// систем проверяются тестами на любой машине.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Os {
    Mac,
    Windows,
    Other,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(target_os = "windows") {
            Os::Windows
        } else {
            Os::Other
        }
    }
}

/// Редактор, которого пикер знает по имени.
pub struct Known {
    pub id: &'static str,
    pub label: &'static str,
    /// Пакет приложения на маке, без каталога.
    mac_app: &'static str,
    /// Пути внутри `%LOCALAPPDATA%\Programs` и `%ProgramFiles%` — у
    /// установщиков «для себя» и «для всех» каталог один и тот же.
    win_exe: &'static str,
    /// Имена программ в PATH на Linux.
    unix_bins: &'static [&'static str],
}

/// Порядок — это и есть приоритет автовыбора. Тот же список (id в том же
/// порядке) держит `EDITORS` в settings-form.js; сверяет их тест там.
pub const KNOWN: [Known; 3] = [
    Known {
        id: "zed",
        label: "Zed",
        mac_app: "Zed.app",
        win_exe: r"Zed\Zed.exe",
        // `zeditor` — имя, под которым Zed ставят часть дистрибутивов.
        unix_bins: &["zed", "zeditor"],
    },
    Known {
        id: "vscode",
        label: "VS Code",
        mac_app: "Visual Studio Code.app",
        win_exe: r"Microsoft VS Code\Code.exe",
        unix_bins: &["code"],
    },
    Known {
        id: "cursor",
        label: "Cursor",
        mac_app: "Cursor.app",
        win_exe: r"cursor\Cursor.exe",
        unix_bins: &["cursor"],
    },
];

/// Откуда искать: переменные окружения, снятые один раз.
pub struct Env {
    pub os: Os,
    pub home: Option<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    pub program_files: Option<PathBuf>,
    pub path: Vec<PathBuf>,
}

impl Env {
    pub fn current() -> Env {
        let var = |name: &str| std::env::var_os(name).map(PathBuf::from);
        Env {
            os: Os::current(),
            home: var("HOME").or_else(|| var("USERPROFILE")),
            local_app_data: var("LOCALAPPDATA"),
            program_files: var("ProgramFiles"),
            path: std::env::var_os("PATH")
                .map(|p| std::env::split_paths(&p).collect())
                .unwrap_or_default(),
        }
    }
}

/// Чем открывать: argv без последнего аргумента (пути) и подпись для меню.
#[derive(Debug, PartialEq)]
pub struct Resolved {
    pub label: String,
    pub argv: Vec<String>,
    /// Файл, с которого брать иконку пункта меню. Есть только у найденного
    /// `.exe`: иконки приложений пикер умеет доставать лишь на Windows.
    pub icon: Option<String>,
}

fn known(setting: &str) -> Option<&'static Known> {
    let s = setting.trim().to_lowercase();
    // `code` — имя CLI у VS Code, и вписать его руками естественнее всего.
    let s = if s == "code" { "vscode".to_string() } else { s };
    KNOWN.iter().find(|k| k.id == s)
}

fn candidates(k: &Known, env: &Env) -> Vec<PathBuf> {
    match env.os {
        Os::Mac => {
            let mut out = vec![Path::new("/Applications").join(k.mac_app)];
            if let Some(home) = &env.home {
                out.push(home.join("Applications").join(k.mac_app));
            }
            out
        }
        Os::Windows => {
            // Строкой, а не `Path::join`: тесты идут и на Linux, где `\` не
            // разделитель, а склеивать надо по-windows-ски.
            let under = |root: &Path, rel: &str| {
                PathBuf::from(format!("{}\\{}", root.display().to_string().trim_end_matches('\\'), rel))
            };
            let mut out = Vec::new();
            if let Some(local) = &env.local_app_data {
                out.push(under(local, &format!(r"Programs\{}", k.win_exe)));
            }
            if let Some(pf) = &env.program_files {
                out.push(under(pf, k.win_exe));
            }
            out
        }
        Os::Other => env
            .path
            .iter()
            .flat_map(|dir| k.unix_bins.iter().map(move |bin| dir.join(bin)))
            .collect(),
    }
}

fn found(k: &Known, env: &Env, exists: &dyn Fn(&Path) -> bool) -> Option<Resolved> {
    let file = candidates(k, env).into_iter().find(|p| exists(p))?;
    let file = file.display().to_string();
    Some(match env.os {
        Os::Mac => Resolved {
            label: k.label.to_string(),
            argv: vec!["open".into(), "-a".into(), file],
            icon: None,
        },
        Os::Windows => Resolved {
            label: k.label.to_string(),
            argv: vec![file.clone()],
            icon: Some(file),
        },
        Os::Other => Resolved {
            label: k.label.to_string(),
            argv: vec![file],
            icon: None,
        },
    })
}

/// «Other»: то, что человек вписал сам, зовётся как прежде. На маке голое
/// имя уходит в `open -a` — CLI редактора там может не быть вовсе; имя с
/// разделителем каталогов — путь, и его зовут напрямую.
fn named(setting: &str, os: Os) -> Resolved {
    let setting = setting.trim();
    let stem = setting
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(setting);
    let label = stem
        .strip_suffix(".exe")
        .or_else(|| stem.strip_suffix(".app"))
        .unwrap_or(stem)
        .to_string();
    let argv = if os == Os::Mac && !setting.contains('/') {
        vec!["open".into(), "-a".into(), setting.to_string()]
    } else {
        vec![setting.to_string()]
    };
    Resolved { label, argv, icon: None }
}

/// Чем открывать при этой настройке. `None` — только у автовыбора, когда не
/// нашлось ни одного из `KNOWN`.
///
/// Названный, но не найденный редактор не отказ, а прежняя дорога «other»:
/// `editor: cursor` до этой правки звал `cursor` по имени, и там, где детект
/// не знает места установки, это по-прежнему работает.
pub fn resolve(setting: &str, env: &Env, exists: &dyn Fn(&Path) -> bool) -> Option<Resolved> {
    if setting.trim().is_empty() {
        return KNOWN.iter().find_map(|k| found(k, env, exists));
    }
    if let Some(k) = known(setting) {
        // Подпись — своя, а не имя из настройки: «Open in Cursor», а не
        // «Open in cursor».
        return Some(found(k, env, exists).unwrap_or_else(|| Resolved {
            label: k.label.to_string(),
            ..named(k.id, env.os)
        }));
    }
    Some(named(setting, env.os))
}

/// То же на этой машине.
pub fn resolve_here(setting: &str) -> Option<Resolved> {
    resolve(setting, &Env::current(), &|p| p.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(os: Os) -> Env {
        Env {
            os,
            home: Some(PathBuf::from("/Users/user")),
            local_app_data: Some(PathBuf::from(r"X:\Users\user\AppData\Local")),
            program_files: Some(PathBuf::from(r"X:\Program Files")),
            path: vec![PathBuf::from("/usr/bin"), PathBuf::from("/home/user/.local/bin")],
        }
    }

    fn only(installed: &'static [&'static str]) -> impl Fn(&Path) -> bool {
        move |p: &Path| installed.contains(&p.display().to_string().as_str())
    }

    #[test]
    fn avtovybor_beryot_zed_ranshe_vscode_i_cursor() {
        let all = only(&[
            r"X:\Users\user\AppData\Local\Programs\Zed\Zed.exe",
            r"X:\Program Files\Microsoft VS Code\Code.exe",
            r"X:\Program Files\cursor\Cursor.exe",
        ]);
        let got = resolve("", &env(Os::Windows), &all).unwrap();
        assert_eq!(got.label, "Zed");
        assert_eq!(got.argv, vec![r"X:\Users\user\AppData\Local\Programs\Zed\Zed.exe"]);
        assert_eq!(got.icon.as_deref(), Some(r"X:\Users\user\AppData\Local\Programs\Zed\Zed.exe"));
    }

    #[test]
    fn avtovybor_idyot_po_spisku_dalshe_esli_pervogo_net() {
        let some = only(&[
            r"X:\Program Files\cursor\Cursor.exe",
            r"X:\Users\user\AppData\Local\Programs\Microsoft VS Code\Code.exe",
        ]);
        let got = resolve("", &env(Os::Windows), &some).unwrap();
        assert_eq!(got.label, "VS Code");
        let cursor = only(&[r"X:\Users\user\AppData\Local\Programs\cursor\Cursor.exe"]);
        assert_eq!(resolve(" ", &env(Os::Windows), &cursor).unwrap().label, "Cursor");
    }

    #[test]
    fn avtovybor_bez_redaktorov_otvechaet_none() {
        // Не «cursor наугад»: пункт меню звал бы программу, которой нет, и
        // отказ пришёл бы невнятным «failed to spawn».
        assert_eq!(resolve("", &env(Os::Windows), &|_| false), None);
        assert_eq!(resolve("", &env(Os::Mac), &|_| false), None);
    }

    #[test]
    fn na_make_naydennoe_prilozhenie_idyot_v_open_a_polnym_putyom() {
        let got = resolve("", &env(Os::Mac), &only(&["/Users/user/Applications/Visual Studio Code.app"])).unwrap();
        assert_eq!(got.label, "VS Code");
        assert_eq!(got.argv, vec!["open", "-a", "/Users/user/Applications/Visual Studio Code.app"]);
        assert_eq!(got.icon, None);
    }

    #[test]
    fn na_linux_ishchetsya_v_path() {
        let got = resolve("", &env(Os::Other), &only(&["/home/user/.local/bin/zeditor"])).unwrap();
        assert_eq!(got.label, "Zed");
        assert_eq!(got.argv, vec!["/home/user/.local/bin/zeditor"]);
    }

    #[test]
    fn nazvannyy_redaktor_beretsya_dazhe_esli_vperedi_drugoy() {
        let all = only(&["/Applications/Zed.app", "/Applications/Cursor.app"]);
        let got = resolve("Cursor", &env(Os::Mac), &all).unwrap();
        assert_eq!(got.argv, vec!["open", "-a", "/Applications/Cursor.app"]);
        // `code` — имя CLI у VS Code.
        let code = only(&["/Applications/Visual Studio Code.app"]);
        assert_eq!(resolve("code", &env(Os::Mac), &code).unwrap().label, "VS Code");
    }

    #[test]
    fn nazvannyy_no_ne_naydennyy_zovetsya_po_imeni_kak_prezhde() {
        let got = resolve("cursor", &env(Os::Mac), &|_| false).unwrap();
        assert_eq!(got.argv, vec!["open", "-a", "cursor"]);
        let got = resolve("cursor", &env(Os::Windows), &|_| false).unwrap();
        assert_eq!(got.argv, vec!["cursor"]);
        assert_eq!(got.label, "Cursor");
    }

    #[test]
    fn svoy_variant_zovetsya_kak_vpisan() {
        // Живая проверка на маке (2026-08-18): `open -a` находит приложение
        // по имени, прямой запуск голого имени там падал.
        let got = resolve("Sublime Text", &env(Os::Mac), &|_| false).unwrap();
        assert_eq!(got.argv, vec!["open", "-a", "Sublime Text"]);
        assert_eq!(got.label, "Sublime Text");
        // Разделитель каталогов значит, что назван файл, а не приложение.
        let got = resolve("/usr/local/bin/subl", &env(Os::Mac), &|_| false).unwrap();
        assert_eq!(got.argv, vec!["/usr/local/bin/subl"]);
        assert_eq!(got.label, "subl");
        let got = resolve(r"X:\Tools\notepad++.exe", &env(Os::Windows), &|_| false).unwrap();
        assert_eq!(got.argv, vec![r"X:\Tools\notepad++.exe"]);
        assert_eq!(got.label, "notepad++");
    }
}
