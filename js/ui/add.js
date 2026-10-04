// Шторка добавления и правки записи. Здесь же выбор порции: множитель
// применяется к введённым числам, а базовые значения хранятся отдельно,
// чтобы при правке ничего не умножалось дважды.
import { addEntry, deleteEntry, store, updateEntry } from '../state.js';
import { h, nowTime, num, round } from '../util.js';
import { openSheet, toast } from './components/sheet.js';

const PORTIONS = [
  { id: 'small', label: 'Мало', multiplier: 0.7 },
  { id: 'normal', label: 'Средне', multiplier: 1 },
  { id: 'large', label: 'Много', multiplier: 1.4 },
];

const multiplierOf = (id) => PORTIONS.find((item) => item.id === id)?.multiplier ?? 1;

export function openAddSheet({ entry = null, date = null } = {}) {
  const isEdit = Boolean(entry);
  const targetDate = entry?.date || date || store.date;
  const base = entry?.base || entry || {};

  let portion = entry?.portion || 'normal';

  const nameInput = h('input', {
    type: 'text', placeholder: 'Например: борщ со сметаной', value: entry?.name || '',
    autocapitalize: 'sentences',
  });

  const timeInput = h('input', { type: 'time', value: (entry?.time || nowTime()).slice(0, 5) });

  const gramsInput = h('input', {
    type: 'number', inputmode: 'decimal', placeholder: 'если знаете',
    value: entry?.grams ?? '',
  });

  const numberField = (key, placeholder) => h('input', {
    type: 'number', inputmode: 'decimal', placeholder,
    value: base[key] === undefined || base[key] === null || base[key] === '' ? '' : round(base[key], 1),
  });

  const kcalInput = numberField('kcal', '0');
  const proteinInput = numberField('protein', '0');
  const fatInput = numberField('fat', '0');
  const carbsInput = numberField('carbs', '0');

  const commentInput = h('input', {
    type: 'text', placeholder: 'Комментарий, необязательно', value: entry?.comment || '',
  });

  const preview = h('div', { class: 'small muted', style: 'margin-top:10px' });

  const portionButtons = PORTIONS.map((item) => h('button', {
    type: 'button',
    text: item.label,
    'aria-pressed': String(item.id === portion),
    onclick: () => {
      portion = item.id;
      portionButtons.forEach((button) => {
        const id = button.dataset.portion;
        button.setAttribute('aria-pressed', String(id === portion));
      });
      updatePreview();
    },
  }));
  portionButtons.forEach((button, index) => { button.dataset.portion = PORTIONS[index].id; });

  function collect() {
    return {
      kcal: num(kcalInput.value),
      protein: num(proteinInput.value),
      fat: num(fatInput.value),
      carbs: num(carbsInput.value),
    };
  }

  function scaledValues() {
    const factor = multiplierOf(portion);
    const raw = collect();
    return {
      kcal: raw.kcal * factor,
      protein: raw.protein * factor,
      fat: raw.fat * factor,
      carbs: raw.carbs * factor,
    };
  }

  function updatePreview() {
    const factor = multiplierOf(portion);
    const value = scaledValues();
    preview.textContent = factor === 1
      ? `Итого: ${round(value.kcal)} ккал · Б ${round(value.protein)} · Ж ${round(value.fat)} · У ${round(value.carbs)}`
      : `Множитель ×${factor}: ${round(value.kcal)} ккал · Б ${round(value.protein)} · Ж ${round(value.fat)} · У ${round(value.carbs)}`;
  }

  [kcalInput, proteinInput, fatInput, carbsInput].forEach((input) => {
    input.addEventListener('input', updatePreview);
  });

  const dateRow = h('div', { class: 'tiny faint', style: 'margin-bottom:12px' },
    `${targetDate}${isEdit ? ' · запись существующая' : ''}`);

  const saveButton = h('button', {
    class: 'btn-primary', type: 'button', text: isEdit ? 'Сохранить изменения' : 'Записать',
    onclick: async () => {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.focus();
        toast('Название не заполнено');
        return;
      }
      const raw = collect();
      const value = scaledValues();
      const payload = {
        date: targetDate,
        time: timeInput.value || nowTime(),
        name,
        grams: gramsInput.value === '' ? null : num(gramsInput.value),
        comment: commentInput.value.trim(),
        portion,
        base: raw,
        ...value,
      };

      if (isEdit) {
        await updateEntry({ ...entry, ...payload });
        toast('Запись обновлена');
      } else {
        await addEntry({ ...payload, source: 'manual' });
        toast(`${name} записано`);
      }
      sheet.close();
    },
  });

  const actions = [saveButton];

  if (isEdit) {
    let armed = false;
    const deleteButton = h('button', {
      class: 'btn btn-small btn-danger', type: 'button', text: 'Удалить запись',
      onclick: async () => {
        if (!armed) {
          armed = true;
          deleteButton.textContent = 'Нажмите ещё раз, чтобы удалить';
          return;
        }
        await deleteEntry(entry.id);
        toast('Запись удалена');
        sheet.close();
      },
    });
    actions.push(deleteButton);
  }

  const content = h('div', {},
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Что это' }), nameInput),
    h('div', { class: 'grid-2' },
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Время' }), timeInput),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Вес, г' }), gramsInput)),
    h('div', { class: 'field' },
      h('span', { class: 'field-label', text: 'Порция' }),
      h('div', { class: 'portion-row' }, portionButtons)),
    h('div', { class: 'grid-4' },
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Ккал' }), kcalInput),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Б' }), proteinInput),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Ж' }), fatInput),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'У' }), carbsInput)),
    preview,
    h('label', { class: 'field', style: 'margin-top:14px' },
      h('span', { class: 'field-label', text: 'Комментарий' }), commentInput),
    dateRow);

  updatePreview();

  const sheet = openSheet({
    title: isEdit ? 'Правка записи' : 'Новая запись',
    content,
    actions,
  });

  return sheet;
}
