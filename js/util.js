// Мелкие утилиты: работа с датами в локальном времени, форматирование,
// безопасное построение DOM без innerHTML.

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

/**
 * Заменяет содержимое узла, отсеивая пустое.
 *
 * Ловушка replaceChildren: null и undefined становятся текстовыми узлами, и на экране
 * появляется слово «null». Глазами такое легко не заметить, поэтому отсеиваем здесь,
 * а не в каждом месте, где собирается разметка.
 */
export function fill(node, ...children) {
  node.replaceChildren(...children.flat()
    .filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

export function num(value, fallback = 0) {
  const parsed = Number.parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Локальная дата в виде YYYY-MM-DD (без сдвига в UTC). */
export function isoDate(date = new Date()) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayISO() {
  return isoDate(new Date());
}

export function parseISO(value) {
  const [y, m, d] = String(value).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(iso, days) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

/** Разница в целых локальных днях: to - from. */
export function daysBetween(fromISO, toISO) {
  const a = parseISO(fromISO);
  const b = parseISO(toISO);
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 86400000);
}

const WEEKDAYS_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export function weekdayFull(iso) { return WEEKDAYS_FULL[parseISO(iso).getDay()]; }
export function weekdayShort(iso) { return WEEKDAYS_SHORT[parseISO(iso).getDay()]; }

/** Ключ дня недели для недельной сетки: mon..sun. */
export function weekdayKey(iso) {
  const day = parseISO(iso).getDay();
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][day];
}

export function formatDateHuman(iso) {
  const d = parseISO(iso);
  return `${d.getDate()} ${MONTHS_GENITIVE[d.getMonth()]}`;
}

export function formatTime(isoTime) {
  return String(isoTime || '').slice(0, 5);
}

export function nowTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function plural(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

export function bytesHuman(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 МБ';
  const mb = bytes / 1048576;
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  if (mb < 1024) return `${round(mb, 1)} МБ`;
  return `${round(mb / 1024, 2)} ГБ`;
}
