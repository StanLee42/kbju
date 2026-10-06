// Экран «Сегодня»: кольца, полоски, лента записей, переключатель типа дня.
import { MACROS, byTimeAscending, dayTypeById, remaining, resolveDayTypeId } from '../norm.js';
import { fill, formatDateHuman, formatTime, h, plural, round, todayISO, weekdayFull } from '../util.js';
import { createBar } from './components/bar.js';
import { createRing } from './components/ring.js';
import { loadDay, store, setDayTypeOverride, subscribe } from '../state.js';
import { openAddSheet } from './add.js';
import { openEntryDetails } from './result-card.js';

const PORTION_LABEL = { small: 'маленькая порция', normal: '', large: 'большая порция' };

export function mount(container) {
  const title = h('h1', { text: 'Сегодня' });
  const subtitle = h('div', { class: 'muted small' });
  const source = h('div', { class: 'tiny faint', style: 'margin-top:2px' });
  const dayRow = h('div', { class: 'day-badge-row', style: 'margin-top:10px' });
  const dayChoice = h('div', { class: 'chips', style: 'margin-top:8px', hidden: true });

  const kcalRing = createRing({ size: 154, stroke: 13, color: 'var(--kcal)' });
  const macroRings = MACROS.slice(1).map((macro) => createRing({
    size: 78, stroke: 8, color: macro.color, mini: true,
  }));

  const bars = MACROS.map((macro) => createBar({ label: macro.label, color: macro.color, unit: macro.unit }));

  const feed = h('div', {});
  const totalLine = h('div', { class: 'total-line' });

  const ringsCard = h('section', { class: 'card' },
    h('div', { class: 'rings' },
      kcalRing.element,
      h('div', { class: 'rings-small' }, macroRings.map((ring) => ring.element))));

  const barsCard = h('section', { class: 'card' }, bars.map((bar) => bar.element));

  const feedCard = h('section', { class: 'card' },
    h('h2', { class: 'card-title', text: 'Что съедено' }),
    feed,
    totalLine);

  container.append(
    h('header', { class: 'dayhead' }, title, subtitle, dayRow, dayChoice, source),
    ringsCard,
    barsCard,
    feedCard,
  );

  /**
   * Тип дня показываем одной плашкой: раньше рядом висели оба типа, и было непонятно,
   * какой из них текущий. Смена типа — по нажатию на плашку.
   */
  function renderDayType() {
    const { settings, date } = store;
    const activeId = resolveDayTypeId(date, settings);
    const active = dayTypeById(settings, activeId);
    const isToday = date === todayISO();

    dayChoice.hidden = true;
    fill(dayRow,
      h('button', {
        class: 'badge badge-day', type: 'button',
        text: `${active.name} · сменить`,
        'aria-expanded': 'false',
        onclick: (event) => {
          dayChoice.hidden = !dayChoice.hidden;
          event.currentTarget.setAttribute('aria-expanded', String(!dayChoice.hidden));
        },
      }),
      isToday
        ? null
        : h('button', {
          class: 'badge', type: 'button', text: 'Вернуться к сегодня',
          onclick: () => loadDay(todayISO()),
        }));

    fill(dayChoice, ...(settings.dayTypes || []).map((type) => h('button', {
      type: 'button',
      text: type.name,
      'aria-pressed': String(type.id === activeId),
      onclick: () => setDayTypeOverride(date, type.id),
    })));
  }

  function renderFeed() {
    const entries = byTimeAscending(store.entries);
    if (!entries.length) {
      fill(feed, h('div', { class: 'empty' },
        'Пока пусто. Нажмите «Добавить» внизу, чтобы записать еду.'));
      totalLine.textContent = '';
      return;
    }

    fill(feed, ...entries.map((entry) => {
      const portion = PORTION_LABEL[entry.portion] || '';
      const sub = [entry.grams ? `${round(entry.grams)} г` : '', portion, entry.portionNote]
        .filter(Boolean).join(' · ');
      // Записи с разбором открываются позициями, ручные — формой правки.
      const open = () => (['photo', 'chat'].includes(entry.source) && entry.items?.length
        ? openEntryDetails(entry)
        : openAddSheet({ entry }));
      return h('div', { class: 'entry', onclick: open },
        h('div', { class: 'entry-time', text: formatTime(entry.time) }),
        h('div', { class: 'grow' },
          h('div', { class: 'entry-name', text: entry.name }),
          h('div', { class: 'entry-sub nowrap', text: [sub, entry.comment].filter(Boolean).join(' · ') }),
          h('div', { class: 'entry-macros' },
            `Б ${round(entry.protein)} · Ж ${round(entry.fat)} · У ${round(entry.carbs)}`)),
        h('div', { class: 'nowrap' },
          h('div', { class: 'mono', text: `${round(entry.kcal)}` }),
          h('div', { class: 'tiny faint', text: 'ккал' })),
      );
    }));
  }

  function update() {
    if (!store.ready) return;
    const { date, settings } = store;
    const norm = dayTypeById(settings, resolveDayTypeId(date, settings));
    const totals = store.entries.reduce((acc, entry) => {
      acc.kcal += Number(entry.kcal) || 0;
      acc.protein += Number(entry.protein) || 0;
      acc.fat += Number(entry.fat) || 0;
      acc.carbs += Number(entry.carbs) || 0;
      return acc;
    }, { kcal: 0, protein: 0, fat: 0, carbs: 0 });

    const left = remaining(norm, totals);
    const isToday = date === todayISO();

    title.textContent = isToday ? 'Сегодня' : formatDateHuman(date);
    subtitle.textContent = `${weekdayFull(date)}, ${formatDateHuman(date)}${isToday ? '' : ` · ${date}`}`;
    source.textContent = `норма дня: ${round(norm.kcal)} ккал · Б ${round(norm.protein)} / Ж ${round(norm.fat)} / У ${round(norm.carbs)}`;

    kcalRing.update({
      value: totals.kcal,
      max: norm.kcal,
      caption: left.kcal >= 0
        ? `осталось ${round(left.kcal)}`
        : `перебор ${Math.abs(round(left.kcal))}`,
    });

    MACROS.slice(1).forEach((macro, index) => {
      const macroLeft = left[macro.key];
      macroRings[index].update({
        value: totals[macro.key],
        max: norm[macro.key],
        unit: 'г',
        caption: macroLeft >= 0 ? `${round(macroLeft)} г` : `+${Math.abs(round(macroLeft))}`,
      });
    });

    bars.forEach((bar, index) => {
      const macro = MACROS[index];
      bar.update({ value: totals[macro.key], max: norm[macro.key] });
    });

    renderDayType();
    renderFeed();

    if (store.entries.length) {
      const entriesWord = plural(store.entries.length, 'запись', 'записи', 'записей');
      fill(totalLine, 
        h('span', { class: 'muted', text: `Итого за день · ${store.entries.length} ${entriesWord}` }),
        h('span', {},
          h('b', { text: `${round(totals.kcal)} ккал` }),
          ` · Б ${round(totals.protein)} · Ж ${round(totals.fat)} · У ${round(totals.carbs)}`));
    }
  }

  const unsubscribe = subscribe(update);
  update();

  return {
    destroy: unsubscribe,
  };
}
