# ccfzf-picker

Пикер сессий Claude Code, живущих на удалённой машине. Список приезжает по ssh
из агрегатора `ccfzf --state`, окно и глобальные хоткеи — Tauri 2, сессия
открывается в терминале по вашему выбору.

## Установка

Нужен Rust, Node 22+, `tauri-cli` (`cargo install tauri-cli`) и терминал на
локальной машине; на удалённой — `ccfzf` (снимок лежит в `vendor/ccfzf`).
Без `tauri-cli` `cargo tauri build` упадёт с `no such subcommand: tauri`.

```
npm test                      # тесты фронтенда
cd src-tauri && cargo test    # тесты оболочки
cargo tauri build             # сборка
```

## Настройка

Скопируйте `config.example.yml` в `~/.config/ccfzf-picker/config.yaml`
(на Windows — `%USERPROFILE%\.config\ccfzf-picker\config.yaml`) и укажите
`sshHost`. Без него пикер покажет, что конфиг не настроен: умолчания у хоста
нет намеренно.

Каждое поле описано комментарием прямо в `config.example.yml`.

## Как устроено

- `frontend-src/` — чистые функции и отрисовка, каждый файл в UMD-шиме:
  работает и как `<script>`, и как CommonJS-модуль в тестах.
- `sessions.html` — окно пикера: разметка, стили и вся запись в DOM.
- `src-tauri/` — оболочка: окно, трей, глобальные хоткеи, чтение конфига,
  вызов ssh.
- `scripts/prepare-frontend.js` — собирает статику в `frontend/` копированием,
  без сборщика. Запускается из `beforeBuildCommand` в Tauri.
- `scripts/check-state.js` — прогон живого ответа агрегатора через ту же
  проверку формы, что и тесты: `ccfzf --state | node scripts/check-state.js`.
- `scripts/check-agent-of.py` — проверка склейки `state.json` и `status.json`
  внутри агрегатора: `python3 scripts/check-agent-of.py vendor/ccfzf`. Тесты
  проекта туда не достают — они про фронтенд, — а «последняя активность» уже
  один раз сломалась именно там.
- `vendor/ccfzf` — снимок агрегатора. Сам он живёт на удалённой машине и
  правится там, а не здесь.

Тесты — только `node --test`, без зависимостей. Запускать `npm test`;
`node --test test/` на этих версиях Node не работает. Питон внутри снимка
агрегатора этим не покрыт — для него есть `scripts/check-agent-of.py`,
он стоит отдельно и требует только стандартной библиотеки.

## Документы

- [CLAUDE.md](CLAUDE.md) — как собирать и какие правила уже оплачены багами.
- [docs/TODO.md](docs/TODO.md) — что отложено и почему.
