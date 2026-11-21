// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CacheWarn = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // globalThis, а не `root`: тот виден только внешней функции шима, а внутрь
  // factory не передаётся. Та же дорога, что у session-windows.js.
  const windowsApi = typeof module === 'object' && module.exports
    ? require('./session-windows')
    : globalThis.SessionWindows;

  /*
   * Мигание кнопки окна перед остыванием кеша промпта (спека
   * docs/superpowers/specs/2026-11-21-cache-warn-design.md).
   *
   * Мигает служба windows11-manager — она хозяин кнопки окна WezTerm, — а
   * знает метку кеша только пикер: `cacheAt` считает ccfzf по хвосту
   * транскрипта. Поэтому пикер отдаёт каждому трекеру **весь набор**
   * `{warnMin, sessions: [{id, cacheAt}]}`, а служба заменяет им свой и сама
   * отсчитывает сроки. Отмена при таком устройстве бесплатна: сессия, которая
   * заработала или сжалась, просто пропадает из набора.
   */

  // Служба держит набор в памяти, и любая выкатка её перезапускает: повтор
  // раз в пять минут возвращает ей набор без участия человека.
  const CACHE_WARN_HEARTBEAT_MS = 5 * 60 * 1000;

  const targetKey = t => `${t.base}|${t.http}`;

  /**
   * Наборы по трекерам: ключ `base|http` → `{target, body}`.
   *
   * `rows` — строки buildSessionList **до** отсевов списка: мигать должно и
   * то, что человек сейчас не показывает. В набор идёт сессия с меткой кеша,
   * не работающая (работающей кеш освежает каждый вызов) и с окном у этого
   * трекера — без окна мигать нечем. Карточки одной сессии (по окну на
   * карточку) схлопываются по id, сессии упорядочены по id: иначе одинаковый
   * набор в другом порядке считался бы изменившимся.
   *
   * `warnMin` 0 — пустая карта: погасить уже мигающее — дело отправителя,
   * он шлёт пустой список целям, которых в карте не стало.
   */
  function cacheWarnSets(rows, state, warnMin) {
    const out = new Map();
    if (!(warnMin > 0)) return out;
    const seen = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      const at = Number(row && row.agentCacheAt) || 0;
      if (!at || row.agentState === 'active' || seen.has(row.id)) continue;
      seen.add(row.id);
      for (const target of windowsApi.unreadTargets(row, state)) {
        const key = targetKey(target);
        if (!out.has(key)) out.set(key, { target, body: { warnMin, sessions: [] } });
        out.get(key).body.sessions.push({ id: row.id, cacheAt: at });
      }
    }
    for (const set of out.values()) {
      set.body.sessions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    return out;
  }

  /**
   * Отправитель наборов. `update(sets)` зовётся на каждом ответе опроса (раз в
   * секунду при показанном окне) и шлёт цели только изменившийся набор либо
   * повтор после `heartbeatMs`. Цель, пропавшая из `sets`, один раз получает
   * пустой список — так гаснет мигание у сессии, которой больше нет, и у всех
   * разом при `warnMin` 0.
   *
   * Отказ отправки не запоминается: следующий `update` повторит. Отправка,
   * которая ещё идёт, второй раз не уходит — http-просьба ждёт до пяти секунд,
   * а ответы опроса приходят каждую.
   */
  function createCacheWarnSender({
    send, onError = () => {}, nowMs = Date.now, heartbeatMs = CACHE_WARN_HEARTBEAT_MS,
  }) {
    const sent = new Map();
    const pending = new Set();

    function push(key, target, body, done) {
      pending.add(key);
      return Promise.resolve()
        .then(() => send(target, body))
        .then(() => done(), (e) => onError(e))
        .finally(() => pending.delete(key));
    }

    function update(sets) {
      const now = nowMs();
      const jobs = [];
      for (const [key, { target, body }] of sets) {
        if (pending.has(key)) continue;
        const json = JSON.stringify(body);
        const prev = sent.get(key);
        if (prev && prev.json === json && now - prev.at < heartbeatMs) continue;
        jobs.push(push(key, target, body, () => {
          sent.set(key, { json, at: now, target, warnMin: body.warnMin });
        }));
      }
      for (const [key, prev] of sent) {
        if (sets.has(key) || pending.has(key)) continue;
        jobs.push(push(key, prev.target, { warnMin: prev.warnMin, sessions: [] }, () => {
          sent.delete(key);
        }));
      }
      return Promise.all(jobs);
    }

    return { update };
  }

  return { cacheWarnSets, createCacheWarnSender, CACHE_WARN_HEARTBEAT_MS };
});
