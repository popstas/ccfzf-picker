use crate::proc::hidden_command;

/// Один вызов агрегатора на example-host.
///
/// Ответ не разбирается и не чинится: форму проверяет фронтенд той же
/// функцией, что и тесты. Здесь важно только отличить «не смогли спросить» от
/// «спросили, ответили не тем».
///
/// `ssh` поднимается через `hidden_command`, а не `Command::new`: на Windows
/// иначе на каждый опрос всплывает консольное окно. Опрос идёт раз в секунду,
/// пока пикер показан, — см. `proc.rs`.
pub fn fetch(ssh_host: &str) -> Result<serde_json::Value, String> {
    let out = hidden_command("ssh")
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
