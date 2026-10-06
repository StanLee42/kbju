// Проверка сетки календаря: недели, соседние месяцы, високосный февраль.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WEEKDAY_SHORT, monthGrid, monthStart, monthTitle, shiftMonth, totalsByDay } from '../js/calendar.js';

test('месяц начинается с первого числа, а не с текущего дня', () => {
  assert.equal(monthStart('2026-10-04'), '2026-10-01');
  assert.equal(monthStart('2026-10-31'), '2026-10-01');
});

test('сдвиг месяца не перескакивает через месяц', () => {
  // 31 января при сдвиге «на -1 месяц» дало бы 31 декабря или 3 января, если считать от 31-го.
  assert.equal(shiftMonth('2026-01-31', -1), '2025-12-01');
  assert.equal(shiftMonth('2026-01-31', 1), '2026-02-01');
  assert.equal(shiftMonth('2026-12-15', 1), '2027-01-01');
  assert.equal(shiftMonth('2026-03-15', -1), '2026-02-01');
});

test('сетка месяца начинается с понедельника и содержит все дни', () => {
  // 1 октября 2026 — четверг, значит перед ним три клетки сентября.
  const grid = monthGrid('2026-10-05', { today: '2026-10-05' });
  assert.equal(grid.weeks.length, 5);
  for (const week of grid.weeks) assert.equal(week.length, 7, 'в неделе ровно семь клеток');

  const first = grid.weeks[0][0];
  assert.equal(first.iso, '2026-09-28', 'неделя начинается с понедельника');
  assert.equal(first.inMonth, false, 'это ещё сентябрь');

  const days = grid.weeks.flat().filter((cell) => cell.inMonth);
  assert.equal(days.length, 31, 'в октябре 31 день');
  assert.equal(days[0].iso, '2026-10-01');
  assert.equal(days[days.length - 1].iso, '2026-10-31');
  assert.equal(days.filter((cell) => cell.isToday).length, 1, 'сегодняшний день отмечен один раз');
});

test('февраль високосного года занимает 29 дней', () => {
  const leap = monthGrid('2028-02-10', { today: '2028-02-10' }).weeks.flat().filter((cell) => cell.inMonth);
  assert.equal(leap.length, 29);

  const plain = monthGrid('2026-02-10', { today: '2026-02-10' }).weeks.flat().filter((cell) => cell.inMonth);
  assert.equal(plain.length, 28);
});

test('месяц, начинающийся с понедельника, не тянет прошлые дни', () => {
  // 1 июня 2026 — понедельник.
  const grid = monthGrid('2026-06-10', { today: '2026-06-10' });
  assert.equal(grid.weeks[0][0].iso, '2026-06-01');
  assert.equal(grid.weeks[0][0].inMonth, true);
});

test('заголовок месяца без года, а чужой год показываем', () => {
  const thisYear = new Date().getFullYear();
  assert.equal(monthTitle(`${thisYear}-10-04`), 'октябрь');
  assert.equal(monthTitle('2024-10-04'), 'октябрь 2024');
});

test('суммы по дням собираются по датам записей', () => {
  const byDay = totalsByDay([
    { date: '2026-10-04', kcal: 300, protein: 20, fat: 10, carbs: 30 },
    { date: '2026-10-04', kcal: 200, protein: 10, fat: 5, carbs: 15 },
    { date: '2026-10-05', kcal: 100, protein: 5, fat: 2, carbs: 8 },
    { kcal: 50 },
  ]);
  assert.equal(byDay['2026-10-04'].kcal, 500);
  assert.equal(byDay['2026-10-04'].count, 2);
  assert.equal(byDay['2026-10-05'].protein, 5);
});

test('подписи дней недели идут с понедельника', () => {
  assert.equal(WEEKDAY_SHORT.length, 7);
  assert.equal(WEEKDAY_SHORT[0], 'пн');
  assert.equal(WEEKDAY_SHORT[6], 'вс');
});
