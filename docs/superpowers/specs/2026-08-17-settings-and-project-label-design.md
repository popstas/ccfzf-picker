# Окно настроек, размер пикера и подпись проекта

Дата: 2026-08-17. Один репозиторий: `ccfzf-picker`.

## Цель

Сделать окно настроек читаемым (вкладки по смыслу, таблица колонок, autosave),
дать выбирать размер пикера в один клик вместе с затемнением фона, и в списке
показывать серый basename проекта вместо длинного пути — только когда его ещё
нет в имени строки.

## Вне скоупа

Реестр терминалов, прыжок выбора в широком режиме, серый кружок у пустых
проектов, комментарии к сессиям, Place cascade, счётчики TODO.md, спеки/планы
как PR, поле bundle ids (это macos-windows-manager).

## Вкладки

Порядок слева, сверху вниз:

1. General
2. Dim stale sessions
3. Window size (бывшая Window)
4. Columns (бывшая UI)
5. Layout panels (бывшая Panels)
6. Hotkeys
7. MQTT
8. Paths

Вкладки Integrations больше нет: её поля разъехались в General, MQTT и Paths.

Вкладок восемь, а не семь, как было задумано здесь изначально: `Dim stale
sessions` приехала параллельно, из #13 (`docs/superpowers/specs/
2026-08-17-stale-settings-tab-design.md`), и слияние этой ветки с тем PR
оставило её отдельной вкладкой сразу после General, а не вернуло четыре
stale-поля туда. Список тут правлен по факту слияния, а не по изначальному
плану.

Страницы по-прежнему задаёт таблица `PAGES` в `frontend-src/settings-form.js`.
Columns и Layout panels полей конфига не имеют — рисуются своим кодом в
`settings.html`, как сегодня UI и Panels. Тест, сверяющий список `PAGES.map(p =>
p.id)`, правится вместе с таблицей.

### General

Поля: Host with sessions, Terminal preset, затем `<details>` с Terminal и
Terminal arguments (открыт, только если пресет Custom), Only running sessions,
Hide the window when it loses focus, Keep polling while the window is closed,
Allow reptyr / takeover, **Name of this machine** (переезд из Integrations).
Группы stale здесь больше нет — все четыре её поля переехали на свою вкладку
`Dim stale sessions` вместе со слиянием #13 (см. правку списка вкладок выше).

У каждой галки атрибут `title` с тем же текстом, что сейчас в `hint` (или с
новым пояснением, если hint пуст). Подсказка при наведении, не вторая строка
под полем.

### MQTT

Поля брокера: host, port, user, password, topic prefix. Над полями английский
текст:

> Focus, snapshots, and opening a session through a window manager need MQTT.
> Without a broker those actions do not run. On Windows the manager both
> focuses windows and opens terminals. On a Mac the tracker focuses windows
> and the picker opens terminals itself — the broker is still required for
> focus.

### Paths

Два поля `pathMap.remote` / `pathMap.local`. Короткое имя вкладки — Paths.
Список настроенных `actions` остаётся на этой вкладке (сегодня он висел под
Integrations).

### Высота окна настроек

`SETTINGS_SIZE` в `main.rs` сейчас 820×1080. После разноски General с
свёрнутым терминалом короче; высоту уменьшить так, чтобы самая длинная вкладка
(ожидаемо Columns или Layout panels) влезала на экран 1920×1080 без
вертикального скролла у `#page`. Ширину 820 не трогать. Сторож
`settings_window_fits_a_1080p_screen` остаётся: на 1080p зажимать высоту уже
не за что, либо зажим не режет содержимое.

## Columns

Бывшая вкладка UI. Это таблица того, что рисуется в строке списка и в
статуслайне, не «весь UI пикера».

Оси в шапке слева направо: **list**, затем **statusline**. List главная.
Фильтры (`onlyWindow`, `showAll`) остаются второй таблицей ниже, как сейчас.

Две группы строк:

- **Recommended:** все ключи `TOGGLE_CHECKS` с `side !== 'filter'`, кроме
  `showEvent` и `showCost`. В набор входят prompt, answer, paths/project,
  hotkeys, id, context, window, window host. `id` здесь, хотя `list` у него
  по умолчанию выключен.
- **Other:** events, cost и новая строка terminal icon.

У заголовка Recommended — галка по оси list:

- включена, если у всех Recommended `list === true`;
- выключена, если ни у одного;
- неопределённое состояние, если смесь;
- клик, когда не все включены, включает `list` у всех Recommended;
- клик, когда все включены, выключает `list` у всех Recommended.
  Ось `statusline` галка заголовка не трогает.

У каждой строки — шрифтовая иконка слева от подписи (тот же приём, что у
пунктов меню `^K`: знаки, а не картинки). У неоднозначных подписей — `title`
на имени, как уже у осей statusline/list: events, window, window host.
Тексты английские, коротко что рисуется (событие агента, глиф окна, имя
машины окна).

Новая строка **terminal icon**, ключ `showTerminalIcon`, по умолчанию
`{ list: false, statusline: false }`. Включённая ось `list` подменяет глиф
окна иконкой приложения терминала (wt, kitty, ghostty, wezterm, iterm), если
запись окна называет процесс или приложение. Нет поля — остаётся нынешний
глиф, не пресет пикера: у соседних строк терминалы разные, общий пресет врал
бы. Ось statusline у этой строки не рисует отдельную галку внизу списка:
подмена глифа живёт только в колонке окна. Незнакомый ключ в старом `ui.json`
нормализуется как остальные.

Подпись галки `showPaths` в статуслайне и в таблице становится `project`.
Ключ не переименовывать: старый `ui.json` обязан читаться.

## Хром формы

Сохранение одно и то же для кнопки и для autosave: `fieldsToPatch` +
`save_config` для yaml, прежний dirty-снимок для `ui.json`. Пауза autosave —
400 мс после последнего `input`/`change`. Кнопка Save остаётся, padding
увеличить. `validate` не пуст — файл не писать, статус красный у кнопки, как
сейчас.

Первая загрузка окна после обновления показывает пустую высоту `pickerSize`
как 65%. Это отличается от нуля на диске, и первый autosave/Save запишет 65.
Кто настройки не открывал, живёт со встроенным размером. Пункт Default в
радио по-прежнему ноль, встроенный размер.

Пресет не Custom — поля Terminal и Terminal arguments внутри свёрнутого
`<details>`. Custom — `<details open>`.

Справочник F1 (`#keys-title` в `sessions.html`): заголовок `ccfzf-picker`
плюс версия из `CARGO_PKG_VERSION`. Подзаголовок Keyboard shortcuts. Внизу
контента: `MIT License` и ссылка https://github.com/popstas/ccfzf-picker.
Разметка клавиш не меняется.

`stale.projectDays` уходит. Здесь изначально планировалось умолчание 168
(семь суток) и разовая миграция `projectDays * 24` для тех, у кого
`projectHours` не задан. Слияние с #13 (`docs/superpowers/specs/
2026-08-17-stale-settings-tab-design.md`) отменило оба пункта: `projectDays`
не читается вовсе, ни в каком виде, а умолчание `projectHours` — 24, как в
том PR. Подпись поля осталась той же: `Projects become stale after, hours`.

## Размер окна пикера

Вкладка Window size, четыре стороны как сейчас (узкая/широкая × ширина/высота).
На каждой стороне:

- радиокнопки в один ряд: Default, 50%, 65%, 80%, 95%, 100%;
- необязательное поле пикселей рядом.

100% — это `scale_axis` = 100, доля экрана, не `set_fullscreen`. Панель задач
и вырез на маке остаются.

Правило значения в `pickerSize.*.width` / `height`:

- `0` — встроенный размер (Default);
- `1..=100` — доля экрана в процентах;
- `≥ 101` — пиксели.

Поле пикселей всегда значит пиксели. Число ≥ 101 уходит в тот же ключ
`pickerSize` и главнее радио: радио визуально не выбрано. Число 1–100 в поле
пикселей форма не сохраняет — для долей экрана есть радио. Выбор радио чистит
поле пикселей. Оба конца (`scale_axis` в Rust и `normalizePickerSize` на
странице) обязаны принять одну и ту же шкалу; сторож по тексту диапазона в
`main.rs` расширить на ветку пикселей.

`narrow_size_matches_the_window_config` не ломается: ноль по-прежнему
совпадает с `tauri.conf.json`. Смена видимого умолчания — только через запись
65 в yaml при первом сохранении настроек, не через смену смысла нуля.

## Затемнение фона

Две галки на вкладке Window size, по умолчанию выключены:

- `Dim the desktop behind the list`
- `Dim the desktop behind the wide view`

Ключи `scrim.narrow` / `scrim.wide` в `config.yaml`. Нет группы — обе false.

Это не второй webview. Нативный scrim процесса пикера: на Windows —
layered popup на весь экран рабочего стола пикера; на macOS — `NSWindow` с
чёрной полупрозрачной заливкой, уровнем ниже окна пикера. Linux флаги
сохраняет и игнорирует. Opacity фиксированный (0.45), крутилки нет.

Показ: `show_picker` показывает scrim, если галка **текущей** раскладки
включена (`fullscreen` из `ui.json`). `hide_picker` гасит scrim. Смена
`^F` пересчитывает видимость. Клик по scrim уводит фокус с пикера; при
включённом `hideOnBlur` пикер гаснет сам. Отдельного обработчика клика не
нужно.

## Подпись проекта в списке

Ключ `showPaths` живёт. Подпись везде `project`.

В теле строки вместо `shortPath(cwd)` — basename каталога, класс `.cwd` как
сейчас, серый. Полный `shortPath` остаётся в `rowTitle` / `titleAttr`.

Подпись не рисуется, если basename уже назван в имени строки. Сравнение:

1. взять имя (`label` / `title` / то, что уже идёт в первую строку) и
   basename `cwd`;
2. разрезать каждое по `[^a-zA-Z0-9]+`, привести к нижнему регистру, пустые
   части выбросить;
3. оба множества непусты и одно содержится в другом → подпись гасить.

`ccfzf_picker` и `ccfzf-picker` совпадают. Короткое имя `picker` в каталоге
`ccfzf-picker` тоже совпадает: `{picker} ⊂ {ccfzf, picker}` — это следствие
правила «по словам», принятого явно. Пустой cwd или пустое имя подпись не
гасит (гасить нечем).

Тот же помощник у `sessionItem`, `projectItem` и snapshot-session. У проекта
`label` есть имя каталога, подпись погаснет почти всегда — повтор не нужен,
путь в подсказке.

Помощник живёт в `frontend-src/session-glyph.js` рядом с `shortPath`. Тесты —
`test/session-glyph.test.js` и контракт строки в `test/row-contract.test.js`.

## Поток данных

1. `PAGES` задаёт вкладки и поля yaml; Columns/Layout panels — по `id` в
   `settings.html`.
2. Autosave и Save зовут один `persist()`: validate, патч yaml, dirty-оси
   ui.json.
3. `pickerSize` и `scrim` читает Rust в `wanted_size` / показе scrim.
   Страница размер не считает.
4. Подпись проекта считает страница из `cwd` и имени строки, без новых
   полей агрегатора.

Новых команд Tauri, кроме показа/сокрытия нативного scrim из уже существующих
`show_picker` / `hide_picker` / `set_picker_size`, не нужно.

## Проверка

- список id вкладок и английские заголовки;
- Integrations отсутствует, windowHost на General, mqtt на MQTT, pathMap на
  Paths;
- terminal details открыт только у Custom;
- autosave не пишет при ошибке validate и пишет патч после паузы;
- Recommended-галка включает и выключает только ось list;
- колонки таблицы — list затем statusline;
- подпись `project`, ключ `showPaths`;
- `projectDays` полностью игнорируется (см. правку выше — миграция из #13 не
  прижилась, слияние оставило только `projectHours`);
- 0 / 1–100 / ≥101 в `scale_axis` и в форме;
- 100% не зовёт fullscreen;
- scrim не создаётся вторым webview; на Linux флаги без окна;
- слова basename гасят подпись, полный путь в title;
- у проекта без расхождения имени подписи в `.cwd` нет;
- `npm test` и `cd src-tauri && cargo test`.
