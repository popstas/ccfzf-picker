# HTTP-транспорт просьб пикера к менеджеру — план работ

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Связка claude-wt работает без брокера MQTT: пять просьб пикера к оконному менеджеру уходят по HTTP, когда адрес известен, и по MQTT, когда нет.

**Architecture:** Адрес менеджера едет пикеру той же дорогой, что `mqttBase`, — полем в файле трекера через агрегатор `ccfzf`. Mqtt-процесс windows11-manager становится служебным: поднимается всегда, вешает http-слушатель, а mqtt-клиент прицепляет только при настроенном брокере. Пикер выбирает транспорт по наличию адреса, одной попыткой, без ретраев.

**Tech Stack:** Node 20 + vitest (windows11-manager), Python 3 + самодельный harness (ccfzf), Rust + Tauri 2 + `ureq` (ccfzf-picker), JS + `node --test` (фронтенд пикера).

**Spec:** [`docs/superpowers/specs/2026-08-23-manager-http-transport-design.md`](../specs/2026-08-23-manager-http-transport-design.md) — все «почему» там, план на них ссылается и не пересказывает.

## Global Constraints

- **Три репозитория.** `windows11-manager` и `ccfzf-picker` — соседние каталоги проектов; `ccfzf` — свой репозиторий, в пикер приезжает сабмодулем `vendor/ccfzf`. Коммиты в каждый — свои; ветка пикера `feat/manager-http-transport`.
- **Язык.** Всё, что видит человек, — по-английски; комментарии, doc-комментарии, названия тестов и сообщения в `assert` — по-русски.
- **Имена машин в репозиторий пикера не возвращать.** `test/no-private-data.test.js` проверяет это по `git ls-files`; новый файл ловится только после `git add`. Названия машин в тестах — выдуманные (`windows-box`, `mac-host`), как уже принято.
- **`;` в удалённой команде не ставить**, удалённые запуски агента идут через `exec $SHELL -ic`. Этот план кода запуска не трогает, но правило действует.
- **Порт по умолчанию 9722.** Ключ конфига `httpPort` — **верхнего уровня**, не внутри `claudeWt`: вложенный молча ничего не делает.
- **Ретраев между транспортами нет.** Транспорт выбирается один раз по наличию адреса. Повтор по второму транспорту открыл бы человеку второй терминал.
- **Тесты гоняются целиком перед каждым коммитом:** `npm test` в пикере, `npx vitest run` в windows11-manager, `python3 tests/<файл>.py` в ccfzf.

## Структура файлов

| Файл | Репозиторий | Ответственность |
|---|---|---|
| `src/claude-wt/windows-file-helpers.js` | w11m | + ключ `http: { port }` в опубликованном файле трекера |
| `src/claude-wt/index.js` | w11m | + прокидывание `httpPort` из конфига в `buildWindowsFile` |
| `src/mqtt/service.js` | w11m | расщепление на «всегда» и «только с брокером», подъём http-слушателя |
| `src/http-server.js` | w11m | слушатель становится встраиваемым: принимает готовый роутер |
| `src/index.js` | w11m | − подкоманда `http-server` |
| `tauri-app/src-tauri/src/lib.rs` | w11m | безусловный спавн ребёнка, подписи `Service` |
| `ccfzf` | ccfzf | + `http` в записи `windowHosts` |
| `frontend-src/session-windows.js` | пикер | `httpFor`, `managerHttp`, `unreadTargets` |
| `frontend-src/open-transport.js` | пикер | `mqttConfigured` → `managerReachable` |
| `sessions.html` | пикер | передача адреса в шесть команд |
| `src-tauri/src/manager_http.rs` | пикер | **новый**: пять просьб по HTTP |
| `src-tauri/src/main.rs` | пикер | развилка транспорта в шести командах |
| `test/manager-routes.test.js` | пикер | **новый**: сторож согласия маршрутов с топиками |

---

### Task 1: Файл трекера называет http-порт

**Files:**
- Modify: `windows11-manager/src/claude-wt/windows-file-helpers.js:35` (сигнатура `buildWindowsFile`), `:69-71` (возвращаемый объект)
- Modify: `windows11-manager/src/claude-wt/index.js:332-335` (вызов `buildWindowsFile`)
- Test: `windows11-manager/src/claude-wt/windows-file-helpers.test.js`

**Interfaces:**
- Consumes: ничего.
- Produces: `buildWindowsFile({ ..., httpPort })` кладёт в корень результата `http: { port: <число> }`, когда `httpPort` — конечное число больше нуля, и **не кладёт ключ вовсе** иначе. Task 2 читает тот же `config.httpPort`; Task 4 читает поле `http` из файла.

- [ ] **Step 1: Написать падающий тест**

В `src/claude-wt/windows-file-helpers.test.js`, внутрь `describe('buildWindowsFile', ...)`:

```javascript
  // Адрес просьбы едет читателю тем же файлом, что и окна: согласовывать порт
  // руками в двух проектах — ровно то, на чём ломается база топика MQTT.
  it('names the http port when one is configured', () => {
    const out = buildWindowsFile({
      windows: WINDOWS, slots: SLOTS, host: 'pc', pid: 42, nowMs: 1_800_000,
      httpPort: 9722,
    });
    expect(out.http).toEqual({ port: 9722 });
  });

  // Ключа нет вовсе, а не `null` и не ноль: читатель отличает «порта не знаю»
  // от «порт такой» наличием ключа, и это то же правило, по которому пустой
  // `mqttBase` значит «спроси свой конфиг».
  it('omits the http key when no port is configured', () => {
    const out = buildWindowsFile({
      windows: WINDOWS, slots: SLOTS, host: 'pc', pid: 42, nowMs: 1_800_000,
    });
    expect('http' in out).toBe(false);
  });

  // Мусор читается как отсутствие: конфиг правит человек, и строка "9722" или
  // ноль не должны превратиться в адрес, по которому никто не слушает.
  it('treats a junk port as no port at all', () => {
    for (const httpPort of ['9722', 0, -1, null, NaN]) {
      const out = buildWindowsFile({
        windows: WINDOWS, slots: SLOTS, host: 'pc', pid: 42, nowMs: 1_800_000, httpPort,
      });
      expect('http' in out).toBe(false);
    }
  });
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd <каталог windows11-manager> && npx vitest run src/claude-wt/windows-file-helpers.test.js`
Expected: FAIL — `expected undefined to deeply equal { port: 9722 }`.

- [ ] **Step 3: Реализовать**

В `windows-file-helpers.js` расширить сигнатуру и возврат:

```javascript
function buildWindowsFile({ windows, slots, host, pid, nowMs, snapshots, projects, httpPort }) {
```

Перед `return` добавить:

```javascript
  // Адрес, по которому менеджер этой машины принимает просьбы напрямую.
  //
  // Объявление о намерении, а не доказательство: файл пишет демон
  // (`claude-wt watch`), а слушатель живёт в служебном процессе, и спрашивать
  // его состояние в цикле демона нельзя — это лишний опрос, за который в этом
  // проекте уже заплачено правилом бюджета.
  //
  // Проверять и нечего: mqtt-клиент живёт в том же служебном процессе, что и
  // слушатель. Лежит служба — мертвы оба транспорта, и откат на MQTT спас бы
  // ровно ноль случаев.
  //
  // Ключа нет вовсе, когда порта нет: читатель отличает «не знаю» от «знаю»
  // наличием ключа, ровно как у `mqttBase` пустая строка значит «спроси свой
  // конфиг». Ноль и строка читаются как отсутствие — конфиг правит человек.
  const port = Number(httpPort);
  const http = Number.isFinite(port) && port > 0 && typeof httpPort === 'number'
    ? { port }
    : null;
```

и в возвращаемом объекте, после `projects: ...`:

```javascript
    ...(http ? { http } : {}),
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npx vitest run src/claude-wt/windows-file-helpers.test.js`
Expected: PASS, все `it` зелёные.

- [ ] **Step 5: Прокинуть порт из конфига**

В `src/claude-wt/index.js`, вызов `buildWindowsFile` (строка ~332):

```javascript
  const payload = buildWindowsFile({
    windows, slots, host: os.hostname(), pid: process.pid, nowMs, snapshots,
    projects: claudeWtProjects(),
    // Ключ верхнего уровня, не внутри claudeWt: вложенный молча ничего не
    // сделает — та же семья, что placeWindowOnOpen и publishStats.
    httpPort: cfg.httpPort,
  });
```

Проверить, что `cfg` в `publishWindows` — это объект конфига верхнего уровня; если функция получает подобъект `claudeWt`, взять порт у корневого конфига тем же способом, каким его берут `src/mqtt/autoplacer.js:25` и `src/mqtt/stats.js:65`.

- [ ] **Step 6: Прогнать весь набор**

Run: `npx vitest run`
Expected: PASS. `windowsFingerprint` считает окна, снимки и хоткеи — ключ `http` в отпечаток не входит и лишних записей файла не вызывает; если какой-то тест на отпечаток покраснел, значит ключ попал в него по ошибке.

- [ ] **Step 7: Добавить ключ в образец конфига**

В `config.example.cjs` рядом с `placeWindowOnOpen` и `publishStats`:

```javascript
  // Порт, на котором служебный процесс принимает просьбы от ccfzf-picker.
  // Ключ верхнего уровня. Живой конфиг лежит не здесь — образец сам не
  // читается, переносить руками.
  httpPort: 9722,
```

- [ ] **Step 8: Коммит**

```bash
cd <каталог windows11-manager>
git add src/claude-wt/windows-file-helpers.js src/claude-wt/windows-file-helpers.test.js src/claude-wt/index.js config.example.cjs
git commit -m "feat: файл трекера называет http-порт менеджера"
```

---

### Task 2: Служебный процесс поднимается без брокера

**Files:**
- Modify: `windows11-manager/src/mqtt/service.js:28-80` (`startMqttService`)
- Modify: `windows11-manager/src/http-server.js:55` (`startHttpServer` принимает готовый роутер)
- Test: `windows11-manager/src/mqtt/service.test.js` (создать, если файла нет)

**Interfaces:**
- Consumes: `buildCommandMap` (без изменений), `config.httpPort` из Task 1.
- Produces: `startService({ winMan, config, log, env })` — новое имя экспортируемой функции, возвращает `{ stop() }`. Поднимается всегда. Task 3 зовёт её из `src/index.js` подкомандой `mqtt`.
- Produces: `startHttpServer({ router, port, log })` — сигнатура меняется с позиционного `port` на объект; роутер приходит снаружи, своего больше не строит.

- [ ] **Step 1: Написать падающий тест**

Создать `src/mqtt/service.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import { startService } from './service.js';

/** Минимальный winMan: службе от него на старте нужен только конфиг окон. */
function fakeWinMan() {
  return {
    getWindows: () => [],
    getConfig: () => ({}),
  };
}

describe('startService', () => {
  // Ради этого вся правка: без брокера служба обязана подняться и слушать
  // http. Раньше функция выходила первой же строкой, и вместе с ней не
  // заводились ни автопостановщик, ни сторож демона.
  it('starts without any broker settings and still listens on http', async () => {
    const log = vi.fn();
    const service = startService({
      winMan: fakeWinMan(),
      config: { httpPort: 0 },
      log,
      env: {},
    });
    expect(service.httpPort()).toBeGreaterThan(0);
    expect(service.mqttConnected()).toBe(false);
    service.stop();
  });

  // Слоты нужны единственной команде — claude-focus-slot, — и приходит она с
  // панели, то есть по MQTT. Без брокера заглушка законна; с брокером она была
  // бы дырой, и ровно поэтому третьего процесса здесь нет.
  it('leaves the ha export stubbed when there is no broker', () => {
    const service = startService({
      winMan: fakeWinMan(), config: { httpPort: 0 }, log: vi.fn(), env: {},
    });
    expect(service.haExport().slots()).toEqual([]);
    service.stop();
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx vitest run src/mqtt/service.test.js`
Expected: FAIL — `startService is not a function` (экспортируется `startMqttService`).

- [ ] **Step 3: Сделать слушатель встраиваемым**

В `src/http-server.js` заменить `startHttpServer` на приём готового роутера. Удалить из файла импорты `winMan`, `createRouter`, `buildCommandMap` и построение `haExport` — они переезжают к вызывающему:

```javascript
/**
 * HTTP-транспорт поверх той же карты команд, что и MQTT.
 *
 * Роутер приходит снаружи, а не строится здесь: раньше слушатель поднимался
 * отдельным процессом и потому строил свой, с заглушкой слотов. Теперь он
 * живёт внутри служебного процесса и обязан разбирать команды тем же роутером,
 * что и MQTT, — иначе `claude-focus-slot` с панели молча не находил бы сессию.
 *
 * `port: 0` — «любой свободный»: так тесты поднимают слушатель, не занимая
 * настоящий порт. Настоящий порт всегда спрашивать у `address()`, а не у
 * аргумента.
 */
function startHttpServer({ router, port = 9722, log }) {
```

Тело `createServer` оставить как есть (`routeToCommand`, `readBody`, `router.dispatch`). Заменить хвост:

```javascript
  server.listen(port, () => log(`HTTP server listening on port ${server.address().port}`));
  return server;
}
```

- [ ] **Step 4: Расщепить службу**

В `src/mqtt/service.js` переименовать функцию и развести две графы:

```javascript
/**
 * Долгоживущая служба: роутер команд, http-транспорт и — когда брокер настроен —
 * mqtt-клиент с экспортом в Home Assistant.
 *
 * Процесс отдельный от демона claude-wt намеренно: http-сервер, поднятый
 * внутри демона, вешал событийный цикл через две-три минуты (см. src/lib/index.js).
 *
 * Поднимается **всегда**, даже без брокера, и это и есть суть правки. Раньше
 * функция выходила первой строкой при пустом W11M_MQTT_HOST, и вместе с mqtt не
 * заводились ни автопостановщик, ни сторож демона — хотя брокер обоим не нужен,
 * о чём тут же и написано ниже.
 */
function startService({ winMan, config, log, env = process.env }) {
  const settings = readMqttSettings(env);
  const withBase = settings ? { ...config, base: settings.base } : { ...config };

  let client = null;
  const publish = (topic, payload, opts) => client?.publish(topic, String(payload), opts ?? {});

  // Без брокера публиковать некуда: HA-экспорт и статистика молчат, а notify
  // уходит в лог — человеку он всё равно приезжает уведомлением через брокер.
  const notify = settings
    ? (message) => publish(settings.notifyTopic, message)
    : (message) => log(`notify: ${message}`);
  const publishDone = settings
    ? (command) => publish(`${settings.base}/${command}/done`, '1')
    : () => {};

  // Заглушка той же формы, что стояла в http-server.js, — и она законна ровно
  // потому, что брокера нет: слоты спрашивает единственная команда
  // claude-focus-slot, а приходит она с панели openHASP, то есть по MQTT.
  const haExport = settings
    ? createHaExport({ winMan, publish, log, config: withBase })
    : { slots: () => [], slotOff: () => {}, refresh: () => {} };

  const router = createRouter(buildCommandMap({
    winMan, config: withBase, log, notify, haExport, publishDone,
  }));

  // Брокер этим троим не нужен, и ждать подключения они не должны: расстановка
  // окон при открытии работает и с лежащим брокером, сторож демона тем более —
  // он про поломку, которая случается сама по себе, — а http-транспорт и есть
  // причина, по которой служба теперь поднимается без брокера вовсе.
  const httpServer = startHttpServer({ router, port: config?.httpPort ?? 9722, log });
  const autoplacer = startAutoplacer({ winMan, config: withBase, log });
  const daemonWatchdog = startDaemonWatchdog({ winMan, log, notify });

  const stats = settings ? createStatsPublisher({ winMan, publish, log, config: withBase }) : null;

  if (!settings) {
    log('MQTT: W11M_MQTT_HOST или W11M_MQTT_BASE не заданы — работаем только по http', 'warn');
  }
```

Дальше — существующий блок `client = connectMqtt({...})` целиком обернуть в `if (settings) { ... }`, включая заведение `stats` по подключению. В `stop()` добавить `httpServer.close()` и снятие `stats`/`client` только при их наличии.

Вернуть расширенный объект (его читают тесты):

```javascript
  return {
    stop() { /* существующее + httpServer.close() */ },
    httpPort: () => httpServer.address()?.port ?? 0,
    mqttConnected: () => Boolean(client),
    haExport: () => haExport,
  };
}

export { startService, FOREIGN_COMMANDS };
```

Импорт слушателя добавить наверх файла: `import { startHttpServer } from '../http-server.js';`

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `npx vitest run src/mqtt/service.test.js src/http-server.test.js`
Expected: PASS. `http-server.test.js` проверяет только `routeToCommand` — его сигнатура не менялась.

- [ ] **Step 6: Прогнать весь набор**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 7: Коммит**

```bash
git add src/mqtt/service.js src/mqtt/service.test.js src/http-server.js
git commit -m "feat: служебный процесс поднимается без брокера и слушает http"
```

---

### Task 3: Трей поднимает службу безусловно, подкоманда http-server уходит

**Files:**
- Modify: `windows11-manager/src/index.js:69-74` (удалить подкоманду `http-server`), `:76-82` (подкоманда `mqtt` зовёт `startService`)
- Modify: `windows11-manager/tauri-app/src-tauri/src/lib.rs:1526` (снять проверку настроек), `:1734` и `:561` (подписи), `:1889` (обработчик тумблера)

**Interfaces:**
- Consumes: `startService` из Task 2.
- Produces: ничего для следующих задач; это последняя правка в windows11-manager до документации.

- [ ] **Step 1: Убрать подкоманду http-server**

В `src/index.js` удалить блок:

```javascript
  program
    .command('http-server')
    .option('--port <port>', 'HTTP server port', '9722')
    .action(async (options) => {
      const { startHttpServer } = await import('./http-server.js');
      startHttpServer(Number(options.port));
    });
```

Второй процесс, разбирающий те же команды со своими слотами, — тот самый класс поломок, ради ухода от которого Task 2 и делалась.

Подкоманду `mqtt` переименовать в описании и переключить на новое имя функции:

```javascript
  program
    .command('mqtt')
    .description('Служба: http-транспорт, команды окон и — при настроенном брокере — MQTT и экспорт в Home Assistant')
    .action(async () => {
      const { startService } = await import('./mqtt/service.js');
```

Имя подкоманды остаётся `mqtt`: его знает трей (`args(["src/index.js", "mqtt"])`), и менять два места разом незачем.

- [ ] **Step 2: Снять запрет на запуск без брокера**

В `tauri-app/src-tauri/src/lib.rs` найти проверку настроек перед спавном (около строки 1526, комментарий «Ставится после проверок настроек: без хоста, темы или пути проекта поднимать нечего»). Убрать из неё условие на пустой `mqtt_host`, оставив проверку пути проекта — без него `current_dir` некуда указать. Комментарий переписать:

```rust
    // Путь проекта проверяется, хост брокера — нет: служба поднимается и без
    // него, отвечая только по http. Раньше пустой хост запрещал запуск, и
    // вместе с mqtt не заводились автопостановщик, сторож демона и приём
    // просьб от пикера.
```

Переменные `W11M_MQTT_*` продолжают передаваться как есть: пустые значения служба читает как «брокера нет».

- [ ] **Step 3: Переименовать подписи в трее**

Строки видит человек — значит по-английски. Заменить:

- `lib.rs:1734`: `"Start MQTT"` → `"Start service"`
- `lib.rs:561`: текст пункта состояния `MQTT: running` / `MQTT: stopped` → `Service: running` / `Service: stopped`
- `lib.rs:1889`: обработчик `"mqtt_toggle"` — id пункта меню оставить прежним (он внутренний), поправить только тексты, которые пункт получает при переключении.

Поиском проверить, что других видимых человеку строк со словом `MQTT` про этот процесс не осталось: `grep -n '"MQTT' tauri-app/src-tauri/src/lib.rs`. Строки про **брокер** (настройки подключения) переименовывать не нужно — они действительно про MQTT.

- [ ] **Step 4: Собрать и проверить**

Run: `cd <каталог windows11-manager> && npx vitest run && npx eslint src/`
Expected: PASS, без предупреждений про неиспользуемый импорт `startHttpServer` в `src/index.js`.

Сборку Rust здесь не гоняем: она идёт на Windows-машине, и её проверит Task 10.

- [ ] **Step 5: Коммит**

```bash
git add src/index.js tauri-app/src-tauri/src/lib.rs
git commit -m "feat: трей поднимает службу без брокера, подкоманда http-server удалена"
```

---

### Task 4: Агрегатор переносит адрес в windowHosts

**Files:**
- Modify: `ccfzf` — `read_windows` (разбор поля, рядом с разбором `mqttBase`, ~строка 799), `read_window_sources` (запись в `hosts`, ~строка 887)
- Test: `tests/test_windows_merge.py`

**Interfaces:**
- Consumes: ключ `http: { port }` из Task 1.
- Produces: запись `windowHosts[]` получает ключ `http` — либо `{"port": <int>}`, либо `None`. Task 5 читает его из ответа `ccfzf --state`.

- [ ] **Step 1: Написать падающий тест**

В `tests/test_windows_merge.py` расширить помощник `_file`:

```python
def _file(host, windows, pid=42, focus=None, projects=None, snapshots=None,
          open_session=None, mqtt_base=None, http=None):
    out = {"generated": NOW - 1, "host": host, "pid": pid, "windows": windows}
    if focus is not None:
        out["focus"] = focus
    if projects is not None:
        out["projects"] = projects
    if snapshots is not None:
        out["snapshots"] = snapshots
    if open_session is not None:
        out["openSession"] = open_session
    if mqtt_base is not None:
        out["mqttBase"] = mqtt_base
    if http is not None:
        out["http"] = http
    return out
```

Добавить тесты:

```python
def test_http_endpoint_reaches_the_host_record():
    # Ради этого поля вся правка: по нему читатель решает, идти ли напрямую.
    # Живёт оно в записи машины, а не окна: адрес — свойство машины, и у строки
    # проекта окна нет вовсе, а спросить «куда просить» надо и про неё.
    _, _, _, _, _, hosts = _merge(
        legacy=_file("windows-box", {UUID_A: _win("ccfzf")}, http={"port": 9722}),
    )
    assert hosts[0]["http"] == {"port": 9722}, hosts


def test_missing_http_reads_as_no_endpoint():
    # Трекер прежней версии поля не пишет вовсе, и это обязано читаться как
    # «адреса не знаю» — читатель тогда откатывается на MQTT, как раньше.
    _, _, _, _, _, hosts = _merge(
        legacy=_file("windows-box", {UUID_A: _win("ccfzf")}),
    )
    assert hosts[0]["http"] is None, hosts


def test_junk_http_reads_as_no_endpoint():
    # Недоверие к файлу такое же, как к остальным полям: третьей ветки
    # поведения мусор не заводит.
    for junk in ["9722", {"port": "9722"}, {"port": 0}, {}, 17, None]:
        _, _, _, _, _, hosts = _merge(
            legacy=_file("windows-box", {UUID_A: _win("ccfzf")}, http=junk),
        )
        assert hosts[0]["http"] is None, (junk, hosts)
```

И поправить существующий `test_hosts_list_names_every_live_tracker` — он сверяет записи целиком, и новый ключ его уронит:

```python
    assert hosts == [
        {"host": "windows-box", "pid": 42, "canFocus": True,
         "openSession": True, "mqttBase": "", "http": None},
        {"host": "mac-host", "pid": 7, "canFocus": False,
         "openSession": True, "mqttBase": "", "http": None},
    ], hosts
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd <каталог ccfzf> && python3 tests/test_windows_merge.py`
Expected: FAIL — `KeyError: 'http'` в первом новом тесте.

- [ ] **Step 3: Разобрать поле в read_windows**

Сразу после блока `mqtt_base` (перед `return out, host, pid, ...`):

```python
    # Адрес, по которому менеджер этой машины принимает просьбы напрямую, без
    # брокера. Отсутствие поля — «адреса не знаю»: трекер прежней версии его не
    # пишет, и читатель тогда идёт прежней дорогой, через MQTT. Мусор читается
    # так же, как отсутствие, — то же правило, что у `focus` и `openSession`:
    # недоверие к файлу не заводит третьей ветки поведения.
    http = o.get("http")
    if isinstance(http, dict):
        port = http.get("port")
        http = {"port": port} if isinstance(port, int) and not isinstance(port, bool) and port > 0 else None
    else:
        http = None

    return out, host, pid, snaps, projects, focus, open_session, mqtt_base, http
```

- [ ] **Step 4: Переложить в запись машины**

В `read_window_sources` поправить распаковку и запись:

```python
        w, host, pid, sn, pr, focus, open_session, mqtt_base, http = read_windows(path, now)
        if not host:
            continue
        hosts.append({"host": host, "pid": pid, "canFocus": focus,
                      "openSession": open_session, "mqttBase": mqtt_base,
                      "http": http})
```

В записи **окна** и в записи **снимка** поле не появляется намеренно — там его читателю не нужно, а ехало бы в каждом ответе `--state`, раз в секунду.

Дополнить докстроку `read_window_sources` абзацем:

```
    Адрес прямой просьбы (`http`) живёт только в записи машины, как и
    `openSession`: по нему выбирается транспорт, а транспорт — свойство машины.
    `None` значит «адреса не знаю», и читатель тогда идёт через MQTT.
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `python3 tests/test_windows_merge.py && python3 tests/test_windows_file.py`
Expected: PASS оба.

- [ ] **Step 6: Прогнать весь набор тестов ccfzf**

Run: `for f in tests/test_*.py; do echo "== $f"; python3 "$f" || break; done`
Expected: все PASS. Другие вызовы `read_windows` в кодовой базе распаковывают кортеж — поиском `grep -n 'read_windows(' ccfzf` убедиться, что поправлены все.

- [ ] **Step 7: Коммит и пуш**

```bash
git add ccfzf tests/test_windows_merge.py
git commit -m "feat: адрес прямой просьбы едет в записи машины windowHosts"
git push
```

Пуш обязателен здесь и сейчас: пикер тянет ccfzf сабмодулем, и Task 5 без запушенного коммита не сдвинет указатель.

- [ ] **Step 8: Сдвинуть указатель сабмодуля в пикере**

```bash
cd <каталог ccfzf-picker>
git -C vendor/ccfzf fetch origin && git -C vendor/ccfzf checkout origin/master
git add vendor/ccfzf
git commit -m "chore: сабмодуль ccfzf с адресом прямой просьбы"
```

Ветку сабмодуля назвать ту, в которую лёг коммит Task 7 выше, если это не `master`.

---

### Task 5: Пикер читает адрес и перестаёт спрашивать про брокер

**Files:**
- Modify: `frontend-src/session-windows.js:197-201` (рядом с `mqttBaseFor`), `:249-262` (`unreadBases`), экспорт в конце файла
- Modify: `frontend-src/open-transport.js` (`chooseOpenTransport`, `canOpenRemote`, `chooseEnterAction`, `chooseProjectOpenAction`)
- Test: `test/session-windows.test.js`, `test/open-transport.test.js`

**Interfaces:**
- Consumes: `windowHosts[].http` из Task 4.
- Produces:
  - `SessionWindows.httpFor(row, state, configHost) -> string` — `"host:port"` или `""`.
  - `SessionWindows.managerHttp(state, configHost) -> string` — то же для машины из `openManager`.
  - `SessionWindows.unreadTargets(row, state) -> Array<{base: string, http: string}>` — заменяет `unreadBases`.
  - `OpenTransport.chooseOpenTransport(manager, configHost, managerReachable)` — третий параметр переименован по смыслу; значение считает вызывающий как «http есть ИЛИ брокер настроен».

- [ ] **Step 1: Написать падающий тест на адрес**

В `test/session-windows.test.js`:

```javascript
// Адрес прямой просьбы — свойство машины, и берётся он из записи машины, а не
// окна: в записи окна его нет вовсе (см. read_window_sources в ccfzf). Дорога
// поэтому двухшаговая — окно называет host, host находится в windowHosts.
test('httpFor находит адрес по машине окна', () => {
  const state = {
    windowHosts: [
      { host: 'windows-box', pid: 9, canFocus: true, openSession: true, mqttBase: '', http: { port: 9722 } },
      { host: 'mac-host', pid: 7, canFocus: true, openSession: false, mqttBase: 'home/mac/windows', http: null },
    ],
  };
  const row = { id: 'aaa', window: { host: 'windows-box' } };
  assert.equal(SessionWindows.httpFor(row, state, 'windows-box'), 'windows-box:9722');
});

// Трекер прежней версии поля не пишет — пустая строка значит «иди прежней
// дорогой, через MQTT». Молчаливого отката тут нет: MQTT и был единственным
// транспортом, а не запасным.
test('httpFor пуст, когда машина адреса не назвала', () => {
  const state = {
    windowHosts: [{ host: 'mac-host', pid: 7, canFocus: true, openSession: true, mqttBase: '', http: null }],
  };
  const row = { id: 'aaa', window: { host: 'mac-host' } };
  assert.equal(SessionWindows.httpFor(row, state, 'mac-host'), '');
});

// Отмотать «просмотрено» надо у каждого трекера сессии, и транспорт у каждого
// свой: у одной машины http, у другой MQTT. Пара едет вместе, иначе адрес и
// база разъехались бы по индексам массивов.
test('unreadTargets даёт паре машин свой транспорт каждой', () => {
  const state = {
    windowHosts: [
      { host: 'windows-box', pid: 9, canFocus: true, openSession: true, mqttBase: '', http: { port: 9722 } },
      { host: 'mac-host', pid: 7, canFocus: true, openSession: true, mqttBase: 'home/mac/windows', http: null },
    ],
  };
  const row = {
    id: 'aaa',
    sessionWindows: [{ host: 'windows-box', mqttBase: '' }, { host: 'mac-host', mqttBase: 'home/mac/windows' }],
  };
  assert.deepEqual(SessionWindows.unreadTargets(row, state), [
    { base: '', http: 'windows-box:9722' },
    { base: 'home/mac/windows', http: '' },
  ]);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm test 2>&1 | grep -A5 "httpFor"`
Expected: FAIL — `SessionWindows.httpFor is not a function`.

- [ ] **Step 3: Реализовать чтение адреса**

В `frontend-src/session-windows.js`, рядом с `mqttBaseFor`:

```javascript
  /**
   * Адрес прямой просьбы к менеджеру машины — `"host:port"` или пусто.
   *
   * Дорога двухшаговая, и это не лишний шаг: в записи окна адреса нет вовсе.
   * Агрегатор кладёт его только в запись машины (`windowHosts`), потому что
   * адрес — свойство машины, а запись окна ехала бы им в каждом ответе
   * `--state`, раз в секунду. `mqttBase` дублируется в обеих по историческим
   * причинам, и повторять это незачем.
   *
   * Пустая строка значит «иди через MQTT»: трекер или агрегатор прежней версии
   * поля не пишет. Отката тут не изобретается — MQTT и был единственной
   * дорогой.
   */
  function httpEndpointOf(entry) {
    const host = String((entry || {}).host || '').trim();
    const port = ((entry || {}).http || {}).port;
    if (!host) return '';
    return Number.isInteger(port) && port > 0 ? `${host}:${port}` : '';
  }

  function httpForHost(state, host) {
    const mine = normHost(host);
    if (!mine) return '';
    const entry = trackerHosts(state).find(e => normHost(e.host) === mine);
    return entry ? httpEndpointOf(entry) : '';
  }

  /** Адрес прямой просьбы для строки — по машине её окна. */
  function httpFor(row, state, configHost) {
    const w = focusWindowOf(row, state, configHost) || windowOf(row, state);
    return httpForHost(state, (w || {}).host);
  }

  /** Адрес прямой просьбы к машине, чей менеджер открывает сессии. */
  function managerHttp(state, configHost) {
    const manager = openManager(state, configHost);
    return manager ? httpEndpointOf(manager) : '';
  }
```

Заменить `unreadBases` на `unreadTargets`, сохранив её докблок целиком и дописав абзац:

```javascript
  /**
   * … (существующий докблок целиком) …
   *
   * Транспорт считается на каждую машину отдельно и едет в паре с базой: у
   * одного трекера может быть http, у соседнего нет. Двумя параллельными
   * массивами это разъехалось бы по индексам на первой же правке.
   */
  function unreadTargets(row, state) {
    const r = row || {};
    const wins = Array.isArray(r.sessionWindows) ? r.sessionWindows : windowsOf(row, state);
    const out = [];
    for (const w of wins) {
      const base = w && typeof w.mqttBase === 'string' ? w.mqttBase.trim() : '';
      const http = httpForHost(state, (w || {}).host);
      if (!out.some(t => t.base === base && t.http === http)) out.push({ base, http });
    }
    return out;
  }
```

В экспорте заменить `unreadBases` на `unreadTargets` и добавить `httpFor`, `managerHttp`.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npm test 2>&1 | tail -8`
Expected: FAIL — старые тесты на `unreadBases` красные. Переписать их на `unreadTargets`, сверяя пары; смысл проверок (дедупликация, откат на `windowsOf`, пустая база едет как есть) сохранить дословно.

- [ ] **Step 5: Переименовать условие транспорта**

В `frontend-src/open-transport.js` заменить третий параметр во всех четырёх функциях `chooseOpenTransport`, `canOpenRemote`, `chooseEnterAction`, `chooseProjectOpenAction` с `mqttConfigured` на `managerReachable`. Правки чисто в имени и в докблоках; условие остаётся тем же `&& managerReachable`.

В докблоке `chooseOpenTransport` заменить абзац про брокер:

```javascript
   * Без транспорта до менеджера ветка `manager` вела бы Enter в ошибку там,
   * где раньше он открывал терминал локально. Поэтому совпадения имени хоста
   * недостаточно: нужна ещё дорога, по которой просьба уйдёт, — прямой адрес
   * менеджера либо настроенный брокер. Раньше здесь спрашивался только брокер,
   * и на машине, где MQTT не настроен вовсе, ветка не включалась бы никогда —
   * то есть ровно в том случае, ради которого http и заводился.
```

Добавить тест в `test/open-transport.test.js`:

```javascript
// Ровно тот случай, ради которого всё делалось: брокера нет, а менеджер
// достижим напрямую. До этой правки Enter молча открывал локальный терминал,
// теряя профиль Windows Terminal из claudeWt.projects.
test('менеджер выбирается по достижимости, а не по брокеру', () => {
  const manager = { host: 'windows-box' };
  assert.equal(OpenTransport.chooseOpenTransport(manager, 'windows-box', true), 'manager');
  assert.equal(OpenTransport.chooseOpenTransport(manager, 'windows-box', false), 'local');
});
```

- [ ] **Step 6: Обновить вызовы в sessions.html**

Шесть мест зовут эти функции с `CONFIG.mqtt.configured` (строки ~2389, 2487, 2571, 3153, 3397, 3448). Завести рядом с `focusBase`/`managerBase` одну функцию и звать её везде:

```javascript
  /** Есть ли вообще дорога до менеджера: прямой адрес либо брокер. */
  function managerReachable() {
    return Boolean(
      window.SessionWindows.managerHttp(lastState, CONFIG.windowHost)
      || CONFIG.mqtt.configured,
    );
  }
```

Заменить `CONFIG.mqtt.configured` на `managerReachable()` во всех шести вызовах `OpenTransport.*`. Строки 1967, 1979 и 2194 — другие проверки (`CONFIG.mqtt.configured` там гейтит саму отправку), их Task 7 переведёт на наличие транспорта; сейчас не трогать.

- [ ] **Step 7: Прогнать тесты**

Run: `npm test 2>&1 | tail -8`
Expected: PASS, 1121+ тестов.

- [ ] **Step 8: Коммит**

```bash
git add frontend-src/session-windows.js frontend-src/open-transport.js sessions.html test/
git commit -m "feat: пикер читает адрес менеджера и выбирает ветку по достижимости"
```

---

### Task 6: Пять просьб по HTTP из Rust

**Files:**
- Create: `src-tauri/src/manager_http.rs`
- Modify: `src-tauri/Cargo.toml` (зависимость `ureq`), `src-tauri/src/main.rs` (объявление модуля)
- Test: `#[cfg(test)] mod tests` внутри `manager_http.rs`

**Interfaces:**
- Consumes: адрес строкой `"host:port"` из Task 5.
- Produces (все возвращают `Result<(), String>`, потолок 5 секунд, как у MQTT):
  - `manager_http::focus(endpoint: &str, id: &str)`
  - `manager_http::unread(endpoint: &str, id: &str)`
  - `manager_http::open(endpoint: &str, id: &str, cwd: &str, terminal: &str, place: mqtt::Placement)`
  - `manager_http::open_project(endpoint: &str, cwd: &str, terminal: &str, place: mqtt::Placement)`
  - `manager_http::open_new(endpoint: &str, cwd: &str, name: &str, terminal: &str, place: mqtt::Placement)`
  - `manager_http::restore(endpoint: &str, id: &str, session_ids: &[String])`
  - `manager_http::place(endpoint: &str, mode: &str, ids: &[String])`
  - `manager_http::ROUTES: [(&str, &str); 5]` — пары «хвост топика → путь», читает сторож из Task 8.

- [ ] **Step 1: Добавить зависимость**

В `src-tauri/Cargo.toml`, после `rumqttc`:

```toml
# Просьба к менеджеру напрямую, без брокера. `default-features = false` —
# ради того, чего в дереве быть не должно: TLS тут не нужен (сеть локальная,
# адрес приезжает от своего же трекера), а `rustls` и `tokio` стоили бы
# времени сборки, которое в этом проекте посчитано и записано таблицей ниже.
ureq = { version = "3", default-features = false }
```

Точный набор фич проверить: нужен обычный `http://`-запрос без TLS. Если сборка требует явной фичи транспорта — включить минимальную, TLS не включать.

- [ ] **Step 2: Написать падающий тест**

Создать `src-tauri/src/manager_http.rs` с одним только тестовым модулем и заглушками, чтобы тест компилировался и падал:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// Адрес разбирается ровно в том виде, в каком его собрал фронтенд, и
    /// мусор отвергается **до** запроса: попытка по кривому адресу выглядела бы
    /// как «менеджер не отвечает» и увела бы расследование не туда.
    #[test]
    fn endpoint_is_parsed_or_refused() {
        assert_eq!(parse_endpoint("windows-box:9722"), Some(("windows-box".to_string(), 9722)));
        assert_eq!(parse_endpoint(" windows-box:9722 "), Some(("windows-box".to_string(), 9722)));
        assert_eq!(parse_endpoint(""), None);
        assert_eq!(parse_endpoint("windows-box"), None);
        assert_eq!(parse_endpoint("windows-box:0"), None);
        assert_eq!(parse_endpoint("windows-box:abc"), None);
    }

    /// Пути не наши: их слушает уже написанный сервер на той стороне
    /// (`ROUTES` в `windows11-manager/src/http-server.js`). Тела просьб те же,
    /// что у публикации, — приёмник разбирает их одним и тем же роутером.
    #[test]
    fn routes_match_the_receiver() {
        assert_eq!(route_for("/claude-focus"), Some("/claude-wt/focus"));
        assert_eq!(route_for("/claude-session-unread"), Some("/claude-wt/session-unread"));
        assert_eq!(route_for("/claude-session-open"), Some("/claude-wt/session-open"));
        assert_eq!(route_for("/claude-snapshot-restore"), Some("/claude-wt/snapshot-restore"));
        assert_eq!(route_for("/claude-place"), Some("/claude-wt/place"));
        assert_eq!(route_for("/claude-unknown"), None);
    }

    /// Тело собирается тем же кодом, что и для публикации: разойдись они —
    /// одна и та же просьба значила бы разное в зависимости от транспорта, и
    /// поймать это можно было бы только на живой машине.
    #[test]
    fn focus_body_is_the_same_as_the_published_one() {
        assert_eq!(focus_body("aaa"), r#"{"id":"aaa"}"#);
    }
}
```

- [ ] **Step 3: Убедиться, что тест падает**

Run: `cd src-tauri && cargo test manager_http`
Expected: FAIL — модуль не объявлен в `main.rs`, функции не существуют.

- [ ] **Step 4: Реализовать модуль**

В `main.rs` рядом с `mod mqtt;` добавить `mod manager_http;`.

Содержимое `manager_http.rs` (шапка + реализация):

```rust
//! Просьбы к оконному менеджеру — прямым http-запросом.
//!
//! Второй транспорт тех же пяти просьб, что уже уходят публикацией в MQTT
//! (`mqtt.rs`). Пути и тела не наши: их слушает `ROUTES` в
//! `windows11-manager/src/http-server.js`, и разбирает тем же роутером, каким
//! разбирает пришедшее по MQTT. Придумывать рядом свои значило бы заводить
//! приёмник, которого нет.
//!
//! Выбор между транспортами — по наличию адреса, одной попыткой. Ретраев по
//! второму транспорту нет намеренно: таймаут на задумавшемся сервере
//! неотличим от падения, а `claude-session-open` не идемпотентна — повтор
//! открыл бы человеку второй терминал.
//!
//! У этой дороги, в отличие от публикации, **есть ответ**, и отказ доезжает до
//! статуслайна пикера. Тело ответа при этом не разбирается: рассказать
//! человеку, что именно не так, — отдельная задача.

use std::time::Duration;

/// Тот же потолок, что у публикации в MQTT: Enter не должен залипать на
/// недоступном менеджере — человек в этот момент ждёт окна.
const TIMEOUT: Duration = Duration::from_secs(5);

/// Хвост топика → путь у приёмника. Общего источника правды у этих пар нет,
/// как нет его и у имён команд; согласие держит сторож
/// `test/manager-routes.test.js`.
pub const ROUTES: [(&str, &str); 5] = [
    ("/claude-focus", "/claude-wt/focus"),
    ("/claude-session-unread", "/claude-wt/session-unread"),
    ("/claude-session-open", "/claude-wt/session-open"),
    ("/claude-snapshot-restore", "/claude-wt/snapshot-restore"),
    ("/claude-place", "/claude-wt/place"),
];

fn route_for(topic_tail: &str) -> Option<&'static str> {
    ROUTES.iter().find(|(t, _)| *t == topic_tail).map(|(_, r)| *r)
}

/// `"host:port"` → пара, либо отказ **до** запроса.
///
/// Кривой адрес, отправленный как есть, выглядел бы у человека как «менеджер
/// не отвечает» и увёл бы расследование к сети вместо файла трекера.
fn parse_endpoint(raw: &str) -> Option<(String, u16)> {
    let s = raw.trim();
    let (host, port) = s.rsplit_once(':')?;
    let host = host.trim();
    let port: u16 = port.trim().parse().ok()?;
    if host.is_empty() || port == 0 {
        return None;
    }
    Some((host.to_string(), port))
}

/// Общий ход всех пяти просьб.
fn post(endpoint: &str, topic_tail: &str, body: String) -> Result<(), String> {
    let (host, port) = parse_endpoint(endpoint)
        .ok_or_else(|| format!("manager address is malformed: {endpoint}"))?;
    let route = route_for(topic_tail)
        .ok_or_else(|| format!("no http route for {topic_tail}"))?;
    let url = format!("http://{host}:{port}{route}");
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .build()
        .new_agent();
    match agent.post(&url).content_type("application/json").send(&body) {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("manager at {host}:{port} refused {route}: {e}")),
    }
}
```

Точный вид вызова `ureq` сверить со справочником установленной версии: API у 2.x и 3.x разный. Требования неизменны — POST, тело строкой, `Content-Type: application/json`, общий таймаут 5 секунд, отказ текстом.

Дальше — семь публичных функций. Тела просьб **собирать теми же функциями, что и `mqtt.rs`**: перенести их построение (`focus_body`, `restore_payload`, `open_payload`, `place_payload`) в общее место, если они там приватные, и звать из обоих модулей. Дублировать сборку тела нельзя — разойдясь, она сделала бы одну и ту же просьбу разной в зависимости от транспорта.

```rust
pub fn focus(endpoint: &str, id: &str) -> Result<(), String> {
    post(endpoint, "/claude-focus", focus_body(id))
}
```

и так же остальные шесть, с теми же аргументами, что у одноимённых функций в `mqtt.rs` (см. блок «Produces» выше).

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `cd src-tauri && cargo test manager_http`
Expected: PASS, три теста.

- [ ] **Step 6: Прогнать весь набор Rust**

Run: `cargo test`
Expected: PASS. Если тесты `mqtt.rs` покраснели на перенесённой сборке тела — это и есть смысл переноса: одна функция вместо двух, тест остаётся на ней.

- [ ] **Step 7: Коммит**

```bash
cd <каталог ccfzf-picker>
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/manager_http.rs src-tauri/src/main.rs src-tauri/src/mqtt.rs
git commit -m "feat: пять просьб к менеджеру умеют ехать прямым http-запросом"
```

---

### Task 7: Развилка транспорта в шести командах

**Files:**
- Modify: `src-tauri/src/main.rs:934-950` (`configured_broker*`), `:968` (`focus_window_mqtt`), `:1000` (`unread_session_mqtt`), `:1030` (восстановление снимка), `:1055` (`place`), `:1100` (`open_session_mqtt`), `:1150` (`open_project`), `:1180` (`open_new`), `:2368` (плитка с хоткея)
- Modify: `sessions.html` — передача адреса в те же команды
- Test: `#[cfg(test)] mod tests` в `main.rs` (или в `manager_http.rs`, если там ближе)

**Interfaces:**
- Consumes: `manager_http::*` (Task 6), `SessionWindows.httpFor` / `managerHttp` / `unreadTargets` (Task 5).
- Produces: конечное поведение. Дальше — только сторожа и документация.

- [ ] **Step 1: Написать падающий тест на правило выбора**

В `main.rs` (или `manager_http.rs`) добавить чистую функцию решения и тест на неё:

```rust
    /// Правило выбора транспорта — одной функцией, а не условием по месту в
    /// шести командах: разойдись копии, одна просьба ушла бы http, соседняя
    /// MQTT, и объяснялось бы это «иногда не работает».
    #[test]
    fn transport_follows_the_address_only() {
        assert_eq!(transport_for("windows-box:9722"), Transport::Http);
        assert_eq!(transport_for(""), Transport::Mqtt);
        assert_eq!(transport_for("   "), Transport::Mqtt);
    }

    /// Ретрая нет: при выбранном http провал остаётся провалом. Публикация
    /// вдогонку открыла бы человеку второй терминал — `claude-session-open` не
    /// идемпотентна.
    #[test]
    fn a_failed_http_request_does_not_fall_back() {
        assert_eq!(fallback_after_http_failure(), None::<Transport>);
    }
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd src-tauri && cargo test transport`
Expected: FAIL — `transport_for` не существует.

- [ ] **Step 3: Реализовать развилку**

```rust
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Transport { Http, Mqtt }

/// Транспорт выбирается наличием адреса и ничем больше.
///
/// Маковский трекер попадает в `Mqtt` сам, без единого условия про macOS: у
/// него http-сервера нет, поля он не пишет. Заведись здесь проверка системы —
/// появление сервера на маке потребовало бы правки в пикере.
fn transport_for(http: &str) -> Transport {
    if http.trim().is_empty() { Transport::Mqtt } else { Transport::Http }
}

/// Ретраев между транспортами нет. Функция существует ради сторожа: правило
/// это невидимо в коде («просто нет ветки»), и без теста его вернули бы как
/// улучшение живучести.
fn fallback_after_http_failure() -> Option<Transport> { None }
```

Развести чтение конфига так, чтобы брокер не требовался на http-ветке. Заменить `configured_broker_and_terminal` на пару:

```rust
/// Конфиг для просьбы: брокер только если он есть, плюс имя терминала и сырой
/// конфиг.
///
/// Брокер стал необязательным, и это суть правки: до неё каждая из шести
/// команд первым делом требовала его и отвечала «mqtt is not configured» — на
/// машине, где брокер не нужен вовсе, потому что менеджер достижим напрямую.
fn config_parts() -> Result<(Option<mqtt::Broker>, String, serde_json::Value), String> {
    let raw = load_config()?;
    let broker = mqtt::broker_from_config(&raw);
    let broker = if broker.is_configured() { Some(broker) } else { None };
    let terminal = mqtt::terminal_name(&raw);
    Ok((broker, terminal, raw))
}

/// Брокер или внятный отказ — для ветки, которая уже выбрала MQTT.
fn require_broker(broker: Option<mqtt::Broker>) -> Result<mqtt::Broker, String> {
    broker.ok_or_else(|| {
        "mqtt is not configured: host and base are required in config.yaml".to_string()
    })
}
```

Каждую из шести команд переписать по образцу `focus_window_mqtt`:

```rust
#[tauri::command]
async fn focus_window_mqtt(id: String, base: Option<String>, http: Option<String>) -> Result<(), String> {
    // До просьбы, а не после: право должно быть на той стороне к моменту,
    // когда там дойдут до подъёма окна. Правило общее для обоих транспортов.
    allow_any_foreground();
    let endpoint = http.unwrap_or_default();
    match transport_for(&endpoint) {
        Transport::Http => tauri::async_runtime::spawn_blocking(move || {
            manager_http::focus(&endpoint, &id)
        })
        .await
        .map_err(|e| format!("focus_window_mqtt task failed: {e}"))?,
        Transport::Mqtt => {
            let broker = require_broker(config_parts()?.0)?;
            let base = mqtt::resolve_base(&broker, base.unwrap_or_default().trim());
            tauri::async_runtime::spawn_blocking(move || mqtt::focus(&broker, &base, &id))
                .await
                .map_err(|e| format!("focus_window_mqtt task failed: {e}"))?
        }
    }
}
```

Имена команд **не менять**: `focus_window_mqtt`, `open_session_mqtt` и соседи известны фронтенду, и переименование — отдельная правка, которую нельзя мешать с транспортом. Дописать к докблоку каждой строку о том, что транспорта теперь два.

`unread_session_mqtt` принимает не `bases: Vec<String>`, а `targets: Vec<Target>`:

```rust
#[derive(serde::Deserialize)]
struct Target { base: String, http: String }
```

Правило «каждая цель получает свою попытку независимо от исхода предыдущих, наружу уходит первая ошибка, но только после того, как испробованы все» сохранить дословно — ранний выход оставил бы вторую машину неотмотанной.

Плитка с хоткея (`main.rs:2368`) идёт мимо фронтенда: адрес там взять тем же способом, каким берётся база, — сиблингом `place_order::tracker_base`. Добавить в `place_order.rs`:

```rust
/// Адрес прямой просьбы к трекеру своей машины — `"host:port"` или пусто.
///
/// Тот же поиск записи, что у `tracker_base`, и те же три условия. Отдельная
/// функция, а не второе поле у первой: базу спрашивают и там, где адрес не
/// нужен, — а лишний возврат пришлось бы игнорировать в каждом вызове.
pub fn tracker_http(state: &Value, config_host: &str) -> String
```

- [ ] **Step 4: Проверить сборку и тесты**

Run: `cd src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 5: Передать адрес из фронтенда**

В `sessions.html`:

```javascript
  /** Куда просить о подъёме окна напрямую. Пусто — пойдём через MQTT. */
  function focusHttp(row) {
    return window.SessionWindows.httpFor(row, lastState, CONFIG.windowHost);
  }

  /** Куда просить об открытии сессии напрямую. Пусто — пойдём через MQTT. */
  function managerHttpHere() {
    return window.SessionWindows.managerHttp(lastState, CONFIG.windowHost);
  }
```

Дописать `http:` в шесть вызовов `invoke`:

- `focus_window_mqtt` (строка ~2283): `{ id: row.id, base: focusBase(row), http: focusHttp(row) }`
- `open_session_mqtt` (строка ~2558): добавить `http: managerHttpHere()` рядом с `base: managerBase()`
- отметка «непросмотрено» (строка ~2197): `bases:` → `targets: window.SessionWindows.unreadTargets(row, lastState)`
- восстановление снимка: адрес брать у владельца снимка — расширить `snapshotOwner` (строка ~2018) полем `http: window.SessionWindows.httpForHost(lastState, manager.host)`; для этого экспортировать `httpForHost` из `session-windows.js` наравне с `httpFor`
- раскладка (`place`) и открытие проекта / новой сессии: `http: managerHttpHere()`

Три гейта на `CONFIG.mqtt.configured` (строки ~1967, ~1979, ~2194) заменить на `managerReachable()` из Task 5: без этого отметка «непросмотрено» и пункты меню на машине без брокера остались бы выключенными при живом http.

- [ ] **Step 6: Прогнать оба набора**

Run: `npm test && (cd src-tauri && cargo test)`
Expected: PASS оба.

- [ ] **Step 7: Проверить порядок «погасить до просьбы»**

Run: `npm test 2>&1 | grep -i "hide-before-request" -A3`
Expected: PASS. Если сторож перечисляет ветки поимённо — добавить в него http-ветки; правило одинаково для обоих транспортов.

- [ ] **Step 8: Коммит**

```bash
git add src-tauri/src/main.rs src-tauri/src/place_order.rs sessions.html test/
git commit -m "feat: транспорт просьбы выбирается по адресу, брокер больше не обязателен"
```

---

### Task 8: Сторож согласия маршрутов

**Files:**
- Create: `test/manager-routes.test.js`

**Interfaces:**
- Consumes: `manager_http::ROUTES` (Task 6), `ROUTES` в `windows11-manager/src/http-server.js`.
- Produces: ничего.

Сторож ловит тихий отказ: путь, разошедшийся с приёмником, даст 404, и человек увидит «менеджер не отвечает» — неотличимо от лежащей службы. Прецедент устройства — `test/terminal-name.test.js`, который так же сверяет копию в Rust с чужим реестром.

- [ ] **Step 1: Написать тест**

```javascript
// Пути просьб живут в двух файлах на двух языках: `ROUTES` в
// `src-tauri/src/manager_http.rs` называет путь, `ROUTES` в
// `windows11-manager/src/http-server.js` его слушает. Общего источника правды
// нет — как нет его и у имён команд MQTT, — и согласие держит этот сторож.
//
// Ловит он тихий отказ: разошедшийся путь даёт 404, пикер показывает
// «менеджер отказал», и от лежащей службы это неотличимо.
//
// Соседний репозиторий может отсутствовать: сторож тогда пропускается, а не
// краснеет. Тест, который падает у того, кто склонировал один репозиторий,
// чинят удалением теста, а не разбором находки.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MANAGER_HTTP_RS = path.join(__dirname, '..', 'src-tauri', 'src', 'manager_http.rs');
const RECEIVER = path.join(
  __dirname, '..', '..', 'windows11-manager', 'src', 'http-server.js',
);

/** Пары «хвост топика → путь» из таблицы ROUTES в Rust. */
function ourRoutes() {
  const src = fs.readFileSync(MANAGER_HTTP_RS, 'utf8');
  const table = src.match(/pub const ROUTES[^=]*=\s*\[([\s\S]*?)\];/);
  assert.ok(table, 'таблица ROUTES не найдена в manager_http.rs');
  return [...table[1].matchAll(/\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)]
    .map(m => ({ topic: m[1], route: m[2] }));
}

/** Пути, которые слушает приёмник. */
function receiverRoutes() {
  const src = fs.readFileSync(RECEIVER, 'utf8');
  const table = src.match(/const ROUTES\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(table, 'таблица ROUTES не найдена в http-server.js');
  return new Set([...table[1].matchAll(/'([^']+)'\s*:/g)].map(m => m[1]));
}

test('каждый путь пикера слушает приёмник', (t) => {
  if (!fs.existsSync(RECEIVER)) {
    t.skip('windows11-manager рядом нет — сверять не с чем');
    return;
  }
  const listened = receiverRoutes();
  for (const { topic, route } of ourRoutes()) {
    assert.ok(
      listened.has(route),
      `путь ${route} (топик ${topic}) приёмник не слушает; известные: ${[...listened].join(', ')}`,
    );
  }
});

test('пять просьб — пять путей, и все разные', () => {
  const routes = ourRoutes();
  assert.equal(routes.length, 5, 'просьб к менеджеру пять');
  assert.equal(new Set(routes.map(r => r.route)).size, 5, 'два топика уехали на один путь');
});
```

- [ ] **Step 2: Прогнать**

Run: `npm test 2>&1 | grep -A5 "путь пикера"`
Expected: PASS оба теста. Если первый упал — значит `/claude-place` в приёмнике не объявлен: маршрут `'/claude-wt/place': 'claude-place'` надо добавить в `windows11-manager/src/http-server.js` (в текущей таблице его нет — там есть `/place`, но это команда окон, а не claude-wt) и закоммитить туда отдельным `fix:`.

- [ ] **Step 3: Коммит**

```bash
git add test/manager-routes.test.js
git commit -m "test: сторож согласия путей просьбы с приёмником"
```

---

### Task 9: Документация

**Files:**
- Modify: `CLAUDE.md` (пикер), `docs/rules/opening-sessions.md`, `docs/rules/windows-and-focus.md`, `docs/configuration.md`
- Modify: скилл `claude-wt` — `SKILL.md` и `mqtt-топики.md` (лежит в `~/.claude/skills/`, вне репозитория)
- Modify: `windows11-manager/AGENTS.md` или его `CLAUDE.md` — про служебный процесс и `httpPort`

**Interfaces:** нет.

- [ ] **Step 1: Правила пикера**

В `docs/rules/opening-sessions.md` добавить правило (счёт правил в таблице-указателе `CLAUDE.md` поднять с 10 до 11):

> **Транспорт просьбы выбирается наличием адреса, а не системой и не брокером.**
> Есть `windowHosts[].http` — просьба уходит прямым POST; нет — публикацией в
> MQTT. Мак попадает во вторую ветку сам: http-сервера у его трекера нет.
> Ретрая по второму транспорту нет намеренно — таймаут неотличим от падения, а
> `claude-session-open` не идемпотентна, и повтор открыл бы второй терминал.

В `docs/rules/windows-and-focus.md` дописать к правилу про право переднего плана, что «погасить → выдать `ASFW_ANY` → послать» одинаково для обоих транспортов.

- [ ] **Step 2: Раздел в CLAUDE.md пикера**

Дописать в раздел про правила, за которые заплачено, — коротко, с отсылкой к спеке: транспортов два, адрес едет файлом трекера, согласовывать руками нечего, сторож — `test/manager-routes.test.js`.

- [ ] **Step 3: Скилл claude-wt**

В `SKILL.md` заменить абзац «**HTTP-сервер не участвует**» — он теперь неверен целиком. Новый текст: сервер живёт внутри служебного процесса, поднимается всегда, подкоманды `http-server` больше нет, порт — `httpPort` верхнего уровня. В таблицу «Что менялось → что сделать» добавить строку про `httpPort`. В `mqtt-топики.md` добавить колонку или абзац о том, что те же пять просьб имеют http-путь, и назвать таблицу `ROUTES` обоих концов.

В таблице частых ошибок добавить строку:

| Пикер открывает сессию локально, теряя профиль Windows Terminal | Транспорта до менеджера нет: ни `http` в `windowHosts` (старый трекер или агрегатор), ни настроенного брокера. `chooseOpenTransport` тогда честно отвечает `local` |

- [ ] **Step 4: Конфигурация**

В `docs/configuration.md` пикера — ничего нового не появилось (адрес приезжает сам). В документации windows11-manager описать `httpPort` с оговоркой про верхний уровень.

- [ ] **Step 5: Прогнать тесты и закоммитить**

Run: `npm test`
Expected: PASS — сторож приватных данных проверяет `git ls-files`, поэтому **сперва `git add`, потом `npm test`**.

```bash
git add CLAUDE.md docs/
git commit -m "docs: два транспорта просьбы, адрес из файла трекера"
```

Скилл лежит вне репозитория — его правка не коммитится сюда.

---

### Task 10: Деплой на Windows и маки

**Files:** нет — задача целиком про выкатку и живую проверку.

Отдельной задачей в конце, а не строчкой внутри Task 9: код лежит на машине разработки, а работает на Windows, и до выкатки правка не проверена ничем, кроме тестов. Деплой этой связки уже врал молча не раз — «скрипт отработал» здесь не значит «правка на месте».

- [ ] **Step 1: Запушить всё**

```bash
cd <каталог ccfzf-picker> && git push -u origin feat/manager-http-transport
cd <каталог windows11-manager> && git push
```

Скрипты деплоя первым делом делают `git pull` на целевой машине: незапушенное не уедет вовсе. Ветку называть явно — умолчание у скриптов `master`.

- [ ] **Step 2: Выкатить менеджер**

Run: `cd <каталог windows11-manager> && ./data/scripts/deploy-pc.sh`
Правится и Rust трея, и node — значит полная сборка, без `--no-build`.

Первым, а не вторым: пикер без менеджера ничего не проверит.

- [ ] **Step 3: Проверить, что служба поднялась и слушает**

На Windows-машине (имя хоста — из `~/.config/ccfzf-picker/config.yaml`, в
репозиторий оно не возвращается):

```bash
ssh <windows-хост> 'powershell -Command "Get-CimInstance Win32_Process | Where-Object CommandLine -match (0)index.js (mqtt|claude-wt)(0) | Select-Object ProcessId,ParentProcessId,CommandLine"'
ssh <windows-хост> 'powershell -Command "Test-NetConnection -ComputerName localhost -Port 9722"'
```

Ожидается ровно по одному живому `index.js mqtt` и `index.js claude-wt` (сироты от убитого мимо деплоя трея — известная беда, см. скилл), и `TcpTestSucceeded: True`.

- [ ] **Step 4: Выкатить пикер на три машины параллельно и в фоне**

```bash
cd <каталог ccfzf-picker>
BRANCH=feat/manager-http-transport ./data/scripts/deploy-win.sh &
BRANCH=feat/manager-http-transport ./data/scripts/deploy-mac.sh --all &
wait
```

Windows собирается около трёх с половиной минут, маки — около одной.

- [ ] **Step 5: Проверить, что адрес доехал**

```bash
ssh <хост агрегатора> 'ccfzf --state' | python3 -c "import json,sys; print(json.load(sys.stdin)['windowHosts'])"
```

У записи Windows-машины ожидается `"http": {"port": 9722}`; у маковской — `None`. Пусто у обеих значит, что ccfzf на машине агрегатора старой версии — Task 4 правит рабочий каталог, деплоя у него нет, но `git pull` там сделать надо.

- [ ] **Step 6: Живая проверка, ради которой всё делалось**

На Windows-машине остановить брокер или снять `W11M_MQTT_HOST` (тумблер `Stop service` → снять переменную → `Start service`). Открыть пикер, встать на строку сессии Windows-машины, нажать Enter.

Ожидается: сессия открывается **на трекере, терминалом с профилем из `claudeWt.projects`**. До правки это молча откатывалось на локальный терминал — то есть выглядело как «работает», и отличие видно только по профилю.

Проверить попутно: `^K` → «Open on \<host\>» с мака, отметку «непросмотрено», раскладку плиткой, восстановление снимка. Пять просьб — пять проверок.

- [ ] **Step 7: Вернуть брокер и проверить, что панель жива**

Вернуть `W11M_MQTT_HOST`, перезапустить службу. Проверить, что строки на панели openHASP обновляются и нажатие слота переводит фокус: это и есть проверка того, что `claude-focus-slot` получил **настоящие** слоты, а не заглушку.

- [ ] **Step 8: Сказать человеку, чего на машинах ещё нет**

Коммит, легший после запуска скриптов, на экране не окажется. Назвать такие явно.

---

## Самопроверка плана

**Покрытие спеки.** Пройдено по секциям: «Как адрес доезжает» → Task 1, 4, 5; «Служебный процесс» → Task 2, 3; «Выбор транспорта» → Task 6, 7; «Безопасность» → решений не требует, записана в спеке как принятый риск; «Что сломается молча» → четыре сторожа разложены по Task 1 (мусорный порт), Task 2 (служба без брокера, заглушка слотов), Task 4 (поле доезжает), Task 8 (маршруты), плюс правило «нет ретрая» в Task 7; «Выкатка» → Task 10. Непокрытых требований не осталось.

**Известная неточность, оставленная сознательно.** Точный вид вызова `ureq` (Task 6, Step 4) назван требованиями, а не готовым кодом: API 2.x и 3.x несовместимы, и выдуманная сигнатура была бы хуже честной отсылки к справочнику. То же — с набором фич в `Cargo.toml`.

**Найдено при самопроверке и учтено в задачах:**

- В приёмнике **нет маршрута для `claude-place`** — в таблице `ROUTES` (`http-server.js`) есть `/place` (команда окон) и пять `/claude-wt/*`, но раскладки среди них нет. Спека утверждала, что маршруты покрывают все пять просьб; это неверно. Task 8, Step 2 ловит расхождение и называет правку.
- `read_windows` в ccfzf возвращает кортеж, и его распаковывают в нескольких местах — Task 4, Step 6 требует найти все.
- `test_hosts_list_names_every_live_tracker` сверяет записи целиком и покраснеет от нового ключа — Task 4, Step 1 правит его заранее.
- `unreadBases` меняет форму на `unreadTargets`, а вместе с ней — сигнатура команды `unread_session_mqtt`. Обе правки лежат в одной паре задач (5 и 7), чтобы ветка не была сломана между коммитами.
