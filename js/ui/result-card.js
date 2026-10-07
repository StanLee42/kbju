// Карточка разбора: разговор про еду и разбор снимка приводят к одному и тому же —
// название блюда, позиции с числами, выбор «сколько съедено», итог и сохранение в дневник.
//
// Живёт отдельно, потому что иначе правки в ней пришлось бы повторять в двух местах,
// а расхождение между разговором и снимком в дневнике выглядело бы как ошибка.
import { PORTION_PRESETS, portionFactor, portionNote, scaleItems, sumItems } from '../portion.js';
import { fill, h, num, round } from '../util.js';
import { addEntry, deleteEntry, loadThumb } from '../state.js';
import { splitEntry } from '../merge.js';
import { openSheet, toast } from './components/sheet.js';

const CONFIDENCE_LABEL = { high: 'уверенно', medium: 'примерно', low: 'неуверенно' };

/** Источник чисел называется по-разному: у снимка одна подпись, у слов человека другая. */
const SOURCE_LABEL = {
  photo: { label: 'по таблице с упаковки', estimate: 'оценка по снимку' },
  chat: { label: 'по таблице с упаковки', estimate: 'оценка по сказанному' },
};

function sourceLine(analysis, origin) {
  const labels = SOURCE_LABEL[origin] || SOURCE_LABEL.photo;
  return `${labels[analysis.source] || analysis.source}`
    + ` · ${CONFIDENCE_LABEL[analysis.confidence] || analysis.confidence}`
    + (analysis.source === 'label' ? ' · значения взяты из таблицы на упаковке' : '');
}

/**
 * Собирает карточку с правкой позиций и выбором порции.
 *
 * @param {object} options
 * @param {object} options.analysis разобранный ответ модели
 * @param {Array} options.items позиции (карточка их меняет)
 * @param {Node|null} options.head верхний блок: снимок у фото, расшифровка у голоса
 * @param {string} options.origin 'photo' | 'chat' — как подписывать источник чисел
 * @param {string} options.retryLabel как называется кнопка возврата к вводу
 * @param {Function} options.onRetry
 * @param {Function|null} options.onSave получает готовые к записи позиции, множитель и итог;
 *   если не передан, кнопки сохранения в карточке нет
 * @param {Function} options.onChange сообщает текущие значения после каждой правки:
 *   по ним показывается черновик, пока разговор продолжается
 * @returns {{element: Node}}
 */
export function createResultCard({
  analysis, items, head = null, origin = 'photo',
  retryLabel = 'Другой снимок', onRetry = null, onSave, onChange = null,
}) {
  const state = {
    items: (items || []).map((item) => ({ ...item })),
    portion: 'all',
    customGrams: null,
  };

  const totalsNode = h('div', { class: 'small', style: 'margin-top:12px' });
  const body = h('div', {});
  const element = h('div', {}, head, body);

  const factor = () => portionFactor({
    portion: state.portion,
    customGrams: state.customGrams,
    items: state.items,
  });

  const scaledItems = () => scaleItems(state.items, factor());
  const scaledTotals = () => sumItems(scaledItems());

  /** Текущие значения карточки: и для строки итогов, и для того, кто её показывает. */
  function currentValues() {
    const value = factor();
    const totals = scaledTotals();
    return {
      items: scaledItems(),
      totals,
      factor: value,
      portion: state.portion,
      portionNote: portionNote({ portion: state.portion, factor: value, grams: totals.grams }),
    };
  }

  function renderTotals() {
    const totals = scaledTotals();
    const value = factor();
    if (onChange) onChange(currentValues());
    fill(totalsNode, 
      h('div', {},
        h('b', { text: `${round(totals.kcal)} ккал` }),
        ` · Б ${round(totals.protein)} · Ж ${round(totals.fat)} · У ${round(totals.carbs)}`),
      h('div', { class: 'small faint', style: 'margin-top:4px' },
        `Вес порции ${round(totals.grams)} г`
        + (value === 1 ? '' : ` (множитель ×${round(value, 2)})`)));
  }

  function itemRow(item, index) {
    const field = (key, label) => h('label', { class: 'field field-compact', style: 'margin:0' },
      h('span', { class: 'field-label', text: label }),
      h('input', {
        type: key === 'name' ? 'text' : 'number',
        spellcheck: false,
        inputmode: key === 'name' ? undefined : 'decimal',
        value: item[key],
        oninput: (event) => {
          item[key] = key === 'name' ? event.target.value : num(event.target.value);
          renderTotals();
        },
      }));

    return h('div', { style: 'padding:10px 0;border-bottom:1px solid var(--line)' },
      field('name', 'Позиция'),
      // Пять чисел в один ряд: окошки получаются узкими и по делу, а не полэкрана на каждое.
      h('div', { class: 'grid-5', style: 'margin-top:8px' },
        field('grams', 'Граммы'),
        field('kcal', 'Ккал'),
        field('protein', 'Б'),
        field('fat', 'Ж'),
        field('carbs', 'У')),
      h('div', { class: 'chips', style: 'margin-top:8px' },
        h('button', {
          class: 'btn btn-small btn-ghost', type: 'button', text: 'Убрать позицию',
          onclick: () => {
            state.items.splice(index, 1);
            render();
          },
        })));
  }

  function render() {
    const portionRow = h('div', { class: 'portion-row' },
      [...PORTION_PRESETS, { id: 'custom', label: 'Свои граммы' }].map((choice) => h('button', {
        type: 'button',
        text: choice.label,
        'aria-pressed': String(state.portion === choice.id),
        onclick: () => {
          state.portion = choice.id;
          render();
        },
      })));

    const customInput = state.portion === 'custom'
      ? h('label', { class: 'field', style: 'margin-top:10px' },
        h('span', { class: 'field-label', text: 'Сколько съедено, граммов' }),
        h('input', {
          type: 'number', inputmode: 'decimal', value: state.customGrams ?? '',
          oninput: (event) => {
            state.customGrams = event.target.value;
            renderTotals();
          },
        }))
      : null;

    fill(body, 
      h('div', { class: 'small' },
        h('b', { text: analysis.dish }),
        h('div', { class: 'small faint', style: 'margin-top:2px' }, sourceLine(analysis, origin))),
      h('h3', { class: 'card-title', style: 'margin-top:14px' }, 'Сколько съедено'),
      portionRow,
      customInput,
      h('h3', { class: 'card-title', style: 'margin-top:16px' }, 'Позиции — можно править'),
      h('div', {}, state.items.map((item, index) => itemRow(item, index))),
      totalsNode,
      analysis.assumptions
        ? h('p', { class: 'small faint', style: 'margin-top:10px' }, `Что учтено: ${analysis.assumptions}`)
        : null,
      onSave || onRetry
        ? h('div', { class: 'chips', style: 'margin-top:16px' },
          // Кнопка сохранения показывается только тем, кто её просил: в разговоре
          // сохраняет полоса с черновиком, и второй кнопки быть не должно.
          onSave
            ? h('button', {
              class: 'btn-primary', type: 'button', text: 'Сохранить в дневник',
              onclick: () => {
                if (!state.items.length) {
                  toast('Нет ни одной позиции');
                  return;
                }
                onSave(currentValues());
              },
            })
            : null,
          onRetry
            ? h('button', { class: 'btn btn-small', type: 'button', text: retryLabel, onclick: onRetry })
            : null)
        : null,
      h('p', { class: 'small faint', style: 'margin-top:8px' },
        `Стоимость этого разбора: ${(analysis.cost || 0).toFixed(5)} $ (оценка)`));

    renderTotals();
  }

  render();
  return { element };
}

/**
 * Показывает уже сохранённую запись: позиции и то, что модель учла, и даёт её удалить.
 * Снимок показывается, если он был: у записи из слов его нет.
 */
export async function openEntryDetails(entry) {
  const thumb = entry.thumbId ? await loadThumb(entry.thumbId).catch(() => null) : null;
  const items = entry.items || [];
  const url = thumb ? URL.createObjectURL(thumb) : null;

  const content = h('div', {},
    url
      ? h('img', {
        src: url,
        alt: 'снимок',
        style: 'width:100%;border-radius:12px;margin-bottom:12px;max-height:240px;object-fit:cover',
      })
      : null,
    items.length
      ? h('div', {}, items.map((item) => h('div', {
        style: 'padding:8px 0;border-bottom:1px solid var(--line)',
      },
      h('div', { class: 'small' }, `${item.name} — ${round(item.grams)} г`),
      h('div', { class: 'tiny faint' },
        `${round(item.kcal)} ккал · Б ${round(item.protein)} · Ж ${round(item.fat)} · У ${round(item.carbs)}`))))
      : h('p', { class: 'small muted' }, 'Позиции не сохранились, есть только итог.'),
    entry.assumptions
      ? h('p', { class: 'tiny faint', style: 'margin-top:10px' }, `Что учтено: ${entry.assumptions}`)
      : null,
    entry.confidence
      ? h('p', { class: 'tiny faint' }, `Уверенность модели: ${CONFIDENCE_LABEL[entry.confidence] || entry.confidence}`)
      : null);

  // Разбор на составляющие: приём пищи распадается на отдельные позиции. Нужно, чтобы
  // посмотреть, какая именно позиция тянет день в перебор.
  const actions = [];
  if (items.length >= 2) {
    actions.push(h('button', {
      class: 'btn btn-small', type: 'button', text: 'Разделить на составляющие',
      onclick: async () => {
        const parts = splitEntry(entry);
        if (!parts.length) {
          toast('Разделять нечего');
          return;
        }
        await deleteEntry(entry.id);
        for (const part of parts) await addEntry(part);
        toast(`Разделено на ${parts.length} позиции`);
        sheet.close();
      },
    }));
  }

  // Удаление спрашивает подтверждение вторым нажатием: запись в дневнике не должна
  // пропадать от одного случайного касания.
  let armed = false;
  const remove = h('button', {
    class: 'btn btn-small btn-danger', type: 'button', text: 'Удалить запись',
    onclick: async () => {
      if (!armed) {
        armed = true;
        remove.textContent = 'Нажмите ещё раз, чтобы удалить';
        return;
      }
      await deleteEntry(entry.id);
      toast('Запись удалена');
      sheet.close();
    },
  });

  const sheet = openSheet({
    title: entry.name,
    content: h('div', {}, content, h('div', { class: 'chips', style: 'margin-top:16px' }, remove, ...actions)),
    onClose: () => {
      if (url) URL.revokeObjectURL(url);
    },
  });
  return sheet;
}
