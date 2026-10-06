// Календарь: сетка месяца. Здесь только вычисления, никакого DOM — арифметика дат
// ошибается тихо, поэтому её проверяют тестами.
import { isoDate, parseISO } from './util.js';

const MONTHS_NOMINATIVE = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

/** Подписи дней недели в том же порядке, в каком идут клетки: неделя начинается с понедельника. */
export const WEEKDAY_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

/** первое число месяца, в котором лежит дата. */
export function monthStart(iso) {
  const date = parseISO(iso);
  return isoDate(new Date(date.getFullYear(), date.getMonth(), 1));
}

/** Сдвиг на месяцы: сдвигаем от первого числа, чтобы 31-е не перескакивало через месяц. */
export function shiftMonth(iso, months) {
  const date = parseISO(monthStart(iso));
  return isoDate(new Date(date.getFullYear(), date.getMonth() + months, 1));
}

export function monthTitle(iso) {
  const date = parseISO(iso);
  const year = date.getFullYear();
  const current = new Date().getFullYear();
  // Год показываем только когда он не текущий: иначе строка длиннее, чем нужно.
  return `${MONTHS_NOMINATIVE[date.getMonth()]}${year === current ? '' : ` ${year}`}`;
}

/**
 * Сетка месяца: недели по семь дней, начиная с понедельника.
 *
 * Клетки соседних месяцев входят в сетку, чтобы недели не рвались: они помечены
 * inMonth: false, и показывать их бледнее — дело интерфейса.
 */
export function monthGrid(iso, { today = isoDate(new Date()) } = {}) {
  const start = parseISO(monthStart(iso));
  const year = start.getFullYear();
  const month = start.getMonth();

  // Понедельник — первый день недели, а getDay() считает с воскресенья.
  const leading = (start.getDay() + 6) % 7;
  const first = new Date(year, month, 1 - leading);

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Math.ceil((leading + daysInMonth) / 7) * 7;

  const weeks = [];
  for (let index = 0; index < cells; index += 1) {
    const date = new Date(first.getFullYear(), first.getMonth(), first.getDate() + index);
    const cellIso = isoDate(date);
    if (index % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1].push({
      iso: cellIso,
      day: date.getDate(),
      inMonth: date.getMonth() === month && date.getFullYear() === year,
      isToday: cellIso === today,
    });
  }
  return { year, month, weeks };
}

/** Суммы по дням месяца: { '2026-10-04': { kcal, protein, fat, carbs } }. */
export function totalsByDay(entries = []) {
  const byDay = {};
  for (const entry of entries) {
    const day = entry?.date;
    if (!day) continue;
    const totals = byDay[day] || (byDay[day] = { kcal: 0, protein: 0, fat: 0, carbs: 0, count: 0 });
    totals.kcal += Number(entry.kcal) || 0;
    totals.protein += Number(entry.protein) || 0;
    totals.fat += Number(entry.fat) || 0;
    totals.carbs += Number(entry.carbs) || 0;
    totals.count += 1;
  }
  return byDay;
}
