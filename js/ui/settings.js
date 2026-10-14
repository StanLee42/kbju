// Настройки: провайдер, нормы, типы дней, расписание, исключения на даты, цель и темп.
//
// Расход, хранилище и цены провайдера отсюда убраны: расход и хранилище открываются
// из раздела «Ещё», а цены живут на экране расхода. Здесь остаётся то, что влияет
// на расчёты и на поведение приложения.
import { AVAILABLE_PROVIDERS, createProvider, describeError } from '../llm/index.js';
import { dayTypeById, kcalFromMacros, macrosForKcal, resolveDayTypeId } from '../norm.js';
import { saveSettings, store } from '../state.js';
import { fill, h, num, round, todayISO } from '../util.js';
import { BUILD_VERSION } from '../version.js';
import { serverVersion, updateAndReload } from '../update.js';
import { toast } from './components/sheet.js';
import { openNormsChat } from './norms-chat.js';

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
  const providerHost = h('div', {});
  const reportHost = h('div', {});
  const dayTypesHost = h('div', {});
  const weekHost = h('div', {});
  const cycleHost = h('div', {});
  const scheduleModeRow = h('div', { class: 'chips', style: 'margin-bottom:12px' });
  const exceptionsHost = h('div', {});

  container.append(
    h('h1', { text: 'Настройки', style: 'margin-bottom:12px' }),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: 'Провайдер анализа' }),
      providerHost),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: 'Нормы и калории' }),
      reportHost),
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
    buildVersionLine(),
  );

  // --- версия сборки ---

  /**
   * Показывает, какая сборка работает сейчас и какая лежит на сервере.
   *
   * Работающую сборку берём из самого кода: служба может быть уже новой, а страница
   * прежней, и тогда верить ей нельзя. На этом владелец дважды попал: строка показывала
   * новую версию, а кнопки и функции были из старой.
   */
  function buildVersionLine() {
    const line = h('p', { class: 'tiny faint center' }, `работает сборка: ${BUILD_VERSION}`);
    const hint = h('p', { class: 'tiny faint center', style: 'margin-top:6px' },
      'Когда приходит новая сборка, приложение перезагружается само, и при запуске, '
      + 'и когда вы возвращаетесь к нему. Кнопка нужна, если этого не случилось.');

    // Своей кнопки обновления у установленного приложения нет: браузер её не показывает.
    const refresh = h('button', {
      class: 'btn btn-small', type: 'button', text: 'Обновить приложение',
      onclick: async () => {
        toast('Проверяем обновление…');
        // Перезагружаемся после того, как новая служба возьмёт управление: иначе
        // страницу снова отдаст старая из своего кэша, и обновление не случится.
        await updateAndReload();
      },
    });

    serverVersion().then((server) => {
      if (!server || server === BUILD_VERSION) return;
      line.textContent = `работает сборка: ${BUILD_VERSION} · на сервере новее: ${server}`;
      line.style.color = 'var(--over)';
      hint.textContent = 'На сервере лежит другая сборка. Нажмите «Обновить приложение»: '
        + 'новая подхватится сразу; если не помогло, нажмите ещё раз.';
    });

    return h('div', {},
      line,
      h('div', { class: 'chips', style: 'justify-content:center;margin-top:6px' }, refresh),
      hint);
  }

  /** Сборка, которая лежит на сервере: файл читаем в обход кэша. */
  async function serverVersion() {
    try {
      const response = await fetch('./version.txt', { cache: 'no-store' });
      if (!response.ok) return null;
      const [version] = String(await response.text()).trim().split('\n');
      return version || null;
    } catch {
      return null;
    }
  }

  let keyCheck = null;
  let keyBusy = false;

  function renderProvider() {
    const provider = store.settings.provider || {};
    const keyInput = h('input', {
      type: 'password',
      placeholder: 'sk-...',
      value: provider.key || '',
      autocapitalize: 'off',
      onchange: (event) => {
        saveSettings({ provider: { ...store.settings.provider, key: event.target.value.trim() } });
        keyCheck = null;
        renderProvider();
      },
    });
    const modelInput = h('input', {
      type: 'text',
      value: provider.model || 'deepseek-flash',
      onchange: (event) => saveSettings({
        provider: { ...store.settings.provider, model: event.target.value.trim() || 'deepseek-flash' },
      }),
    });

    const providerSelect = h('select', {
      onchange: (event) => saveSettings({
        provider: { ...store.settings.provider, id: event.target.value, key: '' },
      }),
    }, AVAILABLE_PROVIDERS.map((id) => h('option', {
      value: id, text: id === 'deepseek' ? 'DeepSeek' : id, selected: (provider.id || 'deepseek') === id,
    })));

    // Внимание: replaceChildren превращает null в текстовый узел «null»,
    // поэтому пустые элементы отсеиваем заранее.
    const nodes = [];

    if (AVAILABLE_PROVIDERS.length > 1) {
      nodes.push(h('label', { class: 'field' },
        h('span', { class: 'field-label', text: 'Провайдер' }),
        providerSelect));
    }

    nodes.push(
      h('label', { class: 'field' },
        h('span', { class: 'field-label', text: 'Ключ' }),
        keyInput),
      h('label', { class: 'field' },
        h('span', { class: 'field-label', text: 'Модель' }),
        modelInput),
      h('div', { class: 'chips' },
        h('button', {
          class: 'btn btn-small', type: 'button',
          text: keyBusy ? 'Проверяем…' : 'Проверить ключ',
          disabled: keyBusy,
          onclick: checkKey,
        })),
    );

    if (keyCheck) {
      nodes.push(h('p', {
        class: 'small', style: `margin-top:10px;${keyCheck.ok ? '' : 'color:var(--over)'}`,
      }, keyCheck.text));
    }

    nodes.push(h('p', { class: 'tiny faint', style: 'margin-top:10px' },
      'Ключ хранится только на устройстве: он не попадает ни в выгрузку дневника, '
      + 'ни в публикацию приложения. Проверка ключа бесплатна: она спрашивает только баланс.'));

    fill(providerHost, ...nodes);
  }

  async function checkKey() {
    keyBusy = true;
    renderProvider();
    try {
      const adapter = createProvider({
        provider: store.settings.provider.id,
        providerKey: store.settings.provider.key,
        model: store.settings.provider.model,
      });
      const balance = await adapter.balance();
      keyCheck = balance
        ? { ok: true, text: `Ключ работает. На счету ${balance.total.toFixed(2)} ${balance.currency}.` }
        : { ok: true, text: 'Ключ принят, но провайдер не сообщил баланс.' };
    } catch (error) {
      const described = describeError(error);
      keyCheck = { ok: false, text: `${described.title}. ${described.hint}` };
    } finally {
      keyBusy = false;
      renderProvider();
    }
  }

  // --- нормы: разговор об этом живёт в отдельном окне ---

  function renderReport() {
    fill(reportHost,
      h('p', { class: 'small muted' },
        'Нормы калорий и БЖУ обсуждаются разговором: пришлите снимок отчёта биоимпеданса '
        + 'или просто напишите словами: «тренер считает, что завышено», «хочу минус триста». '
        + 'Числа считает приложение и показывает расчёт по шагам, чтобы видеть, что именно '
        + 'сдвинулось, а решение остаётся за вами.'),
      h('div', { class: 'chips', style: 'margin-top:12px' },
        h('button', {
          class: 'btn btn-primary', type: 'button', text: 'Обсудить нормы',
          onclick: () => openNormsChat(),
        })),
      h('p', { class: 'tiny faint', style: 'margin-top:10px' },
        'Править нормы руками тоже можно, в разделе «Типы дней и нормы». Если менять калории '
        + 'дня, белки, жиры и углеводы пересчитаются в той же пропорции.'));
  }

  // --- типы дней ---

  function renderDayTypes() {
    const types = store.settings.dayTypes || [];
    fill(dayTypesHost, ...types.map((type, index) => h('div', {
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

    fill(scheduleModeRow, ...[
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
      fill(weekHost, ...WEEK_KEYS.map(([key, label]) => h('label', {
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

      fill(cycleHost, 
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

    fill(exceptionsHost, 
      dates.length
        ? h('div', {}, dates.map((date) => h('div', {
          class: 'row-between', style: 'padding:7px 0;border-bottom:1px solid var(--line)',
        },
        h('span', { class: 'small' },
          `${date}: ${store.settings.dayTypes.find((type) => type.id === overrides[date])?.name || overrides[date]}`),
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

  // --- типы дней ---

  function renderDayTypes() {
    const types = store.settings.dayTypes || [];
    fill(dayTypesHost, ...types.map((type, index) => h('div', {
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
          // Калории и БЖУ правятся вместе: иначе числа разъезжаются, и день врёт.
          onchange: (event) => patchDayTypeLinked(index, key, event.target.value),
        })))),
    h('div', { class: 'tiny faint', style: 'margin-top:6px' },
      `белки, жиры и углеводы дают ${round(kcalFromMacros(type))} ккал`
      + (Math.abs(kcalFromMacros(type) - num(type.kcal)) < 1 ? ': сходится с планом' : '')),
    )));
  }

  /**
   * Правка дня целиком: меняете калории, БЖУ пересчитываются в той же пропорции,
   * меняете макрос: калории пересчитываются по нему. Так план дня остаётся согласованным.
   */
  function patchDayTypeLinked(index, key, rawValue) {
    const type = store.settings.dayTypes[index];
    const macros = { protein: type.protein, fat: type.fat, carbs: type.carbs };
    if (key === 'kcal') {
      patchDayType(index, { kcal: num(rawValue), ...macrosForKcal(macros, num(rawValue)) });
      return;
    }
    const updated = { ...macros, [key]: num(rawValue) };
    patchDayType(index, { ...updated, kcal: round(kcalFromMacros(updated)) });
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

    fill(scheduleModeRow, ...[
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
      fill(weekHost, ...WEEK_KEYS.map(([key, label]) => h('label', {
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

      fill(cycleHost, 
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

    fill(exceptionsHost, 
      dates.length
        ? h('div', {}, dates.map((date) => h('div', {
          class: 'row-between', style: 'padding:7px 0;border-bottom:1px solid var(--line)',
        },
        h('span', { class: 'small' },
          `${date}: ${store.settings.dayTypes.find((type) => type.id === overrides[date])?.name || overrides[date]}`),
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
  renderProvider();
  renderReport();

  return { destroy() {} };
}
