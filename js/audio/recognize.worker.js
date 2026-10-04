// Распознавание речи в отдельном потоке.
//
// Модель считает на устройстве, поэтому звук никуда не уходит. В отдельном потоке
// это делается не для красоты: расчёт занимает секунды, и на главном потоке
// интерфейс бы замер.
//
// Библиотека подгружается с CDN: класть её в репозиторий смысла нет, а кэш
// браузера хранит её после первой загрузки.
const LIBRARY = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';

let transcriber = null;
let loadedConfigId = null;

/**
 * Складывает прогресс по всем файлам: библиотека сообщает о каждом отдельно.
 *
 * Размер файла, о котором уже отчитались, нельзя терять на сообщении «готово»:
 * иначе общий вес на глазах уменьшается, а полоска загрузки едет назад.
 */
function createProgressTracker() {
  const perFile = new Map();
  return (info) => {
    if (!info || !info.file) return null;
    if (info.status === 'progress') {
      perFile.set(info.file, { loaded: info.loaded || 0, total: info.total || 0 });
    } else if (info.status === 'done') {
      const known = perFile.get(info.file);
      if (known) perFile.set(info.file, { loaded: known.total, total: known.total });
    } else {
      return null;
    }
    let loaded = 0;
    let total = 0;
    for (const item of perFile.values()) {
      loaded += item.loaded || 0;
      total += item.total || 0;
    }
    return { loaded, total, percent: total ? Math.round((loaded / total) * 100) : 0 };
  };
}

async function getLibrary() {
  const module = await import(/* @vite-ignore */ LIBRARY);
  module.env.allowLocalModels = false;
  module.env.useBrowserCache = true;
  return module;
}

self.addEventListener('message', async (event) => {
  const { type, payload } = event.data || {};

  if (type === 'load') {
    const { config } = payload;
    try {
      const { pipeline } = await getLibrary();

      // Прогресс складываем по всем файлам: библиотека сообщает о каждом отдельно.
      const track = createProgressTracker();
      const report = (info) => {
        const progress = track(info);
        if (progress) self.postMessage({ type: 'progress', payload: progress });
      };

      transcriber = await pipeline('automatic-speech-recognition', config.model, {
        device: config.device,
        dtype: config.dtype,
        progress_callback: report,
      });

      loadedConfigId = config.id;
      self.postMessage({ type: 'loaded', payload: { configId: config.id } });
    } catch (error) {
      transcriber = null;
      loadedConfigId = null;
      self.postMessage({
        type: 'error',
        payload: { stage: 'load', message: String(error?.message || error), configId: config?.id },
      });
    }
    return;
  }

  if (type === 'recognize') {
    const { samples, language } = payload;
    if (!transcriber) {
      self.postMessage({ type: 'error', payload: { stage: 'recognize', message: 'модель не загружена' } });
      return;
    }
    try {
      const started = Date.now();
      const result = await transcriber(new Float32Array(samples), {
        language,
        task: 'transcribe',
      });
      self.postMessage({
        type: 'result',
        payload: {
          text: String(result?.text || '').trim(),
          seconds: (Date.now() - started) / 1000,
        },
      });
    } catch (error) {
      self.postMessage({
        type: 'error',
        payload: { stage: 'recognize', message: String(error?.message || error) },
      });
    }
  }
});
