use std::process::Command;

/// Один вызов агрегатора на example-host.
///
/// Ответ не разбирается и не чинится: форму проверяет фронтенд той же
/// функцией, что и тесты. Здесь важно только отличить «не смогли спросить» от
/// «спросили, ответили не тем».
pub fn fetch(ssh_host: &str) -> Result<serde_json::Value, String> {
    let out = Command::new("ssh")
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
