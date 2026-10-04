// Настройки: типы дней, расписание, исключения на даты, цель и темп, хранилище.
import { isStoragePersistent, requestPersistentStorage, usageEstimate, wipeEverything } from '../db.js';
import * as db from '../db.js';
import { availableConfigs, configById, detectAcceleration, pickDefaultConfig } from '../audio/recognize.js';
import { AVAILABLE_PROVIDERS, createProvider, describeError, readImpedance } from '../llm/index.js';
import { pickImage, prepareForApi } from '../media/image.js';
import { normsFromMeasurement, dayTypeById, resolveDayTypeId } from '../norm.js';
import { saveSettings, store } from '../state.js';
import { DEFAULT_PRICES, logUsage, makeUsageRow } from '../usage.js';
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
  const providerHost = h('div', {});
  const voiceHost = h('div', {});
  const reportHost = h('div', {});
  const pricesHost = h('div', {});
  const dayTypesHost = h('div', {});
  const weekHost = h('div', {});
  const cycleHost = h('div', {});
  const scheduleModeRow = h('div', { class: 'chips', style: 'margin-bottom:12px' });
  const exceptionsHost = h('div', {});
  const storageHost = h('div', { class: 'small muted' });

  container.append(
    h('h1', { text: 'Настройки', style: 'margin-bottom:12px' }),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: 'Провайдер анализа' }),
      providerHost),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: 'Распознавание речи' }),
      voiceHost),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: 'Нормы из отчёта' }),
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
    h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: 'Цены провайдера' }),
      pricesHost),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: 'Хранилище' }),
      storageHost),
    buildVersionLine(),
  );

  // --- версия сборки ---

  /**
   * Показывает, какая сборка сейчас работает. Файл версии читаем в обход кэша,
   * иначе service worker отдаст старую строку и смысл проверки потеряется.
   */
  function buildVersionLine() {
    const line = h('p', { class: 'tiny faint center' },
      'версия приложения: определяем… (строка обновляется при каждой сборке)');

    // Установленное приложение обновляется само при перезапуске, но своей кнопки
    // обновления у него нет — браузер её не показывает. Эта кнопка проверяет
    // обновление и перезагружает страницу, чтобы новая сборка подхватилась сразу.
    const refresh = h('button', {
      class: 'btn btn-small', type: 'button', text: 'Обновить приложение',
      onclick: async () => {
        toast('Проверяем обновление…');
        try {
          const registration = await navigator.serviceWorker?.getRegistration?.();
          if (registration) await registration.update();
        } catch {
          // Даже если проверка не удалась, перезагрузка полезна: она берёт
          // файлы из сети, если они там новее.
        }
        setTimeout(() => location.reload(), 400);
      },
    });

    fetch('./version.txt', { cache: 'no-store' })
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error('нет файла версии'))))
      .then((text) => {
        const [version, builtLine] = String(text).trim().split('\n');
        const built = builtLine?.replace(/^собрано /, '');
        let when = '';
        if (built) {
          const date = new Date(built);
          if (!Number.isNaN(date.getTime())) {
            when = ` · сборка ${date.toLocaleString('ru-RU', {
              day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
            })}`;
          }
        }
        line.textContent = `версия приложения: ${version}${when}`;
      })
      .catch(() => {
        line.textContent = 'версия приложения: сборка для разработки';
      });

    return h('div', {},
      line,
      h('div', { class: 'chips', style: 'justify-content:center;margin-top:6px' }, refresh),
      h('p', { class: 'tiny faint center', style: 'margin-top:6px' },
        'Приложение обновляется само, когда вы закрываете и открываете иконку. '
        + 'Эта кнопка проверяет обновление вручную и перезагружает приложение.'));
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
      + 'ни в публикацию приложения. Проверка ключа бесплатна — она спрашивает только баланс.'));

    providerHost.replaceChildren(...nodes);
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

  // --- распознавание речи ---

  let voiceAcceleration = null;
  let voiceCheckFailed = false;

  function renderVoice() {
    const chosen = store.settings.voice?.config || '';
    const offered = voiceAcceleration ? availableConfigs(voiceAcceleration) : [];
    const chosenConfig = chosen ? configById(chosen) : null;
    const chosenOffered = Boolean(chosenConfig) && offered.some((item) => item.id === chosen);
    const effective = chosenOffered ? chosenConfig : (voiceAcceleration ? pickDefaultConfig(voiceAcceleration) : null);

    const nodes = [];

    if (!voiceAcceleration) {
      nodes.push(h('p', { class: 'small muted' }, voiceCheckFailed
        ? 'Не удалось проверить, умеет ли телефон считать на видеокарте. Считаем, что не умеет.'
        : 'Проверяем, умеет ли телефон считать на видеокарте…'));
    } else {
      nodes.push(h('p', { class: 'small muted' }, voiceAcceleration.webgpu
        ? `Толкать расчёт на видеокарту можно${voiceAcceleration.adapter ? ` (${voiceAcceleration.adapter})` : ''}: такие сборки считают в разы быстрее.`
        : `Видеокарту для расчёта телефон не даёт — ${voiceAcceleration.reason}. Сборки с ускорением здесь не предлагаются.`));
    }

    if (voiceAcceleration) {
      const choices = [
        { id: '', label: 'Автоматически', note: `по возможностям устройства — сейчас это «${effective?.label || 'средняя'}»` },
        ...offered,
      ];
      nodes.push(h('div', { class: 'choice' }, choices.map((option) => h('button', {
        class: 'btn', type: 'button',
        'aria-pressed': String((option.id || '') === (chosenOffered ? chosen : '')),
        onclick: async () => {
          await saveSettings({ voice: { ...store.settings.voice, config: option.id } });
          renderVoice();
        },
      },
      h('div', { style: 'font-weight:600' }, option.label),
      h('div', { class: 'tiny faint', style: 'margin-top:2px' }, option.note)))));
    }

    if (chosenConfig && !chosenOffered) {
      nodes.push(h('p', { class: 'small', style: 'margin-top:10px;color:var(--over)' },
        `Выбранная сборка «${chosenConfig.label}» на этом устройстве не заработает: `
        + 'распознавание возьмёт автоматическую.'));
    }

    nodes.push(h('p', { class: 'tiny faint', style: 'margin-top:12px' },
      'Речь распознаётся на телефоне, наружу уходит только текст. Вес указан измеренный: '
      + 'столько скачает телефон при первом распознавании. Дальше модель остаётся в памяти, '
      + 'и повторная загрузка занимает меньше секунды.'));

    voiceHost.replaceChildren(...nodes);
  }

  // Проверка ускорения — асинхронная: пока она идёт, раздел показывает «проверяем…».
  detectAcceleration()
    .then((result) => { voiceAcceleration = result; })
    .catch(() => { voiceCheckFailed = true; })
    .finally(renderVoice);

  // --- нормы из отчёта биоимпеданса ---

  let reportBusy = false;
  let reportMeasurements = null;
  let reportNorms = null;
  let reportError = null;
  let reportFile = null;
  let reportPreviewUrl = null;
  // По умолчанию срезаем только шапку с именем: у отчётов этого вида она занимает
  // около пятой части сверху, а таблица измерений начинается сразу под ней.
  let cropFraction = 0.16;

  function releasePreview() {
    if (reportPreviewUrl) URL.revokeObjectURL(reportPreviewUrl);
    reportPreviewUrl = null;
  }

  function renderReport() {
    const parts = [
      h('p', { class: 'small muted' },
        'Пришлите отчёт биоимпеданса — приложение прочитает измерения и посчитает нормы. '
        + 'Расчёт делается здесь же, на устройстве: формулы арифметические и их видно целиком.'),
    ];

    if (reportError) {
      parts.push(h('div', { class: 'card', style: 'border-color:var(--over)' },
        h('div', { class: 'small', style: 'color:var(--over)' }, reportError.title || 'Не получилось'),
        reportError.hint ? h('div', { class: 'tiny faint', style: 'margin-top:4px' }, reportError.hint) : null));
    }

    // Снимок и обрезка: затенённая часть провайдеру не уйдёт.
    if (reportFile && reportPreviewUrl) {
      parts.push(
        h('div', { style: 'position:relative;margin-top:10px;border-radius:12px;overflow:hidden' },
          h('img', { src: reportPreviewUrl, alt: 'отчёт', style: 'width:100%;display:block' }),
          h('div', {
            style: `position:absolute;left:0;right:0;top:0;height:${cropFraction * 100}%;`
              + 'background:rgba(0,0,0,.72)',
          }),
          h('div', {
            style: `position:absolute;left:0;right:0;top:${cropFraction * 100}%;height:2px;`
              + 'background:var(--accent)',
          })),
        h('label', { class: 'field', style: 'margin-top:10px' },
          h('span', { class: 'field-label', text: `Убрать сверху: ${Math.round(cropFraction * 100)}%` }),
          h('input', {
            type: 'range', min: '0', max: '50', step: '1',
            value: String(Math.round(cropFraction * 100)),
            oninput: (event) => {
              cropFraction = Number(event.target.value) / 100;
              renderReport();
            },
          })),
        h('p', { class: 'tiny faint' },
          'Затемнённая часть не уходит провайдеру. Следите, чтобы под ней осталась таблица '
          + 'с измерениями: если срезать лишнее, приложение не сможет посчитать нормы.'),
        h('div', { class: 'chips', style: 'margin-top:10px' },
          h('button', {
            class: 'btn btn-small btn-primary', type: 'button',
            text: reportBusy ? 'Читаем отчёт…' : 'Отправить отчёт',
            disabled: reportBusy,
            onclick: sendReport,
          }),
          h('button', {
            class: 'btn btn-small', type: 'button', text: 'Другой снимок',
            disabled: reportBusy,
            onclick: pickReport,
          })),
      );
    } else {
      parts.push(h('div', { class: 'chips', style: 'margin-top:12px' },
        h('button', {
          class: 'btn btn-small', type: 'button',
          text: reportBusy ? 'Читаем отчёт…' : 'Выбрать отчёт',
          disabled: reportBusy,
          onclick: pickReport,
        })));
    }

    if (reportMeasurements) {
      const m = reportMeasurements;
      const line = (label, value, unit) => (value
        ? h('div', { class: 'row-between', style: 'padding:3px 0' },
          h('span', { class: 'small muted', text: label }),
          h('span', { class: 'small mono', text: `${value} ${unit}`.trim() }))
        : null);
      parts.push(h('div', { style: 'margin-top:12px' },
        line('Дата измерения', m.date || '', ''),
        line('Вес', m.weight, 'кг'),
        line('Тощая масса', m.leanMass, 'кг'),
        line('Жировая масса', m.fatMass, 'кг'),
        line('Доля жира', m.fatPercent, '%'),
        line('Основной обмен', m.bmr, 'ккал'),
        line('Обхват талии', m.waist, 'см')));
    }

    if (reportNorms?.ok) {
      const n = reportNorms;
      parts.push(h('div', { style: 'margin-top:12px' },
        h('div', { class: 'small' }, h('b', { text: 'Посчитанные нормы' })),
        h('div', { class: 'row-between', style: 'padding:3px 0' },
          h('span', { class: 'small muted', text: 'Обычный день' }),
          h('span', { class: 'small mono', text: `${n.rest.kcal} ккал · Б${n.rest.protein} Ж${n.rest.fat} У${n.rest.carbs}` })),
        h('div', { class: 'row-between', style: 'padding:3px 0' },
          h('span', { class: 'small muted', text: 'Тренировка' }),
          h('span', { class: 'small mono', text: `${n.training.kcal} ккал · Б${n.training.protein} Ж${n.training.fat} У${n.training.carbs}` })),
        h('div', { class: 'tiny faint', style: 'margin-top:6px' },
          `Среднее по неделе ${n.weekly.kcal} ккал, ожидаемое снижение ${n.weekly.expectedLossKg} кг в неделю.`),
        h('details', { style: 'margin-top:8px' },
          h('summary', { class: 'tiny faint', style: 'cursor:pointer' }, 'Как это посчитано'),
          h('div', { class: 'tiny faint', style: 'margin-top:6px;white-space:pre-wrap' }, n.steps.join('\n'))),
        n.assumptions.length
          ? h('div', { class: 'tiny faint', style: 'margin-top:8px' },
            `Допущения: ${n.assumptions.join(' ')}`)
          : null,
        h('div', { class: 'chips', style: 'margin-top:10px' },
          h('button', {
            class: 'btn btn-small btn-primary', type: 'button',
            text: 'Применить к типам дней', onclick: applyNorms,
          }))));
    } else if (reportMeasurements) {
      parts.push(h('p', { class: 'small', style: 'margin-top:10px;color:var(--over)' },
        reportNorms?.error || 'Нормы посчитать не удалось: не хватает измерений.'));
      if (cropFraction > 0) {
        parts.push(h('p', { class: 'tiny faint' },
          'Возможно, обрезка срезала часть таблицы с весом и составом тела — уменьшите её '
          + 'и отправьте снимок снова.'));
      }
    }

    reportHost.replaceChildren(...parts);
  }

  async function pickReport() {
    if (!store.settings.provider?.key) {
      reportError = { title: 'Сначала задайте ключ провайдера', hint: 'Без ключа отчёт прочитать некому.' };
      renderReport();
      return;
    }
    const file = await pickImage();
    if (!file) return;
    releasePreview();
    reportFile = file;
    reportPreviewUrl = URL.createObjectURL(file);
    reportError = null;
    renderReport();
  }

  async function sendReport() {
    if (!reportFile) return;
    reportBusy = true;
    reportError = null;
    reportMeasurements = null;
    reportNorms = null;
    renderReport();

    try {
      // Обрезаем до отправки: имя и название клиники модели знать незачем.
      const image = await prepareForApi(reportFile, { maxSide: 1600, cropTopFraction: cropFraction });
      const adapter = createProvider({
        provider: store.settings.provider.id,
        providerKey: store.settings.provider.key,
        model: store.settings.provider.model,
      });
      const result = await readImpedance({
        provider: adapter,
        image: { base64: image.base64, mime: image.mime },
      });

      const model = store.settings.provider.model || 'deepseek-flash';
      const prices = store.settings.prices || DEFAULT_PRICES;
      for (const usage of result.usages || []) {
        await logUsage(makeUsageRow({ kind: 'impedance', model, usage, prices })).catch(() => {});
      }

      if (!result.ok) {
        reportError = result.error;
      } else {
        reportMeasurements = result.data;
        reportNorms = normsFromMeasurement({
          measurement: result.data,
          pace: store.settings.goal?.pace ?? 0.5,
        });
        await db.put('measurements', { id: result.data.date || `m-${Date.now()}`, ...result.data });
      }
    } catch (error) {
      const described = describeError(error);
      reportError = { title: described.title, hint: described.hint };
    } finally {
      reportBusy = false;
      renderReport();
    }
  }

  async function applyNorms() {
    if (!reportNorms?.ok) return;
    const types = (store.settings.dayTypes || []).map((type) => {
      if (type.id === 'rest') return { ...type, ...reportNorms.rest };
      if (type.id === 'train') return { ...type, ...reportNorms.training };
      return type;
    });
    await saveSettings({ dayTypes: types });
    toast('Нормы обновлены');
    renderDynamic();
  }

  // --- цены провайдера ---

  function renderPrices() {
    const prices = store.settings.prices || DEFAULT_PRICES;
    const model = store.settings.provider?.model || 'deepseek-flash';
    const table = { ...(prices.perModel?.[model] || DEFAULT_PRICES.perModel['deepseek-flash']) };

    const patch = (key, value) => {
      const next = {
        ...DEFAULT_PRICES,
        ...prices,
        perModel: { ...(prices.perModel || {}), [model]: { ...table, [key]: value } },
      };
      saveSettings({ prices: next });
    };

    const field = (key, label) => h('label', { class: 'field', style: 'margin:0' },
      h('span', { class: 'field-label', text: label }),
      h('input', {
        type: 'number', inputmode: 'decimal', value: table[key],
        onchange: (event) => patch(key, Number(event.target.value) || 0),
      }));

    pricesHost.replaceChildren(
      h('div', { class: 'grid-2' },
        field('inputCacheMiss', 'Вход, промах'),
        field('inputCacheHit', 'Вход, кэш')),
      h('div', { class: 'grid-2', style: 'margin-top:8px' },
        field('output', 'Выход'),
        h('label', { class: 'field', style: 'margin:0' },
          h('span', { class: 'field-label', text: 'Цены на дату' }),
          h('input', {
            type: 'date', value: prices.asOf || DEFAULT_PRICES.asOf,
            onchange: (event) => saveSettings({ prices: { ...prices, ...DEFAULT_PRICES, asOf: event.target.value } }),
          }))),
      h('p', { class: 'tiny faint', style: 'margin-top:10px' },
        'Цены за миллион токенов. Все суммы в приложении — оценка: тарифы у провайдера меняются, '
        + 'поэтому таблица редактируется и подписана датой.'),
      h('div', { class: 'chips', style: 'margin-top:8px' },
        h('button', {
          class: 'btn btn-small btn-ghost', type: 'button', text: 'Вернуть значения по умолчанию',
          onclick: () => {
            saveSettings({ prices: null });
            renderPrices();
          },
        })),
    );
  }


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
  renderProvider();
  renderVoice();
  renderReport();
  renderPrices();
  renderStorage();

  return { destroy() {} };
}
