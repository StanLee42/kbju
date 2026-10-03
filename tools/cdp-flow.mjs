// Сквозная проверка первого этапа через отладочный протокол Chrome:
// открывает приложение, записывает еду с выбранной порцией, проверяет ленту,
// перезагружает страницу и убеждается, что запись осталась в хранилище.
// Запуск: node tools/cdp-flow.mjs [url]
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

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url });
await wait(3000);

// Чистим прошлые прогоны, чтобы проверка была повторяемой.
await evaluate(`(async () => {
  const dbs = await indexedDB.databases?.() || [];
  for (const info of dbs) if (info.name) indexedDB.deleteDatabase(info.name);
  return 'ok';
})()`);
await send('Page.reload');
await wait(2500);

console.log('шаг 1: записываем еду с порцией «мало» (×0,7)');
await evaluate(`document.getElementById('addButton').click(); 'ok'`);
await wait(400);

const filled = await evaluate(`(() => {
  const sheet = document.querySelector('.sheet');
  if (!sheet) return 'нет шторки';
  const name = sheet.querySelector('input[type=text]');
  name.value = 'Проверка: творог с бананом';
  const numbers = sheet.querySelectorAll('input[type=number]');
  // порядок полей: вес, ккал, белки, жиры, углеводы
  const values = [150, 320, 12, 18, 28];
  numbers.forEach((input, index) => { input.value = values[index]; });
  const smallButton = [...sheet.querySelectorAll('.portion-row button')]
    .find((button) => button.textContent.trim() === 'Мало');
  smallButton.click();
  return 'заполнено';
})()`);
console.log('   ', filled);

const preview = await evaluate(`document.querySelector('.sheet .small.muted')?.textContent || ''`);
console.log('   предпросмотр:', preview);

await evaluate(`document.querySelector('.sheet .btn-primary').click(); 'ok'`);
await wait(800);

const afterSave = await evaluate(`JSON.stringify({
  entries: document.querySelectorAll('.entry').length,
  firstEntry: document.querySelector('.entry')?.textContent || '',
  total: document.querySelector('.total-line')?.textContent || '',
  kcalRing: document.querySelector('.ring-wrap .ring-value')?.textContent || '',
  kcalCaption: document.querySelector('.ring-wrap .ring-meta')?.textContent || '',
  overColored: [...document.querySelectorAll('.bar-fill')].map((node) => node.style.background)
})`);
console.log('шаг 2: после сохранения');
console.log('   ', afterSave);

console.log('шаг 3: перезагружаем страницу и проверяем хранилище');
await send('Page.reload');
await wait(2500);

const afterReload = await evaluate(`JSON.stringify({
  entries: document.querySelectorAll('.entry').length,
  firstEntry: document.querySelector('.entry')?.textContent || '',
  kcalRing: document.querySelector('.ring-wrap .ring-value')?.textContent || ''
})`);
console.log('   ', afterReload);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.data) {
  const file = '/tmp/kbju-flow.png';
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('скриншот:', file);
}

console.log(problems.length ? `ОШИБКИ (${problems.length}):\n${problems.join('\n')}` : 'ошибок в консоли нет');
ws.close();
