// Проверка вёрстки на узких экранах: страница не должна быть шире телефона,
// нижнее меню должно помещаться целиком, а настройки — открываться.
//
// Запуск (нужен Chrome с отладочным портом и локальный сервер):
//   node tools/cdp-layout.mjs
const baseUrl = process.argv[2] || 'http://127.0.0.1:8765';
const debugPort = process.env.CDP_PORT || 9222;

const WIDTHS = [320, 360, 390, 430];
const SCREENS = [
  { hash: '#/today', name: 'Сегодня' },
  { hash: '#/usage', name: 'Расход' },
  { hash: '#/settings', name: 'Настройки' },
];

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
  return result?.result?.value;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTHS[1], height: 780, deviceScaleFactor: 2, mobile: true,
});

// Чистим кэш и снимаем service worker: иначе проверка пойдёт против файлов
// предыдущей сборки, и правки в стилях будут выглядеть как «не применились».
await send('Page.navigate', { url: `${baseUrl}/` });
await wait(1500);
await evaluate(`(async () => {
  for (const key of await caches.keys()) await caches.delete(key);
  const registrations = await navigator.serviceWorker?.getRegistrations?.() || [];
  for (const registration of registrations) await registration.unregister();
  return 'ok';
})()`);
await send('Page.reload', { ignoreCache: true });
await wait(2000);

const loadedStyles = await evaluate(`(() => {
  const sheet = [...document.styleSheets].find((s) => (s.href || '').includes('styles.css'));
  if (!sheet) return 'файл стилей не найден';
  try {
    const rules = [...sheet.cssRules].map((rule) => rule.cssText).join('\\n');
    return rules.includes('max-width: 380px') ? 'новая вёрстка загружена' : 'стили старые';
  } catch {
    return 'правила недоступны';
  }
})()`);
console.log(`стили: ${loadedStyles}`);

const problems = [];

for (const width of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height: 780, deviceScaleFactor: 2, mobile: true,
  });
  await send('Page.navigate', { url: `${baseUrl}/${SCREENS[0].hash}` });
  await wait(2200);

  for (const screen of SCREENS) {
    await evaluate(`location.hash = '${screen.hash}'; 'ok'`);
    await wait(700);

    const metrics = await evaluate(`(() => {
      const deviceWidth = ${width};
      const layoutWidth = window.innerWidth;
      const overflow = document.documentElement.scrollWidth - layoutWidth;

      // Главная беда мобильной вёрстки: если содержимое шире экрана, Chrome
      // расширяет область вёрстки, и правый край вместе с нижним меню уезжает
      // за пределы видимой части. Поэтому сравниваем не с областью вёрстки,
      // а с реальной шириной экрана.
      const offenders = [];
      for (const node of document.querySelectorAll('body *')) {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.right > deviceWidth + 1) {
          offenders.push({
            selector: node.className ? '.' + String(node.className).split(' ')[0] : node.tagName.toLowerCase(),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
          });
        }
      }
      offenders.sort((a, b) => b.right - a.right);

      const tabs = [...document.querySelectorAll('.tab')].map((tab) => {
        const rect = tab.getBoundingClientRect();
        return {
          label: tab.textContent.trim(),
          fits: rect.right <= deviceWidth + 1 && rect.left >= -1,
          right: Math.round(rect.right),
        };
      });

      return JSON.stringify({
        deviceWidth,
        layoutWidth,
        overflow,
        offenders: offenders.slice(0, 4),
        tabs,
        screenErrors: Boolean(document.getElementById('view')?.dataset.errorShown),
      });
    })()`);

    const data = JSON.parse(metrics || '{}');
    const line = `${width}px ${screen.name}`;
    const tabProblems = (data.tabs || []).filter((tab) => !tab.fits).map((tab) => tab.label);

    if (data.layoutWidth > width + 1) {
      problems.push(`${line}: вёрстке нужно ${data.layoutWidth}px при экране ${width}px, `
        + `за краем: ${(data.offenders || []).map((item) => item.selector).join(', ') || 'не определено'}`);
    }
    if (data.overflow > 1) {
      problems.push(`${line}: страница шире области вёрстки на ${data.overflow}px`);
    }
    if (tabProblems.length) {
      problems.push(`${line}: нижнее меню не помещается: ${tabProblems.join(', ')}`);
    }
    if (data.screenErrors) problems.push(`${line}: на экране показана ошибка`);

    console.log(`${line}: вёрстка ${data.layoutWidth}px, экран ${width}px, перелив ${data.overflow}px, `
      + `вкладок ${data.tabs?.length ?? 0}, за краем ${(data.offenders || []).length}`);
  }
}

// Отдельно проверяем, что настройки действительно открываются на узком экране.
await send('Emulation.setDeviceMetricsOverride', {
  width: 360, height: 780, deviceScaleFactor: 2, mobile: true,
});
await send('Page.navigate', { url: `${baseUrl}/#/today` });
await wait(2200);

const tapped = await evaluate(`(() => {
  const tab = [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('Настройки'));
  if (!tab) return 'вкладка Настройки не найдена';
  tab.click();
  return 'нажали';
})()`);
await wait(900);

const afterTap = await evaluate(`JSON.stringify({
  hash: location.hash,
  заголовок: document.querySelector('#view h1')?.textContent || '',
  секций: document.querySelectorAll('section.card').length,
  версия: [...document.querySelectorAll('p')].map((p) => p.textContent)
    .find((text) => text.includes('версия приложения')) || 'нет строки версии',
})`);
console.log(`\nпереход в настройки: ${tapped}`);
console.log(`после нажатия: ${afterTap}`);

const parsed = JSON.parse(afterTap);
if (parsed.hash !== '#/settings') problems.push('нажатие на «Настройки» не открыло экран настроек');
if (!parsed.секций) problems.push('на экране настроек нет ни одной секции');

console.log(problems.length ? `\nНАЙДЕНО ПРОБЛЕМ (${problems.length}):\n${problems.join('\n')}` : '\nвёрстка в порядке');
ws.close();
