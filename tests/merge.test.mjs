// Проверка объединения записей: суммы, время первой строки, позиции и подписи.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeEntries } from '../js/merge.js';

const rows = [
  { id: 'b', date: '2026-10-07', time: '13:40', name: 'Курица', grams: 120, kcal: 300, protein: 25, fat: 16, carbs: 4, comment: '', items: [{ name: 'Курица', grams: 120 }], cost: 0.0002 },
  { id: 'a', date: '2026-10-07', time: '13:10', name: 'Салат', grams: 200, kcal: 110, protein: 3, fat: 8, carbs: 8, comment: 'без соуса', items: [{ name: 'Салат', grams: 200 }], cost: 0.0001 },
  { id: 'c', date: '2026-10-07', time: '13:55', name: 'Хлеб', grams: 30, kcal: 70, protein: 2, fat: 1, carbs: 14, comment: 'ржаной', items: [{ name: 'Хлеб', grams: 30 }], cost: 0 },
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

test('подписи и стоимость складываются, множитель порции сбрасывается', () => {
  const merged = mergeEntries(rows);
  assert.equal(merged.comment, 'без соуса; ржаной');
  assert.ok(Math.abs(merged.cost - 0.0003) < 1e-9);
  assert.equal(merged.portion, 'normal', 'у объединённой записи множитель не сохраняется');
  assert.equal(merged.portionNote, '');
});

test('базис и уверенность берутся у первой строки, допущения соединяются', () => {
  const merged = mergeEntries([
    { ...rows[0], basis: 'per_portion', confidence: 'medium', assumptions: 'Вес оценён.' },
    { ...rows[1], basis: 'per_100g', confidence: 'low', assumptions: 'Соус не учтён.' },
  ]);
  assert.equal(merged.basis, 'per_100g', 'базис берётся у самой ранней строки');
  assert.equal(merged.confidence, 'low');
  assert.equal(merged.assumptions, 'Соус не учтён. Вес оценён.', 'порядок — по времени еды');
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
