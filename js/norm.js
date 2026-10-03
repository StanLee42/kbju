// Нормы, типы дней и расписание. Здесь только вычисления, никакого DOM.
import { isoDate, todayISO, daysBetween, weekdayKey } from './util.js';

export const DEFAULT_SETTINGS = {
  id: 'app',
  schema: 1,
  goal: { mode: 'lose', pace: 0.5 },
  dayTypes: [
    { id: 'rest', name: 'Обычный день', kcal: 2000, protein: 130, fat: 65, carbs: 200 },
    { id: 'train', name: 'Тренировка', kcal: 2400, protein: 150, fat: 70, carbs: 260 },
  ],
  schedule: {
    mode: 'week', // 'week' | 'cycle'
    week: { mon: 'rest', tue: 'rest', wed: 'train', thu: 'rest', fri: 'train', sat: 'rest', sun: 'rest' },
    cycle: { length: 4, trainPositions: [1, 3], startDate: isoDate(new Date()) },
  },
  // Исключения на конкретные даты и ручные переключения — один и тот же механизм.
  dateOverrides: {},
};

export const MACROS = [
  { key: 'kcal', label: 'Калории', unit: 'ккал', color: 'var(--kcal)' },
  { key: 'protein', label: 'Белки', unit: 'г', color: 'var(--protein)' },
  { key: 'fat', label: 'Жиры', unit: 'г', color: 'var(--fat)' },
  { key: 'carbs', label: 'Углеводы', unit: 'г', color: 'var(--carbs)' },
];

export function dayTypeById(settings, id) {
  const types = settings?.dayTypes || [];
  return types.find((type) => type.id === id) || types[0];
}

export function resolveDayTypeId(dateISO, settings) {
  const override = settings?.dateOverrides?.[dateISO];
  if (override && (settings.dayTypes || []).some((type) => type.id === override)) return override;

  const schedule = settings?.schedule;
  const fallback = (settings?.dayTypes || [])[0]?.id;

  if (!schedule) return fallback;

  if (schedule.mode === 'cycle') {
    const { length = 2, trainPositions = [], startDate } = schedule.cycle || {};
    if (!startDate || length < 1) return fallback;
    const diff = daysBetween(startDate, dateISO);
    const index = ((diff % length) + length) % length;
    const position = index + 1;
    return trainPositions.includes(position) ? 'train' : 'rest';
  }

  const key = weekdayKey(dateISO);
  return schedule.week?.[key] || fallback;
}

export function emptyTotals() {
  return { kcal: 0, protein: 0, fat: 0, carbs: 0 };
}

export function sumEntries(entries) {
  const totals = emptyTotals();
  for (const entry of entries || []) {
    totals.kcal += Number(entry.kcal) || 0;
    totals.protein += Number(entry.protein) || 0;
    totals.fat += Number(entry.fat) || 0;
    totals.carbs += Number(entry.carbs) || 0;
  }
  return totals;
}

/** Остаток до нормы: отрицательное значение означает перебор. */
export function remaining(norm, totals) {
  const result = {};
  for (const { key } of MACROS) {
    result[key] = (Number(norm?.[key]) || 0) - (Number(totals?.[key]) || 0);
  }
  return result;
}

export function ratio(value, max) {
  const limit = Number(max) || 0;
  if (limit <= 0) return 0;
  return (Number(value) || 0) / limit;
}

export function byTimeAscending(entries) {
  return [...(entries || [])].sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
}

export function describeSchedule(settings, dateISO = todayISO()) {
  const typeId = resolveDayTypeId(dateISO, settings);
  const type = dayTypeById(settings, typeId);
  const schedule = settings?.schedule;
  const isCycle = schedule?.mode === 'cycle';
  const override = settings?.dateOverrides?.[dateISO];
  return {
    typeId,
    type,
    isCycle,
    isOverride: Boolean(override),
    source: override ? 'вручную' : (isCycle ? 'по циклу' : 'по дню недели'),
  };
}
