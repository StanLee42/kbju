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

// Разбор снимка упаковки между перезагрузками страницы.
//
// Случай тот же, что и у разговора о еде: приложение перезагружает страницу само, когда
// приходит новая сборка. Отличие одно: разбор упаковки не привязан ко дню, потому что из него
// собирается продукт для списка, а не запись в дневник. Поэтому даты в записи нет.
const PRODUCT_KEY = 'kbju-product-parse';
const PRODUCT_TYPED_KEY = 'kbju-product-parse-text';

const PRODUCT_VALUES = ['kcal', 'protein', 'fat', 'carbs'];

/** Значения продукта: только четыре числа, всё остальное отбрасывается. */
function cleanValues(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const key of PRODUCT_VALUES) out[key] = numberOr(value[key], 0);
  return out;
}

/** Карточка продукта: название и значения на 100 г. Без значений карточки нет. */
function cleanProduct(value) {
  if (!value || typeof value !== 'object') return null;
  const per100 = cleanValues(value.per100);
  if (!per100) return null;
  return { name: typeof value.name === 'string' ? value.name : '', per100 };
}

/** Разбор от модели: то, что показывают в переписке и передают следующим сообщением. */
function cleanParse(value) {
  if (!value || typeof value !== 'object') return null;
  const parse = { hasNumbers: Boolean(value.hasNumbers) };
  if (typeof value.name === 'string') parse.name = value.name;
  const values = cleanValues(value.values);
  if (values) parse.values = values;
  for (const key of ['source', 'confidence', 'assumptions', 'question']) {
    if (typeof value[key] === 'string') parse[key] = value[key];
  }
  const basis = numberOr(value.basisGrams, 0);
  if (basis > 0) parse.basisGrams = basis;
  // Вес упаковки в расчёте не участвует, но уходит модели следующим сообщением.
  const packageWeight = numberOr(value.packageWeight, 0);
  if (packageWeight > 0) parse.packageWeight = packageWeight;
  if (Array.isArray(value.warnings)) {
    parse.warnings = value.warnings.filter((item) => typeof item === 'string');
  }
  const cost = numberOr(value.cost, 0);
  if (cost) parse.cost = cost;
  return parse;
}

function cleanProductMessage(value) {
  if (!value || typeof value !== 'object') return null;
  if (!ROLES.includes(value.role)) return null;

  if (value.role === 'user') {
    const text = typeof value.text === 'string' ? value.text : '';
    const photo = typeof value.photo === 'string' && value.photo.startsWith('data:') ? value.photo : null;
    if (!text && !photo) return null;
    return { role: 'user', text, photo };
  }

  const answer = cleanParse(value.answer);
  const error = value.error && typeof value.error === 'object' ? value.error : null;
  if (!answer && !error) return null;
  return { role: 'assistant', answer, error };
}

/**
 * Кладёт разбор упаковки в хранилище. Пустой разбор запись не трогает: окно открывают
 * и закрывают, ничего не разобрав.
 */
export function saveProductParse(
  { messages = [], product = null, draft = null, cost = 0 } = {},
  { storage = null } = {},
) {
  const target = store(storage);
  if (!target) return false;

  const kept = (messages || []).map(cleanProductMessage).filter(Boolean);
  const parse = {
    v: VERSION,
    messages: kept,
    product: cleanProduct(product),
    draft: cleanParse(draft),
    cost: numberOr(cost, 0),
  };

  // Записывать нечего: прежнюю запись не трогаем. Стирание живёт в clearProductParse.
  if (!kept.length && !parse.product) return true;

  if (write(target, PRODUCT_KEY, JSON.stringify(parse))) return true;

  // Места не хватило: снимки убираем, слова и числа оставляем.
  const withoutPhotos = {
    ...parse,
    messages: kept.map((message) => (message.photo ? { ...message, photo: null } : message)),
  };
  return write(target, PRODUCT_KEY, JSON.stringify(withoutPhotos));
}

/** Возвращает разбор упаковки. Запись чужой версии не разбирается: числа важнее полноты. */
export function loadProductParse({ storage = null } = {}) {
  const target = store(storage);
  if (!target) return null;

  const raw = read(target, PRODUCT_KEY);
  if (typeof raw !== 'string' || !raw) return null;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!data || typeof data !== 'object' || data.v !== VERSION) return null;

  const messages = Array.isArray(data.messages)
    ? data.messages.map(cleanProductMessage).filter(Boolean)
    : [];
  const product = cleanProduct(data.product);
  if (!messages.length && !product) return null;

  return { messages, product, draft: cleanParse(data.draft), cost: numberOr(data.cost, 0) };
}

/** Набранные слова к снимку: пишутся на каждое нажатие, поэтому лежат отдельным ключом. */
export function saveProductTyped(text, { storage = null } = {}) {
  const target = store(storage);
  if (!target) return false;
  const value = String(text ?? '');
  if (!value) {
    drop(target, PRODUCT_TYPED_KEY);
    return true;
  }
  return write(target, PRODUCT_TYPED_KEY, JSON.stringify({ v: VERSION, text: value }));
}

export function loadProductTyped({ storage = null } = {}) {
  const target = store(storage);
  if (!target) return '';

  const raw = read(target, PRODUCT_TYPED_KEY);
  if (typeof raw !== 'string' || !raw) return '';

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return '';
  }

  if (!data || typeof data !== 'object' || data.v !== VERSION) return '';
  return typeof data.text === 'string' ? data.text : '';
}

/** Продукт сохранён или окно закрыто: разбор закончен, возвращать его незачем. */
export function clearProductParse({ storage = null } = {}) {
  const target = store(storage);
  if (!target) return;
  drop(target, PRODUCT_KEY);
  drop(target, PRODUCT_TYPED_KEY);
}
