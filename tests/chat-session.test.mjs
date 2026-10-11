// Хранение разговора о еде: он переживает перезагрузку страницы, но не чужой день.
//
// Приложение перезагружает страницу само, когда приходит новая сборка, поэтому разговор
// кладётся в хранилище. Здесь проверяется само хранение: разметка и окно не участвуют.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clearChat, loadChat, loadTyped, saveChat, saveTyped } from '../js/chat-session.js';

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
  factor: 1,
  portion: 'all',
  portionNote: '',
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
  saveTyped('половина шаурмы из ларька', { storage });

  assert.equal(loadTyped({ storage }), 'половина шаурмы из ларька');
  assert.equal(loadChat({ date: DAY, storage }), null);

  saveTyped('', { storage });
  assert.equal(loadTyped({ storage }), '');
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
