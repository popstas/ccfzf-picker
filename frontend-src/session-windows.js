// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SessionWindows = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Имя машины из ответа агрегатора — в сравнимый вид.
   *
   * Одна сторона — `os.hostname()` соседней машины, другая — строка, набранная
   * человеком в конфиге. Регистр в именах машин Windows не значит ничего, а
   * пробел по краям набирается легко и не виден вовсе.
   */
  function normHost(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  /**
   * Поднимать ли окно вместо открытия терминала.
   *
   * Окна, о которых рассказал агрегатор, живут на машине `state.windowHost`.
   * Совпала она с той, где работает пикер, — окно на том же экране, перед
   * которым человек, и Enter должен поднять его. Не совпала — пометка о таком
   * окне по-прежнему полезна (сессия где-то открыта), но подъём не дал бы
   * человеку ничего и вдобавок отнял бы у Enter привычное открытие терминала.
   *
   * Пустой `windowHost` в конфиге — «фокуса не бывает». Это умолчание: пикер,
   * которому не сказали, на какой он машине, обязан вести себя как прежде.
   *
   * Нулевой `windowPid` тоже запрещает фокус, но читать его теперь надо иначе.
   * Раньше это был адресат грамоты на передний план, и без адресата подъём
   * отчитался бы об успехе, а на экране мигнула бы кнопка на таскбаре. Грамота
   * больше не именная (`allow_any_foreground` в main.rs: поднимает окно не тот
   * процесс, чей pid публикует трекер), и осталось второе значение поля —
   * признак живого трекера: свой pid в файл окон кладёт он сам. Ноль значит
   * «файла нет, он чужой или протух», а Enter, молча не сработавший, хуже
   * прежнего поведения.
   */
  function canFocus(state, configHost) {
    const host = normHost((state || {}).windowHost);
    const mine = normHost(configHost);
    return Boolean(host) && host === mine && focusPid(state) > 0;
  }

  /** pid демона трекера; ноль значит «трекера не слышно». */
  function focusPid(state) {
    const pid = (state || {}).windowPid;
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  }

  return { canFocus, focusPid };
});
