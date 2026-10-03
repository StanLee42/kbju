// Смоук-тест страницы через отладочный протокол Chrome: открывает приложение,
// собирает ошибки консоли и печатает содержимое основного блока.
// Запуск: node tools/cdp-check.mjs [url]
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

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result);
    pending.delete(message.id);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    console.log('ИСКЛЮЧЕНИЕ:', details.exception?.description || details.text);
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    const text = message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ');
    console.log('КОНСОЛЬ:', message.params.type, text);
  }
  if (message.method === 'Log.entryAdded') {
    console.log('ЛОГ:', message.params.entry.level, message.params.entry.text);
  }
});

function send(method, params = {}) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url });

await new Promise((resolve) => setTimeout(resolve, 5000));

const result = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    view: document.getElementById('view') ? document.getElementById('view').innerHTML.slice(0, 700) : 'нет #view',
    rings: document.querySelectorAll('.ring-wrap').length,
    entries: document.querySelectorAll('.entry').length,
    tabs: document.querySelectorAll('.tab[aria-current]').length,
    errorShown: !!document.getElementById('view')?.dataset.errorShown
  })`,
  returnByValue: true,
});

console.log('СОСТОЯНИЕ:', result?.result?.value || '(пусто)');
ws.close();
