// Сквозная проверка списка сохранённых продуктов через отладочный протокол Chrome:
// открывает окно добавления, заводит продукт, записывает его в дневник по весу,
// читает ленту дня и убеждается, что запрос к модели не ушёл.
//
// Запуск (нужен Chrome с отладочным портом и локальный сервер):
//   node tools/cdp-products.mjs [url]
import { writeFileSync } from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:8765/#/today';
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
const requests = [];

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result);
    pending.delete(message.id);
    return;
  }
  if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
  if (message.method === 'Runtime.exceptionThrown') {
    problems.push(message.params.exceptionDetails.exception?.description
      || message.params.exceptionDetails.text);
  }
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    const entry = message.params.entry;
    // Файл с версией сборки отдаёт только собранная папка, а здесь работает сервер
    // с исходниками: его отсутствие не ошибка страницы.
    if (!/version\.txt|favicon\.ico/.test(entry.url || entry.text || '')) {
      problems.push(`${entry.text} · ${entry.url || ''}`);
    }
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
const check = (ok, message) => {
  if (!ok) problems.push(message);
  return ok;
};

/** Общие помощники для шагов: живут в странице, поэтому описаны один раз. */
const HELPERS = `
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const root = () => document.getElementById('sheetRoot');
  const click = (el) => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return wait(120); };
  const byText = (sel, text) => [...document.querySelectorAll(sel)]
    .find((node) => node.textContent.trim() === text);
  const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
`;

await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await send('Page.enable');
// Кэш выключен: иначе браузер отдаёт прежнюю версию модуля, и проверка судит по старому коду.
await send('Network.setCacheDisabled', { cacheDisabled: true });
// Служебный работник обходится по той же причине: на порту мог остаться работник прошлого
// прогона, и он отдаёт прежнюю страницу приложения вместо свежей.
await send('Network.setBypassServiceWorker', { bypass: true });
await send('Page.navigate', { url });
await wait(3000);

// Чистим прошлые прогоны, чтобы проверка была повторяемой.
await evaluate(`(async () => {
  const dbs = await indexedDB.databases?.() || [];
  for (const info of dbs) if (info.name) indexedDB.deleteDatabase(info.name);
  return 'ok';
})()`);
await send('Page.reload', { ignoreCache: true });
await wait(2500);
requests.length = 0;

console.log('шаг 1: вкладка продуктов, вход из разговора и пустой список');
const emptyState = await evaluate(`(async () => {
  ${HELPERS}
  const tabs = [...document.querySelectorAll('#tabbar .tab')].map((node) => node.textContent.trim());
  const products = document.getElementById('productsButton');
  await click(products);
  await wait(300);
  const fromTab = root().innerText.includes('Мои продукты');
  const empty = root().innerText.includes('Список пуст');
  await click(document.querySelector('#sheetRoot .sheet-backdrop'));
  await wait(300);
  await click(document.getElementById('addButton'));
  const entry = Boolean(byText('#sheetRoot .btn', 'Из моих продуктов'));
  await click(byText('#sheetRoot .btn', 'Из моих продуктов'));
  return JSON.stringify({ tabs, fromTab, empty, entry, text: root().innerText });
})()`);
const empty = JSON.parse(emptyState || '{}');
console.log('   ', emptyState);
check(empty.fromTab, 'вкладка «Продукты» не открыла список');
check(empty.empty, 'пустой список не показал приглашение завести первый продукт');
check(empty.entry, 'в окне разговора нет входа в список продуктов');
check((empty.tabs || []).some((label) => label.includes('Продукты')),
  `в нижней панели нет вкладки продуктов: ${JSON.stringify(empty.tabs)}`);
check(!(empty.tabs || []).some((label) => label.includes('Расход')),
  `вкладка расхода осталась в нижней панели: ${JSON.stringify(empty.tabs)}`);

console.log('шаг 1б: расход открывается из настроек');
const usageEntry = await evaluate(`(async () => {
  ${HELPERS}
  document.querySelector('#sheetRoot .sheet-backdrop').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(300);
  location.hash = '#/settings';
  await wait(600);
  const button = byText('button.btn', 'Открыть расход');
  await click(button);
  await wait(700);
  const text = document.getElementById('view').innerText;
  const screen = /Калории|Расход|Прогноз|Баланс/.test(text);
  const hash = location.hash;
  // Возвращаемся к списку продуктов: дальше проверка продолжает работу с ним.
  location.hash = '#/today';
  await wait(600);
  await click(document.getElementById('productsButton'));
  await wait(400);
  return JSON.stringify({ button: Boolean(button), hash, screen, back: root().innerText.includes('Мои продукты') });
})()`);
const usage = JSON.parse(usageEntry || '{}');
console.log('   ', usageEntry);
check(usage.button, 'в настройках нет входа в расход');
check(usage.hash === '#/usage', `вход в расход ведёт не туда: ${usage.hash}`);
check(usage.screen, 'экран расхода не показал ни журнала, ни прогноза');
check(usage.back, 'список продуктов не открылся заново после проверки расхода');

console.log('шаг 2: продукт добавляется вручную');
const added = await evaluate(`(async () => {
  ${HELPERS}
  await click(byText('#sheetRoot .btn-primary', 'Добавить продукт'));
  type(root().querySelector('input[type="text"]'), 'Проверочный творог');
  const fields = [...root().querySelectorAll('input[type="number"]')];
  type(fields[0], '121'); type(fields[1], '17'); type(fields[2], '5'); type(fields[3], '3');
  await click(byText('#sheetRoot .btn-primary', 'Добавить продукт'));
  await wait(250);
  return JSON.stringify({
    names: [...root().querySelectorAll('.product-name')].map((node) => node.textContent),
    line: root().querySelector('.product-values')?.textContent,
  });
})()`);
const product = JSON.parse(added || '{}');
console.log('   ', added);
check(product.names?.includes('Проверочный творог'), 'продукт не появился в списке');
check(/121/.test(product.line || ''), 'в строке продукта не видно калорий на 100 г');

console.log('шаг 3: список переживает перезагрузку');
await send('Page.reload', { ignoreCache: true });
await wait(2200);
const survived = await evaluate(`(async () => {
  ${HELPERS}
  await click(document.getElementById('addButton'));
  await click(byText('#sheetRoot .btn', 'Из моих продуктов'));
  return JSON.stringify({ names: [...root().querySelectorAll('.product-name')].map((node) => node.textContent) });
})()`);
const afterReload = JSON.parse(survived || '{}');
console.log('   ', survived);
check(afterReload.names?.includes('Проверочный творог'), 'продукт не пережил перезагрузку страницы');

console.log('шаг 4: запись продукта в дневник по весу');
const recorded = await evaluate(`(async () => {
  ${HELPERS}
  await click(root().querySelector('.product-main'));
  const grams = root().querySelector('input[type="number"]');
  type(grams, '200');
  await wait(150);
  const preview = root().querySelector('.muted')?.textContent || '';
  await click(byText('#sheetRoot .btn-primary', 'В дневник'));
  await wait(400);
  location.hash = '#/today';
  await wait(400);
  const entry = document.querySelector('.entry');
  return JSON.stringify({
    preview,
    toast: [...document.querySelectorAll('.toast')].pop()?.textContent || '',
    entryName: entry?.querySelector('.entry-name')?.textContent || '',
    entryKcal: entry?.querySelector('.mono')?.textContent || '',
    entrySub: entry?.querySelector('.entry-sub')?.textContent || '',
  });
})()`);
const day = JSON.parse(recorded || '{}');
console.log('   ', recorded);
check(/242/.test(day.preview || ''), 'предпросмотр не показал 242 ккал на 200 г');
check(day.entryName === 'Проверочный творог', 'записи нет в ленте дня');
check(day.entryKcal === '242', 'в ленте дня не 242 ккал');
check(day.entrySub === '200 г', 'в ленте дня не видно веса');

console.log('шаг 5: счётчик использования и порядок списка');
const counter = await evaluate(`(async () => {
  const products = await import('/js/products.js');
  const rows = await products.listProducts();
  const found = rows.find((row) => row.name === 'Проверочный творог');
  await products.saveProduct({ id: found.id, name: found.name, per100: found.per100 });
  const afterEdit = (await products.listProducts()).find((row) => row.name === 'Проверочный творог');
  return JSON.stringify({ uses: found.uses, usesAfterEdit: afterEdit.uses, lastUsedAt: afterEdit.lastUsedAt });
})()`);
const uses = JSON.parse(counter || '{}');
console.log('   ', counter);
check(uses.uses === 1, 'счётчик использования не вырос при записи из списка');
check(uses.usesAfterEdit === 1, 'правка продукта сбросила счётчик использования');
check(uses.lastUsedAt > 0, 'время последнего использования не записалось');

console.log('шаг 6: обращений к модели нет');
// Ищем адрес API, а не слово «deepseek»: оно есть и в имени модуля js/llm/deepseek.js.
const modelCalls = requests.filter((request) => request.includes('api.deepseek.com'));
const external = requests.filter((request) => !request.startsWith(url.split('#')[0])
  && !request.startsWith('data:'));
console.log('    запросов всего:', requests.length, '· к модели:', modelCalls.length,
  '· наружу:', JSON.stringify(external));
check(modelCalls.length === 0, `ушёл запрос к модели: ${modelCalls.join(', ')}`);
check(external.length === 0, `ушли посторонние запросы: ${external.join(', ')}`);

console.log('шаг 7: продукт добавляется к разбору в окне разговора');
const draft = JSON.parse(await evaluate(`(async () => {
  ${HELPERS}
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  const items = [{ name: 'Салат', grams: 100, kcal: 50, protein: 2, fat: 3, carbs: 4 }];
  const analysis = { dish: 'Салат', items, cost: 0.001, source: 'estimate',
    confidence: 'medium', assumptions: '', basis: 'per_portion' };
  const session = await import('/js/chat-session.js');
  session.saveChat({ date, messages: [{ role: 'assistant', analysis }], draft: analysis,
    current: { items, totals: { grams: 100, kcal: 50, protein: 2, fat: 3, carbs: 4 } }, cost: 0.001 });

  await click(document.getElementById('addButton'));
  const before = root().querySelector('.draft-bar')?.innerText.replace(/\\n+/g, ' ') || '';
  await click(byText('#sheetRoot .btn', 'Из моих продуктов'));
  await click(root().querySelector('.product-main'));
  type(root().querySelector('input[type="number"]'), '200');
  await wait(150);
  await click(byText('#sheetRoot button', 'В разбор'));
  await wait(350);

  return JSON.stringify({
    before,
    after: root().querySelector('.draft-bar')?.innerText.replace(/\\n+/g, ' ') || '',
    positions: root().querySelectorAll('.field-compact input[type="text"]').length,
    title: root().querySelector('.sheet-title')?.textContent || '',
    kept: Boolean(session.loadChat({ date })?.draft?.items?.length),
  });
})()`) || '{}');
console.log('   ', JSON.stringify(draft));
check(draft.title === 'Добавить еду', 'после добавления в разбор окно разговора не вернулось');
check(draft.positions === 2, 'в разборе не стало на одну позицию больше');
check(/300 г/.test(draft.after || ''), 'полоса черновика не сложила вес');
check(draft.after !== draft.before, 'разбор не изменился после добавления продукта');
check(draft.kept, 'разговор не сохранился после возврата к разбору');

console.log('шаг 8: вёрстка списка и формы на узких экранах');
for (const width of [320, 360, 390, 430]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 700, deviceScaleFactor: 2, mobile: true });
  await send('Page.reload', { ignoreCache: true });
  await wait(1700);
  const measured = JSON.parse(await evaluate(`(async () => {
    ${HELPERS}
    const edge = () => document.documentElement.clientWidth;
    const over = (nodes) => Math.max(0, ...nodes
      .map((node) => Math.round(node.getBoundingClientRect().right - edge())));
    await click(document.getElementById('addButton'));
    await click(byText('#sheetRoot .btn', 'Из моих продуктов'));
    const rows = root().querySelectorAll('.product-row').length;
    const listOver = over([...root().querySelectorAll('.product-row, .badge, input')]);
    await click(root().querySelector('.product-main'));
    const formOver = over([...root().querySelectorAll('input, .hint-list, button')]);
    return JSON.stringify({
      rows, listOver, formOver, pageOver: document.documentElement.scrollWidth - edge(),
    });
  })()`) || '{}');
  console.log(`    ${width}px:`, JSON.stringify(measured));
  check(measured.rows > 0, `${width}px: список не показал ни одного продукта`);
  check(measured.listOver === 0, `${width}px: список вылез за край на ${measured.listOver}px`);
  check(measured.formOver === 0, `${width}px: форма вылезла за край на ${measured.formOver}px`);
  check(measured.pageOver === 0, `${width}px: страница перелилась на ${measured.pageOver}px`);
}
await send('Emulation.clearDeviceMetricsOverride');

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.data) {
  const file = '/tmp/kbju-products.png';
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('скриншот:', file);
}

if (problems.length) {
  console.log(`ОШИБКИ (${problems.length}):\n${problems.join('\n')}`);
  ws.close();
  process.exit(1);
}
console.log('список продуктов и запись по весу работают');
ws.close();
