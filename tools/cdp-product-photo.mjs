// Сквозная проверка разбора снимка упаковки через отладочный протокол Chrome: открывает
// список продуктов, присылает снимок, разбирает подставленный ответ модели, правит число,
// сохраняет продукт и убеждается, что продукт попал в список, дневник остался пустым,
// а снимок нигде не сохранился.
//
// Запуск (нужен Chrome с отладочным портом и локальный сервер):
//   node tools/cdp-product-photo.mjs [url]
//
// Ключ берётся из .env.local: без него окно разбора не начнёт разговор. Запрос к провайдеру
// при этом не уходит, потому что fetch подменяется готовым ответом. Прогон не тратит деньги
// и не зависит от сети; снимок настоящей упаковки владелец проверяет сам.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2] || 'http://127.0.0.1:8767/#/today';
const debugPort = process.env.CDP_PORT || 9222;
const photoPath = '/tmp/kbju-package-photo.png';

// Снимок для проверки: разбор идёт по числам из подставленного ответа, поэтому хватает
// любой картинки. Файл пишем сами, чтобы проверка не зависела от чужих каталогов.
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
await writeFile(photoPath, Buffer.from(TINY_PNG, 'base64'));

// Ответ модели: таблица на упаковке напечатана на порцию 30 г. На 100 г из неё выходит
// 200 ккал, 30 г белка, 8,3 г жира и 6,7 г углеводов: эту арифметику проверяет первый шаг.
const modelAnswer = {
  name: 'Проверочный творог',
  source: 'label',
  basisGrams: 30,
  kcal: 60,
  protein: 9,
  fat: 2.5,
  carbs: 2,
  packageWeight: 300,
  confidence: 'high',
  assumptions: 'Значения взяты с таблицы на порцию.',
};

// Ответ второго разбора: таблицы на снимке нет, поэтому значения идут оценкой, а название
// то же самое. Проверка убеждается, что продукт обновился, а второй строки не появилось.
const estimateAnswer = {
  name: modelAnswer.name,
  source: 'estimate',
  basisGrams: 100,
  kcal: 203,
  protein: 31,
  fat: 8,
  carbs: 7,
  confidence: 'low',
  assumptions: 'Оценка по виду продукта.',
};

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

/** Помощники живут в странице, поэтому описаны один раз. */
const HELPERS = `
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const root = () => document.getElementById('sheetRoot');
  const click = (el) => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return wait(150); };
  const byText = (sel, text) => [...document.querySelectorAll(sel)]
    .find((node) => node.textContent.trim() === text);
`;

await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await send('Page.enable');
await send('DOM.enable');
// Кэш выключен: иначе браузер и служебный работник отдают прежнюю версию модуля,
// и проверка судит по старому коду.
await send('Network.setCacheDisabled', { cacheDisabled: true });
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

console.log('шаг 1: ответ модели подставляется, запрос наружу не уходит');
// Подмена ставится заново после каждой перезагрузки: перезагрузка стирает window.fetch.
const INSTALL_STUB = `(() => {
  const answer = ${JSON.stringify(modelAnswer)};
  const estimate = ${JSON.stringify(estimateAnswer)};
  window.__modelCalls = 0;
  window.__prompts = [];
  const real = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const target = typeof input === 'string' ? input : input.url;
    if (!String(target).includes('api.deepseek.com')) return real(input, init);
    window.__modelCalls += 1;
    window.__prompts.push(String(init.body || ''));
    // Первый ответ приходит не по схеме дважды: слой провайдеров повторяет запрос сам,
    // и только после второй неудачи ошибку видит человек, а повтор запускает он.
    const content = window.__modelCalls <= 2
      ? 'извините, не могу'
      : JSON.stringify(window.__modelCalls === 3 ? answer : estimate);
    return new Response(JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1200, completion_tokens: 60 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  window.__callsBefore = 0;
  return 'ok';
})()`;
const stubbed = await evaluate(INSTALL_STUB);
check(stubbed === 'ok', 'подмена ответа модели не встала');
requests.length = 0;

// После перезагрузки остаётся один разбор, и ответ приходит оценкой с тем же названием.
// Счётчик страницы начинается заново, поэтому подмена здесь вторая, простая.
const INSTALL_STUB_SECOND = `(() => {
  const estimate = ${JSON.stringify(estimateAnswer)};
  window.__modelCalls = 0;
  window.__prompts = [];
  const real = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const target = typeof input === 'string' ? input : input.url;
    if (!String(target).includes('api.deepseek.com')) return real(input, init);
    window.__modelCalls += 1;
    window.__prompts.push(String(init.body || ''));
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(estimate) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1200, completion_tokens: 60 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return 'ok';
})()`;

console.log('шаг 2: вход в разбор из списка продуктов');
const entry = await evaluate(`(async () => {
  ${HELPERS}
  await click(document.getElementById('addButton'));
  await click(byText('#sheetRoot .btn', 'Из моих продуктов'));
  const button = byText('#sheetRoot .btn', 'Снимок упаковки');
  const titles = root().innerText.includes('Мои продукты');
  await click(button);
  await wait(200);
  return JSON.stringify({ listOpened: titles, hasEntry: Boolean(button), title: root().querySelector('.sheet-title')?.textContent || '' });
})()`);
const entryState = JSON.parse(entry || '{}');
console.log('   ', entry);
check(entryState.listOpened, 'список продуктов не открылся из окна добавления');
check(entryState.hasEntry, 'в списке продуктов нет входа в разбор снимка упаковки');
check(entryState.title === 'Продукт со снимка', 'окно разбора не открылось');

console.log('шаг 3: снимок упаковки уходит на разбор');
await evaluate(`(async () => {
  ${HELPERS}
  await click(byText('#sheetRoot .btn', '🖼 Из галереи'));
  return 'ok';
})()`);
await wait(300);
await setFile(photoPath);
await wait(700);
const attached = await evaluate(`(() => {
  const preview = document.querySelector('#sheetRoot .attached .msg-photo');
  return JSON.stringify({ attached: Boolean(preview), src: (preview?.src || '').slice(0, 24) });
})()`);
console.log('   ', attached);
check(JSON.parse(attached || '{}').attached, 'приложенный снимок не виден в окне разбора');

await evaluate(`(async () => {
  ${HELPERS}
  await click(byText('#sheetRoot .btn-primary', 'Отправить'));
  return 'ok';
})()`);

console.log('шаг 4: неудачный разбор повторяется тем же снимком');
// Слой провайдеров повторяет запрос один раз сам, поэтому ошибку человек видит
// после второй неудачи, а третье обращение идёт уже по кнопке «Повторить».
const failed = await waitFor(`(() => {
  const button = [...document.querySelectorAll('#sheetRoot .btn')]
    .find((node) => node.textContent.trim() === 'Повторить');
  return button ? (document.querySelector('#sheetRoot .msg-assistant')?.innerText || '').replace(/\\n/g, ' · ') : null;
})()`, { label: 'сообщение об ошибке с повтором' });
console.log('    ', failed);
check(/не по схеме|разобрался|не удалось/i.test(failed), 'неудачный ответ показан без понятной ошибки');

await evaluate(`(async () => {
  ${HELPERS}
  await click(byText('#sheetRoot .btn', 'Повторить'));
  return 'ok';
})()`);

const card = await waitFor(`(() => {
  const name = document.querySelector('#sheetRoot .draft-name')?.textContent?.trim();
  return name ? name : null;
})()`, { label: 'карточка продукта из разбора' });
console.log('    продукт на полосе:', card);

console.log('шаг 5: значения приведены к 100 г, числа правятся');
const parsed = await evaluate(`(() => {
  const inputs = [...document.querySelectorAll('#sheetRoot input')];
  return JSON.stringify({
    name: inputs.find((input) => input.type === 'text')?.value || '',
    values: inputs.filter((input) => input.type === 'number').map((input) => input.value),
    bar: document.querySelector('#sheetRoot .draft-bar')?.innerText?.replace(/\\n/g, ' ') || '',
    questions: [...document.querySelectorAll('#sheetRoot .msg-question')].length,
    warnings: [...document.querySelectorAll('#sheetRoot .msg-assistant p')].map((node) => node.textContent),
  });
})()`);
const values = JSON.parse(parsed || '{}');
console.log('   ', parsed);
check(values.name === modelAnswer.name, 'название продукта не попало в карточку');
check((values.values || []).join(',') === '200,30,8.3,6.7',
  `значения не приведены к 100 г: ${JSON.stringify(values.values)}`);
check(/на 100 г/.test(values.bar || ''), 'строка продукта не говорит, что числа на 100 г');
check(values.questions === 0, 'модель задала вопрос там, где числа уже прочитаны');

const edited = await evaluate(`(() => {
  const input = [...document.querySelectorAll('#sheetRoot input')].find((node) => node.type === 'number');
  input.value = '201';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return document.querySelector('#sheetRoot .draft-bar')?.innerText?.replace(/\\n/g, ' ') || '';
})()`);
console.log('    после правки числа:', edited);
check(/201/.test(edited), 'правка числа в карточке не отразилась на полосе продукта');

console.log('шаг 6: перезагрузка страницы посреди разбора');
// Счётчики снимаем до перезагрузки: она стирает и подмену ответа, и счётчики страницы.
const before = JSON.parse(await evaluate(
  'JSON.stringify({ calls: window.__modelCalls, prompts: window.__prompts })',
) || '{}');
check(before.calls === 3, `до перезагрузки ушло ${before.calls} обращения вместо трёх`);

await send('Page.reload', { ignoreCache: false });
await wait(2500);
// Подмена ставится заново: после перезагрузки window.fetch снова настоящий.
await evaluate(INSTALL_STUB_SECOND);
const reopened = await evaluate(`(async () => {
  ${HELPERS}
  await click(document.getElementById('addButton'));
  await click(byText('#sheetRoot .btn', 'Из моих продуктов'));
  await click(byText('#sheetRoot .btn', 'Снимок упаковки'));
  await wait(400);
  const inputs = [...document.querySelectorAll('#sheetRoot input')];
  return JSON.stringify({
    messages: document.querySelectorAll('#sheetRoot .msg').length,
    name: inputs.find((input) => input.type === 'text')?.value || '',
    kcal: inputs.filter((input) => input.type === 'number')[0]?.value || '',
    bar: document.querySelector('#sheetRoot .draft-bar')?.innerText?.replace(/\\n/g, ' ') || '',
  });
})()`);
const restored = JSON.parse(reopened || '{}');
console.log('   ', reopened);
check(restored.messages >= 2, 'после перезагрузки разбор не вернулся: переписки нет');
check(restored.name === modelAnswer.name, 'после перезагрузки пропало название продукта');
check(restored.kcal === '201', `после перезагрузки пропало поправленное число: ${restored.kcal}`);
check(/разбор 0\.00025 \$/.test(restored.bar || ''), 'после перезагрузки пропала стоимость разбора');

console.log('шаг 7: карточка продукта на узких экранах');
for (const width of [320, 360, 390, 430]) {
  // Окно разбора уже открыто заново: перезагружать страницу здесь нельзя, иначе окно
  // пришлось бы открывать ещё раз.
  await send('Emulation.setDeviceMetricsOverride', { width, height: 700, deviceScaleFactor: 2, mobile: true });
  await wait(400);
  const measured = JSON.parse(await evaluate(`(() => {
    const edge = () => document.documentElement.clientWidth;
    const over = (nodes) => Math.max(0, ...nodes
      .map((node) => Math.round(node.getBoundingClientRect().right - edge())));
    const sheet = document.querySelector('#sheetRoot .sheet');
    return JSON.stringify({
      fields: document.querySelectorAll('#sheetRoot .grid-4 input').length,
      cardOver: over([...document.querySelectorAll('#sheetRoot input, #sheetRoot .grid-4, #sheetRoot button')]),
      sheetOver: Math.max(0, sheet.scrollWidth - sheet.clientWidth),
      pageOver: document.documentElement.scrollWidth - edge(),
    });
  })()`) || '{}');
  console.log(`    ${width}px:`, JSON.stringify(measured));
  check(measured.fields === 4, `${width}px: в карточке продукта не четыре поля значений`);
  check(measured.cardOver === 0, `${width}px: поля карточки продукта вылезли за край на ${measured.cardOver}px`);
  check(measured.sheetOver === 0, `${width}px: шторка разбора перелилась на ${measured.sheetOver}px`);
  check(measured.pageOver === 0, `${width}px: страница перелилась на ${measured.pageOver}px`);
}
await send('Emulation.clearDeviceMetricsOverride');
await wait(300);

console.log('шаг 8: сохранение уходит в список, а не в дневник');
await evaluate(`(async () => {
  ${HELPERS}
  await click(byText('#sheetRoot .btn-primary', 'В мои продукты'));
  return 'ok';
})()`);
// Список показывается заново уже с новым продуктом: чтение хранилища и отрисовка
// занимают несколько мгновений, поэтому ждём появления строки, а не срока.
const listShown = await waitFor(`(() => {
  const names = [...document.querySelectorAll('#sheetRoot .product-name')].map((node) => node.textContent);
  return names.includes(${JSON.stringify(modelAnswer.name)}) ? JSON.stringify(names) : null;
})()`, { timeout: 15000, label: 'список продуктов с сохранённым продуктом' }).catch(() => null);
const list = await evaluate(`(() => JSON.stringify({
  names: [...document.querySelectorAll('#sheetRoot .product-name')].map((node) => node.textContent),
  line: document.querySelector('#sheetRoot .product-values')?.textContent || '',
  toasts: [...document.querySelectorAll('.toast')].map((node) => node.textContent),
  sheet: document.getElementById('sheetRoot')?.innerText?.replace(/\\n/g, ' · ') || '',
}))()`);
const saved = JSON.parse(list || '{}');
console.log('    строки списка:', listShown);
console.log('   ', list);
check(saved.names?.includes(modelAnswer.name), 'продукт не появился в списке после сохранения');
check(/201/.test(saved.line || ''), 'в списке не видно поправленного числа');
check(saved.toasts?.some((text) => /в моих продуктах/.test(text)), 'человеку не сказали, что продукт сохранён');

const stored = await evaluate(`(async () => {
  const products = await import('/js/products.js');
  const db = await import('/js/db.js');
  const rows = await products.listProducts();
  const found = rows.find((row) => row.name === ${JSON.stringify(modelAnswer.name)});
  const entries = await db.all('entries');
  const thumbs = await db.all('thumbs');
  const usage = await db.all('usage');
  return JSON.stringify({
    product: found ? { per100: found.per100, fields: Object.keys(found).sort() } : null,
    entries: entries.length,
    thumbs: thumbs.length,
    usageKinds: usage.map((row) => row.kind),
  });
})()`);
const kept = JSON.parse(stored || '{}');
console.log('   ', stored);
check(kept.product?.per100?.kcal === 201, 'в продукте не поправленное число на 100 г');
check(kept.product?.per100?.protein === 30, 'белок не приведён к 100 г');
check(kept.entries === 0, `разбор упаковки записал что-то в дневник: записей ${kept.entries}`);
check(kept.thumbs === 0, 'снимок упаковки сохранён в хранилище');
check((kept.usageKinds || []).includes('photo'), `разбор не попал в журнал как анализ фото: ${JSON.stringify(kept.usageKinds)}`);

console.log('шаг 9: второй разбор без таблицы и с тем же названием');
// Второй ответ приходит оценкой и с тем же названием: проверяем и подпись «это оценка»,
// и то, что продукт с таким названием обновляется, а не заводится второй раз.
await evaluate(`(async () => {
  ${HELPERS}
  await click(byText('#sheetRoot .btn', 'Снимок упаковки'));
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

const note = await waitFor(`(() => {
  const text = document.querySelector('#sheetRoot .msg-assistant')?.innerText || '';
  return /оценка по снимку/.test(text) ? text.replace(/\\n/g, ' · ') : null;
})()`, { label: 'подпись о том, что числа не из таблицы' });
console.log('    ', note);

await evaluate(`(async () => {
  ${HELPERS}
  await click(byText('#sheetRoot .btn-primary', 'В мои продукты'));
  return 'ok';
})()`);

const afterSecond = await waitFor(`(() => {
  const names = [...document.querySelectorAll('#sheetRoot .product-name')].map((node) => node.textContent);
  return names.length ? JSON.stringify({
    names, line: document.querySelector('#sheetRoot .product-values')?.textContent || '',
  }) : null;
})()`, { timeout: 15000, label: 'список после второго разбора' }).catch(() => null);
console.log('    ', afterSecond);

const counted = await evaluate(`(async () => {
  const products = await import('/js/products.js');
  const db = await import('/js/db.js');
  const rows = await products.listProducts();
  const entries = await db.all('entries');
  return JSON.stringify({
    count: rows.length,
    names: rows.map((row) => row.name),
    per100: rows[0]?.per100 || null,
    entries: entries.length,
  });
})()`);
const second = JSON.parse(counted || '{}');
console.log('   ', counted);
check(second.count === 1, `продуктов в списке ${second.count}, а с тем же названием должен остаться один`);
check(second.per100?.kcal === 203, 'значения существующего продукта не обновились');
check(second.entries === 0, 'второй разбор записал что-то в дневник');
check(JSON.parse(afterSecond || '{}').line?.includes('203'),
  'в списке не видно новых значений продукта');

console.log('шаг 10: закрытие окна заканчивает разбор, а перезагрузка его сохраняет');
// Счётчики снимаем до последней перезагрузки: она обнуляет их вместе со страницей.
const final = JSON.parse(await evaluate(
  'JSON.stringify({ calls: window.__modelCalls, prompts: window.__prompts })',
) || '{}');

const afterSave = await evaluate(`(async () => {
  ${HELPERS}
  await click(byText('#sheetRoot .btn', 'Снимок упаковки'));
  await wait(400);
  const inputs = [...document.querySelectorAll('#sheetRoot input')];
  const area = root().querySelector('textarea.composer-input');
  return JSON.stringify({
    messages: document.querySelectorAll('#sheetRoot .msg').length,
    bar: document.querySelector('#sheetRoot .draft-bar')?.innerText?.replace(/\\n/g, ' ') || '',
    name: inputs.find((input) => input.type === 'text')?.value || '',
    typed: area ? area.value : null,
  });
})()`);
const cleared = JSON.parse(afterSave || '{}');
console.log('   ', afterSave);
check(cleared.messages === 0, 'после сохранения продукта прежний разбор вернулся в окно');
check(cleared.name === '' && cleared.bar === '', 'после сохранения осталась карточка прежнего продукта');

// Набранные слова переживают перезагрузку страницы.
await evaluate(`(async () => {
  ${HELPERS}
  const area = root().querySelector('textarea.composer-input');
  area.value = 'творог пять процентов';
  area.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`);
await send('Page.reload', { ignoreCache: false });
await wait(2500);
const typedBack = await evaluate(`(async () => {
  ${HELPERS}
  await click(document.getElementById('addButton'));
  await click(byText('#sheetRoot .btn', 'Из моих продуктов'));
  await click(byText('#sheetRoot .btn', 'Снимок упаковки'));
  await wait(400);
  const area = root().querySelector('textarea.composer-input');
  return JSON.stringify({ typed: area ? area.value : null });
})()`);
const typed = JSON.parse(typedBack || '{}');
console.log('   ', typedBack);
check(typed.typed === 'творог пять процентов',
  `набранные слова не пережили перезагрузку: ${JSON.stringify(typed.typed)}`);

// Закрытие окна заканчивает разбор: следующий вход начинается с пустого окна.
const closed = await evaluate(`(async () => {
  ${HELPERS}
  await click(document.querySelector('#sheetRoot .sheet-backdrop'));
  await wait(400);
  await click(document.getElementById('addButton'));
  await click(byText('#sheetRoot .btn', 'Из моих продуктов'));
  await click(byText('#sheetRoot .btn', 'Снимок упаковки'));
  await wait(400);
  const area = root().querySelector('textarea.composer-input');
  return JSON.stringify({
    typed: area ? area.value : null,
    messages: document.querySelectorAll('#sheetRoot .msg').length,
  });
})()`);
const fresh = JSON.parse(closed || '{}');
console.log('   ', closed);
check(!fresh.typed, 'закрытое окно вернуло набранные слова');
check(fresh.messages === 0, 'закрытое окно вернуло прежнюю переписку');

console.log('шаг 11: лишних запросов нет');
const calls = (before.calls || 0) + (final.calls || 0);
const bodies = [...(before.prompts || []), ...(final.prompts || [])];
const prompts = JSON.stringify(bodies);
const modelCalls = requests.filter((request) => request.includes('api.deepseek.com'));
// Снимок уходит в каждом запросе, включая повтор по кнопке: адрес данных должен быть
// один, а не вложенный сам в себя.
const images = bodies.map((raw) => {
  const image = (JSON.parse(raw).messages?.[1]?.content || [])
    .find((part) => part.type === 'image_url')?.image_url?.url || '';
  return { hasImage: image.startsWith('data:image/'), markers: (image.match(/data:/g) || []).length };
});
console.log('    снимок в запросах:', JSON.stringify(images));
// Снимок в окне показывается адресом данных или ссылкой на blob, это не запрос наружу.
const external = requests.filter((request) => !request.startsWith(url.split('#')[0])
  && !request.startsWith('data:') && !request.startsWith('blob:'));
console.log('    обращений к модели из страницы:', calls, '· ушло в сеть:',
  modelCalls.length, '· наружу:', JSON.stringify(external));
check(calls === 4, `разбор обратился к модели ${calls} раза вместо четырёх: две неудачные попытки, повтор по кнопке и второй разбор`);
check(images.every((item) => item.hasImage && item.markers === 1),
  `снимок ушёл не в каждом запросе или собран неверно: ${JSON.stringify(images)}`);
check(/Заполни карточку продукта|Новое сообщение человека/.test(prompts || ''),
  'промпт разбора продукта не попал в запрос');
check(modelCalls.length === 0, `ушёл настоящий запрос к модели: ${modelCalls.join(', ')}`);
check(external.length === 0, `ушли посторонние запросы: ${external.join(', ')}`);

console.log('');
if (problems.length) {
  console.error('Проблемы:');
  for (const problem of problems) console.error(' -', problem);
  process.exit(1);
}
console.log('Разбор снимка упаковки в продукт: проверка пройдена');
ws.close();
