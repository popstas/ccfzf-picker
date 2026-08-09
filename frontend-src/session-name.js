// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SessionName = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Свободное имя для новой сессии.
   *
   * Занято — `-2`, дальше `-3`, и так далее, без потолка. Нумерация с двойки,
   * а не с единицы: первая сессия называется просто именем каталога, и
   * `имя-1` рядом с ней читалось бы как другая сессия.
   *
   * Занятыми считаются имена **живых** сессий — решает это вызывающий. Имя
   * здесь не украшение: по заголовку окна оконный трекер привязывает сессию к
   * слоту, и мешают друг другу именно живые тёзки. Мёртвая сессия с тем же
   * именем не мешает никому.
   *
   * Мусор в списке занятых выбрасывается молча: список собирается из ответа
   * агрегатора, а тот меняется сам по себе — отказ здесь оставил бы человека
   * без новой сессии из-за чужого поля.
   *
   * Пустое базовое имя возвращается пустым: суффикс к пустоте дал бы `-2`,
   * имя, которое ничего не значит. Что делать с пустотой, решает вызывающий.
   */
  function uniqueSessionName(base, taken) {
    const name = String(base == null ? '' : base).trim();
    if (!name) return '';
    const used = new Set(
      (Array.isArray(taken) ? taken : [])
        .filter(t => typeof t === 'string')
        .map(t => t.trim())
        .filter(Boolean),
    );
    if (!used.has(name)) return name;
    // Цикл конечен: занятых конечное число, и каждый шаг пробует новое имя.
    for (let n = 2; ; n += 1) {
      const candidate = `${name}-${n}`;
      if (!used.has(candidate)) return candidate;
    }
  }

  return { uniqueSessionName };
});
