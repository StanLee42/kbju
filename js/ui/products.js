// Шторка сохранённых продуктов: список с КБЖУ на 100 г, поиск и порядок,
// добавление, правка и удаление. Список ничего не считает у модели и токенов
// не тратит: запись в дневник по весу приходит сюда готовым обработчиком.
import { fill, h, nowTime, num, round } from '../util.js';
import {
  ORDERS, forWeight, itemFromProduct, listProducts, matchByName, nameProblem, orderProducts,
  per100Line, removeProduct, saveProduct, searchProducts, touchProduct,
} from '../products.js';
import { addEntryFromProduct, store } from '../state.js';
import { openSheet, toast } from './components/sheet.js';
import { openProductPhoto } from './product-photo.js';

const VALUE_KEYS = ['kcal', 'protein', 'fat', 'carbs'];

export async function openProductsSheet({ title = 'Мои продукты', date = null, onPick = null } = {}) {
  const targetDate = date || store.date;
  let products = await listProducts();
  let query = '';
  let order = 'frequency';
  let sheet = null;

  const open = ({ title: sheetTitle, content, actions }) => {
    sheet = openSheet({ title: sheetTitle, content, actions });
    return sheet;
  };

  const reload = async () => { products = await listProducts(); };

  function showList() {
    const searchInput = h('input', {
      type: 'search', placeholder: 'Поиск по названию', value: query, spellcheck: false,
    });
    const rows = h('div', { class: 'product-list' });

    function renderRows() {
      const items = orderProducts(searchProducts(products, query), order);
      if (!items.length) {
        fill(rows, h('div', { class: 'empty' },
          query.trim() ? 'Ничего не нашлось.' : 'Список пуст. Добавьте первый продукт.'));
        return;
      }
      fill(rows, items.map((product) => h('div', { class: 'product-row' },
        h('button', {
          class: 'product-main', type: 'button',
          onclick: () => showWeightForm(product),
        },
        h('span', { class: 'product-name', text: product.name }),
        h('span', { class: 'product-values', text: per100Line(product.per100) })),
        h('button', {
          class: 'btn btn-small btn-ghost', type: 'button', text: 'Изменить',
          onclick: () => showForm(product),
        }))));
    }

    searchInput.addEventListener('input', () => {
      query = searchInput.value;
      renderRows();
    });

    const orderButtons = ORDERS.map((choice) => h('button', {
      class: 'badge badge-option', type: 'button', text: choice.label,
      onclick: () => {
        order = choice.id;
        orderButtons.forEach((button) => {
          button.setAttribute('aria-pressed', String(button.dataset.order === order));
        });
        renderRows();
      },
    }));
    orderButtons.forEach((button, index) => {
      button.dataset.order = ORDERS[index].id;
      button.setAttribute('aria-pressed', String(ORDERS[index].id === order));
    });

    renderRows();

    return open({
      title,
      content: h('div', {},
        h('div', { class: 'chips', style: 'margin-bottom:10px' }, orderButtons),
        h('label', { class: 'field field-compact' }, searchInput),
        rows),
      actions: [
        h('button', {
          class: 'btn-primary', type: 'button', text: 'Добавить продукт',
          onclick: () => showForm(null),
        }),
        // Второй способ завести продукт: разбор снимка упаковки. Ручной ввод остаётся
        // для того, чего на снимке нет.
        h('button', {
          class: 'btn btn-small', type: 'button', text: 'Снимок упаковки',
          onclick: () => openProductPhoto({
            // Разбор закрылся: список показывается заново, и в нём уже новый продукт.
            onSaved: async () => {
              await reload();
              showList();
            },
          }),
        }),
      ],
    });
  }

  function showForm(product = null) {
    const isEdit = Boolean(product);

    const nameInput = h('input', {
      type: 'text', placeholder: 'Например: творог 5%', value: product?.name || '',
      autocapitalize: 'sentences',
      // Проверку орфографии выключаем по той же причине, что и в ручном вводе:
      // русского словаря у Chrome нет, а его меню закрывает клавиатуру.
      spellcheck: false,
    });

    const numberField = (key, placeholder) => h('input', {
      type: 'number', inputmode: 'decimal', placeholder,
      value: product?.per100?.[key] === undefined ? '' : round(product.per100[key], 1),
    });
    const inputs = { kcal: numberField('kcal', '0'), protein: numberField('protein', '0'), fat: numberField('fat', '0'), carbs: numberField('carbs', '0') };

    const hints = h('div', { class: 'hint-list' });

    /** Подсказка при вводе: сохранённые продукты, название которых начато так же. */
    function renderHints() {
      const found = matchByName(products, nameInput.value)
        .filter((item) => item.id !== product?.id);
      fill(hints, found.map((item) => h('button', {
        class: 'hint', type: 'button',
        onclick: () => {
          nameInput.value = item.name;
          for (const key of VALUE_KEYS) inputs[key].value = round(item.per100?.[key] ?? 0, 1);
          fill(hints);
        },
      },
      h('span', { text: item.name }),
      h('span', { class: 'tiny faint', text: `${round(item.per100?.kcal ?? 0, 1)} ккал на 100 г` }))));
    }

    nameInput.addEventListener('input', renderHints);

    const saveButton = h('button', {
      class: 'btn-primary', type: 'button', text: isEdit ? 'Сохранить продукт' : 'Добавить продукт',
      onclick: async () => {
        const name = nameInput.value.trim();
        const problem = nameProblem(name);
        if (problem) {
          nameInput.focus();
          toast(problem);
          return;
        }

        const per100 = {};
        for (const key of VALUE_KEYS) per100[key] = num(inputs[key].value);

        try {
          await saveProduct({ id: product?.id, name, per100 });
        } catch (error) {
          toast(error.message);
          return;
        }
        await reload();
        toast(isEdit ? 'Продукт обновлён' : `${name} в списке`);
        showList();
      },
    });

    const actions = [
      saveButton,
      h('button', {
        class: 'btn btn-small btn-ghost', type: 'button', text: 'Назад',
        onclick: () => showList(),
      }),
    ];

    if (isEdit) {
      let armed = false;
      const deleteButton = h('button', {
        class: 'btn btn-small btn-danger', type: 'button', text: 'Удалить продукт',
        onclick: async () => {
          if (!armed) {
            armed = true;
            deleteButton.textContent = 'Нажмите ещё раз, чтобы удалить';
            return;
          }
          await removeProduct(product.id);
          await reload();
          toast('Продукт удалён');
          showList();
        },
      });
      actions.push(deleteButton);
    }

    return open({
      title: isEdit ? 'Правка продукта' : 'Новый продукт',
      content: h('div', {},
        h('label', { class: 'field' },
          h('span', { class: 'field-label', text: 'Название' }), nameInput),
        hints,
        h('div', { class: 'tiny faint', style: 'margin:10px 0 6px' }, 'Значения указываются на 100 г'),
        h('div', { class: 'grid-4' },
          h('label', { class: 'field field-compact' },
            h('span', { class: 'field-label', text: 'Ккал' }), inputs.kcal),
          h('label', { class: 'field field-compact' },
            h('span', { class: 'field-label', text: 'Б' }), inputs.protein),
          h('label', { class: 'field field-compact' },
            h('span', { class: 'field-label', text: 'Ж' }), inputs.fat),
          h('label', { class: 'field field-compact' },
            h('span', { class: 'field-label', text: 'У' }), inputs.carbs))),
      actions,
    });
  }

  /** Запись выбранного продукта: вес обязателен, числа считаются по весу. */
  function showWeightForm(product) {
    const gramsInput = h('input', {
      type: 'number', inputmode: 'decimal', placeholder: 'например 150',
    });
    const preview = h('div', { class: 'small muted', style: 'margin-top:10px' });

    function updatePreview() {
      const grams = num(gramsInput.value);
      if (!(grams > 0)) {
        preview.textContent = 'Введите вес порции';
        return;
      }
      const value = forWeight(product.per100, grams);
      preview.textContent = `Выйдет: ${round(value.kcal, 1)} ккал · Б ${round(value.protein, 1)}`
        + ` · Ж ${round(value.fat, 1)} · У ${round(value.carbs, 1)}`;
    }

    gramsInput.addEventListener('input', updatePreview);

    const weight = () => {
      const grams = num(gramsInput.value);
      if (!(grams > 0)) {
        gramsInput.focus();
        toast('Введите вес порции');
        return null;
      }
      return grams;
    };

    const actions = [h('button', {
      class: 'btn-primary', type: 'button', text: 'В дневник',
      onclick: async () => {
        const grams = weight();
        if (!grams) return;
        await addEntryFromProduct({ product, grams, date: targetDate, time: nowTime() });
        await touchProduct(product.id);
        await reload();
        toast(`${product.name}: записано ${round(grams)} г`);
        sheet.close();
      },
    })];

    if (onPick) {
      actions.push(h('button', {
        class: 'btn btn-small', type: 'button', text: 'В разбор',
        onclick: () => {
          const grams = weight();
          if (grams) onPick(itemFromProduct(product, grams));
        },
      }));
    }

    actions.push(h('button', {
      class: 'btn btn-small btn-ghost', type: 'button', text: 'Назад',
      onclick: () => showList(),
    }));

    updatePreview();

    return open({
      title: product.name,
      content: h('div', {},
        h('div', { class: 'small faint' }, per100Line(product.per100)),
        h('label', { class: 'field', style: 'margin-top:10px' },
          h('span', { class: 'field-label', text: 'Вес порции, г' }), gramsInput),
        preview,
        h('div', { class: 'tiny faint', style: 'margin-top:10px' },
          `Запись пойдёт в день ${targetDate}. Модель при этом не вызывается.`)),
      actions,
    });
  }

  return showList();
}
