// Проверка сохранённых продуктов: пересчёт на 100 г и на вес, порядок, подсказки.
// Запуск: node --test
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  entryFromProduct, forWeight, itemFromProduct, matchByName, nameProblem, orderProducts,
  per100g, per100FromLabel, per100Line, productFromParse, productPatch, searchProducts,
} from '../js/products.js';

const close = (actual, expected, message) => {
  assert.equal(Math.round(actual * 10) / 10, expected, message);
};

test('значения разбора пересчитываются на 100 г', () => {
  const per100 = per100g([{ grams: 300, kcal: 420, protein: 21, fat: 12, carbs: 30 }]);
  close(per100.kcal, 140, '300 г и 420 ккал дают 140 ккал на 100 г');
  close(per100.protein, 7);
  close(per100.fat, 4);
  close(per100.carbs, 10);
});

test('разбор с основой на 100 г сохраняется без пересчёта', () => {
  const per100 = per100g([{ grams: 100, kcal: 250, protein: 10, fat: 5, carbs: 20 }]);
  close(per100.kcal, 250);
  close(per100.carbs, 20);
});

test('несколько позиций складываются в одно отношение', () => {
  const per100 = per100g([
    { grams: 100, kcal: 200 },
    { grams: 300, kcal: 400 },
  ]);
  close(per100.kcal, 150, 'сумма 600 ккал на 400 г даёт 150 ккал на 100 г');
});

test('пустой разбор и нулевой вес дают нули, деления на ноль нет', () => {
  for (const items of [[], null, [{ grams: 0, kcal: 500 }], [{ kcal: 500 }]]) {
    const per100 = per100g(items);
    close(per100.kcal, 0);
    close(per100.protein, 0);
  }
});

test('значения на 100 г пересчитываются на вес порции', () => {
  const values = forWeight({ kcal: 250, protein: 10, fat: 5, carbs: 20 }, 200);
  close(values.kcal, 500, '250 ккал на 100 г при 200 г дают 500 ккал');
  close(values.protein, 20);
  close(values.fat, 10);
  close(values.carbs, 40);
});

test('вес без числа даёт нули', () => {
  for (const grams of [0, null, undefined, '', 'abc']) {
    close(forWeight({ kcal: 140 }, grams).kcal, 0, `вес «${grams}» не ломает расчёт`);
  }
});

test('чаще используемый продукт выходит выше', () => {
  const products = [
    { id: 'a', name: 'Творог', uses: 1, lastUsedAt: 100 },
    { id: 'b', name: 'Гречка', uses: 5, lastUsedAt: 50 },
    { id: 'c', name: 'Кефир', uses: 2, lastUsedAt: 200 },
  ];
  assert.deepEqual(orderProducts(products).map((item) => item.id), ['b', 'c', 'a']);
});

test('при равном счётчике выше тот, что использован позже', () => {
  const products = [
    { id: 'a', name: 'Творог', uses: 3, lastUsedAt: 100 },
    { id: 'b', name: 'Гречка', uses: 3, lastUsedAt: 300 },
  ];
  assert.deepEqual(orderProducts(products).map((item) => item.id), ['b', 'a']);
});

test('порядок по алфавиту сортирует по названию', () => {
  const products = [
    { id: 'a', name: 'Творог', uses: 9 },
    { id: 'b', name: 'Яблоко', uses: 1 },
    { id: 'c', name: 'Гречка', uses: 4 },
  ];
  assert.deepEqual(orderProducts(products, 'alpha').map((item) => item.name), ['Гречка', 'Творог', 'Яблоко']);
});

test('продукты не портятся при сортировке', () => {
  const products = [{ id: 'a', name: 'Творог', uses: 1 }, { id: 'b', name: 'Гречка', uses: 5 }];
  const sorted = orderProducts(products);
  assert.equal(products[0].id, 'a', 'исходный порядок массива остаётся прежним');
  assert.notEqual(sorted, products, 'возвращается копия');
});

test('поиск идёт по части названия и не зависит от регистра', () => {
  const products = [{ name: 'Творог 5%' }, { name: 'Гречка' }, { name: 'Творожный сыр' }];
  assert.deepEqual(searchProducts(products, 'твор').map((item) => item.name), ['Творог 5%', 'Творожный сыр']);
  assert.deepEqual(searchProducts(products, 'сыр').map((item) => item.name), ['Творожный сыр']);
});

test('пустой поиск показывает все продукты, без совпадений список пуст', () => {
  const products = [{ name: 'Гречка' }];
  assert.equal(searchProducts(products, '').length, 1);
  assert.equal(searchProducts(products, 'борщ').length, 0);
});

test('подсказка берёт продукты по началу названия', () => {
  const products = [{ name: 'Творог 5%' }, { name: 'Творожный сыр' }, { name: 'Сыр творожный' }];
  assert.deepEqual(matchByName(products, 'ТВОР').map((item) => item.name), ['Творог 5%', 'Творожный сыр']);
  assert.deepEqual(matchByName(products, 'творожный').map((item) => item.name), ['Творожный сыр']);
});

test('подсказка молчит на пустом наборе и без совпадений', () => {
  const products = [{ name: 'Творог 5%' }];
  assert.equal(matchByName(products, '').length, 0);
  assert.equal(matchByName(products, '   ').length, 0);
  assert.equal(matchByName(products, 'сыр').length, 0, 'совпадение в середине слова не подсказывается');
});

test('подсказок не больше пяти', () => {
  const products = Array.from({ length: 8 }, (_, i) => ({ name: `Продукт ${i}` }));
  assert.equal(matchByName(products, 'продукт').length, 5);
});

test('название обязательно', () => {
  assert.equal(nameProblem('Творог'), null);
  assert.ok(nameProblem(''), 'пустое название не годится');
  assert.ok(nameProblem('   '), 'пробелы названием не считаются');
  assert.ok(nameProblem(null));
});

test('правка продукта не сбрасывает счётчик использования', () => {
  const existing = { id: 'p1', name: 'Творог', per100: { kcal: 100, protein: 10, fat: 5, carbs: 3 }, uses: 5, lastUsedAt: 777 };
  const after = { ...existing, ...productPatch({ name: 'Творог 5%', per100: { kcal: 110 } }) };

  assert.equal(after.uses, 5, 'счётчик остаётся прежним');
  assert.equal(after.lastUsedAt, 777, 'время последнего использования остаётся прежним');
  assert.equal(after.name, 'Творог 5%', 'название меняется');
  close(after.per100.kcal, 110, 'значения меняются');
});

test('счётчик при сохранении задаётся явно, когда он передан', () => {
  const after = { uses: 5, ...productPatch({ name: 'Творог', per100: { kcal: 100 }, uses: 6, lastUsedAt: 900 }) };
  assert.equal(after.uses, 6);
  assert.equal(after.lastUsedAt, 900);
});

test('запись из продукта считается по весу и хранит снимок на 100 г', () => {
  const product = { id: 'p1', name: 'Творог 5%', per100: { kcal: 121, protein: 17, fat: 5, carbs: 3 } };
  const entry = entryFromProduct({ product, grams: 150, date: '2026-10-12', time: '09:30' });

  close(entry.kcal, 181.5, '121 ккал на 100 г при 150 г дают 181,5 ккал');
  close(entry.protein, 25.5);
  assert.equal(entry.grams, 150);
  assert.equal(entry.name, 'Творог 5%');
  assert.equal(entry.productId, 'p1');
  assert.deepEqual(entry.per100, { kcal: 121, protein: 17, fat: 5, carbs: 3 });
  assert.equal(entry.source, 'product');
  assert.equal(entry.date, '2026-10-12');
  assert.equal(entry.cost, undefined, 'модель не звали, значит стоимости у записи нет');
});

test('правка продукта не меняет уже созданную запись', () => {
  const product = { id: 'p1', name: 'Творог', per100: { kcal: 100, protein: 10, fat: 5, carbs: 3 } };
  const entry = entryFromProduct({ product, grams: 100, date: '2026-10-12', time: '09:30' });

  product.per100.kcal = 999;
  product.name = 'Другой продукт';

  close(entry.kcal, 100);
  assert.equal(entry.name, 'Творог');
});

test('позиция разбора из продукта считается по весу', () => {
  const product = { name: 'Гречка', per100: { kcal: 343, protein: 13, fat: 3.4, carbs: 72 } };
  const item = itemFromProduct(product, 200);

  assert.equal(item.name, 'Гречка');
  assert.equal(item.grams, 200);
  close(item.kcal, 686);
  close(item.carbs, 144);
});

test('запись из продукта не зовёт модель и не пишет расход', () => {
  const files = ['../js/products.js', '../js/ui/products.js'];
  const source = files
    .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
    .join('\n');

  assert.equal(/llm|logUsage|usage\.js/.test(source), false,
    'в пути записи из продукта нет ни модели, ни журнала расхода');
});

test('значения таблицы пересчитываются на 100 г по граммовке', () => {
  const per100 = per100FromLabel({ kcal: 60, protein: 3, fat: 2, carbs: 6 }, 30);
  close(per100.kcal, 200, '60 ккал на порцию 30 г дают 200 ккал на 100 г');
  close(per100.protein, 10);
  close(per100.fat, 6.7);
  close(per100.carbs, 20);
});

test('таблица на 100 г переносится без пересчёта', () => {
  const per100 = per100FromLabel({ kcal: 121, protein: 17, fat: 5, carbs: 3 }, 100);
  close(per100.kcal, 121);
  close(per100.protein, 17);
  close(per100.carbs, 3);
});

test('граммовка без числа не делит на ноль', () => {
  for (const basis of [0, -5, null, undefined, '', 'abc']) {
    const per100 = per100FromLabel({ kcal: 250, protein: 10 }, basis);
    close(per100.kcal, 250, `граммовка «${basis}» оставляет значения как есть`);
    close(per100.protein, 10);
  }
});

test('пустая таблица даёт нули', () => {
  const per100 = per100FromLabel({}, 30);
  close(per100.kcal, 0);
  close(per100.carbs, 0);
});

test('ответ модели сводится к продукту со значениями на 100 г', () => {
  const product = productFromParse({
    name: '  Творог 5%  ',
    values: { kcal: 60, protein: 9, fat: 2.5, carbs: 2 },
    basisGrams: 30,
  });

  assert.equal(product.name, 'Творог 5%', 'название обрезается по краям');
  close(product.per100.kcal, 200);
  close(product.per100.fat, 8.3);
  close(product.per100.protein, 30);
});

test('разбор без граммовки сводится к продукту как есть', () => {
  const product = productFromParse({ name: 'Хлопья', values: { kcal: 350, protein: 12 } });
  close(product.per100.kcal, 350);
  close(product.per100.carbs, 0);
});

test('строка продукта называет граммовку, к которой отнесены числа', () => {
  assert.equal(per100Line({ kcal: 140, protein: 7, fat: 4, carbs: 10 }),
    '140 ккал · Б 7 · Ж 4 · У 10 на 100 г');
});
