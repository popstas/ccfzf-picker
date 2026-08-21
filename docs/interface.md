# Interface reference

## Panels

- **Your live sessions** — on the left. The panel is always shown, even empty.
- **Other machines' live sessions** — in the middle, as one block; machines are
  named by subheadings (`mac`, `macbook`) and ordered by freshness.
- **Projects** — on the right: a favourite star, the session count and how many
  of them are live (`125 · 1●`), a per-project hotkey (`Ctrl+F11` opens a
  terminal in the project directory, bypassing the picker) and how long ago it
  was last worked on. The circle on the left distinguishes three states: green —
  there are live sessions, grey — there were, transparent — there never were
  any.
- **Snapshots** and **History** are collapsed by default (`Snapshots - 20`,
  `History - 92`) — the count is visible anyway.

Panel headers can be dragged between columns with the mouse, and the order
survives a restart. Wide mode has three columns by default, and up to five by
dragging.

**Hovering or selecting a project row dims the rows that do not belong to it** —
across every panel at once, so what belongs to the project and what does not is
visible. It does not engage in a list of projects alone: there is nothing to
separate there.

## Search

A single line at the top filters every panel at once. Five mode prefixes
(`/l`, `/r`, `/h`, `/p`, `/s`) leave one panel on screen. A forgotten keyboard
layout is not a problem: `зшслук` finds `picker`.

## The session row

Name, project, the human's last request and the agent's reply.

Stale sessions are dimmed — and so are the ones whose window is minimized on
this machine; the `dim stale` checkbox turns that off. Dimmed rows are also
excluded from a tile layout.

Sessions sharing a name are told apart by a mark: the machine name first, and if
that matches too, the tail of the id.

**The status circle** — green: the agent is working; yellow: it is asking;
orange: it finished and the result has not been looked at; grey: idle;
transparent: the session is closed.

**Row columns** — the letter of the terminal the window is open in (`k` — kitty,
`i` — iTerm2, `z` — WezTerm), the machine, the short session id, the share of
context used, the age of the last activity. Which columns to draw is a setting.

**PR link** — `↗ #19` on the session it was opened from.

**Claude Desktop sessions** are marked with a `c` in the window column, and
Enter returns them to the app itself rather than opening a terminal. The old
route remains as the `Resume in terminal` item in the `^K` menu. This works for
sessions of this machine: the app resumes a session by its transcript, and the
transcript lies where the session was opened.

## Keys

**The `^K` menu** — actions on a session; an item fires on a bare letter,
without Ctrl. For your own actions from `config.yaml` the letter is set by the
`menuKey` field.

**Ctrl+Enter or Ctrl+click** — open the session on whichever display the mouse
is on, and leave the window there: the window tracker will not pull it to where
this session lived yesterday, nor to a rule from its own config. This works
where the window manager opens windows (Windows); it does not consult the
`Open sessions on active display` checkbox — that one is about every opening at
once, while the modifier is about one.

**`^F`** unfolds the window into wide mode: the session is shown as a card with
the request and the agent's reply, while groups, projects and snapshots stand
next to it as blocks, each with its own scroll. `↑/↓` move inside a block,
`←/→` between blocks. Everything else — search, prefixes, actions, Enter —
works exactly as in the narrow list; the mode is remembered in `ui.json` and
survives a restart.

**`^S`** or `/s` opens snapshot mode, when MQTT is configured — see
[Configuration](configuration.md#layout-snapshots).

## Status line

Sorting, the `^K` menu hint, filter checkboxes (`project`, `only windowed`,
`show all`, `dim stale`), the key reference, the wide-mode switch and the
settings gear.
