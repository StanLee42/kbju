// Проверка вёрстки на узких экранах: страница не должна быть шире телефона,
// нижнее меню должно помещаться целиком, а настройки — открываться.
//
// Запуск (нужен Chrome с отладочным портом и локальный сервер):
//   node tools/cdp-layout.mjs
const baseUrl = process.argv[2] || 'http://127.0.0.1:8765';
const debugPort = process.env.CDP_PORT || 9222;

const WIDTHS = [320, 360, 390, 430];
const SCREENS = [
  { hash: '#/calendar', name: 'Календарь' },
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
          // Вкладка должна быть видна целиком и находиться в полосе нижней панели:
          // уехавшая на вторую строку вкладка не видна, хотя по ширине проходит.
          fits: rect.right <= deviceWidth + 1 && rect.left >= -1
            && rect.bottom <= window.innerHeight + 1 && rect.top >= 0,
          right: Math.round(rect.right),
          middle: Math.round((rect.top + rect.bottom) / 2),
        };
      });

      return JSON.stringify({
        deviceWidth,
        layoutWidth,
        overflow,
        offenders: offenders.slice(0, 4),
        tabs,
        screenErrors: Boolean(document.getElementById('view')?.dataset.errorShown),
        // Служебные слова в тексте — след пустых значений, которые браузер
        // превратил в текстовые узлы. Такое видно глазами, но легко пропустить.
        strayText: ['null', 'undefined', 'NaN']
          .filter((word) => new RegExp('(^|\\\\s)' + word + '($|\\\\s)').test(document.body.innerText))
          .join(', '),
      });
    })()`);

    const data = JSON.parse(metrics || '{}');
    const line = `${width}px ${screen.name}`;
    const tabProblems = (data.tabs || []).filter((tab) => !tab.fits).map((tab) => tab.label);
    // Все вкладки обязаны стоять в одном ряду: сравниваем середины, потому что кнопка
    // добавления выше остальных, но стоять должна там же.
    const middles = (data.tabs || []).map((tab) => tab.middle);
    if (middles.length && Math.max(...middles) - Math.min(...middles) > 2) {
      problems.push(`${line}: вкладки разъехались по высоте — часть нижней панели не видна`);
    }

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
    if (data.strayText) {
      problems.push(`${line}: на экран попали служебные слова — ${data.strayText}`);
    }

    console.log(`${line}: вёрстка ${data.layoutWidth}px, экран ${width}px, перелив ${data.overflow}px, `
      + `вкладок ${data.tabs?.length ?? 0}, за краем ${(data.offenders || []).length}`);
  }
}

// Отдельно проверяем, что настройки действительно открываются на узком экране.
// Нажимаем НАСТОЯЩИМ касанием по координатам, а не вызовом click() на элементе:
// программный вызов обходит проверку попадания и не замечает невидимых перекрытий,
// которые съедают касания в реальном приложении.
await send('Emulation.setDeviceMetricsOverride', {
  width: 360, height: 780, deviceScaleFactor: 2, mobile: true,
});
await send('Page.navigate', { url: `${baseUrl}/#/today` });
await wait(2200);

async function tapCenter(selectorText, label) {
  const point = await evaluate(`(() => {
    const node = [...document.querySelectorAll('button, .tab, a')]
      .find((item) => item.textContent.includes(${JSON.stringify(selectorText)}));
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return JSON.stringify({ x: Math.round((rect.left + rect.right) / 2), y: Math.round((rect.top + rect.bottom) / 2) });
  })()`);
  if (!point) return `${label}: элемент не найден`;
  const { x, y } = JSON.parse(point);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', clickCount: 1, pointerType: 'mouse',
    });
  }
  await wait(700);
  return `${label}: касание отправлено (${x}, ${y})`;
}

console.log(`\n${await tapCenter('Настройки', 'вкладка Настройки')}`);

const afterTap = await evaluate(`JSON.stringify({
  hash: location.hash,
  заголовок: document.querySelector('#view h1')?.textContent || '',
  секций: document.querySelectorAll('section.card').length,
  версия: [...document.querySelectorAll('p')].map((p) => p.textContent)
    .find((text) => text.includes('сборка')) || 'нет строки версии',
})`);
console.log(`после нажатия: ${afterTap}`);

const parsed = JSON.parse(afterTap);
if (parsed.hash !== '#/settings') problems.push('касание по «Настройки» не открыло экран настроек');
if (!parsed.секций) problems.push('на экране настроек нет ни одной секции');

// Проверяем, что касания доходят до содержимого, а не гасятся невидимым слоем.
await send('Page.navigate', { url: `${baseUrl}/#/today` });
await wait(2000);
console.log(`\n${await tapCenter('Добавить', 'кнопка добавления в нижней панели')}`);
const sheetOpened = await evaluate(`Boolean(document.querySelector('.sheet'))`);
if (!sheetOpened) problems.push('касание по «Добавить» не открыло окно добавления');
const composerReady = await evaluate(`Boolean(document.querySelector('.composer-input') && document.querySelector('.composer-send'))`);
if (!composerReady) problems.push('в окне добавления нет поля ввода и кнопки отправки');
console.log(`окно добавления открылось: ${sheetOpened}, поле ввода на месте: ${composerReady}`);

const blockers = await evaluate(`(() => {
  const points = [[60, 120], [180, 300], [300, 700]];
  return JSON.stringify(points.map(([x, y]) => {
    const node = document.elementFromPoint(x, y);
    return node ? (node.id ? '#' + node.id : (node.className ? '.' + String(node.className).split(' ')[0] : node.tagName)) : 'ничего';
  }));
})()`);
console.log(`что ловит касания в трёх точках экрана: ${blockers}`);
if (String(blockers).includes('sheetRoot')) {
  problems.push('невидимая шторка перехватывает касания (sheetRoot в списке перехватчиков)');
}

console.log(problems.length ? `\nНАЙДЕНО ПРОБЛЕМ (${problems.length}):\n${problems.join('\n')}` : '\nвёрстка и касания в порядке');
ws.close();
