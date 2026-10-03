// Настройки: типы дней, расписание, исключения на даты, цель и темп, хранилище.
import { isStoragePersistent, requestPersistentStorage, usageEstimate, wipeEverything } from '../db.js';
import { saveSettings, store } from '../state.js';
import { dayTypeById, resolveDayTypeId } from '../norm.js';
import { bytesHuman, h, num, todayISO } from '../util.js';
import { toast } from './components/sheet.js';

const WEEK_KEYS = [
  ['mon', 'Понедельник'], ['tue', 'Вторник'], ['wed', 'Среда'], ['thu', 'Четверг'],
  ['fri', 'Пятница'], ['sat', 'Суббота'], ['sun', 'Воскресенье'],
];

const PACE_OPTIONS = [
  { value: 0.25, label: '0,25 кг в неделю' },
  { value: 0.5, label: '0,5 кг в неделю' },
  { value: 0.75, label: '0,75 кг в неделю' },
];

const MACRO_FIELDS = [
  ['kcal', 'Ккал'], ['protein', 'Белки'], ['fat', 'Жиры'], ['carbs', 'Углеводы'],
];

export function mount(container) {
  const dayTypesHost = h('div', {});
  const weekHost = h('div', {});
  const cycleHost = h('div', {});
  const scheduleModeRow = h('div', { class: 'chips', style: 'margin-bottom:12px' });
  const exceptionsHost = h('div', {});
  const storageHost = h('div', { class: 'small muted' });

  container.append(
    h('h1', { text: 'Настройки', style: 'margin-bottom:12px' }),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: 'Типы дней и нормы' }),
      dayTypesHost),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: 'Расписание' }),
      scheduleModeRow,
      weekHost,
      cycleHost),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: 'Исключения на даты' }),
      exceptionsHost),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: 'Цель и темп' }),
      buildGoalHost()),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: 'Хранилище' }),
      storageHost),
  );

  // --- типы дней ---

  function renderDayTypes() {
    const types = store.settings.dayTypes || [];
    dayTypesHost.replaceChildren(...types.map((type, index) => h('div', {
      style: 'padding:10px 0;border-bottom:1px solid var(--line)',
    },
    h('input', {
      type: 'text',
      value: type.name,
      onchange: (event) => patchDayType(index, { name: event.target.value.trim() || type.name }),
    }),
    h('div', { class: 'grid-4', style: 'margin-top:8px' },
      MACRO_FIELDS.map(([key, label]) => h('label', { class: 'field', style: 'margin:0' },
        h('span', { class: 'field-label', text: label }),
        h('input', {
          type: 'number', inputmode: 'decimal', value: type[key],
          onchange: (event) => patchDayType(index, { [key]: num(event.target.value) }),
        })))),
    )));
  }

  function patchDayType(index, patch) {
    const types = store.settings.dayTypes.map((type, i) => (i === index ? { ...type, ...patch } : type));
    saveSettings({ dayTypes: types });
    renderDynamic();
  }

  // --- расписание ---

  function renderSchedule() {
    const { schedule } = store.settings;
    const isCycle = schedule.mode === 'cycle';

    scheduleModeRow.replaceChildren(...[
      ['week', 'По дням недели'],
      ['cycle', 'По циклу'],
    ].map(([mode, label]) => h('button', {
      type: 'button', text: label,
      'aria-pressed': String(schedule.mode === mode),
      onclick: () => {
        saveSettings({ schedule: { ...store.settings.schedule, mode } });
        renderDynamic();
      },
    })));

    weekHost.hidden = isCycle;
    cycleHost.hidden = !isCycle;

    if (!isCycle) {
      weekHost.replaceChildren(...WEEK_KEYS.map(([key, label]) => h('label', {
        class: 'row-between', style: 'padding:7px 0',
      },
      h('span', { class: 'small', text: label }),
      h('select', {
        style: 'width:auto;min-width:150px',
        onchange: (event) => {
          const week = { ...store.settings.schedule.week, [key]: event.target.value };
          saveSettings({ schedule: { ...store.settings.schedule, week } });
        },
      }, (store.settings.dayTypes || []).map((type) => h('option', {
        value: type.id, text: type.name, selected: store.settings.schedule.week[key] === type.id,
      }))))));
    } else {
      const { length = 2, trainPositions = [], startDate } = schedule.cycle || {};
      const positions = Array.from({ length }, (_, i) => i + 1);

      cycleHost.replaceChildren(
        h('label', { class: 'field' },
          h('span', { class: 'field-label', text: 'Длина цикла, дней' }),
          h('input', {
            type: 'number', min: '2', max: '14', value: length,
            onchange: (event) => {
              const nextLength = Math.max(2, Math.min(14, num(event.target.value, length)));
              const allowed = trainPositions.filter((position) => position <= nextLength);
              saveSettings({
                schedule: {
                  ...store.settings.schedule,
                  cycle: { ...store.settings.schedule.cycle, length: nextLength, trainPositions: allowed },
                },
              });
              renderDynamic();
            },
          })),
        h('div', { class: 'field' },
          h('span', { class: 'field-label', text: 'В какие дни цикла тренировка' }),
          h('div', { class: 'chips' }, positions.map((position) => h('button', {
            type: 'button', text: String(position),
            class: 'btn btn-small',
            'aria-pressed': String(trainPositions.includes(position)),
            style: trainPositions.includes(position) ? 'border-color:var(--accent);font-weight:600' : '',
            onclick: () => {
              const next = trainPositions.includes(position)
                ? trainPositions.filter((item) => item !== position)
                : [...trainPositions, position].sort((a, b) => a - b);
              saveSettings({
                schedule: {
                  ...store.settings.schedule,
                  cycle: { ...store.settings.schedule.cycle, trainPositions: next },
                },
              });
              renderDynamic();
            },
          })))),
        h('label', { class: 'field' },
          h('span', { class: 'field-label', text: 'Первый день цикла' }),
          h('input', {
            type: 'date', value: startDate || todayISO(),
            onchange: (event) => saveSettings({
              schedule: {
                ...store.settings.schedule,
                cycle: { ...store.settings.schedule.cycle, startDate: event.target.value },
              },
            }),
          })),
        h('div', { class: 'tiny faint' },
          `Сегодня по расписанию: ${dayTypeById(store.settings, resolveDayTypeId(todayISO(), store.settings)).name}`),
      );
    }
  }

  // --- исключения ---

  function renderExceptions() {
    const overrides = store.settings.dateOverrides || {};
    const dates = Object.keys(overrides).sort();

    const dateInput = h('input', { type: 'date', value: todayISO() });
    const typeSelect = h('select', {}, (store.settings.dayTypes || []).map((type) => h('option', {
      value: type.id, text: type.name,
    })));

    exceptionsHost.replaceChildren(
      dates.length
        ? h('div', {}, dates.map((date) => h('div', {
          class: 'row-between', style: 'padding:7px 0;border-bottom:1px solid var(--line)',
        },
        h('span', { class: 'small' },
          `${date} — ${store.settings.dayTypes.find((type) => type.id === overrides[date])?.name || overrides[date]}`),
        h('button', {
          class: 'btn btn-small btn-ghost', type: 'button', text: 'Убрать',
          onclick: () => {
            const next = { ...store.settings.dateOverrides };
            delete next[date];
            saveSettings({ dateOverrides: next });
            renderDynamic();
          },
        }))))
        : h('div', { class: 'small faint', style: 'margin-bottom:10px' },
          'Исключений нет. Обычно они не нужны: тип дня подставляется по расписанию.'),
      h('div', { class: 'row', style: 'margin-top:10px' }, dateInput, typeSelect,
        h('button', {
          class: 'btn btn-small nowrap', type: 'button', text: 'Добавить',
          onclick: () => {
            if (!dateInput.value) return;
            saveSettings({
              dateOverrides: { ...store.settings.dateOverrides, [dateInput.value]: typeSelect.value },
            });
            renderDynamic();
          },
        })),
    );
  }

  // --- хранилище ---

  async function renderStorage() {
    const [estimate, persistent] = await Promise.all([usageEstimate(), isStoragePersistent()]);
    const parts = [];

    if (estimate) {
      parts.push(h('div', {}, `Занято: ${bytesHuman(estimate.usage)} из ${bytesHuman(estimate.quota)} доступных`));
    } else {
      parts.push(h('div', {}, 'Размер хранилища браузер не сообщает'));
    }

    parts.push(h('div', { style: 'margin-top:6px' },
      persistent === true
        ? 'Постоянное хранилище включено — браузер не удалит дневник сам.'
        : persistent === false
          ? 'Постоянное хранилище не выдано: браузер может удалить данные при нехватке места.'
          : 'Статус постоянного хранилища неизвестен.'));

    parts.push(h('div', { class: 'chips', style: 'margin-top:10px' },
      h('button', {
        class: 'btn btn-small', type: 'button', text: 'Запросить постоянное хранилище',
        onclick: async () => {
          const granted = await requestPersistentStorage();
          toast(granted ? 'Постоянное хранилище включено' : 'Браузер отказал');
          renderStorage();
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
        toast('Данные удалены');
        location.reload();
      },
    });
    parts.push(h('div', { class: 'chips', style: 'margin-top:10px' }, wipeButton));

    storageHost.replaceChildren(...parts);
  }

  // --- цель и темп ---

  function buildGoalHost() {
    return h('div', {},
    h('label', { class: 'field' },
      h('span', { class: 'field-label', text: 'Цель' }),
      h('select', {
        onchange: (event) => saveSettings({ goal: { ...store.settings.goal, mode: event.target.value } }),
      },
      [
        ['lose', 'Снизить вес'], ['maintain', 'Удержать вес'], ['gain', 'Набрать массу'],
      ].map(([value, label]) => h('option', {
        value, text: label, selected: store.settings.goal.mode === value,
      })))),
    h('div', { class: 'field' },
      h('span', { class: 'field-label', text: 'Темп' }),
      h('div', { class: 'chips' }, PACE_OPTIONS.map((option) => h('button', {
        type: 'button', class: 'btn btn-small', text: option.label,
        style: store.settings.goal.pace === option.value ? 'border-color:var(--accent);font-weight:600' : '',
        onclick: () => {
          saveSettings({ goal: { ...store.settings.goal, pace: option.value } });
          renderDynamic();
        },
      })))),
    h('div', { class: 'tiny faint' },
      'Темп понадобится, когда норму будет считать приложение. Сейчас нормы задаются руками в типах дней.'));
  }

  function renderDynamic() {
    renderDayTypes();
    renderSchedule();
    renderExceptions();
  }

  renderDynamic();
  renderStorage();

  return { destroy() {} };
}
