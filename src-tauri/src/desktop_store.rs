//! Где Claude Desktop держит свои сессии и как найти в них нашу.
//!
//! У сессии два имени, и оба настоящие. `id` строки списка — имя транскрипта
//! (`~/.claude/projects/<проект>/<uuid>.jsonl`), а у приложения своё,
//! `local_<uuid>`, и второй uuid **другой**: связь между ними записана внутри
//! файла сессии полем `cliSessionId`.
//!
//! Знать это приходится потому, что маршрут `claude://resume` не открывает
//! сессию, а **импортирует** её — заводит в приложении новую поверх
//! транскрипта. Для сессии, которую приложение и завело, это даёт двойника:
//! рядом с `commits-desktop` появляется безымянная «General coding session» с
//! тем же разговором. Проверено живьём на маке: у одиннадцати записей из
//! двенадцати `sessionId` не выводится из `cliSessionId` вовсе, и ровно одна
//! двенадцатая — тот самый двойник, заведённый прежней версией этой ветки.
//!
//! Открывает уже заведённую сессию другой маршрут — `claude://cowork/<id>`, и
//! ему нужно имя приложения, а не наше.

use std::path::PathBuf;

/// Запись сессии приложения — ровно те два поля, которые нам нужны.
#[derive(Debug, Clone, PartialEq)]
pub struct DesktopSession {
    /// Имя сессии внутри приложения: `local_<uuid>`.
    pub id: String,
    /// Имя транскрипта, то же, что `id` строки списка.
    pub cli_id: String,
}

/// Заведена ли запись импортом.
///
/// Импорт называет сессию по транскрипту (`local_` плюс тот же uuid), а свою
/// собственную приложение называет новым uuid. Это единственный признак,
/// отличающий двойника от настоящей сессии, и он не догадка: у всех
/// одиннадцати живых записей на маке имена расходятся, у двойника — совпадают.
pub fn is_import(rec: &DesktopSession) -> bool {
    rec.id == format!("local_{}", rec.cli_id)
}

/// Какую из записей открывать.
///
/// Записей на один транскрипт бывает две — настоящая и двойник, оставшийся от
/// прежней версии, — и настоящая главнее: у неё имя, история и то, что человек
/// в ней делал. Двойник берётся, только когда другого нет: сам по себе он
/// открывается верно, а импортировать его заново значило бы плодить третьего.
///
/// `None` — записи нет вовсе: сессия терминальная и приложение её не видело.
/// Тогда `claude://resume` и есть верный ход, импорт для того и написан.
pub fn pick_session<'a>(records: &'a [DesktopSession], cli_id: &str) -> Option<&'a DesktopSession> {
    let mine: Vec<&DesktopSession> = records.iter().filter(|r| r.cli_id == cli_id).collect();
    mine.iter().copied().find(|r| !is_import(r)).or_else(|| mine.first().copied())
}

/// Ссылка, открывающая сессию в приложении.
///
/// Два маршрута, и разница между ними — вся суть этого модуля: `cowork`
/// открывает уже заведённую сессию, `resume` заводит новую поверх транскрипта.
pub fn session_url(cli_id: &str, found: Option<&DesktopSession>) -> String {
    match found {
        Some(rec) => format!("claude://cowork/{}", rec.id),
        None => format!("claude://resume?session={cli_id}"),
    }
}

/// Корень хранилища сессий приложения.
///
/// Развилка по системе, а не `cfg`: веток три, а собирается на машине
/// разработки одна — то же соображение, что и у `url_opener`. Внутри корня
/// приложение раскладывает файлы по учётной записи и организации
/// (`<account>/<org>/local_*.json`), и обе ступени нам знать незачем — обход
/// идёт вглубь на два уровня.
pub fn store_root() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    let base = if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support").join("Claude")
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("Claude")
    } else {
        home.join(".config").join("Claude")
    };
    Some(base.join("claude-code-sessions"))
}

/// Все записи сессий приложения, какие удалось прочитать.
///
/// Разбор терпимый, как у файла окон в агрегаторе: нет каталога — пусто, а не
/// отказ (приложение может быть не установлено вовсе); кривой файл
/// пропускается поодиночке. Отказ здесь дороже пропуска: он отменил бы
/// открытие сессии, тогда как пустой список всего лишь возвращает нас к
/// прежнему поведению — импорту.
pub fn read_store(root: &std::path::Path) -> Vec<DesktopSession> {
    let mut out = Vec::new();
    collect(root, 3, &mut out);
    out
}

fn collect(dir: &std::path::Path, depth: u32, out: &mut Vec<DesktopSession>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth > 0 {
                collect(&path, depth - 1, out);
            }
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("local_") || !name.ends_with(".json") {
            continue;
        }
        if let Some(rec) = parse_record(&std::fs::read_to_string(&path).unwrap_or_default()) {
            out.push(rec);
        }
    }
}

/// Запись из текста файла. Отдельной функцией — её единственную и есть чем
/// проверить, не заводя настоящего приложения.
pub fn parse_record(text: &str) -> Option<DesktopSession> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let id = value.get("sessionId")?.as_str()?.to_string();
    let cli_id = value.get("cliSessionId")?.as_str()?.to_string();
    if id.is_empty() || cli_id.is_empty() {
        return None;
    }
    Some(DesktopSession { id, cli_id })
}

#[cfg(test)]
mod tests {
    use super::{is_import, parse_record, pick_session, read_store, session_url, DesktopSession};

    fn rec(id: &str, cli: &str) -> DesktopSession {
        DesktopSession { id: id.to_string(), cli_id: cli.to_string() }
    }

    /// Своя сессия приложения названа своим uuid, импорт — именем транскрипта.
    #[test]
    fn an_import_is_named_after_the_transcript() {
        assert!(is_import(&rec("local_aaa", "aaa")));
        assert!(!is_import(&rec("local_bbb", "aaa")));
    }

    /// Настоящая сессия главнее двойника: у неё имя, история и работа
    /// человека. Двойник открывается верно и сам по себе, но выбирать его при
    /// живой настоящей значило бы показывать пустой разговор вместо работы.
    #[test]
    fn the_apps_own_session_wins_over_an_import() {
        let all = vec![rec("local_dup", "dup"), rec("local_real", "dup")];
        assert_eq!(pick_session(&all, "dup").unwrap().id, "local_real");
    }

    /// Двойник берётся, когда другого нет: импортировать его заново значило бы
    /// завести третьего.
    #[test]
    fn an_import_alone_is_still_opened() {
        let all = vec![rec("local_dup", "dup")];
        assert_eq!(pick_session(&all, "dup").unwrap().id, "local_dup");
    }

    /// Записи нет вовсе — сессия терминальная, приложение её не видело.
    #[test]
    fn a_session_the_app_never_saw_has_no_record() {
        assert!(pick_session(&[rec("local_x", "x")], "y").is_none());
    }

    /// Два маршрута, и разница между ними — вся суть модуля: `cowork`
    /// открывает заведённую сессию, `resume` заводит новую поверх транскрипта.
    #[test]
    fn a_known_session_is_opened_and_an_unknown_one_is_imported() {
        let found = rec("local_real", "dup");
        assert_eq!(session_url("dup", Some(&found)), "claude://cowork/local_real");
        assert_eq!(session_url("dup", None), "claude://resume?session=dup");
    }

    /// Разбор берёт два поля и терпит всё остальное: полей в записи два
    /// десятка, и знать их нам незачем.
    #[test]
    fn a_record_needs_both_names_and_nothing_else() {
        let text = r#"{"sessionId":"local_a","cliSessionId":"b","title":"x","model":"y"}"#;
        assert_eq!(parse_record(text), Some(rec("local_a", "b")));
        assert_eq!(parse_record(r#"{"sessionId":"local_a"}"#), None);
        assert_eq!(parse_record("{не json"), None);
        assert_eq!(parse_record(r#"{"sessionId":"","cliSessionId":"b"}"#), None);
    }

    /// Каталога нет — пусто, а не отказ: приложение может быть не установлено
    /// вовсе, и отказ здесь отменил бы открытие сессии.
    #[test]
    fn a_missing_store_reads_as_no_sessions() {
        assert!(read_store(std::path::Path::new("/nonexistent-claude-store")).is_empty());
    }

    /// Файлы лежат в двух вложенных каталогах (учётная запись и организация),
    /// и обход обязан до них добраться. Кривой файл и чужое имя пропускаются
    /// поодиночке — как у разбора файла окон в агрегаторе.
    #[test]
    fn the_store_is_read_two_levels_down() {
        let root = std::env::temp_dir().join(format!("ccfzf-desktop-store-{}", std::process::id()));
        let dir = root.join("account").join("org");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("local_a.json"), r#"{"sessionId":"local_a","cliSessionId":"t1"}"#).unwrap();
        std::fs::write(dir.join("local_bad.json"), "{не json").unwrap();
        std::fs::write(dir.join("scheduled-tasks.json"), r#"{"sessionId":"x","cliSessionId":"y"}"#).unwrap();
        let got = read_store(&root);
        std::fs::remove_dir_all(&root).ok();
        assert_eq!(got, vec![rec("local_a", "t1")]);
    }
}
