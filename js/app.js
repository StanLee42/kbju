// Точка входа: инициализация, маршрутизация между экранами, регистрация
// service worker и запрос постоянного хранилища.
import { isStoragePersistent, requestPersistentStorage } from './db.js';
import { refreshToday, store, init } from './state.js';
import { h } from './util.js';
import { BUILD_VERSION } from './version.js';
import { openChatSheet } from './ui/chat.js';
import * as calendar from './ui/calendar.js';
import * as settings from './ui/settings.js';
import * as today from './ui/today.js';
import * as usage from './ui/usage.js';

const ROUTES = {
  '/calendar': calendar,
  '/today': today,
  '/usage': usage,
  '/settings': settings,
};

let active = null;

function currentPath() {
  const raw = (location.hash || '').replace(/^#/, '');
  return ROUTES[raw] ? raw : '/today';
}

function render() {
  const path = currentPath();
  const view = document.getElementById('view');
  if (active && active.destroy) active.destroy();
  view.replaceChildren();
  active = ROUTES[path].mount(view) || {};
  document.querySelectorAll('.tab[data-tab]').forEach((tab) => {
    if (tab.dataset.tab === path.slice(1)) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
  window.scrollTo({ top: 0 });
}

async function main() {
  await init();

  document.getElementById('addButton').addEventListener('click', () => {
    if (currentPath() !== '/today') location.hash = '#/today';
    openChatSheet();
  });

  window.addEventListener('hashchange', render);
  if (!location.hash) location.replace('#/today');
  render();

  // Постоянное хранилище просим после первого касания: без жеста браузер
  // такие запросы отклоняет, а без него Chrome вправе вычистить IndexedDB.
  window.addEventListener('pointerdown', async () => {
    const granted = await requestPersistentStorage();
    if (granted !== null) store.storagePersistent = granted;
  }, { once: true });

  store.storagePersistent = await isStoragePersistent();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    // Новая сборка забирает управление сразу: в sw.js стоят skipWaiting и claim. Но уже
    // открытая страница продолжает работать на старых файлах до следующей загрузки, и
    // человек видит старое приложение, хотя в настройках уже новая версия. Поэтому
    // перезагружаемся один раз сами, как только управление перешло к новой сборке.
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // Первая установка тоже забирает управление — перезагружаться из-за неё незачем.
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });

    const registration = await navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.warn('service worker не зарегистрирован', error);
      return null;
    });

    // Проверяем обновление при каждом запуске: одна регистрация обновление не запускает,
    // а браузер сам спрашивает о новой сборке реже, чем раз в сутки. Из-за этого владелец
    // неделю видел старые экраны, хотя на сервере давно лежала новая сборка.
    registration?.update().catch(() => {});

    // Служба может оказаться новее страницы: тогда на телефоне работает прежний код,
    // хотя строка версии показывает новую сборку — так владелец и не нашёл новую кнопку.
    // Сравниваем версию самого кода с версией службы и один раз выравниваем перезагрузкой.
    const serviceWorkerVersion = await new Promise((resolve) => {
      const controller = navigator.serviceWorker.controller;
      if (!controller) { resolve(null); return; }
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 1500);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data?.version || null);
      };
      controller.postMessage({ type: 'version' }, [channel.port2]);
    });

    if (serviceWorkerVersion && serviceWorkerVersion !== BUILD_VERSION) {
      // Один раз на версию службы: иначе перезагрузка могла бы зациклиться.
      const asked = sessionStorage.getItem('kbju-version-aligned');
      if (asked !== serviceWorkerVersion) {
        sessionStorage.setItem('kbju-version-aligned', serviceWorkerVersion);
        location.reload();
      }
    }

    // Телефон держит приложение в памяти и не открывает его заново — значит, и новую
    // сборку не проверяет: браузер спрашивает о ней только при загрузке страницы.
    // Поэтому спрашиваем сами каждый раз, когда человек возвращается к приложению:
    // запрос к sw.js крошечный, а свежесть важнее. Второй проверки одновременно не бывает.
    let checking = false;
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible') return;
      // Вернулись к приложению утром — показываем новый день, а не вчерашний.
      await refreshToday().catch(() => {});
      if (!registration || checking) return;
      checking = true;
      await registration.update().catch(() => {});
      checking = false;
    });
  }
}

main().catch((error) => {
  console.error(error);
  const view = document.getElementById('view');
  view.replaceChildren(h('section', { class: 'card' },
    h('h2', { class: 'card-title', text: 'Не удалось запуститься' }),
    h('div', { class: 'small muted' },
      'Приложение открыто как файл или браузер не дал доступ к хранилищу. ' +
      'Откройте его по адресу http://localhost или через хостинг с HTTPS.'),
    h('pre', { class: 'tiny faint', style: 'white-space:pre-wrap;margin-top:10px' },
      String(error && error.message ? error.message : error))));
});
