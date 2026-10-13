// Проверка объединения записей: суммы, время первой строки, составляющие и разбор обратно.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canSplit, entryParts, mergeEntries, splitEntry } from '../js/merge.js';

const rows = [
  { id: 'b', date: '2026-10-07', time: '13:40', name: 'Курица', grams: 120, kcal: 300, protein: 25, fat: 16, carbs: 4, comment: '', source: 'product', items: [{ name: 'Курица', grams: 120, kcal: 300, protein: 25, fat: 16, carbs: 4 }], cost: 0.0002 },
  { id: 'a', date: '2026-10-07', time: '13:10', name: 'Салат', grams: 200, kcal: 110, protein: 3, fat: 8, carbs: 8, comment: 'без соуса', source: 'photo', items: [{ name: 'Салат', grams: 200, kcal: 110, protein: 3, fat: 8, carbs: 8 }], cost: 0.0001 },
  { id: 'c', date: '2026-10-07', time: '13:55', name: 'Хлеб', grams: 30, kcal: 70, protein: 2, fat: 1, carbs: 14, comment: 'ржаной', source: 'manual', items: [{ name: 'Хлеб', grams: 30, kcal: 70, protein: 2, fat: 1, carbs: 14 }], cost: 0 },
];

test('суммы складываются по всем строкам', () => {
  const merged = mergeEntries(rows);
  assert.equal(merged.grams, 350);
  assert.equal(merged.kcal, 480);
  assert.equal(merged.protein, 30);
  assert.equal(merged.fat, 25);
  assert.equal(merged.carbs, 26);
});

test('время берётся у самой ранней строки', () => {
  // Строки приходят в любом порядке: время задаёт первая по времени, а не первая в списке.
  const merged = mergeEntries(rows);
  assert.equal(merged.time, '13:10');
});

test('позиции всех строк оказываются в объединённой записи', () => {
  const merged = mergeEntries(rows);
  assert.equal(merged.items.length, 3);
  assert.deepEqual(merged.items.map((item) => item.name), ['Салат', 'Курица', 'Хлеб']);
  assert.equal(merged.source, 'merged');
});

test('название собирается из имён строк без повторов', () => {
  const merged = mergeEntries(rows);
  assert.equal(merged.name, 'Салат, Курица, Хлеб');

  // Две строки с одинаковым названием и одна с другим: повтор в названии не удваивается.
  const same = mergeEntries([rows[0], { ...rows[1], name: 'Курица' }, rows[2]]);
  assert.equal(same.name, 'Курица, Хлеб', 'повтор не дублируется');
});

test('подписи и стоимость складываются', () => {
  const merged = mergeEntries(rows);
  assert.equal(merged.comment, 'без соуса; ржаной');
  assert.ok(Math.abs(merged.cost - 0.0003) < 1e-9);
  assert.equal(merged.portion, undefined, 'у записи нет размера порции');
  assert.equal(merged.base, undefined, 'у записи нет базовых значений');
});

test('базис и уверенность берутся у первой строки, допущения соединяются', () => {
  const merged = mergeEntries([
    { ...rows[0], basis: 'per_portion', confidence: 'medium', assumptions: 'Вес оценён.' },
    { ...rows[1], basis: 'per_100g', confidence: 'low', assumptions: 'Соус не учтён.' },
  ]);
  assert.equal(merged.basis, 'per_100g', 'базис берётся у самой ранней строки');
  assert.equal(merged.confidence, 'low');
  assert.equal(merged.assumptions, 'Соус не учтён. Вес оценён.', 'порядок по времени еды');
});

test('пустое и одна строка не ломают объединение', () => {
  assert.equal(mergeEntries([]), null);
  assert.equal(mergeEntries(null), null);
  const single = mergeEntries([rows[0]]);
  assert.equal(single.kcal, 300);
  assert.equal(single.name, 'Курица');
});

test('записи без времени не мешают: берётся самая ранняя из тех, что есть', () => {
  const merged = mergeEntries([
    { name: 'Без времени', kcal: 100, grams: 100 },
    { name: 'Утренняя', time: '09:00', kcal: 100, grams: 100 },
  ]);
  assert.equal(merged.time, '09:00');
  assert.equal(merged.kcal, 200);
});

test('объединённая запись помнит строки, из которых собрана', () => {
  const merged = mergeEntries(rows);
  assert.deepEqual(merged.parts.map((part) => part.name), ['Салат', 'Курица', 'Хлеб']);
  assert.equal(merged.parts[0].comment, 'без соуса', 'подпись строки остаётся при ней');
  assert.equal(merged.parts[0].id, undefined, 'служебный номер строки не запоминаем');
});

test('объединённую запись можно разобрать на составляющие', () => {
  const merged = mergeEntries(rows);
  const parts = splitEntry(merged);

  assert.equal(parts.length, 3, 'по одной записи на каждую строку');
  assert.deepEqual(parts.map((part) => part.name), ['Салат', 'Курица', 'Хлеб']);
  assert.deepEqual(parts.map((part) => part.kcal), [110, 300, 70]);
  assert.deepEqual(parts.map((part) => part.grams), [200, 120, 30]);
  assert.deepEqual(parts.map((part) => part.time), ['13:10', '13:40', '13:55'],
    'время каждой строки её собственное: объединение его запомнило');
  assert.deepEqual(parts.map((part) => part.source), ['photo', 'product', 'manual'],
    'источник строки возвращается вместе с ней');

  // Сумма составляющих равна исходной записи: иначе разбор терял бы еду.
  const back = parts.reduce((acc, part) => acc + part.kcal, 0);
  assert.equal(Math.round(back), Math.round(merged.kcal));
  const cost = parts.reduce((acc, part) => acc + part.cost, 0);
  assert.ok(Math.abs(cost - merged.cost) < 1e-9, 'стоимость возвращается строкам');
});

test('объединённую запись без позиций тоже можно разобрать', () => {
  // Так приходит еда из продукта и ручной записи: позиций нет, а делить нужно.
  const first = { date: '2026-10-12', time: '13:00', name: 'Курица', grams: 120, kcal: 300, protein: 25, fat: 16, carbs: 4, source: 'product' };
  const second = { date: '2026-10-12', time: '13:30', name: 'Салат', grams: 100, kcal: 50, protein: 2, fat: 3, carbs: 4, source: 'manual' };
  const merged = mergeEntries([first, second]);

  assert.deepEqual(merged.items, [], 'позиций у строк не было');
  assert.equal(canSplit(merged), true, 'делить есть что: запись помнит строки');

  const parts = splitEntry(merged);
  assert.deepEqual(parts.map((part) => part.name), ['Курица', 'Салат']);
  assert.deepEqual(parts.map((part) => part.kcal), [300, 50]);
  assert.equal(parts[0].source, 'product');
});

test('строка из продукта возвращается со снимком значений', () => {
  const product = {
    id: '1', date: '2026-10-12', time: '10:00', name: 'Творог', grams: 150, kcal: 200,
    protein: 25, fat: 8, carbs: 5, source: 'product', productId: 'p1',
    per100: { kcal: 133.3, protein: 16.7, fat: 5.3, carbs: 3.3 },
  };
  const manual = {
    id: '2', date: '2026-10-12', time: '10:10', name: 'Хлеб', grams: 30, kcal: 70,
    protein: 2, fat: 1, carbs: 14, source: 'manual',
  };
  const parts = splitEntry(mergeEntries([product, manual]));

  assert.equal(parts[0].source, 'product');
  assert.equal(parts[0].productId, 'p1', 'связь с продуктом не теряется');
  assert.deepEqual(parts[0].per100, product.per100, 'иначе правка веса не пересчитает числа');
});

test('повторное объединение не копит вложенность', () => {
  const first = mergeEntries([rows[1], rows[0]]);
  const again = mergeEntries([first, rows[2]]);

  assert.equal(again.parts.length, 3, 'составляющими стали исходные строки');
  assert.deepEqual(again.parts.map((part) => part.parts), [undefined, undefined, undefined]);
  assert.deepEqual(splitEntry(again).map((part) => part.name), ['Салат', 'Курица', 'Хлеб']);
});

test('запись без составляющих разбирается по позициям', () => {
  const entry = { date: '2026-10-07', time: '13:00', source: 'photo', items: [{ name: 'Салат', kcal: 110 }, { name: 'Курица', kcal: 300 }] };
  const parts = splitEntry(entry);

  assert.deepEqual(parts.map((part) => part.name), ['Салат', 'Курица']);
  assert.equal(parts[0].source, 'split');
  assert.equal(parts[0].time, entry.time);
});

test('разбирать нечего, если позиция одна или их нет', () => {
  assert.deepEqual(splitEntry({ items: [{ name: 'Салат', kcal: 100 }] }), []);
  assert.deepEqual(splitEntry({ items: [] }), []);
  assert.deepEqual(splitEntry({}), []);
  assert.deepEqual(splitEntry(null), []);
});

test('делить есть что там, где есть составляющие или две позиции', () => {
  assert.equal(canSplit(null), false);
  assert.equal(canSplit({ source: 'product', kcal: 100 }), false, 'запись из продукта неделима');
  assert.equal(canSplit({ items: [{ name: 'Салат', kcal: 100 }] }), false);
  assert.equal(canSplit({ items: [{ name: 'А' }, { name: 'Б' }] }), true);
  assert.equal(canSplit(mergeEntries([rows[0], rows[1]])), true);
});

test('составляющие для показа: строки объединения, иначе позиции', () => {
  const items = [{ name: 'Салат' }, { name: 'Курица' }];
  assert.deepEqual(entryParts({ items }), items);
  assert.deepEqual(entryParts(mergeEntries([rows[0], rows[1]])).map((part) => part.name),
    ['Салат', 'Курица']);
  assert.deepEqual(entryParts({}), []);
  assert.deepEqual(entryParts(null), []);
});
