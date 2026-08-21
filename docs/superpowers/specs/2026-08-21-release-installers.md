# Релизный конвейер: инсталлятор Windows, каска для мака, размер

Дата: 2026-08-21. Задача из `# next`: релиза нет вовсе, обе сборки делаются
руками, и выкатка на три машины идёт мимо GitHub — `deploy-*.sh` зовут
`cargo build --release` на целевой машине. Постороннему человеку скачивать
нечего.

## Что делаем

Тег `v*` запускает `.github/workflows/release.yml`, и он даёт три вещи:
установщик под Windows, `.app` под macOS и обновлённую homebrew-каску.

Четыре работы, форма взята у `talks-reducer/.github/workflows/ci.yml` — там она
уже обкатана на живых релизах:

| работа | машина | делает |
| --- | --- | --- |
| `build-windows` | `windows-latest` | `tauri build` → `bundle/nsis/*-setup.exe` |
| `build-macos` | `macos-latest` (arm64) | `tauri build` → `.app`, жмётся `ditto` в zip |
| `release` | `ubuntu-latest` | git-cliff по `cliff.toml`, заводит релиз, кладёт оба файла |
| `update-homebrew` | `ubuntu-latest` | версия и sha256 в каску `popstas/homebrew-ccfzf-picker` |

## Решения и их цена

**NSIS, а не MSI и не Inno.** Собирает сам `tauri build`, доустанавливать в CI
нечего, и у соседнего windows11-manager этот путь уже работает. `installMode:
currentUser` — пикер это значок в трее одного человека, UAC ему не нужен.
WebView2 остаётся в режиме `downloadBootstrapper` (умолчание): соседний
`offlineInstaller` добавил бы к установщику около 130 МБ.

**Размер — переменными окружения, а не вторым профилем.** `[profile.release]`
намеренно собран под скорость выкатки (`incremental`, без LTO), и таблица
замеров в `Cargo.toml` про это предупреждает прямо. Своего `--profile` у
`tauri build` нет — проверено по справочнику CLI v2, — поэтому релизная сборка
перекрывает профиль через `CARGO_PROFILE_RELEASE_*` в самом workflow. Выкатка
на три машины от этого не замедляется ни на секунду: переменных там нет.

**Мак — arm64 и без подписи.** Developer ID нет, universal-сборка удвоила бы
вес ровно в той задаче, где вес и оптимизируется. Плата видна человеку:
Gatekeeper на неподписанном приложении говорит «повреждено», поэтому и README,
и описание релиза называют `--no-quarantine` в команде установки. Каска несёт
`depends_on arch: :arm64` — на Intel-маке она честно откажется вместо того,
чтобы поставить неработающее.

**Релиз заводит workflow, тело собирает git-cliff.** Прежние пять релизов
написаны прозой руками; с этого тега тело собирается из сообщений коммитов.
`cliff.toml` взят у windows11-manager — он уже понимает здешние `feat`, `fix`,
`task` и `chore`.

## Две мины, обе молчаливые

**Сабмодуль назван ssh-адресом.** `vendor/ccfzf` вшивается `include_str!`-ом, и
без него не компилируется весь крейт, а `actions/checkout` по
`git@github.com:` в CI не сходит. Лечится строкой
`git config --global url."https://github.com/".insteadOf "git@github.com:"`
перед чекаутом. Правкой `.gitmodules` — нельзя: пуш в сабмодуль идёт по ssh.

**Тег расходится с версией.** У windows11-manager это уже стоило трёх релизов
без единого `.exe`: workflow висел на `v*`, а теги ставились с префиксом
компонента, и не сработавший workflow ничем себя в релизе не проявляет.
Поэтому шаг сверки `github.ref_name` с версией из `tauri.conf.json` валит
сборку вслух, а тест `test/version-sync.test.js` держит согласие трёх мест, где
версия правится руками: `package.json`, `tauri.conf.json`, `Cargo.toml`.

## Что делает человек руками

Секрет `HOMEBREW_TAP_TOKEN` в `popstas/ccfzf-picker` — PAT с правом записи в
tap: `GITHUB_TOKEN` в чужой репозиторий не пускают. До этого работа
`update-homebrew` падает на пуше — красно и вслух.
