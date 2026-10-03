// Проверка расчётов: тип дня по расписанию, исключения, суммы и остатки.
// Запуск: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS, dayTypeById, remaining, resolveDayTypeId, sumEntries,
} from '../js/norm.js';

const settings = structuredClone(DEFAULT_SETTINGS);

test('тип дня берётся из недельной сетки', () => {
  // 2026-10-05 — понедельник, 2026-10-07 — среда.
  assert.equal(resolveDayTypeId('2026-10-05', settings), 'rest');
  assert.equal(resolveDayTypeId('2026-10-07', settings), 'train');
  assert.equal(resolveDayTypeId('2026-10-09', settings), 'train');
});

test('исключение на дату перебивает расписание', () => {
  const withOverride = { ...settings, dateOverrides: { '2026-10-07': 'rest' } };
  assert.equal(resolveDayTypeId('2026-10-07', withOverride), 'rest');
  assert.equal(resolveDayTypeId('2026-10-08', withOverride), 'rest');
});

test('цикл 2 через 2 считается от даты старта', () => {
  const cycled = {
    ...settings,
    schedule: {
      ...settings.schedule,
      mode: 'cycle',
      cycle: { length: 4, trainPositions: [1, 3], startDate: '2026-10-01' },
    },
  };

  assert.equal(resolveDayTypeId('2026-10-01', cycled), 'train'); // позиция 1
  assert.equal(resolveDayTypeId('2026-10-02', cycled), 'rest');  // позиция 2
  assert.equal(resolveDayTypeId('2026-10-03', cycled), 'train'); // позиция 3
  assert.equal(resolveDayTypeId('2026-10-04', cycled), 'rest');  // позиция 4
  assert.equal(resolveDayTypeId('2026-10-05', cycled), 'train'); // цикл пошёл заново
  // Дни до старта цикла считаются так же, без отрицательных смещений.
  assert.equal(resolveDayTypeId('2026-09-30', cycled), 'rest');  // позиция 4
  assert.equal(resolveDayTypeId('2026-09-29', cycled), 'train'); // позиция 3
});

test('битая настройка не ломает разрешение типа дня', () => {
  const broken = { ...settings, dateOverrides: { '2026-10-07': 'не существует' } };
  assert.equal(resolveDayTypeId('2026-10-07', broken), 'train');
  assert.equal(dayTypeById(settings, 'нет такого').id, 'rest');
});

test('суммы и остаток считаются по всем записям', () => {
  const entries = [
    { kcal: 300, protein: 20, fat: 10, carbs: 30 },
    { kcal: 250.5, protein: 15.5, fat: 8, carbs: 20 },
  ];
  const totals = sumEntries(entries);
  assert.deepEqual(totals, { kcal: 550.5, protein: 35.5, fat: 18, carbs: 50 });

  const left = remaining({ kcal: 2000, protein: 130, fat: 65, carbs: 200 }, totals);
  assert.equal(left.kcal, 1449.5);
  assert.equal(left.protein, 94.5);
  assert.equal(left.fat, 47);
  assert.equal(left.carbs, 150);
});

test('перебор даёт отрицательный остаток', () => {
  const totals = sumEntries([{ kcal: 2300, protein: 100, fat: 80, carbs: 250 }]);
  const left = remaining({ kcal: 2000, protein: 130, fat: 65, carbs: 200 }, totals);
  assert.equal(left.kcal, -300);
  assert.equal(left.fat, -15);
});

test('пустой день даёт нули и полный остаток', () => {
  const totals = sumEntries([]);
  assert.deepEqual(totals, { kcal: 0, protein: 0, fat: 0, carbs: 0 });
  assert.deepEqual(remaining({ kcal: 2000, protein: 130, fat: 65, carbs: 200 }, totals),
    { kcal: 2000, protein: 130, fat: 65, carbs: 200 });
});
