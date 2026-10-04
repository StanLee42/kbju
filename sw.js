// Кэшируем только оболочку приложения: сами файлы. Данные пользователя лежат
// в IndexedDB и в кэш не попадают никогда.
//
// Список ниже — минимальный, чтобы приложение поднималось при разработке. При сборке
// (tools/build-www.mjs) он заменяется полным списком файлов приложения, а там же
// подставляется имя кэша по отпечатку содержимого.
const VERSION = 'kbju-dev';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Отвечаем, какая сборка обслуживает страницу: строка версии в настройках должна показывать
// работающую сборку, а не ту, что лежит на сервере. Это разные вещи ровно тогда, когда
// приложение открыто с прошлого раза и ещё не подхватило новую.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'version') return;
  const port = event.ports && event.ports[0];
  if (port) port.postMessage({ version: VERSION });
});

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // Запросы, которые явно просят не смотреть в кэш (например файл версии сборки),
  // пропускаем прямо в сеть. Иначе кэш оболочки начнёт врать: он сопоставляет
  // запрос по адресу и не смотрит на пожелания запрашивающего.
  if (request.cache === 'no-store' || request.cache === 'reload') return;

  const url = new URL(request.url);
  // Запросы к моделям и любые внешние адреса не трогаем.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
