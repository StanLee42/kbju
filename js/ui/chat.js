// Добавление еды разговором: одно окно, в котором можно написать словами, приложить снимок
// или сделать и то и другое, а потом уточнить разбор словами.
//
// Разбор здесь — предложение, а не запись: в дневник он попадает только по кнопке
// в карточке. Пока разговор открыт, уточнения меняют тот же разбор; закрыли окно —
// разговор пропал, а сохранённое осталось.
import { analyzeChat, createProvider, describeError } from '../llm/index.js';
import { pickImage, prepareForApi, makeThumbnail } from '../media/image.js';
import { addEntry, saveThumb, store } from '../state.js';
import { DEFAULT_PRICES, logUsage, makeUsageRow } from '../usage.js';
import { fill, h, nowTime, round } from '../util.js';
import { openAddSheet } from './add.js';
import { openSheet, toast } from './components/sheet.js';
import { createResultCard } from './result-card.js';

export function openChatSheet({ date = null } = {}) {
  const settings = store.settings || {};
  const providerConfig = settings.provider || {};
  const targetDate = date || store.date;
  const keyMissing = !providerConfig.key;

  const state = {
    messages: [],
    draft: null,
    photo: null, // приложенный снимок, ещё не отправленный
    photoPreview: null,
    text: '',
    busy: false,
  };

  let card = null;

  const thread = h('div', { class: 'thread' });
  const composer = h('div', {});
  const host = h('div', {}, thread, composer);
  const sheet = openSheet({ title: 'Добавить еду', content: host });

  // --- разговор ---

  function userMessage(text, photo) {
    return h('div', { class: 'msg msg-user' },
      photo ? h('img', { class: 'msg-photo', src: photo, alt: 'снимок' }) : null,
      text ? h('div', { class: 'msg-text' }, text) : null);
  }

  /** Краткая строка прежнего разбора: полная карточка нужна только у последнего. */
  function summaryLine(analysis) {
    const totals = (analysis.items || []).reduce((acc, item) => ({
      grams: acc.grams + (Number(item.grams) || 0),
      kcal: acc.kcal + (Number(item.kcal) || 0),
    }), { grams: 0, kcal: 0 });
    return h('div', { class: 'msg-text small' },
      `${analysis.dish} — ${round(totals.grams)} г, ${round(totals.kcal)} ккал`);
  }

  function renderThread() {
    fill(thread, state.messages.map((message, index) => {
      if (message.role === 'user') return userMessage(message.text, message.photo);

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

      const last = index === state.messages.length - 1;
      if (!last) {
        return h('div', { class: 'msg msg-assistant' }, summaryLine(message.analysis));
      }

      // Последний разбор — с правкой позиций, порцией и сохранением.
      card = createResultCard({
        analysis: message.analysis,
        items: message.analysis.items,
        origin: 'chat',
        head: null,
        retryLabel: null,
        onRetry: null,
        onSave: save,
      });
      return card.element;
    }));
  }

  function renderComposer() {
    const chips = [
      h('button', {
        class: 'btn btn-small', type: 'button', text: '📷 Снять',
        disabled: state.busy, onclick: () => attach(true),
      }),
      h('button', {
        class: 'btn btn-small', type: 'button', text: '🖼 Из галереи',
        disabled: state.busy, onclick: () => attach(false),
      }),
    ];

    const attached = state.photoPreview
      ? h('div', { class: 'attached' },
        h('img', { class: 'msg-photo', src: state.photoPreview, alt: 'снимок' }),
        h('button', {
          class: 'btn btn-small btn-ghost', type: 'button', text: 'Убрать снимок',
          onclick: () => {
            state.photo = null;
            state.photoPreview = null;
            renderComposer();
          },
        }))
      : null;

    const input = h('textarea', {
      class: 'composer-input', rows: 2,
      placeholder: state.photoPreview ? 'Добавьте словами, если нужно' : 'Что вы съели',
      value: state.text,
      oninput: (event) => { state.text = event.target.value; },
    });

    fill(composer,
      attached,
      input,
      h('div', { class: 'composer-row' },
        h('div', { class: 'chips' }, chips),
        h('button', {
          class: 'btn-primary composer-send', type: 'button',
          text: state.busy ? 'Считаю…' : 'Отправить',
          disabled: state.busy,
          onclick: send,
        })),
      keyMissing
        ? h('p', { class: 'small', style: 'margin-top:8px;color:var(--over)' },
          'Ключ провайдера не заполнен: посчитать не получится. Заполните ключ в настройках.')
        : null,
      // Числа можно ввести и руками — например, когда они списаны с упаковки.
      h('p', { class: 'tiny faint', style: 'margin-top:8px' },
        'Запись появится в дневнике только после подтверждения. Пока разбор не сохранён, '
        + 'закрывать окно безопасно: в дневник ничего не попадёт.'),
      h('div', { class: 'chips', style: 'margin-top:8px' },
        h('button', {
          class: 'btn btn-small btn-ghost', type: 'button', text: 'Ввести числа вручную',
          onclick: () => {
            sheet.close();
            openAddSheet({ date: targetDate });
          },
        })));
  }

  function render() {
    renderThread();
    renderComposer();
  }

  // --- шаги ---

  async function attach(fromCamera) {
    const file = await pickImage({ camera: fromCamera });
    if (!file) return;
    try {
      const prepared = await prepareForApi(file);
      state.photo = { file, base64: prepared.base64, mime: prepared.mime };
      state.photoPreview = `data:${prepared.mime};base64,${prepared.base64}`;
      renderComposer();
    } catch (error) {
      toast(`Снимок не удалось прочитать: ${error.message || error}`);
    }
  }

  async function send() {
    const text = state.text.trim();
    if (!text && !state.photo) {
      toast('Напишите словами или приложите снимок');
      return;
    }
    if (keyMissing) {
      toast('Вставьте ключ провайдера в настройках');
      return;
    }

    state.messages.push({ role: 'user', text, photo: state.photoPreview });
    state.text = '';
    const photo = state.photo;
    state.photo = null;
    state.photoPreview = null;
    render();
    await ask({ text, photo });
  }

  /** Повторяет последний запрос: тот же текст и тот же разбор, что были до ошибки. */
  async function retry(index) {
    const failed = state.messages[index];
    const previous = state.messages[index - 1];
    state.messages.splice(index, 1);
    render();
    await ask({ text: previous?.text || '', photo: failed.photo ? { base64: failed.photo } : null });
  }

  async function ask({ text, photo }) {
    state.busy = true;
    render();

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

    state.busy = false;

    if (!result.ok) {
      state.messages.push({
        role: 'assistant',
        error: { ...describeError({ kind: result.error.kind, details: { body: result.error.details } }), ...result.error },
      });
      render();
      return;
    }

    state.draft = result.data;
    state.messages.push({ role: 'assistant', analysis: { ...result.data, cost } });
    render();
    // Разговор растёт вниз: последнее сообщение должно быть видно.
    thread.scrollTop = thread.scrollHeight;
  }

  async function save({ items, totals, portionNote }) {
    const analysis = state.draft;
    if (!analysis) return;

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
      grams: round(totals.grams, 1),
      kcal: round(totals.kcal, 1),
      protein: round(totals.protein, 1),
      fat: round(totals.fat, 1),
      carbs: round(totals.carbs, 1),
      comment: '',
      source: 'chat',
      items,
      thumbId,
      basis: analysis.basis,
      confidence: analysis.confidence,
      assumptions: analysis.assumptions,
      portionNote,
      cost: analysis.cost,
    });

    toast('Записано');
    sheet.close();
  }

  render();
  return sheet;
}
