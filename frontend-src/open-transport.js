// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpenTransport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function normHost(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  /**
   * Кто открывает сессию.
   *
   * На машине оконного трекера — он: маппинг проекта на профиль Windows
   * Terminal (`claudeWt.projects`) знает только windows11-manager, и собранная
   * здесь команда `wt.exe` этот профиль теряет.
   *
   * Где трекера нет — открываем сами, как раньше: на macOS менеджера не
   * существует, и просьба уехала бы открывать окно на чужой машине.
   *
   * `windowPid` здесь, в отличие от `canFocus`, не смотрим: право переднего
   * плана нужно для подъёма окна, а не для запуска терминала.
   */
  function chooseOpenTransport(state, configHost) {
    const host = normHost((state || {}).windowHost);
    const mine = normHost(configHost);
    return host && host === mine ? 'manager' : 'local';
  }

  return { chooseOpenTransport };
});
