// Разговор о нормах: калории и БЖУ для обычного и тренировочного дня.
//
// Зачем разговор, а не кнопка «загрузить отчёт»: нормы почти всегда обсуждают — с тренером,
// с врачом, с собственным опытом. Раньше можно было только загрузить отчёт и согласиться
// с числами; поспорить было негде.
//
// Числа считает приложение, а не модель: модель меняет рычаги (темп, активность, белок
// на килограмм, добавку на тренировку), приложение пересчитывает нормы и показывает расчёт
// по шагам. Так в споре видно, что именно сдвинулось.
import { createProvider, describeError, discussNorms } from '../llm/index.js';
import { NORM_DEFAULTS, normsFromMeasurement } from '../norm.js';
import * as db from '../db.js';
import { saveSettings, store } from '../state.js';
import { DEFAULT_PRICES, logUsage, makeUsageRow } from '../usage.js';
import { fill, h, round } from '../util.js';
import { createComposer } from './components/composer.js';
import { openSheet, toast } from './components/sheet.js';

const DAY_TYPE_SOURCE = { rest: 'rest', train: 'training' };

function planLine(title, day) {
  if (!day) return null;
  return h('div', { class: 'small' },
    h('b', { text: title }),
    ` — ${round(day.kcal)} ккал · Б ${round(day.protein)} · Ж ${round(day.fat)} · У ${round(day.carbs)}`);
}

export function openNormsChat() {
  const settings = store.settings || {};
  const providerConfig = settings.provider || {};
  const keyMissing = !providerConfig.key;

  const state = {
    messages: [], // { role, text, photo, answer, error }
    measurement: null,
    params: { ...NORM_DEFAULTS, pace: settings.goal?.pace ?? 0.5 },
    plan: null,
    planError: null,
    cost: 0,
  };

  const thread = h('div', { class: 'thread' });
  const draftBar = h('div', { class: 'draft-bar', hidden: true });
  const host = h('div', {}, thread, draftBar);
  const sheet = openSheet({ title: 'Нормы и калории', content: host });

  const input = createComposer({
    placeholder: 'Что не так с нормами',
    placeholderWithDraft: 'Уточните, если нужно',
    keyWarning: keyMissing
      ? 'Ключ провайдера не заполнен: обсудить не получится. Заполните ключ в настройках.'
      : null,
    note: 'Числа считает приложение по рычагам: темп снижения, активность, белок на килограмм '
      + 'тощей массы, добавка на тренировку. Модель их меняет по вашим словам и объясняет, '
      + 'а расчёт по шагам видно в разговоре — так понятно, что именно сдвинулось.',
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

  // --- расчёт ---

  /** Пересчитывает нормы по текущим рычагам и измерениям. */
  function recalculate() {
    if (!state.measurement) {
      state.plan = null;
      state.planError = 'Измерений нет: пришлите отчёт биоимпеданса снимком или назовите вес, '
        + 'рост, возраст и пол — без них считать не из чего.';
      return;
    }
    const { pace, ...defaults } = state.params;
    const plan = normsFromMeasurement({
      measurement: state.measurement,
      pace,
      defaults: { ...NORM_DEFAULTS, ...defaults },
    });
    state.plan = plan.ok ? plan : null;
    state.planError = plan.ok ? null : plan.error;
  }

  function currentSummary() {
    return {
      dayTypes: (settings.dayTypes || []).map((type) => ({
        name: type.name, kcal: type.kcal, protein: type.protein, fat: type.fat, carbs: type.carbs,
      })),
      params: state.params,
      measurement: state.measurement,
      calculated: state.plan
        ? { rest: { kcal: state.plan.rest.kcal }, training: { kcal: state.plan.training.kcal } }
        : null,
    };
  }

  // --- переписка ---

  function userMessage(message) {
    return h('div', { class: 'msg msg-user' },
      message.photo ? h('img', { class: 'msg-photo', src: message.photo, alt: 'снимок' }) : null,
      message.text ? h('div', { class: 'msg-text' }, message.text) : null);
  }

  function planBlock() {
    if (state.planError) {
      return h('div', { class: 'msg-text small', style: 'color:var(--over)' }, state.planError);
    }
    if (!state.plan) return null;
    return h('div', {},
      h('div', { class: 'field-label', text: 'Получается так' }),
      planLine('Обычный день', state.plan.rest),
      planLine('Тренировка', state.plan.training),
      h('details', { style: 'margin-top:6px' },
        h('summary', { class: 'tiny faint', style: 'cursor:pointer' }, 'Как это посчитано'),
        h('div', { class: 'tiny faint', style: 'margin-top:6px;white-space:pre-wrap' },
          (state.plan.steps || []).join('\n'))),
      (state.plan.assumptions || []).length
        ? h('div', { class: 'tiny faint', style: 'margin-top:6px' },
          `Что принято: ${state.plan.assumptions.join(' ')}`)
        : null);
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
    return h('div', { class: 'msg msg-assistant' },
      answer.comment ? h('div', { class: 'msg-text' }, answer.comment) : null,
      answer.question
        ? h('div', { class: 'msg msg-question' }, h('div', { class: 'msg-text' }, answer.question))
        : null,
      answer.measurement
        ? h('div', { class: 'tiny faint', style: 'margin-top:6px' },
          'Отчёт разобран: ' + Object.entries(answer.measurement)
            .map(([key, value]) => `${key} ${value}`).join(', '))
        : null,
      isLast ? planBlock() : null);
  }

  function renderThread() {
    const lastIndex = state.messages.length - 1;
    fill(thread, state.messages.map((message, index) => (message.role === 'user'
      ? userMessage(message)
      : assistantMessage(message, index, index === lastIndex))));
  }

  /** Полоса с текущим планом: он должен быть виден в любой момент разговора. */
  function renderDraftBar() {
    if (!state.plan) {
      draftBar.hidden = true;
      fill(draftBar);
      return;
    }
    draftBar.hidden = false;
    fill(draftBar,
      h('div', { class: 'grow' },
        h('div', { class: 'draft-name' },
          `${round(state.plan.rest.kcal)} / ${round(state.plan.training.kcal)} ккал`),
        h('div', { class: 'tiny faint' },
          `обычный день · тренировка${state.cost ? ` · разговор ${state.cost.toFixed(5)} $` : ''}`)),
      h('button', {
        class: 'btn-primary draft-save', type: 'button', text: 'Применить нормы',
        onclick: applyPlan,
      }));
  }

  function render() {
    renderThread();
    renderDraftBar();
    input.setHasDraft(Boolean(state.plan));
    thread.scrollTop = thread.scrollHeight;
  }

  // --- шаги ---

  function history() {
    return state.messages.map((message) => ({
      role: message.role,
      text: message.text || message.answer?.comment || '',
    }));
  }

  async function retry(index) {
    const failed = state.messages[index];
    const before = history().slice(0, index);
    const message = state.messages[index - 1];
    state.messages.splice(index, 1);
    render();
    await ask({
      text: message?.text || '',
      photo: failed.photo ? { dataUrl: failed.photo } : null,
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

    // Снимок приходит как адрес данных: разбираем его на части для запроса.
    const image = photo?.dataUrl
      ? (() => {
        const [head, body] = String(photo.dataUrl).split(',');
        return { base64: body, mime: (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg' };
      })()
      : (photo ? { base64: photo.base64, mime: photo.mime } : null);

    let result;
    try {
      result = await discussNorms({
        provider,
        text,
        image,
        current: currentSummary(),
        history: past,
      });
    } catch (error) {
      result = { ok: false, error: describeError(error), usages: [] };
    }

    let cost = 0;
    for (const usage of result.usages || []) {
      const row = makeUsageRow({
        kind: 'impedance',
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
    // Рычаги и измерения обновляем только тем, о чём модель сказала; остальное остаётся как было.
    state.params = { ...state.params, ...result.data.params };
    if (result.data.measurement) {
      state.measurement = { ...(state.measurement || {}), ...result.data.measurement };
      await db.put('measurements', { id: `m-${Date.now()}`, ...state.measurement }).catch(() => {});
    }
    recalculate();
    state.messages.push({ role: 'assistant', answer: { ...result.data, cost } });
    render();
  }

  async function applyPlan() {
    if (!state.plan) {
      toast('Сначала нужен расчёт: без измерений нормы не посчитать');
      return;
    }
    const types = (store.settings.dayTypes || []).map((type) => {
      const source = DAY_TYPE_SOURCE[type.id];
      if (!source || !state.plan[source]) return type;
      const day = state.plan[source];
      return {
        ...type,
        kcal: round(day.kcal),
        protein: round(day.protein),
        fat: round(day.fat),
        carbs: round(day.carbs),
      };
    });
    await saveSettings({ dayTypes: types });
    toast('Нормы обновлены');
    sheet.close();
  }

  // Последний разобранный отчёт берём из хранилища: обсуждать можно и без нового снимка.
  db.all('measurements')
    .then((rows) => {
      const last = rows.sort((a, b) => String(b.id).localeCompare(String(a.id)))[0];
      if (last) {
        const { id, ...measurement } = last;
        state.measurement = measurement;
        recalculate();
        render();
      }
    })
    .catch(() => {});

  render();
  return sheet;
}
