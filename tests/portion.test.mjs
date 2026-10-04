// Проверка порций: множитель, пересчёт позиций и подписи.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PORTION_PRESETS, portionFactor, portionNote, scaleItems, sumItems } from '../js/portion.js';

const items = [
  { name: 'Паста', grams: 160, kcal: 235.4, protein: 8.6, fat: 1.8, carbs: 46 },
  { name: 'Сыр', grams: 15, kcal: 59.2, protein: 5, fat: 4, carbs: 0.5 },
];

test('множители порций заданы явно', () => {
  assert.equal(portionFactor({ portion: 'all', items }), 1);
  assert.equal(portionFactor({ portion: 'half', items }), 0.5);
});

test('свои граммы считаются как доля от посчитанного', () => {
  // Всего 175 г, хотим 35 г — это пятая часть.
  assert.equal(portionFactor({ portion: 'custom', customGrams: 35, items }), 0.2);
});

test('бессмысленные свои граммы не ломают расчёт', () => {
  assert.equal(portionFactor({ portion: 'custom', customGrams: 0, items }), 1);
  assert.equal(portionFactor({ portion: 'custom', customGrams: 500, items: [] }), 1);
  assert.equal(portionFactor({ portion: 'custom', customGrams: -10, items }), 1);
  assert.equal(portionFactor({}), 1);
});

test('суммы складываются по всем позициям', () => {
  const totals = sumItems(items);
  assert.equal(Math.round(totals.grams), 175);
  assert.equal(Math.round(totals.kcal * 10) / 10, 294.6);
  assert.equal(Math.round(totals.protein * 10) / 10, 13.6);
});

test('пересчёт округляет до десятых и не теряет названия', () => {
  const scaled = scaleItems(items, 0.5);
  assert.equal(scaled[0].name, 'Паста');
  assert.equal(scaled[0].grams, 80);
  assert.equal(scaled[0].kcal, 117.7);
  assert.equal(scaled[1].protein, 2.5);
});

test('позиция без названия получает запасное', () => {
  const scaled = scaleItems([{ grams: 100, kcal: 50 }], 1);
  assert.equal(scaled[0].name, 'позиция');
  assert.equal(scaled[0].protein, 0);
});

test('подпись к записи говорит, что именно съедено не целиком', () => {
  assert.equal(portionNote({ portion: 'half', factor: 0.5, grams: 87 }), 'половина посчитанного');
  assert.equal(portionNote({ portion: 'custom', factor: 0.2, grams: 35 }), '35 г из посчитанного');
  assert.equal(portionNote({ portion: 'all', factor: 1, grams: 175 }), '');
});

test('наборы порций для интерфейса не расходятся с расчётом', () => {
  for (const preset of PORTION_PRESETS) {
    assert.equal(portionFactor({ portion: preset.id, items }), preset.factor);
  }
});
