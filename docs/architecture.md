# How it is put together

- `frontend-src/` — pure functions and rendering, each file in a UMD shim: it
  works both as a `<script>` and as a CommonJS module in tests. The tag order in
  `sessions.html` is part of the contract: a module takes its neighbour from
  `globalThis` at load time. `test/frontend-load.test.js` guards this.
- `sessions.html` — the picker window: markup, styles and all writing to the
  DOM.
- `src-tauri/` — the shell: the window, the tray, global hotkeys, reading the
  config, calling ssh.
- `scripts/prepare-frontend.js` — assembles the static files into `frontend/` by
  copying, with no bundler. Run from `beforeBuildCommand` in Tauri.
- `scripts/check-state.js` — runs a live aggregator response through the same
  shape check the tests use: `ccfzf --state | node scripts/check-state.js`.
- `scripts/make-icons.py` — the application icons from the tray icon:
  `python3 scripts/make-icons.py`. Only `src-tauri/icons/favicon.png` is drawn
  by hand; everything else in `src-tauri/icons/` is the script's output.

## Building and testing

Requires Rust, Node 22+, `tauri-cli` (`cargo install tauri-cli`) and a terminal
on the local machine; on the remote one, `ccfzf`. Without `tauri-cli`,
`cargo tauri build` fails with `no such subcommand: tauri`.

Clone with `git clone --recurse-submodules`, or run
`git submodule update --init` in an existing checkout — the vendored
`vendor/ccfzf` aggregator is compiled into the binary, and without it the whole
build fails.

```sh
npm test                      # frontend tests
cd src-tauri && cargo test    # shell tests
cargo tauri build             # build
```

Tests are `node --test` only, with no dependencies. Run them with `npm test`;
`node --test test/` does not work on these Node versions.

The aggregator does not live here and is not tested here: it has its own
repository with its own tests.
