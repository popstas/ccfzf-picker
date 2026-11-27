# Settings window

Opened by the gear on the right of the status line, or with `Ctrl+,` (`Cmd+,` on
a Mac). Tabs on the left, the page on the right.

- **General** — the session host, the terminal, whether to show only working
  sessions, whether to hide the window when it loses focus, whether to poll with
  the window closed, dimming of stale sessions and projects, and the name of
  this machine (Enter uses it to decide whether to raise an already-open
  window).
- **Window popup** — the theme first: `As system` (the default, following the
  desktop), `Dark` or `Light`. It repaints both windows at once, this one
  included, without reopening them. Then width and height per layout, narrow and
  wide: a `Default`
  radio button (the built-in size, identical on any screen), a share of the
  screen, or your own pixel count in the field next to it. On a large monitor,
  `80% of screen` for the narrow list's height fits noticeably more sessions.
  Also here: dimming the desktop behind the picker, with a separate checkbox per
  layout.
- **Columns** — two checkboxes per column: `list` — whether to draw the column
  in the row, `statusline` — whether to put its checkbox in the line at the
  bottom. Space in the status line is limited, and what goes there is your call.
  On Windows the `Other` table also holds `hide dimmed windows`: it hides the
  taskbar buttons of this machine's dimmed sessions and leaves their rows in
  the list, while `hide dimmed` hides the rows and leaves the buttons — the two
  are independent. It is off by default and sits in the status line; it needs
  `dim stale` and windows11-manager on this machine, a session that needs you
  keeps its button, and the service brings the buttons back on its own if the
  picker goes quiet. It replaces the `hideDimmedFromTaskbar` option of
  `config.yaml`: if that is `true`, the checkbox starts out on.
- **Context highlight** — the context-share thresholds of the `usage` column
  (light text, yellow, red), and how many minutes before the prompt cache
  expires the taskbar button of the session window starts blinking yellow
  (`cacheWarnMinutes`, 10 by default, `0` turns it off). The blinking is drawn
  by windows11-manager, so it reaches only WezTerm windows on a machine running
  it; focusing the window stops it until the agent answers again.
- **Auto-compact** — off by default. When on, once a minute the picker looks
  for idle sessions with at least `threshold` percent of context (16) whose
  last reply was `after` minutes ago (58) and less than an hour ago, and sends
  them `/compact` through `claude-wt session compact` on the ssh host — once per
  idle, while the prompt cache is still warm. Only sessions in a WezTerm window
  on this machine; the others are skipped with the reason in the Log tab. `^K`
  → **Auto-compact: on/off** turns it off for one session.
- **Statusline** — whether to show the sort switch and the session menu hint on
  the left of the statusline (both on by default, applied at once), and the URL
  of a JSON with Claude usage limits (`claudeUsageUrl`). With a URL the
  statusline shows `5h: 43% -117m 54m left | week: 87% +1.4d` — see
  [configuration.md](configuration.md#statusline). The switches live in
  `config.yaml`, not `ui.json`: they show or hide whole blocks rather than
  columns.
- **Layout panels** — the order, collapsed state and visibility of the wide-mode
  (`^F`) panels: which column a panel occupies and along which axes. Below the
  wide table, **Column widths in the wide view** switches between `Equal` and
  `2/3 and 1/3`: with the latter, when columns 1 and 3 are the only ones on
  screen, the first takes two thirds of the width.
- **Hotkeys** — the picker's global hotkey, the projects-mode hotkey, the tile
  hotkey (which asks the window tracker to lay this machine's windows out in the
  order of the list — see [window-layouts.md](window-layouts.md)) and the
  per-project hotkeys. A combination is not typed as text: click the field and
  press the keys; `Clear` restores the built-in default. Also here: what a click
  and a middle click on the tray icon do — show the list, show projects, or tile
  the windows. The right button opens the tray menu and cannot be rebound.
- **MQTT** — the broker that carries window raising, layout snapshots and
  opening a session on the machine with the window tracker. The broker field
  takes a bare host name or an address: `mqtts://host:8883` connects over TLS,
  trusting the public roots built into the picker; `CA certificate` replaces
  them with one PEM file, for a broker with its own certificate.
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
