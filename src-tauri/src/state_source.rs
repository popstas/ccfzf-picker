use crate::proc::hidden_command;

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
    let out = hidden_command("ssh")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=5")
        .arg("-o")
        .arg("ServerAliveInterval=5")
        .arg("-o")
        .arg("ServerAliveCountMax=2")
        .arg(ssh_host)
        .arg("ccfzf --state")
        .output()
        .map_err(|e| format!("ssh failed to start: {e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("ssh exited with {}: {}", out.status, err.trim()));
    }

    serde_json::from_slice(&out.stdout).map_err(|e| format!("bad json from ccfzf --state: {e}"))
}
