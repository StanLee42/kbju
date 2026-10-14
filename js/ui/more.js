// Раздел «Ещё»: три входа в то, что не помещается в четыре основных экрана.
//
// Здесь только настройки, расход и хранилище. Список намеренно короткий: раздел, в который
// сваливают всё подряд, перестаёт помогать. Настройки остаются отдельным экраном, потому что
// внутри них семь карточек, и в один ряд они не помещаются.
import { h } from '../util.js';

const ROWS = [
  {
    title: 'Настройки',
    note: 'Провайдер, нормы, типы дней, расписание, цель и темп, версия',
    path: '#/settings',
  },
  {
    title: 'Расход',
    note: 'Журнал запросов к модели, прогноз на месяц, бюджет и остаток на счету',
    path: '#/usage',
  },
  {
    title: 'Хранилище',
    note: 'Сколько занято, постоянное хранилище, удаление всех данных',
    path: '#/storage',
  },
];

export function mount(container) {
  const list = h('section', { class: 'card' },
    ROWS.map((row) => h('button', {
      class: 'nav-row', type: 'button',
      onclick: () => { location.hash = row.path; },
    },
    h('span', { class: 'grow' },
      h('span', { class: 'nav-row-title', text: row.title }),
      h('span', { class: 'nav-row-note', text: row.note })),
    h('span', { class: 'nav-row-arrow', text: '›' }))));

  container.append(
    h('h1', { text: 'Ещё', style: 'margin-bottom:12px' }),
    list,
  );

  return { destroy() {} };
}
