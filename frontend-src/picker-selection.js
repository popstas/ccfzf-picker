// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PickerSelection = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Сообщать Rust подсвеченную строку — только при её смене.
   *
   * Хоткей раскладки группы обрабатывает Rust, и выбор при открытом пикере
   * ему взять неоткуда, кроме как от страницы. Слать на каждый `paint()`
   * незачем: он зовётся и на каждом ответе агрегатора, раз в секунду.
   *
   * `reset()` — на гашении окна: Rust выбор тогда забывает, и при следующем
   * показе та же строка обязана уйти заново.
   */
  function createSelectionSync(send) {
    let last;
    return {
      sync(id) {
        const value = typeof id === 'string' && id ? id : null;
        if (value === last) return;
        last = value;
        send(value);
      },
      reset() {
        last = undefined;
      },
    };
  }

  return { createSelectionSync };
});
