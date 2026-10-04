// Разбор и проверка ответа модели.
//
// Модель обязана вернуть объект по схеме, но на практике она оборачивает JSON в ```,
// пишет числа строками, отдаёт items объектом вместо массива или обрывается на середине.
// Здесь всё это приводится к одному виду, а неисправимое возвращается как ошибка.
import { num } from '../util.js';

const SOURCES = new Set(['label', 'estimate']);
const BASES = new Set(['per_100g', 'per_portion', 'per_package']);
const CONFIDENCE = new Set(['high', 'medium', 'low']);

/** Убирает обёртку из markdown-кода и лишний текст вокруг объекта. */
export function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;

  try {
    return JSON.parse(candidate);
  } catch {
    // Ищем первый { и последний } — так выживает ответ с пояснением вокруг.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function normalizeItem(item, index, warnings) {
  if (!item || typeof item !== 'object') {
    warnings.push(`позиция ${index + 1} не объект и пропущена`);
    return null;
  }

  const name = String(item.name || '').trim();
  if (!name) {
    warnings.push(`позиция ${index + 1} без названия и пропущена`);
    return null;
  }

  const grams = num(item.grams);
  if (!(grams > 0)) {
    warnings.push(`у позиции «${name}» не указан вес, позиция пропущена`);
    return null;
  }

  return {
    name,
    grams,
    kcal: Math.max(0, num(item.kcal)),
    protein: Math.max(0, num(item.protein)),
    fat: Math.max(0, num(item.fat)),
    carbs: Math.max(0, num(item.carbs)),
  };
}

export function totalsOf(items) {
  return (items || []).reduce((acc, item) => ({
    kcal: acc.kcal + item.kcal,
    protein: acc.protein + item.protein,
    fat: acc.fat + item.fat,
    carbs: acc.carbs + item.carbs,
  }), { kcal: 0, protein: 0, fat: 0, carbs: 0 });
}

/**
 * Проверяет ответ модели.
 * @returns {{ok: true, data: object} | {ok: false, error: string}}
 */
export function parseAnalysis(text) {
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'ответ не является JSON' };
  }

  const warnings = [];
  const rawItems = Array.isArray(parsed.items)
    ? parsed.items
    : (parsed.items && typeof parsed.items === 'object' ? Object.values(parsed.items) : []);

  if (!rawItems.length) return { ok: false, error: 'в ответе нет ни одной позиции' };

  const items = rawItems
    .map((item, index) => normalizeItem(item, index, warnings))
    .filter(Boolean);

  if (!items.length) return { ok: false, error: 'все позиции оказались без веса или без названия' };

  const source = SOURCES.has(parsed.source) ? parsed.source : 'estimate';
  if (!SOURCES.has(parsed.source)) warnings.push('источник не указан, считаем оценкой');

  const basis = BASES.has(parsed.basis) ? parsed.basis : 'per_portion';
  if (!BASES.has(parsed.basis)) warnings.push('базис не указан, считаем порционным');

  return {
    ok: true,
    data: {
      dish: String(parsed.dish || '').trim() || items[0].name,
      source,
      basis,
      packageWeight: parsed.packageWeight === null || parsed.packageWeight === undefined
        ? null
        : num(parsed.packageWeight) || null,
      items,
      totals: totalsOf(items),
      confidence: CONFIDENCE.has(parsed.confidence) ? parsed.confidence : 'low',
      assumptions: String(parsed.assumptions || '').trim(),
      warnings,
    },
  };
}

/** Разбор отчёта биоимпеданса: набор измерений, без позиций. */
export function parseImpedance(text) {
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'ответ не является JSON' };
  }

  const numericKeys = [
    'age', 'height', 'weight', 'waist', 'hips', 'bmi', 'fatMass', 'leanMass',
    'activeCellMass', 'skeletalMuscleMass', 'totalWater', 'extracellularWater',
    'boneMineralMass', 'bmr', 'fatPercent',
  ];

  const data = {};
  for (const key of numericKeys) {
    const value = num(parsed[key], NaN);
    data[key] = Number.isFinite(value) && value !== 0 ? value : null;
  }

  data.date = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date || '')) ? parsed.date : null;
  data.sex = parsed.sex === 'M' || parsed.sex === 'F' ? parsed.sex : null;
  data.confidence = CONFIDENCE.has(parsed.confidence) ? parsed.confidence : 'low';
  data.assumptions = String(parsed.assumptions || '').trim();

  const hasAnything = data.weight || data.leanMass || data.bmr || data.fatMass;
  if (!hasAnything) return { ok: false, error: 'в ответе нет измерений' };

  return { ok: true, data };
}
