// Поле ввода сообщения со снимком: общее для переписки про еду и для разговора о нормах.
//
// Здесь собраны те мелочи, на которых мы уже спотыкались: поле создаётся один раз (иначе
// клавиатура закрывается прямо во время набора), проверка орфографии выключена (её меню
// скрывает клавиатуру, а русского словаря у Chrome нет), а приложенный снимок видно сразу.
import { pickImage, prepareForApi } from '../../media/image.js';
import { fill, h } from '../../util.js';
import { toast } from './sheet.js';

export function createComposer({
  placeholder = 'Напишите сообщение',
  placeholderWithDraft = null,
  initialText = '',
  note = null,
  keyWarning = null,
  extra = null,
  onSend,
  onTyped = null,
  onAttachError = null,
  onProducts = null,
} = {}) {
  const state = { text: initialText, photo: null, preview: null, busy: false, hasDraft: false };

  // Поле одно на всё время: пересоздание во время набора закрывает клавиатуру.
  const input = h('textarea', {
    class: 'composer-input', rows: 2,
    spellcheck: false,
    oninput: (event) => { state.text = event.target.value; notifyTyped(); },
  });

  const host = h('div', {});

  /**
   * Сообщает наружу о набранном. Набранное сохраняется, не дожидаясь отправки: страница
   * перезагружается сама, когда на устройство приходит новая сборка.
   */
  function notifyTyped() {
    if (onTyped) onTyped(state.text);
  }

  function renderPhoto() {
    return state.preview
      ? h('div', { class: 'attached' },
        h('img', { class: 'msg-photo', src: state.preview, alt: 'снимок' }),
        h('button', {
          class: 'btn btn-small btn-ghost', type: 'button', text: 'Убрать снимок',
          onclick: () => {
            state.photo = null;
            state.preview = null;
            render();
          },
        }))
      : null;
  }

  async function attach(fromCamera) {
    const file = await pickImage({ camera: fromCamera });
    if (!file) return;
    try {
      const prepared = await prepareForApi(file);
      state.photo = { base64: prepared.base64, mime: prepared.mime, file };
      state.preview = `data:${prepared.mime};base64,${prepared.base64}`;
      render();
    } catch (error) {
      if (onAttachError) onAttachError(error);
      else toast(`Снимок не удалось прочитать: ${error.message || error}`);
    }
  }

  function render() {
    input.placeholder = state.hasDraft && placeholderWithDraft
      ? placeholderWithDraft
      : placeholder;
    if (input.value !== state.text) input.value = state.text;

    fill(host,
      renderPhoto(),
      input,
      // Способы ввода стоят одним рядом, отправка отдельной кнопкой под ними: так отправка
      // не спорит размерами со способами, и человек видит, что снимок и список это выбор,
      // а отправка это действие.
      h('div', { class: 'chips composer-ways' },
        h('button', {
          class: 'btn btn-small', type: 'button', text: '📷 Камера',
          disabled: state.busy, onclick: () => attach(true),
        }),
        h('button', {
          class: 'btn btn-small', type: 'button', text: '🖼 Галерея',
          disabled: state.busy, onclick: () => attach(false),
        }),
        onProducts
          ? h('button', {
            class: 'btn btn-small', type: 'button', text: '🧺 Мои продукты',
            disabled: state.busy, onclick: onProducts,
          })
          : null),
      h('button', {
        class: 'btn-primary composer-send', type: 'button',
        text: state.busy ? 'Считаю…' : 'Отправить',
        disabled: state.busy,
        onclick: send,
      }),
      keyWarning
        ? h('p', { class: 'small', style: 'margin-top:8px;color:var(--over)' }, keyWarning)
        : null,
      extra,
      note ? h('p', { class: 'tiny faint', style: 'margin-top:8px' }, note) : null);
  }

  async function send() {
    const text = state.text.trim();
    if (!text && !state.photo) {
      toast('Напишите словами или приложите снимок');
      return;
    }
    if (state.busy) return;
    if (keyWarning) {
      toast('Вставьте ключ провайдера в настройках');
      return;
    }
    const photo = state.photo;
    const sent = text;
    // Поле чистим сразу: если отправка не удалась, текст вернём в сообщение переписки.
    state.text = '';
    state.photo = null;
    state.preview = null;
    render();
    notifyTyped();
    await onSend({ text: sent, photo });
  }

  render();

  return {
    element: host,
    get text() { return state.text; },
    get photo() { return state.photo; },
    /** Забирает написанное для отправки извне (повтор неудачного запроса). */
    take() {
      const payload = { text: state.text.trim(), photo: state.photo };
      state.text = '';
      state.photo = null;
      state.preview = null;
      render();
      notifyTyped();
      return payload;
    },
    setBusy(value) {
      state.busy = Boolean(value);
      render();
    },
    setHasDraft(value) {
      state.hasDraft = Boolean(value);
      render();
    },
    focus() {
      input.focus();
    },
  };
}
