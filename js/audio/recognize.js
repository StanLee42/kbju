// Распознавание речи на устройстве: клиент для потока распознавания.
//
// Размеры загрузки и качество измерены стендом (tools/recognize-probe.mjs) на настоящих
// файлах моделей, а не взяты на глаз. Что показал замер на русской речи:
//   средняя модель — 88–92% верных слов, ошибается на редких словах («бедборщ»);
//   крошечная — 46–71% и путает именно названия блюд («цайкосист» вместо «яйца и кофе»);
//   сжатые сборки запускаются, но качество теряют только у крошечной.
// Поэтому по умолчанию берём среднюю: в дневнике питания название блюда и есть смысл записи.

export const LANGUAGE_CODE = 'russian';

export const CONFIGS = [
  {
    id: 'base-webgpu',
    label: 'Средняя с ускорением',
    note: 'около 197 МБ, узнаёт слова лучше всех и считает быстрее всех, если телефон умеет считать на видеокарте',
    model: 'onnx-community/whisper-base',
    device: 'webgpu',
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    sizeMb: 197,
  },
  {
    id: 'base-wasm',
    label: 'Средняя без ускорения',
    note: 'около 278 МБ, узнаёт слова так же хорошо, но считает в разы медленнее',
    model: 'onnx-community/whisper-base',
    device: 'wasm',
    dtype: 'fp32',
    sizeMb: 278,
  },
  {
    id: 'base-int8',
    label: 'Средняя самого малого размера',
    note: 'около 73 МБ, узнаёт почти как полная, но теряет редкие слова; считает не быстрее',
    model: 'onnx-community/whisper-base',
    device: 'wasm',
    dtype: 'int8',
    sizeMb: 73,
  },
  {
    id: 'tiny-webgpu',
    label: 'Крошечная с ускорением',
    note: 'около 115 МБ, считает быстро, но путает названия блюд',
    model: 'onnx-community/whisper-tiny',
    device: 'webgpu',
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    sizeMb: 115,
  },
  {
    id: 'tiny-wasm',
    label: 'Крошечная без ускорения',
    note: 'около 145 МБ, работает на любом телефоне, но считает медленно и путает названия блюд',
    model: 'onnx-community/whisper-tiny',
    device: 'wasm',
    dtype: 'fp32',
    sizeMb: 145,
  },
  {
    id: 'tiny-int8',
    label: 'Крошечная самого малого размера',
    note: 'всего 39 МБ, но названия блюд разбирает хуже всех — для дневника не годится',
    model: 'onnx-community/whisper-tiny',
    device: 'wasm',
    dtype: 'int8',
    sizeMb: 39,
  },
];

export function configById(id) {
  return CONFIGS.find((config) => config.id === id) || null;
}

/** Есть ли у устройства ускорение видеокартой: от этого зависит выбор модели. */
export function hasWebGPU(nav = typeof navigator === 'undefined' ? {} : navigator) {
  return Boolean(nav?.gpu?.requestAdapter);
}

const defaultNavigator = () => (typeof navigator === 'undefined' ? {} : navigator);

/**
 * Работает ли ускорение на самом деле.
 *
 * Одного наличия navigator.gpu мало: в эмуляторе Android он есть, а адаптер не выдаётся,
 * и загрузка модели с ускорением падает с «Failed to get GPU adapter». Если бы мы верили
 * одному наличию поля, человек получал бы ошибку на ровном месте. Поэтому адаптер
 * запрашиваем по-настоящему — и знаем, что он вернулся, а не просто что поле есть.
 */
export async function detectAcceleration(nav = defaultNavigator()) {
  if (!hasWebGPU(nav)) return { webgpu: false, reason: 'браузер не умеет считать на видеокарте' };
  try {
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) return { webgpu: false, reason: 'устройство не выдало адаптер видеокарты' };
    const info = adapter.info || {};
    const name = [info.vendor, info.architecture].filter(Boolean).join(' ');
    return { webgpu: true, reason: '', adapter: name };
  } catch (error) {
    return { webgpu: false, reason: `видеокарта не ответила: ${String(error?.message || error)}` };
  }
}

/**
 * Сборка по умолчанию: средняя.
 *
 * Крошечная считает быстрее, но путает названия блюд, а в дневнике питания название
 * и есть смысл записи. Ускорение берём только если проверка подтвердила, что оно работает.
 */
export function pickDefaultConfig({ webgpu = false } = {}) {
  return webgpu ? configById('base-webgpu') : configById('base-wasm');
}

/** Сборки, которые вообще могут заработать на этом устройстве. */
export function availableConfigs({ webgpu = false } = {}) {
  return webgpu ? [...CONFIGS] : CONFIGS.filter((config) => config.device !== 'webgpu');
}

/** Та же модель без ускорения: нужна, если с ускорением не получилось. */
export function wasmTwinOf(config) {
  if (!config || config.device !== 'webgpu') return null;
  return CONFIGS.find((item) => item.model === config.model
    && item.device === 'wasm' && typeof item.dtype === 'string') || null;
}

const FRIENDLY_ERRORS = [
  {
    match: /Missing required scale|MatMulNBits|DequantizeLinear/i,
    text: 'Сжатая модель не запустилась в этом браузере. Выберите другой размер модели — например, без ускорения.',
  },
  {
    match: /Failed to fetch|NetworkError|load failed/i,
    text: 'Не удалось скачать модель. Проверьте интернет и попробуйте снова.',
  },
  {
    match: /out of memory|OOM|Array buffer allocation/i,
    text: 'Телефону не хватило памяти на эту модель. Возьмите размер меньше.',
  },
  {
    match: /webgpu|adapter/i,
    text: 'Ускорение видеокартой не заработало',
  },
];

/** Переводит ошибку библиотеки в понятный текст. */
export function describeRecognizeError(message) {
  const raw = String(message || '');
  const found = FRIENDLY_ERRORS.find((item) => item.match.test(raw));
  return {
    title: found ? found.text : 'Распознавание не получилось',
    details: raw.slice(0, 300),
  };
}

/**
 * Ошибка из-за ускорения видеокартой, а не из-за модели или сети: только в этом
 * случае есть смысл повторить загрузку без ускорения.
 */
function isAccelerationError(error) {
  const text = `${error?.title || ''} ${error?.details || ''}`;
  return /webgpu|видеокарт|adapter|no available backend/i.test(text);
}

/** Поток распознавания. Отдельной функцией — чтобы подменять его в тестах. */
function openRecognizeWorker() {
  return new Worker('./js/audio/recognize.worker.js', { type: 'module' });
}

/**
 * Запускает поток распознавания.
 * @param {{onProgress?: Function, createWorker?: Function}} options
 * @returns {object} клиент с методами load, recognize и close
 */
export function createRecognizer({ onProgress = () => {}, createWorker = openRecognizeWorker } = {}) {
  let worker = null;
  let pending = null;
  let loadedConfigId = null;

  function start() {
    if (worker) return worker;
    worker = createWorker();
    worker.addEventListener('message', (event) => {
      const { type, payload } = event.data || {};
      if (type === 'progress') { onProgress(payload); return; }
      if (!pending) return;
      const { resolve, reject } = pending;
      pending = null;
      if (type === 'loaded') { loadedConfigId = payload.configId; resolve({ ok: true }); return; }
      if (type === 'result') { resolve({ ok: true, ...payload }); return; }
      if (type === 'error') { reject(describeRecognizeError(payload.message)); }
    });
    worker.addEventListener('error', (event) => {
      const reject = pending?.reject;
      pending = null;
      reject?.(describeRecognizeError(event.message || 'поток распознавания упал'));
    });
    return worker;
  }

  function ask(message) {
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      start().postMessage(message);
    });
  }

  function stop() {
    worker?.terminate();
    worker = null;
    pending = null;
    loadedConfigId = null;
  }

  return {
    get configId() { return loadedConfigId; },

    /**
     * Загружает модель. Повторный вызов с той же конфигурацией ничего не делает.
     *
     * Если ускорение отказало уже во время загрузки, пробуем ту же модель без него:
     * человеку нужен текст, а не разбирательство с видеокартой. О подмене сообщаем
     * вызывающему, чтобы интерфейс мог сказать об этом вслух.
     */
    async load(config, { fallback = true } = {}) {
      if (loadedConfigId === config.id) return { ok: true, cached: true };
      try {
        return await ask({ type: 'load', payload: { config } });
      } catch (error) {
        const twin = fallback ? wasmTwinOf(config) : null;
        if (!twin || !isAccelerationError(error)) throw error;
        stop();
        const answer = await ask({ type: 'load', payload: { config: twin } });
        return { ...answer, fallback: { from: config.id, to: twin.id, reason: error.title } };
      }
    },

    async recognize(samples, { language = LANGUAGE_CODE } = {}) {
      // Отправляем сами числа, а не их копию списком: копия из десятков тысяч значений
      // тратит память и время на каждой записи.
      return ask({ type: 'recognize', payload: { samples, language } });
    },

    close: stop,
  };
}
