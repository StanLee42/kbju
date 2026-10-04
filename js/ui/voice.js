// Голосовой ввод: сказать, что съел, и получить запись в дневнике.
//
// Порядок шагов намеренно такой: сначала запись, потом распознавание, потом показ расшифровки
// и только потом расчёт КБЖУ. Неудачное распознавание не теряет запись, а расшифровку можно
// поправить до того, как она станет записью в дневнике.
//
// Звук никуда не уходит: распознавание считает на устройстве, провайдеру отправляется
// только текст.
import { createRecorder } from '../audio/recorder.js';
import { isTooQuiet } from '../audio/wav.js';
import {
  availableConfigs, configById, createRecognizer, detectAcceleration, pickDefaultConfig, wasmTwinOf,
} from '../audio/recognize.js';
import { analyzeSpoken, createProvider, describeError } from '../llm/index.js';
import { addEntry, saveSettings, store } from '../state.js';
import { DEFAULT_PRICES, logUsage, makeUsageRow } from '../usage.js';
import { bytesHuman, fill, h, nowTime, round } from '../util.js';
import { openSheet, toast } from './components/sheet.js';
import { openAddSheet } from './add.js';
import { createResultCard } from './result-card.js';

/** Длиннее не нужно: фраза про еду занимает секунды, а окно модели — 30 секунд звука. */
const MAX_SECONDS = 30;

/**
 * Сколько молчания в подготовке модели считаем застоем.
 *
 * Такое уже случалось: файл модели не отдавался, новостей о ходе не было, и приложение
 * молча висело на «Готовлю модель». Человек в этот момент не знает, работает оно или нет,
 * поэтому через полминуты тишины честно говорим об этом и предлагаем другой способ ввода.
 */
const STALL_MS = 30000;

/**
 * Подготовленная модель переживает закрытие шторки.
 *
 * Подготовка — это не только скачивание: модель нужно разложить в память и собрать
 * вычислительный граф, и на телефоне без ускорения это занимает секунды. Держим её
 * готовой, чтобы вторая запись начиналась сразу. Плата — занятая память, пока открыто
 * приложение; если модель понадобится другая, прежнюю закрываем.
 */
let warm = null;

function dropWarmRecognizer() {
  warm?.recognizer.close();
  warm = null;
}

export function openVoiceSheet({ date = null } = {}) {
  const settings = store.settings || {};
  const providerConfig = settings.provider || {};
  const targetDate = date || store.date;

  const state = {
    step: 'idle', // idle | recording | recognizing | transcript | analyzing | result | error
    seconds: 0,
    duration: 0,
    recognizeSeconds: null,
    loudness: null,
    transcript: '',
    analysis: null,
    error: null,
    card: null,
    model: null,
    modelNote: '',
    acceleration: null,
    stalled: false,
  };

  let recorder = null;
  let ticker = null;
  let watchdog = null;
  let startedAt = 0;
  let levelNode = null;
  let timeNode = null;
  let statusNode = null;
  let closed = false;

  const host = h('div', {});
  const sheet = openSheet({ title: 'Еда голосом', content: host, onClose: cleanup });

  function cleanup() {
    closed = true;
    stopTicker();
    stopWatchdog();
    // Микрофон отпускаем всегда: держать его открытым между записями незачем.
    // А подготовленную модель, наоборот, оставляем — она понадобится следующей записи.
    recorder?.cancel();
    recorder = null;
  }

  function stopTicker() {
    if (ticker) clearInterval(ticker);
    ticker = null;
  }

  // --- сторож застоя в подготовке модели ---

  function stopWatchdog() {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  }

  /** Отмечает, что подготовка идёт: пока приходят новости, сторожить нечего. */
  function noteActivity() {
    stopWatchdog();
    watchdog = setTimeout(() => {
      watchdog = null;
      if (closed) return;
      state.stalled = true;
      if (state.step === 'recognizing') render();
    }, STALL_MS);
  }

  // --- запись ---

  async function startRecording() {
    state.error = null;
    try {
      recorder = await createRecorder();
    } catch (error) {
      // Самая частая причина — запрет доступа. Объясняем и предлагаем другой способ ввода.
      state.error = {
        title: 'Нет доступа к микрофону',
        hint: 'Разрешите приложению доступ к микрофону в настройках браузера '
          + 'или запишите еду вручную.',
        details: String(error?.message || error),
      };
      state.step = 'error';
      render();
      return;
    }
    recorder.start();
    startedAt = Date.now();
    state.seconds = 0;
    state.step = 'recording';
    render();
  }

  async function finishRecording() {
    if (!recorder?.isRecording) return;
    stopTicker();
    const audio = recorder.stop();
    recorder = null;
    state.duration = audio.durationSeconds;
    state.loudness = audio.loudness;
    state.step = 'recognizing';
    render();

    try {
      const text = await recognize(audio.samples);
      if (!text) {
        // Человек говорил, а модели нечего показать: это не ошибка расчёта, а повод записать снова.
        state.error = {
          title: 'Ничего не расслышали',
          hint: quietHint() || 'Попробуйте записать ещё раз — ближе к микрофону и без лишнего шума.',
          details: '',
          recordAgain: true,
        };
        state.step = 'error';
        render();
        return;
      }
      state.transcript = text;
      state.step = 'transcript';
      render();
    } catch (error) {
      state.error = error;
      state.step = 'error';
      render();
    }
  }

  /** Тихая запись объясняет и плохую расшифровку, и «ничего не расслышали». */
  function quietHint() {
    return isTooQuiet(state.loudness)
      ? 'В записи почти нет звука: кажется, микрофон ничего не услышал. '
        + 'Проверьте, что не закрыт микрофон, и скажите ближе к телефону.'
      : '';
  }

  function cancelRecording() {
    stopTicker();
    recorder?.cancel();
    recorder = null;
    state.step = 'idle';
    render();
  }

  // --- распознавание на устройстве ---

  /**
   * Готовит распознаватель.
   *
   * Модель скачивается один раз, но подготовка — это ещё и сборка вычислительного графа,
   * которая на телефоне без ускорения занимает секунды. Поэтому готовый распознаватель
   * остаётся жить между записями: вторая запись начинается сразу, без ожидания.
   */
  async function prepareRecognizer() {
    const acceleration = await detectAcceleration();
    state.acceleration = acceleration;
    const offered = availableConfigs(acceleration);
    // Модель выбирается в настройках. Если выбранной там сборки на этом устройстве
    // нет (например, включили ускорение, а видеокарта не работает) — берём среднюю.
    const stored = configById(settings.voice?.config || '');
    const config = (stored && offered.some((item) => item.id === stored.id) ? stored : null)
      || pickDefaultConfig(acceleration);
    state.model = config;

    if (warm?.configId === config.id) {
      // Эта модель уже подготовлена прошлой записью — ждать нечего.
      return warm.recognizer;
    }
    dropWarmRecognizer();

    const recognizer = createRecognizer({
      onProgress: (progress) => {
        // Строку обновляем на месте: перерисовка всего экрана на каждое сообщение
        // о готовности модели съедала бы больше, чем сама подготовка.
        noteActivity();
        if (!statusNode) return;
        statusNode.textContent = `Готовлю модель: ${progress.percent}%`
          + (progress.total ? ` (${bytesHuman(progress.loaded)} из ${bytesHuman(progress.total)})` : '');
      },
    });

    noteActivity();
    try {
      const answer = await recognizer.load(config);
      if (answer?.fallback) {
        state.modelNote = 'Ускорение видеокартой не заработало — считаю без него.';
      }
    } catch (error) {
      stopWatchdog();
      recognizer.close();
      throw error;
    }
    stopWatchdog();

    // Запоминаем именно ту сборку, которая заработала: после отката без ускорения
    // это двойник, и в следующий раз готовить нужно уже его.
    warm = { configId: recognizer.configId || config.id, recognizer };
    return recognizer;
  }

  async function recognize(samples) {
    let recognizer;
    try {
      recognizer = await prepareRecognizer();
    } catch (error) {
      throw {
        title: error?.title || 'Модель распознавания не загрузилась',
        hint: 'Проверьте интернет и попробуйте снова. Можно выбрать модель поменьше в настройках.',
        details: error?.details || String(error?.message || error || ''),
      };
    }

    try {
      const result = await recognizer.recognize(samples);
      state.recognizeSeconds = result.seconds ?? null;
      return String(result.text || '').trim();
    } catch (error) {
      // Если счёт упал, держать этот распознаватель смысла нет: следующая попытка
      // должна начинаться с чистой подготовки, а не биться в то же место.
      if (warm?.recognizer === recognizer) dropWarmRecognizer();
      throw {
        title: error?.title || 'Распознавание не получилось',
        hint: 'Попробуйте записать ещё раз — ближе к микрофону и без лишнего шума.',
        details: error?.details || '',
      };
    }
  }

  // --- расчёт КБЖУ ---

  async function analyze() {
    const text = state.transcript.trim();
    if (!text) {
      toast('Сначала скажите, что съели');
      return;
    }
    if (!providerConfig.key) {
      state.error = {
        title: 'Нет ключа провайдера',
        hint: 'Вставьте ключ в настройках — без него приложение не посчитает КБЖУ.',
        details: '',
      };
      state.step = 'error';
      render();
      return;
    }

    state.step = 'analyzing';
    state.error = null;
    render();

    const provider = createProvider({
      provider: providerConfig.id,
      providerKey: providerConfig.key,
      model: providerConfig.model,
    });
    const prices = settings.prices || DEFAULT_PRICES;
    const result = await analyzeSpoken({ provider, text });

    // Каждая попытка оплачивается, поэтому в журнал идут все, а не только удачная.
    let cost = 0;
    for (const usage of result.usages || []) {
      const row = makeUsageRow({
        kind: 'voice',
        model: providerConfig.model || 'deepseek-flash',
        usage,
        prices,
      });
      cost += row.cost;
      await logUsage(row).catch(() => {});
    }

    if (!result.ok) {
      state.error = {
        ...describeError({ kind: result.error.kind, details: { body: result.error.details } }),
        ...result.error,
      };
      state.step = 'error';
      render();
      return;
    }

    state.analysis = { ...result.data, cost };
    state.step = 'result';
    render();
  }

  async function save({ items, totals, portionNote }) {
    await addEntry({
      date: targetDate,
      time: nowTime(),
      name: state.analysis.dish,
      grams: round(totals.grams, 1),
      kcal: round(totals.kcal, 1),
      protein: round(totals.protein, 1),
      fat: round(totals.fat, 1),
      carbs: round(totals.carbs, 1),
      comment: '',
      source: 'voice',
      transcript: state.transcript.trim(),
      items,
      basis: state.analysis.basis,
      confidence: state.analysis.confidence,
      assumptions: state.analysis.assumptions,
      portionNote,
      cost: state.analysis.cost,
    });
    toast('Записано');
    sheet.close();
  }

  // --- экраны ---

  function renderIdle() {
    const keyMissing = !providerConfig.key;
    statusNode = null;
    fill(host, 
      h('p', { class: 'small muted' },
        'Скажите, что съели: «съел двести граммов куриной грудки и порцию гречки». '
        + 'Речь распознаётся на телефоне, наружу уйдёт только текст.'),
      h('div', { class: 'chips', style: 'margin-top:14px' },
        h('button', { class: 'btn-primary', type: 'button', text: '🎤 Записать', onclick: startRecording }),
        h('button', {
          class: 'btn btn-small', type: 'button', text: 'Ввести вручную',
          onclick: () => {
            sheet.close();
            openAddSheet({ date: targetDate });
          },
        })),
      h('p', { class: 'tiny faint', style: 'margin-top:12px' },
        `Запись до ${MAX_SECONDS} секунд. В первый раз модель скачается — это займёт время, `
        + 'потом она остаётся в памяти телефона.'),
      keyMissing
        ? h('p', { class: 'small', style: 'margin-top:10px;color:var(--over)' },
          'Ключ провайдера не заполнен: расшифровать получится, а посчитать КБЖУ — нет. '
          + 'Заполните ключ в настройках.')
        : null);
  }

  function renderRecording() {
    statusNode = null;
    timeNode = h('div', { class: 'timer', text: '0,0 с' });
    levelNode = h('div', { class: 'level-fill' });

    fill(host, 
      h('p', { class: 'small muted' }, 'Говорите. Когда закончите — нажмите «Готово».'),
      h('div', { class: 'rec-row' },
        h('div', { class: 'level' }, levelNode),
        timeNode),
      h('div', { class: 'chips', style: 'margin-top:16px' },
        h('button', { class: 'btn-primary', type: 'button', text: 'Готово', onclick: finishRecording }),
        h('button', { class: 'btn btn-small', type: 'button', text: 'Отменить', onclick: cancelRecording })));

    const tick = () => {
      const elapsed = (Date.now() - startedAt) / 1000;
      state.seconds = elapsed;
      if (timeNode) {
        timeNode.textContent = `${elapsed.toFixed(1).replace('.', ',')} с из ${MAX_SECONDS}`;
      }
      if (levelNode) levelNode.style.width = `${Math.round((recorder?.getLevel() || 0) * 100)}%`;
      if (elapsed >= MAX_SECONDS) finishRecording();
    };
    stopTicker();
    ticker = setInterval(tick, 100);
    tick();
  }

  function renderRecognizing() {
    const seconds = state.duration ? `${state.duration.toFixed(1).replace('.', ',')} с` : '';
    statusNode = h('p', { class: 'small muted' }, 'Готовлю распознавание…');
    fill(host, 
      h('p', { class: 'small' }, `Записано ${seconds}. Распознаю на телефоне.`),
      h('div', { class: 'rec-row' },
        h('div', { class: 'level' }, h('div', { class: 'level-fill level-wait' })),
        h('div', { class: 'timer', text: '…' })),
      statusNode,
      // Про скачивание говорим только тогда, когда его действительно предстоит:
      // подготовленная модель со второй записи уже лежит в памяти, и ждать нечего.
      warm ? null : h('p', { class: 'tiny faint' },
        `Первый раз модель скачивается${state.model?.sizeMb ? ` (${state.model.sizeMb} МБ)` : ''} `
        + 'и собирается в память — это самая долгая часть. Дальше она готова сразу.'),
      state.stalled
        ? h('p', { class: 'small', style: 'margin-top:8px;color:var(--over)' },
          'Модель не загружается: новостей нет уже полминуты. Проверьте интернет — '
          + 'или введите запись вручную, распознавание подождёт.')
        : null,
      state.stalled
        ? h('div', { class: 'chips', style: 'margin-top:10px' },
          h('button', {
            class: 'btn', type: 'button', text: 'Ввести вручную',
            onclick: () => {
              sheet.close();
              openAddSheet({ date: targetDate });
            },
          }))
        : null,
      state.modelNote ? h('p', { class: 'tiny faint' }, state.modelNote) : null,
      h('p', { class: 'tiny faint', style: 'margin-top:10px' },
        'Звук остаётся на устройстве: считается на телефоне, наружу уходит только текст.'));
  }

  function renderTranscript() {
    statusNode = null;
    const input = h('textarea', {
      class: 'transcript', rows: 3, value: state.transcript,
      oninput: (event) => { state.transcript = event.target.value; },
    });

    // Показываем, чем именно считали и сколько это заняло: по этим числам видно,
    // стоит ли брать модель поменьше, и понятно, почему пришлось подождать.
    // Название видеокарты здесь же: по нему видно, настоящая она или программная.
    const facts = [
      state.model ? state.model.label.toLowerCase() : null,
      state.acceleration?.adapter ? `видеокарта: ${state.acceleration.adapter}` : 'без видеокарты',
      state.recognizeSeconds !== null && state.duration
        ? `${state.recognizeSeconds.toFixed(1).replace('.', ',')} с на ${state.duration.toFixed(1).replace('.', ',')} с записи`
        : null,
    ].filter(Boolean).join(' · ');

    // Долгий счёт — повод предложить выход, а не молча ждать столько же в следующий раз.
    const slow = (state.recognizeSeconds || 0) > 30;
    const twin = slow ? wasmTwinOf(state.model) : null;
    const quiet = isTooQuiet(state.loudness);

    fill(host,
      h('p', { class: 'small muted' }, 'Вот что расслышали. Поправьте, если что-то не так, — '
        + 'дальше считаются именно эти слова.'),
      input,
      facts ? h('p', { class: 'tiny faint', style: 'margin-top:6px' }, facts) : null,
      quiet
        ? h('p', { class: 'small', style: 'margin-top:6px;color:var(--over)' }, quietHint())
        : null,
      slow
        ? h('p', { class: 'small', style: 'margin-top:8px;color:var(--over)' },
          `Считалось ${Math.round(state.recognizeSeconds)} с — это слишком долго для одной фразы. `
          + (twin
            ? 'Похоже, видеокарта на телефоне не помогает. Можно перейти на ту же модель без неё и сравнить.'
            : 'В настройках можно взять модель поменьше — она узнаёт чуть хуже, зато считает быстрее.'))
        : null,
      slow && twin
        ? h('div', { class: 'chips', style: 'margin-top:10px' },
          h('button', {
            class: 'btn btn-small', type: 'button',
            text: `Взять «${twin.label}»`,
            onclick: async () => {
              await saveSettings({ voice: { ...store.settings.voice, config: twin.id } });
              dropWarmRecognizer();
              state.modelNote = `Теперь считается сборкой «${twin.label}». `
                + 'Запишите ту же фразу и сравните время — оно будет ниже в этом же месте.';
              startRecording();
            },
          }))
        : null,
      state.modelNote ? h('p', { class: 'tiny faint' }, state.modelNote) : null,
      h('div', { class: 'chips', style: 'margin-top:14px' },
        h('button', { class: 'btn-primary', type: 'button', text: 'Посчитать КБЖУ', onclick: analyze }),
        h('button', { class: 'btn btn-small', type: 'button', text: 'Записать снова', onclick: startRecording })),
      h('p', { class: 'tiny faint', style: 'margin-top:10px' },
        'Расшифровка сделана на телефоне, запись голоса никуда не отправлялась.'));
  }

  function renderAnalyzing() {
    statusNode = null;
    fill(host, 
      h('p', { class: 'small' }, 'Считаю КБЖУ по сказанному…'),
      h('p', { class: 'tiny faint', style: 'margin-top:8px' },
        `«${state.transcript.trim()}»`),
      h('p', { class: 'tiny faint', style: 'margin-top:10px' },
        'Модель получает только текст — ни звука, ни снимка она не видит.'));
  }

  function renderResult() {
    statusNode = null;
    if (!state.card) {
      state.card = createResultCard({
        analysis: state.analysis,
        items: state.analysis.items,
        origin: 'voice',
        head: h('div', { class: 'small', style: 'margin-bottom:12px' },
          h('div', { class: 'field-label', text: 'Сказано' }),
          h('div', {}, `«${state.transcript.trim()}»`)),
        retryLabel: 'Сказать снова',
        onRetry: () => {
          state.card = null;
          state.analysis = null;
          state.transcript = '';
          startRecording();
        },
        onSave: save,
      });
    }
    fill(host, state.card.element);
  }

  function renderError() {
    statusNode = null;
    const error = state.error || { title: 'Не получилось', hint: '', details: '' };
    fill(host, 
      h('div', { class: 'card', style: 'border-color:var(--over)' },
        h('h3', { class: 'card-title', style: 'color:var(--over)' }, error.title),
        error.hint ? h('p', { class: 'small muted' }, error.hint) : null,
        error.details
          ? h('pre', { class: 'tiny faint', style: 'white-space:pre-wrap;margin-top:8px' }, String(error.details))
          : null),
      h('div', { class: 'chips' },
        h('button', {
          class: 'btn-primary', type: 'button',
          // Если беда в самой записи (ничего не расслышали), логичнее сразу записать снова.
          text: error.recordAgain ? '🎤 Записать снова' : 'Попробовать снова',
          onclick: () => {
            const recordAgain = Boolean(error.recordAgain);
            state.error = null;
            state.card = null;
            state.analysis = null;
            if (recordAgain) {
              startRecording();
              return;
            }
            state.step = 'idle';
            render();
          },
        }),
        h('button', {
          class: 'btn btn-small', type: 'button', text: 'Ввести вручную',
          onclick: () => {
            sheet.close();
            openAddSheet({ date: targetDate });
          },
        })));
  }

  function render() {
    // Распознавание может закончиться уже после закрытия шторки: рисовать тогда некуда.
    if (closed) return;
    if (state.step === 'recording') { renderRecording(); return; }
    if (state.step === 'recognizing') { renderRecognizing(); return; }
    if (state.step === 'transcript') { renderTranscript(); return; }
    if (state.step === 'analyzing') { renderAnalyzing(); return; }
    if (state.step === 'result') { renderResult(); return; }
    if (state.step === 'error') { renderError(); return; }
    renderIdle();
  }

  render();
  return sheet;
}
