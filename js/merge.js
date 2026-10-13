// Объединение записей дня.
//
// Так бывает: один приём пищи записан несколькими строками: отдельно салат, отдельно курица,
// отдельно хлеб. В дневнике это выглядит как три приёма, и итог дня приходится складывать
// глазами. Объединение складывает их в одну запись.
//
// Складывание обратимо: объединённая запись помнит строки, из которых она собрана, и разбор
// возвращает их обратно. Обратимость нужна потому, что строки бывают без позиций: у записи
// из продукта позиция одна, у ручной записи её нет вовсе, и делить такую запись по позициям
// было бы нечем.
//
// Время берём у самой ранней строки: объединённый приём начался тогда, когда началась
// первая из них.
import { round } from './util.js';

/** Сколько знаков после запятой оставляем в числах: столько же, сколько у обычной записи. */
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
 * Строка объединённой записи как отдельная составляющая.
 *
 * Служебные поля самой записи сюда не идут: свой номер и своё время создания составляющая
 * получит, когда снова станет записью. Поля самой строки остаются все, включая источник,
 * снимок значений продукта и стоимость: иначе разбор терял бы то, чем запись жила.
 */
function asSource(entry) {
  const { id, createdAt, thumbId, parts, ...rest } = entry;
  return rest;
}

/** Составляющие строки: своя строка или то, из чего её собрали раньше. */
function sourcesOf(entry) {
  if (Array.isArray(entry?.parts) && entry.parts.length) return entry.parts;
  return [asSource(entry)];
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

  // Время объединённой записи задаёт самая ранняя по времени строка.
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
    // Строки, из которых собран приём пищи: по ним объединение отменяется разбором.
    // У строки, которая уже была объединена, берём её составляющие: повторное объединение
    // не копит вложенность.
    parts: sorted.flatMap(sourcesOf),
    // Снимок оставляем первый, который был: остальные удалятся вместе со своими записями.
    thumbId: sorted.find((entry) => entry.thumbId)?.thumbId || null,
    basis: first.basis || null,
    confidence: first.confidence || null,
    assumptions: sorted.map((entry) => String(entry.assumptions || '').trim()).filter(Boolean).join(' '),
    cost: round(sorted.reduce((acc, entry) => acc + (Number(entry.cost) || 0), 0), 5),
  };
}

/** Строки, из которых собрана объединённая запись. Пусто, если объединения не было. */
export function mergedSources(entry) {
  return Array.isArray(entry?.parts) ? entry.parts.filter(Boolean) : [];
}

/**
 * Составляющие записи для показа: строки объединения, а если их нет, то позиции.
 * Ими же решается, есть ли что показать в окне записи.
 */
export function entryParts(entry) {
  const sources = mergedSources(entry);
  if (sources.length) return sources;
  return Array.isArray(entry?.items) ? entry.items.filter(Boolean) : [];
}

/** Строка объединённой записи снова становится записью: время и дата у неё свои. */
function restoredEntry(row, entry) {
  return {
    ...row,
    date: row.date || entry.date || null,
    time: row.time || entry.time || '',
    // Снимок остаётся у объединённой записи: у составляющих его нет.
    thumbId: null,
    parts: null,
  };
}

/**
 * Разбирает запись на составляющие: по одной на каждую позицию.
 *
 * Объединённая запись распадается на строки, из которых её собрали: это отмена объединения,
 * и она работает даже там, где позиций не было. Такая же запись без позиций неразбираема.
 *
 * Нужно, чтобы посмотреть, из чего собран приём пищи: какая именно позиция тянет день
 * в перебор. У строк время и дата свои: объединение их запомнило. У позиций время остаётся
 * тем же, что у исходной записи: точнее мы его всё равно не знаем, а придумывать не будем.
 */
export function splitEntry(entry) {
  const sources = mergedSources(entry);
  if (sources.length >= 2) return sources.map((row) => restoredEntry(row, entry));

  const items = Array.isArray(entry?.items) ? entry.items.filter(Boolean) : [];
  if (items.length < 2) return [];

  return items.map((item) => ({
    date: entry.date || null,
    time: entry.time || '',
    name: String(item.name || '').trim() || 'Позиция',
    grams: round(Number(item.grams) || 0, DIGITS),
    kcal: round(Number(item.kcal) || 0, DIGITS),
    protein: round(Number(item.protein) || 0, DIGITS),
    fat: round(Number(item.fat) || 0, DIGITS),
    carbs: round(Number(item.carbs) || 0, DIGITS),
    comment: '',
    source: 'split',
    items: [item],
    thumbId: null,
    basis: entry.basis || null,
    confidence: entry.confidence || null,
    assumptions: '',
    // Стоимость разговора относилась ко всему приёму: при разделении её не размазываем.
    cost: 0,
  }));
}

/** Есть что делить: строки объединения или хотя бы две позиции. */
export function canSplit(entry) {
  return splitEntry(entry).length >= 2;
}
