// Проверка повтора неудачного запроса в разговорах через отладочный протокол Chrome:
// прикладывает снимок, получает ошибку, нажимает «Повторить» и убеждается, что повторный
// запрос ушёл с тем же снимком и теми же словами.
//
// Запуск (нужен Chrome с отладочным портом и локальный сервер):
//   node tools/cdp-chat-retry.mjs [url]
//
// Ключ берётся из .env.local: без него окно не начнёт разговор. Запрос к провайдеру при этом
// не уходит, потому что fetch подменяется готовым ответом: первые две попытки приходят не по
// схеме, и человек видит ошибку с кнопкой повтора.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2] || 'http://127.0.0.1:8767/#/today';
const debugPort = process.env.CDP_PORT || 9222;
const photoPath = '/tmp/kbju-retry-photo.png';

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
await writeFile(photoPath, Buffer.from(TINY_PNG, 'base64'));

// Ответы для обоих разговоров: они приходят только после двух неудачных попыток.
const foodAnswer = {
  dish: 'Проверочный творог',
  source: 'estimate',
  basis: 'per_portion',
  items: [{ name: 'Проверочный творог', grams: 100, kcal: 121, protein: 17, fat: 5, carbs: 3 }],
  question: null,
  confidence: 'medium',
  assumptions: 'Оценка по снимку.',
};
const normsAnswer = { params: { pace: 0.5 }, comment: 'Темп снижения оставил прежним.', question: null, confidence: 'high' };

const envText = await readFile(join(root, '.env.local'), 'utf8').catch(() => '');
const apiKey = envText.match(/^DEEPSEEK_API_KEY\s*=\s*(.+)$/m)?.[1]?.trim();
if (!apiKey) {
  console.error('в .env.local нет ключа провайдера');
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
    if (!/version\.txt|favicon\.ico/.test(entry.url || entry.text || '')) {
      problems.push(`${entry.text} · ${entry.url || ''}`);
    }
  }
});

function send(method, params = {}) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolvePromise) => pending.set(id, resolvePromise));
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

const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const check = (ok, message) => {
  if (!ok) problems.push(message);
  return ok;
};

async function waitFor(expression, { timeout = 30000, step = 400, label = '' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await evaluate(expression);
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`не дождались: ${label || expression}`);
    await wait(step);
  }
}

/** Прикладывает файл к полю выбора, которое создаёт поле ввода сообщения. */
async function setFile(path) {
  const doc = await send('DOM.getDocument', { depth: -1 });
  const found = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
  if (!found?.nodeId) throw new Error('на странице нет поля выбора файла');
  await send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [path] });
}

const HELPERS = `
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const root = () => document.getElementById('sheetRoot');
  const click = (el) => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return wait(180); };
  const byText = (sel, text) => [...document.querySelectorAll(sel)]
    .find((node) => node.textContent.trim() === text);
  const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
`;

await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await send('Page.enable');
await send('DOM.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
// Служебный работник обходится: на порту мог остаться работник прошлого прогона,
// и тогда проверка судила бы по прежней странице приложения.
await send('Network.setBypassServiceWorker', { bypass: true });
await send('Page.navigate', { url });
await wait(3000);

console.log('шаг 0: чистое хранилище и ключ провайдера');
await evaluate(`(async () => {
  const dbs = await indexedDB.databases?.() || [];
  for (const info of dbs) if (info.name) indexedDB.deleteDatabase(info.name);
  for (const key of await caches.keys()) await caches.delete(key);
  const registrations = await navigator.serviceWorker?.getRegistrations?.() || [];
  for (const registration of registrations) await registration.unregister();
  return 'ok';
})()`);
await send('Page.reload', { ignoreCache: true });
await wait(2500);

await evaluate(`(async () => {
  const state = await import('/js/state.js');
  await state.saveSettings({ provider: { id: 'deepseek', key: ${JSON.stringify(apiKey)}, model: 'deepseek-flash' } });
  return 'ok';
})()`);

console.log('шаг 1: ответ модели подставляется, первые попытки не разбираются');
const stubbed = await evaluate(`(() => {
  const food = ${JSON.stringify(foodAnswer)};
  const norms = ${JSON.stringify(normsAnswer)};
  window.__calls = { chat: 0, norms: 0 };
  window.__prompts = { chat: [], norms: [] };
  const real = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const target = typeof input === 'string' ? input : input.url;
    if (!String(target).includes('api.deepseek.com')) return real(input, init);
    const body = String(init.body || '');
    const kind = body.includes('помогаешь настроить нормы') ? 'norms' : 'chat';
    window.__calls[kind] += 1;
    window.__prompts[kind].push(body);
    // Две первые попытки приходят не по схеме: слой провайдеров повторяет сам, и только
    // после второй неудачи ошибку видит человек, а повтор запускает он.
    const content = window.__calls[kind] <= 2 ? 'извините, не могу' : JSON.stringify(kind === 'norms' ? norms : food);
    return new Response(JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 900, completion_tokens: 40 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return 'ok';
})()`);
check(stubbed === 'ok', 'подмена ответа модели не встала');
requests.length = 0;

console.log('шаг 2: повтор в разговоре о еде');
await evaluate(`(async () => {
  ${HELPERS}
  await click(document.getElementById('addButton'));
  type(root().querySelector('textarea.composer-input'), 'это творог');
  await click(byText('#sheetRoot .btn', '🖼 Из галереи'));
  return 'ok';
})()`);
await wait(300);
await setFile(photoPath);
await wait(700);

const attached = await evaluate(`(() => {
  const preview = document.querySelector('#sheetRoot .attached .msg-photo');
  return JSON.stringify({ attached: Boolean(preview) });
})()`);
console.log('   ', attached);
check(JSON.parse(attached || '{}').attached, 'приложенный снимок не виден в окне разговора');

await evaluate(`(async () => {
  ${HELPERS}
  await click(byText('#sheetRoot .btn-primary', 'Отправить'));
  return 'ok';
})()`);

const failed = await waitFor(`(() => {
  const button = [...document.querySelectorAll('#sheetRoot .btn')]
    .find((node) => node.textContent.trim() === 'Повторить');
  return button ? (document.querySelector('#sheetRoot .msg-assistant')?.innerText || '').replace(/\\n/g, ' · ') : null;
})()`, { label: 'сообщение об ошибке с повтором' });
console.log('    ошибка:', failed);

await evaluate(`(async () => {
  ${HELPERS}
  await click(byText('#sheetRoot .btn', 'Повторить'));
  return 'ok';
})()`);

const parsed = await waitFor(`(() => {
  const bar = document.querySelector('#sheetRoot .draft-bar');
  return bar && !bar.hidden ? bar.innerText.replace(/\\n/g, ' ') : null;
})()`, { label: 'разбор после повтора' });
console.log('    разбор:', parsed);

const chatCalls = await evaluate(`JSON.stringify({
  calls: window.__calls.chat,
  last: (window.__prompts.chat[window.__prompts.chat.length - 1] || ''),
})`);
const chat = JSON.parse(chatCalls || '{}');
const chatImage = (JSON.parse(chat.last || '{}').messages?.[1]?.content || [])
  .find((part) => part.type === 'image_url')?.image_url?.url || '';
console.log('    повторных запросов к модели:', chat.calls, '· снимок в последнем:', chatImage.slice(0, 22));
check(chat.calls === 3, `разговор обратился к модели ${chat.calls} раза вместо трёх`);
check(chatImage.startsWith('data:image/'), 'повтор ушёл без снимка');
check((chatImage.match(/data:/g) || []).length === 1, 'снимок в повторе собран неверно');
check(chat.last.includes('это творог'), 'повтор ушёл без слов человека');

console.log('шаг 3: повтор в разговоре о нормах');
await evaluate(`(async () => {
  ${HELPERS}
  await click(document.querySelector('#sheetRoot .sheet-backdrop'));
  location.hash = '#/settings';
  await wait(700);
  await click(byText('button.btn-primary', 'Обсудить нормы'));
  await wait(400);
  await click(byText('#sheetRoot .btn', '🖼 Из галереи'));
  return 'ok';
})()`);
await wait(300);
await setFile(photoPath);
await wait(700);
await evaluate(`(async () => {
  ${HELPERS}
  await click(byText('#sheetRoot .btn-primary', 'Отправить'));
  return 'ok';
})()`);

await waitFor(`(() => {
  const button = [...document.querySelectorAll('#sheetRoot .btn')]
    .find((node) => node.textContent.trim() === 'Повторить');
  return button ? 'есть' : null;
})()`, { label: 'ошибка разбора отчёта' });
await evaluate(`(async () => {
  ${HELPERS}
  await click(byText('#sheetRoot .btn', 'Повторить'));
  return 'ok';
})()`);
await waitFor(`window.__calls.norms === 3 ? 'готово' : null`, { label: 'повтор разбора отчёта' });

const normsCalls = await evaluate(`JSON.stringify({
  calls: window.__calls.norms,
  last: (window.__prompts.norms[window.__prompts.norms.length - 1] || ''),
})`);
const norms = JSON.parse(normsCalls || '{}');
const normsImage = (JSON.parse(norms.last || '{}').messages?.[1]?.content || [])
  .find((part) => part.type === 'image_url')?.image_url?.url || '';
console.log('    повторных запросов к модели:', norms.calls, '· снимок в последнем:', normsImage.slice(0, 22));
check(norms.calls === 3, `разговор о нормах обратился к модели ${norms.calls} раза вместо трёх`);
check(normsImage.startsWith('data:image/'), 'повтор разбора отчёта ушёл без снимка');

console.log('шаг 4: лишних запросов нет');
const modelCalls = requests.filter((request) => request.includes('api.deepseek.com'));
const external = requests.filter((request) => !request.startsWith(url.split('#')[0])
  && !request.startsWith('data:') && !request.startsWith('blob:'));
console.log('    ушло в сеть:', modelCalls.length, '· наружу:', JSON.stringify(external));
check(modelCalls.length === 0, `ушёл настоящий запрос к модели: ${modelCalls.join(', ')}`);
check(external.length === 0, `ушли посторонние запросы: ${external.join(', ')}`);

console.log('');
if (problems.length) {
  console.error('Проблемы:');
  for (const problem of problems) console.error(' -', problem);
  process.exit(1);
}
console.log('Повтор неудачного запроса: проверка пройдена');
ws.close();
