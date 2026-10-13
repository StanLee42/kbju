// Проверка объединения и разбора через отладочный протокол Chrome.
//
// Собирает приём пищи из трёх записей без позиций, объединяет их, открывает объединённую
// запись, нажимает «Разделить на составляющие» и убеждается, что вернулись те же три записи.
// Ошибка была именно здесь: строки при объединении удалялись, а разбор по позициям у записи
// без позиций недоступен.
//
// Записи кладутся в хранилище сразу, а не набираются через разговор: разговор зовёт модель
// и без ключа не работает, а проверять нужно объединение и разбор, а не разбор моделью.
//
// Запуск: node tools/cdp-merge-split.mjs [url]
const url = process.argv[2] || 'http://127.0.0.1:8769/#/today';
const debugPort = process.env.CDP_PORT || 9222;

const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const page = targets.find((target) => target.type === 'page');
if (!page) {
  console.error('нет открытой вкладки');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

let nextId = 0;
const pending = new Map();
const problems = [];

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result);
    pending.delete(message.id);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    problems.push(message.params.exceptionDetails.exception?.description
      || message.params.exceptionDetails.text);
  }
  // version.txt ищет проверка обновления: на сервере из исходников его нет.
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error'
    && !String(message.params.entry.url || '').includes('version.txt')) {
    problems.push(message.params.entry.url
      ? `${message.params.entry.text} · ${message.params.entry.url}`
      : message.params.entry.text);
  }
});

function send(method, params = {}) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (result?.exceptionDetails) {
    problems.push(result.exceptionDetails.exception?.description || 'ошибка вычисления');
  }
  return result?.result?.value;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, details = '') {
  console.log(`${ok ? 'ок  ' : 'БЕДА'}  ${name}${details ? ` - ${details}` : ''}`);
  if (!ok) problems.push(name);
}

const source = [
  { name: 'Проверка: курица', time: '13:00', grams: 120, kcal: 300, protein: 25, fat: 16, carbs: 4 },
  { name: 'Проверка: салат', time: '13:30', grams: 200, kcal: 110, protein: 3, fat: 8, carbs: 8 },
  { name: 'Проверка: хлеб', time: '13:55', grams: 30, kcal: 70, protein: 2, fat: 1, carbs: 14 },
];

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url });
await wait(2500);

// Чистим прошлые прогоны: и данные, и сборку в кэше службы.
await evaluate(`(async () => {
  const registrations = await navigator.serviceWorker?.getRegistrations?.() || [];
  for (const registration of registrations) await registration.unregister();
  if (globalThis.caches) for (const key of await caches.keys()) await caches.delete(key);
  const dbs = await indexedDB.databases?.() || [];
  for (const info of dbs) if (info.name) indexedDB.deleteDatabase(info.name);
  return 'ok';
})()`);
await send('Page.reload', { ignoreCache: true });
await wait(2500);

console.log('шаг 1: кладём в дневник три записи без позиций');
const seeded = await evaluate(`(async () => {
  const pad = (value) => String(value).padStart(2, '0');
  const now = new Date();
  const date = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join('-');
  const rows = ${JSON.stringify(source)}.map((row, index) => ({
    id: 'seed-' + index, date, time: row.time, name: row.name, grams: row.grams,
    kcal: row.kcal, protein: row.protein, fat: row.fat, carbs: row.carbs,
    comment: '', source: 'manual', items: null, parts: null, thumbId: null,
    basis: null, confidence: null, assumptions: '', cost: 0, productId: null, per100: null,
    createdAt: Date.now(),
  }));
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('kbju', 4);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readwrite');
    const store = tx.objectStore('entries');
    for (const row of rows) store.put(row);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return date;
})()`);
console.log('   день:', seeded);
await send('Page.reload', { ignoreCache: true });
await wait(2500);

const written = await evaluate(`JSON.stringify({
  entries: document.querySelectorAll('.entry').length,
  total: document.querySelector('.total-line')?.textContent || '',
})`);
console.log('   ', written);
check('в дне три записи', JSON.parse(written).entries === 3, written);

console.log('шаг 2: объединяем их');
await evaluate(`[...document.querySelectorAll('.feed-head button')]
  .find((button) => button.textContent.trim() === 'Объединить').click(); 'ok'`);
await wait(400);
// Лента перерисовывается после каждой отметки, поэтому строку каждый раз ищем заново.
await evaluate(`(async () => {
  for (let index = 0; index < 3; index += 1) {
    document.querySelectorAll('.entry')[index]?.click();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return 'ok';
})()`);
await wait(400);
const marked = await evaluate(`document.querySelector('.merge-bar .small')?.textContent || ''`);
check('отмечены три записи', marked.includes('3'), marked);
await evaluate(`[...document.querySelectorAll('.merge-bar button')]
  .find((button) => button.textContent.trim() === 'Объединить отмеченные').click(); 'ok'`);
await wait(800);

const merged = await evaluate(`JSON.stringify({
  entries: document.querySelectorAll('.entry').length,
  name: document.querySelector('.entry-name')?.textContent || '',
  time: document.querySelector('.entry-time')?.textContent || '',
  kcal: document.querySelector('.entry .mono')?.textContent || '',
  total: document.querySelector('.total-line')?.textContent || '',
})`);
console.log('   ', merged);
const mergedData = JSON.parse(merged);
check('осталась одна запись', mergedData.entries === 1, mergedData.entries);
check('время от самой ранней строки', mergedData.time === '13:00', mergedData.time);
check('числа сложились', mergedData.kcal === '480', mergedData.kcal);
check('итог дня не изменился', mergedData.total.includes('480'), mergedData.total);

console.log('шаг 3: открываем объединённую запись');
await evaluate(`document.querySelector('.entry').click(); 'ok'`);
await wait(700);

const opened = await evaluate(`JSON.stringify({
  title: document.querySelector('.sheet-title')?.textContent || '',
  rows: [...document.querySelectorAll('.sheet div.small')]
    .map((node) => node.textContent).filter((text) => text.includes(':')),
  canSplit: [...document.querySelectorAll('.sheet button')]
    .some((button) => button.textContent.trim() === 'Разделить на составляющие'),
})`);
console.log('   ', opened);
const openedData = JSON.parse(opened);
check('открылось окно записи, а не правка', openedData.title === mergedData.name, openedData.title);
check('видна кнопка разбора', openedData.canSplit);
check('видны три составляющие', openedData.rows.length === 3, openedData.rows.join(' | '));

console.log('шаг 4: разбираем обратно');
await evaluate(`[...document.querySelectorAll('.sheet button')]
  .find((button) => button.textContent.trim() === 'Разделить на составляющие').click(); 'ok'`);
await wait(900);

const split = await evaluate(`JSON.stringify({
  entries: document.querySelectorAll('.entry').length,
  names: [...document.querySelectorAll('.entry-name')].map((node) => node.textContent),
  times: [...document.querySelectorAll('.entry-time')].map((node) => node.textContent),
  kcals: [...document.querySelectorAll('.entry .mono')].map((node) => node.textContent),
  sheet: Boolean(document.querySelector('.sheet')),
  total: document.querySelector('.total-line')?.textContent || '',
})`);
console.log('   ', split);
const splitData = JSON.parse(split);
check('вернулись три записи', splitData.entries === 3, splitData.entries);
check('вернулись те же названия',
  JSON.stringify(splitData.names) === JSON.stringify(source.map((entry) => entry.name)),
  splitData.names.join(', '));
check('вернулось то же время',
  JSON.stringify(splitData.times) === JSON.stringify(['13:00', '13:30', '13:55']),
  splitData.times.join(', '));
check('вернулись те же числа', JSON.stringify(splitData.kcals) === JSON.stringify(['300', '110', '70']),
  splitData.kcals.join(', '));
check('окно закрылось', splitData.sheet === false);
check('итог дня не изменился', splitData.total.includes('480'), splitData.total);

console.log(problems.length ? `ОШИБКИ (${problems.length}):\n${problems.join('\n')}` : 'ошибок нет');
ws.close();
process.exit(problems.length ? 1 : 0);
