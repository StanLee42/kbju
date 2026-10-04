// Добавление еды по фотографии: выбрать снимок, отправить в модель, проверить карточку,
// сохранить запись. Запись создаётся только по подтверждению — модель ничего не пишет сама.
import { createProvider, analyzeFood, describeError } from '../llm/index.js';
import { pickImage, prepareForApi, makeThumbnail } from '../media/image.js';
import { PORTION_PRESETS, portionFactor, portionNote, scaleItems, sumItems } from '../portion.js';
import { addEntry, loadThumb, saveThumb, store } from '../state.js';
import { DEFAULT_PRICES, logUsage, makeUsageRow } from '../usage.js';
import { h, num, nowTime, round } from '../util.js';
import { openSheet, toast } from './components/sheet.js';

const SOURCE_LABEL = { label: 'по таблице с упаковки', estimate: 'оценка по снимку' };
const CONFIDENCE_LABEL = { high: 'уверенно', medium: 'примерно', low: 'неуверенно' };

export function openPhotoSheet({ date = null, entry = null } = {}) {
  const settings = store.settings || {};
  const providerConfig = settings.provider || {};
  const targetDate = date || store.date;

  const state = {
    file: null,
    preview: null,
    analysis: null,
    error: null,
    busy: false,
    comment: '',
    portion: 'all',
    customGrams: null,
    items: [],
  };

  const host = h('div', {});
  const sheet = openSheet({ title: 'Еда по фотографии', content: host });

  const keyMissing = !providerConfig.key;

  function scaleFactor() {
    return portionFactor({
      portion: state.portion,
      customGrams: state.customGrams,
      items: state.items,
    });
  }

  function scaledTotals() {
    return sumItems(scaleItems(state.items, scaleFactor()));
  }

  // --- шаг 1: выбор снимка ---

  function renderChooser() {
    host.replaceChildren(
      h('p', { class: 'small muted' },
        'Снимите тарелку или упаковку. Лучше всего работает таблица пищевой ценности на упаковке: '
        + 'с неё значения берутся точно. По тарелке модель оценивает состав и вес на глаз.'),
      h('div', { class: 'chips' },
        h('button', {
          class: 'btn', type: 'button', text: '📷 Снять',
          onclick: () => choose({ camera: true }),
        }),
        h('button', {
          class: 'btn', type: 'button', text: '🖼 Из галереи',
          onclick: () => choose({ camera: false }),
        })),
      keyMissing
        ? h('p', { class: 'small', style: 'margin-top:14px;color:var(--over)' },
          'Сначала вставьте ключ провайдера в настройках — без него модель не сможет посмотреть снимок.')
        : null);
  }

  async function choose({ camera }) {
    const file = await pickImage({ camera });
    if (!file) return;
    state.error = null;
    state.analysis = null;
    try {
      state.file = file;
      state.preview = await prepareForApi(file);
      render();
    } catch (error) {
      state.error = { title: 'Снимок не удалось прочитать', hint: String(error.message || error), details: '' };
      render();
    }
  }

  // --- шаг 2: отправка ---

  async function analyze() {
    if (keyMissing) {
      toast('Вставьте ключ провайдера в настройках');
      return;
    }
    state.busy = true;
    state.error = null;
    render();

    const provider = createProvider({
      provider: providerConfig.id,
      providerKey: providerConfig.key,
      model: providerConfig.model,
    });
    const prices = settings.prices || DEFAULT_PRICES;
    const result = await analyzeFood({
      provider,
      image: { base64: state.preview.base64, mime: state.preview.mime },
      text: state.comment.trim() || null,
    });

    // Каждая попытка оплачивается, поэтому в журнал идут все, а не только удачная.
    let cost = 0;
    for (const usage of result.usages || []) {
      const row = makeUsageRow({
        kind: 'photo',
        model: providerConfig.model || 'deepseek-flash',
        usage,
        prices,
      });
      cost += row.cost;
      await logUsage(row).catch(() => {});
    }

    state.busy = false;

    if (!result.ok) {
      state.error = { ...describeError({ kind: result.error.kind, details: { body: result.error.details } }), ...result.error };
      render();
      return;
    }

    state.analysis = { ...result.data, cost };
    state.items = result.data.items.map((item) => ({ ...item }));
    if (result.data.basis === 'per_100g') {
      // Вес порции модель не знала — предлагаем уточнить его сразу.
      state.portion = 'all';
    }
    render();
  }

  // --- карточка результата ---

  function itemRow(item, index) {
    const field = (key, label, width) => h('label', { class: 'field', style: 'margin:0' },
      h('span', { class: 'field-label', text: label }),
      h('input', {
        type: key === 'name' ? 'text' : 'number',
        inputmode: key === 'name' ? undefined : 'decimal',
        value: item[key],
        style: width ? `width:${width}` : '',
        oninput: (event) => {
          item[key] = key === 'name' ? event.target.value : num(event.target.value);
          updateTotals();
        },
      }));

    return h('div', { style: 'padding:10px 0;border-bottom:1px solid var(--line)' },
      field('name', 'Позиция'),
      h('div', { class: 'grid-4', style: 'margin-top:8px' },
        field('grams', 'Граммы'),
        field('kcal', 'Ккал'),
        field('protein', 'Б'),
        field('fat', 'Ж')),
      h('div', { class: 'grid-4', style: 'margin-top:8px' },
        field('carbs', 'У'),
        h('div', {}),
        h('div', {}),
        h('button', {
          class: 'btn btn-small btn-ghost', type: 'button', text: 'Убрать',
          onclick: () => {
            state.items.splice(index, 1);
            render();
          },
        })));
  }

  const totalsNode = h('div', { class: 'small', style: 'margin-top:12px' });

  function updateTotals() {
    const totals = scaledTotals();
    const factor = scaleFactor();
    totalsNode.replaceChildren(
      h('div', {},
        h('b', { text: `${round(totals.kcal)} ккал` }),
        ` · Б ${round(totals.protein)} · Ж ${round(totals.fat)} · У ${round(totals.carbs)}`),
      h('div', { class: 'tiny faint', style: 'margin-top:4px' },
        `Вес порции ${round(totals.grams)} г`
        + (factor === 1 ? '' : ` (множитель ×${round(factor, 2)})`)));
  }

  function renderCard() {
    const analysis = state.analysis;
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
            updateTotals();
          },
        }))
      : null;

    host.replaceChildren(
      state.preview
        ? h('img', {
          src: `data:${state.preview.mime};base64,${state.preview.base64}`,
          alt: 'снимок',
          style: 'width:100%;border-radius:12px;margin-bottom:12px;max-height:240px;object-fit:cover',
        })
        : null,
      h('div', { class: 'small' },
        h('b', { text: analysis.dish }),
        h('div', { class: 'tiny faint', style: 'margin-top:2px' },
          `${SOURCE_LABEL[analysis.source] || analysis.source}`
          + ` · ${CONFIDENCE_LABEL[analysis.confidence] || analysis.confidence}`
          + (analysis.source === 'label' ? ' · значения взяты из таблицы на упаковке' : ''))),
      h('h3', { class: 'card-title', style: 'margin-top:14px' }, 'Сколько съедено'),
      portionRow,
      customInput,
      h('h3', { class: 'card-title', style: 'margin-top:16px' }, 'Позиции — можно править'),
      h('div', {}, state.items.map((item, index) => itemRow(item, index))),
      totalsNode,
      analysis.assumptions
        ? h('p', { class: 'tiny faint', style: 'margin-top:10px' }, `Что учтено: ${analysis.assumptions}`)
        : null,
      h('div', { class: 'chips', style: 'margin-top:16px' },
        h('button', { class: 'btn-primary', type: 'button', text: 'Сохранить в дневник', onclick: save }),
        h('button', {
          class: 'btn btn-small', type: 'button', text: 'Переснять',
          onclick: () => {
            state.file = null;
            state.preview = null;
            state.analysis = null;
            state.items = [];
            render();
          },
        })),
      h('p', { class: 'tiny faint', style: 'margin-top:8px' },
        `Стоимость этого разбора: ${(analysis.cost || 0).toFixed(5)} $ (оценка)`));

    updateTotals();
  }

  async function save() {
    if (!state.items.length) {
      toast('Нет ни одной позиции');
      return;
    }
    const factor = scaleFactor();
    const items = scaleItems(state.items, factor);
    const totals = sumItems(items);

    let thumbId = null;
    try {
      if (state.file) {
        const thumb = await makeThumbnail(state.file);
        thumbId = await saveThumb(thumb);
      }
    } catch {
      // Без превью запись всё равно сохраняем: картинка не важнее данных.
    }

    const note = portionNote({ portion: state.portion, factor, grams: totals.grams });

    await addEntry({
      date: targetDate,
      time: nowTime(),
      name: state.analysis.dish,
      grams: round(totals.grams, 1),
      kcal: round(totals.kcal, 1),
      protein: round(totals.protein, 1),
      fat: round(totals.fat, 1),
      carbs: round(totals.carbs, 1),
      comment: state.comment.trim(),
      source: 'photo',
      items,
      thumbId,
      basis: state.analysis.basis,
      confidence: state.analysis.confidence,
      assumptions: state.analysis.assumptions,
      portionNote: note,
      cost: state.analysis.cost,
    });

    toast('Записано');
    sheet.close();
  }

  // --- предпросмотр перед отправкой ---

  function renderPreview() {
    host.replaceChildren(
      h('img', {
        src: `data:${state.preview.mime};base64,${state.preview.base64}`,
        alt: 'снимок',
        style: 'width:100%;border-radius:12px;margin-bottom:12px;max-height:240px;object-fit:cover',
      }),
      state.busy
        ? h('p', { class: 'small muted' }, 'Модель смотрит снимок…')
        : h('label', { class: 'field' },
          h('span', { class: 'field-label', text: 'Пояснение, необязательно' }),
          h('input', {
            type: 'text', value: state.comment,
            placeholder: 'например: это половина порции, без соуса',
            oninput: (event) => { state.comment = event.target.value; },
          })),
      h('div', { class: 'chips', style: 'margin-top:14px' },
        h('button', {
          class: 'btn-primary', type: 'button', text: 'Посчитать',
          disabled: state.busy, onclick: analyze,
        }),
        h('button', {
          class: 'btn btn-small', type: 'button', text: 'Другой снимок',
          onclick: () => {
            state.file = null;
            state.preview = null;
            render();
          },
        })),
      h('p', { class: 'tiny faint', style: 'margin-top:10px' },
        'Снимок уходит провайдеру уменьшенным и без метаданных съёмки. '
        + 'Запись появится в дневнике только после подтверждения.'));
  }

  function renderError() {
    host.replaceChildren(
      h('div', { class: 'card', style: 'border-color:var(--over)' },
        h('h3', { class: 'card-title', style: 'color:var(--over)' }, state.error.title || 'Не получилось'),
        h('p', { class: 'small muted' }, state.error.hint || ''),
        state.error.details
          ? h('pre', { class: 'tiny faint', style: 'white-space:pre-wrap;margin-top:8px' }, String(state.error.details))
          : null),
      h('div', { class: 'chips' },
        state.preview
          ? h('button', { class: 'btn-primary', type: 'button', text: 'Повторить', onclick: analyze })
          : null,
        h('button', {
          class: 'btn', type: 'button', text: 'Выбрать другой снимок',
          onclick: () => {
            state.file = null;
            state.preview = null;
            state.error = null;
            render();
          },
        })));
  }

  function render() {
    if (state.error) { renderError(); return; }
    if (state.analysis) { renderCard(); return; }
    if (state.preview) { renderPreview(); return; }
    renderChooser();
  }

  render();
  return sheet;
}

/** Открывает карточку существующей записи из фотографии: превью и позиции. */
export async function openPhotoEntrySheet(entry) {
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

  return openSheet({
    title: entry.name,
    content,
    onClose: () => {
      if (url) URL.revokeObjectURL(url);
    },
  });
}
