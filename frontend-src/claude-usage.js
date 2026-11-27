// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClaudeUsage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Usage лимитов Claude в статуслайне: `5h: 43% -117m 54m left | week: 87% +1.4d`.
   *
   * Формулы переписаны с `llm-usage-update-image` на домашнем сервере
   * (`elapsed_percent_week`, `deviation_days_text`, `remaining_text`,
   * `data_is_stale`): картинка на панели и этот блок читают один и тот же json,
   * и разойдись они в арифметике — два экрана называли бы разный запас.
   * Отличие одно и намеренное: «left» и offset считаются от текущего времени, а
   * не от `updated_at`. Картинку перерисовывают на каждое обновление файла, а
   * блок — раз в минуту своим таймером, и отсчёт обязан идти сам (решение
   * coord 27.11.2026).
   *
   * Чистый модуль: время приходит аргументом, DOM не трогается.
   */

  /** Данные старше этого — весь блок серый. Как у скрипта, а не ровно 5: файл
   * обновляется раз в 3–5 минут, и ровная пятёрка мигала бы серым. */
  const FRESH_DATA_MINUTES = 5.2;
  /** Опережение в 5-часовом окне, с которого offset красный (строго больше). */
  const HOT_MINUTES = 15;

  const FIVE_HOURS = 5 * 3600;
  const WEEK = 7 * 24 * 3600;

  /** Процент как `int()` скрипта, зажатый в 0..100. */
  function percent(value) {
    const n = Math.trunc(Number(value));
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
  }

  /** Сколько окна прошло, в процентах; `null` — окно не начато. */
  function elapsed(resetsAt, windowSec, now) {
    if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return null;
    const pct = (1 - (resetsAt - now) / windowSec) * 100;
    return Math.max(0, Math.min(100, pct));
  }

  /** Плюс у положительных, у нуля знака нет — ни `+0m`, ни `-0m`. */
  function signed(value, text) {
    return `${value > 0 ? '+' : ''}${text}`;
  }

  /** `remaining_text` скрипта. */
  function remaining(resetsAt, now) {
    if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return 'not started';
    const seconds = Math.trunc(resetsAt - now);
    if (seconds <= 0) return 'reset due';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 90) return `${minutes}m left`;
    const hours = minutes / 60;
    if (hours < 48) return `${hours.toFixed(1)}h left`;
    return `${(hours / 24).toFixed(1)}d left`;
  }

  /** `updated_at` в секунды: ISO-строка или число, как у `parse_timestamp_unix`. */
  function stampSec(raw) {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
      const ms = Date.parse(raw);
      return Number.isFinite(ms) ? ms / 1000 : null;
    }
    return null;
  }

  function fiveHourView(src, now) {
    const pct = percent(src.usedPercent);
    const done = elapsed(src.resetsAtUnix, FIVE_HOURS, now);
    if (done === null) return { pct, offset: '', offsetHot: false, left: remaining(src.resetsAtUnix, now) };
    // `|| 0` снимает минус у нуля: Math.round(-0.1) — это -0.
    const minutes = Math.round(((pct - done) / 100) * (FIVE_HOURS / 60)) || 0;
    return {
      pct,
      offset: signed(minutes, `${minutes}m`),
      offsetHot: minutes > HOT_MINUTES,
      left: remaining(src.resetsAtUnix, now),
    };
  }

  function weekView(src, now) {
    const pct = percent(src.usedPercent);
    const done = elapsed(src.resetsAtUnix, WEEK, now);
    if (done === null) return { pct, offset: '' };
    const days = Math.round(((pct - done) / (100 / 7)) * 10) / 10 || 0;
    return { pct, offset: signed(days, `${days.toFixed(1)}d`) };
  }

  /**
   * Что показать: `null` — блока нет (нет ни одной из двух частей).
   *
   * `stale` — серый весь блок: данные старше `FRESH_DATA_MINUTES`, отметки нет
   * вовсе (поручиться за свежесть нечем) или последняя загрузка не удалась
   * (`failed`, значения — прошлые).
   */
  function usageView(data, nowSec, opts) {
    if (!data || typeof data !== 'object') return null;
    const obj = v => (v && typeof v === 'object' ? v : null);
    const five = obj(data.fiveHour);
    const week = obj(data.weekly);
    if (!five && !week) return null;
    const stamp = stampSec(data.updated_at);
    const stale = Boolean(opts && opts.failed)
      || stamp === null || nowSec - stamp > FRESH_DATA_MINUTES * 60;
    return {
      stale,
      fiveHour: five ? fiveHourView(five, nowSec) : null,
      week: week ? weekView(week, nowSec) : null,
    };
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  /**
   * Разметка блока. Красный offset — классом `hot`, и только на свежих
   * данных: серый блок значит «это прошлое», и тревога на прошлом не к месту.
   * Серость самого блока ставит страница классом на контейнере.
   */
  function usageHtml(view) {
    if (!view) return '';
    const off = (text, hot) => (text
      ? ` <span class="usage-off${hot && !view.stale ? ' hot' : ''}">${esc(text)}</span>` : '');
    const parts = [];
    if (view.fiveHour) {
      const f = view.fiveHour;
      parts.push(`5h: ${esc(f.pct)}%${off(f.offset, f.offsetHot)} ${esc(f.left)}`);
    }
    if (view.week) parts.push(`week: ${esc(view.week.pct)}%${off(view.week.offset, false)}`);
    return parts.join(' | ');
  }

  return { usageView, usageHtml, FRESH_DATA_MINUTES, HOT_MINUTES };
});
