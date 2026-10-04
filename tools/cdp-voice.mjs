// Сквозная проверка голосового ввода: нажать «Голос», записать, получить расшифровку.
//
// Микрофон настоящий не нужен: Chrome умеет подставить файл вместо звука с микрофона,
// и тогда весь путь — запись, подготовка звука, распознавание на устройстве — проходит
// по-настоящему. Звук для подстановки лежит в spike/voice/fake-mic.wav (фраза плюс тишина).
//
// Запуск (сначала сборка и сервер, затем Chrome с подставным микрофоном):
//   node tools/build-www.mjs
//   cd dist && python3 -m http.server 8765 &
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/kbju-probe-chrome \
//     --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
//     --use-file-for-fake-audio-capture="$PWD/spike/voice/fake-mic.wav" about:blank
//   node tools/cdp-voice.mjs
//
// Переменные: CDP_PORT (по умолчанию 9222), KBJU_URL (по умолчанию http://127.0.0.1:8765/),
// KBJU_EXPECT — ожидаемая фраза для сравнения слов, KBJU_OFFLINE=1 — повторить прогон без сети.
//
// Звук для подставного микрофона собирается из spike/voice/s2.wav: фраза плюс тишина,
// чтобы при записи не начинался повтор файла по кругу.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function ensureFakeMic() {
  const path = join(root, 'spike', 'voice', 'fake-mic.wav');
  try {
    await readFile(path);
    return path;
  } catch {
    // Собираем: берём фразу и дописываем тишину вручную, без сторонних библиотек.
    const phrase = await readFile(join(root, 'spike', 'voice', 's2.wav'));
    const silence = Buffer.alloc(16000 * 2 * 2.5);
    const head = Buffer.from(phrase.subarray(0, 44));
    const data = Buffer.concat([phrase.subarray(44), silence]);
    head.writeUInt32LE(36 + data.length, 4);
    head.writeUInt32LE(data.length, 40);
    await writeFile(path, Buffer.concat([head, data]));
    console.log(`собран звук для подставного микрофона: ${path}`);
    return path;
  }
}

await ensureFakeMic();

const debugPort = process.env.CDP_PORT || 9222;
const baseUrl = process.env.KBJU_URL || 'http://127.0.0.1:8765';
const expected = process.env.KBJU_EXPECT || 'съел двести граммов куриной грудки и порцию гречки';
const offlineRun = process.env.KBJU_OFFLINE === '1';
const recordSeconds = Number(process.env.KBJU_RECORD_SECONDS || 3.4);
const timeoutMs = Number(process.env.KBJU_TIMEOUT_SECONDS || 300) * 1000;

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
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
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

/** Настоящее касание по координатам элемента, а не вызов click(). */
async function tapText(text) {
  // Ищем внутри шторки, если она открыта: в нижнем меню есть своя кнопка «Записать»,
  // и без этого поиск попадал бы в неё.
  const point = await evaluate(`(() => {
    const root = document.querySelector('.sheet') || document;
    const node = [...root.querySelectorAll('button, .tab, a')]
      .find((item) => item.textContent.includes(${JSON.stringify(text)}));
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return JSON.stringify({ x: Math.round((rect.left + rect.right) / 2), y: Math.round((rect.top + rect.bottom) / 2) });
  })()`);
  if (!point) return false;
  const { x, y } = JSON.parse(point);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  }
  return true;
}

const problems = [];
const state = () => evaluate(`JSON.stringify({
  hash: location.hash,
  sheet: Boolean(document.querySelector('.sheet')),
  заголовок: document.querySelector('.sheet-title')?.textContent || '',
  текст: document.querySelector('.sheet')?.innerText?.slice(0, 700) || '',
  расшифровка: document.querySelector('textarea.transcript')?.value ?? null,
  ошибка: Boolean(document.querySelector('#view')?.dataset.errorShown),
  версия: document.querySelector('#view')?.innerText?.includes('версия на сервере') || false,
  // Пустое место в разметке превращается в текстовый узел «null» и попадает на экран.
  мусор: ['null', 'undefined', 'NaN']
    .filter((word) => new RegExp('(^|\\\\s)' + word + '($|\\\\s)')
      .test(document.querySelector('.sheet')?.innerText || ''))
    .join(', ')
})`);

await send('Runtime.enable');
await send('Page.enable');

await send('Page.navigate', { url: `${baseUrl}/` });
await wait(2000);

if (offlineRun) {
  // Кэш должен быть прогрет предыдущим прогоном: именно его и проверяем, поэтому
  // ничего не чистим — иначе проверяли бы пустой кэш.
  await send('Network.enable');
  await send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  console.log('сеть выключена, кэш оставлен прогретым');
} else {
  // Чистим только кэш приложения: кэш моделей и библиотеки оставляем, иначе каждая
  // проверка тянула бы сотни мегабайт заново. Их проверяет стенд загрузки.
  console.log(`оставлено в кэше: ${await evaluate(`(async () => {
    const keep = ['transformers-cache', 'kbju-library-v1'];
    const kept = [];
    for (const key of await caches.keys()) {
      if (keep.includes(key)) { kept.push(key); continue; }
      await caches.delete(key);
    }
    for (const registration of await navigator.serviceWorker?.getRegistrations?.() || []) {
      await registration.unregister();
    }
    return kept.join(', ') || 'ничего';
  })()`)}`);
}

await send('Page.reload', { ignoreCache: false });
await wait(2500);

console.log(`страница: ${await evaluate('location.href')}`);
console.log(`кнопка «Голос» на экране дня: ${await tapText('Голос')}`);
await wait(600);

let sheet = JSON.parse(await state());
console.log(`открылась шторка: ${sheet.sheet} «${sheet.заголовок}»`);
if (!sheet.sheet) problems.push('кнопка «Голос» не открыла экран записи');
if (sheet.заголовок !== 'Еда голосом') problems.push(`неожиданный заголовок шторки: ${sheet.заголовок}`);

console.log(`начало записи: ${await tapText('Записать')}`);
await wait(400);
sheet = JSON.parse(await state());
if (!sheet.текст.includes('Говорите')) {
  problems.push(`запись не началась: нет приглашения говорить. На экране: ${sheet.текст.slice(0, 300).replace(/\n/g, ' | ')}`);
}
console.log(`идёт запись: ${sheet.текст.includes('Говорите')}`);

await wait(recordSeconds * 1000);
console.log(`остановка записи: ${await tapText('Готово')}`);

// Распознавание на слабой машине может занять минуты: ждём появления расшифровки.
const started = Date.now();
let transcript = null;
while (Date.now() - started < timeoutMs) {
  await wait(1500);
  const now = JSON.parse(await state());
  if (now.мусор) problems.push(`на экране распознавания служебное слово: ${now.мусор}`);
  if (now.ошибка) {
    problems.push(`на экране ошибка: ${now.текст.slice(0, 200).replace(/\n/g, ' ')}`);
    break;
  }
  if (now.расшифровка !== null) { transcript = now.расшифровка; break; }
  if (Date.now() - started > 6000 && Date.now() - started < 8000) {
    console.log(`  … ждём распознавания (${Math.round((Date.now() - started) / 1000)} с)`);
  }
}

if (transcript === null && !problems.length) problems.push('расшифровка так и не появилась');

function words(text) {
  return String(text || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

if (transcript !== null) {
  const want = words(expected);
  const got = new Set(words(transcript));
  const hit = want.filter((word) => got.has(word)).length;
  console.log(`\nрасшифровка: «${transcript}»`);
  console.log(`ожидалось:   «${expected}»`);
  console.log(`слов совпало: ${hit} из ${want.length}`);
  // Порог намеренно мягкий: проверяем, что путь работает, а качество меряет стенд.
  if (hit < Math.ceil(want.length / 2)) {
    problems.push(`слишком мало совпавших слов: ${hit} из ${want.length}`);
  }
}

// Вторая запись подряд: модель уже подготовлена, и готовить её заново не должны —
// иначе человек ждёт её второй раз и видит, будто она снова скачивается.
if (transcript !== null) {
  console.log(`\nвторая запись: ${await tapText('Записать снова')}`);
  await wait(1500);
  await tapText('Готово');

  const secondStarted = Date.now();
  let secondTranscript = null;
  let preparedAgain = false;
  while (Date.now() - secondStarted < timeoutMs) {
    await wait(400);
    const now = JSON.parse(await state());
    if (now.текст.includes('Готовлю модель')) preparedAgain = true;
    if (now.ошибка) { problems.push('на второй записи ошибка'); break; }
    if (now.расшифровка !== null) { secondTranscript = now.расшифровка; break; }
  }

  const secondSeconds = (Date.now() - secondStarted) / 1000;
  console.log(`вторая расшифровка за ${secondSeconds.toFixed(1)} с: «${secondTranscript}»`);
  const finalState = JSON.parse(await state());
  const facts = (finalState.текст || '')
    .split('\n').find((line) => line.includes(' с на ')) || 'строки с числами нет';
  console.log(`на экране: ${facts}`);
  if (finalState.мусор) problems.push(`на экране после второй записи служебное слово: ${finalState.мусор}`);

  if (preparedAgain) {
    problems.push('на второй записи модель готовилась заново — её держат подготовленной');
  }
  if (secondTranscript === null) problems.push('вторая расшифровка не появилась');
}

console.log(problems.length
  ? `\nНАЙДЕНО ПРОБЛЕМ (${problems.length}):\n${problems.join('\n')}`
  : '\nголосовой ввод работает: запись → расшифровка');
ws.close();
