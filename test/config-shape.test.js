const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeConfig } = require('../frontend-src/config-shape');

// Умолчание reptyr — false, хотя в бою в config.yaml стоит true (вердикт
// docs/reptyr-experiment.md). Это не рассинхрон: без конфига пикер не знает,
// установлен ли reptyr на той стороне, и обещать перенос процесса вслепую
// нельзя — незнание должно вести к перехвату с подтверждением, а не к команде,
// которой на хосте нет.
test('пустой конфиг даёт рабочие значения по умолчанию', () => {
  const c = normalizeConfig(null);
  assert.strictEqual(c.sshHost, 'example-host');
  assert.strictEqual(c.hotkey, 'Cmd+Shift+C');
  assert.strictEqual(c.caps.reptyr, false);
  assert.strictEqual(c.caps.takeover, false);
  assert.strictEqual(c.onlyLive, true);
  assert.strictEqual(c.hideOnBlur, true);
  assert.deepStrictEqual(c.terminal, { file: '/opt/homebrew/bin/kitty', args: ['--single-instance'] });
  assert.deepStrictEqual(c.projects, []);
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
