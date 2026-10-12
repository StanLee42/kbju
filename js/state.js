// Состояние приложения: настройки и записи выбранного дня.
// Простейший стор с подписками: экранов мало, полной перерисовки достаточно.
import * as db from './db.js';
import { DEFAULT_SETTINGS, dayTypeById, resolveDayTypeId, scheduledDayTypeId, sumEntries } from './norm.js';
import { entryFromProduct } from './products.js';
import { todayISO, uid } from './util.js';

const listeners = new Set();

export const store = {
  ready: false,
  settings: null,
  date: todayISO(),
  // Дата, с которой приложение открылось: по ней понимаем, что сутки сменились,
  // пока оно лежало в памяти.
  openedOn: todayISO(),
  entries: [],
  storagePersistent: null,
};

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) {
    try {
      listener(store);
    } catch (error) {
      console.error('listener failed', error);
    }
  }
}

function normalizeSettings(saved) {
  const base = structuredClone(DEFAULT_SETTINGS);
  if (!saved) return base;
  const merged = {
    ...base,
    ...saved,
    goal: { ...base.goal, ...(saved.goal || {}) },
    provider: { ...base.provider, ...(saved.provider || {}) },
    budget: { ...base.budget, ...(saved.budget || {}) },
    prices: saved.prices || null,
    dayTypes: Array.isArray(saved.dayTypes) && saved.dayTypes.length ? saved.dayTypes : base.dayTypes,
    schedule: {
      ...base.schedule,
      ...(saved.schedule || {}),
      week: { ...base.schedule.week, ...(saved.schedule?.week || {}) },
      cycle: { ...base.schedule.cycle, ...(saved.schedule?.cycle || {}) },
    },
    dateOverrides: { ...(saved.dateOverrides || {}) },
  };
  return merged;
}

export async function init() {
  const saved = await db.get('settings', 'app').catch(() => null);
  store.settings = normalizeSettings(saved);
  if (!saved) await db.put('settings', store.settings).catch(() => {});
  store.date = todayISO();
  store.entries = await db.byIndex('entries', 'date', store.date).catch(() => []);
  store.ready = true;
  emit();
}

export async function loadDay(date) {
  store.date = date;
  store.entries = await db.byIndex('entries', 'date', date).catch(() => []);
  emit();
}

/**
 * Переходит на новый день, если сутки сменились, пока приложение было открыто.
 *
 * Телефон держит приложение в памяти, и утром в нём всё ещё вчерашний день: тогда и записи
 * уходили бы во вчерашний дневник, а человек видел бы старую дату как сегодняшнюю.
 * Прошлый день, открытый нарочно, не трогаем: возвращаемся только если смотрели сегодняшний.
 */
export async function refreshToday() {
  const today = todayISO();
  if (store.date === today || store.date !== store.openedOn) return false;
  store.openedOn = today;
  await loadDay(today);
  return true;
}

export async function saveSettings(patch) {
  store.settings = normalizeSettings({ ...store.settings, ...patch });
  await db.put('settings', store.settings);
  emit();
}

export async function reloadSettings() {
  const saved = await db.get('settings', 'app');
  if (saved) store.settings = normalizeSettings(saved);
  emit();
}

export function dayType() {
  const id = resolveDayTypeId(store.date, store.settings);
  return dayTypeById(store.settings, id);
}

export function totals() {
  return sumEntries(store.entries);
}

export async function addEntry(data) {
  const entry = {
    id: uid(),
    date: data.date || store.date,
    time: data.time || '12:00',
    name: String(data.name || '').trim() || 'Без названия',
    grams: data.grams === '' || data.grams === undefined || data.grams === null ? null : Number(data.grams),
    kcal: Number(data.kcal) || 0,
    protein: Number(data.protein) || 0,
    fat: Number(data.fat) || 0,
    carbs: Number(data.carbs) || 0,
    comment: data.comment || '',
    source: data.source || 'manual',
    // Поля, которые заполняются только у записей из фотографии.
    items: Array.isArray(data.items) ? data.items : null,
    thumbId: data.thumbId || null,
    basis: data.basis || null,
    confidence: data.confidence || null,
    assumptions: data.assumptions || '',
    cost: Number(data.cost) || 0,
    // Поля записи из сохранённого продукта: откуда пришла и по каким числам считалась.
    productId: data.productId || null,
    per100: data.per100 || null,
    createdAt: Date.now(),
  };
  await db.put('entries', entry);
  if (entry.date === store.date) {
    store.entries = [...store.entries, entry];
  }
  emit();
  return entry;
}

/**
 * Запись в дневник из сохранённого продукта: числа считаются по весу порции.
 * Модель не вызывается, поэтому запись не стоит токенов и по строке в расход не попадает.
 */
export async function addEntryFromProduct({ product, grams, date, time }) {
  return addEntry(entryFromProduct({ product, grams, date, time }));
}

export async function updateEntry(entry) {
  await db.put('entries', entry);
  if (entry.date === store.date) {
    store.entries = store.entries.map((item) => (item.id === entry.id ? entry : item));
  } else {
    store.entries = store.entries.filter((item) => item.id !== entry.id);
  }
  emit();
  return entry;
}

export async function deleteEntry(id) {
  const entry = store.entries.find((item) => item.id === id);
  await db.remove('entries', id);
  // Превью удаляем вместе с записью, иначе картинки копятся в хранилище навсегда.
  if (entry?.thumbId) await db.removeThumb(entry.thumbId).catch(() => {});
  store.entries = store.entries.filter((item) => item.id !== id);
  emit();
}

/** Превью фотографии: сохраняем отдельно от записи. */
export async function saveThumb(thumb) {
  await db.putThumb(thumb.id, thumb.blob);
  return thumb.id;
}

export function loadThumb(id) {
  return db.getThumb(id);
}

/** Ручное переключение типа дня: та же карта, что и исключения на даты.
 *  Если выбран тип, который и так назначен расписанием, исключение убирается,
 *  иначе в настройках копились бы записи, ничего не меняющие. */
export async function setDayTypeOverride(date, typeId) {
  const overrides = { ...(store.settings.dateOverrides || {}) };
  if (typeId && typeId !== scheduledDayTypeId(date, store.settings)) overrides[date] = typeId;
  else delete overrides[date];
  await saveSettings({ dateOverrides: overrides });
}

export async function setPersistentStorageFlag(value) {
  store.storagePersistent = value;
  emit();
}
