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

// Отдельный кэш для библиотеки распознавания с CDN. Он не привязан к версии сборки
// намеренно: иначе после каждого обновления приложения телефон качал бы её заново.
const LIBRARY_CACHE = 'kbju-library-v1';
const LIBRARY_HOSTS = ['cdn.jsdelivr.net'];

// Кэши, которые переживают обновление сборки. Кэш моделей ведёт сама библиотека
// распознавания: удалив его, мы заставили бы телефон скачивать модель заново.
const KEPT_CACHES = [LIBRARY_CACHE, 'transformers-cache'];

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
      .then((keys) => Promise.all(keys
        .filter((key) => key !== VERSION && !KEPT_CACHES.includes(key))
        .map((key) => caches.delete(key))))
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

  // Библиотека распознавания приезжает с CDN. Её кэшируем отдельно: без сети приложение
  // должно не только открыться, но и распознать сказанное. Модели сюда не попадают —
  // их библиотека хранит сама, вторым кэшем.
  if (LIBRARY_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(LIBRARY_CACHE).then((cache) => cache.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        });
      }))
    );
    return;
  }

  // Остальные внешние адреса (модели, провайдер) не трогаем: у них свои правила.
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
