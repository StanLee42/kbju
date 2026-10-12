// Шторка добавления и правки записи. Числа вводятся как есть: множителя размера порции нет,
// поэтому в записи лежат те же числа, что человек набрал.
import { addEntry, deleteEntry, store, updateEntry } from '../state.js';
import { forWeight } from '../products.js';
import { h, nowTime, num, round } from '../util.js';
import { openSheet, toast } from './components/sheet.js';

export function openAddSheet({ entry = null, date = null } = {}) {
  const isEdit = Boolean(entry);
  const targetDate = entry?.date || date || store.date;

  const nameInput = h('input', {
    type: 'text', placeholder: 'Например: борщ со сметаной', value: entry?.name || '',
    autocapitalize: 'sentences',
    // Проверку орфографии Chrome выключаем: словаря на русском у него нет, он подчёркивает
    // всё подряд, а его меню закрывает клавиатуру прямо во время набора.
    spellcheck: false,
  });

  const timeInput = h('input', { type: 'time', value: (entry?.time || nowTime()).slice(0, 5) });

  const gramsInput = h('input', {
    type: 'number', inputmode: 'decimal', placeholder: 'если знаете',
    value: entry?.grams ?? '',
  });

  const numberField = (key, placeholder) => h('input', {
    type: 'number', inputmode: 'decimal', placeholder,
    value: entry?.[key] === undefined || entry?.[key] === null || entry?.[key] === '' ? '' : round(entry[key], 1),
  });

  const kcalInput = numberField('kcal', '0');
  const proteinInput = numberField('protein', '0');
  const fatInput = numberField('fat', '0');
  const carbsInput = numberField('carbs', '0');

  const commentInput = h('input', {
    type: 'text', placeholder: 'Комментарий, необязательно', value: entry?.comment || '',
    spellcheck: false,
  });

  const preview = h('div', { class: 'small muted', style: 'margin-top:10px' });

  function collect() {
    return {
      kcal: num(kcalInput.value),
      protein: num(proteinInput.value),
      fat: num(fatInput.value),
      carbs: num(carbsInput.value),
    };
  }

  function updatePreview() {
    const value = collect();
    preview.textContent = `Итого: ${round(value.kcal)} ккал · Б ${round(value.protein)} · Ж ${round(value.fat)} · У ${round(value.carbs)}`;
  }

  [kcalInput, proteinInput, fatInput, carbsInput].forEach((input) => {
    input.addEventListener('input', updatePreview);
  });

  // Запись из сохранённого продукта: числа считаются по весу и снимку значений на 100 г.
  // Снимок лежит в самой записи, поэтому правка продукта прошлые дни не меняет, а правка
  // веса пересчитывает числа заново.
  const fromProduct = Boolean(entry?.per100);
  const valueInputs = [[kcalInput, 'kcal'], [proteinInput, 'protein'],
    [fatInput, 'fat'], [carbsInput, 'carbs']];

  if (fromProduct) {
    gramsInput.addEventListener('input', () => {
      const value = forWeight(entry.per100, num(gramsInput.value));
      for (const [input, key] of valueInputs) input.value = round(value[key], 1);
      updatePreview();
    });
  }

  const productNote = fromProduct
    ? h('div', { class: 'tiny faint', style: 'margin-top:6px' },
      'Числа считаются по весу и значениям продукта на 100 г')
    : null;

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
      const payload = {
        date: targetDate,
        time: timeInput.value || nowTime(),
        name,
        grams: gramsInput.value === '' ? null : num(gramsInput.value),
        comment: commentInput.value.trim(),
        ...collect(),
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
    productNote,
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
