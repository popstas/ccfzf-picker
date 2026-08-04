# ccfzf-picker

Пикер сессий claude-wt. Список берётся из `ccfzf --state` по ssh, окно
и хоткеи — Tauri, открытие сессии — kitty.

    npm test

## Состояние

Задачи 1–8 плана выполнены: агрегатор, чистые функции и отрисовка списка.
Задачи 9–14 (оболочка на Tauri, macOS) ещё не выполнялись — начинать с них.

- `frontend-src/` — чистые функции и отрисовка, каждый файл в UMD-шиме:
  работает и как `<script>`, и как CommonJS-модуль в тестах.
- `scripts/prepare-frontend.js` — собирает статику в `frontend/` копированием,
  без сборщика. Запускается из `beforeBuildCommand` в Tauri.
- `scripts/check-state.js` — прогон живого ответа агрегатора через ту же
  проверку формы, что и тесты: `ccfzf --state | node scripts/check-state.js`.
- `vendor/ccfzf` — снимок агрегатора для истории правок. Сам он живёт на
  example-host по пути `/home/user/bin/ccfzf` и правится там, а не здесь.

Тесты — только `node --test`, без зависимостей. Запускать `npm test`;
`node --test test/` на этих версиях Node не работает.

## Документы

- [docs/TODO.md](docs/TODO.md) — **прочитать перед задачами 9–14.** Отложенное
  и то, что надо поправить в самом плане, иначе Task 11 «заработает», ничего не
  отрисовывая, а Task 13 позовёт функцию, которой нет.
- [docs/plan-2026-08-04-ccfzf-picker-macos.md](docs/plan-2026-08-04-ccfzf-picker-macos.md) — план работ, задачи 1–14.
- [docs/spec-2026-08-04-ccfzf-picker-macos.md](docs/spec-2026-08-04-ccfzf-picker-macos.md) — спек и обоснование решений.
- [docs/reptyr-experiment.md](docs/reptyr-experiment.md) — опыт с переносом
  живой сессии между терминалами. Вердикт «пригоден»; там же честные оговорки
  о том, что режим `-T` на самом деле проверил, а что нет.

## Машины

- Сессии и агрегатор — `example-host`, репозиторий там же в `~/projects/js/ccfzf-picker`.
- Пикер — macOS, клон в `~/projects/ccfzf-picker`. Node ставится через nvm и не
  подхватывается в неинтерактивном ssh: `zsh -lc 'source ~/.nvm/nvm.sh && npm test'`.
