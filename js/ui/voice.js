// Голосовой ввод: сказать, что съел, и получить запись в дневнике.
//
// Порядок шагов намеренно такой: сначала запись, потом распознавание, потом показ расшифровки
// и только потом расчёт КБЖУ. Неудачное распознавание не теряет запись, а расшифровку можно
// поправить до того, как она станет записью в дневнике.
//
// Звук никуда не уходит: распознавание считает на устройстве, провайдеру отправляется
// только текст.
import { createRecorder } from '../audio/recorder.js';
import {
  availableConfigs, configById, createRecognizer, detectAcceleration, pickDefaultConfig,
} from '../audio/recognize.js';
import { analyzeSpoken, createProvider, describeError } from '../llm/index.js';
import { addEntry, store } from '../state.js';
import { DEFAULT_PRICES, logUsage, makeUsageRow } from '../usage.js';
import { bytesHuman, h, nowTime, round } from '../util.js';
import { openSheet, toast } from './components/sheet.js';
import { openAddSheet } from './add.js';
import { createResultCard } from './result-card.js';

/** Длиннее не нужно: фраза про еду занимает секунды, а окно модели — 30 секунд звука. */
const MAX_SECONDS = 30;

export function openVoiceSheet({ date = null } = {}) {
  const settings = store.settings || {};
  const providerConfig = settings.provider || {};
  const targetDate = date || store.date;

  const state = {
    step: 'idle', // idle | recording | recognizing | transcript | analyzing | result | error
    seconds: 0,
    duration: 0,
    transcript: '',
    analysis: null,
    error: null,
    card: null,
    model: null,
    modelNote: '',
  };

  let recorder = null;
  let recognizer = null;
  let ticker = null;
  let startedAt = 0;
  let levelNode = null;
  let timeNode = null;
  let statusNode = null;

  const host = h('div', {});
  const sheet = openSheet({ title: 'Еда голосом', content: host, onClose: cleanup });

  function cleanup() {
    stopTicker();
    recorder?.cancel();
    recorder = null;
    recognizer?.close();
    recognizer = null;
  }

  function stopTicker() {
    if (ticker) clearInterval(ticker);
    ticker = null;
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
    state.step = 'recognizing';
    render();

    try {
      const text = await recognize(audio.samples);
      if (!text) {
        // Человек говорил, а модели нечего показать: это не ошибка расчёта, а повод записать снова.
        state.error = {
          title: 'Ничего не расслышали',
          hint: 'Попробуйте записать ещё раз — ближе к микрофону и без лишнего шума.',
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

  function cancelRecording() {
    stopTicker();
    recorder?.cancel();
    recorder = null;
    state.step = 'idle';
    render();
  }

  // --- распознавание на устройстве ---

  /** Готовит распознаватель: модель скачивается один раз и остаётся в кэше браузера. */
  async function prepareRecognizer() {
    if (recognizer) return recognizer;
    const acceleration = await detectAcceleration();
    const offered = availableConfigs(acceleration);
    // Модель выбирается в настройках. Если выбранной там сборки на этом устройстве
    // нет (например, включили ускорение, а видеокарта не работает) — берём среднюю.
    const stored = configById(settings.voice?.config || '');
    const config = (stored && offered.some((item) => item.id === stored.id) ? stored : null)
      || pickDefaultConfig(acceleration);
    state.model = config;

    recognizer = createRecognizer({
      onProgress: (progress) => {
        // Полоску обновляем на месте: перерисовка всего экрана на каждое сообщение
        // о загрузке съедала бы больше, чем сама загрузка.
        if (!statusNode) return;
        statusNode.textContent = `Скачиваю модель: ${progress.percent}%`
          + (progress.total ? ` (${bytesHuman(progress.loaded)} из ${bytesHuman(progress.total)})` : '');
      },
    });

    const answer = await recognizer.load(config);
    if (answer?.fallback) {
      state.modelNote = 'Ускорение видеокартой не заработало — считаю без него.';
    }
    return recognizer;
  }

  async function recognize(samples) {
    try {
      await prepareRecognizer();
    } catch (error) {
      // Поток с неудачной загрузкой закрываем: со сломанным распознавателем
      // повторная попытка обречена, а так следующий раз начнётся заново.
      recognizer?.close();
      recognizer = null;
      throw {
        title: error?.title || 'Модель распознавания не загрузилась',
        hint: 'Проверьте интернет и попробуйте снова. Можно выбрать модель поменьше в настройках.',
        details: error?.details || String(error?.message || error || ''),
      };
    }

    try {
      const result = await recognizer.recognize(samples);
      return String(result.text || '').trim();
    } catch (error) {
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
    host.replaceChildren(
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

    host.replaceChildren(
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
    host.replaceChildren(
      h('p', { class: 'small' }, `Записано ${seconds}. Распознаю на телефоне.`),
      h('div', { class: 'rec-row' },
        h('div', { class: 'level' }, h('div', { class: 'level-fill level-wait' })),
        h('div', { class: 'timer', text: '…' })),
      statusNode,
      state.modelNote ? h('p', { class: 'tiny faint' }, state.modelNote) : null,
      h('p', { class: 'tiny faint', style: 'margin-top:10px' },
        'На слабом телефоне это может занять до полуминуты. Звук остаётся на устройстве.'));
  }

  function renderTranscript() {
    statusNode = null;
    const input = h('textarea', {
      class: 'transcript', rows: 3, value: state.transcript,
      oninput: (event) => { state.transcript = event.target.value; },
    });

    host.replaceChildren(
      h('p', { class: 'small muted' }, 'Вот что расслышали. Поправьте, если что-то не так, — '
        + 'дальше считаются именно эти слова.'),
      input,
      state.modelNote ? h('p', { class: 'tiny faint' }, state.modelNote) : null,
      h('div', { class: 'chips', style: 'margin-top:14px' },
        h('button', { class: 'btn-primary', type: 'button', text: 'Посчитать КБЖУ', onclick: analyze }),
        h('button', { class: 'btn btn-small', type: 'button', text: 'Записать снова', onclick: startRecording })),
      h('p', { class: 'tiny faint', style: 'margin-top:10px' },
        'Расшифровка сделана на телефоне, запись голоса никуда не отправлялась.'));
  }

  function renderAnalyzing() {
    statusNode = null;
    host.replaceChildren(
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
    host.replaceChildren(state.card.element);
  }

  function renderError() {
    statusNode = null;
    const error = state.error || { title: 'Не получилось', hint: '', details: '' };
    host.replaceChildren(
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
