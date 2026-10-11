// Разговор о еде между перезагрузками страницы.
//
// Приложение перезагружает страницу само, когда на устройство приходит новая сборка.
// До этого разговор жил только в памяти открытого окна, и вместе со страницей пропадали
// набранный текст, переписка и посчитанные числа. Здесь разговор ложится в sessionStorage:
// он переживает перезагрузку, но умирает вместе с сессией приложения, поэтому вчерашние
// числа не всплывают сами собой.
//
// Записей две. Снимки отправленных сообщений весят сотни килобайт, а набранный текст пишется
// на каждое нажатие клавиши: под одним ключом каждая буква переписывала бы весь разговор.
const CHAT_KEY = 'kbju-food-chat';
const TYPED_KEY = 'kbju-food-chat-text';

// Форма записи. Запись чужой версии не разбирается: разговор дня проще потерять, чем
// восстановить неверно и записать в дневник не то.
const VERSION = 1;

const ROLES = ['user', 'assistant'];

/** Хранилище берём из аргумента: так проверки работают без браузера. */
function store(storage) {
  if (storage) return storage;
  try {
    return globalThis.sessionStorage || null;
  } catch {
    // Браузер с запрещёнными данными сайта: разговор просто не сохранится.
    return null;
  }
}

function read(target, key) {
  try {
    return target.getItem(key);
  } catch {
    return null;
  }
}

function write(target, key, value) {
  try {
    target.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function drop(target, key) {
  try {
    target.removeItem(key);
  } catch {
    // Стереть не вышло: данные и так недоступны.
  }
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Разбор от модели: проверяем форму, чтобы испорченная запись не сломала отрисовку. */
function cleanAnalysis(value) {
  if (!value || typeof value !== 'object') return null;
  const analysis = { ...value };
  if (typeof analysis.dish !== 'string') analysis.dish = '';
  if (!Array.isArray(analysis.items)) delete analysis.items;
  if (typeof analysis.question !== 'string') delete analysis.question;
  return analysis;
}

function cleanMessage(value) {
  if (!value || typeof value !== 'object') return null;
  if (!ROLES.includes(value.role)) return null;

  if (value.role === 'user') {
    const text = typeof value.text === 'string' ? value.text : '';
    const photo = typeof value.photo === 'string' && value.photo.startsWith('data:') ? value.photo : null;
    if (!text && !photo) return null;
    return { role: 'user', text, photo };
  }

  const analysis = cleanAnalysis(value.analysis);
  const error = value.error && typeof value.error === 'object' ? value.error : null;
  if (!analysis && !error) return null;
  return { role: 'assistant', analysis, error };
}

/** Полоса черновика: по ней записывается блюдо, поэтому без позиций она не годится. */
function cleanCurrent(value) {
  if (!value || typeof value !== 'object') return null;
  if (!Array.isArray(value.items) || !value.items.length) return null;
  if (!value.totals || typeof value.totals !== 'object') return null;
  return {
    items: value.items,
    totals: value.totals,
  };
}

/**
 * Кладёт разговор в хранилище. Пустой разговор не хранится: окно открывают и закрывают,
 * ничего не сказав.
 */
export function saveChat({
  date = '', messages = [], draft = null, current = null, cost = 0,
} = {}, { storage = null } = {}) {
  const target = store(storage);
  if (!target) return false;

  const kept = (messages || []).map(cleanMessage).filter(Boolean);
  const chat = {
    v: VERSION,
    date: typeof date === 'string' ? date : '',
    messages: kept,
    draft: cleanAnalysis(draft),
    current: cleanCurrent(current),
    cost: numberOr(cost, 0),
  };

  // Записывать нечего: запись не трогаем. Стирать её здесь нельзя, потому что окно открывают
  // и на другом дне, где разговора нет, а разговор прежнего дня должен уцелеть.
  if (!kept.length && !chat.current) return true;

  if (write(target, CHAT_KEY, JSON.stringify(chat))) return true;

  // Места не хватило: снимки убираем, слова и числа оставляем.
  const withoutPhotos = {
    ...chat,
    messages: kept.map((message) => (message.photo ? { ...message, photo: null } : message)),
  };
  return write(target, CHAT_KEY, JSON.stringify(withoutPhotos));
}

/**
 * Возвращает разговор для указанного дня. Разговор другого дня не возвращается: запись
 * ушла бы не в тот дневник, а числа были бы вчерашние.
 */
export function loadChat({ date = null, storage = null } = {}) {
  const target = store(storage);
  if (!target) return null;

  const raw = read(target, CHAT_KEY);
  if (typeof raw !== 'string' || !raw) return null;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!data || typeof data !== 'object' || data.v !== VERSION) return null;
  if (date && data.date !== date) return null;

  const messages = Array.isArray(data.messages)
    ? data.messages.map(cleanMessage).filter(Boolean)
    : [];
  const current = cleanCurrent(data.current);
  if (!messages.length && !current) return null;

  return {
    date: data.date,
    messages,
    draft: cleanAnalysis(data.draft),
    current,
    cost: numberOr(data.cost, 0),
  };
}

/**
 * Набранный, но не отправленный текст: отдельно от переписки, он пишется на каждую букву.
 * Дата хранится вместе с текстом: вчерашние слова в сегодняшнем окне так же неуместны,
 * как вчерашние числа.
 */
export function saveTyped(text, { date = '', storage = null } = {}) {
  const target = store(storage);
  if (!target) return false;
  const value = String(text ?? '');
  if (!value) {
    drop(target, TYPED_KEY);
    return true;
  }
  const typed = { v: VERSION, date: typeof date === 'string' ? date : '', text: value };
  return write(target, TYPED_KEY, JSON.stringify(typed));
}

export function loadTyped({ date = '', storage = null } = {}) {
  const target = store(storage);
  if (!target) return '';

  const raw = read(target, TYPED_KEY);
  if (typeof raw !== 'string' || !raw) return '';

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return '';
  }

  if (!data || typeof data !== 'object' || data.v !== VERSION) return '';
  if (typeof data.text !== 'string') return '';
  if (date && data.date !== date) return '';
  return data.text;
}

/** Полный сброс и запись в дневник: разговор закончен, возвращать его незачем. */
export function clearChat({ storage = null } = {}) {
  const target = store(storage);
  if (!target) return;
  drop(target, CHAT_KEY);
  drop(target, TYPED_KEY);
}
