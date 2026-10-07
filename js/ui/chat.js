// Добавление еды разговором: мини-чат, в котором человек пишет словами, прикладывает снимки,
// отвечает на уточняющие вопросы модели, а записать блюдо в дневник может в любой момент.
//
// Два правила, из которых следует всё остальное:
// 1. Текущий разбор виден всегда — он показан отдельной полосой над полем ввода, а не только
//    последним сообщением: разговор можно листать, а числа остаются перед глазами.
// 2. Запись в дневник — только по кнопке. Разговор сам ничего не сохраняет.
import { analyzeChat, createProvider, describeError } from '../llm/index.js';
import { makeThumbnail } from '../media/image.js';
import { addEntry, saveThumb, store } from '../state.js';
import { sumItems } from '../portion.js';
import { DEFAULT_PRICES, logUsage, makeUsageRow } from '../usage.js';
import { fill, h, nowTime, round } from '../util.js';
import { createComposer } from './components/composer.js';
import { openSheet, toast } from './components/sheet.js';
import { createResultCard } from './result-card.js';

export function openChatSheet({ date = null } = {}) {
  const settings = store.settings || {};
  const providerConfig = settings.provider || {};
  const targetDate = date || store.date;
  const keyMissing = !providerConfig.key;

  const state = {
    messages: [], // { role, text, photo, analysis, error }
    draft: null, // последний разбор: уходит модели следующим сообщением
    current: null, // текущие значения: позиции, итог, множитель (их и записываем)
    cost: 0,
  };

  const thread = h('div', { class: 'thread' });
  const draftBar = h('div', { class: 'draft-bar', hidden: true });
  const host = h('div', {}, thread, draftBar);
  const sheet = openSheet({ title: 'Добавить еду', content: host });

  const input = createComposer({
    placeholder: 'Что вы съели',
    placeholderWithDraft: 'Уточните, если нужно',
    keyWarning: keyMissing
      ? 'Ключ провайдера не заполнен: посчитать не получится. Заполните ключ в настройках.'
      : null,
    note: 'Разговор можно вести сколько нужно: блюдо попадает в дневник только по кнопке '
      + '«В дневник». Если закрыть окно без неё, в дневнике ничего не появится.',
    onSend: async ({ text, photo }) => {
      const before = history();
      state.messages.push({
        role: 'user',
        text,
        photo: photo ? `data:${photo.mime};base64,${photo.base64}` : null,
      });
      render();
      await ask({ text, photo, history: before });
    },
  });
  host.append(input.element);

  // --- переписка ---

  function userMessage(message) {
    return h('div', { class: 'msg msg-user' },
      message.photo ? h('img', { class: 'msg-photo', src: message.photo, alt: 'снимок' }) : null,
      message.text ? h('div', { class: 'msg-text' }, message.text) : null);
  }

  function assistantMessage(message, index, isLast) {
    if (message.error) {
      return h('div', { class: 'msg msg-assistant' },
        h('div', { class: 'msg-text small', style: 'color:var(--over)' }, message.error.title),
        message.error.hint ? h('div', { class: 'tiny faint' }, message.error.hint) : null,
        h('div', { class: 'chips', style: 'margin-top:8px' },
          h('button', {
            class: 'btn btn-small', type: 'button', text: 'Повторить',
            onclick: () => retry(index),
          })));
    }

    // Вопрос показываем человеческим текстом: ответ на него продолжает тот же разбор.
    const question = message.analysis?.question
      ? h('div', { class: 'msg msg-question' }, h('div', { class: 'msg-text' }, message.analysis.question))
      : null;

    if (!message.analysis) return question;

    // Разбора может ещё не быть: модель спросила, и считать пока нечего.
    if (!message.analysis.items?.length) return question;

    // Полная карточка с правкой позиций — у последнего разбора: прежние уже не правят.
    if (isLast) {
      return h('div', { class: 'msg msg-assistant' },
        question,
        createResultCard({
          analysis: message.analysis,
          items: message.analysis.items,
          origin: 'chat',
          onSave: null, // сохраняет кнопка на полосе: она видна всегда
          onChange: (values) => {
            state.current = values;
            renderDraftBar();
          },
        }).element);
    }

    const totals = sumItems(message.analysis.items);
    return h('div', { class: 'msg msg-assistant' },
      question,
      h('div', { class: 'msg-text small faint' },
        `${message.analysis.dish} — ${round(totals.grams)} г, ${round(totals.kcal)} ккал`));
  }

  function renderThread() {
    const lastIndex = state.messages.length - 1;
    fill(thread, state.messages.map((message, index) => (message.role === 'user'
      ? userMessage(message)
      : assistantMessage(message, index, index === lastIndex))));
  }

  /** Полоса с текущим разбором: видна всё время, поэтому записать можно в любой момент. */
  function renderDraftBar() {
    if (!state.current) {
      draftBar.hidden = true;
      fill(draftBar);
      return;
    }
    const { totals, portionNote } = state.current;
    draftBar.hidden = false;
    fill(draftBar,
      h('div', { class: 'grow' },
        h('div', { class: 'draft-name' }, state.draft?.dish || 'Без названия'),
        h('div', { class: 'tiny faint' },
          `${round(totals.grams)} г · ${round(totals.kcal)} ккал · Б ${round(totals.protein)}`
          + ` · Ж ${round(totals.fat)} · У ${round(totals.carbs)}`
          + (portionNote ? ` · ${portionNote}` : '')
          + (state.cost ? ` · разговор ${state.cost.toFixed(5)} $` : ''))),
      h('button', {
        class: 'btn-primary draft-save', type: 'button', text: 'В дневник',
        onclick: () => save(state.current),
      }));
  }

  function render() {
    // Порядок важен: карточка в переписке сообщает текущие значения, и полоса
    // строится уже по ним.
    renderThread();
    renderDraftBar();
    input.setHasDraft(Boolean(state.current));
    thread.scrollTop = thread.scrollHeight;
  }

  // --- шаги ---

  /** Прежние сообщения словами: без них модель спрашивала бы одно и то же по кругу. */
  function history() {
    return state.messages.map((message) => ({
      role: message.role,
      text: message.text || message.analysis?.question || '',
    }));
  }

  /** Повторяет неудачный запрос: то же сообщение и тот же разговор до него. */
  async function retry(index) {
    const failed = state.messages[index];
    const before = history().slice(0, index);
    const message = state.messages[index - 1];
    state.messages.splice(index, 1);
    render();
    await ask({
      text: message?.text || '',
      photo: failed.photo ? { base64: failed.photo } : null,
      history: before,
    });
  }

  async function ask({ text, photo, history: past }) {
    input.setBusy(true);

    const provider = createProvider({
      provider: providerConfig.id,
      providerKey: providerConfig.key,
      model: providerConfig.model,
    });
    const prices = settings.prices || DEFAULT_PRICES;

    let result;
    try {
      result = await analyzeChat({
        provider,
        text,
        image: photo ? { base64: photo.base64, mime: photo.mime } : null,
        draft: state.draft,
        history: past,
      });
    } catch (error) {
      result = { ok: false, error: describeError(error), usages: [] };
    }

    // Каждая попытка оплачивается, поэтому в журнал идут все, а не только удачная.
    let cost = 0;
    for (const usage of result.usages || []) {
      const row = makeUsageRow({
        kind: 'chat',
        model: providerConfig.model || 'deepseek-flash',
        usage,
        prices,
      });
      cost += row.cost;
      await logUsage(row).catch(() => {});
    }

    input.setBusy(false);

    if (!result.ok) {
      state.messages.push({
        role: 'assistant',
        error: { ...describeError({ kind: result.error.kind, details: { body: result.error.details } }), ...result.error },
      });
      render();
      return;
    }

    // Пустой разбор не заменяет прежний: вопрос уточняет то, что уже посчитано.
    if (result.data.items?.length) state.draft = result.data;
    state.cost += cost;
    // Модель спрашивает — показываем вопрос, а числа кладём на полосу: подробную карточку
    // рядом с вопросом показывать было бы шумно. Если считать пока нечего, полоса молчит:
    // нули на ней выглядели бы как посчитанное блюдо.
    if (result.data.question && result.data.items?.length) {
      state.current = {
        items: result.data.items,
        totals: sumItems(result.data.items),
        factor: 1,
        portion: 'all',
        portionNote: '',
      };
    }
    state.messages.push({ role: 'assistant', analysis: { ...result.data, cost } });
    render();
  }

  async function save(values) {
    const analysis = state.draft;
    if (!analysis || !values?.items?.length) {
      toast('Пока нечего записывать');
      return;
    }

    let thumbId = null;
    const withPhoto = state.messages.find((message) => message.photo);
    try {
      if (withPhoto?.photo) {
        const blob = await (await fetch(withPhoto.photo)).blob();
        const thumb = await makeThumbnail(new File([blob], 'chat.jpg', { type: blob.type }));
        thumbId = await saveThumb(thumb);
      }
    } catch {
      // Без превью запись всё равно сохраняем: картинка не важнее данных.
    }

    await addEntry({
      date: targetDate,
      time: nowTime(),
      name: analysis.dish,
      grams: round(values.totals.grams, 1),
      kcal: round(values.totals.kcal, 1),
      protein: round(values.totals.protein, 1),
      fat: round(values.totals.fat, 1),
      carbs: round(values.totals.carbs, 1),
      comment: '',
      source: 'chat',
      items: values.items,
      thumbId,
      basis: analysis.basis,
      confidence: analysis.confidence,
      assumptions: analysis.assumptions,
      portionNote: values.portionNote,
      cost: state.cost,
    });

    toast('Записано');
    sheet.close();
  }

  render();
  return sheet;
}
