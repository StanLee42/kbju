// Обновление приложения до серверной сборки.
//
// Здесь две вещи, на которых мы уже спотыкались.
//
// Первая: перезагружать страницу нужно ПОСЛЕ того, как новая служба возьмёт управление.
// Если перезагрузиться раньше (например, через фиксированную задержку), страницу снова
// отдаст старая служба из своего кэша, и всё повторится: владелец неделю видел старые экраны,
// нажимая «Обновить приложение».
//
// Вторая: сравнивать нужно версию работающего кода с версией на сервере, а не версию службы:
// служба может быть новой, пока страница осталась прежней.
import { BUILD_VERSION } from './version.js';

/** Версия сборки, которая лежит на сервере (файл читается в обход кэша). */
export async function serverVersion() {
  try {
    const response = await fetch('./version.txt', { cache: 'no-store' });
    if (!response.ok) return null;
    const [version] = String(await response.text()).trim().split('\n');
    return version || null;
  } catch {
    return null;
  }
}

/**
 * Доводит обновление до конца и перезагружает страницу.
 * Ждёт, пока служба действительно сменится, но не дольше двадцати секунд.
 */
export async function updateAndReload({ waitMs = 20000 } = {}) {
  const registration = await navigator.serviceWorker?.getRegistration?.().catch(() => null);
  if (!registration) {
    location.reload();
    return;
  }

  const changed = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), waitMs);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      clearTimeout(timer);
      resolve(true);
    }, { once: true });
  });

  await registration.update().catch(() => {});
  await changed;
  location.reload();
}

/**
 * Проверяет, не отстал ли работающий код от сервера, и если отстал — обновляется.
 * Повторяет попытку один раз на версию: иначе без сети получилась бы бесконечная перезагрузка.
 */
export async function alignWithServer({ onOutdated = null } = {}) {
  const server = await serverVersion();
  if (!server || server === BUILD_VERSION) return false;
  if (onOutdated) onOutdated(server);

  const tried = sessionStorage.getItem('kbju-update-tried');
  if (tried === server) return true;
  sessionStorage.setItem('kbju-update-tried', server);

  await updateAndReload();
  return true;
}
