//! Фоновый опрос агрегатора: отпечаток, такт и поток.

use std::time::Duration;

/// Показанное окно опрашивается раз в секунду — как было до фонового режима.
pub const VISIBLE_TICK: Duration = Duration::from_secs(1);
/// Нижний такт скрытого окна.
pub const BACKGROUND_MIN: Duration = Duration::from_secs(60);
/// Потолок бэкоффа. Восемь минут — из задачи; выше подниматься нельзя:
/// этим же опросом живёт панель openHASP, и такт — это её отставание.
pub const BACKGROUND_MAX: Duration = Duration::from_secs(8 * 60);

/// Через сколько без ввода человека машина считается простаивающей.
///
/// Пять минут — не «когда гаснет экран», а «когда точно никто не смотрит на
/// список». Меньше было бы опасно: человек, читающий с экрана длинный ответ
/// агента, ввода не делает вовсе, и опрос гас бы у него под носом.
pub const AWAY_AFTER: Duration = Duration::from_secs(5 * 60);

/// Как часто в простое освежается дамп агрегатора.
///
/// Это единственная работа, которая в простое остаётся, и мерка ей не своя:
/// дамп читает windows11-manager, а из него живут Home Assistant и плата
/// openHASP. Порог самого агрегатора вдвое ниже (`STATE_DUMP_MAX_AGE`, 30 с),
/// то есть минута — это отставание платы, за которое заплачено вдвое меньшим
/// числом походов по ssh. Больше платить нечем: трекер и так не видит новую
/// сессию быстрее 15 с (кэш индекса `sessions.js`).
pub const AWAY_DUMP_TICK: Duration = Duration::from_secs(60);

/// Кусок, которым проспан фоновый такт, пока под присмотром сигнал трекера.
///
/// Секунда — не такт опроса, а частота одного локального `stat`: сам опрос
/// по-прежнему идёт по бэкоффу, и цена этой секунды ровно один системный
/// вызов.
pub const SIGNAL_TICK: Duration = Duration::from_secs(1);

/// Всплеск опроса после своего же действия, кончающегося терминалом.
///
/// Это **смещения от действия**, а не промежутки между опросами: спека
/// называет +3, +8 и +20 секунд, и весь всплеск обязан уложиться в двадцать.
/// Иначе рассыпается довод, ради которого он просит принудительный дамп:
/// порог дампа в агрегаторе — тридцать секунд, и опрос, съехавший за него,
/// прочитал бы ровно тот же прошлый дамп, что и без всплеска.
///
/// Три шага, потому что окно приезжает не сразу: терминал поднимается секунды,
/// заголовок устаивается ещё два тика трекера. Дальше работу забирает сигнал —
/// досиживать до появления окна всплеск не обязан.
pub const BURST: [Duration; 3] = [
    Duration::from_secs(3),
    Duration::from_secs(8),
    Duration::from_secs(20),
];

/// Следующий шаг расписания: его номер и смещение от действия. `None` —
/// всплеск кончился.
pub fn burst_next(step: usize) -> Option<(usize, Duration)> {
    BURST.get(step + 1).map(|at| (step + 1, *at))
}

/// Пора ли всплеску опрашивать: прошло ли от действия смещение своего шага.
///
/// Решение это молчаливое, а поток будят и сигналы из канала, и трекер, и
/// конец чужого сна — поэтому спрашивается оно от прошедшего времени, а не от
/// того, чем кончился сон. Без `Instant` в подписи, чтобы тест мог подставить
/// любое время: тела потока в юнит-тесте не поднять.
pub fn burst_due(step: usize, elapsed: Duration) -> bool {
    // Шага нет — расписание кончилось, и держать опрос больше нечем.
    BURST.get(step).map_or(true, |at| elapsed >= *at)
}

/// Сколько спать до опроса нынешнего шага.
///
/// Остаток до точки, а не промежуток от прошлого опроса: считается от того же
/// якоря, поэтому чужое пробуждение посреди расписания точек не сдвигает.
/// `saturating_sub` — опоздали (долгий ssh, порченая таблица) — опрос
/// немедленный, а не паника в потоке.
pub fn burst_sleep(step: usize, elapsed: Duration) -> Duration {
    BURST.get(step).map_or(Duration::ZERO, |at| at.saturating_sub(elapsed))
}

/// Сколько ждать до следующего опроса.
///
/// Смена видимости в формулу не входит: её обрабатывает поток, подменяя
/// `prev`. Поэтому нижняя граница проверяется здесь явно — секундный такт,
/// доставшийся от показанного окна, не должен удвоиться в две секунды.
pub fn next_delay(visible: bool, changed: bool, prev: Duration) -> Duration {
    if visible {
        return VISIBLE_TICK;
    }
    if changed {
        return BACKGROUND_MIN;
    }
    let doubled = prev.saturating_mul(2);
    doubled.clamp(BACKGROUND_MIN, BACKGROUND_MAX)
}

/// Отпечаток состояния: то же ли это, что в прошлый раз.
///
/// Из ответа выброшены `generated` и все `age` — они считаются от «сейчас» и
/// отличаются на каждом опросе. Остальное (`mtime`, `live`, `title`, окна,
/// снимки, проекты) и есть активность.
///
/// Строка, а не хэш: сравнение идёт раз в минуту, экономить не на чем, а
/// увидеть разницу в отладке по строке можно, по хэшу — нет. Порядок ключей
/// стабилен сам: `serde_json::Map` без фичи `preserve_order` — это BTreeMap.
pub fn fingerprint(state: &serde_json::Value) -> String {
    let mut copy = state.clone();
    if let Some(obj) = copy.as_object_mut() {
        obj.remove("generated");
        if let Some(sessions) = obj.get_mut("sessions").and_then(|v| v.as_array_mut()) {
            for session in sessions {
                if let Some(fields) = session.as_object_mut() {
                    fields.remove("age");
                }
            }
        }
    }
    copy.to_string()
}

use crate::state_source::Source;
use crate::tracker_signal;

/// Сложить ответы источников в пару «состояние, текст отказа».
///
/// Чистая и отдельная от `poll_once`: настоящий ssh в тесте не поднять, а
/// правило «отказ одного не гасит второй» — единственное, что здесь можно
/// сделать неправильно.
///
/// Отказ называет источник поимённо: `local: ccfzf not found` и
/// `remote-host: exited with 255` — разные беды, и чинят их в разных местах.
pub fn combine(
    parts: Vec<(Source, Result<serde_json::Value, String>)>,
) -> (Option<serde_json::Value>, String) {
    let mut good = Vec::new();
    let mut errors = Vec::new();
    for (source, part) in parts {
        match part {
            Ok(state) => good.push((source, state)),
            Err(e) => errors.push(format!("{}: {e}", source.label())),
        }
    }
    let state = if good.is_empty() {
        None
    } else {
        Some(crate::merge_state::merge_states(&good))
    };
    (state, errors.join("; "))
}

/// Опросить все источники по очереди.
///
/// По очереди, а не параллельно: поток здесь один, источников два, а
/// таймауты у ssh уже выставлены (`ConnectTimeout=5`, `ServerAlive*`), то есть
/// худший случай ограничен. Второй поток стоил бы синхронизации ради секунд.
pub fn poll_once(sources: &[Source], fresh_dump: bool) -> (Option<serde_json::Value>, String) {
    let parts = sources
        .iter()
        .map(|s| (s.clone(), crate::state_source::fetch(s, fresh_dump)))
        .collect();
    combine(parts)
}

/// Освежить дампы всех источников, ничего себе не забирая.
///
/// Такт простоя: состояние никому не нужно, а дамп нужен панели. Отказ
/// называет источник поимённо и той же строкой, что у опроса, — читателю у
/// неё одно место, поле `error` в кэше, и две разных формулировки одной беды
/// он принял бы за две беды.
pub fn dump_once(sources: &[Source]) -> String {
    let errors: Vec<String> = sources
        .iter()
        .filter_map(|s| crate::state_source::refresh_dump(s).err().map(|e| format!("{}: {e}", s.label())))
        .collect();
    errors.join("; ")
}

use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

/// Что поток узнаёт извне.
enum Signal {
    /// Окно показано: отдать кэш немедленно и перейти на секундный такт.
    Shown,
    /// Окно скрыто: вернуться на минутный такт, а не на накопленный бэкофф —
    /// человек только что смотрел на список, и первый фоновый опрос должен
    /// быть скорым.
    Hidden,
    /// Опросить сейчас (первая подписка фронтенда, смена настроек).
    Nudge,
    /// Пикер сам открыл что-то, кончающееся терминалом. Не опрос, а
    /// расписание: на само нажатие опрашивать нечего, терминал ещё не поднялся.
    Opened,
}

/// Последнее, что известно об агрегаторе.
///
/// Отказ хранится рядом с ответом, а не вместо него: оборвавшийся ssh в
/// закрытом окне сообщать некому, а выбрасывать из-за него уже показанный
/// список — значит гасить работающий пикер из-за чужой сети.
#[derive(Default)]
struct Cache {
    state: Option<serde_json::Value>,
    error: String,
}

/// Отправитель под мьютексом, а не голый.
///
/// `tauri::State` требует `Send + Sync`, а `Sender` стал `Sync` только в
/// Rust 1.72 — на более раннем тулчейне сборка падала бы с непонятной
/// ошибкой о трейте. Мьютекс здесь ничего не стоит: отправка идёт на нажатие
/// клавиши, а не в цикле.
pub struct Poller {
    tx: Mutex<Sender<Signal>>,
    cache: Arc<Mutex<Cache>>,
    settings: Arc<Mutex<(Vec<Source>, bool)>>,
}

fn payload(cache: &Cache) -> serde_json::Value {
    serde_json::json!({
        "state": cache.state.clone(),
        "error": cache.error.clone(),
    })
}

/// Чем кончилось ожидание.
enum Woke {
    Got(Signal),
    Elapsed,
    Tracker,
    Gone,
}

/// Проспать срок, поглядывая на сигнал трекера.
///
/// Кусками по `SIGNAL_TICK`, а не одним сном: у скрытого окна срок доходит до
/// восьми минут, и всё это время поток нечем разбудить, кроме сигнала из
/// канала. Без сторожа (показанное окно, выключенный фон) спим одним куском —
/// лишний системный вызов в секунду там ни за что.
fn wait_for(
    rx: &Receiver<Signal>,
    wait: Duration,
    mut watcher: Option<&mut tracker_signal::Watcher>,
) -> Woke {
    let deadline = std::time::Instant::now() + wait;
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return Woke::Elapsed;
        }
        let slice = if watcher.is_some() { left.min(SIGNAL_TICK) } else { left };
        match rx.recv_timeout(slice) {
            Ok(signal) => return Woke::Got(signal),
            Err(RecvTimeoutError::Disconnected) => return Woke::Gone,
            Err(RecvTimeoutError::Timeout) => {
                if let Some(w) = watcher.as_deref_mut() {
                    if w.changed() {
                        return Woke::Tracker;
                    }
                }
            }
        }
    }
}

impl Poller {
    /// Поднять поток опроса. Окно на старте скрыто.
    pub fn start(app: tauri::AppHandle, sources: Vec<Source>, background: bool) -> Poller {
        let (tx, rx) = channel::<Signal>();
        let cache = Arc::new(Mutex::new(Cache::default()));
        let settings = Arc::new(Mutex::new((sources, background)));

        let thread_cache = Arc::clone(&cache);
        let thread_settings = Arc::clone(&settings);
        std::thread::spawn(move || {
            let mut visible = false;
            let mut delay = BACKGROUND_MIN;
            let mut prev_fingerprint: Option<String> = None;
            // Номер шага и момент действия. Якорь, а не флаг: опрос
            // отмеряется от `Opened`, и чем бы поток ни разбудили посреди
            // расписания, точки опроса не сдвигаются.
            let mut burst: Option<(usize, std::time::Instant)> = None;
            // Простой машины и момент последнего освежённого в нём дампа.
            // Флаг нужен ради возврата человека: бэкофф, накопленный до
            // простоя, к вернувшемуся отношения не имеет.
            let mut was_away = false;
            let mut last_dump: Option<std::time::Instant> = None;
            let mut watcher =
                tracker_signal::Watcher::new(crate::state_path(tracker_signal::FILE).ok());

            loop {
                let (sources, background) = thread_settings.lock().unwrap().clone();

                // Спрашивать некого — единственная проверка ненастроенности.
                // Раньше их было две, и вторая молчала бы, разойдясь с первой.
                let idle = sources.is_empty() || (!visible && !background);
                if sources.is_empty() {
                    let mut cache = thread_cache.lock().unwrap();
                    // Текст общий на все три места, где он виден человеку
                    // (здесь, sessions.html и settings-form.js), — намеренно
                    // дословно один и тот же: разная формулировка одной и той
                    // же беды читалась бы как две разных.
                    cache.error =
                        "no source: set the host with sessions, or turn on sessions from this machine"
                            .to_string();
                    if visible {
                        let body = payload(&cache);
                        drop(cache);
                        let _ = app.emit("state", body);
                    }
                }
                // Всплеск идёт только у скрытого окна: показанное опрашивает
                // раз в секунду само, и расписание всплеска замедлило бы его до
                // трёх. Пауза, а не гашение: `Opened` приходит со страницы
                // раньше `Hidden` (сперва `spawn_detached`, следом
                // `hide_picker`), то есть при живом ещё показанном окне, — и
                // погаси мы всплеск здесь, до дела он не дошёл бы ни разу.
                let bursting = if visible { None } else { burst };
                let due =
                    bursting.map_or(true, |(step, started)| burst_due(step, started.elapsed()));
                // Человека за машиной нет: тянуть состояние себе в кэш незачем
                // — смотреть на список некому, — а дамп на агрегаторе освежать
                // надо, им живёт панель openHASP.
                //
                // Спрашивается это только у скрытого окна при работающем фоне:
                // показанное окно и так опрашивает раз в секунду, а
                // выключенный человеком фон простой воскрешать не вправе — как
                // и сигнал трекера ниже. Всплеск простой перебивает целиком:
                // его завело своё же действие человека, и оно младше любого
                // порога.
                let away = !visible && !idle && bursting.is_none() && crate::user_idle::away(AWAY_AFTER);
                // Человек вернулся: бэкофф начинается заново, и опрос идёт этим
                // же витком — вернувшемуся отдаётся свежий список, а не тот,
                // что застыл к началу простоя. Показанного окна это не
                // касается: ему такт ставит ветка `Shown`.
                if was_away && !away && !visible {
                    delay = BACKGROUND_MIN;
                }
                was_away = away;

                if away {
                    if last_dump.map_or(true, |at| at.elapsed() >= AWAY_DUMP_TICK) {
                        let error = dump_once(&sources);
                        // Скрытому окну отказ сообщать некому — оно узнает при
                        // показе, той же дорогой, что и отказ опроса. Удача
                        // строку чистит: ssh, который только что ответил, —
                        // это ответ и на прошлую жалобу.
                        thread_cache.lock().unwrap().error = error;
                        last_dump = Some(std::time::Instant::now());
                    }
                } else if !idle && due {
                    let fresh_dump = bursting.is_some();
                    let (state, error) = poll_once(&sources, fresh_dump);
                    let changed = match state {
                        Some(state) => {
                            let fp = fingerprint(&state);
                            let changed = prev_fingerprint.as_deref() != Some(fp.as_str());
                            prev_fingerprint = Some(fp);
                            crate::project_hotkeys::apply_from_state(&app, &state);
                            let mut cache = thread_cache.lock().unwrap();
                            cache.state = Some(state);
                            cache.error = error;
                            let body = payload(&cache);
                            drop(cache);
                            let _ = app.emit("state", body);
                            changed
                        }
                        None => {
                            let mut cache = thread_cache.lock().unwrap();
                            cache.error = error;
                            // Показанному окну об отказе говорим сразу;
                            // скрытому — некому, и оно узнает при показе.
                            if visible {
                                let body = payload(&cache);
                                drop(cache);
                                let _ = app.emit("state", body);
                            }
                            // Отказ — это «не изменилось»: сеть, лежащая
                            // десять минут, не повод десять минут долбить ssh.
                            false
                        }
                    };
                    if let Some((step, started)) = bursting {
                        // Шаг съеден: следующий отмеряется от того же якоря.
                        burst = burst_next(step).map(|(next, _)| (next, started));
                    }
                    // Обычный такт считается, только когда всплеск не идёт: под
                    // всплеском срок берётся от якоря, а бэкофф стоит
                    // нетронутым и продолжит с того такта, на котором его
                    // прервали.
                    if bursting.is_none() || burst.is_none() {
                        delay = next_delay(visible, changed, delay);
                    }
                }

                // Всплеск пересчитан: опрос мог съесть шаг, а мог и длиться
                // секунды — сон всё равно отмеряется от якоря, а не от конца
                // прошлого сна.
                let bursting = if visible { None } else { burst };
                // Спящий поток ждёт либо срока, либо сигнала. `recv_timeout`
                // на закрытом канале выходит из цикла: приложение кончилось.
                let wait = if idle {
                    Duration::from_secs(3600)
                } else if away {
                    // Кусками по секунде, а не одним сном на минуту: спит здесь
                    // не опрос, а ожидание человека, и заметить его возвращение
                    // надо тотчас. Цена куска — один системный вызов, ровно как
                    // у сторожа сигнала, которым спит обычный фоновый такт.
                    SIGNAL_TICK
                } else if let Some((step, started)) = bursting {
                    burst_sleep(step, started.elapsed())
                } else {
                    delay
                };
                // Сторож смотрится только у скрытого окна и только при
                // работающем фоне: показанное и так опрашивает раз в секунду, а
                // выключенный человеком фон сигнал воскрешать не вправе. В
                // простое он тоже молчит: сигнал заведён ради снимка для
                // проектного хоткея, а хоткей нажимает тот, кого за машиной нет.
                let watching = !visible && !idle && !away;
                match wait_for(&rx, wait, if watching { Some(&mut watcher) } else { None }) {
                    Woke::Got(Signal::Shown) => {
                        visible = true;
                        delay = VISIBLE_TICK;
                        // Показанное окно опрашивает раз в секунду — всплеску
                        // тут делать нечего, и досиживать его незачем.
                        burst = None;
                        // Кэш отдаётся до опроса: ради этого фон и заведён —
                        // список рисуется, не дожидаясь ssh.
                        let cache = thread_cache.lock().unwrap();
                        let body = payload(&cache);
                        drop(cache);
                        let _ = app.emit("state", body);
                    }
                    Woke::Got(Signal::Hidden) => {
                        visible = false;
                        delay = BACKGROUND_MIN;
                    }
                    Woke::Got(Signal::Opened) => {
                        // Якорь ставится здесь и больше не двигается: `Hidden`,
                        // посланный страницей следом, расписания не сдвинет.
                        burst = Some((0, std::time::Instant::now()));
                    }
                    Woke::Got(Signal::Nudge) => {
                        let cache = thread_cache.lock().unwrap();
                        let body = payload(&cache);
                        drop(cache);
                        let _ = app.emit("state", body);
                    }
                    // Трекер сказал, что состав окон изменился: опрос на
                    // следующем витке, без всякой задержки.
                    Woke::Tracker | Woke::Elapsed => {}
                    Woke::Gone => return,
                }
            }
        });

        Poller { tx: Mutex::new(tx), cache, settings }
    }

    fn signal(&self, signal: Signal) {
        let _ = self.tx.lock().unwrap().send(signal);
    }

    pub fn shown(&self) {
        self.signal(Signal::Shown);
    }

    pub fn hidden(&self) {
        self.signal(Signal::Hidden);
    }

    pub fn nudge(&self) {
        self.signal(Signal::Nudge);
    }

    /// Пикер открыл что-то, кончающееся терминалом.
    pub fn opened(&self) {
        self.signal(Signal::Opened);
    }

    /// Новые настройки подхватываются следующим тактом: рвать текущий ssh
    /// незачем, он всё равно вот-вот кончится.
    pub fn set_config(&self, sources: Vec<Source>, background: bool) {
        *self.settings.lock().unwrap() = (sources, background);
        self.signal(Signal::Nudge);
    }

    /// Что известно прямо сейчас — для команды `poll_now`.
    pub fn snapshot(&self) -> serde_json::Value {
        payload(&self.cache.lock().unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Два ответа, отличающиеся только временем, — одно и то же состояние.
    ///
    /// Проверка здесь потому, что ошибка невидима: сравнивая ответы целиком,
    /// бэкофф не включился бы никогда — `generated` и `age` считаются от
    /// «сейчас» и отличаются на каждом опросе. Выглядело бы это как
    /// работающая функция.
    #[test]
    fn time_alone_is_not_a_change() {
        let a = serde_json::json!({
            "generated": 1000,
            "sessions": [{"id": "s1", "mtime": 500, "age": "1m", "live": true}],
        });
        let b = serde_json::json!({
            "generated": 2000,
            "sessions": [{"id": "s1", "mtime": 500, "age": "17m", "live": true}],
        });
        assert_eq!(fingerprint(&a), fingerprint(&b));
    }

    /// Настоящая активность отпечаток меняет.
    #[test]
    fn real_activity_changes_the_fingerprint() {
        let base = serde_json::json!({
            "generated": 1000,
            "sessions": [{"id": "s1", "mtime": 500, "age": "1m", "live": true}],
        });
        let touched = serde_json::json!({
            "generated": 1000,
            "sessions": [{"id": "s1", "mtime": 900, "age": "1m", "live": true}],
        });
        let died = serde_json::json!({
            "generated": 1000,
            "sessions": [{"id": "s1", "mtime": 500, "age": "1m", "live": false}],
        });
        assert_ne!(fingerprint(&base), fingerprint(&touched));
        assert_ne!(fingerprint(&base), fingerprint(&died));
    }

    /// Окна и снимки — тоже активность: их приносит тот же ответ.
    #[test]
    fn windows_and_snapshots_count() {
        let a = serde_json::json!({"generated": 1, "sessions": [], "snapshots": []});
        let b = serde_json::json!({
            "generated": 1, "sessions": [],
            "snapshots": [{"id": "snap1", "created": 5}],
        });
        assert_ne!(fingerprint(&a), fingerprint(&b));
    }

    /// Ответ не той формы отпечаток не роняет: чинить его здесь нечем, а
    /// поток обязан пережить любой мусор с той стороны.
    #[test]
    fn junk_does_not_panic() {
        assert_eq!(fingerprint(&serde_json::json!(null)), fingerprint(&serde_json::json!(null)));
        assert_ne!(fingerprint(&serde_json::json!("строка")), fingerprint(&serde_json::json!(7)));
    }

    /// Тишина растит такт до потолка, активность сбрасывает его на минуту.
    #[test]
    fn silence_doubles_activity_resets() {
        let mut d = BACKGROUND_MIN;
        for expected in [2u64, 4, 8, 8, 8] {
            d = next_delay(false, false, d);
            assert_eq!(d, Duration::from_secs(expected * 60), "такт после тишины");
        }
        assert_eq!(next_delay(false, true, d), BACKGROUND_MIN, "активность сбрасывает");
    }

    /// Показанное окно опрашивается раз в секунду при любой предыстории.
    #[test]
    fn visible_window_always_ticks_every_second() {
        assert_eq!(next_delay(true, false, BACKGROUND_MAX), VISIBLE_TICK);
        assert_eq!(next_delay(true, true, VISIBLE_TICK), VISIBLE_TICK);
    }

    /// Секундный такт, доставшийся от показанного окна, не удваивается в
    /// секунды: скрытое окно начинает с минуты, что бы ни стояло до него.
    #[test]
    fn hidden_window_never_ticks_faster_than_a_minute() {
        assert_eq!(next_delay(false, false, VISIBLE_TICK), BACKGROUND_MIN);
    }

    use crate::state_source::Source;

    /// Отказ одного источника не гасит второй. Молчаливое выпадение половины
    /// списка — худшее, что здесь может случиться: пропавшие сессии читаются
    /// как «сессий нет», и человек пойдёт искать сессию, а не чинить ssh.
    #[test]
    fn one_failure_does_not_hide_the_other_source() {
        let parts = vec![
            (Source::Ssh("remote-host".into()), Err("exited with 255".to_string())),
            (Source::Local, Ok(serde_json::json!({"generated": 1, "sessions": [{"id": "a"}]}))),
        ];
        let (state, error) = combine(parts);
        let state = state.expect("ответивший источник обязан дать список");
        assert_eq!(state["sessions"].as_array().unwrap().len(), 1);
        assert!(error.contains("remote-host"), "отказ обязан называть источник: {error}");
    }

    /// Отказ всех — прежняя ошибка на весь список, и состояния нет.
    #[test]
    fn all_failing_is_still_an_error() {
        let parts = vec![
            (Source::Ssh("remote-host".into()), Err("exited with 255".to_string())),
            (Source::Local, Err("ccfzf not found".to_string())),
        ];
        let (state, error) = combine(parts);
        assert!(state.is_none());
        assert!(error.contains("remote-host") && error.contains("local"), "{error}");
    }

    /// Все ответили — ошибки нет вовсе.
    #[test]
    fn success_clears_the_error() {
        let parts = vec![(Source::Local, Ok(serde_json::json!({"generated": 1, "sessions": []})))];
        let (state, error) = combine(parts);
        assert!(state.is_some());
        assert_eq!(error, "");
    }

    #[test]
    fn the_burst_has_three_steps_and_then_ends() {
        assert_eq!(BURST.len(), 3, "расписание названо в спеке: 3, 8, 20 секунд");
        assert_eq!(BURST[0], Duration::from_secs(3));
        // Отдаётся смещение следующего шага от действия: вычитание живёт в
        // одном месте — в `burst_sleep`, где считается сон.
        assert_eq!(burst_next(0), Some((1, Duration::from_secs(8))));
        assert_eq!(burst_next(1), Some((2, Duration::from_secs(20))));
        assert_eq!(burst_next(2), None, "после третьего шага — обычный бэкофф");
    }

    /// Прогон расписания ровно так, как его проходит поток: решение «пора
    /// ли», опрос, шаг, сон до своей точки. `wakes` — чужие пробуждения
    /// (секунды от действия), приходящие не по своему сну: `Hidden`, посланный
    /// страницей следом за `Opened`, сигнал трекера, что угодно ещё.
    ///
    /// Возвращает моменты опросов, считая от якоря.
    fn a_burst_run(wakes: &[u64]) -> Vec<Duration> {
        let mut step = 0;
        let mut now = Duration::ZERO;
        let mut polls = Vec::new();
        for _ in 0..100 {
            if burst_due(step, now) {
                polls.push(now);
                match burst_next(step) {
                    Some((next, _)) => step = next,
                    None => return polls,
                }
            }
            let till = now + burst_sleep(step, now);
            now = wakes
                .iter()
                .map(|s| Duration::from_secs(*s))
                .filter(|w| *w > now && *w < till)
                .min()
                .unwrap_or(till);
        }
        panic!("расписание не кончилось — всплеск зациклился");
    }

    #[test]
    fn burst_polls_land_at_three_eight_and_twenty_seconds() {
        // Стеречь надо смещения, названные спекой, а не промежуточную
        // арифметику: перепиши кто-нибудь `burst_next` или `burst_sleep` —
        // порознь они сойдутся сами с собой, а точки разъедутся.
        assert_eq!(
            a_burst_run(&[]),
            vec![Duration::from_secs(3), Duration::from_secs(8), Duration::from_secs(20)],
            "весь всплеск обязан уложиться в двадцать секунд — в порог дампа"
        );
    }

    #[test]
    fn no_poll_comes_sooner_than_three_seconds_after_the_action() {
        // Разбудить поток может что угодно, и ни один из будильников не вправе
        // стронуть первый опрос: терминал ещё не поднялся, сессия ещё не
        // родилась, и принудительный дамп ушёл бы впустую.
        assert!(!burst_due(0, Duration::ZERO), "разбудили сразу — опрашивать рано");
        assert!(!burst_due(0, Duration::from_millis(2999)));
        assert!(burst_due(0, Duration::from_secs(3)));
    }

    #[test]
    fn an_unrelated_wakeup_mid_burst_does_not_shift_the_schedule() {
        // Живой случай, из-за которого якорь и заведён: страница зовёт
        // `spawn_detached` (там `opened`), а следом `hide_picker` (там
        // `hidden`), и `Hidden` лежит в канале уже к первому сну. На цепочке
        // относительных снов это давало опросы на +0, +5 и +17: первый — тот
        // самый, которого спека запрещает, и он же тратил дамп впустую.
        let точки = vec![Duration::from_secs(3), Duration::from_secs(8), Duration::from_secs(20)];
        assert_eq!(a_burst_run(&[1]), точки, "Hidden сразу за Opened");
        assert_eq!(a_burst_run(&[1, 4, 5, 9, 12, 19]), точки, "и трекер, и что угодно ещё");
    }

    #[test]
    fn a_burst_sleep_is_the_remainder_up_to_its_own_point() {
        assert_eq!(burst_sleep(0, Duration::ZERO), Duration::from_secs(3));
        assert_eq!(burst_sleep(0, Duration::from_secs(1)), Duration::from_secs(2));
        assert_eq!(burst_sleep(1, Duration::from_secs(3)), Duration::from_secs(5));
        // Опоздали (долгий ssh) — спать нечего, опрос немедленный.
        assert_eq!(burst_sleep(2, Duration::from_secs(25)), Duration::ZERO);
    }

    #[test]
    fn the_first_burst_step_is_never_sooner_than_three_seconds() {
        // Раньше — впустую: терминал ещё не поднялся, сессия ещё не родилась.
        assert!(BURST[0] >= Duration::from_secs(3));
    }

    #[test]
    fn a_sleep_slice_is_shorter_than_the_background_tick() {
        assert_eq!(SIGNAL_TICK, Duration::from_secs(1));
        assert!(SIGNAL_TICK < BACKGROUND_MIN, "иначе сигнал ничего бы не ускорил");
    }

    #[test]
    fn the_signal_does_not_wake_a_disabled_background() {
        // Текстовый: поведение потока в тесте не поднять, а правило молчаливое
        // — разреши мы сторожу работать при idle, выключенный человеком
        // фоновый опрос воскресал бы сам собой.
        let src = include_str!("poller.rs");
        let body = src
            .split_once("let watching = ")
            .expect("выбор сторожа пропал — тест сторожит не то")
            .1;
        let (body, _) = body.split_once(';').expect("строка не закрыта");
        assert!(body.contains("!idle"), "сторож смотрится только при работающем фоне");
        assert!(body.contains("!visible"), "показанное окно и так опрашивает раз в секунду");
    }

    #[test]
    fn a_burst_asks_for_a_fresh_dump_and_an_ordinary_poll_does_not() {
        // Без принудительного дампа всплеск ушёл бы впустую: STATE_DUMP_MAX_AGE
        // в агрегаторе тридцать секунд, а весь всплеск укладывается в двадцать.
        //
        // `split_once`, а не `contains`: последний нашёл бы собственный литерал
        // этого же теста и прошёл бы при удалённой боевой строке. Первое
        // вхождение — боевое, `mod tests` в файле идёт последним.
        let src = include_str!("poller.rs");
        let body = src
            .split_once("let fresh_dump = ")
            .expect("свежий дамп перестали просить — тест сторожит не то")
            .1;
        let (body, _) = body.split_once(';').expect("строка не закрыта");
        assert!(body.contains("bursting.is_some()"), "свежий дамп просят ровно опросы всплеска");
    }

    #[test]
    fn a_visible_window_never_bursts() {
        // Текстовый, как соседи: тела потока в юнит-тесте не поднять. Правило
        // молчаливое вдвойне — под всплеском срок сна считается от якоря, и
        // `visible` в нём не участвует вовсе: побеги всплеск при показанном
        // окне, секундный такт списка стал бы трёхсекундным.
        //
        // Проверяются ВСЕ вхождения, а не первое. Их два — гейт опроса и срок
        // сна, — и прежний сторож брал первое: замена второго на голое `burst`
        // оставляла все тесты зелёными, а открытый список замирал на три
        // секунды после каждого Enter. Заведи третье место — оно попадёт сюда
        // само.
        let src = include_str!("poller.rs");
        // Боевая часть: `mod tests` идёт последним, и литерал этого же теста
        // сторожить самого себя не должен.
        let (code, _) = src.split_once("mod tests").expect("mod tests пропал — тест сторожит не то");
        let mut seen = 0;
        for tail in code.split("let bursting = ").skip(1) {
            let (line, _) = tail.split_once(';').expect("строка не закрыта");
            assert!(line.contains("visible"), "всплеск идёт только у скрытого окна: {line}");
            assert!(line.contains("None"), "показанному окну всплеск не отдаётся: {line}");
            seen += 1;
        }
        assert!(seen >= 2, "мест два — гейт опроса и срок сна; найдено {seen}");
    }

    #[test]
    fn an_idle_machine_is_asked_about_only_where_it_may_decide_anything() {
        // Текстовый, как соседи: тела потока в юнит-тесте не поднять. Правило
        // молчаливое трижды. Показанному окну простой решать нечего — его такт
        // секундный. Выключенный человеком фон простой воскрешать не вправе:
        // спроси мы отметку раньше `idle`, и `backgroundRefresh: false` начал
        // бы ходить по ssh раз в минуту. А всплеск завело своё же действие
        // человека — он младше любого порога, и перебить его простой значило бы
        // потерять окно только что открытой сессии.
        let src = include_str!("poller.rs");
        let body = src
            .split_once("let away = ")
            .expect("простой перестали спрашивать — тест сторожит не то")
            .1;
        let (body, _) = body.split_once(';').expect("строка не закрыта");
        assert!(body.contains("!visible"), "показанное окно опрашивает раз в секунду");
        assert!(body.contains("!idle"), "выключенный фон простой не воскрешает");
        assert!(body.contains("bursting.is_none()"), "всплеск простой перебивает целиком");
    }

    #[test]
    fn an_idle_machine_keeps_feeding_the_dump() {
        // Порядок величин, а не вкусовщина: дамп читает панель openHASP, и
        // такт простоя — это её отставание. Порог агрегатора тридцать секунд,
        // и подниматься сильно выше нельзя по той же причине, по какой
        // ограничен BACKGROUND_MAX.
        assert_eq!(AWAY_AFTER, Duration::from_secs(300));
        assert_eq!(AWAY_DUMP_TICK, Duration::from_secs(60));
        assert!(AWAY_DUMP_TICK <= BACKGROUND_MAX, "в простое панель отставать больше не должна");
        assert!(SIGNAL_TICK < AWAY_DUMP_TICK, "кусок сна короче такта дампа");
    }

    #[test]
    fn a_local_source_gets_no_dump_of_its_own() {
        // Ничего не запускает: `dump_args` у местного источника `None`, и
        // дальше вызова дело не доходит. Проверка именно про это — местная
        // ветка на Windows про `--dump` не знает, и отказ разбора аргументов
        // лёг бы в строку ошибки раз в минуту.
        assert_eq!(dump_once(&[Source::Local]), "");
        assert_eq!(dump_once(&[]), "");
    }

    #[test]
    fn returning_from_idle_starts_the_backoff_over() {
        // Иначе вернувшийся человек получил бы список, застывший к началу
        // простоя, и ждал бы до восьми минут — ровно та беда, ради которой
        // заведены и сигнал трекера, и всплеск.
        let src = include_str!("poller.rs");
        let body = src
            .split_once("if was_away && !away")
            .expect("сброс бэкоффа на возврате пропал — тест сторожит не то")
            .1;
        let (body, _) = body.split_once('}').expect("ветка не закрыта");
        assert!(body.contains("BACKGROUND_MIN"), "бэкофф начинается заново");
        assert!(
            src.split_once("if was_away && !away").unwrap().1.starts_with(" && !visible"),
            "показанному окну такт ставит ветка Shown, и перебивать её нельзя",
        );
    }

    #[test]
    fn showing_the_window_cancels_the_burst() {
        // Пауза при `visible` его бы только придержала, а якорь остался бы
        // взведённым: человек, открывший сессию и тут же вернувший пикер,
        // получил бы досиженный всплеск посреди работы со списком.
        let src = include_str!("poller.rs");
        let body = src
            .split_once("Woke::Got(Signal::Shown) => {")
            .expect("ветка показа пропала — тест сторожит не то")
            .1;
        let (body, _) = body.split_once("Woke::Got(").expect("ветка не закрыта");
        assert!(body.contains("burst = None"), "показ окна гасит всплеск, а не откладывает");
    }
}
