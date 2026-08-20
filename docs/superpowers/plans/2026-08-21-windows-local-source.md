# Local session source on Windows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the picker's local session source work on Windows, so sessions started on that machine — today almost always Claude Desktop ones — appear in the list beside the `sshHost` aggregator's sessions.

**Architecture:** `ccfzf` gains a third process-layer branch that reads Claude Code's own session registry (`~/.claude/sessions/<pid>.json`) instead of enumerating processes, plus a `--state` entry point that computes its paths itself so it can run without the bash wrapper. The picker unpacks the python block out of the vendored copy and runs it with `python` on Windows, stops translating paths for rows that are already local, and opens a local terminal row without a POSIX shell.

**Tech Stack:** bash + embedded python3 (`ccfzf`, no dependencies, tests via pytest over `tests/harness.py`); Rust/Tauri 2 and plain browser JS with `node --test` (`ccfzf-picker`).

**Spec:** `docs/superpowers/specs/2026-08-21-windows-local-source-design.md`

## Global Constraints

- Two repositories. Tasks 1–3 are in `~/projects/shell/ccfzf` (branch `feat/windows-local-source`, off `main`). Tasks 4–7 are in `~/projects/js/ccfzf-picker` (branch `feat/windows-local-source`, already created off `feat/claude-desktop-sessions`).
- Everything a human sees is English; comments, docstrings, test names and assert messages are Russian. This is the project rule, not a preference.
- Aggregator tests run with `.venv/bin/python -m pytest tests/ -q` from the `ccfzf` repo; picker tests with `npm test` and `cd src-tauri && cargo test`.
- No machine names, user names or home directories in tracked files — `test/no-private-data.test.js` fails the whole picker suite otherwise. Use `<user>`, `<drive>:\…`, `some-project`.
- `;` must never appear in a command that reaches Windows Terminal: it splits its command line into panes.
- `entrypoint` is not read from the registry. Its source is the transcript, and it already ships.
- Nothing in this plan installs hooks on Windows. Rows from that machine arrive with no agent state, no status dot, no cost and no context share, and that is expected.

## File Structure

**`ccfzf` repository**

- `ccfzf` — the single distributed file. Three regions change: the process-layer section (new `WINDOWS` constant, registry reader, live check, `windows_sessions`), the head of `running_sessions()` (early return on the Windows branch), and the mode dispatch at line ~2504 (a `--state` alias that fills in the six paths).
- `tests/test_windows_registry.py` — new. Registry parsing and the live rule, over a fixture directory and an injected creation-time table. Runs on Linux.
- `tests/test_state_mode.py` — modified. One test that the `--state` alias produces the same document as the explicit `state` invocation.

**`ccfzf-picker` repository**

- `src-tauri/src/local_ccfzf.rs` — cutting the python block out of the vendored copy, writing `ccfzf.py`, choosing `python` over `bash` on Windows.
- `src-tauri/src/main.rs` — `spawn_detached` gains an optional working directory.
- `frontend-src/path-map.js` — `mapRowPath`, the rule that a local row needs no translation.
- `frontend-src/session-actions.js`, `sessions.html` — call sites move to `mapRowPath`.
- `frontend-src/open-strategy.js` — the Windows branch of `buildOpenCommand` for a local row.
- `test/path-map.test.js`, `test/open-strategy.test.js`, `test/local-ccfzf.test.js` (new) — guards.

---

### Task 1: Registry reader in the aggregator

**Files:**
- Modify: `~/projects/shell/ccfzf/ccfzf` — insert after `ps_field` (line ~1275), before `lsof_cwd`
- Test: `~/projects/shell/ccfzf/tests/test_windows_registry.py` (create)

**Interfaces:**
- Consumes: `UUID_RE` (line ~1193), `json`, `os` — all already imported at the top of the block.
- Produces: `WINDOWS` (bool), `SESSIONS_DIR` (str), `registry_records(path=SESSIONS_DIR) -> list[dict]` where each dict is `{"sid": str, "pid": int, "cwd": str, "procStart": str}`.

- [x] **Step 1: Write the failing test**

Create `tests/test_windows_registry.py`:

```python
"""Реестр сессий Claude Code — источник связки «процесс ↔ сессия» на Windows.

Разбора процессов там нет вовсе: рабочего каталога `Win32_Process` не отдаёт,
а без него `fresh_ids` кормить нечем. Зато Claude Code сам пишет
`~/.claude/sessions/<pid>.json`, и в нём лежит всё нужное.

Запуск: python3 tests/test_windows_registry.py
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness

CC = harness.load()

UUID_A = "aaaaaaaa-1111-2222-3333-444444444444"
UUID_B = "bbbbbbbb-1111-2222-3333-444444444444"


def _dir(records):
    """Каталог реестра из списка (имя файла, содержимое)."""
    d = tempfile.mkdtemp()
    for name, body in records:
        with open(os.path.join(d, name), "w", encoding="utf-8") as fh:
            fh.write(body if isinstance(body, str) else json.dumps(body))
    return d


def _record(pid, sid, cwd="<drive>:\\projects\\some-project", **extra):
    rec = {"pid": pid, "sessionId": sid, "cwd": cwd,
           "procStart": "134317286687059374", "kind": "interactive"}
    rec.update(extra)
    return rec


def test_a_record_is_read_whole():
    d = _dir([("10980.json", _record(10980, UUID_A))])
    assert CC["registry_records"](d) == [
        {"sid": UUID_A, "pid": 10980, "cwd": "<drive>:\\projects\\some-project",
         "procStart": "134317286687059374"},
    ]


def test_an_absent_directory_reads_as_no_sessions():
    """Пустота, а не отказ: на машине без единой местной сессии каталога нет."""
    assert CC["registry_records"]("/nonexistent-registry-for-tests") == []


def test_broken_and_foreign_files_are_skipped_one_by_one():
    """Разбор терпимый, как у файла окон: одна кривая запись не роняет ответ."""
    d = _dir([
        ("1.json", "{не json"),
        ("2.json", "[]"),
        ("3.json", _record(3, "not-a-uuid")),
        ("4.json", {"pid": 4, "sessionId": UUID_B}),
        ("5.json", _record(0, UUID_B)),
        ("6.key", "секрет"),
        ("7.json", _record(7, UUID_A)),
    ])
    assert [r["pid"] for r in CC["registry_records"](d)] == [7]


def test_a_record_without_a_start_time_is_dropped():
    """Без `procStart` живость не проверить, а «не проверили» здесь опасно:
    мёртвый процесс тоже отвечает пустотой, и запись сошлась бы с ним."""
    d = _dir([("8.json", _record(8, UUID_A, procStart=""))])
    assert CC["registry_records"](d) == []


def test_a_background_kind_is_not_a_session_here():
    """Форк не должен отобрать у родителя окно, а признака `bg-pty-host`,
    по которому его узнают на Linux, здесь нет вовсе."""
    d = _dir([("9.json", _record(9, UUID_A, kind="background"))])
    assert CC["registry_records"](d) == []


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("ok")
```

- [x] **Step 2: Run the test and watch it fail**

```bash
cd ~/projects/shell/ccfzf && .venv/bin/python -m pytest tests/test_windows_registry.py -q
```

Expected: every test fails with `KeyError: 'registry_records'`.

- [x] **Step 3: Write the reader**

Insert into `ccfzf` right after `ps_field` (line ~1275):

```python
# ---- Windows: реестр сессий вместо разбора процессов ----------------------
#
# На Windows перебирать процессы бесполезно: рабочего каталога `Win32_Process`
# не отдаёт вовсе, а именно на cwd держится `fresh_ids` — единственная дорога
# для сессии, запущенной как голый `claude`, без id в argv. Зато Claude Code
# сам ведёт реестр: файл на процесс, и в нём уже есть и id, и каталог.
WINDOWS = sys.platform == "win32"

SESSIONS_DIR = os.path.expanduser("~/.claude/sessions")


def registry_records(path=SESSIONS_DIR):
    """[{sid, pid, cwd, procStart}] из `~/.claude/sessions/<pid>.json`.

    Разбор белым списком, как у файла окон (`read_windows`): незнакомый ключ
    теряется, кривая запись пропускается, отсутствующий каталог читается
    пустотой, а не отказом — на машине без единой местной сессии его и нет.

    Файл мы не пишем и не чистим: мёртвые записи там обычное дело, живость
    спрашивается отдельно (`windows_sessions`).

    Запись без `procStart` выбрасывается здесь же: живость проверяется
    сравнением с этим значением, а мёртвый процесс отвечает той же пустотой —
    то есть запись без него сошлась бы с любым покойником.

    `kind`, отличный от `interactive`, тоже выбрасывается: фоновый форк, взятый
    за обычную сессию, отобрал бы у родителя его же окно, а признака
    `bg-pty-host`, по которому форк узнают на Linux, здесь нет.

    `entrypoint` в реестре есть, но не читается намеренно: его источник —
    транскрипт, и второго у одного факта быть не должно.
    """
    out = []
    try:
        names = sorted(os.listdir(path))
    except OSError:
        return out
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(path, name), encoding="utf-8") as fh:
                rec = json.load(fh)
        except (OSError, ValueError):
            continue
        if not isinstance(rec, dict):
            continue
        sid, pid, cwd = rec.get("sessionId"), rec.get("pid"), rec.get("cwd")
        started = rec.get("procStart")
        if not isinstance(sid, str) or not UUID_RE.match(sid):
            continue
        if not isinstance(pid, int) or pid <= 0:
            continue
        if not isinstance(cwd, str) or not cwd:
            continue
        if not isinstance(started, (str, int)) or not str(started):
            continue
        if rec.get("kind", "interactive") != "interactive":
            continue
        out.append({"sid": sid, "pid": pid, "cwd": cwd, "procStart": str(started)})
    return out
```

- [x] **Step 4: Run the test and watch it pass**

```bash
cd ~/projects/shell/ccfzf && .venv/bin/python -m pytest tests/test_windows_registry.py -q
```

Expected: `5 passed`.

- [x] **Step 5: Run the whole suite**

```bash
cd ~/projects/shell/ccfzf && .venv/bin/python -m pytest tests/ -q
```

Expected: all green (262 + 5).

- [x] **Step 6: Commit**

```bash
cd ~/projects/shell/ccfzf
git checkout -b feat/windows-local-source main
git add ccfzf tests/test_windows_registry.py
git commit -m "feat(windows): агрегатор читает реестр сессий Claude Code"
```

---

### Task 2: The live rule and the Windows branch of `running_sessions`

**Files:**
- Modify: `~/projects/shell/ccfzf/ccfzf` — after `registry_records`, and the head of `running_sessions()` (line ~1889, right after its docstring)
- Test: `~/projects/shell/ccfzf/tests/test_windows_registry.py`

**Interfaces:**
- Consumes: `registry_records()` from Task 1.
- Produces: `process_start(pid) -> str` (creation FILETIME as a decimal string, `""` when the process is gone) and `windows_sessions(records=None, started_of=None) -> (set, dict)` where the dict is `{sid: {"pid": int, "tty": "", "tmux": None, "zellij": None, "cwd": str}}`.

- [x] **Step 1: Write the failing test**

Append to `tests/test_windows_registry.py`, before the `__main__` block:

```python
# ── Живость ────────────────────────────────────────────────────────────────


def _records():
    return [
        {"sid": UUID_A, "pid": 10, "cwd": "<drive>:\\a", "procStart": "111"},
        {"sid": UUID_B, "pid": 20, "cwd": "<drive>:\\b", "procStart": "222"},
    ]


def test_a_live_record_brings_its_pid_and_directory():
    live, procs = CC["windows_sessions"](_records(), lambda pid: "111")
    assert live == {UUID_A}, live
    assert procs[UUID_A] == {"pid": 10, "tty": "", "tmux": None,
                             "zellij": None, "cwd": "<drive>:\\a"}, procs


def test_a_dead_pid_is_not_alive():
    live, procs = CC["windows_sessions"](_records(), lambda pid: "")
    assert live == set(), live
    assert procs == {}, procs


def test_a_reused_pid_does_not_revive_yesterdays_session():
    """Проверка двойная не для красоты: pid переиспользуются, и без сверки
    времени старта чужой процесс оживил бы вчерашнюю сессию."""
    live, _ = CC["windows_sessions"](_records(), lambda pid: "999")
    assert live == set(), live
```

- [x] **Step 2: Run the test and watch it fail**

```bash
cd ~/projects/shell/ccfzf && .venv/bin/python -m pytest tests/test_windows_registry.py -q
```

Expected: three failures with `KeyError: 'windows_sessions'`.

- [x] **Step 3: Write the live rule**

Append to `ccfzf` right after `registry_records`:

```python
def process_start(pid):
    """Время создания процесса как FILETIME строкой; `""` — процесса нет.

    Через `ctypes`, а не через подпроцесс: спрашиваются только те несколько
    pid, которые назвал реестр, и делать ради них `powershell` на каждый опрос
    было бы дороже всего остального разбора вместе взятого.

    `GetProcessTimes` отдаёт ровно ту величину, которую реестр хранит строкой
    в `procStart`: сотни наносекунд от 1601 года, — так что сравниваются они
    без перевода.
    """
    import ctypes
    import ctypes.wintypes as wintypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return ""
    try:
        created = wintypes.FILETIME()
        exited = wintypes.FILETIME()
        kernel = wintypes.FILETIME()
        user = wintypes.FILETIME()
        ok = kernel32.GetProcessTimes(handle, ctypes.byref(created),
                                      ctypes.byref(exited), ctypes.byref(kernel),
                                      ctypes.byref(user))
        if not ok:
            return ""
        return str((created.dwHighDateTime << 32) | created.dwLowDateTime)
    finally:
        kernel32.CloseHandle(handle)


def windows_sessions(records=None, started_of=None):
    """(живые id, {id: запись процесса}) по реестру.

    Запись жива, когда pid существует **и** его время создания совпало с
    `procStart`. Обе половины обязательны — см. `process_start`.

    Спрашивающий вынесен аргументом по той же причине, по какой у маковской
    ветки вынесена таблица `ps`: настоящего Windows в тестах не завести, а
    правило проверить надо.

    `tty`, `tmux` и `zellij` пустые: на Windows их нет вовсе, а форма записи
    процесса общая на все три системы — читатель у неё один.
    """
    records = registry_records() if records is None else records
    started_of = process_start if started_of is None else started_of
    live, procs = set(), {}
    for rec in records:
        if started_of(rec["pid"]) != rec["procStart"]:
            continue
        live.add(rec["sid"])
        procs[rec["sid"]] = {"pid": rec["pid"], "tty": "", "tmux": None,
                             "zellij": None, "cwd": rec["cwd"]}
    return live, procs
```

- [x] **Step 4: Run the test and watch it pass**

```bash
cd ~/projects/shell/ccfzf && .venv/bin/python -m pytest tests/test_windows_registry.py -q
```

Expected: `8 passed`.

- [x] **Step 5: Wire the branch into `running_sessions`**

In `running_sessions()`, immediately after its docstring and before
`live, fresh, agents, procs = set(), [], {}, {}`:

```python
    # На Windows разбора процессов нет вовсе: связку «процесс ↔ сессия ↔
    # каталог» отдаёт реестр, и гадать по каталогу (`fresh_ids`) не о чем — id
    # там назван прямо. Хуков на той машине тоже нет (`~/.claude/claude-wt` не
    # существует), поэтому и второй проход по отметкам ничего бы не добавил:
    # выходим сразу.
    if WINDOWS:
        live, procs = windows_sessions()
        return live, {}, procs, []
```

- [x] **Step 6: Run the whole suite**

```bash
cd ~/projects/shell/ccfzf && .venv/bin/python -m pytest tests/ -q
```

Expected: all green. The new branch is unreachable on Linux, so nothing else
moves.

The spec asks for an end-to-end `--state` run with a registry standing in for
`/proc`. That test is deliberately **not** written: `running_sessions()` picks
the branch by `sys.platform`, and forcing it from a test would mean a switch
that exists only for tests — the very thing `_PS_TABLE` avoids by seaming the
data instead. The rule itself is covered by the three tests above, and the
wiring is covered live in Task 7, Step 4.

- [x] **Step 7: Commit**

```bash
cd ~/projects/shell/ccfzf
git add ccfzf tests/test_windows_registry.py
git commit -m "feat(windows): живость сессии — по pid и времени его старта"
```

---

### Task 3: `--state` without paths

**Files:**
- Modify: `~/projects/shell/ccfzf/ccfzf` — a helper beside the mode dispatch, and the dispatch itself at line ~2504
- Test: `~/projects/shell/ccfzf/tests/test_state_mode.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `state_defaults(limit="") -> list[str]` — the six positional arguments the `state` mode expects, in order: marks, windows file, sessions file, limit, windows dir, comments file.

- [x] **Step 1: Write the failing test**

Append to `tests/test_state_mode.py`:

```python
def test_the_state_alias_needs_no_paths():
    """Пикер на Windows зовёт python-блок напрямую: bash-обёртку там нечем
    исполнить. Значит режим обязан посчитать те же шесть путей сам, и ответ
    обязан совпасть с тем, что даёт обёртка."""
    with tempfile.TemporaryDirectory() as tmp:
        build_home(tmp, [A])
        dump = os.path.join(tmp, "dump.json")
        by_wrapper = run_state(tmp, dump)
        saved = dict(os.environ)
        os.environ.update(_facts_env(tmp, dump))
        try:
            out, err = harness.run(["--state"])
        finally:
            os.environ.clear()
            os.environ.update(saved)
        assert out.strip(), err
        got = json.loads(out)
        assert ([s["id"] for s in got["sessions"]]
                == [s["id"] for s in by_wrapper["sessions"]]), out
```

Add `import harness` and the `sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))` line above it at the top of the file — `test_state_mode.py` runs the script through `subprocess` today and does not import the harness yet. `harness.run(argv)` executes the block in-process with `sys.argv = ["ccfzf"] + argv` and returns `(stdout, stderr)`; the environment is patched around the call because the block reads `HOME` and the `CCFZF_*` variables at that moment.

- [x] **Step 2: Run the test and watch it fail**

```bash
cd ~/projects/shell/ccfzf && .venv/bin/python -m pytest tests/test_state_mode.py -q
```

Expected: failure — the block exits without printing anything, because `mode` is `--state` and no branch matches.

- [x] **Step 3: Write the alias**

Insert into `ccfzf` immediately before `mode = sys.argv[1] if len(sys.argv) > 1 else ""` (line ~2504):

```python
def state_defaults(limit=""):
    """Шесть позиционных аргументов режима `state`, посчитанных здесь же.

    Ровно те умолчания, что стоят в шапке скрипта, и с той же разницей форм:
    у меток — `:-` (пустое значение тоже заменяется), у остальных — `-`
    (заменяется только неназванное).

    Нужны они затем, что на Windows bash-обёртки нет: пикер зовёт этот блок
    напрямую. Второй экземпляр тех же умолчаний в Rust разошёлся бы с этим
    молча — а расхождение это выглядело бы пустым списком сессий.
    """
    home = os.path.expanduser("~")

    def unset_only(name, default):
        value = os.environ.get(name)
        return default if value is None else value

    return [
        os.environ.get("FZF_MARKS_FILE") or os.path.join(home, ".fzf-marks"),
        unset_only("CCFZF_WINDOWS_FILE",
                   os.path.join(home, ".ccfzf.sessions.claude-wt.json")),
        unset_only("CCFZF_SESSIONS_FILE", os.path.join(home, ".ccfzf.sessions.json")),
        limit,
        unset_only("CCFZF_WINDOWS_DIR", os.path.join(home, ".ccfzf", "windows")),
        unset_only("CCFZF_COMMENTS_FILE", os.path.join(home, ".ccfzf.comments.json")),
    ]


# `--state` — тот же режим `state`, но без путей в argv. Пустой предел значит
# «умолчание самого блока» (DUMP_SESSIONS), и оно совпадает со значением,
# которое подставляет обёртка.
if len(sys.argv) > 1 and sys.argv[1] == "--state":
    _limit = sys.argv[3] if len(sys.argv) > 3 and sys.argv[2] == "--limit" else ""
    sys.argv = [sys.argv[0], "state"] + state_defaults(_limit)
```

- [x] **Step 4: Run the test and watch it pass**

```bash
cd ~/projects/shell/ccfzf && .venv/bin/python -m pytest tests/test_state_mode.py -q
```

Expected: all tests in the file pass.

- [x] **Step 5: Confirm the wrapper is untouched**

```bash
cd ~/projects/shell/ccfzf && .venv/bin/python -m pytest tests/ -q
```

Expected: all green — the bash prologue still passes its six arguments, and the alias never fires for it.

- [x] **Step 6: Commit and push**

```bash
cd ~/projects/shell/ccfzf
git add ccfzf tests/test_state_mode.py
git commit -m "feat(state): --state считает свои пути сам"
git push -u origin feat/windows-local-source
```

---

### Task 4: The picker runs the python block

**Files:**
- Modify: `~/projects/js/ccfzf-picker/src-tauri/src/local_ccfzf.rs`
- Test: `~/projects/js/ccfzf-picker/src-tauri/src/local_ccfzf.rs` (its `mod tests`)

**Interfaces:**
- Consumes: the vendored `vendor/ccfzf/ccfzf` with its `<<'PYEOF'` … `\nPYEOF` markers.
- Produces: `python_block(vendored: &str) -> Result<&str, String>`, and `choose` gaining a Windows shape: `("python", vec![<path to ccfzf.py>])`.

- [x] **Step 1: Write the failing tests**

Add to the `mod tests` block of `local_ccfzf.rs`:

```rust
    /// Блок вырезается по тем же меткам, по которым его читает и bash, и
    /// tests/harness.py в репозитории агрегатора. Третьего разбора заводить
    /// нельзя — он разошёлся бы молча, а отказ читался бы как
    /// «python: can't open file».
    #[test]
    fn python_block_is_cut_by_the_shell_heredoc_markers() {
        let vendored = "#!/usr/bin/env bash\nread -r -d '' PY <<'PYEOF' || true\nimport os\nPYEOF\necho done\n";
        assert_eq!(super::python_block(vendored).unwrap(), "import os");
    }

    #[test]
    fn a_copy_without_markers_is_a_named_failure() {
        assert!(super::python_block("#!/usr/bin/env bash\necho hi\n").is_err());
    }

    /// Настоящая вшитая копия обязана резаться — иначе местный источник на
    /// Windows молчал бы, а поймать это можно только здесь: на машине
    /// разработки эта ветка не исполняется.
    #[test]
    fn the_vendored_copy_still_carries_the_markers() {
        let block = super::python_block(super::VENDORED).expect("маркеры PYEOF");
        assert!(block.contains("def registry_records("), "блок вырезан не тот");
    }

    #[test]
    fn on_windows_the_block_runs_through_python() {
        assert_eq!(
            super::choose_python("/x/ccfzf.py", "python"),
            ("python".to_string(), vec!["/x/ccfzf.py".to_string()]),
        );
    }
```

- [x] **Step 2: Run the tests and watch them fail**

```bash
cd ~/projects/js/ccfzf-picker/src-tauri && cargo test local_ccfzf 2>&1 | tail -20
```

Expected: compile error — `python_block` and `choose_python` do not exist.

- [x] **Step 3: Write the implementation**

In `local_ccfzf.rs`, add beside `choose`:

```rust
/// Метки heredoc, которыми bash отделяет python-программу от обёртки.
const PY_BEGIN: &str = "<<'PYEOF'";
const PY_END: &str = "\nPYEOF";

/// Python-программа, вырезанная из вшитой копии.
///
/// На Windows bash-обёртку исполнить нечем: единственный `bash` там — пускач
/// WSL, у которого свой `$HOME` и свой `~/.claude`. Зато сама программа —
/// обычный python, и запустить её можно напрямую.
///
/// Метки те же, по которым блок читает и сам bash, и `tests/harness.py` в
/// репозитории агрегатора. Открывающая ищется без перевода строки, а хвост её
/// строки отбрасывается отдельно: в скрипте она записана как
/// `read -r -d '' PY <<'PYEOF' || true`.
pub fn python_block(vendored: &str) -> Result<&str, String> {
    let (_, rest) = vendored
        .split_once(PY_BEGIN)
        .ok_or_else(|| "vendored ccfzf has no PYEOF marker".to_string())?;
    let (_, body) = rest
        .split_once('\n')
        .ok_or_else(|| "vendored ccfzf ends at its PYEOF marker".to_string())?;
    body.split_once(PY_END)
        .map(|(block, _)| block)
        .ok_or_else(|| "vendored ccfzf has no closing PYEOF marker".to_string())
}

/// Программа и её аргументы на Windows: интерпретатор и путь к вырезанному
/// блоку. Отдельной функцией, а не веткой внутри `choose`: ту проверяют на
/// Linux, и обе формы должны быть видны тестам одинаково.
pub fn choose_python(py_path: &str, interpreter: &str) -> (String, Vec<String>) {
    (interpreter.to_string(), vec![py_path.to_string()])
}
```

Then teach `unpack` to write the second file and `resolve` to use it. Replace the body of `unpack` and `resolve` with:

```rust
fn unpack() -> Result<String, String> {
    let path = crate::state_path("ccfzf")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    std::fs::write(&path, VENDORED).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("cannot chmod {}: {e}", path.display()))?;
    }
    // Вторым файлом — сама python-программа: на Windows обёртку исполнить
    // нечем. Пишется и там, где не нужна: разница в один `fs::write` раз за
    // запуск процесса, а ветка `cfg` здесь стоила бы непроверяемого кода.
    let py = crate::state_path("ccfzf.py")?;
    std::fs::write(&py, python_block(VENDORED)?)
        .map_err(|e| format!("cannot write {}: {e}", py.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

pub fn resolve() -> Result<(String, Vec<String>), String> {
    if cfg!(target_os = "windows") {
        // Ветка PATH пропускается: `ccfzf`, найденный там, — тот же bash-скрипт.
        let interpreter = ["python", "python3"]
            .into_iter()
            .find(|name| on_path(name))
            .ok_or_else(|| "neither python nor python3 is on PATH".to_string())?;
        UNPACKED.get_or_init(unpack).as_ref().map_err(|e| e.clone())?;
        let py = crate::state_path("ccfzf.py")?;
        return Ok(choose_python(&py.to_string_lossy(), interpreter));
    }
    if on_path("ccfzf") {
        return choose(true, None);
    }
    match UNPACKED.get_or_init(unpack) {
        Ok(path) => choose(false, Some(path)),
        Err(e) => Err(e.clone()),
    }
}
```

- [x] **Step 4: Run the tests and watch them pass**

```bash
cd ~/projects/js/ccfzf-picker/src-tauri && cargo test 2>&1 | tail -5
```

Expected: `222 passed` plus the four new tests.

- [x] **Step 5: Commit**

```bash
cd ~/projects/js/ccfzf-picker
git add src-tauri/src/local_ccfzf.rs
git commit -m "feat(windows): пикер зовёт python-блок напрямую"
```

---

### Task 5: A local row needs no path translation

**Files:**
- Modify: `~/projects/js/ccfzf-picker/frontend-src/path-map.js`
- Modify: `~/projects/js/ccfzf-picker/frontend-src/session-actions.js` — lines 67, 113, 124, 136
- Modify: `~/projects/js/ccfzf-picker/sessions.html` — lines ~3394 and ~3438
- Test: `~/projects/js/ccfzf-picker/test/path-map.test.js`

**Interfaces:**
- Consumes: `mapPath(cwd, pathMap)` — unchanged.
- Produces: `mapRowPath(row, pathMap) -> string | null`.

- [x] **Step 1: Write the failing tests**

Append to `test/path-map.test.js`:

```js
const LOCAL_ROW = { cwd: '<drive>:\\projects\\some-project', source: 'local' };
const REMOTE_ROW = { cwd: '/home/user/projects/x', source: 'build-host' };
const MAP = { remote: '/home/user', local: 'v:' };

test('строка местного источника переводу не подлежит', () => {
  // Её путь уже местный. Перевод отдавал бы null, и вместе с ним из меню
  // пропадали бы все действия с папкой, Open plan и Open spec.
  assert.strictEqual(mapRowPath(LOCAL_ROW, MAP), '<drive>:\\projects\\some-project');
});

test('строка с чужой машины переводится как прежде', () => {
  assert.strictEqual(mapRowPath(REMOTE_ROW, MAP), '<drive>:\\projects\\x');
});

test('строка без источника переводится как прежде', () => {
  // Старый ответ агрегатора источника не проставляет вовсе.
  assert.strictEqual(mapRowPath({ cwd: '/home/user/projects/x' }, MAP), '<drive>:\\projects\\x');
});

test('местная строка без каталога — по-прежнему null', () => {
  assert.strictEqual(mapRowPath({ source: 'local' }, MAP), null);
});
```

Add `mapRowPath` to the `require` at the top of the file.

- [x] **Step 2: Run the tests and watch them fail**

```bash
cd ~/projects/js/ccfzf-picker && node --test test/path-map.test.js
```

Expected: `TypeError: mapRowPath is not a function`.

- [x] **Step 3: Write the implementation**

Add to `frontend-src/path-map.js`, beside `mapPath`, and add `mapRowPath` to the returned object:

```js
  /**
   * Путь строки на этой машине.
   *
   * У строки местного источника он уже местный: переводить нечего, а перевод
   * отдал бы `null` — путь не начинается с удалённого префикса, — и вместе с
   * ним из меню пропали бы все действия с папкой, `Open plan` и `Open spec`.
   * Видно это стало на Windows, где местная строка несёт `<drive>:\…`, но правило
   * общее: на Linux местная строка сегодня переводится через тот же префикс,
   * и это так же неверно.
   *
   * Метка источника — та же строка `local`, что стоит в `LOCAL_LABEL`
   * (state_source.rs) и в `LOCAL_SOURCE` (open-strategy.js). Импортировать её
   * сюда неоткуда: у этого модуля зависимостей нет вовсе.
   */
  function mapRowPath(row, pathMap) {
    const cwd = (row || {}).cwd;
    if (typeof cwd !== 'string' || !cwd) return null;
    if (String((row || {}).source || '') === 'local') return cwd;
    return mapPath(cwd, pathMap);
  }
```

- [x] **Step 4: Run the tests and watch them pass**

```bash
cd ~/projects/js/ccfzf-picker && node --test test/path-map.test.js
```

Expected: all pass.

- [x] **Step 5: Move the call sites**

In `frontend-src/session-actions.js` replace all four occurrences:

```js
      if (pathApi.mapPath(row.cwd, cfg.pathMap) !== null) {
```

with

```js
      if (pathApi.mapRowPath(row, cfg.pathMap) !== null) {
```

Two of the four are written as `pathApi.mapPath((row || {}).cwd, cfg.pathMap)`
(lines 124 and 136) and become `pathApi.mapRowPath(row, cfg.pathMap)` — the
argument is the row itself in every case, and `mapRowPath` already tolerates a
missing row.

In `sessions.html` line ~3394:

```js
        localPath: window.PathMap.mapRowPath(row, CONFIG.pathMap),
```

and line ~3438:

```js
      const base = window.PathMap.mapRowPath(row, CONFIG.pathMap);
```

- [x] **Step 6: Write the guard that keeps new call sites honest**

Append to `test/path-map.test.js`:

```js
test('каталог строки никто не переводит мимо mapRowPath', () => {
  // Правило «местная строка уже местная» живёт в одном месте, и вызов
  // напрямую его обходит молча: действия просто исчезают из меню.
  const files = ['sessions.html', 'frontend-src/session-actions.js'];
  const offenders = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/mapPath\(\s*(row|\(row \|\| \{\}\))\./.test(line)) {
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepStrictEqual(offenders, []);
});
```

Add `const fs = require('node:fs');` and `const path = require('node:path');` at the top if absent.

- [x] **Step 7: Run the whole suite**

```bash
cd ~/projects/js/ccfzf-picker && npm test 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: `# fail 0`.

- [x] **Step 8: Commit**

```bash
cd ~/projects/js/ccfzf-picker
git add frontend-src/path-map.js frontend-src/session-actions.js sessions.html test/path-map.test.js
git commit -m "fix(paths): каталог местной строки не переводится"
```

---

### Task 6: Enter on a local terminal row on Windows

**Files:**
- Modify: `~/projects/js/ccfzf-picker/src-tauri/src/main.rs` — `spawn_detached` (line ~1701), its two internal callers (lines ~1755, ~1821)
- Modify: `~/projects/js/ccfzf-picker/frontend-src/open-strategy.js` — `buildOpenCommand` (line ~252)
- Modify: `~/projects/js/ccfzf-picker/sessions.html` — the `openSession` call into `buildOpenCommand`, and the `spawn_detached` invocation beside it
- Test: `~/projects/js/ccfzf-picker/test/open-strategy.test.js`, `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `terminalArgv(terminal, parts, opts)` — unchanged.
- Produces: `buildOpenCommand` returning `{ argv, destructive, cwd }` where `cwd` is a string only on the Windows local branch and `undefined` otherwise; `spawn_detached(argv, cwd)` on the Rust side.

- [x] **Step 1: Write the failing JS test**

Append to `test/open-strategy.test.js`:

```js
test('местная строка на Windows открывается без шелла', () => {
  // `/bin/sh` там нет вовсе, а `$SHELL -ic` существует ради интерактивного
  // rc, которого там тоже нет. Каталог ставит не команда, а сам запуск.
  const row = { kind: 'interactive', id: 'b5a54ce3-a022-4c9a-aa91-e306d75bdc76',
                cwd: '<drive>:\\projects\\some-project', source: 'local' };
  const got = buildOpenCommand(row, 'resume', {
    terminal: { file: 'wt.exe', args: [] }, os: 'windows',
  });
  assert.deepStrictEqual(got.argv, ['wt.exe', 'claude', '--resume', row.id]);
  assert.strictEqual(got.cwd, '<drive>:\\projects\\some-project');
  assert.ok(!JSON.stringify(got.argv).includes('/bin/sh'));
  assert.ok(!JSON.stringify(got.argv).includes('$SHELL'));
});

test('местная строка на маке и Linux открывается как раньше', () => {
  const row = { kind: 'interactive', id: 'b5a54ce3-a022-4c9a-aa91-e306d75bdc76',
                cwd: '/home/user/x', source: 'local' };
  const got = buildOpenCommand(row, 'resume', {
    terminal: { file: 'kitty', args: [] }, os: 'macos',
  });
  assert.strictEqual(got.cwd, undefined);
  assert.ok(JSON.stringify(got.argv).includes('/bin/sh'));
});

test('строка с чужой машины на Windows по-прежнему едет через ssh', () => {
  const row = { kind: 'interactive', id: 'b5a54ce3-a022-4c9a-aa91-e306d75bdc76',
                cwd: '/home/user/x', source: 'build-host' };
  const got = buildOpenCommand(row, 'resume', {
    terminal: { file: 'wt.exe', args: [] }, os: 'windows',
  });
  assert.ok(got.argv.includes('ssh'), got.argv.join(' '));
  assert.strictEqual(got.cwd, undefined);
});
```

- [x] **Step 2: Run the tests and watch them fail**

```bash
cd ~/projects/js/ccfzf-picker && node --test test/open-strategy.test.js
```

Expected: the first test fails — `argv` still starts a `/bin/sh` command.

- [x] **Step 3: Write the branch**

In `frontend-src/open-strategy.js`, inside `buildOpenCommand`, right after
`if (remote === null) return null;`:

```js
    const source = String((row || {}).source || '') || String(sshHost || '');
    // На Windows у местной строки шелла нет: `/bin/sh` там не существует, а
    // `$SHELL -ic` написан ради интерактивного rc, которого там тоже нет.
    // Команда уходит голым хвостом argv, а каталог ставит запуск процесса
    // (`spawn_detached` с `cwd`) — так не приходится ни собирать `cd`, ни
    // кавычить путь, ни бояться `;`, который Windows Terminal делит на панели.
    //
    // Только `resume`: `attach`, `reptyr` и `takeover` — про POSIX-машину, и
    // на Windows у строки нет ни tmux, ни pid чужого шелла.
    if ((opts || {}).os === 'windows' && source === LOCAL_SOURCE && strategy === 'resume') {
      const argv = terminalArgv(terminal, ['claude', '--resume', row.id], opts);
      return argv === null ? null : { argv, destructive: false, cwd: row.cwd };
    }
```

and delete the now-duplicated `const source = …` line below it.

- [x] **Step 4: Run the tests and watch them pass**

```bash
cd ~/projects/js/ccfzf-picker && node --test test/open-strategy.test.js
```

Expected: all pass.

- [x] **Step 5: Write the failing Rust test**

Add to `mod tests` in `src-tauri/src/main.rs`:

```rust
    /// Каталог запуска — аргумент команды, а не `cd` внутри неё: у местной
    /// строки на Windows шелла нет вовсе, и склеивать команду было бы нечем.
    #[test]
    fn spawn_takes_a_working_directory() {
        let dir = std::env::temp_dir();
        let argv = if cfg!(target_os = "windows") {
            vec!["cmd".to_string(), "/c".to_string(), "cd".to_string()]
        } else {
            vec!["pwd".to_string()]
        };
        assert!(super::spawn_detached(argv, Some(dir.to_string_lossy().into_owned())).is_ok());
    }
```

- [x] **Step 6: Run it and watch it fail**

```bash
cd ~/projects/js/ccfzf-picker/src-tauri && cargo test spawn_takes 2>&1 | tail -10
```

Expected: compile error — `spawn_detached` takes one argument.

- [x] **Step 7: Add the parameter**

In `src-tauri/src/main.rs` replace the signature and body head:

```rust
#[tauri::command]
fn spawn_detached(argv: Vec<String>, cwd: Option<String>) -> Result<(), String> {
    let Some((file, args)) = argv.split_first() else {
        return Err("empty argv".into());
    };
    let mut command = std::process::Command::new(file);
    command.args(args);
    // Каталог ставится процессу, а не собирается в команду: у местной строки
    // на Windows шелла нет, и `cd` было бы негде выполнить.
    if let Some(dir) = cwd.as_deref().filter(|d| !d.is_empty()) {
        command.current_dir(dir);
    }
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to spawn {file}: {e}"))
}
```

Update the two internal callers to pass `None`: line ~1755 becomes
`spawn_detached(url_opener(&url), None)` and line ~1821 becomes
`return spawn_detached(argv, None);`.

- [x] **Step 8: Run the Rust tests**

```bash
cd ~/projects/js/ccfzf-picker/src-tauri && cargo test 2>&1 | tail -5
```

Expected: all pass.

- [x] **Step 9: Pass the platform and the directory from the page**

In `sessions.html`, add the script tag before `open-strategy.js` (line ~774):

```html
<script src="terminal-presets.js"></script>
```

In `openSession`, pass the platform into `buildOpenCommand` and the directory
into the spawn:

```js
    const cmd = window.OpenStrategy.buildOpenCommand(row, strategy, {
      sshHost: CONFIG.sshHost, terminal: CONFIG.terminal, helperPath: await helperPath(),
      // Система — той же меркой, что и выбор пресета терминала в окне
      // настроек: второй разбор `navigator.platform` разошёлся бы с первым.
      os: window.TerminalPresets.osOf(navigator.platform || navigator.userAgent || ''),
    });
```

```js
      await invoke('spawn_detached', { argv: cmd.argv, cwd: cmd.cwd });
```

- [x] **Step 10: Run the whole picker suite**

```bash
cd ~/projects/js/ccfzf-picker && npm test 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: `# fail 0`. `test/frontend-load.test.js` covers that every script tag has a file behind it.

- [x] **Step 11: Commit**

```bash
cd ~/projects/js/ccfzf-picker
git add src-tauri/src/main.rs frontend-src/open-strategy.js sessions.html test/open-strategy.test.js
git commit -m "feat(windows): местная сессия открывается без шелла"
```

---

### Task 7: Bump the submodule, deploy, verify live

**Files:**
- Modify: `~/projects/js/ccfzf-picker/vendor/ccfzf` (submodule pointer)
- Modify: `~/projects/js/ccfzf-picker/CLAUDE.md`, `docs/TODO.md`

**Interfaces:**
- Consumes: the pushed `feat/windows-local-source` branch of the aggregator (Task 3).
- Produces: a deployed picker on all three machines.

- [x] **Step 1: Point the submodule at the new aggregator commit**

```bash
cd ~/projects/js/ccfzf-picker/vendor/ccfzf
git fetch origin && git checkout origin/feat/windows-local-source
cd ~/projects/js/ccfzf-picker
git add vendor/ccfzf && git commit -m "chore(vendor): ccfzf с местным источником на Windows"
```

- [x] **Step 2: Rebuild and re-run both suites**

```bash
cd ~/projects/js/ccfzf-picker && npm test 2>&1 | grep -E "^# fail"
cd src-tauri && cargo test 2>&1 | tail -3
```

Expected: `# fail 0` and all Rust tests green. The Rust guard
`the_vendored_copy_still_carries_the_markers` now cuts the new copy and must
still find `def registry_records(`.

- [x] **Step 3: Push and deploy**

```bash
cd ~/projects/js/ccfzf-picker && git push -u origin feat/windows-local-source
BRANCH=feat/windows-local-source ./data/scripts/deploy-win.sh
BRANCH=feat/windows-local-source ./data/scripts/deploy-mac.sh --all
```

Run the two deploys in parallel and in the background; Windows takes about
three and a half minutes, the macs about one each.

- [x] **Step 4: Verify the aggregator live on Windows**

```bash
ssh popstas-pc 'python "%USERPROFILE%\.config\ccfzf-picker\ccfzf.py" --state'
```

Expected: valid JSON whose `sessions` include a session with
`entrypoint: "claude-desktop"` and `live: true` while Claude Desktop holds it
open, with a `pid` that is not zero.

- [x] **Step 5: Verify in the picker**

By eye, on the Windows machine: the session appears in the list with the `c`
glyph, Enter on it raises the Claude Desktop window, and the statusline no
longer shows the `exit code: 127` line. On a local terminal row, Enter opens
the terminal in the row's directory.

If Windows Terminal opens in the wrong directory, the fallback named in the
spec applies: compose `cmd /k` with the directory inside the command instead of
relying on the inherited one, keeping `;` out of it. Add the flag to the
preset's args rather than to `buildOpenCommand` if a per-preset flag turns out
to be needed.

- [x] **Step 6: Write the rule down**

Add a rule to `CLAUDE.md` beside the Claude Desktop one: the local source on
Windows reads the session registry rather than processes, `Win32_Process` has no
working directory, the registry keeps dead records, `procStart` is the guard
against reused pids, and there is no agent state on that machine because there
are no hooks. Remove the `# future` task about the Windows tracker's local
sessions if this closes it, or narrow it to the hooks half.

- [x] **Step 7: Commit**

```bash
cd ~/projects/js/ccfzf-picker
git add CLAUDE.md docs/TODO.md
git commit -m "docs: правило про местный источник на Windows"
git push
```
