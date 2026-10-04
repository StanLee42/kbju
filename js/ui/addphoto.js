// Добавление еды по фотографии: выбрать снимок, отправить в модель, проверить карточку,
// сохранить запись. Запись создаётся только по подтверждению — модель ничего не пишет сама.
import { createProvider, analyzeFood, describeError } from '../llm/index.js';
import { pickImage, prepareForApi, makeThumbnail } from '../media/image.js';
import { addEntry, saveThumb, store } from '../state.js';
import { DEFAULT_PRICES, logUsage, makeUsageRow } from '../usage.js';
import { h, nowTime, round } from '../util.js';
import { openSheet, toast } from './components/sheet.js';
import { createResultCard } from './result-card.js';

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
    card: null,
  };

  const host = h('div', {});
  const sheet = openSheet({ title: 'Еда по фотографии', content: host });

  const keyMissing = !providerConfig.key;

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
    // Новый разбор — новая карточка: старая осталась бы от прошлого снимка.
    state.card = null;
    render();
  }

  // --- карточка результата ---

  function renderCard() {
    // Разбор фотографии показываем той же карточкой, что и сказанное вслух: правки
    // в ней живут в одном месте, а запись в дневник получается одинаковой.
    if (!state.card) {
      state.card = createResultCard({
        analysis: state.analysis,
        items: state.analysis.items,
        origin: 'photo',
        head: state.preview
          ? h('img', {
            src: `data:${state.preview.mime};base64,${state.preview.base64}`,
            alt: 'снимок',
            style: 'width:100%;border-radius:12px;margin-bottom:12px;max-height:240px;object-fit:cover',
          })
          : null,
        retryLabel: 'Переснять',
        onRetry: () => {
          state.file = null;
          state.preview = null;
          state.analysis = null;
          state.card = null;
          render();
        },
        onSave: save,
      });
    }
    host.replaceChildren(state.card.element);
  }

  async function save({ items, totals, portionNote: note }) {
    let thumbId = null;
    try {
      if (state.file) {
        const thumb = await makeThumbnail(state.file);
        thumbId = await saveThumb(thumb);
      }
    } catch {
      // Без превью запись всё равно сохраняем: картинка не важнее данных.
    }

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
