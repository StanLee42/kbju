// Разбор снимка упаковки ради продукта: человек присылает таблицу пищевой ценности, модель
// читает её, приложение приводит числа к 100 г, а продукт уходит в список «Мои продукты».
//
// Почему отдельная шторка, а не режим разговора о еде: разговор о еде отвечает на вопрос
// «что я съел и сколько», и его ответ уходит в дневник дня. Здесь вопрос другой, и дневник
// не затрагивается вовсе. Подсказка окна говорит об этом прямо.
//
// Числа правятся в карточке до сохранения: модель читает таблицу, а человек видит упаковку
// перед собой, и опечатку в прочитанном числе дешевле поправить сразу.
import { createProvider, describeError, readProduct } from '../llm/index.js';
import { nameProblem, per100Line, productFromParse, saveProduct } from '../products.js';
import { store } from '../state.js';
import {
  clearProductParse, loadProductParse, loadProductTyped, saveProductParse, saveProductTyped,
} from '../chat-session.js';
import { DEFAULT_PRICES, logUsage, makeUsageRow } from '../usage.js';
import { fill, h, num, round } from '../util.js';
import { createComposer } from './components/composer.js';
import { openSheet, toast } from './components/sheet.js';

const VALUE_KEYS = ['kcal', 'protein', 'fat', 'carbs'];
const VALUE_LABELS = { kcal: 'Ккал', protein: 'Б', fat: 'Ж', carbs: 'У' };
const CONFIDENCE_LABEL = { high: 'уверенно', medium: 'примерно', low: 'неуверенно' };

export function openProductPhoto({ onSaved = null } = {}) {
  const settings = store.settings || {};
  const providerConfig = settings.provider || {};
  const keyMissing = !providerConfig.key;

  // Разбор возвращается после перезагрузки страницы: приложение перезагружает себя само,
  // когда на устройство приходит новая сборка, и незавершённый разбор терять незачем.
  const restored = loadProductParse();
  const state = {
    messages: restored?.messages || [], // { role, text, photo, answer, error }
    draft: restored?.draft || null, // последний разбор: уходит модели следующим сообщением
    product: restored?.product || null, // текущая карточка: название и значения на 100 г
    cost: restored?.cost || 0,
  };

  const thread = h('div', { class: 'thread' });
  const draftBar = h('div', { class: 'draft-bar', hidden: true });
  const host = h('div', {}, thread, draftBar);
  const sheet = openSheet({
    title: 'Продукт со снимка',
    content: host,
    // Закрытие окна заканчивает разбор, каким бы способом его ни закрыли. Перезагрузка
    // страницы окно не закрывает, поэтому разбор и возвращается после неё.
    onClose: () => clearProductParse(),
  });

  const input = createComposer({
    placeholder: 'Название продукта, если нужно',
    placeholderWithDraft: 'Поправьте словами, если нужно',
    initialText: loadProductTyped(),
    onTyped: (text) => saveProductTyped(text),
    keyWarning: keyMissing
      ? 'Ключ провайдера не заполнен: разобрать не получится. Заполните ключ в настройках.'
      : null,
    note: 'Пришлите снимок таблицы пищевой ценности: значения придут на 100 г, и их можно '
      + 'поправить до сохранения. Продукт уходит в «Мои продукты» по кнопке, в дневник дня '
      + 'разбор не пишет, а снимок нигде не хранится.',
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

  // --- карточка продукта ---

  /** Строка «что учтено» и уверенность модели: по ним видно, таблица это или оценка. */
  function notesLine(answer) {
    const parts = [];
    if (answer.source === 'estimate') parts.push('числа не из таблицы, а оценка по снимку');
    if (answer.confidence) parts.push(`уверенность: ${CONFIDENCE_LABEL[answer.confidence] || answer.confidence}`);
    if (answer.assumptions) parts.push(answer.assumptions);
    return parts.join(' · ');
  }

  /**
   * Карточка продукта: название и четыре числа на 100 г. Поля правки создаются один раз
   * на сообщение, поэтому набор с клавиатуры не сбрасывает ни фокус, ни курсор.
   */
  function productCard(answer) {
    /** Правка числа или названия: записываем сразу, иначе перезагрузка съела бы правку. */
    const edited = () => {
      renderDraftBar();
      persist();
    };

    const field = (key) => h('label', { class: 'field field-compact', style: 'margin:0' },
      h('span', { class: 'field-label', text: VALUE_LABELS[key] }),
      h('input', {
        type: 'number', spellcheck: false, inputmode: 'decimal',
        value: round(state.product.per100[key], 1),
        oninput: (event) => {
          state.product.per100[key] = num(event.target.value);
          edited();
        },
      }));

    const notes = notesLine(answer);

    return h('div', {},
      h('label', { class: 'field' },
        h('span', { class: 'field-label', text: 'Название' }),
        h('input', {
          type: 'text', spellcheck: false, value: state.product.name,
          autocapitalize: 'sentences',
          oninput: (event) => {
            state.product.name = event.target.value;
            edited();
          },
        })),
      h('div', { class: 'tiny faint', style: 'margin:12px 0 6px' }, 'Значения на 100 г'),
      h('div', { class: 'grid-4' }, VALUE_KEYS.map(field)),
      notes ? h('p', { class: 'small faint', style: 'margin-top:10px' }, `Что учтено: ${notes}`) : null,
      (answer.warnings || []).length
        ? h('p', { class: 'tiny faint', style: 'margin-top:6px' }, `Замечания разбора: ${answer.warnings.join('; ')}`)
        : null);
  }

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

    const answer = message.answer || {};
    // Вопрос показываем человеческим текстом: ответ на него продолжает тот же разбор.
    const question = answer.question
      ? h('div', { class: 'msg msg-question' }, h('div', { class: 'msg-text' }, answer.question))
      : null;

    // Карточку с правкой показывает последний разбор: прежние уже не правят.
    if (isLast && state.product && answer.hasNumbers) {
      return h('div', { class: 'msg msg-assistant' }, question, productCard(answer));
    }

    // Числа прежнего разбора могли остаться без карточки: показываем их строкой, как они
    // напечатаны на упаковке, вместе с граммовкой таблицы.
    const line = answer.hasNumbers
      ? `${answer.name || 'Без названия'} - ${round(answer.values.kcal)} ккал · Б ${round(answer.values.protein)}`
        + ` · Ж ${round(answer.values.fat)} · У ${round(answer.values.carbs)} на ${round(answer.basisGrams)} г`
      : null;
    return question || line
      ? h('div', { class: 'msg msg-assistant' },
        question,
        line ? h('div', { class: 'msg-text small faint' }, line) : null)
      : null;
  }

  function renderThread() {
    const lastIndex = state.messages.length - 1;
    fill(thread, state.messages.map((message, index) => (message.role === 'user'
      ? userMessage(message)
      : assistantMessage(message, index, index === lastIndex))));
  }

  /** Полоса с текущим продуктом: видна всё время разбора, поэтому сохранить можно в любой момент. */
  function renderDraftBar() {
    if (!state.product) {
      draftBar.hidden = true;
      fill(draftBar);
      return;
    }
    draftBar.hidden = false;
    fill(draftBar,
      h('div', { class: 'grow' },
        h('div', { class: 'draft-name' }, state.product.name.trim() || 'Без названия'),
        h('div', { class: 'tiny faint' },
          per100Line(state.product.per100)
          + (state.cost ? ` · разбор ${state.cost.toFixed(5)} $` : ''))),
      h('button', {
        class: 'btn-primary draft-save', type: 'button', text: 'В мои продукты',
        onclick: save,
      }));
  }

  function render() {
    // Порядок важен: карточка в переписке сообщает текущий продукт, и полоса
    // строится уже по нему.
    renderThread();
    renderDraftBar();
    input.setHasDraft(Boolean(state.product));
    thread.scrollTop = thread.scrollHeight;
    persist();
  }

  /**
   * Кладёт разбор в хранилище. Перезагрузка страницы приходит сама вместе с новой сборкой,
   * и разбор должен пережить её целиком.
   */
  function persist() {
    saveProductParse({
      messages: state.messages,
      product: state.product,
      draft: state.draft,
      cost: state.cost,
    });
  }

  // --- шаги ---

  /** Прежние сообщения словами: без них модель спрашивала бы одно и то же по кругу. */
  function history() {
    return state.messages.map((message) => ({
      role: message.role,
      text: message.text || message.answer?.question || '',
    }));
  }

  /** Разбирает адрес данных на части: повтор запроса отправляет тот же снимок. */
  function imageFromDataUrl(dataUrl) {
    const [head, body] = String(dataUrl).split(',');
    const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
    return { base64: body, mime };
  }

  /** Повторяет неудачный запрос: то же сообщение человека и тот же разбор до него. */
  async function retry(index) {
    const before = history().slice(0, index);
    // Снимок лежит в сообщении человека, а не в сообщении об ошибке: из ошибки его взять негде.
    const message = state.messages[index - 1];
    state.messages.splice(index, 1);
    render();
    await ask({
      text: message?.text || '',
      photo: message?.photo ? imageFromDataUrl(message.photo) : null,
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
      result = await readProduct({
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
        kind: 'photo',
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

    state.cost += cost;
    // Разбор без чисел это вопрос: он уточняет прочитанное, а прежний продукт не заменяет.
    if (result.data.hasNumbers) {
      state.draft = result.data;
      state.product = productFromParse(result.data);
    }
    state.messages.push({ role: 'assistant', answer: { ...result.data, cost } });
    render();
  }

  async function save() {
    if (!state.product) {
      toast('Пока нечего сохранять');
      return;
    }
    const problem = nameProblem(state.product.name);
    if (problem) {
      toast(problem);
      return;
    }

    try {
      await saveProduct({ name: state.product.name, per100: state.product.per100 });
    } catch (error) {
      toast(error.message);
      return;
    }

    toast(`«${state.product.name}» в моих продуктах`);
    // Список продуктов показывается заново уже с новым продуктом, и новая шторка заменяет эту.
    // Отдельно закрывать окно нельзя: закрытие откладывает возврат по истории, и этот возврат
    // закрыл бы заново открытый список.
    if (onSaved) await onSaved();
    else sheet.close();
  }

  render();
  return sheet;
}
