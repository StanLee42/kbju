// Проверка слоя инструментов: вычисления по дню и истории, валидация аргументов.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS } from '../js/norm.js';
import { TOOL_SPECS, dayOverview, historyOverview, toolSpec, validateArgs } from '../js/tools.js';

const settings = structuredClone(DEFAULT_SETTINGS);

const entries = [
  { time: '18:20', name: 'Ужин', grams: 300, kcal: 420, protein: 30, fat: 14, carbs: 40, source: 'photo' },
  { time: '09:10', name: 'Завтрак', grams: 200, kcal: 300, protein: 20, fat: 10, carbs: 30, source: 'manual' },
];

test('обзор дня отдаёт норму, съеденное и остаток', () => {
  // 2026-10-05 — понедельник, обычный день: 2000 ккал, Б130 Ж65 У200.
  const overview = dayOverview({ date: '2026-10-05', settings, entries });
  assert.equal(overview.dayType.id, 'rest');
  assert.equal(overview.norm.kcal, 2000);
  assert.equal(overview.eaten.kcal, 720);
  assert.equal(overview.remaining.kcal, 1280);
  assert.equal(overview.remaining.protein, 80);
});

test('записи в обзоре идут по времени, а не как попало', () => {
  const overview = dayOverview({ date: '2026-10-05', settings, entries });
  assert.deepEqual(overview.entries.map((entry) => entry.name), ['Завтрак', 'Ужин']);
  assert.equal(overview.entries[1].source, 'photo');
});

test('в тренировочный день норма другая', () => {
  // 2026-10-07 — среда, тренировка.
  const overview = dayOverview({ date: '2026-10-07', settings, entries });
  assert.equal(overview.dayType.id, 'train');
  assert.equal(overview.norm.kcal, 2400);
  assert.equal(overview.remaining.kcal, 1680);
});

test('перебор даёт отрицательный остаток', () => {
  const heavy = [{ time: '12:00', name: 'Пир', kcal: 2600, protein: 100, fat: 90, carbs: 300 }];
  const overview = dayOverview({ date: '2026-10-05', settings, entries: heavy });
  assert.equal(overview.remaining.kcal, -600);
});

test('история показывает дни по порядку и средние только по дням с едой', () => {
  const history = historyOverview({
    days: 3,
    today: '2026-10-07',
    entriesByDate: {
      '2026-10-05': [{ kcal: 2000, protein: 100, fat: 60, carbs: 200 }],
      '2026-10-06': [{ kcal: 2200, protein: 120, fat: 70, carbs: 210 }],
      '2026-10-07': [],
    },
  });
  assert.deepEqual(history.days.map((day) => day.date), ['2026-10-05', '2026-10-06', '2026-10-07']);
  assert.equal(history.daysWithFood, 2);
  assert.equal(history.average.kcal, 2100);
  assert.equal(history.days[2].kcal, 0);
});

test('история считает изменение веса по измерениям', () => {
  const history = historyOverview({
    days: 7,
    today: '2026-10-07',
    entriesByDate: {},
    measurements: [
      { date: '2026-09-15', weight: 82 },
      { date: '2026-10-05', weight: 92.2 },
      { date: '2026-10-07', weight: 91.9 },
    ],
  });
  assert.equal(history.weight.first, 93);
  assert.equal(history.weight.last, 91.9);
  assert.equal(history.weight.change, -1.1);
});

test('без измерений веса в истории его просто нет', () => {
  const history = historyOverview({ days: 2, today: '2026-10-07', entriesByDate: {} });
  assert.equal(history.weight, null);
  assert.equal(history.average, null);
});

test('валидация аргументов ловит пропуски, лишнее и выход за границы', () => {
  const spec = toolSpec('add_entry');

  assert.equal(validateArgs(spec, { name: 'Творог', kcal: 200 }).ok, true);

  const missing = validateArgs(spec, { kcal: 200 });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /name/);

  const unknown = validateArgs(spec, { name: 'Творог', weight: 200 });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /weight/);

  const range = validateArgs(spec, { name: 'Творог', kcal: 9000 });
  assert.equal(range.ok, false);
  assert.match(range.error, /kcal/);

  const type = validateArgs(spec, { name: 'Творог', protein: 'много' });
  assert.equal(type.ok, false);
  assert.match(type.error, /protein/);
});

test('обязательные параметры и границы объявлены у всех инструментов', () => {
  assert.ok(TOOL_SPECS.length >= 6);
  for (const spec of TOOL_SPECS) {
    assert.equal(typeof spec.name, 'string');
    assert.ok(spec.description?.length > 10, `у ${spec.name} слишком короткое описание`);
    assert.equal(spec.parameters?.type, 'object');
    for (const required of spec.parameters.required || []) {
      assert.ok(spec.parameters.properties[required], `${spec.name}: ${required} не описан`);
    }
  }
});

test('неизвестный инструмент не падает, а отвечает ошибкой', () => {
  assert.equal(toolSpec('нет-такого'), null);
  const spec = toolSpec('log_water');
  assert.equal(validateArgs(spec, { ml: 250 }).ok, true);
  assert.equal(validateArgs(spec, { ml: 0 }).ok, false);
});
