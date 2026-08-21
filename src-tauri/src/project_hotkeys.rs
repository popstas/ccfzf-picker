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

/// Живые трекеры ответа поимённо: названа ли среди них эта машина.
///
/// Список `windowHosts` собирает `read_window_sources` из тех файлов окон,
/// что разобрались и не протухли, — то есть «моё имя здесь есть» значит разом
/// две вещи: имя в конфиге набрано верно и трекер на этой машине жив. Обе
/// нужны и `wanted_from_state`, и `host_mismatch_note`, и второе их прочтение
/// разошлось бы с первым.
///
/// Имена приводятся `norm_host` — той же формулой, какой их сравнивает
/// фронтенд (`normHost` в `session-windows.js`).
fn names_tracker(state: &serde_json::Value, own_norm: &str) -> bool {
    if own_norm.is_empty() {
        return false;
    }
    state
        .get("windowHosts")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|e| e.get("host").and_then(|v| v.as_str()))
        .any(|h| norm_host(h) == own_norm)
}

/// Хоткеи, какими они приехали в ответе: `projects` с непустой клавишей.
fn hotkeys_of(state: &serde_json::Value) -> Vec<Project> {
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
    out
}

/// Чего хочет ответ агрегатора.
///
/// Список в ответе один, и принадлежит он не машине, а самому ответу:
/// хоткеи живут в конфиге windows11-manager, а проекты, на которые они
/// указывают, лежат на машине источника и открываются оттуда с любой машины.
/// Поэтому веток две.
///
/// **Своя машина** — верхний `windowHost` совпал с конфигом. Список берётся
/// целиком, включая пустой: живой трекер сказал, что в конфиге пусто, и
/// `Some(vec![])` честно снимает регистрации.
///
/// **Чужой список, взятый живой машиной** — имя этой машины названо среди
/// `windowHosts`, а список непуст. Это мак: верхний `windowHost` называет ту
/// машину, чьи хоткеи мы взяли (`lead` в `read_window_sources` предпочитает
/// источник с хоткеями), то есть на маке он всегда чужой, и сравнение с ним
/// значило «клавиши работают только на Windows». Пустой чужой список при этом
/// не снимает ничего: ляжет Windows-трекер — `lead` съедет на мак, `projects`
/// приедут без хоткеев, и прочти это Windows-машина как «хоткеев больше нет»,
/// она снимала бы свои же клавиши на каждую перезагрузку соседа.
///
/// `None` — «трогать нечего»: ответ про окна ничего не знает (пустой
/// `windowHost`: `read_windows` на той стороне на любой отказ возвращает
/// пустоту целиком), либо своей машины нет среди живых трекеров, либо чужой
/// список пуст. Различить «менеджер убрал хоткей» и «трекер лежит» больше
/// нечем: строки `projects` в ответе есть всегда, они собираются из закладок
/// ccfzf.
pub fn wanted_from_state(state: &serde_json::Value, own_host: &str) -> Option<Vec<Project>> {
    let host = state.get("windowHost").and_then(|v| v.as_str()).unwrap_or("");
    let host_norm = norm_host(host);
    let own_norm = norm_host(own_host);
    if own_norm.is_empty() {
        return None;
    }
    let list = hotkeys_of(state);
    if !host_norm.is_empty() && host_norm == own_norm {
        return Some(list);
    }
    if !list.is_empty() && names_tracker(state, &own_norm) {
        return Some(list);
    }
    None
}

/// Возьмётся ли менеджер **этой** машины открыть терминал по просьбе.
///
/// Тот же ответ, что странице дают `openManager` и `chooseOpenTransport`
/// (`session-windows.js`, `open-transport.js`): просьба уходит менеджеру
/// только на его собственной машине, а не на первой попавшейся из списка.
/// Спрашивается здесь потому, что клавишу жмут при скрытом пикере, где
/// webview усыплён целиком, — по той же причине, по какой в Rust живут имя
/// терминала и порядок плитки.
///
/// Мак объявляет `openSession: false`: терминалы там открывает сам пикер, и
/// ушедшая туда просьба не нашла бы разбирающего — молча, ответа у публикации
/// нет. Отсутствие поля читается как «берётся»: windows11-manager его не
/// пишет и не должен, то же правило, что у `canFocus`.
///
/// Списка трекеров нет вовсе (старый агрегатор, ответа поллера ещё не было) —
/// прежняя дорога, публикация: иначе Windows-машина первые секунды после
/// старта, пока висят клавиши из `hotkeys.json`, уезжала бы на местную
/// дорогу, которой у неё нет.
pub fn manager_takes_open(state: &serde_json::Value, own_host: &str) -> bool {
    let Some(hosts) = state.get("windowHosts").and_then(|v| v.as_array()) else {
        return true;
    };
    let own_norm = norm_host(own_host);
    if own_norm.is_empty() {
        return false;
    }
    hosts.iter().any(|e| {
        e.get("host").and_then(|v| v.as_str()).map(norm_host).as_deref() == Some(own_norm.as_str())
            && e.get("openSession").and_then(|v| v.as_bool()) != Some(false)
    })
}

/// Ответ несёт хоткеи, а взять их некому — сказать об этом ровно раз.
///
/// Взять чужой список вправе любая машина с живым трекером, поэтому остаётся
/// ровно один случай, когда клавиш не будет при непустом списке: имени этой
/// машины нет среди `windowHosts`. Причин у него две — опечатка в
/// `windowHost` конфига и лежачий трекер, — и обе дают ровно ту картину, ради
/// которой заметка и заведена: клавиши не работают, и молчат обе стороны.
/// Обе стороны сравнения — в строке: иначе человеку негде увидеть, какое имя
/// писать в конфиг.
pub fn host_mismatch_note(state: &serde_json::Value, own: &str) -> Option<String> {
    if wanted_from_state(state, own).is_some() {
        return None;
    }
    // Наше имя названо среди живых трекеров, а список всё равно не взят —
    // значит, он пуст, и жаловаться не на что. Заметка ниже говорит о
    // непустом списке, до которого этой машине не дотянуться.
    if names_tracker(state, &norm_host(own)) {
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

/// Нажали проектный хоткей.
///
/// Дорог две, и выбирает между ними не место в коде, а тот же вопрос, каким
/// его решает страница (`chooseProjectOpenAction`): берётся ли менеджер
/// **этой** машины открывать терминалы.
///
/// Берётся — уходит просьба, а не решение. Развилку «поднять окно или завести
/// сессию» принимает тогда менеджер: правило «последняя открытая сессия этого
/// каталога» уже написано и покрыто тестами у него (`pickOpenProjectSession`),
/// список пикера у скрытого окна отстаёт до восьми минут, и профиль Windows
/// Terminal по каталогу знает тоже только он.
///
/// Не берётся (мак: `openSession: false`) или брокера нет вовсе — нажатие
/// уезжает на страницу событием `project-hotkey`, и терминал открывает пикер
/// сам, ровно как по Enter на строке проекта. Опубликуй мы просьбу и здесь,
/// она ушла бы в топик, который никто не слушает, — молча, ответа у публикации
/// нет.
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
            ccfzf_log!("cannot read config, falling back to a new session: {e}");
            serde_json::Value::Null
        }
    };
    // Что делает нажатие: завести новую сессию (умолчание) или поднять уже
    // открытое окно проекта. Умолчание названо здесь, у самого нажатия, а не в
    // таблице: та отвечает на вопрос «что бывает», а не «что по умолчанию у
    // этого входа». Читается на каждом нажатии, как терминал и курсор ниже.
    //
    // Умолчание у клавиши то же, что у строки списка, и это решение владельца,
    // проверенное на живых машинах: `focus` работает ровно тогда, когда окно
    // каталога есть в снимке пикера, а у скрытого окна тот отстаёт до восьми
    // минут — то есть «вернуться туда, где работа идёт» сбывалось через раз, и
    // предсказать, чем кончится нажатие, было нечем.
    //
    // Считается до развилки транспорта: обеим дорогам нужно одно и то же
    // решение, и второй его экземпляр на странице разошёлся бы с этим.
    let action = crate::project_open_action(&raw, "projectHotkeyAction", "new");
    let broker = crate::mqtt::broker_from_config(&raw);
    let own = raw
        .get("windowHost")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let takes_open = manager_takes_open(&last_state(app), own);
    if !broker.is_configured() || !takes_open {
        // Просить некого: либо брокера в конфиге нет (см. `is_configured` в
        // `mqtt.rs`), либо менеджер этой машины открытием не занимается —
        // мак. Прежняя дорога: страница открывает терминал сама, тем же
        // способом, каким его открывает Enter на строке проекта.
        //
        // Действие едет с каталогом: `projectHotkeyAction` читает Rust (у
        // скрытого пикера webview усыплён), а страница про этот ключ не знает
        // — у неё свой, `projectOpenAction`, и он про другой повод.
        ccfzf_log!(
            "{}, opening {cwd} from the picker itself",
            if broker.is_configured() {
                "no manager takes open requests on this machine"
            } else {
                "mqtt broker is not configured"
            }
        );
        let _ = app.emit(
            "project-hotkey",
            serde_json::json!({ "cwd": cwd, "action": action }),
        );
        return;
    }

    // Грамота уходит до публикации: нажатие хоткея — последнее событие ввода, и
    // оно наше, а через секунду право отдавать будет уже нечем. Кому именно —
    // не выбираем: исполнителей у просьбы трое (демон, служба MQTT, новый
    // `wt.exe`), см. `allow_any_foreground`.
    crate::allow_any_foreground();

    // Публикация ждёт подтверждения брокера до пяти секунд — держать на этом
    // поток, из которого плагин зовёт обработчик, нельзя. Ответа у просьбы нет
    // по замыслу, как у фокуса и восстановления: приёмник отчитывается в свой
    // журнал, а не нам.
    let cwd = cwd.to_string();
    // Ответа агрегатора здесь нет — только конфиг, поэтому просимый адрес
    // всегда пуст, и `resolve_base` откатывается на базу из конфига.
    let base = crate::mqtt::resolve_base(&broker, "");
    // Имя терминала считается здесь же, из того же прочитанного конфига:
    // спросить страницу нельзя — у скрытого пикера webview усыплён целиком, а
    // хоткей нажимают ровно тогда, когда пикер скрыт. Ради этого имя и живёт в
    // Rust, а не в `settings-form.js`.
    let terminal = crate::mqtt::terminal_name(&raw);
    // Точка курсора — оттуда же и по той же причине, что имя терминала: галка
    // `openOnActiveDisplay` живёт в конфиге, а спросить страницу нельзя. Своя
    // ли это машина, здесь не спрашивают: до этой строки доезжает только та,
    // чей менеджер сам и принимает просьбу (`manager_takes_open` выше).
    // Ctrl у клавиши нет: нажимают её вслепую, при скрытом пикере, — то есть
    // «открой там, куда я смотрю» здесь спросить не у кого. Отсюда `false`, и
    // просьба уходит с одной лишь галкой, как уходила всегда.
    let place = crate::placement(app, &raw, false);
    // Ветка на каждое значение `PROJECT_OPEN_ACTIONS`; сторож —
    // `every_project_open_action_is_handled` в main.rs. Значение без ветки
    // нажатие бы проглотило: ни ошибки, ни следа.
    let name = match action {
        // Имя обязано считаться здесь: менеджер списка занятых не ведёт и взял
        // бы basename каталога — то самое имя, которое уже носит открытая
        // сессия, — а два окна с одним заголовком трекер привяжет к одному
        // слоту. Ради этого `session_name` и продублирован в Rust.
        "new" => new_session_name(app, &cwd),
        "focus" => String::new(),
        other => {
            // Сюда не доезжает ничего: `project_open_action` уже привела
            // значение к известному. Ветка всё равно обязана быть, и молчать в
            // ней нельзя — иначе клавиша сделала бы не то, что выбрано.
            ccfzf_log!("unknown projectHotkeyAction {other}, raising the open window");
            String::new()
        }
    };
    tauri::async_runtime::spawn_blocking(move || {
        // Пустое имя — это ветка `focus` либо отказ считать имя (путь с `;`,
        // пустой каталог): в обоих случаях уходит прежняя просьба, и открытое
        // окно поднимет менеджер. Про отказ уже сказано в журнал.
        let sent = if name.is_empty() {
            crate::mqtt::open_project(&broker, &base, &cwd, &terminal, place)
        } else {
            crate::mqtt::open_new(&broker, &base, &cwd, &name, &terminal, place)
        };
        if let Err(e) = sent {
            ccfzf_log!("cannot ask to open {cwd}: {e}");
        }
    });
}

/// Последний ответ поллера, или `Null` — «спросить не у кого».
///
/// Один читатель на два вопроса нажатия: куда уходит просьба
/// (`manager_takes_open`) и какие имена сессий заняты (`new_session_name`).
/// Ответ берётся у поллера, а не спрашивается заново: спрашивать — это ssh на
/// той стороне, а мы стоим в обработчике клавиши.
fn last_state(app: &tauri::AppHandle) -> serde_json::Value {
    app.try_state::<crate::poller::Poller>()
        .map(|p| p.snapshot())
        .and_then(|s| s.get("state").cloned())
        .unwrap_or(serde_json::Value::Null)
}

/// Свободное имя для сессии, которую заведёт это нажатие.
///
/// Занятые — заголовки живых сессий из последнего ответа поллера плюс имена,
/// выданные прошлыми нажатиями. Ответ берётся у поллера, а не спрашивается
/// заново: у скрытого окна он отстаёт до восьми минут (бэкофф в `poller.rs`),
/// и ровно поэтому одного его мало — за это отставание успевают открыться
/// сессии, о которых он ещё не знает. Дыру закрывает `session_name::issued`.
///
/// Пустая строка значит «имени нет»: путь с `;` (Windows Terminal режет по
/// нему командную строку до всякого шелла) или каталог без basename. Вызывающий
/// на неё откатывается к прежней просьбе, а не молчит.
fn new_session_name(app: &tauri::AppHandle, cwd: &str) -> String {
    let state = last_state(app);
    let mut taken = crate::session_name::live_names(&state);
    taken.extend(crate::session_name::issued(Instant::now()));
    let name = crate::session_name::new_session_name(cwd, &taken);
    if name.is_empty() {
        ccfzf_log!("cannot name a session for {cwd}, asking to raise the open window instead");
        return name;
    }
    // Занимается до отправки, а не после: публикация ждёт брокера до пяти
    // секунд, и второе нажатие за это время увидело бы то же самое.
    crate::session_name::issue(&name);
    name
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
                ccfzf_log!("cannot register hotkey {}: {e}", project.hotkey);
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
        ccfzf_log!("cannot remember hotkeys: {e}");
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
            SAID.call_once(|| ccfzf_log!("{note}"));
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


    /// Мак берёт список, опубликованный Windows-машиной.
    ///
    /// Верхний `windowHost` называет ту машину, чей это список (`lead` в
    /// `read_window_sources` предпочитает источник с хоткеями), и до этой
    /// правки сравнение с ним значило «клавиши работают только там». На маке
    /// проекты те же самые — они лежат на машине ssh-источника, — и открыть их
    /// оттуда пикер умеет; терять из-за имени машины было нечего.
    #[test]
    fn a_live_tracker_takes_the_published_list() {
        let s = serde_json::json!({
            "windowHost": "tracker-host",
            "windowHosts": [{"host": "tracker-host"}, {"host": "mac"}],
            "projects": [{"path": "/p/one", "hotkey": "Ctrl+F11"}],
        });
        assert_eq!(
            wanted_from_state(&s, "mac"),
            Some(vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() }])
        );
    }

    /// Взять чужой список вправе только машина с живым трекером: её имя
    /// названо среди `windowHosts`. Не названо — это либо опечатка в конфиге,
    /// либо лежачий трекер, и в обоих случаях вешать клавиши не на что
    /// опереться: `press` этой же машины спросит тот же список о том, куда
    /// уходит просьба.
    #[test]
    fn a_machine_no_tracker_knows_takes_nothing() {
        let s = serde_json::json!({
            "windowHost": "tracker-host",
            "windowHosts": [{"host": "tracker-host"}],
            "projects": [{"path": "/p/one", "hotkey": "Ctrl+F11"}],
        });
        assert_eq!(wanted_from_state(&s, "mac"), None);
    }

    /// Пустой чужой список не снимает ничего: снимать вправе только хозяин.
    ///
    /// Случай живой: ляжет Windows-трекер — `lead` съедет на мак, и верхним
    /// хостом станет он, а `projects` останутся без хоткеев. Прочти это
    /// Windows-машина как «хоткеев больше нет», она сняла бы свои же клавиши
    /// на каждую перезагрузку соседа.
    #[test]
    fn a_foreign_empty_list_clears_nothing() {
        let s = serde_json::json!({
            "windowHost": "mac",
            "windowHosts": [{"host": "mac"}, {"host": "tracker-host"}],
            "projects": [{"path": "/p/one"}],
        });
        assert_eq!(wanted_from_state(&s, "tracker-host"), None);
    }

    /// Своя машина ведёт себя как раньше и на пустом списке — снимает.
    #[test]
    fn the_owner_still_clears_on_an_empty_list() {
        let s = serde_json::json!({
            "windowHost": "tracker-host",
            "windowHosts": [{"host": "tracker-host"}, {"host": "mac"}],
            "projects": [{"path": "/p/one"}],
        });
        assert_eq!(wanted_from_state(&s, "tracker-host"), Some(vec![]));
    }

    /// Просьбу об открытии принимает та машина, которая объявила `openSession`.
    ///
    /// Тот же ответ, что даёт странице `openManager` + `chooseOpenTransport`:
    /// менеджеру просьба уходит только на его собственной машине. На маке
    /// (`openSession: false`) она ушла бы в топик, который никто не слушает, —
    /// молча, потому что ответа у публикации нет.
    #[test]
    fn only_the_manager_machine_takes_the_request() {
        let s = serde_json::json!({"windowHosts": [
            {"host": "tracker-host", "openSession": true},
            {"host": "mac", "openSession": false},
        ]});
        assert!(manager_takes_open(&s, "tracker-host"));
        assert!(!manager_takes_open(&s, "mac"));
        assert!(!manager_takes_open(&s, "macbook"), "машины нет в списке вовсе");
        assert!(!manager_takes_open(&s, ""), "своё имя не названо");
    }

    /// Отсутствие поля `openSession` значит «берётся»: windows11-manager его
    /// не пишет и не должен — то же правило, что у `canFocus`.
    #[test]
    fn a_tracker_without_the_field_takes_the_request() {
        let s = serde_json::json!({"windowHosts": [{"host": "tracker-host"}]});
        assert!(manager_takes_open(&s, "TRACKER-HOST"), "регистр имени машины не значит ничего");
    }

    /// Списка трекеров нет вовсе — старый агрегатор или ответа ещё не было.
    /// Прежняя дорога: просьба уходит менеджеру, как уходила всегда. Иначе
    /// Windows-машина первые секунды после старта (клавиши висят с
    /// `hotkeys.json`, ответа поллера ещё нет) уезжала бы на местную дорогу,
    /// которой у неё нет.
    #[test]
    fn without_a_tracker_list_the_request_goes_as_before() {
        assert!(manager_takes_open(&serde_json::json!({}), "tracker-host"));
        assert!(manager_takes_open(&serde_json::Value::Null, "tracker-host"));
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

    /// Мак теперь называет себя в конфиге — иначе подъём окна не с чем
    /// сверять, — и заметка про чужие хоткеи начала бы ругаться на каждом
    /// запуске. Ругаться ей положено на «настроили не ту машину», а это
    /// отличается ровно одним: нашего имени нет среди трекеров вовсе.
    #[test]
    fn no_note_when_our_host_is_a_known_tracker() {
        let state = serde_json::json!({
            "windowHost": "windows-box",
            "windowHosts": [
                { "host": "windows-box", "pid": 42, "canFocus": true },
                { "host": "mac-host", "pid": 7, "canFocus": false },
            ],
            "projects": [{ "path": "/projects/js/picker", "hotkey": "Ctrl+F11" }],
        });
        assert!(
            host_mismatch_note(&state, "mac-host").is_none(),
            "мак — известный трекер, ругаться не на что"
        );
    }

    /// А вот имя, которого среди трекеров нет, — это и есть опечатка в
    /// конфиге, ради которой заметка заведена.
    #[test]
    fn note_stays_for_a_host_no_tracker_knows() {
        let state = serde_json::json!({
            "windowHost": "windows-box",
            "windowHosts": [{ "host": "windows-box", "pid": 42, "canFocus": true }],
            "projects": [{ "path": "/projects/js/picker", "hotkey": "Ctrl+F11" }],
        });
        let note = host_mismatch_note(&state, "windwos-box").expect("опечатку надо назвать");
        assert!(note.contains("windwos-box"), "человеку нужно его же имя: {note}");
    }

}
