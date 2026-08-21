# Configuration

Copy `config.example.yml` to `~/.config/ccfzf-picker/config.yaml` (on Windows,
`%USERPROFILE%\.config\ccfzf-picker\config.yaml`) and set `sshHost`. Without it
the picker says the config is not set up: there is deliberately no default host.

Every field is documented by a comment right in `config.example.yml`.

## Sessions from this machine

`localSource: true` adds a second source: the picker runs `ccfzf --state` here,
as a process, without ssh. Both lists are shown as one — a session keeps the
machine of its window, and a session with no window belongs to the source that
reported it.

`ccfzf` is taken from `PATH`. If it is not there, the picker unpacks the copy
built into the binary (`~/.config/ccfzf-picker/ccfzf`) and runs it through
`bash`. `PATH` comes first on purpose: on a machine where `ccfzf` is already
installed, it is the one that rewrites `~/.ccfzf.sessions.json` — the dump the
window tracker, the Home Assistant export and the openHASP panel live on.

Linux and macOS only: `ccfzf` is a bash wrapper around an embedded python
program, and neither it nor the bundled copy runs on native Windows.

With `localSource` on, `sshHost` may be left empty — one source is a working
setup. Local sessions get no window mark and no Enter-to-focus until the window
tracker on this machine learns to bind them; that is a separate task.

## Mapped directories and folder actions

If the remote host's directories are mounted on this machine, set `pathMap` — a
pair of "path there ⇄ path here". With it the picker adds folder-opening
actions from `actions` to every session: Explorer, Finder, an editor — whatever
you write there.

The picker knows no applications by name; it substitutes the path into `argv`
and runs it, and you supply the command and the hotkey. A `^K` menu item can
additionally be bound to a bare letter with `menuKey`; it only works while the
menu is open, which is why it can take even the letters the picker keeps for
itself under Ctrl.

Without `pathMap` these actions do not exist, and a session whose directory is
outside the shared tree does not get them either.

## Layout snapshots

If `mqtt` is configured and `windowHost` matches the machine where the windows
are, the picker gains snapshot mode — `^S`, or `/s` in the search line.

A layout snapshot is remembered by the window tracker once the set of open
sessions has settled. Enter on the header raises the whole layout, Enter on a
session row raises just that one. Snapshots arrive in the same aggregator
response as the list; the picker has no client of its own for them.

Asking the tracker to tile or cascade windows is described in
[window-layouts.md](window-layouts.md).

## Background refresh

The picker polls the aggregator with the window closed too: once a minute, and
less often when nothing happens — 2, 4, 8 minutes — then back to once a minute
as soon as something changes.

That way the list is ready for the next opening, and `ccfzf --state` keeps its
own dump fresh, the one the Home Assistant export and the openHASP panel live
on. Turned off with `backgroundRefresh: false`.
