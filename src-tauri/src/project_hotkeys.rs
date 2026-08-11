//! Проектные хоткеи: список приезжает ответом агрегатора, а не из конфига.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Mutex, Once};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Проект с хоткеем — ровно то, что читателю нужно от ответа.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Project {
    pub cwd: String,
    pub hotkey: String,
}

/// Приводит имя машины к виду, пригодному для сравнения: обрезает пробелы по
/// краям и переводит в нижний регистр.
///
/// Одна сторона сравнения — `os.hostname()` соседней машины, другая — строка,
/// набранная человеком в конфиге. Регистр в именах машин Windows не значит
/// ничего, а пробел по краям набирается легко и не виден вовсе. Это не
/// случайное послабление, а то же самое правило, которым фронтенд уже
/// сравнивает хосты в `canFocus` (`normHost` в
/// `frontend-src/session-windows.js`) — здесь та же формула на той же паре
/// строк, только на стороне Rust.
fn norm_host(value: &str) -> String {
    value.trim().to_lowercase()
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
    let host_norm = norm_host(host);
    let own_norm = norm_host(own_host);
    if host_norm.is_empty() || own_norm.is_empty() || host_norm != own_norm {
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
    sort_by_cwd(&mut out);
    Some(out)
}

/// Ответ несёт хоткеи, а взять их некому — сказать об этом ровно раз.
///
/// Пустой или чужой `windowHost` на маке — это норма и умолчание: агрегатор
/// рассказывает там про окна Windows-машины, хоткеев на маке не бывает, и
/// строка об этом была бы шумом на каждом запуске. Но на самой
/// Windows-машине незаполненный `windowHost` даёт ровно ту картину, ради
/// которой всё и затевалось: клавиши не работают, и молчат обе стороны.
/// Отличить эти два случая по конфигу нельзя — он одинаков; отличает их ответ,
/// в котором либо есть хоткеи, либо нет. Обе стороны сравнения — в строке:
/// иначе человеку негде увидеть, какое имя писать в конфиг.
pub fn host_mismatch_note(state: &serde_json::Value, own: &str) -> Option<String> {
    if wanted_from_state(state, own).is_some() {
        return None;
    }
    let carries = state
        .get("projects")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .any(|row| {
            row.get("hotkey")
                .and_then(|v| v.as_str())
                .is_some_and(|h| !h.trim().is_empty())
        });
    if !carries {
        return None;
    }
    let host = state.get("windowHost").and_then(|v| v.as_str()).unwrap_or("");
    Some(format!(
        "ccfzf-picker: the answer brings project hotkeys for windowHost \"{host}\", \
         but this picker's windowHost is \"{}\" — no project hotkeys registered",
        own.trim()
    ))
}

/// Список — по каталогу, и это не косметика.
///
/// Порядок ответа порядком конфига менеджера не является: `project_rows` в
/// ccfzf отдаёт проекты по свежести сессий (`-mtime`, затем имя), и он
/// меняется по ходу работы. Решай столкновение по нему — дважды названная
/// комбинация молча переезжала бы от проекта к проекту, стоило поработать в
/// другом; считай по нему отпечаток — каждая перестановка выглядела бы сменой
/// списка и стоила полного цикла «снять-повесить» с перезаписью
/// `hotkeys.json` для списка, который не менялся. Сортировка устойчивая:
/// одинаковых каталогов в ответе не бывает, но и порядок дублей менять не за
/// чем.
pub fn sort_by_cwd(list: &mut [Project]) {
    list.sort_by(|a, b| a.cwd.cmp(&b.cwd));
}

/// Отпечаток списка: то же ли это, что уже висит.
///
/// Считается по паре «каталог + клавиша» и по порядку — а порядок задан
/// `sort_by_cwd`, не ответом.
pub fn fingerprint(list: &[Project]) -> String {
    list.iter()
        .map(|p| format!("{}\u{0}{}", p.cwd, p.hotkey))
        .collect::<Vec<_>>()
        .join("\u{1}")
}

/// Почему клавиша не встала.
///
/// Причина едет наверх вместе с записью, а не подразумевается одна на всех:
/// «занято другим приложением» на внутреннем столкновении — неправда, и она
/// отправляет человека искать чужое приложение, которого нет.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TakenReason {
    /// Систему попросили, система отказала: клавишу держит кто-то ещё.
    System,
    /// Комбинация названа больше чем на одном проекте.
    Duplicate,
    /// Комбинация совпала с собственным хоткеем пикера.
    Reserved,
    /// Комбинация не разбирается.
    Unparsable,
}

impl TakenReason {
    /// Имя причины для страницы. Формулировку складывает она (`project-list.js`):
    /// человеческие строки живут там же, где остальные, и по-английски.
    pub fn as_str(self) -> &'static str {
        match self {
            TakenReason::System => "system",
            TakenReason::Duplicate => "duplicate",
            TakenReason::Reserved => "reserved",
            TakenReason::Unparsable => "unparsable",
        }
    }
}

/// Запись «эта клавиша не встала»: каталог, комбинация и причина.
///
/// Каталог здесь не для полноты картины: строку в списке фронтенд помечает по
/// нему. Пометка по комбинации накрывала бы и победителя внутреннего
/// столкновения — клавиша у них общая, а работает она у одного.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Taken {
    pub cwd: String,
    pub hotkey: String,
    pub reason: TakenReason,
}

impl Taken {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "cwd": self.cwd,
            "hotkey": self.hotkey,
            "reason": self.reason.as_str(),
        })
    }
}

/// Одна и та же форма для события `project-hotkeys` и для команды
/// `project_hotkeys_taken`: разбирает их на странице один помощник, и разойдись
/// эти два тела — разошлись бы и пометки в списке с жалобой в статуслайне.
pub fn taken_json(list: &[Taken]) -> Vec<serde_json::Value> {
    list.iter().map(Taken::to_json).collect()
}

/// Что висит прямо сейчас и по какому списку.
///
/// Отпечаток хранится рядом с самим списком: без него каждый секундный опрос
/// снимал бы и ставил регистрации заново — шестьдесят раз в минуту на ровном
/// месте.
///
/// `live` — это победители: у кого клавиша действительно висит в системе.
/// `wanted` и `taken` — не производные от него, а отдельная память о полном
/// последнем применённом списке и о том, что из него не встало. Оба вопроса,
/// «что показать человеку» (колонка `hk`, команда `project_hotkeys_taken`) и
/// «что перевесить после общего сброса» (`reapply`), — про список целиком, а
/// не про победителей: вывести их из `live` значило бы каждый раз терять
/// проигравших столкновение.
#[derive(Default)]
pub struct RegisteredState {
    pub live: Vec<(Project, Shortcut)>,
    pub fingerprint: String,
    pub wanted: Vec<Project>,
    pub taken: Vec<Taken>,
}

/// Кто вешает клавиши прямо сейчас и что попросили повесить, пока он занят.
///
/// Очередь на одну заявку, а не мьютекс на всё применение: см. `claim`.
#[derive(Default)]
pub struct Work {
    pub busy: bool,
    pub pending: Option<Vec<Project>>,
}

#[derive(Default)]
pub struct Registered {
    pub state: Mutex<RegisteredState>,
    pub work: Mutex<Work>,
    /// Когда по каждому каталогу нажимали в прошлый раз — см. `PRESS_DEBOUNCE`.
    ///
    /// Отдельный мьютекс, а не поле в `RegisteredState`: тот берут и отпускают
    /// вокруг работы с плагином (см. `apply_once`), и добавлять туда что-то,
    /// что читается на каждое нажатие, значило бы связать нажатие клавиши с
    /// перевешиванием списка.
    pub presses: Mutex<HashMap<String, Instant>>,
}

/// Взяться за список самому или отдать его тому, кто уже вешает.
///
/// Мьютекс состояния во время работы с плагином отпущен (иначе поток поллера
/// ждал бы главный поток, а главный — мьютекс), и без очереди два `apply`
/// внахлёст — поллер против сохранения настроек — разошлись бы: второй забрал
/// бы уже опустевший `live` и оставил регистрации первого висеть в системе,
/// никем не учтёнными, а `unregister` до них больше не дошёл бы никогда.
///
/// Ждать здесь нельзя по той же причине, по какой нельзя держать мьютекс:
/// `apply` зовётся и с главного потока (`apply_config` → `reapply`), а
/// работающий в это время поток поллера сам ждёт главный поток внутри
/// плагина. Поэтому опоздавший не ждёт, а оставляет заявку — её подберёт
/// работающий, закончив.
pub fn claim(work: &Mutex<Work>, wanted: Vec<Project>) -> Option<Vec<Project>> {
    let mut w = work.lock().unwrap();
    if w.busy {
        // Заявка хранится последняя: список приезжает целиком, и предыдущий
        // желаемый устарел ровно тогда, когда пришёл следующий.
        w.pending = Some(wanted);
        return None;
    }
    w.busy = true;
    Some(wanted)
}

/// Закончил — забрать оставленную заявку или освободить место.
pub fn finish(work: &Mutex<Work>) -> Option<Vec<Project>> {
    let mut w = work.lock().unwrap();
    match w.pending.take() {
        Some(next) => Some(next),
        None => {
            w.busy = false;
            None
        }
    }
}

/// Кто из желаемых получит клавишу, а кто останется ни с чем.
///
/// Столкновения решаются в одну сторону и всегда одинаково: встроенная клавиша
/// пикера выигрывает у настроенной, а из двух настроенных — первая по порядку.
/// Возвращается вторым списком то, о чём придётся сказать человеку: пока это
/// была строка в stderr, занятый `Ctrl+F11` расследовали полдня. Причина у
/// каждого проигравшего своя и едет с ним: столкновение внутри конфига
/// менеджера и отобранная соседом по системе клавиша чинятся в разных местах,
/// и одно название на оба случая посылало бы человека не туда.
pub fn plan(
    wanted: &[Project],
    reserved: Option<&Shortcut>,
) -> (Vec<(Project, Shortcut)>, Vec<Taken>) {
    let mut ok: Vec<(Project, Shortcut)> = Vec::new();
    let mut taken: Vec<Taken> = Vec::new();
    let lost = |project: &Project, reason: TakenReason| Taken {
        cwd: project.cwd.clone(),
        hotkey: project.hotkey.clone(),
        reason,
    };
    for project in wanted {
        let Ok(shortcut) = Shortcut::from_str(&project.hotkey) else {
            taken.push(lost(project, TakenReason::Unparsable));
            continue;
        };
        if reserved == Some(&shortcut) {
            taken.push(lost(project, TakenReason::Reserved));
            continue;
        }
        if ok.iter().any(|(_, s)| *s == shortcut) {
            taken.push(lost(project, TakenReason::Duplicate));
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
    // Тем же порядком, что и ответ: разойдись они, первый же ответ после
    // старта не совпал бы с отпечатком повешенного с диска списка и перевесил
    // бы всё заново на ровном месте.
    sort_by_cwd(&mut out);
    out
}

/// Окно дребезга проектного хоткея.
///
/// Не страховка от повтора удержанной клавиши: `global-hotkey` (версия
/// зафиксирована в `Cargo.lock`) регистрирует хоткеи с флагом `MOD_NOREPEAT`
/// (`src/platform_impl/windows/mod.rs` в исходнике плагина), и на удержание
/// `WM_HOTKEY` не повторяется — держит клавишу хоть минуту, событие одно.
/// Дребезг здесь против другого: человек не видит подтверждения нажатию
/// (пикер уже погашен) и рука тянется нажать ещё раз, а заодно — на случай,
/// если `MOD_NOREPEAT` в будущей версии плагина перестанет ставиться.
///
/// Секунда — оттуда же, откуда её взял ограничитель `keys/press-throttled` для
/// кнопок панели: ниже этого порога человек не нажимает нарочно.
pub const PRESS_DEBOUNCE: Duration = Duration::from_secs(1);

/// Пропустить ли нажатие: прошлое по этому же каталогу было достаточно давно.
///
/// Причина самого окна — у `PRESS_DEBOUNCE`, не здесь: это чистая формула
/// сравнения времён.
///
/// Отдельно от отметок, чтобы правило проверялось `cargo test` без мьютекса и
/// без живого `AppHandle` — тем же приёмом, что `picker_toggle` в `main.rs`.
pub fn press_allowed(last: Option<Instant>, now: Instant, window: Duration) -> bool {
    match last {
        Some(previous) => now.duration_since(previous) >= window,
        None => true,
    }
}

/// Записать нажатие, если дребезг его пропускает.
fn take_press(reg: &Registered, cwd: &str, now: Instant) -> bool {
    let mut presses = reg.presses.lock().unwrap();
    if !press_allowed(presses.get(cwd).copied(), now, PRESS_DEBOUNCE) {
        return false;
    }
    presses.insert(cwd.to_string(), now);
    true
}

/// pid демона трекера из последнего ответа поллера; ноль — «грамоту выдавать
/// некому».
///
/// Форма та же, что у `focusPid` во фронтенде: конечное положительное число,
/// всё прочее — ноль. Читается из тела `Poller::snapshot()`, а оно
/// `{state, error}`: сам ответ агрегатора лежит под `state`, и там же
/// `windowPid`, который трекер кладёт в файл окон.
pub fn tracker_pid_from(snapshot: &serde_json::Value) -> u32 {
    snapshot
        .get("state")
        .and_then(|s| s.get("windowPid"))
        .and_then(|v| v.as_u64())
        .filter(|pid| *pid > 0 && *pid <= u32::MAX as u64)
        .unwrap_or(0) as u32
}

/// Нажали проектный хоткей.
///
/// Развилку «поднять окно или завести сессию» принимает не пикер, а менеджер:
/// правило «последняя открытая сессия этого каталога» уже написано и покрыто
/// тестами у него (`pickOpenProjectSession`), список пикера у скрытого окна
/// отстаёт до восьми минут, и профиль Windows Terminal по каталогу знает тоже
/// только он. Отсюда уходит просьба, а не решение.
///
/// Живёт в этом файле, а не в `main.rs`: она про нажатие хоткея, а не про
/// пикер вообще, и читается вместе с тем, кто её вешает.
pub fn press(app: &tauri::AppHandle, cwd: &str) {
    // `try_state` здесь ради отсутствия паники, а не ради ветки без него:
    // `apply` начинается с `let Some(reg) = app.try_state::<Registered>()
    // else { return }`, то есть без состояния ни один хоткей не повешен, а
    // `press` зовётся только из повешенного on_shortcut — сюда без `reg` не
    // попасть.
    if let Some(reg) = app.try_state::<Registered>() {
        if !take_press(&reg, cwd, Instant::now()) {
            return;
        }
    }
    // Гасим до просьбы, а не после: показанный пикер накрыл бы поднятое окно.
    // Та же причина, по которой гасит до публикации `focusSession` на странице.
    // Идемпотентна — уже скрытое окно повторно не гасит.
    crate::hide_window(app);

    // Отказ обязан быть виден — в этом файле уже расследовали занятый
    // `Ctrl+F11`, который молчал строкой в непрочитанный stderr. Молчаливый
    // `unwrap_or(Null)` тут выглядел бы как «брокер не настроен» что для
    // битого конфига (опечатка в yaml, нечитаемый файл), что для настоящего
    // отсутствия mqtt — и запасная дорога завела бы вторую сессию без
    // единого слова о том, что конфиг вообще не прочитался.
    let raw = match crate::load_config() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("ccfzf-picker: cannot read config, falling back to a new session: {e}");
            serde_json::Value::Null
        }
    };
    let broker = crate::mqtt::broker_from_config(&raw);
    if !broker.is_configured() {
        // Конфиг прочитан, но брокера в нём нет либо он неполный (см.
        // `is_configured` в `mqtt.rs`). Просить некого. Прежняя дорога:
        // страница поднимет новую сессию сама — это и было поведением до
        // всей правки, и без брокера другого нет.
        eprintln!("ccfzf-picker: mqtt broker is not configured, falling back to a new session");
        let _ = app.emit("project-hotkey", cwd.to_string());
        return;
    }

    // Неизвестный pid отменяет грамоту, но не просьбу — и это сознательно иначе,
    // чем в `canFocus` на странице, где нулевой pid запрещает подъём целиком.
    // Там цена ошибки — открыть терминал у себя; здесь — молча завести второй
    // терминал на проект, у которого окно уже есть. Окно, поднятое без грамоты,
    // в худшем случае мигнёт кнопкой на таскбаре, и это дешевле.
    let pid = app
        .try_state::<crate::poller::Poller>()
        .map(|poller| tracker_pid_from(&poller.snapshot()))
        .unwrap_or(0);
    if pid > 0 {
        crate::allow_tracker_foreground(pid);
    }

    // Публикация ждёт подтверждения брокера до пяти секунд — держать на этом
    // поток, из которого плагин зовёт обработчик, нельзя. Ответа у просьбы нет
    // по замыслу, как у фокуса и восстановления: приёмник отчитывается в свой
    // журнал, а не нам.
    let cwd = cwd.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = crate::mqtt::open_project(&broker, &cwd) {
            eprintln!("ccfzf-picker: cannot ask to open {cwd}: {e}");
        }
    });
}

/// Повесить список, сняв прежний.
///
/// Снятие поимённое, а не `unregister_all()`: общий сброс на каждое изменение
/// списка уронил бы и хоткей самого пикера, а он живёт по другому поводу и
/// перевешивается только сменой конфига.
///
/// Список приходит отсортированным по каталогу — `sort_by_cwd` стоит в обоих
/// источниках, `wanted_from_state` и `from_cache`, а `reapply` берёт уже
/// применённый. На этом стоит и сравнение отпечатков в `apply_from_state`.
///
/// Наверх уходит `project-hotkeys` записями «каталог, комбинация, причина»:
/// отказ обязан быть виден, и виден настоящей причиной. До этой правки он
/// стоил строки в stderr, которого у приложения из трея не читает никто, — и
/// `Ctrl+F11`, отобранный соседом по системе, выглядел как сломанный конфиг.
pub fn apply(app: &tauri::AppHandle, wanted: Vec<Project>) {
    let Some(reg) = app.try_state::<Registered>() else { return };
    // Занято — оставляем заявку и уходим: ждать нельзя, см. `claim`.
    let Some(mut list) = claim(&reg.work, wanted) else { return };
    loop {
        apply_once(app, &reg, list);
        match finish(&reg.work) {
            Some(next) => list = next,
            None => break,
        }
    }
}

/// Один проход: снять прежние, повесить эти, запомнить исход.
///
/// Мьютекс состояния берётся здесь дважды по чуть-чуть и **не** держится, пока
/// идёт работа с плагином. `unregister` и `on_shortcut` в
/// `tauri-plugin-global-shortcut` идут через `run_main_thread!`, то есть кладут
/// задачу в цикл событий и блокируются на ответе главного потока. Держи мы при
/// этом мьютекс, замок сошёлся бы двумя путями сразу: поток поллера ждал бы
/// главный поток, а тот в это время ждал бы мьютекс в команде
/// `project_hotkeys_taken`; и второй, короче, — `apply_config` зовёт `reapply`
/// прямо с главного потока, и `run_main_thread!` под собственным мьютексом
/// ждал бы там сам себя.
fn apply_once(app: &tauri::AppHandle, reg: &Registered, wanted: Vec<Project>) {
    let reserved = crate::picker_hotkey(&crate::load_config().unwrap_or(serde_json::Value::Null)).0;
    let (ok, taken) = plan(&wanted, Some(&reserved));

    let (previous, was_fingerprint, was_taken) = {
        let mut guard = reg.state.lock().unwrap();
        (
            std::mem::take(&mut guard.live),
            guard.fingerprint.clone(),
            guard.taken.clone(),
        )
    };
    for (_, shortcut) in previous {
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
                    press(&handle, &cwd);
                }
            });
        match hooked {
            Ok(()) => live.push((project, shortcut)),
            Err(e) => {
                eprintln!("ccfzf-picker: cannot register hotkey {}: {e}", project.hotkey);
                failed.push(Taken {
                    cwd: project.cwd,
                    hotkey: project.hotkey,
                    reason: TakenReason::System,
                });
            }
        }
    }
    let fp = fingerprint(&wanted);
    {
        let mut guard = reg.state.lock().unwrap();
        guard.fingerprint = fp.clone();
        // wanted и taken запоминаются здесь же, а не выводятся из live позже:
        // это единственное место, где виден весь список целиком, включая тех,
        // кто проиграл столкновение и в live не попал.
        guard.wanted = wanted.clone();
        guard.live = live;
        guard.taken = failed.clone();
    }

    // Ни списка, ни исхода не изменилось — значит, это очередная попытка
    // отобрать назад занятую клавишу (`needs_reapply`), и рассказывать о ней
    // некому: файл получил бы ту же запись, а страница — то же событие, раз в
    // секунду и без повода.
    if was_fingerprint == fp && was_taken == failed {
        return;
    }
    if let Err(e) = crate::save_json("hotkeys.json", &to_cache(&wanted)) {
        eprintln!("ccfzf-picker: cannot remember hotkeys: {e}");
    }
    let _ = app.emit(
        "project-hotkeys",
        serde_json::json!({ "taken": taken_json(&failed) }),
    );
}

/// Стоит ли трогать клавиши на этот ответ.
///
/// Отпечаток считается по желаемому, а не по исходу, и одной его проверки
/// мало: клавиша, отобранная соседом по системе на момент старта, не
/// перепробовалась бы больше ни разу — список-то не менялся, — и жалоба в
/// статуслайне провисела бы до перезапуска, хотя вор давно ушёл. Поэтому пока
/// в `taken` есть хоть одна клавиша с причиной `System`, список применяется
/// заново на каждый опрос: снять и повесить десяток клавиш раз в секунду
/// дешевле, чем врать человеку про занятость. Учесть исход в самом отпечатке
/// не вышло бы: отпечаток сравнивается до применения, а исход известен только
/// после.
///
/// Причины `Duplicate`, `Reserved` и `Unparsable` переспросом не лечатся:
/// `plan` решает их детерминированно из того же отсортированного списка, и
/// без смены самого списка (а она и так собьёт отпечаток) исход не изменится
/// ни на йоту. Перевешивать под них весь список — это на миг снимать каждую
/// уже висящую клавишу без единого шанса что-то починить, и нажатие, попавшее
/// в этот разрыв, теряется бесследно.
pub fn needs_reapply(state: &RegisteredState, wanted: &[Project]) -> bool {
    let stuck_on_system = state
        .taken
        .iter()
        .any(|t| t.reason == TakenReason::System);
    stuck_on_system || state.fingerprint != fingerprint(wanted)
}

/// Применить то, что приехало ответом. Зовётся поллером на каждый удачный опрос.
pub fn apply_from_state(app: &tauri::AppHandle, state: &serde_json::Value) {
    let own = crate::load_config()
        .ok()
        .and_then(|c| c.get("windowHost").and_then(|v| v.as_str()).map(str::to_string))
        .unwrap_or_default();
    let Some(wanted) = wanted_from_state(state, &own) else {
        if let Some(note) = host_mismatch_note(state, &own) {
            // Один раз за запуск: опрос идёт раз в секунду, и повторять эту
            // строку значило бы залить ею весь stderr.
            static SAID: Once = Once::new();
            SAID.call_once(|| eprintln!("{note}"));
        }
        return;
    };
    if let Some(reg) = app.try_state::<Registered>() {
        if !needs_reapply(&reg.state.lock().unwrap(), &wanted) {
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

/// Список, который `reapply` повесит заново после общего сброса.
///
/// Читает `wanted`, а не `live`: `live` хранит только победителей, и собирать
/// список для перевешивания по нему значило бы на каждом общем сбросе заново
/// терять тех, кто проиграл столкновение при первом применении, — и
/// `hotkeys.json`, и колонка `hk`, и предупреждение в статуслайне после
/// такого сброса стали бы неполными. Отдельная функция — чтобы это правило
/// проверялось `cargo test` без живого `AppHandle`, которого само это правило
/// не касается.
pub fn reapply_list(state: &RegisteredState) -> Vec<Project> {
    state.wanted.clone()
}

/// Повесить заново то, что уже висело: после `unregister_all()` в `apply_config`.
pub fn reapply(app: &tauri::AppHandle) {
    let Some(reg) = app.try_state::<Registered>() else { return };
    // Мьютекс отпускается этой же строкой, до `apply`: держать его дальше
    // значило бы войти в плагин под замком — тот самый путь, от которого
    // `apply_once` и расщеплён.
    let wanted = reapply_list(&reg.state.lock().unwrap());
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

    /// Живая ошибка с выкатки: в конфиге человек написал `TRACKER-HOST`,
    /// `os.hostname()` на той же машине отдаёт `tracker-host` — тот же хост,
    /// разный регистр. `canFocus` во фронтенде через `normHost` эту разницу
    /// не видит, и Rust обязан сравнивать так же, а не строже: до этой правки
    /// условие `host != own` никогда не выполнялось, и ответ агрегатора с
    /// хоткеями не регистрировал ни одного.
    #[test]
    fn own_host_case_does_not_matter() {
        let s = state("tracker-host", serde_json::json!([{"path": "/p/one", "hotkey": "Ctrl+F11"}]));
        assert_eq!(
            wanted_from_state(&s, "TRACKER-HOST"),
            Some(vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() }])
        );
    }

    /// Тот же случай, но со стороны ответа: не только конфиг человека может
    /// быть набран в другом регистре — `windowHost` в ответе агрегатора тоже.
    #[test]
    fn answer_host_case_does_not_matter() {
        let s = state("TRACKER-HOST", serde_json::json!([{"path": "/p/one", "hotkey": "Ctrl+F11"}]));
        assert_eq!(
            wanted_from_state(&s, "tracker-host"),
            Some(vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() }])
        );
    }

    /// Пробел по краям в конфиге набирается легко и не виден вовсе —
    /// сравнение обязано его прощать так же, как `normHost`.
    #[test]
    fn surrounding_spaces_in_own_host_do_not_matter() {
        let s = state("tracker-host", serde_json::json!([{"path": "/p/one", "hotkey": "Ctrl+F11"}]));
        assert_eq!(
            wanted_from_state(&s, "  tracker-host  "),
            Some(vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() }])
        );
    }

    /// Послабление не должно превращаться в «совпадает со всем»: настоящее
    /// несовпадение имён машин по-прежнему ничего не регистрирует.
    #[test]
    fn a_genuinely_different_host_still_registers_nothing() {
        let s = state("TRACKER-HOST", serde_json::json!([{"path": "/p/one", "hotkey": "Ctrl+F11"}]));
        assert_eq!(wanted_from_state(&s, "other-host"), None);
    }

    /// Живой трекер с пустым списком — это «хоткеев нет», и он их снимает.
    #[test]
    fn a_live_tracker_with_no_hotkeys_clears_them() {
        let s = state("tracker-host", serde_json::json!([{"path": "/p/one"}]));
        assert_eq!(wanted_from_state(&s, "tracker-host"), Some(vec![]));
    }

    #[test]
    fn hotkeys_arrive_sorted_by_directory() {
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

    /// Порядок ответа значения не имеет: он приезжает по свежести сессий и
    /// меняется, стоит поработать в другом проекте. Реши мы по нему
    /// столкновение — дважды названная клавиша молча переезжала бы от проекта
    /// к проекту; считай по нему отпечаток — каждая перестановка выглядела бы
    /// сменой списка и стоила полного цикла «снять-повесить» с перезаписью
    /// hotkeys.json.
    #[test]
    fn a_reshuffled_answer_is_the_same_list() {
        let fresh_first = state("tracker-host", serde_json::json!([
            {"path": "/p/two", "hotkey": "Ctrl+F11"},
            {"path": "/p/one", "hotkey": "Ctrl+F11"},
        ]));
        let fresh_last = state("tracker-host", serde_json::json!([
            {"path": "/p/one", "hotkey": "Ctrl+F11"},
            {"path": "/p/two", "hotkey": "Ctrl+F11"},
        ]));
        let a = wanted_from_state(&fresh_first, "tracker-host").unwrap();
        let b = wanted_from_state(&fresh_last, "tracker-host").unwrap();
        assert_eq!(a, b);
        assert_eq!(fingerprint(&a), fingerprint(&b));
        // Победитель один и тот же в обоих случаях — каталог, а не свежесть.
        let (ok, _) = plan(&a, None);
        assert_eq!(ok.iter().map(|(p, _)| p.cwd.as_str()).collect::<Vec<_>>(), vec!["/p/one"]);
    }

    /// Кэш читается тем же порядком, что и ответ: разойдись они, первый же
    /// ответ после старта не совпал бы с отпечатком повешенного с диска
    /// списка и перевесил бы всё заново на ровном месте.
    #[test]
    fn the_cache_comes_back_sorted_too() {
        let stored = serde_json::json!({"projects": [
            {"cwd": "/p/two", "hotkey": "Ctrl+F12"},
            {"cwd": "/p/one", "hotkey": "Ctrl+F11"},
        ]});
        assert_eq!(
            from_cache(&stored).iter().map(|p| p.cwd.as_str()).collect::<Vec<_>>(),
            vec!["/p/one", "/p/two"]
        );
    }

    /// Ответ несёт хоткеи, а свой `windowHost` пуст или не тот — единственный
    /// случай, когда об этом надо сказать. На маке ответ хоткеев не несёт, и
    /// жаловаться там не на что.
    #[test]
    fn hotkeys_for_a_host_we_are_not_are_worth_a_word() {
        let s = state("tracker-host", serde_json::json!([{"path": "/p/one", "hotkey": "Ctrl+F11"}]));
        let note = host_mismatch_note(&s, "").expect("пустой свой хост при хоткеях в ответе");
        assert!(note.contains("tracker-host"), "чужая сторона сравнения в строке: {note}");
        assert!(note.contains("windowHost"), "человеку нужно имя ключа в конфиге: {note}");
        assert!(host_mismatch_note(&s, "other-host").is_some(), "несовпадение — тот же случай");
        assert_eq!(host_mismatch_note(&s, "tracker-host"), None, "свои хоткеи — не жалоба");
    }

    /// Ответ без хоткеев молчит: это и есть мак, где их не бывает.
    #[test]
    fn an_answer_without_hotkeys_says_nothing() {
        let s = state("tracker-host", serde_json::json!([
            {"path": "/p/one"},
            {"path": "/p/two", "hotkey": "  "},
        ]));
        assert_eq!(host_mismatch_note(&s, ""), None);
    }

    /// Пока хоть одна клавиша не встала, список пробуется заново на каждый
    /// опрос. Отпечаток считается по желаемому, а не по исходу: срежь по нему
    /// — и клавиша, отобранная соседом по системе на момент старта, не
    /// перепробуется больше ни разу, а жалоба провисит до перезапуска, хотя
    /// вор давно ушёл.
    #[test]
    fn a_taken_key_is_tried_again_on_every_answer() {
        let wanted = vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() }];
        let settled = RegisteredState {
            fingerprint: fingerprint(&wanted),
            wanted: wanted.clone(),
            ..Default::default()
        };
        assert!(!needs_reapply(&settled, &wanted), "тот же список без отказов не трогаем");

        let complaining = RegisteredState {
            taken: vec![Taken {
                cwd: "/p/one".into(),
                hotkey: "Ctrl+F11".into(),
                reason: TakenReason::System,
            }],
            ..settled
        };
        assert!(needs_reapply(&complaining, &wanted), "непойманная клавиша — повод пробовать");
    }

    /// Детерминированные причины отказа переспросом не лечатся: `plan` решает
    /// их из того же отсортированного списка, и без смены списка исход не
    /// изменится. Круг «снять-повесить» на них — только риск потерять
    /// нажатие, попавшее в разрыв между снятием и повторной регистрацией.
    #[test]
    fn a_deterministic_taken_reason_is_not_tried_again() {
        let wanted = vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() }];

        for reason in [TakenReason::Duplicate, TakenReason::Reserved, TakenReason::Unparsable] {
            let complaining = RegisteredState {
                fingerprint: fingerprint(&wanted),
                wanted: wanted.clone(),
                taken: vec![Taken {
                    cwd: "/p/one".into(),
                    hotkey: "Ctrl+F11".into(),
                    reason,
                }],
                ..Default::default()
            };
            assert!(
                !needs_reapply(&complaining, &wanted),
                "причина {reason:?} сама не рассосётся — переспрос ничего не изменит"
            );
        }
    }

    #[test]
    fn a_changed_list_is_applied_even_without_complaints() {
        let old = vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() }];
        let new = vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F12".into() }];
        let state = RegisteredState {
            fingerprint: fingerprint(&old),
            wanted: old,
            ..Default::default()
        };
        assert!(needs_reapply(&state, &new));
    }

    /// Опоздавший не ждёт, а оставляет заявку.
    ///
    /// Ждать нельзя: `apply` зовётся и с главного потока (`apply_config` →
    /// `reapply`), а работающий в это время поток поллера сам ждёт главный
    /// поток внутри плагина — взаимный замок. Но и разойтись двум `apply`
    /// нельзя: второй забрал бы уже опустевший `live` и оставил регистрации
    /// первого висеть, никем не учтёнными.
    #[test]
    fn a_second_apply_leaves_a_note_instead_of_waiting() {
        let work = Mutex::new(Work::default());
        let first = vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() }];
        let second = vec![Project { cwd: "/p/two".into(), hotkey: "Ctrl+F12".into() }];
        assert_eq!(claim(&work, first.clone()), Some(first), "свободно — берём сами");
        assert_eq!(claim(&work, second.clone()), None, "занято — отдаём заявкой");
        assert_eq!(finish(&work), Some(second), "заявку подбирает тот, кто работал");
        assert_eq!(finish(&work), None, "заявок больше нет — место свободно");
        let third = vec![Project { cwd: "/p/three".into(), hotkey: "Ctrl+F9".into() }];
        assert_eq!(claim(&work, third.clone()), Some(third), "после finish место свободно");
    }

    /// Заявка хранится последняя: список приезжает целиком, и предыдущий
    /// желаемый устарел ровно в тот момент, когда пришёл следующий.
    #[test]
    fn only_the_latest_note_survives() {
        let work = Mutex::new(Work::default());
        assert!(claim(&work, vec![]).is_some());
        let older = vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() }];
        let newer = vec![Project { cwd: "/p/two".into(), hotkey: "Ctrl+F12".into() }];
        assert_eq!(claim(&work, older), None);
        assert_eq!(claim(&work, newer.clone()), None);
        assert_eq!(finish(&work), Some(newer));
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
    ///
    /// Причина у каждого проигравшего своя, и она уезжает наверх вместе с
    /// записью: назвав внутреннее столкновение занятостью, пикер отправил бы
    /// человека искать чужое приложение, которого нет.
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
        assert_eq!(taken, vec![
            Taken { cwd: "/p/two".into(), hotkey: "Ctrl+F11".into(), reason: TakenReason::Duplicate },
            Taken { cwd: "/p/three".into(), hotkey: "Super+F10".into(), reason: TakenReason::Reserved },
        ]);
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
        assert_eq!(taken, vec![Taken {
            cwd: "/p/one".into(),
            hotkey: "не хоткей".into(),
            reason: TakenReason::Unparsable,
        }]);
    }

    /// Наверх уезжает каталог, а не одна комбинация: строку в списке фронтенд
    /// помечает по нему. По комбинации пометка накрыла бы и победителя
    /// внутреннего столкновения — клавиша у них общая, а работает она у
    /// одного.
    #[test]
    fn the_report_names_the_directory_that_lost() {
        let wanted = vec![
            Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() },
            Project { cwd: "/p/two".into(), hotkey: "Ctrl+F11".into() },
        ];
        let (_, taken) = plan(&wanted, None);
        let json = taken_json(&taken);
        assert_eq!(json.len(), 1);
        assert_eq!(json[0]["cwd"].as_str(), Some("/p/two"));
        assert_eq!(json[0]["hotkey"].as_str(), Some("Ctrl+F11"));
        assert_eq!(json[0]["reason"].as_str(), Some("duplicate"));
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

    /// `reapply` обязан вешать заново весь желаемый список, а не только
    /// победителей: `live` у столкнувшейся пары хранит одного, а `wanted` — обоих.
    /// До этой правки `reapply` собирал список из `live`, и проигравший
    /// столкновение при общем сбросе (`apply_config`) пропадал бы из
    /// `hotkeys.json` и из предупреждения молча — второй раз подряд.
    #[test]
    fn reapply_list_keeps_the_loser_of_a_collision_that_live_would_drop() {
        let winner = Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() };
        let loser = Project { cwd: "/p/two".into(), hotkey: "Ctrl+F11".into() };
        let shortcut = Shortcut::from_str("Ctrl+F11").unwrap();
        let state = RegisteredState {
            live: vec![(winner.clone(), shortcut)],
            fingerprint: String::new(),
            wanted: vec![winner.clone(), loser.clone()],
            taken: vec![Taken {
                cwd: "/p/two".into(),
                hotkey: "Ctrl+F11".into(),
                reason: TakenReason::Duplicate,
            }],
        };
        // live содержит только победителя — если бы reapply_list читал его,
        // loser здесь не оказалось бы.
        assert_eq!(state.live.len(), 1);
        assert_eq!(reapply_list(&state), vec![winner, loser]);
    }

    /// Второе нажатие в пределах секунды гасится — но не потому, что Windows
    /// повторяет `WM_HOTKEY` на удержании: хоткеи регистрируются с флагом
    /// `MOD_NOREPEAT` (`global-hotkey`, версия зафиксирована в `Cargo.lock`),
    /// и держи клавишу хоть минуту — событие одно. Гасит дребезг нарочное
    /// повторное нажатие человеком: подтверждения первому нет (пикер уже
    /// погашен), и рука тянется нажать ещё раз, — а заодно страхует на
    /// случай, если `MOD_NOREPEAT` когда-нибудь перестанет ставиться.
    #[test]
    fn a_second_press_within_a_second_is_dropped() {
        let now = Instant::now();
        assert!(press_allowed(None, now, PRESS_DEBOUNCE));
        assert!(!press_allowed(Some(now), now, PRESS_DEBOUNCE));
        assert!(!press_allowed(
            Some(now - Duration::from_millis(900)),
            now,
            PRESS_DEBOUNCE
        ));
        // Точная граница окна: сравнение `>=`, а не `>`, иначе ничем не
        // покрыта.
        assert!(press_allowed(Some(now - PRESS_DEBOUNCE), now, PRESS_DEBOUNCE));
    }

    /// Нарочное второе нажатие через секунду проходит: окно дребезга — про
    /// палец на клавише, а не про запрет открывать проект дважды.
    #[test]
    fn a_deliberate_second_press_goes_through() {
        let now = Instant::now();
        assert!(press_allowed(
            Some(now - Duration::from_millis(1100)),
            now,
            PRESS_DEBOUNCE
        ));
    }

    /// Соседние проекты друг друга не глушат: отметка своя на каждый каталог.
    #[test]
    fn projects_do_not_silence_each_other() {
        let reg = Registered::default();
        let now = Instant::now();
        assert!(take_press(&reg, "/p/one", now));
        assert!(take_press(&reg, "/p/two", now));
        assert!(!take_press(&reg, "/p/one", now));
    }

    /// pid трекера лежит внутри `state`, а не рядом с ним: тело
    /// `Poller::snapshot()` — это `{state, error}`.
    #[test]
    fn the_tracker_pid_comes_from_inside_the_answer() {
        let snapshot = serde_json::json!({"state": {"windowPid": 4242}, "error": ""});
        assert_eq!(tracker_pid_from(&snapshot), 4242);
    }

    /// Ответа ещё нет, pid не число, pid ноль — грамоту выдавать некому.
    ///
    /// Ноль здесь не мелочь: `AllowSetForegroundWindow(0)` — это не «никому», а
    /// отдельное значение, и отдавать его системе по недосмотру не стоит.
    #[test]
    fn no_answer_means_no_grant() {
        assert_eq!(
            tracker_pid_from(&serde_json::json!({"state": null, "error": "ssh failed"})),
            0
        );
        assert_eq!(
            tracker_pid_from(&serde_json::json!({"state": {"windowPid": "4242"}})),
            0
        );
        assert_eq!(
            tracker_pid_from(&serde_json::json!({"state": {"windowPid": 0}})),
            0
        );
    }
}
