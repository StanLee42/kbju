// Нижняя шторка: используется для добавления, правки записи и диалогов.
//
// Кнопка «назад» на телефоне — системная, и по умолчанию она уводит из приложения, а не
// закрывает открытое окно: раньше нажатие «назад» с открытой шторкой просто выходило из
// приложения. Чтобы этого не было, на открытие шторки добавляется своя запись в истории,
// и возврат к ней понимается как «закрой окно».
import { fill, h } from '../../util.js';

const root = () => document.getElementById('sheetRoot');
const HISTORY_STATE = { kbjuSheet: true };

/** Открытая шторка одна: новая заменяет прежнюю. */
let activeSheet = null;
/** Отложенный возврат по истории: отменяется, если шторку сразу заменяют другой. */
let pendingBack = null;

export function openSheet({ title = '', content, actions = [], onClose } = {}) {
  const holder = root();
  if (!holder) return { close() {} };

  // Переход «из окна в окно» (например, из разговора в ручной ввод): прежняя шторка
  // закрывается, а запись в истории переиспользуется — иначе на каждый переход
  // копилась бы своя запись, и «назад» пришлось бы нажимать несколько раз.
  if (activeSheet) {
    activeSheet.close({ replaced: true });
  } else if (pendingBack) {
    clearTimeout(pendingBack);
    pendingBack = null;
  } else if (!history.state?.kbjuSheet) {
    history.pushState(HISTORY_STATE, '');
  }

  const sheet = h('div', { class: 'sheet' },
    h('div', { class: 'sheet-grab' }),
    title ? h('h2', { class: 'sheet-title', text: title }) : null,
    content || null,
    actions.length ? h('div', { class: 'chips', style: 'margin-top:14px' }, actions) : null);

  const backdrop = h('div', { class: 'sheet-backdrop', onclick: () => close() });

  fill(holder, backdrop, sheet);
  holder.hidden = false;
  document.body.style.overflow = 'hidden';
  const releaseViewport = watchVisibleArea(holder);

  function onKey(event) {
    if (event.key === 'Escape') close();
  }

  /** Системный «назад»: браузер сам убрал нашу запись — закрываем окно и остаёмся в приложении. */
  function onPop() {
    if (closed) return;
    close({ fromHistory: true });
    // Запись уже убрана возвратом: возвращаем её, чтобы приложение никуда не уехало.
    history.pushState(HISTORY_STATE, '');
  }

  let closed = false;
  function close({ replaced = false, fromHistory = false } = {}) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('popstate', onPop);
    holder.hidden = true;
    fill(holder);
    document.body.style.overflow = '';
    releaseViewport();
    if (activeSheet === api) activeSheet = null;
    if (onClose) onClose();

    // Свою запись в истории убираем, иначе «назад» придётся нажимать лишний раз.
    // Возврат откладываем на один шаг: если шторку тут же заменят другой, запись
    // переиспользуется, а не пропадает.
    if (replaced || fromHistory) return;
    if (history.state?.kbjuSheet) {
      pendingBack = setTimeout(() => {
        pendingBack = null;
        history.back();
      }, 0);
    }
  }

  document.addEventListener('keydown', onKey);
  window.addEventListener('popstate', onPop);

  const api = { close, get opened() { return !closed; } };
  activeSheet = api;
  return api;
}

/**
 * Держим окно по видимой части экрана.
 *
 * Клавиатура на телефоне уменьшает видимую часть, но область вёрстки при этом не меняется.
 * Из-за этого окно ввода могло оказаться под клавиатурой, а пересчёт размеров во время её
 * появления заставлял браузер закрывать клавиатуру — она «появлялась и исчезала».
 * Поэтому высоту и положение берём у видимой части: тогда содержимое не переезжает,
 * а окно ввода стоит ровно над клавиатурой.
 */
function watchVisibleArea(holder) {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};

  const apply = () => {
    holder.style.height = `${Math.round(viewport.height)}px`;
    holder.style.top = `${Math.round(viewport.offsetTop)}px`;
    holder.style.bottom = 'auto';
  };

  apply();
  viewport.addEventListener('resize', apply);
  viewport.addEventListener('scroll', apply);

  return () => {
    viewport.removeEventListener('resize', apply);
    viewport.removeEventListener('scroll', apply);
    holder.style.height = '';
    holder.style.top = '';
    holder.style.bottom = '';
  };
}

export function toast(text, ms = 1800) {
  const node = h('div', { class: 'toast', text });
  document.body.append(node);
  setTimeout(() => node.remove(), ms);
}
