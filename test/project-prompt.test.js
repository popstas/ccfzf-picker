// Сторожа режима промпта (`/p <проект> <промпт>`) в sessions.html.
//
// Текстовые, и иначе никак: страница в тестах не поднимается, а каждая из
// ошибок ниже не падает — она просто делает не то. Забытый prompt в одной
// ветке транспорта открывает сессию без промпта, и видно это только на той
// машине, где эта ветка выбрана.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');
const mainRs = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'main.rs'), 'utf8');

/** Тело функции страницы: от объявления до первой строки `  }` с её отступом. */
function body(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} пропала — сторож сторожит не то`);
  const end = html.indexOf('\n  }\n', start);
  return html.slice(start, end);
}

test('Enter в режиме промпта идёт мимо openProjectRow и projectOpenAction', () => {
  const choose = body('choose');
  const prompt = choose.indexOf('projectPromptTarget()');
  const plain = choose.indexOf('openProjectRow(row, opts)');
  assert.ok(prompt !== -1 && plain !== -1 && prompt < plain, 'режим промпта проверяется раньше обычного открытия проекта');
});

test('промпт уходит развилкой ^N, а не мимо менеджера', () => {
  // Своя местная newSession здесь потеряла бы http и MQTT менеджера, а с
  // ними профиль Windows Terminal и расстановку окна.
  const open = body('openProjectPrompt');
  assert.match(open, /newSessionHere\(row, opts, prompt\)/);
  assert.doesNotMatch(open, /\bnewSession\(/);
});

test('каждая ветка newSessionHere везёт промпт', () => {
  const here = body('newSessionHere');
  const local = here.match(/newSession\([^)]*\)/g) || [];
  assert.ok(local.length >= 2, here);
  for (const call of local) assert.match(call, /prompt/, `местная ветка без промпта: ${call}`);
  assert.match(here, /\.\.\.\(prompt \? \{ prompt \} : \{\}\)/, 'просьба менеджеру без промпта');
});

test('команда Rust принимает ключ prompt — тот, что шлёт страница', () => {
  const start = mainRs.indexOf('async fn new_session_mqtt(');
  const sig = mainRs.slice(start, mainRs.indexOf(') -> Result', start));
  assert.match(sig, /\bprompt: Option<String>/);
  assert.match(mainRs, /manager_http::open_prompt\(/);
  assert.match(mainRs, /mqtt::open_prompt\(/);
});

test('Tab гасится всегда, а не только на строке проекта', () => {
  // Иначе на строке сессии webview увёл бы фокус из поиска.
  const at = html.indexOf("e.key === 'Tab'");
  assert.ok(at !== -1, 'ветки Tab нет');
  const branch = html.slice(at, html.indexOf('return;', at));
  const prevent = branch.indexOf('e.preventDefault()');
  const act = branch.indexOf('tabToProject()');
  assert.ok(prevent !== -1 && act !== -1 && prevent < act, branch);
});
