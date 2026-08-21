# Settings window

Opened by the gear on the right of the status line, or with `Ctrl+,` (`Cmd+,` on
a Mac). Tabs on the left, the page on the right.

- **General** — the session host, the terminal, whether to show only working
  sessions, whether to hide the window when it loses focus, whether to poll with
  the window closed, dimming of stale sessions and projects, and the name of
  this machine (Enter uses it to decide whether to raise an already-open
  window).
- **Window popup** — width and height per layout, narrow and wide: a `Default`
  radio button (the built-in size, identical on any screen), a share of the
  screen, or your own pixel count in the field next to it. On a large monitor,
  `80% of screen` for the narrow list's height fits noticeably more sessions.
  Also here: dimming the desktop behind the picker, with a separate checkbox per
  layout.
- **Columns** — two checkboxes per column: `list` — whether to draw the column
  in the row, `statusline` — whether to put its checkbox in the line at the
  bottom. Space in the status line is limited, and what goes there is your call.
- **Layout panels** — the order, collapsed state and visibility of the wide-mode
  (`^F`) panels: which column a panel occupies and along which axes.
- **Hotkeys** — the picker's global hotkey, the projects-mode hotkey, the tile
  hotkey (which asks the window tracker to lay this machine's windows out in the
  order of the list — see [window-layouts.md](window-layouts.md)) and the
  per-project hotkeys. A combination is not typed as text: click the field and
  press the keys; `Clear` restores the built-in default. Also here: what a click
  and a middle click on the tray icon do — show the list, show projects, or tile
  the windows. The right button opens the tray menu and cannot be rebound.
- **MQTT** — the broker that carries window raising, layout snapshots and
  opening a session on the machine with the window tracker.
- **Paths** — the directory mapping (`pathMap`) between this machine and the
  remote one. Folder-opening actions are shown, but are edited only in
  `config.yaml`.

## Saving

An edit saves itself 400 ms after a pause in typing; the Save button does the
same immediately, without waiting for the pause.

The Columns and Layout panels tabs write `~/.config/ccfzf-picker/ui.json`, the
rest write `~/.config/ccfzf-picker/config.yaml`. Changes apply at once, hotkeys
included: no restart needed.

**`config.yaml` loses its comments after the first save from the window.** The
file is rewritten in full, and there is nothing to preserve the notes with. The
previous file is left next to it as `config.yaml.bak`, and a description of
every key always lives in `config.example.yml`.

Saving closes both files to outsiders (`0600` where such permissions exist): the
config holds the broker password.
