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
/// молчало бы, разойдись с первым. Пустым он остался достижим и после того,
/// как местный источник стал умолчанием: его выключают явным `false`.
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
    // Умолчание — «спрашивать»: местный источник выключает только явный
    // `false`. Развилки по системе здесь нет и на Windows: bash-обёртки там
    // нет, но местный источник работает — `local_ccfzf::resolve` зовёт
    // вырезанный из вшитой копии python-блок через `python`/`python3` из PATH.
    // Без питона в PATH источник отказывает поимённо (`neither python nor
    // python3 is on PATH`), и такой машине ключ пишется явным `false`. Второй
    // довод против развилки — тот же ключ читает страница (проверка
    // ненастроенности и галка в настройках), и умолчание, разное у Rust и у
    // неё, окно настроек молча увезло бы в `config.yaml` обратной записью.
    if config.get("localSource").and_then(|v| v.as_bool()) != Some(false) {
        out.push(Source::Local);
    }
    out
}

/// Переменная, которой пикер просит агрегатор переписать дамп немедленно.
///
/// Имя названо здесь один раз на обе дороги: по ssh оно уезжает приставкой к
/// команде, местному вызову ставится через `Command::env`. Второе написание
/// разошлось бы с первым молча — ответ пришёл бы прежний, а дамп остался бы
/// старым, и всплеск опроса ушёл бы впустую.
pub const DUMP_ENV: &str = "CCFZF_STATE_DUMP_MAX_AGE";

/// Приставка к удалённой команде.
fn dump_env_prefix(fresh_dump: bool) -> String {
    if fresh_dump {
        format!("{DUMP_ENV}=0 ")
    } else {
        String::new()
    }
}

/// Аргументы вызова `--state`, свои у каждой дороги.
///
/// Через ssh уезжает одна строка: её заново разбирает удалённый шелл, и
/// `ccfzf --state` там команда. Местный вызов шелла не поднимает вовсе —
/// `--state` обязан быть отдельным аргументом процесса.
///
/// `if_changed` — отпечаток прошлого ответа этого же источника
/// (`state_memo.rs`). Форма проверяется здесь второй раз, хотя память кладёт
/// только проверенное: строка уезжает в чужой шелл, и сторож у самой двери
/// дешевле, чем довод «туда не попадёт».
fn state_args(source: &Source, fresh_dump: bool, if_changed: Option<&str>) -> Vec<String> {
    let key = if_changed.filter(|fp| crate::state_memo::looks_like_fingerprint(fp));
    match source {
        Source::Ssh(_) => vec![match key {
            Some(fp) => format!("{}ccfzf --state --if-changed {fp}", dump_env_prefix(fresh_dump)),
            None => format!("{}ccfzf --state", dump_env_prefix(fresh_dump)),
        }],
        Source::Local => {
            let mut out = vec!["--state".to_string()];
            if let Some(fp) = key {
                out.push("--if-changed".to_string());
                out.push(fp.to_string());
            }
            out
        }
    }
}

/// Аргументы вызова `--dump` — того самого, который переписывает дампы и
/// выходит, ничего не отдавая.
///
/// `None` у местного источника, и причин тому две. На Windows местная ветка
/// зовёт не `ccfzf`, а вырезанный из него python-блок, который режим считает
/// себе сам по алиасу `--state` и про `--dump` не знает вовсе. А на машинах,
/// где пикер стоит, местный дамп не читает никто: панель openHASP живёт
/// дампом агрегатора, до которого ходят по ssh.
pub fn dump_args(source: &Source) -> Option<Vec<String>> {
    match source {
        // Одной строкой, как и `--state`: её заново разбирает удалённый шелл.
        Source::Ssh(_) => Some(vec!["ccfzf --dump".to_string()]),
        Source::Local => None,
    }
}

/// Переписать дамп агрегатора, не забирая состояние.
///
/// Ради этого вызова фоновый поток и не засыпает совсем, пока человека нет за
/// машиной: дамп читает windows11-manager, а из него живут Home Assistant и
/// плата openHASP. Состояние при этом не едет ни в кэш, ни на страницу —
/// смотреть на список некому.
///
/// Ответа у режима нет: он переписывает файлы и выходит. Поэтому здесь
/// проверяется только код возврата — «спросить не смогли» против «спросили».
pub fn refresh_dump(source: &Source) -> Result<(), String> {
    let Some(args) = dump_args(source) else { return Ok(()) };
    let out = command_for(source, false)?
        .args(args)
        .output()
        .map_err(|e| format!("failed to start: {e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("exited with {}: {}", out.status, err.trim()));
    }
    Ok(())
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
fn command_for(source: &Source, fresh_dump: bool) -> Result<std::process::Command, String> {
    match source {
        Source::Ssh(host) => Ok(ssh(host)),
        Source::Local => {
            let (program, args) = crate::local_ccfzf::resolve()?;
            let mut cmd = hidden_command(&program);
            cmd.args(args);
            if fresh_dump {
                cmd.env(DUMP_ENV, "0");
            }
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
pub fn fetch(
    source: &Source,
    fresh_dump: bool,
    if_changed: Option<&str>,
) -> Result<serde_json::Value, String> {
    let out = command_for(source, fresh_dump)?
        .args(state_args(source, fresh_dump, if_changed))
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
    let mut child = command_for(source, false)?
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

/// Аргументы флага автокомпакта — та же форма, что у `comment_args`.
fn auto_compact_args(source: &Source, id: &str, on: bool) -> Vec<String> {
    let mut out = match source {
        Source::Ssh(_) => vec!["ccfzf".to_string()],
        Source::Local => vec![],
    };
    out.push("--auto-compact".to_string());
    out.push(id.to_string());
    out.push(if on { "on" } else { "off" }.to_string());
    out
}

/// Включить или выключить автокомпакт сессии на машине её источника.
pub fn set_auto_compact(source: &Source, id: &str, on: bool) -> Result<(), String> {
    if !looks_like_session_id(id) {
        return Err("not a session id".into());
    }
    let out = command_for(source, false)?
        .args(auto_compact_args(source, id, on))
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to start: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("ccfzf exited with {}: {}", out.status, err.trim()));
    }
    Ok(())
}

/// Удалённая команда автокомпакта — одной строкой для удалённого шелла.
///
/// Через интерактивный шелл, как всё, что пикер зовёт на той машине
/// (CLAUDE.md, `inDir`): `claude-wt` и его окружение — из rc. Без `;`: правило
/// общее для удалённых команд связки. Подставляются только id, уже проверенный
/// `looks_like_session_id`, и целое число — кавычить нечего.
fn compact_remote(id: &str, min_idle: i64) -> String {
    format!("exec $SHELL -ic 'claude-wt session compact {id} --min-idle {min_idle} --json'")
}

/// Послать сессии `/compact` через `claude-wt session compact` на машине
/// агрегатора. Возвращает код выхода и вывод (stdout, следом stderr) —
/// разбирает их `auto_compact::outcome`.
///
/// Местного источника нет намеренно: `claude-wt` живёт на машине
/// агрегатора, а не на машине пикера.
pub fn run_compact(source: &Source, id: &str, min_idle: i64) -> Result<(Option<i32>, String), String> {
    if !looks_like_session_id(id) {
        return Err("not a session id".into());
    }
    let Source::Ssh(host) = source else {
        return Err("claude-wt lives on the aggregator machine, not on a local source".into());
    };
    let out = ssh(host)
        .arg(compact_remote(id, min_idle))
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to start ssh: {e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok((out.status.code(), text))
}

/// Форма id сессии: тридцать шесть знаков UUID и ничего больше.
///
/// Проверяется здесь, а не только на той стороне, потому что строка уезжает
/// аргументом в чужой шелл: пропусти мы сюда пробел или `;`, и разбирать это
/// стал бы он.
///
/// Видна и соседям: та же проверка стоит на пути ссылки `claude://resume`
/// (`desktop_session_url` в main.rs). Второй такой разбор разошёлся бы с этим
/// молча — и разошёлся бы ровно там, где цена ошибки наибольшая.
pub fn looks_like_session_id(id: &str) -> bool {
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
    use super::{
        auto_compact_args, command_for, comment_args, compact_remote, dump_args, run_compact, dump_env_prefix, looks_like_session_id, sources_from,
        state_args, Source, DUMP_ENV,
    };

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
    /// Пустой `sshHost` не источник, а ненастроенное поле; местный источник
    /// спрашивается по умолчанию и выключается явным `false`.
    #[test]
    fn sources_come_from_the_config() {
        let cfg = serde_json::json!({"sshHost": "remote-host", "localSource": false});
        assert_eq!(sources_from(&cfg), vec![Source::Ssh("remote-host".into())]);

        let cfg = serde_json::json!({"sshHost": "remote-host"});
        assert_eq!(
            sources_from(&cfg),
            vec![Source::Ssh("remote-host".into()), Source::Local],
            "удалённый первым: дедуп разрешает споры в пользу первого"
        );

        let cfg = serde_json::json!({"localSource": true});
        assert_eq!(sources_from(&cfg), vec![Source::Local], "один местный — тоже рабочая настройка");

        // Умолчание, а не только явная `true`: конфиг без ключа — это и есть
        // свежая установка, ради которой умолчание менялось.
        assert_eq!(sources_from(&serde_json::json!({})), vec![Source::Local]);
        assert_eq!(
            sources_from(&serde_json::json!({"sshHost": "  ", "localSource": false})),
            Vec::<Source>::new(),
            "пробелы — тот же пустой хост"
        );
        assert_eq!(
            sources_from(&serde_json::Value::Null),
            vec![Source::Local],
            "испорченный конфиг читается как отсутствующий, а у того местный источник есть"
        );
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
        assert_eq!(
            state_args(&Source::Ssh("remote-host".into()), false, None),
            vec!["ccfzf --state".to_string()]
        );
        assert_eq!(state_args(&Source::Local, false, None), vec!["--state".to_string()]);
    }

    #[test]
    fn a_fresh_dump_rides_a_prefix_only_over_ssh() {
        // По ssh команду разбирает шелл той стороны, и переменная едет строкой.
        assert_eq!(
            state_args(&Source::Ssh("remote-host".into()), true, None),
            vec!["CCFZF_STATE_DUMP_MAX_AGE=0 ccfzf --state".to_string()]
        );
        // Местный вызов шелла не поднимает вовсе: там переменная ставится
        // процессу через Command::env, и в аргументах ей делать нечего.
        assert_eq!(state_args(&Source::Local, true, None), vec!["--state".to_string()]);
    }

    #[test]
    fn an_ordinary_poll_does_not_ask_for_a_dump() {
        assert_eq!(
            state_args(&Source::Ssh("remote-host".into()), false, None),
            vec!["ccfzf --state".to_string()]
        );
        assert_eq!(state_args(&Source::Local, false, None), vec!["--state".to_string()]);
    }

    /// Отпечаток прошлого ответа едет ключом `--if-changed` по обеим дорогам:
    /// по ssh — в той же строке, местному процессу — отдельными аргументами
    /// (на Windows их разбирает алиас `--state` в python-блоке). Не похожее на
    /// отпечаток в чужой шелл не уходит вовсе — опрос становится полным.
    #[test]
    fn the_fingerprint_rides_as_if_changed() {
        let fp = "0123456789abcdef";
        assert_eq!(
            state_args(&Source::Ssh("remote-host".into()), true, Some(fp)),
            vec![format!("CCFZF_STATE_DUMP_MAX_AGE=0 ccfzf --state --if-changed {fp}")]
        );
        assert_eq!(
            state_args(&Source::Local, false, Some(fp)),
            vec!["--state".to_string(), "--if-changed".to_string(), fp.to_string()]
        );
        assert_eq!(
            state_args(&Source::Ssh("remote-host".into()), false, Some("abc; rm -rf ~")),
            vec!["ccfzf --state".to_string()]
        );
    }

    #[test]
    fn an_ordinary_poll_adds_no_prefix() {
        assert_eq!(dump_env_prefix(false), "");
    }

    /// Освежение дампа в простое идёт только по ssh, и это не экономия.
    ///
    /// Местная ветка на Windows — вырезанный из `ccfzf` python-блок, который
    /// режим считает себе сам по алиасу `--state`: получи он `--dump`, ответом
    /// был бы отказ разбора аргументов, а виден он был бы раз в минуту в
    /// строке ошибки на машине, где пикер стоит.
    #[test]
    fn a_dump_goes_only_to_the_ssh_source() {
        assert_eq!(
            dump_args(&Source::Ssh("remote-host".into())),
            Some(vec!["ccfzf --dump".to_string()])
        );
        assert_eq!(dump_args(&Source::Local), None);
    }

    /// Местная дорога ставит переменную не строкой, а `Command::env` — эта
    /// проверка смотрит именно туда, а не в `dump_env_prefix`, которая этой
    /// дороги вовсе не касается.
    ///
    /// Захардкодь `command_for` литерал с опечаткой вместо `DUMP_ENV`, ответ
    /// агрегатора пришёл бы прежний, дамп остался бы старым, и заметить это
    /// можно было бы только на той машине, где живёт местный источник, —
    /// сторож обязан ловить именно это расхождение, а не форму строки-приставки.
    #[test]
    fn the_local_road_sets_the_variable_through_command_env() {
        let cmd = command_for(&Source::Local, true).expect("местный ccfzf обязан находиться в тестовой среде");
        let value = cmd.get_envs().find(|(k, _)| *k == DUMP_ENV).and_then(|(_, v)| v);
        assert_eq!(value, Some(std::ffi::OsStr::new("0")));

        let cmd = command_for(&Source::Local, false).expect("местный ccfzf обязан находиться в тестовой среде");
        assert!(cmd.get_envs().all(|(k, _)| k != DUMP_ENV), "обычный опрос переменную не ставит");
    }

    /// То же и у комментария: id и имя машины едут аргументами по обеим
    /// дорогам, а текст — на stdin, потому что через ssh его разбирал бы шелл.
    #[test]
    fn compact_remote_idyot_cherez_interaktivnyy_shell() {
        let line = compact_remote("b5a54ce3-a022-4c9a-aa91-e306d75bdc76", 58);
        assert_eq!(
            line,
            "exec $SHELL -ic 'claude-wt session compact b5a54ce3-a022-4c9a-aa91-e306d75bdc76 --min-idle 58 --json'"
        );
        assert!(!line.contains(';'), "`;` для Windows Terminal — разделитель панелей");
    }

    #[test]
    fn auto_compact_args_kak_u_kommentariya() {
        let id = "b5a54ce3-a022-4c9a-aa91-e306d75bdc76";
        assert_eq!(
            auto_compact_args(&Source::Ssh("remote-host".into()), id, false),
            vec!["ccfzf".to_string(), "--auto-compact".to_string(), id.to_string(), "off".to_string()]
        );
        assert_eq!(
            auto_compact_args(&Source::Local, id, true),
            vec!["--auto-compact".to_string(), id.to_string(), "on".to_string()]
        );
    }

    #[test]
    fn run_compact_ne_hodit_s_krivym_id_i_mestnym_istochnikom() {
        assert!(run_compact(&Source::Ssh("remote-host".into()), "x; rm -rf ~", 58).is_err());
        assert!(run_compact(&Source::Local, "b5a54ce3-a022-4c9a-aa91-e306d75bdc76", 58).is_err());
    }

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
