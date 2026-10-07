// Нормы, типы дней и расписание. Здесь только вычисления, никакого DOM.
import { isoDate, todayISO, daysBetween, weekdayKey, num, round } from './util.js';

export const DEFAULT_SETTINGS = {
  id: 'app',
  schema: 1,
  goal: { mode: 'lose', pace: 0.5 },
  // Провайдер анализа. Ключ хранится только на устройстве и в выгрузки не попадает.
  provider: { id: 'deepseek', model: 'deepseek-flash', key: '' },
  // null означает «использовать таблицу цен по умолчанию» из js/usage.js.
  prices: null,
  budget: { monthly: 0 },
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

/** Тип дня строго по расписанию, без учёта ручных исключений. */
export function scheduledDayTypeId(dateISO, settings) {
  const withoutOverrides = settings?.dateOverrides
    ? { ...settings, dateOverrides: {} }
    : settings;
  return resolveDayTypeId(dateISO, withoutOverrides);
}

export function emptyTotals() {
  return { kcal: 0, protein: 0, fat: 0, carbs: 0 };
}export function sumEntries(entries) {
  const totals = emptyTotals();
  for (const entry of entries || []) {
    totals.kcal += Number(entry.kcal) || 0;
    totals.protein += Number(entry.protein) || 0;
    totals.fat += Number(entry.fat) || 0;
    totals.carbs += Number(entry.carbs) || 0;
  }
  return totals;
}

/** Калории по макросам: 4 ккал на грамм белков и углеводов, 9 на грамм жиров. */
export function kcalFromMacros({ protein = 0, fat = 0, carbs = 0 } = {}) {
  return 4 * num(protein) + 9 * num(fat) + 4 * num(carbs);
}

/**
 * Пересчитывает БЖУ под заданные калории, сохраняя их соотношение.
 *
 * Нужно, когда человек меняет калории дня руками: раньше числа БЖУ оставались прежними,
 * и день начинал врать — калории одни, а макросы от другого плана. Держим форму дня:
 * умножаем белки, жиры и углеводы на одно и то же число.
 */
export function macrosForKcal(macros = {}, targetKcal) {
  const current = kcalFromMacros(macros);
  const target = num(targetKcal);
  if (current <= 0 || target <= 0) {
    return { protein: num(macros.protein), fat: num(macros.fat), carbs: num(macros.carbs) };
  }
  const factor = target / current;
  return {
    protein: round(num(macros.protein) * factor, 1),
    fat: round(num(macros.fat) * factor, 1),
    carbs: round(num(macros.carbs) * factor, 1),
  };
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

// ---------------------------------------------------------------------------
// Расчёт норм из измеренного состава тела.
//
// Считаем здесь, а не в модели: формулы арифметические, их можно проверить тестами,
// а результат не зависит от настроения модели.
// ---------------------------------------------------------------------------

export const NORM_DEFAULTS = {
  proteinPerKgLean: 1.9, // середина диапазона 1,6–2,2 г на кг тощей массы
  fatPerKgMin: 0.8,
  fatPerKgTraining: 0.9,
  kcalPerKgFat: 7700, // калорий в килограмме жировой ткани
  activityRest: 1.375, // лёгкая активность без тренировки
  trainingExtraKcal: 400, // час силовой работы при весе около 90 кг
  deficitShareTraining: 0.7, // в тренировочный день дефицит меньше
};

/** Основной обмен по формуле Миффлина — запасной путь, когда измерения нет. */
export function mifflinStJeor({ sex, weight, height, age }) {
  if (!weight || !height || !age) return null;
  const base = 10 * weight + 6.25 * height - 5 * age;
  if (sex === 'F') return round(base - 161);
  if (sex === 'M') return round(base + 5);
  return round(base - 78); // среднее между полами
}

/**
 * Нормы на тренировочный и обычный день по составу тела.
 *
 * @returns {{ok: false, error: string} | {ok: true, rest: object, training: object,
 *   weekly: object, base: object, steps: string[], assumptions: string[]}}
 */
export function normsFromMeasurement({
  measurement = {},
  pace = 0.5,
  trainingDays = 3,
  restDays = 4,
  defaults = NORM_DEFAULTS,
} = {}) {
  const assumptions = [];
  const steps = [];

  const weight = num(measurement.weight) || null;
  const leanMass = num(measurement.leanMass) || null;
  const bmrMeasured = num(measurement.bmr) || null;

  let bmr = bmrMeasured;
  if (bmr) {
    steps.push(`Основной обмен ${round(bmr)} ккал взят из отчёта, это измеренное значение.`);
  } else {
    bmr = mifflinStJeor({
      sex: measurement.sex,
      weight: measurement.weight,
      height: measurement.height,
      age: measurement.age,
    });
    if (!bmr) {
      return { ok: false, error: 'не хватает данных: нужен измеренный основной обмен либо пол, вес, рост и возраст' };
    }
    assumptions.push('Измеренного основного обмена нет, взят расчёт по формуле Миффлина.');
    steps.push(`Основной обмен ${round(bmr)} ккал посчитан по формуле Миффлина.`);
  }

  if (!weight) return { ok: false, error: 'не хватает массы тела для расчёта жиров' };

  let lean = leanMass;
  if (!lean) {
    lean = round(weight * 0.75, 1);
    assumptions.push('Тощая масса неизвестна, принята как 75% от массы тела — это грубая оценка.');
  }

  const tdeeRest = bmr * defaults.activityRest;
  const tdeeTraining = tdeeRest + defaults.trainingExtraKcal;
  steps.push(`Расход обычного дня ${round(tdeeRest)} ккал: ${round(bmr)} × ${defaults.activityRest}.`);
  assumptions.push(`Коэффициент активности ${defaults.activityRest} принят для лёгкой активности.`);
  steps.push(`Расход тренировочного дня ${round(tdeeTraining)} ккал: плюс ${defaults.trainingExtraKcal} ккал на тренировку.`);
  assumptions.push(`Расход тренировки принят ${defaults.trainingExtraKcal} ккал — час силовой работы с разминкой.`);

  const weeklyDeficit = pace * defaults.kcalPerKgFat;
  const share = restDays + defaults.deficitShareTraining * trainingDays;
  const deficitRest = weeklyDeficit / share;
  const deficitTraining = deficitRest * defaults.deficitShareTraining;
  steps.push(`Недельный дефицит ${round(weeklyDeficit)} ккал под темп ${pace} кг в неделю.`);
  steps.push(`Дефицит ${round(deficitRest)} ккал в обычный день и ${round(deficitTraining)} в тренировочный: в дни нагрузки он мягче.`);

  const protein = round(defaults.proteinPerKgLean * lean);
  steps.push(`Белок ${protein} г: тощая масса ${lean} кг × ${defaults.proteinPerKgLean} г/кг.`);

  const fatRest = round(defaults.fatPerKgMin * weight);
  const fatTraining = round(defaults.fatPerKgTraining * weight);
  steps.push(`Жир ${fatRest} г в обычный день и ${fatTraining} г в тренировочный — от массы тела ${weight} кг.`);

  const kcalRest = round(tdeeRest - deficitRest);
  const kcalTraining = round(tdeeTraining - deficitTraining);

  const carbsOf = (kcal, fat) => Math.max(0, round((kcal - protein * 4 - fat * 9) / 4));
  const carbsRest = carbsOf(kcalRest, fatRest);
  const carbsTraining = carbsOf(kcalTraining, fatTraining);
  steps.push(`Углеводы добирают остаток калорий: ${carbsRest} г и ${carbsTraining} г.`);

  const weeklyKcal = (kcalRest * restDays + kcalTraining * trainingDays) / (restDays + trainingDays);
  const weeklyDeficitActual = deficitRest * restDays + deficitTraining * trainingDays;
  steps.push(`Среднее по неделе ${round(weeklyKcal)} ккал, недельный дефицит ${round(weeklyDeficitActual)} ккал.`);

  return {
    ok: true,
    base: { bmr: round(bmr), leanMass: lean, weight, pace, measuredBmr: Boolean(bmrMeasured) },
    rest: { kcal: kcalRest, protein, fat: fatRest, carbs: carbsRest },
    training: { kcal: kcalTraining, protein, fat: fatTraining, carbs: carbsTraining },
    weekly: {
      kcal: round(weeklyKcal),
      deficit: round(weeklyDeficitActual),
      expectedLossKg: round(weeklyDeficitActual / defaults.kcalPerKgFat, 2),
    },
    steps,
    assumptions,
  };
}
