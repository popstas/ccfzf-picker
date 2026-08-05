const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeConfig } = require('../frontend-src/config-shape');

// Умолчание reptyr — false, хотя в бою в config.yaml стоит true (вердикт —
// см. архив скилла claude-wt). Это не рассинхрон: без конфига пикер не знает,
// установлен ли reptyr на той стороне, и обещать перенос процесса вслепую
// нельзя — незнание должно вести к перехвату с подтверждением, а не к команде,
// которой на хосте нет.
test('пустой конфиг даёт рабочие значения по умолчанию', () => {
  const c = normalizeConfig(null);
  // Умолчания у хоста нет и быть не может: любое значение здесь — либо чужое
  // имя машины, либо ложь. Пустой хост пикер показывает как ненастроенный
  // конфиг (check_ssh_host в src-tauri/src/main.rs).
  assert.strictEqual(c.sshHost, '');
  assert.strictEqual(c.hotkey, 'Cmd+Shift+C');
  assert.strictEqual(c.caps.reptyr, false);
  assert.strictEqual(c.caps.takeover, false);
  assert.strictEqual(c.onlyLive, true);
  assert.strictEqual(c.hideOnBlur, true);
  assert.deepStrictEqual(c.terminal, { file: '/opt/homebrew/bin/kitty', args: ['--single-instance'] });
  assert.deepStrictEqual(c.projects, []);
  // Пустой url — выключенный трекер. Умолчания у него нет по той же причине,
  // что и у sshHost: любое значение было бы чужим именем машины.
  assert.deepStrictEqual(c.windowTracker, { url: '' });
  assert.deepStrictEqual(c.mqtt, { configured: false });
});

test('брокер считается настроенным только с адресом и префиксом сразу', () => {
  // Те же два условия, что и в Broker::is_configured на стороне Rust: без
  // адреса публиковать нечем, без префикса топиков — некуда.
  const has = (mqtt) => normalizeConfig({ mqtt }).mqtt.configured;
  assert.strictEqual(has({ host: 'broker', base: 'home/room/pc' }), true);
  assert.strictEqual(has({ host: 'broker' }), false);
  assert.strictEqual(has({ base: 'home/room/pc' }), false);
  assert.strictEqual(has({ host: '  ', base: 'home/room/pc' }), false);
  assert.strictEqual(has({ host: 42, base: 'home/room/pc' }), false);
  assert.strictEqual(has(undefined), false);
});

test('url трекера чистится от пробелов, мусор выключает его', () => {
  // Пробел вокруг адреса — самая частая опечатка в yaml, и она превратила бы
  // url в непустой, но нерабочий: запросы шли бы каждую секунду и падали.
  assert.strictEqual(
    normalizeConfig({ windowTracker: { url: '  http://localhost:9722 ' } }).windowTracker.url,
    'http://localhost:9722',
  );
  for (const windowTracker of [{ url: 42 }, {}, 'мусор', null]) {
    assert.strictEqual(normalizeConfig({ windowTracker }).windowTracker.url, '', String(windowTracker));
  }
});

test('заданные значения перекрывают умолчания', () => {
  const c = normalizeConfig({ sshHost: 'other', caps: { reptyr: true, takeover: true } });
  assert.strictEqual(c.sshHost, 'other');
  assert.strictEqual(c.caps.reptyr, true);
  assert.strictEqual(c.caps.takeover, true);
});

// Единственное поле с умолчанием true, поэтому его выключение проверяется
// отдельно: `false` не должен потеряться на проверке «значение задано».
test('поля с умолчанием true выключаются только явным false', () => {
  for (const key of ['onlyLive', 'hideOnBlur']) {
    assert.strictEqual(normalizeConfig({ [key]: false })[key], false, key);
    assert.strictEqual(normalizeConfig({ [key]: 'нет' })[key], true, key);
    assert.strictEqual(normalizeConfig({})[key], true, key);
  }
});

test('проект без пути отбрасывается, а не роняет конфиг', () => {
  const c = normalizeConfig({ projects: [
    { path: '/home/user/x', hotkey: 'Cmd+Shift+1' },
    { hotkey: 'Cmd+Shift+2' },
    'мусор',
  ] });
  assert.deepStrictEqual(c.projects, [{ path: '/home/user/x', hotkey: 'Cmd+Shift+1' }]);
});

test('проект без хоткея остаётся в списке', () => {
  const c = normalizeConfig({ projects: [{ path: '/home/user/y' }] });
  assert.deepStrictEqual(c.projects, [{ path: '/home/user/y', hotkey: '' }]);
});
