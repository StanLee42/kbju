// Проверка обновления сборки: смена сборки должна подхватываться сама.
//
// Зачем отдельная проверка. Приложение открыто со старой сборкой, на сервере уже новая.
// Service worker забирает управление сразу, но страница продолжает работать на старых файлах,
// и человек видит старое приложение, хотя версия в настройках показывает новую. Поэтому
// приложение перезагружается само, как только управление перешло к новой сборке.
// Здесь это и проверяется: сборка подменяется на месте, как это делает публикация.
//
// Запуск (нужны собранная папка и сервер из неё):
//   node tools/build-www.mjs
//   cd dist && python3 -m http.server 8765 &
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/kbju-update-check about:blank
//   node tools/cdp-update.mjs
//
// Переменные: CDP_PORT (9222), KBJU_URL (http://127.0.0.1:8765/), KBJU_DIST (./dist).
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const debugPort = process.env.CDP_PORT || 9222;
const baseUrl = process.env.KBJU_URL || 'http://127.0.0.1:8765';
const distDir = resolve(process.env.KBJU_DIST || join(root, 'dist'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
let loadEvents = 0;
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Page.loadEventFired') loadEvents += 1;
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result);
    pending.delete(message.id);
  }
});

function send(method, params = {}) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text || 'ошибка на странице');
  return result?.result?.value;
}

const problems = [];
const swPath = join(distDir, 'sw.js');
const original = await readFile(swPath, 'utf8');
const versionOf = (text) => (text.match(/const VERSION = '([^']+)'/) || [])[1] || 'нет версии';

async function state() {
  return {
    управляет: await evaluate('Boolean(navigator.serviceWorker.controller)'),
    кэши: await evaluate('(async () => (await caches.keys()).join(", "))()'),
    ошибка: await evaluate('Boolean(document.getElementById("view")?.dataset.errorShown)'),
  };
}

try {
  await send('Runtime.enable');
  await send('Page.enable');

  // Чистый старт: без кэшей и без службы, иначе проверяли бы прошлый запуск.
  await send('Page.navigate', { url: `${baseUrl}/` });
  await wait(2000);
  await evaluate(`(async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    for (const registration of await navigator.serviceWorker?.getRegistrations?.() || []) {
      await registration.unregister();
    }
    return 'ok';
  })()`);
  await send('Page.reload', { ignoreCache: true });
  await wait(3000);

  const first = await state();
  console.log(`первая загрузка: служба управляет — ${first.управляет}, кэши: ${first.кэши}`);
  if (!first.управляет) problems.push('service worker не взял управление — обновление проверять нечем');
  const firstVersion = versionOf(original);
  const firstCache = String(first.кэши).split(', ').find((name) => name.startsWith('kbju-')) || '';
  if (firstCache !== firstVersion) {
    problems.push(`страница работает не на той сборке, что в sw.js: кэш ${firstCache}, версия ${firstVersion}`);
  }

  // Подменяем сборку на месте: так же меняется sw.js при публикации (имя кэша — отпечаток).
  const nextVersion = 'kbju-update-check';
  await writeFile(swPath, original.replace(/const VERSION = '[^']*'/, `const VERSION = '${nextVersion}'`), 'utf8');
  console.log(`подменили сборку: ${firstVersion} → ${nextVersion}`);

  loadEvents = 0;
  await send('Page.reload', { ignoreCache: false });
  // Ждём: загрузка страницы, установка новой сборки, передача управления, самостоятельная перезагрузка.
  await wait(9000);

  const after = await state();
  console.log(`после подмены: загрузок страницы — ${loadEvents}, служба управляет — ${after.управляет}`);
  console.log(`кэши: ${after.кэши}`);

  if (loadEvents < 2) {
    problems.push(`приложение не перезагрузилось само: загрузок ${loadEvents}, ожидалось две`);
  }
  if (!String(after.кэши).includes(nextVersion)) {
    problems.push(`новая сборка не встала в кэш: ${after.кэши}`);
  }
  if (after.ошибка) problems.push('после обновления на экране ошибка');
} finally {
  // Возвращаем сборку на место: это рабочий каталог, а не игрушка.
  await writeFile(swPath, original, 'utf8');
  console.log('сборка возвращена на место');
}

console.log(problems.length
  ? `\nНАЙДЕНО ПРОБЛЕМ (${problems.length}):\n${problems.join('\n')}`
  : '\nсмена сборки подхватывается сама');
ws.close();
