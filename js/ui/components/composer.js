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
  note = null,
  keyWarning = null,
  extra = null,
  onSend,
  onAttachError = null,
} = {}) {
  const state = { text: '', photo: null, preview: null, busy: false, hasDraft: false };

  // Поле одно на всё время: пересоздание во время набора закрывает клавиатуру.
  const input = h('textarea', {
    class: 'composer-input', rows: 2,
    spellcheck: false,
    oninput: (event) => { state.text = event.target.value; },
  });

  const host = h('div', {});

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
      h('div', { class: 'composer-row' },
        h('div', { class: 'chips' },
          h('button', {
            class: 'btn btn-small', type: 'button', text: '📷 Снять',
            disabled: state.busy, onclick: () => attach(true),
          }),
          h('button', {
            class: 'btn btn-small', type: 'button', text: '🖼 Из галереи',
            disabled: state.busy, onclick: () => attach(false),
          })),
        h('button', {
          class: 'btn-primary composer-send', type: 'button',
          text: state.busy ? 'Считаю…' : 'Отправить',
          disabled: state.busy,
          onclick: send,
        })),
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
