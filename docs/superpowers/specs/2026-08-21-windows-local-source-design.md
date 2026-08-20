# Local session source on Windows

## Goal

Make `localSource` work on Windows, so that sessions started on the Windows
machine itself — today almost always Claude Desktop ones — appear in the picker
list next to the sessions of the `sshHost` aggregator.

Today the local source is enabled by default (`localSource: true` in
`config-shape.js`) and cannot work there at all: the picker runs the vendored
copy as `bash <path>`, the only `bash` on that machine is the WSL launcher, it
eats the backslashes of a Windows path, and the statusline shows

```
local: exited with exit code: 127: /bin/bash: C:Users<user>.config/ccfzf-pickerccfzf
```

(the backslashes of `<drive>:\Users\<user>\.config\ccfzf-picker\ccfzf` are gone)

Fixing the path would not help: WSL has its own `$HOME` and its own
`~/.claude/projects`, so it would list WSL sessions, not Windows ones.

## Scope

In scope:

- `ccfzf`: a third process-layer branch for Windows, and a self-sufficient
  `--state` entry point;
- `ccfzf-picker`: running that entry point through `python`, path mapping for
  local rows, and Enter for a local terminal row on Windows.

Out of scope, stated so the result is not mistaken for a regression:

- the interactive `ccfzf` list, `--dump` and `--comment` on Windows;
- agent state for Windows rows. There is no `~/.claude/claude-wt/` on that
  machine and no hooks in its `settings.json`, so the status dot, the summary,
  the cost and the context share have no source. Those rows arrive with an
  empty right-hand group. Installing the hooks on Windows is a separate task.

## Aggregator: the Windows process branch

`ccfzf` gains `WINDOWS = sys.platform == "win32"` beside the existing `DARWIN`.
On that branch `running_sessions()` does not enumerate processes at all. It
reads the session registry that Claude Code itself maintains:

```
~/.claude/sessions/<pid>.json
{"pid":10980,"sessionId":"059dd425-…","cwd":"<drive>:\\projects\\some-project",
 "startedAt":1787255069839,"procStart":"134317286687059374",
 "kind":"interactive","entrypoint":"claude-desktop","name":"some-project-1b"}
```

The registry is the only available answer to "which process is which session".
`Win32_Process` does not expose a process working directory, and the working
directory is what `fresh_ids` needs for a session started as a bare `claude`
with no id in its argv.

Parsing is a whitelist, exactly like `read_windows`: an unknown key is dropped,
a malformed record is skipped, an unreadable or absent directory reads as "no
live sessions" rather than as a failure. The file is never written or deleted
by us — stale records are normal there, all three records on the Windows machine
today belong to dead pids.

Fields taken: `sessionId` (must match the UUID form), `pid` (integer), `cwd`
(non-empty string), `kind`, `procStart`. `entrypoint` is deliberately **not**
taken from the registry: the transcript already carries it and one fact must
have one source.

A record is live when the pid exists **and** its creation time equals
`procStart`. Both halves are required: pids are reused, and without the second
half a recycled pid would revive yesterday's session. The creation time is read
through `ctypes` — `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` plus
`GetProcessTimes`, whose creation `FILETIME` is the same 100-nanosecond value
the registry stores as a string. No subprocess is spawned: only the handful of
pids named by the registry is asked, once per poll.

`procs[sid]` is filled with the same shape as the other two branches: real
`pid` and `cwd`, empty `tty`, `tmux` and `zellij` — none of them exist there.
A record whose `kind` is anything but `interactive` is skipped. `agents`
(background forks) therefore stay empty on this branch: a background kind must
not silently claim a parent's window, and the ancestry check that recognizes one
on Linux (`bg-pty-host`) has no counterpart here.

The lookup of a creation time is injectable, the way `_PS_TABLE` already makes
the macOS branch testable on Linux: the parser takes a callable and the tests
pass a fake table.

## Aggregator: a self-sufficient `--state`

The python block learns `--state` as an alias of its `state` mode, and in that
mode computes the six paths itself — `FZF_MARKS_FILE`, `CCFZF_WINDOWS_FILE`,
`CCFZF_SESSIONS_FILE`, `CCFZF_WINDOWS_DIR`, `CCFZF_COMMENTS_FILE` and the
limit — with the same defaults the bash prologue uses today. The bash wrapper
keeps passing them explicitly, so its behavior does not change; the alias only
makes the block runnable without bash.

The alternative — teaching the picker to assemble those six arguments — was
rejected: it would put a second copy of the defaults in Rust, and the two would
drift silently.

## Picker: running the block

`local_ccfzf::unpack` writes `ccfzf` as it does now, and on Windows writes
`ccfzf.py` beside it: the block cut out between `<<'PYEOF'` and the closing
`\nPYEOF`, the same markers bash and `tests/harness.py` already use. A text
guard asserts the markers are still present in the vendored copy — if they
change, the failure would otherwise read `python: can't open file`.

`local_ccfzf::choose` on Windows returns `("python", [<ccfzf.py>])` and skips
the PATH branch entirely: a `ccfzf` found in PATH there is the same bash script
and cannot be executed. The interpreter is looked up as `python`, then
`python3`; when neither is on PATH the error names them both, rather than
letting the source fail with a spawn error.

`state_args` is unchanged — `--state` for the local source on every platform.

## Picker: a local row needs no path mapping

`mapPath` translates a remote path into a local one and returns `null` when the
path does not start with the configured `remote` prefix. A row that came from
the local source is already local: on Windows its `cwd` is `<drive>:\…`, and
`mapPath` returns `null`, which silently removes every folder action, `Open
plan` and `Open spec` from its menu.

A new `mapRowPath(row, pathMap)` returns `row.cwd` unchanged when
`row.source === 'local'` and falls back to `mapPath` otherwise. Every call
site that maps a row's directory moves to it — the branches of
`availableActions` and the action branches of `runAction` in `sessions.html`;
a text guard keeps new ones from going straight to `mapPath`.

The rule holds on every platform, and it fixes a latent bug rather than adding a
Windows special case: on a Linux picker with `pathMap` configured, a local row's own
absolute path is translated through the remote prefix today, which is equally
wrong.

## Picker: Enter on a local terminal row

`commandParts` returns `['/bin/sh', '-c', remote]` for the local source, and
there is no `/bin/sh` on Windows. Claude Desktop rows are unaffected — they go
through the `claude://resume` link, whose branch is already cross-platform —
but a local terminal session would fail.

On Windows a local row is opened without a shell at all: the command tail is
`claude --resume <id>` appended to the terminal's argv by the existing
`terminalArgv`, and the working directory is set by the spawner. `spawn_detached`
gains an optional `cwd`, applied with `Command::current_dir`; the POSIX
`inDir`/`$SHELL -ic` form is not used, since it exists to make an interactive rc
file run, and there is no such rc there.

One open detail belongs to the implementation, not to this document: a terminal
does not always inherit the caller's directory — Windows Terminal starts a tab
in its profile's `startingDirectory` unless told `-d`. The plan settles the
exact per-preset flag with a live check on the Windows machine, and falls back
to composing `cmd /k` with the directory inside the command when no flag works.
`;` must not appear in whatever is composed: Windows Terminal splits its command
line on it.

## Tests

Aggregator, all runnable on Linux:

- registry parsing over a fixture directory: a live record, a dead pid, a pid
  whose creation time disagrees with `procStart`, a malformed file, a record
  with unknown keys, an absent directory;
- the `--state` alias produces the same document as the `state` mode invoked
  with explicit paths;
- an end-to-end `--state` run over a fake `HOME` with a registry instead of
  `/proc`, in the shape of `test_state_mode.py`.

Picker:

- `mapRowPath` returns a local row's path untouched and still maps a remote
  one; a text guard that no call site maps a row's directory past it;
- the Windows local command carries no `/bin/sh` and no `$SHELL -ic`;
- `spawn_detached` honors `cwd`;
- the `PYEOF` marker guard over the vendored copy.

## Verification and deploy

Live, on the Windows machine: `python ccfzf.py --state` lists session
`059dd425` as live while Claude Desktop holds it open, with
`entrypoint: claude-desktop`, and the same session appears in the picker list
with the `c` glyph. Enter on it raises the application window; Enter on a local
terminal row opens a terminal in the right directory.

Deploy with `data/scripts/deploy-win.sh` for the branch, then the two macs, and
confirm the tray build stamp advanced. The aggregator change ships first and the
vendored submodule is bumped before the picker is built — the local source on
Windows is the vendored copy, and a picker built against the old one would show
nothing.
