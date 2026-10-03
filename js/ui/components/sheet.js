// Нижняя шторка: используется для добавления, правки записи и диалогов.
import { h } from '../../util.js';

const root = () => document.getElementById('sheetRoot');

export function openSheet({ title = '', content, actions = [], onClose } = {}) {
  const holder = root();
  if (!holder) return { close() {} };

  const sheet = h('div', { class: 'sheet' },
    h('div', { class: 'sheet-grab' }),
    title ? h('h2', { class: 'sheet-title', text: title }) : null,
    content || null,
    actions.length ? h('div', { class: 'chips', style: 'margin-top:14px' }, actions) : null);

  const backdrop = h('div', { class: 'sheet-backdrop', onclick: () => close() });

  holder.replaceChildren(backdrop, sheet);
  holder.hidden = false;
  document.body.style.overflow = 'hidden';

  function onKey(event) {
    if (event.key === 'Escape') close();
  }

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    holder.hidden = true;
    holder.replaceChildren();
    document.body.style.overflow = '';
    if (onClose) onClose();
  }

  document.addEventListener('keydown', onKey);
  return { close };
}

export function toast(text, ms = 1800) {
  const node = h('div', { class: 'toast', text });
  document.body.append(node);
  setTimeout(() => node.remove(), ms);
}
