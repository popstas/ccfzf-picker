// Loaded twice: as a <script> in sessions.html and as a module in the tests.
// The project has no bundler, and duplicating this logic to make it testable
// would be worse than this shim.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StateShape = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Проверяются только те поля, на которые опирается пикер. Лишние поля
  // агрегатора — не ошибка: ccfzf отдаёт и то, что нужно другим читателям.
  const SESSION_FIELDS = [
    ['id', 'string'],
    ['cwd', 'string'],
    ['title', 'string'],
    ['mtime', 'number'],
    ['live', 'boolean'],
    ['kind', 'string'],
  ];

  function validateState(obj) {
    const out = [];
    if (!obj || !Array.isArray(obj.sessions)) return ['sessions is not an array'];
    if (typeof obj.generated !== 'number') out.push('generated is not a number');
    obj.sessions.forEach((s, i) => {
      for (const [key, type] of SESSION_FIELDS) {
        if (typeof (s || {})[key] !== type) out.push(`sessions[${i}].${key} is not a ${type}`);
      }
      // pid и tty есть только у живой сессии: у остальных процесса нет.
      if (s && s.live && typeof s.pid !== 'number') out.push(`sessions[${i}].pid is not a number`);
      // agent отсутствует, пока хук ни разу не сработал, — это нормально.
      if (s && s.agent && typeof s.agent.updated !== 'number') {
        out.push(`sessions[${i}].agent.updated is not a number`);
      }
    });
    return out;
  }

  return { validateState };
});
