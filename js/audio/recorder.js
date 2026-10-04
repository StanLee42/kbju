// Запись голоса через Web Audio API.
//
// Записываем сырые сэмплы, а не сжатый поток: из одних и тех же данных получается и WAV
// для отправки в облако, и моно 16 кГц для распознавания на устройстве.
import { prepareSpeech, recordLoudness, SPEECH_SAMPLE_RATE } from './wav.js';

/**
 * @returns {Promise<object>} объект записи с методами start, stop, cancel и getLevel
 */
export async function createRecorder({ targetRate = SPEECH_SAMPLE_RATE } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('браузер не даёт доступ к микрофону');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const context = new (window.AudioContext || window.webkitAudioContext)();

  // На телефоне контекст умеет создаться приостановленным, и тогда в запись пойдёт
  // тишина: распознавание на тишине выдаёт выдуманные слова, и это выглядит как ошибка
  // модели. Поэтому перед записью просим звук работать.
  if (context.state === 'suspended') await context.resume();

  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;

  const channels = [[]];
  let recording = false;
  let released = false;

  // ScriptProcessor устарел, но работает без отдельного файла-ворклета, а сборки у нас нет.
  // Если он когда-нибудь исчезнет из браузеров, здесь появится AudioWorklet.
  const processor = context.createScriptProcessor(4096, 1, 1);
  const levelBuffer = new Float32Array(analyser.fftSize);

  processor.onaudioprocess = (event) => {
    if (!recording) return;
    const input = event.inputBuffer.getChannelData(0);
    channels[0].push(new Float32Array(input));
  };

  source.connect(analyser);
  analyser.connect(processor);
  // Без подключения к выходу ScriptProcessor не получает событий в части браузеров,
  // поэтому ведём его в усилитель с нулевой громкостью: наружу звук не идёт.
  const silence = context.createGain();
  silence.gain.value = 0;
  processor.connect(silence);
  silence.connect(context.destination);

  function flatten() {
    const total = channels[0].reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of channels[0]) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  }

  function release() {
    if (released) return;
    released = true;
    processor.onaudioprocess = null;
    try {
      processor.disconnect();
      analyser.disconnect();
      source.disconnect();
      silence.disconnect();
    } catch {
      // Узлы могли уже быть отключены — это не повод падать.
    }
    for (const track of stream.getTracks()) track.stop();
    context.close().catch(() => {});
  }

  return {
    get isRecording() {
      return recording;
    },

    start() {
      channels[0] = [];
      recording = true;
    },

    /** Текущая громкость от 0 до 1: для индикатора записи в интерфейсе. */
    getLevel() {
      analyser.getFloatTimeDomainData(levelBuffer);
      let sum = 0;
      for (const value of levelBuffer) sum += value * value;
      return Math.min(1, Math.sqrt(sum / levelBuffer.length) * 4);
    },

    /** Останавливает запись и возвращает готовый звук вместе с его громкостью. */
    stop() {
      recording = false;
      const samples = flatten();
      const prepared = prepareSpeech({
        channels: [samples],
        sampleRate: context.sampleRate,
        targetRate,
      });
      release();
      return {
        ...prepared,
        loudness: recordLoudness(prepared.samples),
        blob: new Blob([prepared.wav], { type: 'audio/wav' }),
        sourceSampleRate: context.sampleRate,
      };
    },

    /** Отменяет запись, ничего не возвращая. */
    cancel() {
      recording = false;
      release();
    },
  };
}

/** Скачивание записи: нужна для отладки и для проверки качества распознавания. */
export function downloadAudio(wav, name = 'voice.wav') {
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
