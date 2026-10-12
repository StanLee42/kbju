// Проверка разбора адреса данных снимка: из переписки снимок приходит строкой,
// а запросу нужны части по отдельности.
// Запуск: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { imageFromDataUrl } from '../js/media/image.js';

test('адрес данных разбирается на части', () => {
  const image = imageFromDataUrl('data:image/png;base64,AAAA');

  assert.deepEqual(image, { base64: 'AAAA', mime: 'image/png' });
});

test('разделитель внутри данных не рвёт снимок', () => {
  // Данные base64 запятых не содержат, но проверка держится на первом разделителе.
  const image = imageFromDataUrl('data:image/jpeg;base64,AA,BB');

  assert.equal(image.base64, 'AA,BB');
  assert.equal(image.mime, 'image/jpeg');
});

test('тип без имени подменяется безопасным', () => {
  assert.equal(imageFromDataUrl('data:;base64,AAAA').mime, 'image/jpeg');
});

test('пустой адрес не ломает разбор', () => {
  for (const value of ['', null, undefined, 'AAAA', 'data:image/jpeg;base64,']) {
    assert.equal(imageFromDataUrl(value), null, `адрес «${String(value)}» данных не содержит`);
  }
});
