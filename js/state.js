// Состояние приложения: настройки и записи выбранного дня.
// Простейший стор с подписками — экранов мало, полный перерисовки достаточно.
import * as db from './db.js';
import { DEFAULT_SETTINGS, dayTypeById, resolveDayTypeId, sumEntries } from './norm.js';
import { todayISO, uid } from './util.js';

const listeners = new Set();

export const store = {
  ready: false,
  settings: null,
  date: todayISO(),
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
    portion: data.portion || 'normal',
    // Базовые значения храним отдельно: множитель порции применяется к ним
    // при каждом сохранении, поэтому правка ничего не умножает дважды.
    base: data.base || null,
    kcal: Number(data.kcal) || 0,
    protein: Number(data.protein) || 0,
    fat: Number(data.fat) || 0,
    carbs: Number(data.carbs) || 0,
    comment: data.comment || '',
    source: data.source || 'manual',
    createdAt: Date.now(),
  };
  await db.put('entries', entry);
  if (entry.date === store.date) {
    store.entries = [...store.entries, entry];
  }
  emit();
  return entry;
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
  await db.remove('entries', id);
  store.entries = store.entries.filter((item) => item.id !== id);
  emit();
}

/** Ручное переключение типа дня: та же карта, что и исключения на даты. */
export async function setDayTypeOverride(date, typeId) {
  const overrides = { ...(store.settings.dateOverrides || {}) };
  if (typeId) overrides[date] = typeId;
  else delete overrides[date];
  await saveSettings({ dateOverrides: overrides });
}

export async function setPersistentStorageFlag(value) {
  store.storagePersistent = value;
  emit();
}
