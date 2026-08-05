//! Клиент оконного трекера: кто из сессий уже держит окно терминала.
//!
//! Трекер — демон соседнего проекта, http в локальной сети. Отвечает на два
//! маршрута, оба POST: `/claude-wt/status` отдаёт слоты, `/claude-wt/focus`
//! поднимает окно сессии.
//!
//! Ответ, как и у `state_source`, не разбирается и не чинится: форму проверяет
//! фронтенд той же функцией, что и тесты. Здесь важно только отличить «не
//! смогли спросить» от «спросили, ответили не тем».

use std::time::Duration;

/// Опрос идёт на том же тике, что и `ccfzf --state`, то есть раз в секунду.
/// Трекер отвечает из памяти за миллисекунды, так что секунды хватает с
/// запасом; смысл таймаута в другом — машина, ушедшая в сон, не должна
/// набирать очередь висящих запросов.
const TIMEOUT: Duration = Duration::from_secs(1);

fn endpoint(base: &str, path: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), path)
}

fn post(url: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let response = ureq::AgentBuilder::new()
        .timeout(TIMEOUT)
        .build()
        .post(url)
        .send_json(body)
        .map_err(|e| format!("window tracker at {url} failed: {e}"))?;

    response
        .into_json()
        .map_err(|e| format!("bad json from {url}: {e}"))
}

/// Слоты трекера. Пустое тело — маршрут ничего не принимает, но сервер
/// отвечает только на POST.
pub fn fetch(base: &str) -> Result<serde_json::Value, String> {
    post(&endpoint(base, "/claude-wt/status"), serde_json::json!({}))
}

/// Поднять окно сессии.
///
/// Отказ трекера («окна нет», «сессия неизвестна») приезжает как обычный ответ
/// с `ok: false`, а не как ошибка транспорта: разбирать его — дело фронтенда,
/// который единственный знает, что показать человеку.
pub fn focus(base: &str, id: &str) -> Result<serde_json::Value, String> {
    post(
        &endpoint(base, "/claude-wt/focus"),
        serde_json::json!({ "id": id }),
    )
}

#[cfg(test)]
mod tests {
    use super::endpoint;

    #[test]
    fn endpoint_joins_base_and_path() {
        assert_eq!(
            endpoint("http://localhost:9722", "/claude-wt/status"),
            "http://localhost:9722/claude-wt/status"
        );
    }

    /// Косая черта в конце — самая частая форма, в которой url копируют из
    /// браузера. Без обрезки маршрут стал бы `//claude-wt/status`, и сервер
    /// ответил бы 404 на каждый опрос.
    #[test]
    fn endpoint_does_not_double_the_slash() {
        assert_eq!(
            endpoint("http://localhost:9722/", "/claude-wt/focus"),
            "http://localhost:9722/claude-wt/focus"
        );
        assert_eq!(
            endpoint("http://localhost:9722///", "/claude-wt/focus"),
            "http://localhost:9722/claude-wt/focus"
        );
    }
}
