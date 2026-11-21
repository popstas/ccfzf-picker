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
//
// А вот если сосед есть, но стоит на ветке без нужного маршрута, — сторож
// именно краснеет, и по причине, лежащей целиком в соседнем репозитории:
// смотреть в этом случае надо на его ветку, а не на код здесь.
//
// В CI этот сторож не работает никогда: у бегунка соседнего репозитория нет
// и не будет — оба клонируются раздельно, `windows11-manager` рядом с
// `ccfzf-picker` не появляется ни на одном прогоне. Согласие путей проверяет
// только машина разработчика, у которой оба репозитория лежат рядом на
// диске. Решение верное (заводить его в CI значило бы тянуть туда второй
// репозиторий целиком ради одного теста), но об этом стоит знать: зелёный CI
// не значит, что эта пара путей согласована.
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

test('семь просьб — семь путей, и все разные', () => {
  const routes = ourRoutes();
  assert.equal(routes.length, 7, 'просьб к менеджеру семь');
  assert.equal(new Set(routes.map(r => r.route)).size, 7, 'два топика уехали на один путь');
});

/** Путь вопроса о терминале — отдельной константой: топика у него нет. */
function ourTerminalRoute() {
  const src = fs.readFileSync(MANAGER_HTTP_RS, 'utf8');
  const m = src.match(/pub const TERMINAL_ROUTE: &str = "([^"]+)";/);
  assert.ok(m, 'TERMINAL_ROUTE не найден в manager_http.rs');
  return m[1];
}

test('вопрос о терминале приёмник слушает', (t) => {
  // Разойдись путь — менеджер ответил бы 404, и пикер молча остался бы на
  // пресете: окно открылось бы, только не тем терминалом, что выбран в
  // `claudeWt.terminal`.
  const route = ourTerminalRoute();
  assert.strictEqual(route, '/claude-wt/terminal');
  assert.ok(!ourRoutes().some(r => r.route === route), 'вопрос о терминале — не просьба из ROUTES');
  if (!fs.existsSync(RECEIVER)) {
    t.skip('windows11-manager рядом нет — сверять не с чем');
    return;
  }
  assert.ok(receiverRoutes().has(route), `путь ${route} приёмник не слушает`);
});
