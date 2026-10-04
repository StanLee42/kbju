// Сквозная проверка второго этапа в браузере: ключ, разбор отчёта, применение норм,
// журнал расхода и экран дня.
//
// Запуск:
//   1) python3 -m http.server 8765   (в корне репозитория)
//   2) node tools/cdp-e2e.mjs
//
// Ключ берётся из .env.local и подставляется в настройки приложения. Ключ попадает
// только в профиль временного браузера, который удаляется после прогона.
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2] || 'http://127.0.0.1:8765/#/settings';
const debugPort = process.env.CDP_PORT || 9222;
// Полная страница отчёта: приложение само срежет шапку с именем, поэтому
// подавать уже обрезанный снимок нельзя — обрежется дважды.
const reportPath = process.argv[3] || '/tmp/report-page1.png';

const envText = await readFile(join(root, '.env.local'), 'utf8');
const apiKey = envText.match(/^DEEPSEEK_API_KEY\s*=\s*(.+)$/m)?.[1]?.trim();
if (!apiKey) {
  console.error('в .env.local нет ключа');
  process.exit(1);
}

const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const page = targets.find((target) => target.type === 'page');
if (!page) {
  console.error('нет открытой вкладки: запустите Chrome с --remote-debugging-port');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, fail) => {
  ws.addEventListener('open', ok);
  ws.addEventListener('error', fail);
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
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    problems.push(message.params.entry.text);
  }
});

function send(method, params = {}) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolvePromise) => pending.set(id, resolvePromise));
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result?.exceptionDetails) {
    problems.push(result.exceptionDetails.exception?.description || 'ошибка вычисления');
  }
  return result?.result?.value;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(expression, { timeout = 60000, step = 700, label = '' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await evaluate(expression);
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`не дождались: ${label || expression}`);
    await wait(step);
  }
}

async function setFile(path) {
  const doc = await send('DOM.getDocument', { depth: -1 });
  const found = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
  if (!found?.nodeId) throw new Error('на странице нет поля выбора файла');
  await send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [path] });
}

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('DOM.enable');

console.log('1. Открываем настройки и начинаем с чистого листа');
await send('Page.navigate', { url });
await wait(2000);
// Чистим и данные, и кэш: service worker иначе отдаст старые файлы приложения,
// и проверка будет идти против прошлой версии кода.
await evaluate(`(async () => {
  const dbs = await indexedDB.databases?.() || [];
  for (const info of dbs) if (info.name) indexedDB.deleteDatabase(info.name);
  for (const key of await caches.keys()) await caches.delete(key);
  const registrations = await navigator.serviceWorker?.getRegistrations?.() || [];
  for (const registration of registrations) await registration.unregister();
  return 'ok';
})()`);
await send('Page.reload');
await wait(2500);
console.log('   открыто:', await evaluate('location.hash'));

console.log('2. Вставляем ключ и проверяем его');
await evaluate(`(() => {
  const input = [...document.querySelectorAll('input[type=password]')][0];
  input.value = ${JSON.stringify(apiKey)};
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`);
await wait(600);

await evaluate(`[...document.querySelectorAll('button')]
  .find((b) => b.textContent.includes('Проверить ключ')).click(); 'ok'`);
const keyResult = await waitFor(
  `(() => {
    const node = [...document.querySelectorAll('p')]
      .find((p) => /Ключ работает|Ключ принят|не принял ключ|Закончились средства|Нет связи/.test(p.textContent));
    return node ? node.textContent : null;
  })()`,
  { label: 'ответ проверки ключа' },
);
console.log('   ', keyResult);

console.log('3. Разбираем отчёт биоимпеданса (сначала обрезаем шапку с именем)');
await evaluate(`[...document.querySelectorAll('button')]
  .find((b) => b.textContent.includes('Выбрать отчёт')).click(); 'ok'`);
await wait(800);
await setFile(reportPath);

const cropShown = await waitFor(
  `(() => {
    const slider = document.querySelector('input[type=range]');
    return slider ? slider.value : null;
  })()`,
  { label: 'ползунок обрезки' },
);
console.log('    обрезка по умолчанию, %:', cropShown);

await evaluate(`[...document.querySelectorAll('button')]
  .find((b) => b.textContent.includes('Отправить отчёт')).click(); 'ok'`);

const norms = await waitFor(
  `(() => {
    const text = document.body.textContent;
    return /Посчитанные нормы/.test(text) && /Обычный день/.test(text) ? text : null;
  })()`,
  { timeout: 90000, label: 'карточка с нормами' },
);

const parsed = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.row-between')].map((r) => r.textContent);
  return JSON.stringify({
    measured: rows.filter((r) => /Тощая масса|Основной обмен|Вес/.test(r)),
    norms: rows.filter((r) => /Обычный день|Тренировка/.test(r)),
    steps: document.querySelector('details') ? 'раскрываемый расчёт есть' : 'нет',
  });
})()`);
console.log('   ', parsed);

console.log('4. Применяем нормы к типам дней');
await evaluate(`[...document.querySelectorAll('button')]
  .find((b) => b.textContent.includes('Применить к типам дней')).click(); 'ok'`);
await wait(1200);
const dayTypes = await evaluate(`JSON.stringify(
  [...document.querySelectorAll('input[type=number]')]
    .slice(0, 8)
    .map((i) => i.value)
)`);
console.log('    значения в типах дней:', dayTypes);

console.log('5. Смотрим расход');
await send('Page.navigate', { url: url.replace('#/settings', '#/usage') });
await wait(2500);
const usage = await evaluate(`(() => {
  const text = document.body.textContent;
  const total = [...document.querySelectorAll('div')]
    .find((d) => /^\\$[\\d.]+$/.test(d.textContent.trim()));
  return JSON.stringify({
    итого: total ? total.textContent.trim() : 'нет',
    естьПровайдер: /На что ушло/.test(text),
    естьКалькулятор: /Сколько будет стоить/.test(text),
  });
})()`);
console.log('   ', usage);

console.log('6. Смотрим экран дня');
await send('Page.navigate', { url: url.replace('#/settings', '#/today') });
await wait(2500);
const today = await evaluate(`JSON.stringify({
  колец: document.querySelectorAll('.ring-wrap').length,
  кнопкаФото: !!document.querySelector('button') && document.body.textContent.includes('Фото'),
  ошибка: !!document.getElementById('view')?.dataset.errorShown,
})`);
console.log('   ', today);

console.log(problems.length ? `\nОШИБКИ (${problems.length}):\n${problems.join('\n')}` : '\nошибок в консоли нет');
ws.close();
