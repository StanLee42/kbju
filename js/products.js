// Сохранённые продукты: КБЖУ на 100 г и пересчёт на вес порции.
//
// Арифметика и порядок списка вынесены в чистые функции: их проверяет node --test
// без браузера. Ошибка в арифметике тихо портит дневник, а глазами такое не ловится.
import * as db from './db.js';
import { uid } from './util.js';

const STORE = 'products';
const VALUES = ['kcal', 'protein', 'fat', 'carbs'];
const round1 = (value) => Math.round((Number(value) || 0) * 10) / 10;

/** Приводит набор значений к четырём числам: пустое становится нулём. */
export function values(source = {}) {
  const out = {};
  for (const key of VALUES) out[key] = round1(source?.[key]);
  return out;
}

/**
 * КБЖУ на 100 г из разбора: отношение сумм значений к сумме граммов.
 * Поле `basis` читать не нужно: у разбора с основой на 100 г сумма граммов
 * уже равна ста, и отношение даёт те же числа.
 */
export function per100g(items = []) {
  const list = items || [];
  const grams = list.reduce((sum, item) => sum + (Number(item?.grams) || 0), 0);
  if (!(grams > 0)) return values();

  const totals = list.reduce((acc, item) => {
    for (const key of VALUES) acc[key] += Number(item?.[key]) || 0;
    return acc;
  }, { kcal: 0, protein: 0, fat: 0, carbs: 0 });

  const out = {};
  for (const key of VALUES) out[key] = round1((totals[key] / grams) * 100);
  return out;
}

/** КБЖУ на вес порции: значения на 100 г, умноженные на вес. */
export function forWeight(per100 = {}, grams = 0) {
  const weight = Number(grams) || 0;
  const out = {};
  for (const key of VALUES) out[key] = round1(((Number(per100?.[key]) || 0) / 100) * weight);
  return out;
}

/** Проверка названия: без названия продукт не сохраняется. */
export function nameProblem(name) {
  return String(name || '').trim() ? null : 'Название не заполнено';
}

const nameKey = (name) => String(name || '').trim().toLowerCase();

export const ORDERS = [
  { id: 'frequency', label: 'По частоте' },
  { id: 'alpha', label: 'По алфавиту' },
];

/** Порядок списка: по частоте использования или по алфавиту названий. */
export function orderProducts(products = [], order = 'frequency') {
  const list = [...(products || [])];
  if (order === 'alpha') {
    return list.sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), 'ru'));
  }
  return list.sort((a, b) => (Number(b?.uses) || 0) - (Number(a?.uses) || 0)
    || (Number(b?.lastUsedAt) || 0) - (Number(a?.lastUsedAt) || 0));
}

/** Поиск по части названия без учёта регистра. */
export function searchProducts(products = [], query = '') {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [...(products || [])];
  return (products || []).filter((product) => String(product?.name || '').toLowerCase().includes(needle));
}

/** Подсказка при вводе: продукты, название которых начинается с набранного. */
export function matchByName(products = [], query = '', limit = 5) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [];
  return (products || [])
    .filter((product) => String(product?.name || '').trim().toLowerCase().startsWith(needle))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'))
    .slice(0, limit);
}

export async function listProducts() {
  return (await db.all(STORE)) || [];
}

export async function getProduct(id) {
  return (await db.get(STORE, id)) || null;
}

/**
 * Новые поля продукта: чего в данных нет, того нет и в наборе.
 * Иначе правка названия затирала бы счётчик использования и время последнего использования,
 * и продукт падал бы вниз списка после каждой правки.
 */
export function productPatch(data = {}) {
  const patch = {
    name: String(data.name || '').trim(),
    per100: values(data.per100 || data),
  };
  if (data.uses !== undefined) patch.uses = Math.max(0, Math.trunc(Number(data.uses) || 0));
  if (data.lastUsedAt !== undefined) patch.lastUsedAt = Number(data.lastUsedAt) || 0;
  return patch;
}

/**
 * Сохраняет продукт: создаёт новый или пишет поверх существующего.
 * Продукт с тем же названием обновляется, а не заводится второй раз.
 */
export async function saveProduct(data = {}) {
  const patch = productPatch(data);
  const problem = nameProblem(patch.name);
  if (problem) throw new Error(problem);

  const rows = await listProducts();
  const existing = data.id
    ? rows.find((row) => row.id === data.id)
    : rows.find((row) => nameKey(row.name) === nameKey(patch.name));

  const product = existing
    ? { ...existing, ...patch, id: existing.id }
    : { id: uid(), uses: 0, lastUsedAt: 0, ...patch, createdAt: Date.now() };

  await db.put(STORE, product);
  return product;
}

/** Отмечает использование продукта: счётчик и время последнего использования. */
export async function touchProduct(id) {
  const row = await getProduct(id);
  if (!row) return null;
  const product = { ...row, uses: (Number(row.uses) || 0) + 1, lastUsedAt: Date.now() };
  await db.put(STORE, product);
  return product;
}

export function removeProduct(id) {
  return db.remove(STORE, id);
}

/** Позиция разбора из продукта: числа считаются по весу порции. */
export function itemFromProduct(product, grams) {
  return {
    name: String(product?.name || '').trim() || 'продукт',
    grams: round1(Number(grams) || 0),
    ...forWeight(product?.per100, grams),
  };
}

/**
 * Поля записи дневника из продукта: вес, числа по весу и снимок значений на 100 г.
 * Снимок едет с записью, чтобы правка продукта не меняла прошлые дни. Модель здесь
 * не вызывается, поэтому и расход не растёт: поля стоимости в записи нет.
 */
export function entryFromProduct({ product, grams, date, time }) {
  const item = itemFromProduct(product, grams);
  return {
    date,
    time,
    name: item.name,
    grams: item.grams,
    kcal: item.kcal,
    protein: item.protein,
    fat: item.fat,
    carbs: item.carbs,
    source: 'product',
    productId: product?.id || null,
    per100: values(product?.per100),
  };
}
