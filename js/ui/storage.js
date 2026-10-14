// Экран хранилища: сколько занято, выдано ли постоянное хранилище и удаление всех данных.
//
// Переехал из настроек: удаление данных это не настройка поведения, а обслуживание,
// и рядом с нормами и расписанием такая кнопка стоит слишком близко к рабочим настройкам.
import { isStoragePersistent, requestPersistentStorage, usageEstimate, wipeEverything } from '../db.js';
import { clearChat } from '../chat-session.js';
import { bytesHuman, fill, h } from '../util.js';
import { toast } from './components/sheet.js';

export function mount(container) {
  const host = h('div', { class: 'small muted' });
  container.append(
    h('h1', { text: 'Хранилище', style: 'margin-bottom:12px' }),
    h('section', { class: 'card' }, host),
  );

  render();

  async function render() {
    const [estimate, persistent] = await Promise.all([usageEstimate(), isStoragePersistent()]);
    const parts = [];

    if (estimate) {
      parts.push(h('div', {}, `Занято: ${bytesHuman(estimate.usage)} из ${bytesHuman(estimate.quota)} доступных`));
    } else {
      parts.push(h('div', {}, 'Размер хранилища браузер не сообщает'));
    }

    parts.push(h('div', { style: 'margin-top:6px' },
      persistent === true
        ? 'Постоянное хранилище включено: браузер не удалит дневник сам.'
        : persistent === false
          ? 'Постоянное хранилище не выдано: браузер может удалить данные при нехватке места.'
          : 'Статус постоянного хранилища неизвестен.'));

    parts.push(h('div', { class: 'chips', style: 'margin-top:10px' },
      h('button', {
        class: 'btn btn-small', type: 'button', text: 'Запросить постоянное хранилище',
        onclick: async () => {
          const granted = await requestPersistentStorage();
          toast(granted ? 'Постоянное хранилище включено' : 'Браузер отказал');
          render();
        },
      })));

    let armed = false;
    const wipeButton = h('button', {
      class: 'btn btn-small btn-danger', type: 'button', text: 'Удалить все данные',
      onclick: async () => {
        if (!armed) {
          armed = true;
          wipeButton.textContent = 'Нажмите ещё раз, чтобы стереть';
          return;
        }
        await wipeEverything();
        // Разговор о еде лежит вне дневника, но это тоже данные человека.
        clearChat();
        toast('Данные удалены');
        location.reload();
      },
    });
    parts.push(h('div', { class: 'chips', style: 'margin-top:10px' }, wipeButton));

    fill(host, ...parts);
  }

  return { destroy() {} };
}
