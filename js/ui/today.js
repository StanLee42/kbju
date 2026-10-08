// Экран дня: плашка типа дня, полоски по показателям, лента записей с итогом и режим объединения.
import { MACROS, byTimeAscending, dayTypeById, remaining, resolveDayTypeId } from '../norm.js';
import { fill, formatDateHuman, formatTime, h, plural, round, todayISO, weekdayFull } from '../util.js';
import { createBar } from './components/bar.js';
import { toast } from './components/sheet.js';
import { addEntry, deleteEntry, loadDay, store, setDayTypeOverride, subscribe } from '../state.js';
import { mergeEntries } from '../merge.js';
import { openAddSheet } from './add.js';
import { openEntryDetails } from './result-card.js';

const PORTION_LABEL = { small: 'маленькая порция', normal: '', large: 'большая порция' };

export function mount(container) {
  const title = h('h1', { text: 'Сегодня' });
  const subtitle = h('div', { class: 'muted small' });
  const source = h('div', { class: 'tiny faint', style: 'margin-top:2px' });
  const dayRow = h('div', { class: 'day-badge-row', style: 'margin-top:10px' });
  const dayChoice = h('div', { class: 'chips', style: 'margin-top:8px', hidden: true });

  const bars = MACROS.map((macro) => createBar({ label: macro.label, color: macro.color, unit: macro.unit }));

  const feed = h('div', {});
  const totalLine = h('div', { class: 'total-line' });

  const barsCard = h('section', { class: 'card' }, bars.map((bar) => bar.element));

  // Отметка записей для объединения: включён ли режим и что отмечено.
  const selection = { active: false, ids: new Set() };
  const feedHead = h('div', { class: 'feed-head' });
  const mergeBar = h('div', { class: 'merge-bar' });

  const feedCard = h('section', { class: 'card' },
    feedHead,
    feed,
    mergeBar,
    totalLine);

  container.append(
    h('header', { class: 'dayhead' }, title, subtitle, dayRow, dayChoice, source),
    // Круговых диаграмм здесь больше нет: они повторяли полоски и путали числами.
    // Полоски ниже показывают норму, съеденное, остаток и перебор — этого достаточно.
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
        text: active.name,
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
      class: 'badge badge-option',
      type: 'button',
      text: type.name,
      'aria-pressed': String(type.id === activeId),
      onclick: () => setDayTypeOverride(date, type.id),
    })));
  }

  /** Выход из режима отметки: он не должен переживать смену дня или уход с экрана. */
  function stopSelection() {
    selection.active = false;
    selection.ids.clear();
  }

  /** Объединяет отмеченные записи в одну: суммы складываются, время — от самой ранней. */
  async function mergeSelected() {
    const entries = byTimeAscending(store.entries);
    const chosen = entries.filter((entry) => selection.ids.has(entry.id));
    if (chosen.length < 2) {
      toast('Отметьте хотя бы две записи');
      return;
    }

    const merged = mergeEntries(chosen);
    if (!merged) return;

    // Сначала убираем строки, потом записываем объединённую: так дневник не покажет
    // на мгновение и старое, и новое.
    for (const entry of chosen) await deleteEntry(entry.id);
    await addEntry(merged);

    stopSelection();
    toast(`Объединено записей: ${chosen.length}`);
    renderFeed();
  }

  function renderFeedHead(entries) {
    fill(feedHead,
      h('h2', { class: 'card-title', style: 'margin:0' }, 'Что съедено'),
      selection.active
        ? h('button', {
          class: 'btn btn-small', type: 'button', text: 'Отмена',
          onclick: () => {
            stopSelection();
            renderFeed();
          },
        })
        : (entries.length >= 2
          ? h('button', {
            class: 'btn btn-small', type: 'button', text: 'Объединить',
            onclick: () => {
              selection.active = true;
              selection.ids.clear();
              renderFeed();
            },
          })
          : null));
  }

  function renderMergeBar() {
    if (!selection.active) {
      fill(mergeBar);
      return;
    }
    fill(mergeBar,
      h('div', { class: 'small muted', text: `Отмечено: ${selection.ids.size}` }),
      h('button', {
        class: 'btn-primary draft-save', type: 'button', text: 'Объединить отмеченные',
        disabled: selection.ids.size < 2,
        onclick: mergeSelected,
      }));
  }

  function renderFeed() {
    const entries = byTimeAscending(store.entries);
    if (!entries.length) {
      fill(feedHead, h('h2', { class: 'card-title', style: 'margin:0' }, 'Что съедено'));
      fill(feed, h('div', { class: 'empty' },
        'Пока пусто. Нажмите «Добавить» внизу, чтобы записать еду.'));
      fill(mergeBar);
      totalLine.textContent = '';
      return;
    }
    renderFeedHead(entries);
    renderMergeBar();

    fill(feed, ...entries.map((entry) => {
      const portion = PORTION_LABEL[entry.portion] || '';
      const sub = [entry.grams ? `${round(entry.grams)} г` : '', portion, entry.portionNote]
        .filter(Boolean).join(' · ');
      const marked = selection.ids.has(entry.id);
      // В режиме отметки касание выбирает запись для объединения, а не открывает её.
      const open = () => {
        if (selection.active) {
          if (marked) selection.ids.delete(entry.id);
          else selection.ids.add(entry.id);
          renderFeed();
          return;
        }
        if (['photo', 'chat', 'merged'].includes(entry.source) && entry.items?.length) openEntryDetails(entry);
        else openAddSheet({ entry });
      };
      return h('div', {
        class: `entry${marked ? ' entry-marked' : ''}`,
        'aria-pressed': String(marked),
        onclick: open,
      },
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
