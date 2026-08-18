use crate::proc::hidden_command;
use std::io::Write;
use std::process::Stdio;

/// Метка местного источника — она же значение поля `source` у его строк.
///
/// `sshHost`, буквально равный `local`, зарезервирован: обратный разбор
/// (`from_label`) принял бы его за местный источник и пошёл бы не по ssh.
/// Случай выдуманный, а вторая дорога различать их стоила бы поля рядом с
/// меткой в каждой строке ответа.
pub const LOCAL_LABEL: &str = "local";

/// Кого спрашивать. Дорог две, и они не сводятся друг к другу: у ssh чужой
/// шелл на той стороне, у местного вызова — свой процесс и никакого шелла.
#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    Ssh(String),
    Local,
}

impl Source {
    /// Как источник называется в поле `source` строки.
    ///
    /// `sshHost` отдаётся дословно, включая форму `user@host`: этой же строкой
    /// потом адресуются действия, и приведи её пикер к «красивому» имени
    /// машины — ssh пошёл бы не туда.
    pub fn label(&self) -> String {
        match self {
            Source::Ssh(host) => host.clone(),
            Source::Local => LOCAL_LABEL.to_string(),
        }
    }

    pub fn from_label(label: &str) -> Source {
        if label == LOCAL_LABEL {
            Source::Local
        } else {
            Source::Ssh(label.to_string())
        }
    }
}

/// Источники по конфигу. Пустой список — «спрашивать некого», и это
/// единственная проверка ненастроенности: раньше их было две (`check_ssh_host`
/// в Rust и `sshHostMissing()` на странице), и второе правило про то же самое
/// молчало бы, разойдись с первым.
pub fn sources_from(config: &serde_json::Value) -> Vec<Source> {
    let mut out = Vec::new();
    let host = config
        .get("sshHost")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim();
    if !host.is_empty() {
        out.push(Source::Ssh(host.to_string()));
    }
    if config.get("localSource").and_then(|v| v.as_bool()) == Some(true) {
        out.push(Source::Local);
    }
    out
}

/// Аргументы вызова `--state`, свои у каждой дороги.
///
/// Через ssh уезжает одна строка: её заново разбирает удалённый шелл, и
/// `ccfzf --state` там команда. Местный вызов шелла не поднимает вовсе —
/// `--state` обязан быть отдельным аргументом процесса.
fn state_args(source: &Source) -> Vec<String> {
    match source {
        Source::Ssh(_) => vec!["ccfzf --state".to_string()],
        Source::Local => vec!["--state".to_string()],
    }
}

/// То же для комментария. Текст сюда не входит: он уходит на stdin.
fn comment_args(source: &Source, id: &str, from: &str) -> Vec<String> {
    let mut out = match source {
        Source::Ssh(_) => vec!["ccfzf".to_string()],
        Source::Local => vec![],
    };
    out.push("--comment".to_string());
    out.push(id.to_string());
    out.push(from.to_string());
    out
}

/// Заготовка процесса для источника.
///
/// `hidden_command`, а не `Command::new`: на Windows иначе на каждый опрос
/// всплывает консольное окно, а опрос идёт раз в секунду.
fn command_for(source: &Source) -> Result<std::process::Command, String> {
    match source {
        Source::Ssh(host) => Ok(ssh(host)),
        Source::Local => {
            let (program, args) = crate::local_ccfzf::resolve()?;
            let mut cmd = hidden_command(&program);
            cmd.args(args);
            Ok(cmd)
        }
    }
}

/// Один вызов агрегатора.
///
/// Ответ не разбирается и не чинится: форму проверяет фронтенд той же
/// функцией, что и тесты. Здесь важно только отличить «не смогли спросить» от
/// «спросили, ответили не тем».
///
/// Опции таймаута у ssh обязательны с тех пор, как опрос переехал в фоновый
/// поток Rust (`poller.rs`): это единственный поток, и повисший ssh не просто
/// задерживает кадр — он не даёт разобрать ни одного сигнала (`Shown`,
/// `Hidden`, `Nudge`), пока не отвалится сам. `BatchMode=yes` не даёт ssh
/// уйти в запрос пароля вместо ошибки, `ConnectTimeout=5` — не даёт зависнуть
/// на установке соединения после сна машины или обрыва VPN,
/// `ServerAliveInterval`/`ServerAliveCountMax` обрывают уже установленное, но
/// замолчавшее соединение самое большее через 10 секунд.
pub fn fetch(source: &Source) -> Result<serde_json::Value, String> {
    let out = command_for(source)?
        .args(state_args(source))
        .output()
        .map_err(|e| format!("failed to start: {e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("exited with {}: {}", out.status, err.trim()));
    }

    serde_json::from_slice(&out.stdout).map_err(|e| format!("bad json from ccfzf --state: {e}"))
}

/// Общие опции ssh для обоих вызовов.
///
/// Второй список опций разошёлся бы с первым молча: отказ ssh виден только
/// тем, что ничего не произошло, — а тут ещё и ответа у команды нет.
fn ssh(ssh_host: &str) -> std::process::Command {
    let mut cmd = hidden_command("ssh");
    cmd.arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=5")
        .arg("-o")
        .arg("ServerAliveInterval=5")
        .arg("-o")
        .arg("ServerAliveCountMax=2")
        .arg(ssh_host);
    cmd
}

/// Записать комментарий к сессии на машине её источника.
///
/// Текст уходит на **stdin**, а не аргументом, и это не удобство. `ssh host
/// cmd args…` склеивает аргументы в одну строку, которую заново разбирает
/// удалённый шелл: комментарий вида `fix; rm -rf ~` был бы там командой.
/// Через stdin текст шелла не касается вовсе, и кавычить нечего — тот же
/// приём и та же причина, по которой iTerm2 получает base64 вместо команды.
///
/// Id при этом едет аргументом, и это безопасно: его форму проверяет
/// `looks_like_session_id` здесь и `UUID_RE` на той стороне. Проверок две
/// намеренно — вторая стоит там, куда ходит не только пикер.
///
/// Пустой текст стирает комментарий: отдельного «удалить» у него нет.
pub fn set_comment(source: &Source, id: &str, text: &str, from: &str) -> Result<(), String> {
    if !looks_like_session_id(id) {
        return Err("not a session id".into());
    }
    let mut child = command_for(source)?
        .args(comment_args(source, id, from))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start: {e}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "ssh has no stdin".to_string())?
        .write_all(text.as_bytes())
        .map_err(|e| format!("cannot send the comment: {e}"))?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("ccfzf failed: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("ccfzf exited with {}: {}", out.status, err.trim()));
    }
    Ok(())
}

/// Форма id сессии: тридцать шесть знаков UUID и ничего больше.
///
/// Проверяется здесь, а не только на той стороне, потому что строка уезжает
/// аргументом в чужой шелл: пропусти мы сюда пробел или `;`, и разбирать это
/// стал бы он.
fn looks_like_session_id(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    if parts.len() != 5 {
        return false;
    }
    let widths = [8usize, 4, 4, 4, 12];
    parts
        .iter()
        .zip(widths.iter())
        .all(|(p, w)| p.len() == *w && p.chars().all(|c| c.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests {
    use super::{comment_args, looks_like_session_id, sources_from, state_args, Source};

    #[test]
    fn id_sessii_prinimaetsya_tolko_v_forme_uuid() {
        // Строка уезжает аргументом в чужой шелл через ssh: пропущенный сюда
        // пробел или `;` разбирал бы уже он.
        assert!(looks_like_session_id("b5a54ce3-a022-4c9a-aa91-e306d75bdc76"));
        assert!(!looks_like_session_id("b5a54ce3-a022-4c9a-aa91-e306d75bdc76 ; rm -rf ~"));
        assert!(!looks_like_session_id("../../etc/passwd"));
        assert!(!looks_like_session_id(""));
        assert!(!looks_like_session_id("b5a54ce3a0224c9aaa91e306d75bdc76"));
        // Длины сегментов проверяются каждая своя: без этого сошёлся бы любой
        // набор из пяти шестнадцатеричных кусков.
        assert!(!looks_like_session_id("b5a54ce-3a022-4c9a-aa91-e306d75bdc76"));
    }

    /// Список источников — это весь ответ на вопрос «кого спрашивать».
    /// Пустой `sshHost` не источник, а ненастроенное поле; выключенный
    /// `localSource` не добавляет ничего.
    #[test]
    fn sources_come_from_the_config() {
        let cfg = serde_json::json!({"sshHost": "remote-host"});
        assert_eq!(sources_from(&cfg), vec![Source::Ssh("remote-host".into())]);

        let cfg = serde_json::json!({"sshHost": "remote-host", "localSource": true});
        assert_eq!(
            sources_from(&cfg),
            vec![Source::Ssh("remote-host".into()), Source::Local],
            "удалённый первым: дедуп разрешает споры в пользу первого"
        );

        let cfg = serde_json::json!({"localSource": true});
        assert_eq!(sources_from(&cfg), vec![Source::Local], "один местный — тоже рабочая настройка");

        assert_eq!(sources_from(&serde_json::json!({})), Vec::<Source>::new());
        assert_eq!(
            sources_from(&serde_json::json!({"sshHost": "  ", "localSource": false})),
            Vec::<Source>::new(),
            "пробелы — тот же пустой хост"
        );
        assert_eq!(sources_from(&serde_json::Value::Null), Vec::<Source>::new());
    }

    /// Метка источника уезжает в поле `source` каждой строки и возвращается
    /// обратно аргументом команды. Дорога круговая, и разъехаться половинкам
    /// нельзя: по метке потом выбирается транспорт.
    #[test]
    fn label_survives_the_round_trip() {
        for s in [Source::Ssh("user@remote-host".into()), Source::Local] {
            assert_eq!(Source::from_label(&s.label()), s);
        }
        assert_eq!(Source::Ssh("remote-host".into()).label(), "remote-host");
        assert_eq!(Source::Local.label(), "local");
    }

    /// Аргументы у двух дорог разные, и это не оплошность. Через ssh уезжает
    /// **одна строка**, которую заново разбирает удалённый шелл; местный вызов
    /// шелла не поднимает вовсе, и `--state` обязан быть отдельным аргументом.
    /// Склей мы их одинаково — местный ccfzf получил бы аргумент `ccfzf --state`.
    #[test]
    fn state_args_differ_by_transport() {
        assert_eq!(state_args(&Source::Ssh("remote-host".into())), vec!["ccfzf --state".to_string()]);
        assert_eq!(state_args(&Source::Local), vec!["--state".to_string()]);
    }

    /// То же и у комментария: id и имя машины едут аргументами по обеим
    /// дорогам, а текст — на stdin, потому что через ssh его разбирал бы шелл.
    #[test]
    fn comment_args_differ_by_transport() {
        let id = "b5a54ce3-a022-4c9a-aa91-e306d75bdc76";
        assert_eq!(
            comment_args(&Source::Ssh("remote-host".into()), id, "mac"),
            vec!["ccfzf".to_string(), "--comment".to_string(), id.to_string(), "mac".to_string()]
        );
        assert_eq!(
            comment_args(&Source::Local, id, "mac"),
            vec!["--comment".to_string(), id.to_string(), "mac".to_string()]
        );
    }
}
