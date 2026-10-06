// Календарь: месяц клетками, с отметками съеденного. Нужен, чтобы посмотреть прошедшие дни
// и вернуться в любой из них — записи, нормы и правки там те же, что и на экране «Сегодня».
import { WEEKDAY_SHORT, monthGrid, monthStart, monthTitle, shiftMonth, totalsByDay } from '../calendar.js';
import * as db from '../db.js';
import { loadDay, store } from '../state.js';
import { fill, h, round, todayISO } from '../util.js';

export function mount(container) {
  const currentMonth = monthStart(todayISO());
  let month = monthStart(store.date || todayISO());
  let byDay = {};

  const title = h('div', { class: 'cal-title' });
  const back = h('div', { class: 'chips', style: 'justify-content:center;margin-top:8px' });
  const grid = h('div', { class: 'cal-grid' });

  container.append(
    h('h1', { text: 'Календарь' }),
    h('section', { class: 'card' },
      h('div', { class: 'cal-head' },
        h('button', {
          class: 'btn btn-small', type: 'button', text: '‹', 'aria-label': 'предыдущий месяц',
          onclick: () => { month = shiftMonth(month, -1); render(); },
        }),
        title,
        h('button', {
          class: 'btn btn-small', type: 'button', text: '›', 'aria-label': 'следующий месяц',
          onclick: () => { month = shiftMonth(month, 1); render(); },
        })),
      back,
      h('div', { class: 'cal-weekdays' }, WEEKDAY_SHORT.map((day) => h('div', { text: day }))),
      grid),
    h('p', { class: 'tiny faint' },
      'Нажмите день, чтобы открыть его записи. Число под днём — сколько за этот день съедено.'));

  /** Открывает день: он показывается тем же экраном, что и сегодняшний. */
  async function openDay(iso) {
    await loadDay(iso);
    location.hash = '#/today';
  }

  function render() {
    title.textContent = monthTitle(month);
    fill(back, month === currentMonth
      ? null
      : h('button', {
        class: 'btn btn-small', type: 'button', text: 'К текущему месяцу',
        onclick: () => { month = currentMonth; render(); },
      }));

    const { weeks } = monthGrid(month, { today: todayISO() });
    fill(grid, weeks.flat().map((cell) => {
      const totals = byDay[cell.iso];
      const selected = cell.iso === store.date;
      return h('button', {
        class: 'cal-day',
        type: 'button',
        dataset: { out: cell.inMonth ? '0' : '1', today: cell.isToday ? '1' : '0' },
        'aria-pressed': String(selected),
        onclick: () => openDay(cell.iso),
      },
      h('span', { class: 'cal-num', text: String(cell.day) }),
      totals ? h('span', { class: 'cal-kcal', text: String(Math.round(totals.kcal)) }) : null);
    }));
  }

  // Суммы берём по всем записям сразу: их немного, а листать месяцы после этого быстро.
  db.all('entries')
    .then((entries) => { byDay = totalsByDay(entries); })
    .catch(() => {})
    .finally(render);

  render();
  return { destroy() {} };
}
