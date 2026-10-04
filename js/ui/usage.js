// Экран расхода: сколько потрачено, на что, сколько будет стоить при разном уровне
// использования, и сколько осталось на счету провайдера.
import { createProvider, describeError } from '../llm/index.js';
import { saveSettings, store } from '../state.js';
import { DEFAULT_PRICES, USAGE_KINDS, allUsage, budgetState, projectMonth, summarize } from '../usage.js';
import { fill, h, round } from '../util.js';
import { toast } from './components/sheet.js';

const PERIODS = [
  { id: 'today', label: 'Сегодня' },
  { id: 'week', label: 'Неделя' },
  { id: 'month', label: 'Месяц' },
  { id: 'all', label: 'Всё время' },
];

const LEVELS = [5, 15, 40];

export function mount(container) {
  let period = 'week';
  let rows = [];
  let ready = false;
  let balance = null;
  let balanceError = null;
  let balanceBusy = false;

  const periodRow = h('div', { class: 'chips', style: 'margin-bottom:12px' });
  const summaryCard = h('section', { class: 'card' });
  const kindsCard = h('section', { class: 'card' });
  const calculatorCard = h('section', { class: 'card' });
  const budgetCard = h('section', { class: 'card' });
  const balanceCard = h('section', { class: 'card' });
  const pricesNote = h('p', { class: 'tiny faint' });

  container.append(
    h('h1', { text: 'Расход', style: 'margin-bottom:12px' }),
    periodRow,
    summaryCard,
    kindsCard,
    calculatorCard,
    budgetCard,
    balanceCard,
    pricesNote,
  );

  function sinceFor(id) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const day = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    if (id === 'today') return day(now);
    if (id === 'week') {
      const from = new Date(now);
      from.setDate(from.getDate() - 6);
      return day(from);
    }
    if (id === 'month') {
      const from = new Date(now);
      from.setDate(from.getDate() - 29);
      return day(from);
    }
    return null;
  }

  const money = (value) => `$${(Number(value) || 0).toFixed(value >= 1 ? 2 : 4)}`;

  function renderPeriods() {
    fill(periodRow, ...PERIODS.map((item) => h('button', {
      type: 'button', text: item.label,
      'aria-pressed': String(item.id === period),
      onclick: () => {
        period = item.id;
        render();
      },
    })));
  }

  function renderSummary(filtered) {
    if (!filtered.requests) {
      fill(summaryCard, 
        h('h2', { class: 'card-title', text: 'Итого' }),
        h('p', { class: 'small muted' }, 'За этот период запросов к модели не было.'));
      return;
    }
    const tokens = filtered.tokens;
    fill(summaryCard, 
      h('h2', { class: 'card-title', text: 'Итого' }),
      h('div', { style: 'font-size:26px;font-weight:700' }, money(filtered.total)),
      h('p', { class: 'small muted', style: 'margin-top:6px' },
        `${filtered.requests} запросов · в среднем ${money(filtered.averagePerRequest)} за запрос`),
      h('p', { class: 'tiny faint', style: 'margin-top:6px' },
        `Токены: вход ${tokens.input} (из кэша ${tokens.hit}), выход ${tokens.output}`
        + (tokens.reasoning ? `, из них размышлений ${tokens.reasoning}` : '')));
  }

  function renderKinds(filtered) {
    const entries = Object.entries(filtered.byKind).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
      fill(kindsCard, h('h2', { class: 'card-title', text: 'На что ушло' }));
      return;
    }
    const max = entries[0][1] || 1;
    fill(kindsCard, 
      h('h2', { class: 'card-title', text: 'На что ушло' }),
      ...entries.map(([kind, cost]) => h('div', { class: 'bar-line' },
        h('div', { class: 'bar-head' },
          h('span', { text: USAGE_KINDS[kind] || kind }),
          h('span', { class: 'tiny muted', text: money(cost) })),
        h('div', { class: 'bar-track' },
          h('div', {
            class: 'bar-fill',
            style: `background:var(--accent);width:${Math.max(2, Math.round((cost / max) * 100))}%`,
          })))));
  }

  function renderCalculator(filtered) {
    const chatRows = rows.filter((row) => row.kind === 'chat');
    const source = chatRows.length ? summarize(chatRows) : filtered;
    if (!source.requests) {
      fill(calculatorCard, 
        h('h2', { class: 'card-title', text: 'Сколько будет стоить' }),
        h('p', { class: 'small muted' },
          'Пока не набралось истории: как только появятся запросы к модели, здесь будет прогноз.'));
      return;
    }
    const projection = projectMonth({ averageCost: source.averagePerRequest, levels: LEVELS });
    fill(calculatorCard, 
      h('h2', { class: 'card-title', text: 'Сколько будет стоить' }),
      h('p', { class: 'tiny faint', style: 'margin-bottom:10px' },
        chatRows.length
          ? `Прогноз по вашим сообщениям в чате: в среднем ${money(source.averagePerRequest)} за ход.`
          : `Прогноз по всем запросам: в среднем ${money(source.averagePerRequest)} за запрос.`),
      ...projection.map((row) => h('div', { class: 'row-between', style: 'padding:5px 0' },
        h('span', { class: 'small', text: `${row.perDay} в день` }),
        h('span', { class: 'small mono', text: `${money(row.perMonth)} в месяц` }))));
  }

  function renderBudget(filtered) {
    const budget = store.settings?.budget?.monthly || 0;
    const state = budgetState({ spent: filtered.total, budget });
    const budgetInput = h('input', {
      type: 'number', inputmode: 'decimal', placeholder: 'например 3',
      value: budget || '',
      onchange: (event) => {
        const value = Number(event.target.value) || 0;
        saveSettings({ budget: { ...(store.settings.budget || {}), monthly: value } });
        render();
      },
    });

    const warn = {
      over: 'Бюджет исчерпан — можно перевести разговор в локальный режим без модели.',
      critical: 'Израсходовано больше 80% бюджета.',
      warn: 'Израсходована половина бюджета.',
      ok: '',
      none: '',
    }[state.level];

    fill(budgetCard, 
      h('h2', { class: 'card-title', text: 'Бюджет на месяц' }),
      h('label', { class: 'field' },
        h('span', { class: 'field-label', text: 'Сколько готовы тратить в месяц, долларов' }),
        budgetInput),
      budget > 0
        ? h('div', {},
          h('div', { class: 'bar-track', style: 'margin-top:10px' },
            h('div', {
              class: 'bar-fill',
              style: `width:${Math.min(100, Math.round(state.percent * 100))}%`
                + `;background:${state.level === 'ok' ? 'var(--accent)' : 'var(--over)'}`,
            })),
          h('div', { class: 'tiny faint', style: 'margin-top:6px' },
            `${money(filtered.total)} из ${money(budget)} · ${Math.round(state.percent * 100)}%`),
          warn ? h('p', { class: 'small', style: 'margin-top:8px;color:var(--over)' }, warn) : null)
        : h('p', { class: 'tiny faint', style: 'margin-top:6px' },
          'Если задать бюджет, приложение начнёт предупреждать о расходе.'));
  }

  function renderBalance() {
    const provider = store.settings?.provider || {};
    const button = h('button', {
      class: 'btn btn-small', type: 'button',
      text: balanceBusy ? 'Спрашиваем…' : 'Проверить баланс',
      disabled: balanceBusy,
      onclick: async () => {
        balanceBusy = true;
        balanceError = null;
        render();
        try {
          const adapter = createProvider({
            provider: provider.id, providerKey: provider.key, model: provider.model,
          });
          balance = await adapter.balance();
          if (!balance) balanceError = { title: 'Провайдер не сообщил баланс', hint: '' };
        } catch (error) {
          const described = describeError(error);
          balanceError = { title: described.title, hint: described.hint };
        } finally {
          balanceBusy = false;
          render();
        }
      },
    });

    const parts = [h('h2', { class: 'card-title', text: 'Счёт у провайдера' })];
    if (!provider.key) {
      parts.push(h('p', { class: 'small muted' }, 'Ключ не задан — баланс не спросить.'));
    } else if (balance) {
      parts.push(h('div', { style: 'font-size:22px;font-weight:650' },
        `${balance.total.toFixed(2)} ${balance.currency}`));
      parts.push(h('p', { class: 'tiny faint', style: 'margin-top:4px' },
        balance.available ? 'Счёт активен.' : 'Провайдер сообщает, что счёт недоступен.'));
      if (balance.toppedUp) {
        parts.push(h('p', { class: 'tiny faint' }, `Пополнено вами: ${balance.toppedUp.toFixed(2)} ${balance.currency}`));
      }
    } else if (balanceError) {
      parts.push(h('p', { class: 'small', style: 'color:var(--over)' }, balanceError.title));
      if (balanceError.hint) parts.push(h('p', { class: 'tiny faint' }, balanceError.hint));
    } else {
      parts.push(h('p', { class: 'small muted' },
        'Пока не спрашивали. Кнопка сделает запрос к провайдеру — он бесплатный.'));
    }
    parts.push(h('div', { class: 'chips', style: 'margin-top:10px' }, button));
    parts.push(h('p', { class: 'tiny faint', style: 'margin-top:10px' },
      'Распознавание речи работает на устройстве и ничего не стоит — деньги тратят только '
      + 'запросы к модели.'));
    fill(balanceCard, ...parts);
  }

  function renderPrices() {
    const prices = store.settings?.prices || DEFAULT_PRICES;
    const table = prices.perModel?.[store.settings?.provider?.model] || prices.perModel?.['deepseek-flash'];
    pricesNote.textContent = table
      ? `Цены на ${prices.asOf}: вход ${table.inputCacheMiss} / из кэша ${table.inputCacheHit} / выход `
        + `${table.output} за миллион токенов. Суммы — оценка, а не факт: тарифы меняются.`
      : '';
  }

  function render() {
    renderPeriods();
    const since = sinceFor(period);
    const filtered = summarize(rows, { since });
    renderSummary(filtered);
    renderKinds(filtered);
    renderCalculator(filtered);
    renderBudget(filtered);
    renderBalance();
    renderPrices();
  }

  allUsage().then((loaded) => {
    rows = loaded;
    ready = true;
    render();
  }).catch(() => {
    ready = true;
    toast('Не удалось прочитать журнал расхода');
    render();
  });

  return { destroy() {} };
}
