# Разорванные сессии (disconnected) — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** агрегатор ccfzf помечает сессию `disconnected: true`, когда у её ssh-сокета застряла очередь отправки; пикер рисует такой строке кружок-контур, поднимает её заново через takeover (`^K` → `Reopen session`, трей → `Reopen disconnected sessions`) и не считает её имя занятым.

**Architecture:** две пробы `tx_queue` — это **два соседних опроса `--state`**, а не `sleep` внутри одного: прошлый замер лежит в файле рядом с памяткой фактов (`~/.cache/ccfzf/sendq.json`), поэтому время ответа не удваивается. Пикер признак только читает, своего вывода «окна нет — значит разорвана» не заводит. Reopen — нынешний `takeover` (SIGHUP, ожидание, `--resume`), но собранный без `;` и всегда местным терминалом, мимо `focus`/`manager`.

**Tech Stack:** ccfzf — bash + встроенный python3, тесты `python3 tests/test_*.py`; пикер — vanilla JS (`npm test`, node --test) и Rust/Tauri 2 (`cargo test`).

**Spec:** `docs/TODO.md` пикера, пункт «После сна машины терминалы остаются разорванными…»; разбор и замеры — `data/dead-term.md` (под `.gitignore`); решения Стаса от 2026-11-22 — задание head `~/.ccfzf/prompts/1e77fb66-…task.md`.

## Global Constraints

- Признак: очередь отправки ssh-сокета **не пуста и не убыла** между двумя пробами; сокет находится по `SSH_CONNECTION` из `/proc/<pid>/environ`, очередь берётся из поля `tx_queue` в `/proc/net/tcp` и `/proc/net/tcp6`.
- Поле в `--state` — `disconnected: true` у сессии. Ложь не пишется (`state_record` и так выкидывает пустые значения). В `DUMP_KEEP` поле не попадает.
- Кружок — контур **без нового токена** в `theme.css`: прозрачная заливка, кольцо цвета состояния. Шестой вид в `session-glyph.js`, правила `.dot.*` в `sessions.html`.
- Reopen = `takeover`: убить процесс (SIGHUP), **окно не закрывать**.
- Входы: пункт трея `Reopen disconnected sessions` и пункт `^K` `Reopen session`.
- Разорванные исключаются из занятых имён в **обеих копиях**: `liveSessionNames` (`frontend-src/session-name.js`) и `live_names` (`src-tauri/src/session_name.rs`). Сторож общий — `test/fixtures/session-name.json`. Фильтр идёт по `disconnected`, а не по отсутствию окна.
- ccfzf — публичный репозиторий: в фикстурах адреса 192.0.2.x / 2001:db8::, без имён машин и домашних путей (сверка по `data/private-patterns.txt`).
- Видимые строки — по-английски, комментарии, тесты и `assert` — по-русски.
- Ветки: `feat/disconnected` в обоих репо, по worktree на каждый (`~/projects/shell/ccfzf-disconnected`, `~/projects/js/ccfzf-picker-disconnected`). Коммит на каждую задачу. Не мержить.

## Review Focus

1. **Сессия в tmux/zellij** несёт `SSH_CONNECTION` давно ушедшего клиента: сокета нет либо он чужой. Она не должна получить пометку — проба её пропускает (Task 3).
2. **Сессия, которую `reptyr -T` уже перенёс в новый терминал**, хранит в environ старый `SSH_CONNECTION`, а старый сокет висит до `ClientAlive*` с застрявшей очередью. Если читать environ самого агента, Reopen убил бы живую сессию. Поэтому соединение берётся у последнего звена цепочки reptyr, которое держит этот pid (Task 3).
3. **Переиспользованный порт клиента или pid.** Сокет сверяется по всем четырём полям (оба адреса и оба порта), а ключ замера включает pid и момент запуска процесса (Task 1, Task 2).
4. **Несколько пикеров опрашивают одновременно**, с шагом меньше секунды, и после долгого бэкоффа скрытого окна. Минимальный зазор между замерами и потолок его давности не дают признаку мигать или срабатывать на двух случайных всплесках с разницей в восемь минут (Task 2).
5. **Windows Terminal режет команду по `;`** на панели: команда takeover обязана собираться без единого `;` (Task 7).

---

## Часть A — ccfzf (`~/projects/shell/ccfzf-disconnected`)

### Task 1: разбор `SSH_CONNECTION` и `/proc/net/tcp{,6}`

**Files:**
- Modify: `ccfzf` (python-блок, рядом с `proc_args`/`proc_tty`, раздел «процессы»)
- Create: `tests/test_sendq.py`, фикстуры строками в самом тесте (настоящие строки `/proc/net/tcp` и `tcp6`, адреса заменены на 192.0.2.x / 2001:db8::)

**Interfaces:**
- Produces: `ssh_peer(environ_bytes) -> tuple[str, int, str, int] | None` — `(client_ip, client_port, server_ip, server_port)` из `SSH_CONNECTION`; адреса нормализованы через `ipaddress` (у IPv4-mapped снимается `::ffff:`).
- Produces: `tcp_queues(texts: list[str]) -> dict[tuple[str,int,str,int], int]` — ключ `(local_ip, local_port, remote_ip, remote_port)`, значение `tx_queue` (hex → int). Берутся только строки в состоянии `01` (ESTABLISHED). Адреса разбираются по формату ядра: IPv4 — 4 байта в little-endian, IPv6 — четыре 32-битных слова, каждое в little-endian.

- [ ] **Step 1: тесты** — `test_ssh_peer_reads_four_fields` (environ с `SSH_CONNECTION=192.0.2.15 63374 192.0.2.14 22` → `("192.0.2.15", 63374, "192.0.2.14", 22)`), `test_ssh_peer_absent` (нет переменной → `None`), `test_tcp_queues_ipv4` (строка с `tx_queue` `000003B4` → 948), `test_tcp_queues_ipv6_mapped` (строка tcp6 с `::ffff:192.0.2.14` → ключ с `"192.0.2.14"`), `test_tcp_queues_skips_listen` (состояние `0A` в ответ не попадает).
- [ ] **Step 2:** `python3 tests/test_sendq.py` → FAIL (имён нет).
- [ ] **Step 3:** написать обе функции.
- [ ] **Step 4:** `python3 tests/test_sendq.py` → PASS.
- [ ] **Step 5:** commit `feat(state): разбор SSH_CONNECTION и очередей /proc/net/tcp`.

### Task 2: вердикт по двум опросам

**Files:**
- Modify: `ccfzf` (рядом с функциями из Task 1)
- Test: `tests/test_sendq.py`

**Interfaces:**
- Produces: константы `SENDQ_STUCK_SECS = 8` и `SENDQ_MAX_GAP = 60`.
- Produces: `sendq_verdicts(samples: dict[str, int], prev: dict, now: float) -> tuple[set[str], dict]`. Ключ в `samples` — строка `"<pid>:<procStart>:<cip>:<cport>:<sip>:<sport>"`. `prev` и новое состояние имеют вид `{key: {"q": int, "since": float, "seen": float}}`. Ключи, которых нет в `samples`, в новое состояние не переходят.

Правила, по которым считается вердикт (тесты их не определяют однозначно, поэтому выписаны):

```
q == 0                         → записи нет, не разорвана
нет записи или now-seen > MAX_GAP → {q, since: now, seen: now}, не разорвана
q < prev.q                     → {q, since: now, seen: now}, не разорвана  (рассасывается)
иначе (q >= prev.q > 0)        → {q: prev.q, since: prev.since, seen: now};
                                 разорвана, если now - since >= STUCK_SECS
```

`q` в записи не растёт, поэтому любое убывание ниже первого замера сбрасывает счёт. Вердикт держится, пока очередь не убыла, — признак не мигает и не ломает отпечаток `--if-changed`.

- [ ] **Step 1: тесты**
  - `test_draining_queue_is_not_stuck`: 0 → 108 → 0 → нет ни вердикта, ни записи;
  - `test_equal_queue_over_stuck_secs_is_disconnected`: 948 при t=0, 948 при t=9 → ключ в множестве;
  - `test_two_polls_within_stuck_secs_are_not_enough`: 948 при t=0 и при t=0.3 → пусто (опросы двух пикеров подряд);
  - `test_growing_queue_counts_as_stuck`: 748 → 848 → 948 на t=0/5/10 → разорвана на t=10;
  - `test_decrease_resets`: 948 при t=0, 500 при t=9 → пусто, `since == 9`;
  - `test_gap_over_max_resets`: 948 при t=0, 948 при t=500 → пусто (бэкофф скрытого пикера);
  - `test_verdict_is_stable_while_stuck`: три опроса подряд после срабатывания → вердикт каждый раз;
  - `test_vanished_key_is_dropped`.
- [ ] **Step 2:** запустить → FAIL.
- [ ] **Step 3:** написать `sendq_verdicts`.
- [ ] **Step 4:** запустить → PASS.
- [ ] **Step 5:** commit `feat(state): вердикт разрыва по двум соседним опросам`.

### Task 3: проба в `--state` и поле `disconnected`

**Files:**
- Modify: `ccfzf` — сбор `procs` в `running_sessions` (около :2849), сборка записи сессии в режиме `state` (около :4194), документация полей
- Test: `tests/test_sendq.py` (фальшивый `/proc` во временном каталоге), `tests/test_state_record.py`

**Interfaces:**
- Consumes: `ssh_peer`, `tcp_queues`, `sendq_verdicts`.
- Produces: `SENDQ_FILE` — из `CCFZF_SENDQ_FILE`, по умолчанию `<XDG_CACHE_HOME|~/.cache>/ccfzf/sendq.json`. Пустая строка выключает пробу.
- Produces: `disconnected_ids(procs: dict, proc_root: str = "/proc", state_path: str = SENDQ_FILE, now: float | None = None) -> set[str]`. Пишет файл (tmp + rename) только при изменении, нечитаемый файл считает пустым. Не-Linux (`proc_root` не существует) → пустое множество.
- Produces: в записи сессии `--state` поле `"disconnected": sid in disc`.

Порядок внутри `disconnected_ids`:
1. Пропустить сессию с `tmux` или `zellij` в `procs[sid]`, а также сессию без `pid`.
2. Найти, чьё environ читать. Если в `/proc/*/cmdline` есть `reptyr` с аргументом, равным pid сессии (`reptyr -T <pid>`), или цепочка `reptyr <pid прошлого reptyr>`, берётся последнее звено цепочки. Иначе — сам агент. Таблицу `reptyr` собирает тот же проход по `/proc`: один список `reptyr`-процессов на вызов.
3. Если `ssh_peer` дал `None` — пропустить (местная сессия).
4. Ключ сокета ищется в `tcp_queues` как `(server_ip, server_port, client_ip, client_port)`. Сокета нет — пропустить: «связь закрыта» без улики, форма cb32 остаётся непокрытой (см. «Что не покрыто»).
5. Ключ замера — `pid:procStart:…`. `procStart` берётся из `proc_start_epoch(pid)`.

- [ ] **Step 1: тесты**
  - `test_disconnected_ids_marks_stuck_socket` — фальшивый корень `/proc`: `<pid>/environ`, `<pid>/cmdline`, `net/tcp` с застрявшей очередью; два вызова, `now=0` и `now=9` → `{sid}`;
  - `test_disconnected_ids_skips_multiplexer` — у сессии `tmux` → пусто;
  - `test_disconnected_ids_follows_reptyr` — у агента в environ старый порт с застрявшей очередью, у процесса `reptyr -T <pid>` новый порт с пустой → пусто;
  - `test_disconnected_ids_without_proc_root` → пусто, файл не создан;
  - в `test_state_record.py`: `disconnected: False` из записи выкинут, `True` остаётся.
- [ ] **Step 2:** запустить → FAIL.
- [ ] **Step 3:** реализовать `disconnected_ids` и вызвать один раз в режиме `state` после `running_sessions`, до сборки записей. `dump` и прочие режимы пробу не зовут.
- [ ] **Step 4:** `for t in tests/test_*.py; do python3 "$t" || echo FAIL "$t"; done` → ни одного FAIL.
- [ ] **Step 5:** commit `feat(state): поле disconnected — застрявшая очередь ssh-сокета`.

### Task 4: замер, документация, PR ccfzf

**Files:** `README.md` (описание полей `--state`), `CHANGELOG.md`, если в нём ведётся Unreleased.

- [ ] **Step 1: замер.** `--state` из worktree против `~/bin/ccfzf`, по 20 прогонов каждый, на живых данных (`for i in $(seq 20); do /usr/bin/time -f %e … --state >/dev/null; done`). Записать медиану и p90 обоих; ожидается прирост меньше 10%. Цифры — в PR и в отчёт head.
- [ ] **Step 2:** абзац в README про `disconnected`: что значит, Linux + ssh, две пробы с зазором 8 с, чего признак не видит.
- [ ] **Step 3:** grep по `private-patterns.txt` пикера на diff ветки → пусто.
- [ ] **Step 4:** commit и push, PR в `main` с чеклистом ручной проверки. Не мержить.

## Часть B — пикер (`~/projects/js/ccfzf-picker-disconnected`)

### Task 5: vendor, поле в строке, занятые имена

**Files:**
- Modify: `vendor/ccfzf` (сабмодуль на коммит ветки `feat/disconnected`), `frontend-src/session-list.js` (`buildSessionList`, рядом с `tmux`/`zellij` около :246), `frontend-src/session-name.js` (`liveSessionNames`), `src-tauri/src/session_name.rs` (`live_names`), `test/fixtures/session-name.json` (раздел `live`)
- Test: `test/session-name.test.js` и Rust-тест в `session_name.rs` (оба уже читают фикстуру), `test/row-contract.test.js`

**Interfaces:**
- Produces: строка списка несёт `disconnected: boolean` (`Boolean(s.disconnected)`).
- Produces: `liveSessionNames` и `live_names` пропускают `s.disconnected === true`.

- [ ] **Step 1:** в `live` фикстуры добавить кейс `"разорванная сессия не занимает имени — ни заголовком, ни окном"`: `{title:"api", live:true, disconnected:true, windows:[{title:"api"}]}` и `{title:"notes", live:true}` → `["notes"]`. В `row-contract` — строка с `disconnected: true` в ответе агрегатора несёт `disconnected === true`, без поля — `false`.
- [ ] **Step 2:** `npm test` и `cd src-tauri && cargo test session_name` → FAIL.
- [ ] **Step 3:** правка трёх функций и бамп сабмодуля (`git -C vendor/ccfzf checkout <sha ветки>`).
- [ ] **Step 4:** оба прогона → PASS.
- [ ] **Step 5:** commit `feat(list): поле disconnected и свободное имя разорванной сессии`.

### Task 6: кружок-контур

**Files:**
- Modify: `frontend-src/session-glyph.js` (`statusDotHtml`), `sessions.html` (правила `.dot` около :334–354)
- Test: `test/row-contract.test.js`, `test/theme.test.js` (менять не нужно, должен остаться зелёным)

**Interfaces:**
- Produces: живая разорванная → `<div class="dot <dotState> disconnected"></div>`; цвет состояния сохраняется.

CSS: у каждого `.dot.<state>` цвет переезжает в местную переменную `--dot` (`.dot.active { --dot: var(--ok) }` и так далее), а общее правило — `.dot { background: var(--dot, transparent) }`. Контур задаётся правилом `.dot.disconnected { background: transparent; box-shadow: inset 0 0 0 2px var(--dot) }`. В `theme.css` не появляется ни одного нового токена, литералов цвета нет.

- [ ] **Step 1: тесты** — `statusDotHtml({live:true, disconnected:true, agentState:'active'})` → `'<div class="dot active disconnected"></div>'`; у неживой с `disconnected` → `'<div class="dot closed"></div>'`. Текстовый сторож: в `<style>` есть правило `.dot.disconnected`, и в нём нет `var(--` с новым именем (каждый `var(--x)` есть в `theme.css` или равен `--dot`).
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** правка глифа и CSS.
- [ ] **Step 4:** `npm test` → PASS, включая `theme.test.js`.
- [ ] **Step 5:** commit `feat(glyph): кружок-контур у разорванной сессии`.

### Task 7: takeover без `;`

**Files:**
- Modify: `frontend-src/open-strategy.js` (ветка `takeover` в `buildOpenCommand`, около :344)
- Test: `test/open-strategy.test.js`

**Interfaces:**
- Produces: `takeoverPrefix(pid: number) -> string` (в экспортах модуля). Это команда, которая шлёт SIGHUP, ждёт до 10 с и падает с кодом ≠ 0, если процесс жив. Без `;` и без перевода строки. `remote = takeoverPrefix(pid) + ' && ' + resumeCommand(cwd, id)`.

Форма: цикл ожидания и проверка уезжают base64-ом в `sh -c`, тем же приёмом, каким `newSessionCommand` везёт промпт: `sh -c "$(printf %s <b64> | base64 --decode)"`. Внутри — прежние три строки (`kill -HUP`, цикл `kill -0` на 20 × 0,5 с, `exit 1` с сообщением). `tail --pid`/`timeout` не годятся: это GNU, на макоси их нет.

- [ ] **Step 1: тесты**
  - `test('у takeover в команде нет ни ";", ни перевода строки')` — по всем элементам argv;
  - `test('takeoverPrefix снимает процесс и пропускает хвост')` — `spawn('sleep', ['60'])`, затем `sh -c takeoverPrefix(pid) + ' && echo resumed'` → stdout `resumed`, процесс мёртв;
  - `test('takeoverPrefix не пускает хвост, пока процесс жив')` — процесс с `trap '' HUP` → код ≠ 0, `resumed` нет (таймаут теста 15 с).
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** реализация.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** commit `fix(open): takeover собирается без ";" — Windows Terminal не режет его на панели`.

### Task 8: `^K` → `Reopen session`

**Files:**
- Modify: `frontend-src/session-actions.js` (`availableActions`), `sessions.html` (`runAction`, `openSession`)
- Test: `test/session-actions.test.js`

**Interfaces:**
- Consumes: `row.disconnected`, `takeoverPrefix` (через `buildOpenCommand(row, 'takeover', …)`).
- Produces: пункт `{ id: 'reopen', label: 'Reopen session' }` — у строки `live && disconnected && pid && cwd`, кроме `winLocal` и сессий Claude Desktop.
- Produces: `openSession(row, { reopen: true })`. Стратегия принудительно `'takeover'`, `chooseEnterAction` не спрашивается, `focus`/`desktop`/`manager` не рассматриваются: окно-труп поднимать бессмысленно, а менеджер зовёт `ccfzf --session`, у которого своё решение. Подтверждение своё: `Reopen session "<name>"?\n\nProcess <pid> on <source> will get SIGHUP and exit; the session will be resumed in a new terminal. Its old window stays as it is.` Цена — профиль Windows Terminal по каталогу теряется: открывает местный терминал, не менеджер.

- [ ] **Step 1: тесты** — пункт есть у разорванной строки с pid и нет у целой, у разорванной без pid, у `winLocal`. Сторож «каждый встроенный пункт меню обработан в runAction» должен остаться зелёным после правки — в нём новый id.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** реализация. Ветка `runAction` → `openSession(row, { reopen: true })`.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** commit `feat(menu): Reopen session у разорванной строки`.

### Task 9: трей → `Reopen disconnected sessions`

**Files:**
- Modify: `src-tauri/src/main.rs` (сборка меню около :3644, `on_menu_event`, сторож `every_active_tray_item_is_handled`), `sessions.html` (слушатель события), `frontend-src/session-list.js` (чистая выборка)
- Test: Rust-сторож в `main.rs`, `test/session-list.test.js`, текстовый тест страницы

**Interfaces:**
- Produces: пункт трея id `reopen-disconnected`, подпись `Reopen disconnected sessions`. Ветка: `show_picker(app)`, затем `app.emit("reopen-disconnected", ())`. Сначала показ, потому что у скрытого пикера WebView2 усыпляет страницу, а команду собирает JS.
- Produces: `disconnectedRows(rows) -> rows` в `session-list.js` — живые, `disconnected`, с `pid` и `cwd`, без строк Desktop.
- Страница на событие ставит флаг `pendingReopen` и ждёт **следующего** события `state` (не дольше 10 с): список скрытого пикера мог отстать на восемь минут, и SIGHUP ушёл бы по устаревшему pid. Дальше:
  - пусто → статуслайн `No disconnected sessions`;
  - иначе одно `confirm` со списком имён и `openSession(row, { reopen: true, confirmed: true })` по очереди, без второго подтверждения на каждую.
  - Нет `state` за 10 с → ошибка `No fresh session list, nothing reopened`.

- [ ] **Step 1: тесты** — `disconnectedRows` на смеси строк. `every_active_tray_item_is_handled` с `"reopen-disconnected"` в списке. Текстовый сторож: обработчик `reopen-disconnected` в `sessions.html` зовёт `openSession(` с `reopen: true` и не собирает свою команду.
- [ ] **Step 2:** `npm test`, `cargo test` → FAIL.
- [ ] **Step 3:** реализация.
- [ ] **Step 4:** оба → PASS.
- [ ] **Step 5:** commit `feat(tray): Reopen disconnected sessions`.

### Task 10: правила и документация

**Files:** `docs/rules/state-sources.md` (поле, зазор, файл замеров), `docs/rules/opening-sessions.md` (Reopen мимо manager/focus, без `;`), `docs/rules/hotkeys-and-tray.md` (пункт трея и `^K`), `docs/rules/list-rows.md` (контур), `CLAUDE.md` (счёт правил в указателе), `README.md` (строка про Reopen в фичах), `config.example.yml` (если Reopen что-то читает — не должен).

- [ ] **Step 1:** правила, по одному на файл, с ценой и сторожем.
- [ ] **Step 2:** `npm test` (`skipped 0`), `cargo test` → зелёные; записать числа.
- [ ] **Step 3:** commit `docs(rules): разорванные сессии`, push, PR в `master` с чеклистом. Не мержить.

### Task 11: выкатка и живая проверка

Деплой **на Windows — ноутбук; мак пропущен, недоступен.**

- [ ] **Step 1:** посмотреть, какая ветка стоит на ноутбуке (хост и путь — в `deploy-win.sh`). Если там чужая несмёрженная — не катить, написать head.
- [ ] **Step 2:** `BRANCH=feat/disconnected ./data/scripts/deploy-win.sh` в фоне. После — сверка `tasklist` (PID новый) и штамп сборки в трее.
- [ ] **Step 3: живая проверка** (нужен агрегатор с веткой, см. вопрос head):
  - на ноутбуке `^N` поднимает тестовую сессию;
  - на этой машине через `ssh root@localhost` ставится `iptables -I OUTPUT -p tcp --sport 22 -d <client_ip> --dport <client_port> -j DROP` (порт — из `SSH_CONNECTION` сессии);
  - в сессию пишется вывод; через ≥ 8 с в `--state` появляется `disconnected: true`, в строке — контур, `^N` в том же каталоге получает имя без `-2`;
  - `^K` → `Reopen session` поднимает её в новом окне, старый процесс мёртв, `--resume` с тем же id;
  - правило DROP снять (`iptables -D …`).

  SIGSTOP клиента для проверки не годится: ядро клиента продолжает подтверждать пакеты, и очередь не копится.
- [ ] **Step 4:** отчёт head: коммиты, PR, числа тестов, замер `--state`, что проверено вживую и что нет.

## Что не покрыто (назвать в PR)

- Форма cb32: сокета уже нет, агент осиротел. Признака нет: он виден только по очереди, пока сокет жив.
- Агент, который ничего не пишет, улики не даёт.
- Мак и Windows как ssh-хосты — `/proc` нет, признак не считается.
- Enter на разорванной строке не меняется (сейчас это подъём окна-трупа или `ccfzf --session` через менеджер). Вопрос head, см. ниже.
