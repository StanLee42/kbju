// Объединение записей дня.
//
// Так бывает: один приём пищи записан несколькими строками — отдельно салат, отдельно курица,
// отдельно хлеб. В дневнике это выглядит как три приёма, и итог дня приходится складывать
// глазами. Объединение складывает их в одну запись.
//
// Время берём у самой ранней строки: объединённый приём начался тогда, когда началась
// первая из них.
import { round } from './util.js';

/** Сколько знаков после запятой оставляем в числах — столько же, сколько у обычной записи. */
const DIGITS = 1;

function sumOf(entries, key) {
  return round(entries.reduce((acc, entry) => acc + (Number(entry[key]) || 0), 0), DIGITS);
}

/** Название объединённой записи: имена строк по порядку, без повторов. */
function joinNames(entries) {
  const names = [];
  for (const entry of entries) {
    const name = String(entry.name || '').trim();
    if (name && !names.includes(name)) names.push(name);
  }
  if (!names.length) return 'Приём пищи';
  return names.join(', ').slice(0, 120);
}

/**
 * Складывает записи в одну.
 *
 * @param {Array} entries записи одного дня
 * @returns {object|null} поля объединённой записи или null, если складывать нечего
 */
export function mergeEntries(entries = []) {
  const rows = (entries || []).filter(Boolean);
  if (!rows.length) return null;

  // Первая строка — самая ранняя по времени: она и задаёт время объединённой записи.
  // Записи без времени уходят в конец: начало приёма задаёт та, у которой время есть.
  const sortKey = (entry) => String(entry.time || '').trim() || '99:99';
  const sorted = [...rows].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const first = sorted[0];

  return {
    date: first.date || null,
    time: first.time || '',
    name: joinNames(sorted),
    grams: sumOf(sorted, 'grams'),
    kcal: sumOf(sorted, 'kcal'),
    protein: sumOf(sorted, 'protein'),
    fat: sumOf(sorted, 'fat'),
    carbs: sumOf(sorted, 'carbs'),
    comment: sorted.map((entry) => String(entry.comment || '').trim()).filter(Boolean).join('; '),
    source: 'merged',
    // Позиции всех строк складываем подряд: в показе записи видно, из чего она собрана.
    items: sorted.flatMap((entry) => (Array.isArray(entry.items) ? entry.items : [])),
    // Снимок оставляем первый, который был: остальные удалятся вместе со своими записями.
    thumbId: sorted.find((entry) => entry.thumbId)?.thumbId || null,
    basis: first.basis || null,
    confidence: first.confidence || null,
    assumptions: sorted.map((entry) => String(entry.assumptions || '').trim()).filter(Boolean).join(' '),
    portion: 'normal',
    portionNote: '',
    base: null,
    cost: round(sorted.reduce((acc, entry) => acc + (Number(entry.cost) || 0), 0), 5),
  };
}
