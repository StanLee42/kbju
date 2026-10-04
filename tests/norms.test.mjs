// Проверка расчёта норм по измеренному составу тела.
//
// Пример выдуман для тестов: мужчина, 41 год, 176 см, 82 кг, тощая масса 63,5 кг,
// измеренный основной обмен 1800 ккал. Никаких реальных измерений здесь нет.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mifflinStJeor, normsFromMeasurement } from '../js/norm.js';

const measurement = {
  sex: 'M', age: 41, height: 176, weight: 82,
  leanMass: 63.5, fatMass: 18.5, bmr: 1800, fatPercent: 22.6,
};

test('нормы считаются из измеренного обмена, а не из формулы', () => {
  const result = normsFromMeasurement({ measurement });
  assert.equal(result.ok, true);
  assert.equal(result.base.measuredBmr, true);
  assert.equal(result.base.bmr, 1800);
  assert.equal(result.rest.protein, 121);
  assert.equal(result.rest.fat, 66);
  assert.equal(result.training.fat, 66);
  assert.equal(result.rest.kcal, 1844);
  assert.equal(result.training.kcal, 2433);
  assert.equal(result.rest.carbs, 192);
  assert.equal(result.training.carbs, 321);
});

test('недельный дефицит соответствует заявленному темпу', () => {
  const { weekly } = normsFromMeasurement({ measurement });
  assert.equal(weekly.deficit, 3850);
  assert.equal(weekly.expectedLossKg, 0.5);
  assert.equal(weekly.kcal, 2096);
});

test('белок одинаков в оба дня, потому что привязан к тощей массе', () => {
  const { rest, training } = normsFromMeasurement({ measurement });
  assert.equal(rest.protein, training.protein);
});

test('в тренировочный день углеводов больше, а дефицит мягче', () => {
  const { rest, training } = normsFromMeasurement({ measurement });
  assert.ok(training.carbs > rest.carbs);
  assert.ok(training.kcal > rest.kcal);
});

test('без измерения обмена работает формула Миффлина', () => {
  const result = normsFromMeasurement({
    measurement: { sex: 'M', age: 41, height: 176, weight: 82, leanMass: 63.5 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.base.bmr, 1720);
  assert.equal(result.base.measuredBmr, false);
  assert.match(result.assumptions.join(' '), /Миффлина/);
});

test('формула Миффлина считается по полу', () => {
  assert.equal(mifflinStJeor({ sex: 'M', weight: 82, height: 176, age: 41 }), 1720);
  assert.equal(mifflinStJeor({ sex: 'F', weight: 60, height: 165, age: 30 }), 1320);
  assert.equal(mifflinStJeor({ sex: 'M', weight: 0, height: 176, age: 41 }), null);
});

test('без тощей массы она оценивается, и об этом сказано прямо', () => {
  const result = normsFromMeasurement({ measurement: { weight: 82, bmr: 1800 } });
  assert.equal(result.ok, true);
  assert.equal(result.base.leanMass, 61.5);
  assert.match(result.assumptions.join(' '), /75%/);
});

test('не хватает данных — понятная ошибка, а не тихие нули', () => {
  assert.equal(normsFromMeasurement({ measurement: {} }).ok, false);
  assert.match(normsFromMeasurement({ measurement: {} }).error, /не хватает/);
  assert.equal(normsFromMeasurement({ measurement: { bmr: 1800 } }).ok, false);
});

test('другой темп меняет калории и недельный дефицит', () => {
  const slow = normsFromMeasurement({ measurement, pace: 0.25 });
  const fast = normsFromMeasurement({ measurement, pace: 0.75 });
  assert.ok(slow.rest.kcal > fast.rest.kcal);
  assert.equal(slow.weekly.deficit, 1925);
  assert.equal(fast.weekly.deficit, 5775);
  assert.equal(slow.weekly.expectedLossKg, 0.25);
});

test('расписание влияет на распределение, но не на недельную сумму', () => {
  const three = normsFromMeasurement({ measurement, trainingDays: 3, restDays: 4 });
  const two = normsFromMeasurement({ measurement, trainingDays: 2, restDays: 5 });
  assert.equal(three.weekly.deficit, two.weekly.deficit);
  assert.notEqual(three.training.kcal, two.training.kcal);
});

test('каждый шаг расчёта объяснён словами', () => {
  const { steps } = normsFromMeasurement({ measurement });
  assert.ok(steps.length >= 6);
  assert.match(steps.join('\n'), /тощая масса 63.5 кг × 1.9 г\/кг/);
  assert.match(steps.join('\n'), /1800/);
});
