# Иконки у пунктов меню `^K` — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** у каждой строки меню действий появляется значок слева: иконка
приложения, вытащенная из его `.exe`, там где за пунктом стоит приложение, и
символ шрифта у остальных.

**Architecture:** страница собирает список запросов `{id, path}` из
`CONFIG.actions` и зовёт команду Tauri `action_icons`; Rust раскрывает
переменные окружения и app-execution alias, тянет иконку через WinAPI, отдаёт
`data:image/png;base64,…`. Чего в ответе нет — рисуется глифом из таблицы.
Вся логика выбора «картинка или глиф» живёт в чистом модуле
`frontend-src/action-icons.js`, вся работа с WinAPI — в `src-tauri/src/icons.rs`,
причём разбор буфера alias и сборка RGBA вынесены из-под `cfg(windows)` и
проверяются `cargo test` на любой машине.

**Tech Stack:** Tauri 2 + Rust (`windows` 0.61, `png`, `base64`), фронтенд без
сборщика — UMD-модули тегами `<script>`, тесты `node --test` через `npm test`.

Спека: [2026-08-13-menu-icons-design.md](../specs/2026-08-13-menu-icons-design.md).

## Global Constraints

- **Язык:** видимое человеку — по-английски, комментарии, названия тестов и
  сообщения `assert` — по-русски (`CLAUDE.md`).
- **Тесты фронтенда** запускаются только через `npm test` (`node --test test/`
  на этих версиях Node не работает).
- **Никаких имён машин и путей с буквой диска** в отслеживаемых файлах:
  сторожит `test/no-private-data.test.js`. В примерах писать `%SystemRoot%`,
  `%LOCALAPPDATA%`. Два падения этого теста существуют до начала работы (пути
  внутри `docs/superpowers/plans/2026-07-31-…` и `…2026-08-04-…`) — их не
  чинить и на них не ориентироваться: смотреть, не добавились ли новые строки.
- **Новый файл `frontend-src/*.js`** обязан попасть и в тег `<script>` в
  `sessions.html`, и в `FILES` в `scripts/prepare-frontend.js` — это сторожит
  `test/frontend-load.test.js`.
- **Размер иконки** — 32×32 из WinAPI, показ в 16×16 CSS-пикселей.
- **Отказ извлечения — не событие:** нет иконки, значит глиф. Ни сообщений об
  ошибке, ни строк в статуслайне.

---

## File Structure

| файл | ответственность |
|---|---|
| `frontend-src/config-shape.js` (правка) | ключ `icon` у действия |
| `frontend-src/action-icons.js` (создать) | таблица глифов, сбор списка запросов, выбор «картинка или глиф» |
| `sessions.html` (правка) | стиль слота, разметка строки меню, вызов команды при старте и на `config-changed` |
| `scripts/prepare-frontend.js` (правка) | новый модуль в списке копирования |
| `config.example.yml` (правка) | документация ключа `icon` |
| `src-tauri/src/icons.rs` (создать) | чистые функции разбора + извлечение через WinAPI + кеш |
| `src-tauri/src/main.rs` (правка) | команда `action_icons`, регистрация, `manage` кеша |
| `src-tauri/Cargo.toml` (правка) | `png`, `base64`, расширение features у `windows` |
| `test/action-icons.test.js` (создать) | модуль выбора значка |
| `test/config-shape.test.js` (правка) | ключ `icon` |
| `test/row-contract.test.js` (правка) | слот в разметке строки меню |

---

### Task 1: Ключ `icon` в конфиге

**Files:**
- Modify: `frontend-src/config-shape.js:104-130` (`normalizeActions`)
- Modify: `config.example.yml:115-133`
- Test: `test/config-shape.test.js`

**Interfaces:**
- Consumes: ничего.
- Produces: `normalizeConfig(raw).actions[i].icon` — строка, `''` если ключа
  нет или он не строка. Читает её Task 2 (`iconSpecs`).

- [ ] **Step 1: Написать падающие тесты**

В конец `test/config-shape.test.js`:

```js
// Иконку действия берут из отдельного ключа, а не из argv[0], потому что у
// самого частого действия argv[0] — это `cmd`: проводник открывается через
// `cmd /c start` (правило в CLAUDE.md), и иконка вышла бы от командной строки.
test('icon у действия доезжает до нормализованного конфига', () => {
  const c = normalizeConfig({
    actions: [{
      id: 'explorer',
      label: 'Open in Explorer',
      argv: ['cmd', '/c', 'start', '', '{localPathSlash}'],
      icon: '%SystemRoot%\\explorer.exe',
    }],
  });
  assert.strictEqual(c.actions[0].icon, '%SystemRoot%\\explorer.exe');
});

// То же правило, что у hotkey: испорченный ключ обнуляется, но действие
// остаётся в меню. Спрятать пункт из-за опечатки в иконке — потерять доступ к
// нему вовсе, а иконка тут украшение.
test('мусорный icon обнуляется, а действие остаётся в списке', () => {
  const c = normalizeConfig({ actions: [{ id: 'cursor', argv: ['cursor', '{localPath}'], icon: 42 }] });
  assert.strictEqual(c.actions.length, 1, 'опечатка в иконке не повод прятать пункт');
  assert.strictEqual(c.actions[0].icon, '');
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npm test 2>&1 | grep -E "^not ok .*icon"`
Expected: обе строки — `not ok` (`undefined !== '%SystemRoot%\explorer.exe'`).

- [ ] **Step 3: Реализовать**

В `normalizeActions`, в объект, который кладётся в `out.push({…})`, добавить
поле после `hotkey`/`parsedHotkey`:

```js
        // Откуда брать иконку пункта. Пусто — берётся argv[0]; ключ нужен
        // там, где argv[0] не приложение: `cmd /c start` у проводника.
        icon: nonEmpty(item.icon) ? item.icon.trim() : '',
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 2` (те же два предсуществующих падения `no-private-data`), новых нет.

- [ ] **Step 5: Задокументировать ключ в примере конфига**

В `config.example.yml`, в закомментированном блоке `actions`, дописать строку
к действию `explorer` и комментарий перед блоком:

```yaml
# Ключ `icon` — необязательный: откуда взять иконку пункта меню. Пусто —
# берётся argv[0]. Нужен там, где argv[0] не приложение: проводник
# открывается через `cmd /c start`, и без ключа пункт показал бы иконку
# командной строки. Переменные окружения раскрываются.
# actions:
#   # Windows: проводник и Cursor.
#   - id: explorer
#     label: Open in Explorer
#     hotkey: Ctrl+Shift+E
#     argv: ['cmd', '/c', 'start', '', '{localPathSlash}']
#     icon: '%SystemRoot%\explorer.exe'
```

- [ ] **Step 6: Коммит**

```bash
git add frontend-src/config-shape.js config.example.yml test/config-shape.test.js
git commit -m "feat(picker): ключ icon у действия открытия"
```

---

### Task 2: Модуль выбора значка

**Files:**
- Create: `frontend-src/action-icons.js`
- Test: `test/action-icons.test.js`

**Interfaces:**
- Consumes: `normalizeConfig(...).actions[i]` из Task 1 — поля `id`, `icon`, `argv`.
- Produces:
  - `ActionIcons.iconSpecs(config) -> [{id: string, path: string}]`
  - `ActionIcons.actionIcon(action, icons) -> {kind:'img', src} | {kind:'glyph', text, cls}`
  - `ActionIcons.GLYPHS` — карта `id → {text, cls?}`
  Их зовут Task 3 (разметка) и Task 6 (запрос иконок).

- [ ] **Step 1: Написать падающий тест**

Создать `test/action-icons.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { GLYPHS, iconSpecs, actionIcon } = require('../frontend-src/action-icons');
const { BUILTIN_ACTION_KEYS } = require('../frontend-src/action-hotkey');

// Сторож на будущее: новый встроенный пункт приедет в меню без значка, и
// заметить это можно только глазами на той машине, где пикер стоит.
// `open-remote` в BUILTIN_ACTION_KEYS нет — у него нет прямой клавиши, но
// строка в меню есть.
test('у каждого встроенного пункта есть глиф', () => {
  for (const id of [...Object.keys(BUILTIN_ACTION_KEYS), 'open-remote']) {
    assert.ok(GLYPHS[id], `нет глифа для встроенного пункта ${id}`);
  }
});

test('icon перевешивает argv[0], а без него берётся argv[0]', () => {
  const specs = iconSpecs({ actions: [
    { id: 'explorer', icon: '%SystemRoot%\\explorer.exe', argv: ['cmd', '/c', 'start'] },
    { id: 'cursor', icon: '', argv: ['Cursor.exe', '{localPath}'] },
  ] });
  assert.deepStrictEqual(
    specs.filter(s => s.id !== 'new'),
    [
      { id: 'explorer', path: '%SystemRoot%\\explorer.exe' },
      { id: 'cursor', path: 'Cursor.exe' },
    ],
  );
});

// Пункт `new` в конфиге не описан вовсе, а иконку у него взять есть откуда —
// у агента. На машине без агента запрос вернётся пустым, и встанет глиф.
test('new спрашивается всегда, даже с пустым конфигом', () => {
  assert.deepStrictEqual(iconSpecs(null), [{ id: 'new', path: 'claude.exe' }]);
});

test('действие без icon и без argv в запрос не попадает', () => {
  const specs = iconSpecs({ actions: [{ id: 'broken', icon: '', argv: [] }] });
  assert.deepStrictEqual(specs.map(s => s.id), ['new']);
});

test('картинка выигрывает у глифа, когда она есть', () => {
  const icon = actionIcon({ id: 'info' }, { info: 'data:image/png;base64,AAA' });
  assert.deepStrictEqual(icon, { kind: 'img', src: 'data:image/png;base64,AAA' });
});

test('без картинки встаёт глиф пункта, у неизвестного — запасной', () => {
  assert.deepStrictEqual(actionIcon({ id: 'info' }, {}), { kind: 'glyph', text: 'ⓘ', cls: '' });
  assert.deepStrictEqual(actionIcon({ id: 'unread' }, {}), { kind: 'glyph', text: '●', cls: 'unread' });
  assert.deepStrictEqual(actionIcon({ id: 'whatever' }, {}), { kind: 'glyph', text: '▸', cls: '' });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm test 2>&1 | grep -c "Cannot find module '../frontend-src/action-icons'"`
Expected: не ноль — модуля ещё нет.

- [ ] **Step 3: Написать модуль**

Создать `frontend-src/action-icons.js`:

```js
// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ActionIcons = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Значки пунктов, у которых приложения нет.
   *
   * Три знака взяты из строки списка не для красоты: `↗` там помечает PR,
   * `●` оранжевым горит непросмотренная сессия, `▣` — открытое окно. Один и
   * тот же знак в списке и в меню читается как одно и то же дело; разные
   * заставили бы догадываться, что это про одно и то же.
   */
  const GLYPHS = {
    new: { text: '+' },
    info: { text: 'ⓘ' },
    pr: { text: '↗' },
    unread: { text: '●', cls: 'unread' },
    attach: { text: '⧉' },
    'open-remote': { text: '▣' },
  };

  /** Настроенное действие, чей exe не нашёлся: нейтральное «запустить». */
  const FALLBACK = { text: '▸' };

  /**
   * Что спросить у Rust.
   *
   * Список собирает страница, а не Rust: тот умеет ровно «дай иконку этого
   * файла» и про меню не знает ничего. `icon` перевешивает `argv[0]` — он и
   * заведён ради случая, когда argv[0] не приложение (`cmd /c start` у
   * проводника). Пункт `new` в конфиге не описан, но иконку у него взять
   * есть откуда — у агента; нет агента на машине — встанет глиф.
   */
  function iconSpecs(config) {
    const specs = [{ id: 'new', path: 'claude.exe' }];
    for (const action of (config && config.actions) || []) {
      const path = action.icon || (action.argv || [])[0] || '';
      if (path) specs.push({ id: action.id, path });
    }
    return specs;
  }

  /**
   * Значок строки меню: картинка, если она приехала, иначе глиф.
   *
   * Возвращается описание, а не готовый HTML: экранирование живёт на
   * странице, вместе с остальной сборкой строки, — второй escapeHtml здесь
   * разошёлся бы с ним молча.
   */
  function actionIcon(action, icons) {
    const id = (action || {}).id;
    const src = (icons || {})[id];
    if (src) return { kind: 'img', src };
    const glyph = GLYPHS[id] || FALLBACK;
    return { kind: 'glyph', text: glyph.text, cls: glyph.cls || '' };
  }

  return { GLYPHS, iconSpecs, actionIcon };
});
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 2` — прежние два, новых нет.

- [ ] **Step 5: Коммит**

```bash
git add frontend-src/action-icons.js test/action-icons.test.js
git commit -m "feat(picker): модуль значков меню — глифы и список запросов"
```

---

### Task 3: Слот значка в строке меню

**Files:**
- Modify: `sessions.html` — стиль рядом с `.action-row` (около строки 212),
  тег `<script>` (около строки 315), `renderMenu` (около строки 1184)
- Modify: `scripts/prepare-frontend.js:12-34`
- Test: `test/row-contract.test.js`

**Interfaces:**
- Consumes: `ActionIcons.actionIcon(action, icons)` из Task 2.
- Produces: переменная страницы `actionIcons` (карта `id → dataUri`, пока
  всегда пустая) — её заполняет Task 6.

- [ ] **Step 1: Написать падающий тест**

В `test/row-contract.test.js`, рядом с тестом «строка меню красится тем же,
чем строка списка»:

```js
// Слот значка обязан быть у каждой строки меню, включая глифовые: строка без
// слота съезжает влево, и подписи в меню перестают стоять в одну линию.
// Проверяется исходник шаблона, а не разметка: строка меню собирается внутри
// renderMenu, у которой на входе живой ответ агрегатора.
test('строка меню начинается со слота значка', () => {
  const row = SESSIONS_HTML.match(/<div class="action-row\$\{[\s\S]*?<\/div>`/);
  assert.ok(row, 'шаблон строки меню не найден — тест сторожит не то');
  const icon = row[0].indexOf('action-icon');
  const label = row[0].indexOf('action-label');
  assert.notStrictEqual(icon, -1, 'у строки меню нет слота значка');
  assert.ok(icon < label, 'слот значка идёт перед подписью');
});

test('стиль слота задаёт одну ширину всем строкам меню', () => {
  assert.match(
    SESSIONS_HTML,
    /\.action-icon \{[^}]*flex: 0 0 16px/,
    'без фиксированной ширины подписи разъедутся на строке без иконки',
  );
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npm test 2>&1 | grep -E "^not ok .*(слот|ширину)"`
Expected: обе строки — `not ok`.

- [ ] **Step 3: Добавить стиль**

В `sessions.html`, сразу после правил `.action-row:hover` / `.action-row.active`:

```css
        /* Слот значка. Ширина фиксированная и одинаковая у всех строк, включая
           глифовые: без неё подпись на строке без иконки съезжает влево, и
           меню читается как два списка в одном окне.

           16 px при иконке 32×32 из WinAPI — ровно вдвое; на масштабе 150%,
           который стоит на машине, это 24 устройственных точки, то есть
           картинку ужимают, а не растягивают. */
        .action-icon {
            flex: 0 0 16px; width: 16px; height: 16px;
            display: flex; align-items: center; justify-content: center;
            margin-right: 10px; font-size: 12px; color: #7d838c;
        }
        .action-icon img { width: 16px; height: 16px; }
        /* Тем же оранжевым горит непросмотренная сессия в списке. */
        .action-icon.unread { color: #db6d28; }
```

- [ ] **Step 4: Подключить модуль**

В `sessions.html` дописать тег после `picker-list-sync.js`:

```html
<script src="action-icons.js"></script>
```

В `scripts/prepare-frontend.js`, в конец массива `FILES`:

```js
  'frontend-src/action-icons.js',
```

- [ ] **Step 5: Собрать слот в `renderMenu`**

В `sessions.html`, рядом с объявлениями страницы (около `let menuActive = 0;`):

```js
  // Иконки приложений: id действия → data-URI. Заполняется один раз при
  // старте и на config-changed, см. loadActionIcons.
  let actionIcons = {};
```

В `renderMenu`, внутри `menuActions.map(...)`, перед `return`:

```js
        // Значок: картинка приложения, если Rust её отдал, иначе глиф.
        // Экранируется здесь, вместе с остальной строкой: data-URI приходит
        // из Rust, но правило одно на всю сборку разметки.
        const icon = window.ActionIcons.actionIcon(action, actionIcons);
        const iconHtml = icon.kind === 'img'
          ? `<span class="action-icon"><img src="${escapeHtml(icon.src)}" alt=""></span>`
          : `<span class="action-icon${icon.cls ? ` ${icon.cls}` : ''}">${escapeHtml(icon.text)}</span>`;
```

и в самом `return` поставить `${iconHtml}` перед `<span class="action-label">`:

```js
        return `<div class="action-row${index === 0 ? ' active' : ''}" data-index="${index}" role="menuitem">` +
          `${iconHtml}<span class="action-label">${escapeHtml(action.label)}</span>${hotkey}</div>`;
```

- [ ] **Step 6: Убедиться, что тесты проходят**

Run: `npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 2` — прежние два. Заодно молча проходит сторож
`frontend-load.test.js`, требующий модуль и в теге, и в `FILES`.

- [ ] **Step 7: Проверить вёрстку глазами, без Windows**

Меню целиком глифовое (иконок ещё никто не запрашивает) — этого хватает,
чтобы увидеть, что слот не ломает строку:

Харнесс собран при разведке и лежит в scratchpad сессии: `harness/` с
заглушкой `stub.js` (подменяет `window.__TAURI__`), `shot.mjs` (жмёт `^K`,
наводит мышь, снимает через CDP) и `icons/` с иконками, вытащенными на
Windows-машине. Если сессия другая — собрать заново по этому же образцу:
скопировать `frontend/`, дописать тег `stub.js` перед `state-shape.js`.

```bash
S=<scratchpad этой сессии>
node scripts/prepare-frontend.js
cp frontend/* $S/harness/            # заглушка Tauri уже лежит там, см. stub.js
cd $S/harness && python3 -m http.server 8791 &
~/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome --headless=new --disable-gpu \
  --no-sandbox --remote-debugging-port=9223 --user-data-dir=$S/chrome-profile \
  --window-size=900,620 http://127.0.0.1:8791/index.html &
node $S/shot.mjs $S/menu-icons.png   # жмёт ^K, наводит мышь, снимает
```

Ожидается: у всех трёх строк меню слева знак, подписи в одну линию.
Прибрать за собой: `pkill -f "remote-debugging-port=9223"; pkill -f "http.server 8791"`.

- [ ] **Step 8: Коммит**

```bash
git add sessions.html scripts/prepare-frontend.js test/row-contract.test.js
git commit -m "feat(picker): слот значка в строке меню"
```

---

### Task 4: Rust — разбор без WinAPI

**Files:**
- Create: `src-tauri/src/icons.rs`
- Modify: `src-tauri/src/main.rs:14-19` (`mod icons;`)
- Test: `src-tauri/src/icons.rs`, `mod tests` в конце файла

**Interfaces:**
- Consumes: ничего.
- Produces (всё `pub`, всё вне `cfg(windows)`):
  - `struct IconSpec { pub id: String, pub path: String }` (`serde::Deserialize`)
  - `fn appexec_target(buf: &[u8]) -> Option<String>`
  - `fn to_rgba(bgra: &[u8], mask: &[u8]) -> Vec<u8>`
  - `fn resolve_name(name: &str, path_var: &str, exists: &dyn Fn(&std::path::Path) -> bool) -> Option<std::path::PathBuf>`
  Их зовёт Task 5.

- [ ] **Step 1: Написать падающие тесты**

Создать `src-tauri/src/icons.rs` и положить в него пока только `mod tests`
(реализация — Step 3):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// Буфер AppExecLink — как его отдаёт FSCTL_GET_REPARSE_POINT.
    fn appexec_buf(strings: &[&str]) -> Vec<u8> {
        let mut data = vec![3u8, 0, 0, 0]; // версия
        for s in strings {
            for w in s.encode_utf16() {
                data.extend_from_slice(&w.to_le_bytes());
            }
            data.extend_from_slice(&[0, 0]); // NUL
        }
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x8000_001Bu32.to_le_bytes()); // тег
        buf.extend_from_slice(&(data.len() as u16).to_le_bytes());
        buf.extend_from_slice(&[0, 0]); // Reserved
        buf.extend_from_slice(&data);
        buf
    }

    /// Третья строка, а не первая: первые две — имя пакета и AppUserModelID.
    /// Взяв первую, мы бы кормили SHGetFileInfo именем пакета, а он на такое
    /// отвечает дежурной иконкой — то есть ровно тем, из-за чего вся эта
    /// ветка и появилась.
    #[test]
    fn appexec_target_is_the_third_string() {
        let buf = appexec_buf(&[
            "Microsoft.WindowsTerminal_8wekyb3d8bbwe",
            "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App",
            r"X:\Program Files\WindowsApps\Microsoft.WindowsTerminal\WindowsTerminal.exe",
        ]);
        assert_eq!(
            appexec_target(&buf).as_deref(),
            Some(r"X:\Program Files\WindowsApps\Microsoft.WindowsTerminal\WindowsTerminal.exe"),
        );
    }

    /// Чужой тег — не наше дело: обычный symlink разбирать этим разбором
    /// нельзя, у него другая раскладка байт.
    #[test]
    fn other_reparse_tags_are_left_alone() {
        let mut buf = appexec_buf(&["a", "b", "c"]);
        buf[0..4].copy_from_slice(&0xA000_000Cu32.to_le_bytes()); // symlink
        assert_eq!(appexec_target(&buf), None);
    }

    /// Обрезанный буфер даёт None, а не панику: это данные с диска, и
    /// доверять их длине нельзя.
    #[test]
    fn truncated_buffer_is_none() {
        let buf = appexec_buf(&["a", "b", "c"]);
        for cut in [0usize, 4, 8, 12] {
            assert_eq!(appexec_target(&buf[..cut]), None, "обрезка до {cut} байт");
        }
        assert_eq!(appexec_target(&appexec_buf(&["a", "b"])), None, "строк меньше трёх");
    }

    /// Иконка с альфа-каналом берётся как есть, порядок каналов — BGRA→RGBA.
    #[test]
    fn bgra_becomes_rgba() {
        let bgra = vec![10, 20, 30, 255, 1, 2, 3, 128];
        let out = to_rgba(&bgra, &[]);
        assert_eq!(out, vec![30, 20, 10, 255, 3, 2, 1, 128]);
    }

    /// Старая иконка без альфы: во всём битмапе ноль, и взять её как есть
    /// значило бы показать пустоту. Прозрачность собирается по маске, где
    /// белый — дырка.
    #[test]
    fn alpha_comes_from_the_mask_when_missing() {
        let bgra = vec![10, 20, 30, 0, 40, 50, 60, 0];
        let mask = vec![0, 0, 0, 255, 255, 255, 255, 255];
        let out = to_rgba(&bgra, &mask);
        assert_eq!(out, vec![30, 20, 10, 255, 60, 50, 40, 0]);
    }

    /// Голое имя ищется по PATH с дописанным .exe; путь с разделителем не
    /// трогается вовсе — иначе `wt.exe` из PATH перебил бы путь из конфига.
    #[test]
    fn bare_name_is_looked_up_in_path() {
        let path_var = r"X:\one;X:\two";
        let exists = |p: &std::path::Path| p.to_string_lossy() == r"X:\two\cursor.exe";
        assert_eq!(
            resolve_name("cursor", path_var, &exists).map(|p| p.to_string_lossy().to_string()),
            Some(r"X:\two\cursor.exe".to_string()),
        );
        assert_eq!(resolve_name("nope", path_var, &exists), None);
    }
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd src-tauri && cargo test icons 2>&1 | tail -20`
Expected: ошибки компиляции — `appexec_target`, `to_rgba`, `resolve_name` не найдены.

- [ ] **Step 3: Написать разбор**

В начало `src-tauri/src/icons.rs`, до `mod tests`:

```rust
//! Иконки приложений для меню действий.
//!
//! Разбор — здесь и без `cfg(windows)`: и буфер reparse, и пиксели приезжают
//! байтами, а байты одинаковы везде. Под `cfg(windows)` остаётся обвязка над
//! WinAPI, у которой своей логики нет и проверять в ней нечего.
use std::path::{Path, PathBuf};

/// Один запрос от страницы: чья иконка и под каким id её вернуть.
#[derive(serde::Deserialize)]
pub struct IconSpec {
    pub id: String,
    pub path: String,
}

/// Настоящий exe за app-execution alias.
///
/// `wt.exe` в `WindowsApps` — файл нулевой длины с reparse-тегом
/// `IO_REPARSE_TAG_APPEXECLINK`; иконку система отдаёт по нему дежурную.
/// Настоящий путь лежит внутри самого буфера третьей UTF-16 строкой: первые
/// две — имя пакета и AppUserModelID, четвёртая — тип приложения.
///
/// Прописать этот путь в конфиг руками нельзя: в нём стоит версия пакета, и
/// после обновления Terminal он протухнет молча — иконка просто исчезнет.
pub fn appexec_target(buf: &[u8]) -> Option<String> {
    const TAG: u32 = 0x8000_001B;
    if buf.len() < 12 {
        return None;
    }
    if u32::from_le_bytes(buf[0..4].try_into().ok()?) != TAG {
        return None;
    }
    let len = u16::from_le_bytes(buf[4..6].try_into().ok()?) as usize;
    // Длина с диска: верить ей нельзя, поэтому get, а не срез.
    let data = buf.get(8..8usize.checked_add(len)?)?;
    let words: Vec<u16> = data
        .get(4..)?
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let exe = words.split(|&w| w == 0).nth(2)?;
    if exe.is_empty() {
        return None;
    }
    Some(String::from_utf16_lossy(exe))
}

/// Пиксели иконки из `GetDIBits` — в RGBA для PNG.
///
/// Альфа берётся из битмапа, если она там есть хоть где-то. Нулевая во всём
/// битмапе значит «иконка старая, без альфа-канала» — тогда прозрачность
/// собирается по маске, где белый пиксель это дырка. Взять такую альфу как
/// есть значило бы показать пустой квадрат.
pub fn to_rgba(bgra: &[u8], mask: &[u8]) -> Vec<u8> {
    let has_alpha = bgra.chunks_exact(4).any(|px| px[3] != 0);
    let mut out = Vec::with_capacity(bgra.len());
    for (i, px) in bgra.chunks_exact(4).enumerate() {
        let alpha = if has_alpha {
            px[3]
        } else {
            match mask.get(i * 4) {
                Some(&m) if m != 0 => 0,
                _ => 255,
            }
        };
        out.extend_from_slice(&[px[2], px[1], px[0], alpha]);
    }
    out
}

/// Голое имя — в путь по `PATH`.
///
/// Предикат существования отдельным аргументом: без него тест зависел бы от
/// того, что стоит на машине, где его гоняют.
pub fn resolve_name(
    name: &str,
    path_var: &str,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let file = if name.to_ascii_lowercase().ends_with(".exe") {
        name.to_string()
    } else {
        format!("{name}.exe")
    };
    path_var
        .split(';')
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join(&file))
        .find(|candidate| exists(candidate))
}
```

В `src-tauri/src/main.rs`, к списку `mod`:

```rust
mod icons;
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd src-tauri && cargo test icons 2>&1 | tail -12`
Expected: `test result: ok. 6 passed`.

- [ ] **Step 5: Коммит**

```bash
git add src-tauri/src/icons.rs src-tauri/src/main.rs
git commit -m "feat(picker): разбор alias и пикселей иконки"
```

---

### Task 5: Rust — извлечение через WinAPI и команда

**Files:**
- Modify: `src-tauri/src/icons.rs` (добавить `cfg(windows)`-часть и кеш)
- Modify: `src-tauri/src/main.rs` — команда, `invoke_handler`, `manage`
- Modify: `src-tauri/Cargo.toml`
- Test: `src-tauri/src/main.rs`, `mod tests` — сторож формы команды

**Interfaces:**
- Consumes: `icons::{IconSpec, appexec_target, to_rgba, resolve_name}` из Task 4.
- Produces: команда Tauri `action_icons(specs: Vec<IconSpec>) -> HashMap<String, String>`
  (id → `data:image/png;base64,…`), состояние `icons::Cache`. Зовёт её Task 6.

- [ ] **Step 1: Добавить зависимости**

В `src-tauri/Cargo.toml`:

```toml
# Иконка приложения из exe уезжает на страницу картинкой: PNG — единственный
# формат, который <img src="data:…"> понимает без кода на странице. Крейт уже
# в дереве (Tauri тянет его ради image-png), прямая запись нужна ради `use`.
png = "0.17"
# Тот же data-URI: base64 руками — двадцать строк и свой тест, крейт дешевле.
base64 = "0.22"
```

и расширить features у `windows` в блоке `[target.'cfg(windows)'.dependencies]`:

```toml
windows = { version = "0.61", features = [
    "Win32_UI_WindowsAndMessaging",
    "Win32_UI_Shell",
    "Win32_Graphics_Gdi",
    "Win32_Storage_FileSystem",
    "Win32_System_Environment",
    "Win32_System_IO",
] }
```

- [ ] **Step 2: Написать сторож формы команды**

В `src-tauri/src/main.rs`, в `mod tests`, рядом с `taken_command_runs_off_the_event_loop`:

```rust
    /// Извлечение иконок не должно ехать в потоке цикла событий: там же
    /// дозревает webview, и синхронная команда, полезшая в четыре exe за
    /// иконками, придержала бы отрисовку окна. Поведением это не поймать —
    /// на быстрой машине разницы не видно, — поэтому сторожится форма.
    #[test]
    fn action_icons_runs_off_the_event_loop() {
        let src = include_str!("main.rs");
        assert!(
            src.contains("async fn action_icons"),
            "action_icons должна быть async — иначе извлечение держит цикл событий"
        );
    }
```

- [ ] **Step 3: Убедиться, что сторож падает**

Run: `cd src-tauri && cargo test action_icons 2>&1 | tail -8`
Expected: FAIL — «action_icons должна быть async».

- [ ] **Step 4: Реализовать извлечение**

В `src-tauri/src/icons.rs` дописать:

```rust
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::SystemTime;

/// Кеш иконок на время жизни процесса.
///
/// Ключ — путь плюс mtime: обновился Cursor, сменился mtime, иконка
/// перечиталась сама. Кеш по одному пути протух бы незаметно и держался до
/// перезапуска пикера, а перезапускают его только при выкатке. `None` в
/// значении кеширует и неудачу — иначе несуществующий exe перепроверялся бы
/// на каждый показ меню.
#[derive(Default)]
pub struct Cache(Mutex<HashMap<(PathBuf, Option<SystemTime>), Option<String>>>);

/// Иконки для списка запросов. Чего не нашлось — просто нет в ответе.
pub fn icons_for(specs: &[IconSpec], cache: &Cache) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for spec in specs {
        let Some(path) = resolve(&spec.path) else { continue };
        let stamp = std::fs::metadata(&path).ok().and_then(|m| m.modified().ok());
        let key = (path.clone(), stamp);
        let cached = cache.0.lock().unwrap().get(&key).cloned();
        let value = match cached {
            Some(value) => value,
            None => {
                let value = extract(&path);
                cache.0.lock().unwrap().insert(key, value.clone());
                value
            }
        };
        if let Some(uri) = value {
            out.insert(spec.id.clone(), uri);
        }
    }
    out
}

/// Путь из конфига — в путь на диске: переменные окружения, PATH, alias.
fn resolve(raw: &str) -> Option<PathBuf> {
    let expanded = expand_env(raw);
    let direct = Path::new(&expanded);
    let path = if expanded.contains('\\') || expanded.contains('/') {
        if !direct.exists() {
            return None;
        }
        direct.to_path_buf()
    } else {
        let path_var = std::env::var("PATH").unwrap_or_default();
        resolve_name(&expanded, &path_var, &|p: &Path| p.exists())?
    };
    Some(alias_target(&path).unwrap_or(path))
}

#[cfg(not(windows))]
fn expand_env(raw: &str) -> String {
    raw.to_string()
}

#[cfg(not(windows))]
fn alias_target(_path: &Path) -> Option<PathBuf> {
    None
}

/// Вне Windows иконок не бывает: `.app` — другой API и другая задача.
#[cfg(not(windows))]
fn extract(_path: &Path) -> Option<String> {
    None
}
```

Windows-часть — в том же файле, под `#[cfg(windows)]`:

```rust
#[cfg(windows)]
use std::mem::size_of;
#[cfg(windows)]
use windows::core::PCWSTR;
#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
};
#[cfg(windows)]
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, OPEN_EXISTING,
};
#[cfg(windows)]
use windows::Win32::System::Environment::ExpandEnvironmentStringsW;
#[cfg(windows)]
use windows::Win32::System::IO::DeviceIoControl;
#[cfg(windows)]
use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

/// Код FSCTL_GET_REPARSE_POINT. Записан числом, а не взят из
/// `Win32_System_Ioctl`: ради одной константы тянуть ещё одну feature
/// `windows` дороже, чем написать её здесь.
#[cfg(windows)]
const FSCTL_GET_REPARSE_POINT: u32 = 0x0009_00A8;

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// `%SystemRoot%\explorer.exe` → настоящий путь.
///
/// Раскрытие живёт только в этой ветке: `argv` запускается без шелла
/// (`spawn_detached`), и раскрывать переменные там значило бы завести второй
/// разбор команды.
#[cfg(windows)]
fn expand_env(raw: &str) -> String {
    let src = wide(raw);
    let mut buf = vec![0u16; 4096];
    let len = unsafe { ExpandEnvironmentStringsW(PCWSTR(src.as_ptr()), Some(&mut buf)) } as usize;
    // Ответ считается вместе с нулём в конце; ноль и переполнение значат
    // «не вышло», и тогда путь остаётся тем, что дал человек.
    if len == 0 || len > buf.len() {
        return raw.to_string();
    }
    String::from_utf16_lossy(&buf[..len - 1])
}

/// Настоящий exe за app-execution alias — или `None`, если это обычный файл.
#[cfg(windows)]
fn alias_target(path: &Path) -> Option<PathBuf> {
    let name = wide(&path.to_string_lossy());
    // OPEN_REPARSE_POINT обязателен: без него открывается цель, а нам нужен
    // сам reparse point. BACKUP_SEMANTICS — чтобы не спорить с ACL каталога.
    let handle: HANDLE = unsafe {
        CreateFileW(
            PCWSTR(name.as_ptr()),
            0,
            FILE_SHARE_READ,
            None,
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )
    }
    .ok()?;
    let mut buf = vec![0u8; 16 * 1024];
    let mut returned = 0u32;
    let ok = unsafe {
        DeviceIoControl(
            handle,
            FSCTL_GET_REPARSE_POINT,
            None,
            0,
            Some(buf.as_mut_ptr() as *mut _),
            buf.len() as u32,
            Some(&mut returned),
            None,
        )
    };
    unsafe {
        let _ = CloseHandle(handle);
    }
    ok.ok()?;
    appexec_target(&buf[..returned as usize]).map(PathBuf::from)
}

/// Иконка файла — в `data:image/png;base64,…`.
#[cfg(windows)]
fn extract(path: &Path) -> Option<String> {
    let name = wide(&path.to_string_lossy());
    let mut info = SHFILEINFOW::default();
    let ok = unsafe {
        SHGetFileInfoW(
            PCWSTR(name.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut info),
            size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if ok == 0 || info.hIcon.is_invalid() {
        return None;
    }
    let png = icon_png(info.hIcon);
    // Хендл иконки принадлежит нам, и его не возвращают: без DestroyIcon на
    // каждый перечит утекает GDI-объект, а их у процесса десять тысяч.
    unsafe {
        let _ = DestroyIcon(info.hIcon);
    }
    png
}

#[cfg(windows)]
fn icon_png(icon: HICON) -> Option<String> {
    let mut ii = ICONINFO::default();
    unsafe { GetIconInfo(icon, &mut ii) }.ok()?;
    let colour = read_dib(ii.hbmColor);
    let mask = read_dib(ii.hbmMask);
    unsafe {
        let _ = DeleteObject(ii.hbmColor.into());
        let _ = DeleteObject(ii.hbmMask.into());
    }
    let (width, height, bgra) = colour?;
    let mask_px = mask.map(|(_, _, px)| px).unwrap_or_default();
    let rgba = to_rgba(&bgra, &mask_px);

    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header().ok()?.write_image_data(&rgba).ok()?;
    }
    use base64::Engine;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ))
}

/// Битмап → (ширина, высота, BGRA).
///
/// Высота в заголовке отрицательная намеренно: так строки идут сверху вниз.
/// С положительной DIB приезжает снизу вверх, и иконка встала бы вверх ногами
/// — молча, потому что размеры при этом верные.
#[cfg(windows)]
fn read_dib(bitmap: HBITMAP) -> Option<(u32, u32, Vec<u8>)> {
    let mut bm = BITMAP::default();
    let read = unsafe {
        GetObjectW(
            bitmap.into(),
            size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut _ as *mut _),
        )
    };
    if read == 0 || bm.bmWidth <= 0 || bm.bmHeight <= 0 {
        return None;
    }
    let (width, height) = (bm.bmWidth as u32, bm.bmHeight as u32);
    let mut info = BITMAPINFO::default();
    info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
    info.bmiHeader.biWidth = bm.bmWidth;
    info.bmiHeader.biHeight = -bm.bmHeight;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB.0;
    let mut pixels = vec![0u8; (width * height * 4) as usize];
    let hdc = unsafe { CreateCompatibleDC(None) };
    let rows = unsafe {
        GetDIBits(
            hdc,
            bitmap,
            0,
            height,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    unsafe {
        let _ = DeleteDC(hdc);
    }
    if rows == 0 {
        return None;
    }
    Some((width, height, pixels))
}
```

Сигнатуры даны по `windows` 0.61; если компилятор ругается на форму аргумента
(`Option<…>` вместо ссылки и наоборот) — править по его подсказке, смысл
вызова от этого не меняется.

В `src-tauri/src/main.rs`:

```rust
/// Иконки пунктов меню. Список собирает страница: Rust про меню не знает.
///
/// `async` — по той же причине, что и у `project_hotkeys_taken`: синхронная
/// команда выполняется в потоке цикла событий, а тут поход в файловую систему
/// за четырьмя иконками.
#[tauri::command]
async fn action_icons(
    specs: Vec<icons::IconSpec>,
    cache: tauri::State<'_, icons::Cache>,
) -> Result<std::collections::HashMap<String, String>, String> {
    Ok(icons::icons_for(&specs, &cache))
}
```

в `invoke_handler` — добавить `action_icons` к списку, в `setup` — 
`app.manage(icons::Cache::default());`.

- [ ] **Step 5: Проверить сборку и тесты локально**

Run: `cd src-tauri && cargo test 2>&1 | tail -15`
Expected: всё зелёное, включая `action_icons_runs_off_the_event_loop`.
Windows-часть на Linux не компилируется по `cfg` — это ожидаемо, её проверит
следующий шаг.

- [ ] **Step 6: Проверить сборку на Windows**

Скрипт выкатки собирает то, что запушено, поэтому сначала push:

```bash
git add src-tauri/ && git commit -m "feat(picker): иконки приложений из exe" && git push
./data/scripts/deploy-win.sh --no-launch
```

Expected: `Finished \`release\` profile`, `EXE_OK`. Ошибки компиляции
Windows-части ловятся только здесь.

---

### Task 6: Страница спрашивает иконки, живой конфиг, проверка

**Files:**
- Modify: `sessions.html` — `loadActionIcons`, вызовы в `start()` и в
  слушателе `config-changed`
- Test: `test/row-contract.test.js`

**Interfaces:**
- Consumes: команда `action_icons` из Task 5, `ActionIcons.iconSpecs` из Task 2,
  переменная `actionIcons` из Task 3.
- Produces: ничего для следующих задач — это последняя.

- [ ] **Step 1: Написать падающий тест**

В `test/row-contract.test.js`:

```js
// Иконки спрашиваются один раз при старте и ещё раз на config-changed — не
// при первом ^K: меню обязано открываться уже с картинками, а не дорисовывать
// их на глазах. Поймать это тестом поведения нельзя (страница целиком тут не
// живёт), поэтому сторожится форма: вызов есть в обоих местах.
test('иконки спрашиваются при старте и после смены конфига', () => {
  const start = SESSIONS_HTML.indexOf('async function start()');
  const configChanged = SESSIONS_HTML.indexOf("listen('config-changed'");
  assert.ok(start !== -1 && configChanged !== -1, 'тест сторожит не то');
  const calls = [...SESSIONS_HTML.matchAll(/loadActionIcons\(\)/g)].map(m => m.index);
  assert.ok(
    calls.some(i => i > start && i < configChanged),
    'иконки не запрашиваются при старте',
  );
  assert.ok(
    calls.some(i => i > configChanged),
    'после смены конфига иконки остались бы от прежних приложений',
  );
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm test 2>&1 | grep -E "^not ok .*иконки спрашиваются"`
Expected: `not ok`.

- [ ] **Step 3: Реализовать запрос**

В `sessions.html`, рядом с другими функциями страницы:

```js
  /**
   * Иконки приложений для меню.
   *
   * Отказ не событие: пустая карта значит «у всех пунктов глифы», и это
   * рабочее состояние — на маке оно единственное.
   */
  async function loadActionIcons() {
    try {
      actionIcons = await invoke('action_icons', {
        specs: window.ActionIcons.iconSpecs(CONFIG),
      }) || {};
    } catch (e) {
      actionIcons = {};
    }
  }
```

В `start()` — сразу после блока, где грузится `CONFIG`:

```js
    await loadActionIcons();
```

В слушателе `config-changed` — после переприсваивания `CONFIG`, до `regroup()`:

```js
      // Настроенные действия могли смениться вместе с конфигом: иконки от
      // прежних приложений остались бы висеть у новых пунктов.
      await loadActionIcons();
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 2` — прежние два.

- [ ] **Step 5: Проверить вёрстку с картинкой, без Windows**

В заглушке харнесса (`stub.js`) вернуть на `action_icons` карту с настоящей
картинкой — сгодится PNG, вытащенный при разведке:

```bash
# base64 иконки проводника, вытащенной при разведке
B64=$(base64 -w0 "$S/icons/explorer.png")
```

```js
// в stub.js, рядом с остальными ответами invoke
if (cmd === 'action_icons') {
  return Promise.resolve({ new: 'data:image/png;base64,<сюда $B64>' });
}
```

Прогнать `shot.mjs`, посмотреть снимок: у пункта `New session` картинка, у
остальных глифы, подписи в одну линию, слот одной ширины.

- [ ] **Step 6: Коммит и выкатка**

```bash
git add sessions.html test/row-contract.test.js
git commit -m "feat(picker): страница запрашивает иконки приложений"
git push
./data/scripts/deploy-win.sh
```

- [ ] **Step 7: Дописать `icon` в живой конфиг**

Конфиг лежит на самой машине и в репозиторий не входит. Дописать ключ
действию `explorer` (остальным трём он не нужен — у них `argv[0]` и есть
приложение). Скриптом, а не руками в yaml: вставка идёт ровно под строку
`- id: explorer` и только если ключа там ещё нет.

Положить в `patch-icon.ps1`, скопировать и выполнить (имя машины берётся из
`TARGET_HOST` в `data/scripts/deploy-win.sh`):

```powershell
$cfg = "$env:USERPROFILE\.config\ccfzf-picker\config.yaml"
$lines = Get-Content $cfg
if ($lines -match "^\s*icon:") { "already patched"; exit }
$out = foreach ($line in $lines) {
  $line
  if ($line -match "^- id: explorer\s*$") { "  icon: '%SystemRoot%\explorer.exe'" }
}
Copy-Item $cfg "$cfg.bak" -Force
$out | Set-Content $cfg -Encoding UTF8
"patched"
```

Пикер перечитывает конфиг по событию из окна настроек, а правку руками мимо
окна он не увидит — перезапустить: `./data/scripts/deploy-win.sh --no-build`.

- [ ] **Step 8: Посмотреть глазами на машине**

Открыть пикер, нажать `^K` на строке сессии и на строке проекта. Ожидается:
жёлтая папка у Explorer, логотипы у Cursor и VS Code, `>_` у терминала,
глифы у остальных, подписи в одну линию. Отдельно проверить, что у терминала
именно логотип Terminal, а не дежурная картинка: это и есть проверка ветки
alias.

---

## Что проверить в конце

```bash
npm test                      # ожидается: fail 2 — те же, что были до работы
cd src-tauri && cargo test    # ожидается: всё зелёное
```
