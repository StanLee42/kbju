// Стенд распознавания речи: запускает проверочную страницу в Chrome и печатает замеры.
//
// Зачем: модуль распознавания написан, но ни разу не запускался в браузере. Здесь
// проверяется то, что нельзя проверить тестами: скачивается ли модель, считает ли она
// и сколько это занимает времени на настоящем движке.
//
// Запуск:
//   node tools/recognize-probe.mjs                          # крошечная без ускорения
//   node tools/recognize-probe.mjs --configs tiny-wasm,tiny-int8,base-wasm
//   node tools/recognize-probe.mjs --headed                 # с видимым окном Chrome
//
// Ключи: --configs (список сборок), --timeout (минуты), --chrome-port (отладочный порт),
// --target (часть адреса нужной вкладки), --adhoc (сборки для замера), --headed, --tag, --out.
//
// Пример сборки для замера: --adhoc "base-int8:onnx-community/whisper-base:wasm:int8"
//
// Для телефона или эмулятора Chrome уже должен быть открыт, порты проброшены:
//   adb reverse tcp:8766 tcp:8766
//   adb forward tcp:9223 localabstract:chrome_devtools_remote
//   node tools/recognize-probe.mjs --chrome-port 9223 --target recognize-probe --configs tiny-wasm
//
// Результаты складываются в spike/voice/ (папка не попадает в репозиторий).
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const flag = (name) => args.includes(`--${name}`);

const configs = option('configs', 'tiny-wasm');
const samples = option('samples', 'spike/voice/samples.json');
const serverPort = Number(option('port', 8766));
const debugPort = Number(option('chrome-port', 9333));
const profileDir = resolve(option('profile', '/tmp/kbju-probe-chrome'));
const headed = flag('headed');
const timeoutMs = Number(option('timeout', 20)) * 60 * 1000;
const targetFilter = option('target', '');
// Сборки для замера, которых нет в списке приложения: «id:модель:устройство:точность».
// Точность — одно значение для обеих частей или два через «+» (кодировщик и декодер).
const adhoc = option('adhoc', '');
const tag = option('tag', configs.replace(/[^a-z0-9-]/gi, '_'));
const outFile = resolve(option('out', join(root, 'spike', 'voice', `probe-${tag}.json`)));

const baseUrl = `http://127.0.0.1:${serverPort}`;
// Метка времени в адресе: иначе браузер может взять со стенда вчерашнюю страницу
// из своего кэша, и правки в стенде будут выглядеть как «не применились».
const pageUrl = `${baseUrl}/tools/recognize-probe.html`
  + `?configs=${encodeURIComponent(configs)}&samples=${encodeURIComponent(samples)}`
  + (adhoc ? `&adhoc=${encodeURIComponent(adhoc)}` : '')
  + `&t=${Date.now()}`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function reachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Статический сервер из корня репозитория: стенду нужны и страница, и образцы. */
async function ensureServer() {
  if (await reachable(`${baseUrl}/tools/recognize-probe.html`)) return null;
  const child = spawn('python3', ['-m', 'http.server', String(serverPort)], {
    cwd: root, stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await wait(250);
    if (await reachable(`${baseUrl}/tools/recognize-probe.html`)) return child;
  }
  child.kill();
  throw new Error(`сервер на порту ${serverPort} не поднялся (занят? проверьте: lsof -i :${serverPort})`);
}

const CHROME_PATHS = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'google-chrome',
].filter(Boolean);

function findChrome() {
  for (const path of CHROME_PATHS) {
    if (path.includes('/')) {
      const check = spawnSync('test', ['-x', path]);
      if (check.status === 0) return path;
    } else {
      const check = spawnSync('which', [path]);
      if (check.status === 0) return path;
    }
  }
  throw new Error('не найден Chrome: задайте путь переменной CHROME');
}

async function ensureChrome() {
  if (await reachable(`http://127.0.0.1:${debugPort}/json/version`)) return null;

  const binary = findChrome();
  // Профиль постоянный: скачанные модели остаются в кэше браузера между запусками,
  // иначе каждая проверка тянула бы сотни мегабайт заново.
  const chromeArgs = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ];
  // Ускорение видеокартой намеренно не отключаем: стенд должен честно показать,
  // доступно ли оно, а не отвечать «нет» из-за флага запуска.
  if (!headed) chromeArgs.push('--headless=new');
  chromeArgs.push('about:blank');

  const child = spawn(binary, chromeArgs, { stdio: 'ignore' });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(500);
    if (await reachable(`http://127.0.0.1:${debugPort}/json/version`)) return child;
  }
  child.kill();
  throw new Error(`Chrome не открыл отладочный порт ${debugPort}`);
}

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const pages = targets.filter((target) => target.type === 'page');
  // На телефоне вкладок обычно много: тогда нужную выбираем по адресу,
  // чтобы не увести на стенд чужую открытую страницу.
  const page = targetFilter
    ? pages.find((target) => target.url.includes(targetFilter))
    : pages[0];
  if (!page) {
    throw new Error(targetFilter
      ? `не нашлась вкладка с адресом «${targetFilter}» — откройте её в браузере`
      : 'в Chrome нет открытой вкладки');
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

  const send = (method, params = {}) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveAnswer) => pending.set(id, resolveAnswer));
  };

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (result?.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'ошибка вычисления на странице');
    }
    return result?.result?.value;
  };

  return { send, evaluate, close: () => ws.close() };
}

const stripTags = (text) => String(text).replace(/<[^>]+>/g, '');

async function main() {
  await mkdir(dirname(outFile), { recursive: true });
  const server = await ensureServer();
  const chrome = await ensureChrome();
  const cleanup = () => { chrome?.kill(); server?.kill(); };

  try {
    const cdp = await connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    console.log(`сборки моделей: ${configs}`);
    console.log(`образцы: ${samples}`);
    console.log(`страница: ${pageUrl}\n`);

    await cdp.send('Page.navigate', { url: pageUrl });

    const started = Date.now();
    let printed = 0;
    let lastPercent = -1;
    let snapshot = null;

    for (;;) {
      await wait(2000);
      const raw = await cdp.evaluate('JSON.stringify(window.__probe ? window.__probe : null)');
      if (raw) {
        snapshot = JSON.parse(raw);
        for (const line of snapshot.log.slice(printed)) console.log(stripTags(line));
        printed = snapshot.log.length;

        // Загрузка модели идёт минутами: показываем, что она движется, а не зависла.
        // Проценты могут начаться заново — после отката на сборку без ускорения
        // качается уже другой набор файлов, и это не повод молчать.
        const progress = snapshot.progress;
        if (progress && snapshot.status === 'running') {
          if (progress.percent < lastPercent) lastPercent = -1;
          if (progress.percent - lastPercent >= 10) {
            console.log(`    ${progress.id}: скачано ${progress.percent}%`);
            lastPercent = progress.percent;
          }
        }
        if (snapshot.status !== 'running') break;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`стенд не закончил за ${Math.round(timeoutMs / 1000)} с`);
      }
    }

    cdp.close();

    if (!snapshot) throw new Error('страница не отдала результаты');
    const report = { pageUrl, finishedAt: new Date().toISOString(), ...snapshot };
    await writeFile(outFile, JSON.stringify(report, null, 2), 'utf8');

    console.log('\n— итог —');
    for (const row of report.configs || []) {
      if (row.error) {
        console.log(`${row.id}: не пошло — ${row.error.title}`);
        continue;
      }
      const parts = [`загрузка ${(row.load.ms / 1000).toFixed(1)} с`, `${row.load.mb ?? '?'} МБ`];
      if (row.reload?.ms !== undefined) parts.push(`повтор ${(row.reload.ms / 1000).toFixed(1)} с`);
      console.log(`${row.id}: ${parts.join(', ')}`);
      for (const item of row.recognize) {
        if (item.error) { console.log(`    ${item.file}: ошибка — ${item.error}`); continue; }
        console.log(`    ${item.file}: ×${item.realtime} от длительности, `
          + `слов ${item.words.hit}/${item.words.total} — «${item.text}»`);
      }
    }
    console.log(`\nсырые замеры: ${outFile}`);
    return report.status === 'done' ? 0 : 1;
  } finally {
    cleanup();
  }
}

const code = await main();
if (code !== 0) process.exitCode = code;
