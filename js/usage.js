// Учёт расхода: токены, стоимость, прогноз и бюджет.
//
// Цены заданы таблицей с датой и считаются оценкой, а не фактом: тарифы провайдера меняются,
// поэтому таблица редактируется в настройках, а рядом всегда показывается, на какую дату
// цены действовали.
import * as db from './db.js';
import { uid } from './util.js';

/** Стоимость в долларах: округляем до стотысячных, мельче в интерфейсе не нужно. */
function money(value) {
  return Math.round((Number(value) || 0) * 100_000) / 100_000;
}

export const DEFAULT_PRICES = {
  asOf: '2026-10-04',
  currency: 'USD',
  perModel: {
    'deepseek-flash': {
      inputCacheMiss: 0.15, // за 1M токенов
      inputCacheHit: 0.02,
      output: 1.1, // размышления тарифицируются как выходные токены
      perSearch: 0,
    },
  },
  // Непиковые часы: у провайдера в этом окне действует скидка. Границы и размер скидки
  // заданы предположительно и требуют сверки с тарифами.
  offPeak: { fromMinutesUtc: 16 * 60 + 30, toMinutesUtc: 24 * 60 + 30, factor: 0.5 },
};

export const USAGE_KINDS = {
  photo: 'Анализ фото',
  voice: 'Разбор сказанного',
  chat: 'Чат',
  greeting: 'Приветствие',
  summary: 'Выжимка разговора',
  impedance: 'Разбор отчёта',
  search: 'Поиск в сети',
};

export function priceFor(prices, model) {
  const table = prices?.perModel || DEFAULT_PRICES.perModel;
  return table[model] || table['deepseek-flash'];
}

/** Попадает ли момент в окно скидки. Окно задано в минутах от полуночи по UTC. */
export function isOffPeak(at = new Date(), offPeak = DEFAULT_PRICES.offPeak) {
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  const { fromMinutesUtc, toMinutesUtc } = offPeak;
  if (fromMinutesUtc <= toMinutesUtc) {
    return minutes >= fromMinutesUtc && minutes < toMinutesUtc;
  }
  // Окно переходит через полночь.
  return minutes >= fromMinutesUtc || minutes < toMinutesUtc;
}

/** Токены из ответа провайдера в единый вид. */
export function normalizeUsage(usage = {}) {
  const input = Number(usage.prompt_tokens) || 0;
  const output = Number(usage.completion_tokens) || 0;
  const hit = Number(usage.prompt_cache_hit_tokens)
    || Number(usage.prompt_tokens_details?.cached_tokens) || 0;
  const miss = Number(usage.prompt_cache_miss_tokens) || Math.max(0, input - hit);
  const reasoning = Number(usage.completion_tokens_details?.reasoning_tokens) || 0;
  return { input, output, hit, miss, reasoning };
}

/**
 * Стоимость одного запроса.
 * @returns {{cost: number, currency: string, offPeak: boolean, tokens: object, prices: object}}
 */
export function computeCost({ usage, model = 'deepseek-flash', at = new Date(), prices = DEFAULT_PRICES, searches = 0 }) {
  const price = priceFor(prices, model);
  const tokens = normalizeUsage(usage);
  const offPeak = isOffPeak(at, prices.offPeak ?? DEFAULT_PRICES.offPeak);
  const factor = offPeak ? (prices.offPeak?.factor ?? 1) : 1;

  const perMillion = (count, rate) => (count / 1_000_000) * rate * factor;
  const cost = perMillion(tokens.miss, price.inputCacheMiss)
    + perMillion(tokens.hit, price.inputCacheHit)
    + perMillion(tokens.output, price.output)
    + searches * (price.perSearch || 0);

  return {
    // Стоимость считаем точно: округление живёт на границах — при записи в журнал
    // и при показе, иначе арифметика перестаёт сходиться.
    cost,
    currency: prices.currency || 'USD',
    offPeak,
    tokens,
    searches,
    pricesAsOf: prices.asOf || DEFAULT_PRICES.asOf,
  };
}

export function makeUsageRow({ kind, model, usage, at = new Date(), prices = DEFAULT_PRICES, searches = 0, note = '' }) {
  const computed = computeCost({ usage, model, at, prices, searches });
  return {
    id: uid(),
    at: at.toISOString(),
    kind: kind in USAGE_KINDS ? kind : 'chat',
    model,
    searches,
    note,
    ...computed,
    cost: money(computed.cost),
  };
}

export async function logUsage(row) {
  await db.put('usage', row);
  return row;
}

export async function allUsage() {
  return db.all('usage');
}

function dayKey(iso) {
  return String(iso).slice(0, 10);
}

/** Сводка за период: суммы по видам запросов и по дням. */
export function summarize(rows, { since = null, until = null } = {}) {
  const filtered = (rows || []).filter((row) => {
    const day = dayKey(row.at);
    if (since && day < since) return false;
    if (until && day > until) return false;
    return true;
  });

  const byKind = {};
  const byDay = {};
  let total = 0;
  let requests = 0;
  let tokens = { input: 0, output: 0, hit: 0, miss: 0, reasoning: 0 };

  for (const row of filtered) {
    total += row.cost || 0;
    requests += 1;
    const kind = row.kind || 'chat';
    byKind[kind] = (byKind[kind] || 0) + (row.cost || 0);
    const day = dayKey(row.at);
    byDay[day] = (byDay[day] || 0) + (row.cost || 0);
    const rowTokens = row.tokens || {};
    tokens.input += rowTokens.input || 0;
    tokens.output += rowTokens.output || 0;
    tokens.hit += rowTokens.hit || 0;
    tokens.miss += rowTokens.miss || 0;
    tokens.reasoning += rowTokens.reasoning || 0;
  }

  return {
    total,
    requests,
    tokens,
    byKind,
    byDay,
    averagePerRequest: requests ? total / requests : 0,
  };
}

/** Прогноз месяца при разном уровне общения, по собственной средней стоимости. */
export function projectMonth({ averageCost, levels = [5, 15, 40], days = 30 }) {
  // Округляем до десятитысячных: суммы тут маленькие, и без округления
  // в интерфейс попадают числа вида 0,44999999999999996.
  return levels.map((perDay) => ({
    perDay,
    perMonth: Math.round(averageCost * perDay * days * 10_000) / 10_000,
  }));
}

export function budgetState({ spent = 0, budget = 0 }) {
  if (!budget || budget <= 0) return { percent: 0, level: 'none', spent, budget };
  const percent = spent / budget;
  let level = 'ok';
  if (percent >= 1) level = 'over';
  else if (percent >= 0.8) level = 'critical';
  else if (percent >= 0.5) level = 'warn';
  return { percent, level, spent, budget };
}
