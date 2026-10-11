// Проверка сумм по позициям записи.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sumItems } from '../js/portion.js';

const items = [
  { name: 'Паста', grams: 160, kcal: 235.4, protein: 8.6, fat: 1.8, carbs: 46 },
  { name: 'Сыр', grams: 15, kcal: 59.2, protein: 5, fat: 4, carbs: 0.5 },
];

test('суммы складываются по всем позициям', () => {
  const totals = sumItems(items);
  assert.equal(Math.round(totals.grams), 175);
  assert.equal(Math.round(totals.kcal * 10) / 10, 294.6);
  assert.equal(Math.round(totals.protein * 10) / 10, 13.6);
});

test('пропущенные числа считаются нулями', () => {
  const totals = sumItems([{ grams: 100, kcal: 50 }, { name: 'Соль' }]);
  assert.equal(totals.grams, 100);
  assert.equal(totals.kcal, 50);
  assert.equal(totals.carbs, 0);
  assert.deepEqual(sumItems(), { grams: 0, kcal: 0, protein: 0, fat: 0, carbs: 0 });
});
