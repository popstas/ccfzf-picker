use crate::proc::hidden_command;
use std::io::Write;
use std::process::Stdio;

/// Один вызов агрегатора на удалённом хосте.
///
/// Ответ не разбирается и не чинится: форму проверяет фронтенд той же
/// функцией, что и тесты. Здесь важно только отличить «не смогли спросить» от
/// «спросили, ответили не тем».
///
/// `ssh` поднимается через `hidden_command`, а не `Command::new`: на Windows
/// иначе на каждый опрос всплывает консольное окно. Опрос идёт раз в секунду,
/// пока пикер показан, — см. `proc.rs`.
///
/// Опции таймаута обязательны с тех пор, как опрос переехал в фоновый поток
/// Rust (`poller.rs`): это единственный поток, и повисший ssh не просто
/// задерживает кадр — он не даёт разобрать ни одного сигнала (`Shown`,
/// `Hidden`, `Nudge`), пока не отвалится сам. `BatchMode=yes` не даёт ssh
/// уйти в запрос пароля вместо ошибки, `ConnectTimeout=5` — не даёт зависнуть
/// на установке соединения после сна машины или обрыва VPN,
/// `ServerAliveInterval`/`ServerAliveCountMax` обрывают уже установленное, но
/// замолчавшее соединение самое большее через 10 секунд.
pub fn fetch(ssh_host: &str) -> Result<serde_json::Value, String> {
    let out = ssh(ssh_host)
        .arg("ccfzf --state")
        .output()
        .map_err(|e| format!("ssh failed to start: {e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("ssh exited with {}: {}", out.status, err.trim()));
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

/// Записать комментарий к сессии на машине агрегатора.
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
pub fn set_comment(ssh_host: &str, id: &str, text: &str, from: &str) -> Result<(), String> {
    if !looks_like_session_id(id) {
        return Err("not a session id".into());
    }
    let mut child = ssh(ssh_host)
        .arg("ccfzf")
        .arg("--comment")
        .arg(id)
        .arg(from)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ssh failed to start: {e}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "ssh has no stdin".to_string())?
        .write_all(text.as_bytes())
        .map_err(|e| format!("cannot send the comment: {e}"))?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("ssh failed: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("ssh exited with {}: {}", out.status, err.trim()));
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
    use super::looks_like_session_id;

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
}
