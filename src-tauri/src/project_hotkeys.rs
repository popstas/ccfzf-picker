//! Проектные хоткеи: список приезжает ответом агрегатора, а не из конфига.

use std::str::FromStr;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Проект с хоткеем — ровно то, что читателю нужно от ответа.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Project {
    pub cwd: String,
    pub hotkey: String,
}

/// Чего хочет ответ агрегатора.
///
/// `None` — «трогать нечего»: либо ответ про окна ничего не знает (пустой
/// `windowHost`: `read_windows` на той стороне на любой отказ возвращает
/// пустоту целиком), либо окна на чужой машине. Различить «менеджер убрал
/// хоткей» и «трекер лежит» больше нечем: строки `projects` в ответе есть
/// всегда, они собираются из закладок ccfzf.
///
/// `Some(vec![])` — это «хоткеев нет», и он честно снимает регистрации:
/// живой трекер сказал, что в конфиге пусто.
pub fn wanted_from_state(state: &serde_json::Value, own_host: &str) -> Option<Vec<Project>> {
    let host = state.get("windowHost").and_then(|v| v.as_str()).unwrap_or("");
    let own = own_host.trim();
    if host.is_empty() || own.is_empty() || host != own {
        return None;
    }
    let mut out = Vec::new();
    for row in state
        .get("projects")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        let (Some(cwd), Some(hotkey)) = (
            row.get("path").and_then(|v| v.as_str()),
            row.get("hotkey").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        if cwd.is_empty() || hotkey.trim().is_empty() {
            continue;
        }
        out.push(Project {
            cwd: cwd.to_string(),
            hotkey: hotkey.trim().to_string(),
        });
    }
    Some(out)
}

/// Отпечаток списка: то же ли это, что уже висит.
///
/// Считается по паре «каталог + клавиша» и по порядку: порядок решает, кому
/// достанется дважды названная комбинация, и его смена — настоящее изменение.
pub fn fingerprint(list: &[Project]) -> String {
    list.iter()
        .map(|p| format!("{}\u{0}{}", p.cwd, p.hotkey))
        .collect::<Vec<_>>()
        .join("\u{1}")
}

/// Что висит прямо сейчас и по какому списку.
///
/// Отпечаток хранится рядом с самим списком: без него каждый секундный опрос
/// снимал бы и ставил регистрации заново — шестьдесят раз в минуту на ровном
/// месте.
#[derive(Default)]
pub struct RegisteredState {
    pub live: Vec<(Project, Shortcut)>,
    pub fingerprint: String,
}

#[derive(Default)]
pub struct Registered(pub Mutex<RegisteredState>);

/// Кто из желаемых получит клавишу, а кто останется ни с чем.
///
/// Столкновения решаются в одну сторону и всегда одинаково: встроенная клавиша
/// пикера выигрывает у настроенной, а из двух настроенных — первая по порядку.
/// Возвращается вторым списком то, о чём придётся сказать человеку: пока это
/// была строка в stderr, занятый `Ctrl+F11` расследовали полдня.
pub fn plan(
    wanted: &[Project],
    reserved: Option<&Shortcut>,
) -> (Vec<(Project, Shortcut)>, Vec<String>) {
    let mut ok: Vec<(Project, Shortcut)> = Vec::new();
    let mut taken: Vec<String> = Vec::new();
    for project in wanted {
        let Ok(shortcut) = Shortcut::from_str(&project.hotkey) else {
            taken.push(project.hotkey.clone());
            continue;
        };
        let clashes = reserved == Some(&shortcut) || ok.iter().any(|(_, s)| *s == shortcut);
        if clashes {
            taken.push(project.hotkey.clone());
            continue;
        }
        ok.push((project.clone(), shortcut));
    }
    (ok, taken)
}

/// Вид кэша на диске. Объект, а не массив: `load_json` на отсутствующий файл
/// отдаёт `{}`, и массив пришлось бы отличать от него отдельной веткой.
pub fn to_cache(list: &[Project]) -> serde_json::Value {
    serde_json::json!({
        "projects": list.iter()
            .map(|p| serde_json::json!({"cwd": p.cwd, "hotkey": p.hotkey}))
            .collect::<Vec<_>>()
    })
}

pub fn from_cache(value: &serde_json::Value) -> Vec<Project> {
    let mut out = Vec::new();
    for row in value
        .get("projects")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        let (Some(cwd), Some(hotkey)) = (
            row.get("cwd").and_then(|v| v.as_str()),
            row.get("hotkey").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        if cwd.is_empty() || hotkey.is_empty() {
            continue;
        }
        out.push(Project { cwd: cwd.to_string(), hotkey: hotkey.to_string() });
    }
    out
}

/// Повесить список, сняв прежний.
///
/// Снятие поимённое, а не `unregister_all()`: общий сброс на каждое изменение
/// списка уронил бы и хоткей самого пикера, а он живёт по другому поводу и
/// перевешивается только сменой конфига.
///
/// Наверх уходит `project-hotkeys` с занятыми комбинациями: отказ обязан быть
/// виден. До этой правки он стоил строки в stderr, которого у приложения из
/// трея не читает никто, — и `Ctrl+F11`, отобранный соседом по системе, выглядел
/// как сломанный конфиг.
pub fn apply(app: &tauri::AppHandle, wanted: Vec<Project>) {
    let reserved = crate::picker_hotkey(&crate::load_config().unwrap_or(serde_json::Value::Null)).0;
    let (ok, taken) = plan(&wanted, Some(&reserved));

    let Some(state) = app.try_state::<Registered>() else { return };
    let mut guard = state.0.lock().unwrap();
    for (_, shortcut) in guard.live.drain(..) {
        let _ = app.global_shortcut().unregister(shortcut);
    }

    let mut live = Vec::new();
    let mut failed = taken;
    for (project, shortcut) in ok {
        let handle = app.clone();
        let cwd = project.cwd.clone();
        let hooked = app
            .global_shortcut()
            .on_shortcut(shortcut, move |_app, _sc, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = handle.emit("project-hotkey", cwd.clone());
                }
            });
        match hooked {
            Ok(()) => live.push((project, shortcut)),
            Err(e) => {
                eprintln!("ccfzf-picker: cannot register hotkey {}: {e}", project.hotkey);
                failed.push(project.hotkey);
            }
        }
    }
    guard.fingerprint = fingerprint(&wanted);
    guard.live = live;
    drop(guard);

    if let Err(e) = crate::save_json("hotkeys.json", &to_cache(&wanted)) {
        eprintln!("ccfzf-picker: cannot remember hotkeys: {e}");
    }
    let _ = app.emit("project-hotkeys", serde_json::json!({ "taken": failed }));
}

/// Применить то, что приехало ответом. Зовётся поллером на каждый удачный опрос.
pub fn apply_from_state(app: &tauri::AppHandle, state: &serde_json::Value) {
    let own = crate::load_config()
        .ok()
        .and_then(|c| c.get("windowHost").and_then(|v| v.as_str()).map(str::to_string))
        .unwrap_or_default();
    let Some(wanted) = wanted_from_state(state, &own) else { return };
    if let Some(reg) = app.try_state::<Registered>() {
        if reg.0.lock().unwrap().fingerprint == fingerprint(&wanted) {
            return;
        }
    }
    apply(app, wanted);
}

/// Список прошлого запуска — до первого ответа.
///
/// Без него перезапуск пикера (или спящий хост) оставлял бы человека без
/// клавиш до первого удачного ssh, а на выключенной Windows-машине — навсегда.
pub fn apply_cached(app: &tauri::AppHandle) {
    let cached = from_cache(&crate::load_json("hotkeys.json").unwrap_or(serde_json::Value::Null));
    if cached.is_empty() {
        return;
    }
    apply(app, cached);
}

/// Повесить заново то, что уже висело: после `unregister_all()` в `apply_config`.
pub fn reapply(app: &tauri::AppHandle) {
    let Some(reg) = app.try_state::<Registered>() else { return };
    let wanted: Vec<Project> = reg.0.lock().unwrap().live.iter().map(|(p, _)| p.clone()).collect();
    if wanted.is_empty() {
        return;
    }
    apply(app, wanted);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(host: &str, projects: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "windowHost": host, "projects": projects })
    }

    /// Пустой `windowHost` значит «ответ про окна ничего не знает».
    ///
    /// Различить «менеджер убрал хоткей» и «трекер лежит» больше нечем:
    /// строки `projects` в ответе есть всегда, они собираются из закладок
    /// ccfzf. Спутав эти случаи, пикер снимал бы клавиши на каждую ночь, когда
    /// Windows-машина выключена, — и молча.
    #[test]
    fn a_silent_answer_changes_nothing() {
        let s = state("", serde_json::json!([{"path": "/p/one", "hotkey": "Ctrl+F11"}]));
        assert_eq!(wanted_from_state(&s, "tracker-host"), None);
    }

    /// Чужая машина ничего не регистрирует: клавиши там принадлежат её хозяину.
    #[test]
    fn another_machine_registers_nothing() {
        let s = state("tracker-host", serde_json::json!([{"path": "/p/one", "hotkey": "Ctrl+F11"}]));
        assert_eq!(wanted_from_state(&s, "other-host"), None);
        assert_eq!(wanted_from_state(&s, ""), None);
    }

    /// Живой трекер с пустым списком — это «хоткеев нет», и он их снимает.
    #[test]
    fn a_live_tracker_with_no_hotkeys_clears_them() {
        let s = state("tracker-host", serde_json::json!([{"path": "/p/one"}]));
        assert_eq!(wanted_from_state(&s, "tracker-host"), Some(vec![]));
    }

    #[test]
    fn hotkeys_arrive_in_the_order_the_answer_gave_them() {
        let s = state("tracker-host", serde_json::json!([
            {"path": "/p/one", "hotkey": "Ctrl+F11"},
            {"path": "/p/two", "hotkey": " Ctrl+F12 "},
            {"path": "", "hotkey": "Ctrl+F9"},
        ]));
        assert_eq!(
            wanted_from_state(&s, "tracker-host"),
            Some(vec![
                Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() },
                Project { cwd: "/p/two".into(), hotkey: "Ctrl+F12".into() },
            ])
        );
    }

    /// Отпечаток нужен затем же, зачем и у состояния: перевешивать клавиши на
    /// каждый секундный опрос — значит снимать и ставить регистрацию в системе
    /// шестьдесят раз в минуту.
    #[test]
    fn the_same_list_has_the_same_fingerprint() {
        let a = vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() }];
        let b = vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() }];
        assert_eq!(fingerprint(&a), fingerprint(&b));
    }

    #[test]
    fn a_changed_key_changes_the_fingerprint() {
        let a = vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() }];
        let b = vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F12".into() }];
        assert_ne!(fingerprint(&a), fingerprint(&b));
        assert_ne!(fingerprint(&a), fingerprint(&[]));
    }

    use tauri_plugin_global_shortcut::Shortcut;
    use std::str::FromStr;

    /// Клавиша пикера выигрывает у проектной, а из двух одинаковых проектных —
    /// первая по порядку.
    ///
    /// Правило то же, что у настроенных действий в `config-shape.js`, и цена
    /// его отсутствия та же: комбинация досталась бы тому, кто ниже в списке, а
    /// колонка `hk` обещала бы клавишу, ведущую в другое место.
    #[test]
    fn the_picker_key_wins_and_the_first_project_wins() {
        let picker = Shortcut::from_str("Super+F10").unwrap();
        let wanted = vec![
            Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() },
            Project { cwd: "/p/two".into(), hotkey: "Ctrl+F11".into() },
            Project { cwd: "/p/three".into(), hotkey: "Super+F10".into() },
        ];
        let (ok, taken) = plan(&wanted, Some(&picker));
        assert_eq!(ok.iter().map(|(p, _)| p.cwd.as_str()).collect::<Vec<_>>(), vec!["/p/one"]);
        assert_eq!(taken, vec!["Ctrl+F11".to_string(), "Super+F10".to_string()]);
    }

    /// Неразобранная комбинация — не повод уронить остальные.
    #[test]
    fn an_unparsable_key_costs_only_itself() {
        let wanted = vec![
            Project { cwd: "/p/one".into(), hotkey: "не хоткей".into() },
            Project { cwd: "/p/two".into(), hotkey: "Ctrl+F12".into() },
        ];
        let (ok, taken) = plan(&wanted, None);
        assert_eq!(ok.iter().map(|(p, _)| p.cwd.as_str()).collect::<Vec<_>>(), vec!["/p/two"]);
        assert_eq!(taken, vec!["не хоткей".to_string()]);
    }

    /// Записанное на диск читается обратно тем же списком: кэш вешается на
    /// setup() до первого опроса, и разойдись эти две формы — пикер поднимался
    /// бы без клавиш и молча.
    #[test]
    fn the_cache_survives_a_round_trip() {
        let list = vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() }];
        let stored = to_cache(&list);
        assert_eq!(from_cache(&stored), list);
        assert_eq!(from_cache(&serde_json::json!({})), Vec::<Project>::new());
    }
}
