// Хранение разговора о еде: он переживает перезагрузку страницы, но не чужой день.
//
// Приложение перезагружает страницу само, когда приходит новая сборка, поэтому разговор
// кладётся в хранилище. Здесь проверяется само хранение: разметка и окно не участвуют.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clearChat, loadChat, loadTyped, saveChat, saveTyped } from '../js/chat-session.js';
import {
  clearProductParse, loadProductParse, loadProductTyped, saveProductParse, saveProductTyped,
} from '../js/chat-session.js';

/** Хранилище как в браузере, но в памяти. Предел повторяет поведение при переполнении. */
function memoryStorage({ limit = Infinity } = {}) {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      if (String(value).length > limit) throw new Error('QuotaExceededError');
      map.set(key, String(value));
    },
    removeItem: (key) => map.delete(key),
    size: () => map.size,
  };
}

const DAY = '2026-10-11';
const items = [{ name: 'борщ', grams: 300, kcal: 120, protein: 5, fat: 4, carbs: 12 }];
const analysis = {
  dish: 'борщ',
  items,
  basis: 'тарелка 300 г',
  confidence: 'средняя',
  assumptions: [],
  cost: 0.0004,
};
const current = {
  items,
  totals: { grams: 300, kcal: 120, protein: 5, fat: 4, carbs: 12 },
};

test('разговор возвращается после перезагрузки целиком', () => {
  const storage = memoryStorage();
  const messages = [
    { role: 'user', text: 'тарелка борща', photo: 'data:image/jpeg;base64,AAAA' },
    { role: 'assistant', analysis },
  ];

  saveChat({ date: DAY, messages, draft: analysis, current, cost: 0.0009 }, { storage });

  const back = loadChat({ date: DAY, storage });
  assert.equal(back.date, DAY);
  assert.equal(back.messages.length, 2);
  assert.equal(back.messages[0].text, 'тарелка борща');
  assert.equal(back.messages[0].photo, 'data:image/jpeg;base64,AAAA');
  assert.equal(back.messages[1].analysis.dish, 'борщ');
  assert.equal(back.draft.dish, 'борщ');
  assert.equal(back.current.totals.kcal, 120);
  assert.equal(back.cost, 0.0009);
});

test('разговор другого дня не возвращается', () => {
  const storage = memoryStorage();
  saveChat({ date: DAY, messages: [{ role: 'user', text: 'каша' }] }, { storage });

  assert.equal(loadChat({ date: '2026-10-12', storage }), null);
  assert.equal(loadChat({ date: DAY, storage }).messages.length, 1);
});

test('битая запись не ломает открытие окна', () => {
  const storage = memoryStorage();
  // Запись проверяется по ключу хранилища: форма записи это договор между запусками.
  const key = 'kbju-food-chat';

  storage.setItem(key, '{это не json');
  assert.equal(loadChat({ date: DAY, storage }), null);

  storage.setItem(key, JSON.stringify({ v: 99, date: DAY, messages: [{ role: 'user', text: 'каша' }] }));
  assert.equal(loadChat({ date: DAY, storage }), null);

  storage.setItem(key, JSON.stringify({ v: 1, date: DAY, messages: 'не список' }));
  assert.equal(loadChat({ date: DAY, storage }), null);
});

test('сообщения не той формы отсеиваются', () => {
  const storage = memoryStorage();
  storage.setItem('kbju-food-chat', JSON.stringify({
    v: 1,
    date: DAY,
    messages: [
      { role: 'user', text: 'каша' },
      { role: 'system', text: 'чужое' },
      null,
      { role: 'user' },
      { role: 'assistant', error: { title: 'нет сети', hint: 'проверьте связь' } },
    ],
    cost: 0,
  }));

  const back = loadChat({ date: DAY, storage });
  assert.equal(back.messages.length, 2);
  assert.equal(back.messages[0].text, 'каша');
  assert.equal(back.messages[1].error.title, 'нет сети');
});

test('пустой разговор не хранится', () => {
  const storage = memoryStorage();
  saveChat({ date: DAY, messages: [] }, { storage });

  assert.equal(storage.size(), 0);
  assert.equal(loadChat({ date: DAY, storage }), null);
});

test('набранный текст живёт отдельно от переписки', () => {
  const storage = memoryStorage();
  saveTyped('половина шаурмы из ларька', { date: DAY, storage });

  assert.equal(loadTyped({ date: DAY, storage }), 'половина шаурмы из ларька');
  assert.equal(loadChat({ date: DAY, storage }), null);

  saveTyped('', { date: DAY, storage });
  assert.equal(loadTyped({ date: DAY, storage }), '');
});

test('набранный текст другого дня не показывается', () => {
  const storage = memoryStorage();
  saveTyped('половина шаурмы', { date: DAY, storage });

  assert.equal(loadTyped({ date: '2026-10-12', storage }), '');
  assert.equal(loadTyped({ date: DAY, storage }), 'половина шаурмы');
});

test('битая запись набранного не ломает поле ввода', () => {
  const storage = memoryStorage();
  storage.setItem('kbju-food-chat-text', 'просто строка');
  assert.equal(loadTyped({ date: DAY, storage }), '');

  storage.setItem('kbju-food-chat-text', JSON.stringify({ v: 99, date: DAY, text: 'каша' }));
  assert.equal(loadTyped({ date: DAY, storage }), '');
});

test('открытие окна на другом дне не стирает разговор прежнего дня', () => {
  const storage = memoryStorage();
  saveChat({ date: DAY, messages: [{ role: 'user', text: 'борщ' }], current }, { storage });

  // Окно открыли на другом дне: сохранять там нечего, и запись прежнего дня уцелела.
  saveChat({ date: '2026-10-12', messages: [], current: null }, { storage });

  const back = loadChat({ date: DAY, storage });
  assert.equal(back.messages.length, 1);
  assert.equal(back.messages[0].text, 'борщ');
});

test('очистка убирает и переписку, и набранное', () => {
  const storage = memoryStorage();
  saveChat({ date: DAY, messages: [{ role: 'user', text: 'каша' }] }, { storage });
  saveTyped('ещё ложку', { storage });

  clearChat({ storage });

  assert.equal(loadChat({ date: DAY, storage }), null);
  assert.equal(loadTyped({ storage }), '');
});

test('при нехватке места снимки отбрасываются, слова остаются', () => {
  const storage = memoryStorage({ limit: 600 });
  const photo = `data:image/jpeg;base64,${'A'.repeat(2000)}`;

  saveChat({
    date: DAY,
    messages: [{ role: 'user', text: 'шаурма', photo }, { role: 'assistant', analysis }],
  }, { storage });

  const back = loadChat({ date: DAY, storage });
  assert.equal(back.messages.length, 2);
  assert.equal(back.messages[0].text, 'шаурма');
  assert.equal(back.messages[0].photo, null);
  assert.equal(back.messages[1].analysis.dish, 'борщ');
});

test('хранилище без места не отдаёт мусор', () => {
  const storage = memoryStorage({ limit: 1 });
  const saved = saveChat({ date: DAY, messages: [{ role: 'user', text: 'каша' }] }, { storage });

  assert.equal(saved, false);
  assert.equal(loadChat({ date: DAY, storage }), null);
});

test('недоступное хранилище не ломает разговор', () => {
  const broken = {
    getItem: () => { throw new Error('данные сайта запрещены'); },
    setItem: () => { throw new Error('данные сайта запрещены'); },
    removeItem: () => { throw new Error('данные сайта запрещены'); },
  };

  assert.equal(saveChat({ date: DAY, messages: [{ role: 'user', text: 'каша' }] }, { storage: broken }), false);
  assert.equal(loadChat({ date: DAY, storage: broken }), null);
  assert.equal(loadTyped({ storage: broken }), '');
  assert.equal(saveTyped('каша', { storage: broken }), false);
  clearChat({ storage: broken });
});

// Разбор снимка упаковки: то же хранение, но без привязки ко дню.
const parseAnswer = {
  name: 'Творог 5%',
  values: { kcal: 60, protein: 9, fat: 2.5, carbs: 2 },
  basisGrams: 30,
  hasNumbers: true,
  source: 'label',
  confidence: 'high',
  assumptions: 'С таблицы на порцию.',
  warnings: [],
};
const savedProduct = { name: 'Творог 5%', per100: { kcal: 200, protein: 30, fat: 8.3, carbs: 6.7 } };

test('разбор упаковки возвращается после перезагрузки целиком', () => {
  const storage = memoryStorage();
  const messages = [
    { role: 'user', text: 'это творог', photo: 'data:image/jpeg;base64,AAAA' },
    { role: 'assistant', answer: { ...parseAnswer, cost: 0.0004 } },
  ];

  saveProductParse({ messages, product: savedProduct, draft: parseAnswer, cost: 0.0004 }, { storage });

  const back = loadProductParse({ storage });
  assert.equal(back.messages.length, 2);
  assert.equal(back.messages[0].text, 'это творог');
  assert.equal(back.messages[0].photo, 'data:image/jpeg;base64,AAAA');
  assert.equal(back.messages[1].answer.name, 'Творог 5%');
  assert.equal(back.draft.basisGrams, 30);
  assert.equal(back.cost, 0.0004);
  assert.equal(back.product.per100.kcal, 200);
});

test('поправленное число переживает перезагрузку', () => {
  const storage = memoryStorage();
  const edited = { name: 'Творог 5%', per100: { ...savedProduct.per100, kcal: 201 } };
  saveProductParse({ messages: [], product: edited }, { storage });

  assert.equal(loadProductParse({ storage }).product.per100.kcal, 201);
});

test('разбор упаковки не привязан ко дню', () => {
  // Дня в записи нет: продукт один для всего списка, а не на дату.
  const storage = memoryStorage();
  saveProductParse({ product: savedProduct }, { storage });

  assert.equal(loadProductParse({ storage }).product.per100.protein, 30);
});

test('битая запись разбора не ломает окно', () => {
  const storage = memoryStorage();
  storage.setItem('kbju-product-parse', '{это не json');
  assert.equal(loadProductParse({ storage }), null);

  storage.setItem('kbju-product-parse', JSON.stringify({ v: 99, messages: [] }));
  assert.equal(loadProductParse({ storage }), null);

  // Карточка без значений не восстанавливается: сохранять по ней нечего.
  storage.setItem('kbju-product-parse', JSON.stringify({ v: 1, messages: [], product: { name: 'Творог' } }));
  assert.equal(loadProductParse({ storage }), null);
});

test('пустой разбор упаковки не затирает прежний', () => {
  const storage = memoryStorage();
  saveProductParse({ product: savedProduct }, { storage });

  // Окно открыли и закрыли, ничего не разобрав: прежнюю запись не трогаем.
  saveProductParse({ messages: [], product: null }, { storage });

  assert.equal(loadProductParse({ storage }).product.per100.kcal, 200);
});

test('при нехватке места снимок упаковки отбрасывается, числа остаются', () => {
  const storage = memoryStorage({ limit: 600 });
  const photo = `data:image/jpeg;base64,${'A'.repeat(2000)}`;

  saveProductParse({ messages: [{ role: 'user', text: 'творог', photo }], product: savedProduct }, { storage });

  const back = loadProductParse({ storage });
  assert.equal(back.messages.length, 1);
  assert.equal(back.messages[0].text, 'творог');
  assert.equal(back.messages[0].photo, null);
  assert.equal(back.product.per100.kcal, 200);
});

test('набранные слова к снимку возвращаются отдельно от разбора', () => {
  const storage = memoryStorage();
  saveProductTyped('творог 5 процентов', { storage });

  assert.equal(loadProductTyped({ storage }), 'творог 5 процентов');
  assert.equal(loadProductParse({ storage }), null);

  saveProductTyped('', { storage });
  assert.equal(loadProductTyped({ storage }), '');
});

test('очистка стирает и разбор упаковки, и набранные слова', () => {
  const storage = memoryStorage();
  saveProductParse({ product: savedProduct }, { storage });
  saveProductTyped('творог', { storage });

  clearProductParse({ storage });

  assert.equal(loadProductParse({ storage }), null);
  assert.equal(loadProductTyped({ storage }), '');
});

test('недоступное хранилище не ломает разбор упаковки', () => {
  const broken = {
    getItem: () => { throw new Error('данные сайта запрещены'); },
    setItem: () => { throw new Error('данные сайта запрещены'); },
    removeItem: () => { throw new Error('данные сайта запрещены'); },
  };

  assert.equal(saveProductParse({ product: savedProduct }, { storage: broken }), false);
  assert.equal(loadProductParse({ storage: broken }), null);
  assert.equal(loadProductTyped({ storage: broken }), '');
  assert.equal(saveProductTyped('творог', { storage: broken }), false);
  clearProductParse({ storage: broken });
});
