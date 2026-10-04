// Распознавание речи на устройстве: клиент для потока распознавания.
//
// Размеры загрузки измерены по файлам моделей на Hugging Face, а не взяты на глаз:
// библиотека качает только два файла (кодировщик и объединённый декодер), поэтому
// числа ниже — это именно то, что скачает телефон.

export const LANGUAGE_CODE = 'russian';

// Проверено по репозиториям моделей: квантованные варианты сейчас могут не запускаться
// в браузере, поэтому основная ставка на полную точность и на ускорение видеокартой.
export const CONFIGS = [
  {
    id: 'tiny-webgpu',
    label: 'Крошечная с ускорением',
    note: 'около 120 МБ, считает быстрее всех, точность ниже',
    model: 'onnx-community/whisper-tiny',
    device: 'webgpu',
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    sizeMb: 120,
  },
  {
    id: 'base-webgpu',
    label: 'Средняя с ускорением',
    note: 'около 210 МБ, точнее крошечной, считает быстро',
    model: 'onnx-community/whisper-base',
    device: 'webgpu',
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    sizeMb: 206,
  },
  {
    id: 'tiny-wasm',
    label: 'Крошечная без ускорения',
    note: 'около 150 МБ, работает на любом телефоне, считает медленнее',
    model: 'onnx-community/whisper-tiny',
    device: 'wasm',
    dtype: 'fp32',
    sizeMb: 151,
  },
  {
    id: 'base-wasm',
    label: 'Средняя без ускорения',
    note: 'около 290 МБ, самая точная из надёжных, считает медленно',
    model: 'onnx-community/whisper-base',
    device: 'wasm',
    dtype: 'fp32',
    sizeMb: 291,
  },
  {
    id: 'tiny-int8',
    label: 'Крошечная самого малого размера',
    note: 'всего 41 МБ, но сжатые модели сейчас могут не запускаться в браузере',
    model: 'onnx-community/whisper-tiny',
    device: 'wasm',
    dtype: 'int8',
    sizeMb: 41,
  },
];

export function configById(id) {
  return CONFIGS.find((config) => config.id === id) || null;
}

/** Есть ли у устройства ускорение видеокартой: от этого зависит выбор модели. */
export function hasWebGPU(nav = typeof navigator === 'undefined' ? {} : navigator) {
  return Boolean(nav?.gpu?.requestAdapter);
}

export function pickDefaultConfig(nav) {
  return hasWebGPU(nav) ? configById('tiny-webgpu') : configById('tiny-wasm');
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
    text: 'Ускорение видеокартой не заработало. Выберите модель без ускорения.',
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
 * Запускает поток распознавания.
 * @returns {object} клиент с методами load, recognize и close
 */
export function createRecognizer({ onProgress = () => {} } = {}) {
  let worker = null;
  let pending = null;
  let loadedConfigId = null;

  function start() {
    if (worker) return worker;
    worker = new Worker('./js/audio/recognize.worker.js', { type: 'module' });
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

  return {
    get configId() { return loadedConfigId; },

    /** Загружает модель. Повторный вызов с той же конфигурацией ничего не делает. */
    async load(config) {
      if (loadedConfigId === config.id) return { ok: true, cached: true };
      return ask({ type: 'load', payload: { config } });
    },

    async recognize(samples, { language = LANGUAGE_CODE } = {}) {
      return ask({ type: 'recognize', payload: { samples: Array.from(samples), language } });
    },

    close() {
      worker?.terminate();
      worker = null;
      pending = null;
      loadedConfigId = null;
    },
  };
}
