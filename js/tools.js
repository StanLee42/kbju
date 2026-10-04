// Операции над дневником. Их будет вызывать ассистент, когда появится чат:
// модель не считает сама, а спрашивает приложение и получает точные числа.
//
// Вычисления вынесены в чистые функции: их можно проверить тестами без браузера,
// а тонкие обёртки только читают состояние и хранилище.
import * as db from './db.js';
import { dayTypeById, resolveDayTypeId, sumEntries } from './norm.js';
import { addEntry, store } from './state.js';
import { addDays, round, todayISO } from './util.js';

// ---------------------------------------------------------------------------
// Чистые вычисления
// ---------------------------------------------------------------------------

export function dayOverview({ date, settings, entries = [] }) {
  const type = dayTypeById(settings, resolveDayTypeId(date, settings));
  const eaten = sumEntries(entries);
  const remaining = {
    kcal: (type.kcal || 0) - eaten.kcal,
    protein: (type.protein || 0) - eaten.protein,
    fat: (type.fat || 0) - eaten.fat,
    carbs: (type.carbs || 0) - eaten.carbs,
  };
  return {
    date,
    dayType: { id: type.id, name: type.name },
    norm: { kcal: type.kcal, protein: type.protein, fat: type.fat, carbs: type.carbs },
    eaten: {
      kcal: round(eaten.kcal), protein: round(eaten.protein),
      fat: round(eaten.fat), carbs: round(eaten.carbs),
    },
    remaining: {
      kcal: round(remaining.kcal), protein: round(remaining.protein),
      fat: round(remaining.fat), carbs: round(remaining.carbs),
    },
    entries: entries
      .slice()
      .sort((a, b) => String(a.time).localeCompare(String(b.time)))
      .map((entry) => ({
        time: entry.time,
        name: entry.name,
        grams: entry.grams,
        kcal: round(entry.kcal),
        protein: round(entry.protein),
        fat: round(entry.fat),
        carbs: round(entry.carbs),
        source: entry.source,
      })),
  };
}

export function historyOverview({ days = 7, today = todayISO(), entriesByDate = {}, measurements = [] }) {
  const result = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = addDays(today, -offset);
    const eaten = sumEntries(entriesByDate[date] || []);
    result.push({
      date,
      kcal: round(eaten.kcal),
      protein: round(eaten.protein),
      fat: round(eaten.fat),
      carbs: round(eaten.carbs),
      entries: (entriesByDate[date] || []).length,
    });
  }

  const withFood = result.filter((day) => day.entries > 0);
  const average = withFood.length
    ? {
      kcal: round(withFood.reduce((sum, day) => sum + day.kcal, 0) / withFood.length),
      protein: round(withFood.reduce((sum, day) => sum + day.protein, 0) / withFood.length),
      fat: round(withFood.reduce((sum, day) => sum + day.fat, 0) / withFood.length),
      carbs: round(withFood.reduce((sum, day) => sum + day.carbs, 0) / withFood.length),
    }
    : null;

  const sortedMeasurement = measurements
    .filter((item) => item.weight)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  return {
    days: result,
    average,
    daysWithFood: withFood.length,
    weight: sortedMeasurement.length
      ? {
        first: sortedMeasurement[0].weight,
        last: sortedMeasurement[sortedMeasurement.length - 1].weight,
        change: round(sortedMeasurement[sortedMeasurement.length - 1].weight - sortedMeasurement[0].weight, 1),
        measurements: sortedMeasurement.length,
      }
      : null,
  };
}

/** Проверка аргументов вызова инструмента: модель может прислать что угодно. */
export function validateArgs(spec, args = {}) {
  const problems = [];
  const properties = spec.parameters?.properties || {};

  for (const key of spec.parameters?.required || []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      problems.push(`не передан обязательный параметр ${key}`);
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const definition = properties[key];
    if (!definition) {
      problems.push(`неизвестный параметр ${key}`);
      continue;
    }
    if (definition.type === 'number' && value !== null && value !== undefined
      && !Number.isFinite(Number(value))) {
      problems.push(`${key} должен быть числом`);
    }
    if (definition.minimum !== undefined && Number(value) < definition.minimum) {
      problems.push(`${key} не может быть меньше ${definition.minimum}`);
    }
    if (definition.maximum !== undefined && Number(value) > definition.maximum) {
      problems.push(`${key} не может быть больше ${definition.maximum}`);
    }
    if (definition.enum && !definition.enum.includes(value)) {
      problems.push(`${key} должен быть одним из: ${definition.enum.join(', ')}`);
    }
  }

  return problems.length ? { ok: false, error: problems.join('; ') } : { ok: true };
}

const number = (description, extra = {}) => ({ type: 'number', description, ...extra });

export const TOOL_SPECS = [
  {
    name: 'get_today',
    description: 'Что съедено сегодня: нормы дня, съеденное, остаток и список записей.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_history',
    description: 'Итоги по дням за период: калории и БЖУ по каждому дню, средние и динамика веса.',
    parameters: {
      type: 'object',
      properties: { days: number('сколько дней назад смотреть', { minimum: 1, maximum: 90 }) },
      required: [],
    },
  },
  {
    name: 'add_entry',
    description: 'Записать еду в дневник. Требует названия; КБЖУ можно не указывать, тогда они нулевые.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'что съедено' },
        grams: number('вес порции в граммах', { minimum: 0, maximum: 5000 }),
        kcal: number('калории порции', { minimum: 0, maximum: 5000 }),
        protein: number('белки, г', { minimum: 0, maximum: 500 }),
        fat: number('жиры, г', { minimum: 0, maximum: 500 }),
        carbs: number('углеводы, г', { minimum: 0, maximum: 500 }),
        time: { type: 'string', description: 'время в формате ЧЧ:ММ' },
        comment: { type: 'string', description: 'пояснение' },
      },
      required: ['name'],
    },
  },
  {
    name: 'log_water',
    description: 'Записать выпитую воду в миллилитрах.',
    parameters: {
      type: 'object',
      properties: { ml: number('объём в миллилитрах', { minimum: 1, maximum: 5000 }) },
      required: ['ml'],
    },
  },
  {
    name: 'log_weight',
    description: 'Записать вес тела в килограммах.',
    parameters: {
      type: 'object',
      properties: {
        kg: number('вес в килограммах', { minimum: 20, maximum: 300 }),
        date: { type: 'string', description: 'дата в формате ГГГГ-ММ-ДД, по умолчанию сегодня' },
      },
      required: ['kg'],
    },
  },
  {
    name: 'save_dish',
    description: 'Запомнить блюдо, чтобы в следующий раз считать его по сохранённым значениям.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'название блюда' },
        grams: number('обычный вес порции', { minimum: 1, maximum: 5000 }),
        kcal: number('калории на эту порцию', { minimum: 0, maximum: 5000 }),
        protein: number('белки на порцию', { minimum: 0, maximum: 500 }),
        fat: number('жиры на порцию', { minimum: 0, maximum: 500 }),
        carbs: number('углеводы на порцию', { minimum: 0, maximum: 500 }),
      },
      required: ['name'],
    },
  },
  {
    name: 'list_dishes',
    description: 'Список сохранённых блюд с их значениями.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

// ---------------------------------------------------------------------------
// Обёртки: читают состояние и хранилище, меняют данные
// ---------------------------------------------------------------------------

async function entriesByDate(days) {
  const today = todayISO();
  const result = {};
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDays(today, -offset);
    result[date] = await db.byIndex('entries', 'date', date);
  }
  return result;
}

export const TOOL_HANDLERS = {
  async get_today() {
    return dayOverview({
      date: store.date,
      settings: store.settings,
      entries: store.entries,
    });
  },

  async get_history({ days = 7 } = {}) {
    const map = await entriesByDate(days);
    const measurements = await db.all('measurements').catch(() => []);
    return historyOverview({ days, today: todayISO(), entriesByDate: map, measurements });
  },

  async add_entry(args) {
    const entry = await addEntry({
      name: args.name,
      grams: args.grams,
      kcal: args.kcal || 0,
      protein: args.protein || 0,
      fat: args.fat || 0,
      carbs: args.carbs || 0,
      time: args.time,
      comment: args.comment || '',
      source: 'assistant',
    });
    return { saved: true, id: entry.id, name: entry.name };
  },

  async log_water({ ml }) {
    const date = todayISO();
    const existing = await db.get('water', date).catch(() => null);
    const record = { id: date, ml: (existing?.ml || 0) + ml };
    await db.put('water', record);
    return { date, totalMl: record.ml };
  },

  async log_weight({ kg, date }) {
    const day = date || todayISO();
    const record = { id: day, date: day, weight: kg };
    await db.put('measurements', record);
    return { date: day, weight: kg };
  },

  async save_dish(args) {
    const name = String(args.name || '').trim();
    const existing = await db.all('dishes').catch(() => []);
    const same = existing.find((dish) => dish.name.toLowerCase() === name.toLowerCase());
    const record = {
      id: same?.id || `dish-${Date.now()}`,
      name,
      grams: args.grams || same?.grams || null,
      kcal: args.kcal ?? same?.kcal ?? 0,
      protein: args.protein ?? same?.protein ?? 0,
      fat: args.fat ?? same?.fat ?? 0,
      carbs: args.carbs ?? same?.carbs ?? 0,
      usageCount: (same?.usageCount || 0) + 1,
      lastUsed: new Date().toISOString(),
    };
    await db.put('dishes', record);
    return { saved: true, name: record.name, updated: Boolean(same) };
  },

  async list_dishes() {
    const dishes = await db.all('dishes').catch(() => []);
    return {
      dishes: dishes
        .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0))
        .map((dish) => ({
          name: dish.name, grams: dish.grams, kcal: dish.kcal,
          protein: dish.protein, fat: dish.fat, carbs: dish.carbs,
          times: dish.usageCount || 0,
        })),
    };
  },
};

export function toolSpec(name) {
  return TOOL_SPECS.find((spec) => spec.name === name) || null;
}

/** Вызов инструмента по имени с проверкой аргументов. */
export async function callTool(name, args = {}) {
  const spec = toolSpec(name);
  if (!spec) return { ok: false, error: `инструмент ${name} не найден` };

  const checked = validateArgs(spec, args);
  if (!checked.ok) return { ok: false, error: `неверные аргументы: ${checked.error}` };

  const handler = TOOL_HANDLERS[name];
  if (!handler) return { ok: false, error: `инструмент ${name} объявлен, но не реализован` };

  try {
    return { ok: true, result: await handler(args) };
  } catch (error) {
    // Ошибка инструмента возвращается модели как результат, а не как падение.
    return { ok: false, error: String(error?.message || error) };
  }
}
