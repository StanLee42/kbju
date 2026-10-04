// Звук: сырые сэмплы в WAV.
//
// Chrome на Android пишет голос в webm/opus, а распознавание речи на устройстве и часть
// облачных сервисов хотят WAV. Поэтому пишем свой кодек: он небольшой, проверяется тестами
// и не требует ни конвертеров, ни сторонних библиотек.

/** Частота, которую ждёт распознавание речи. */
export const SPEECH_SAMPLE_RATE = 16000;

/** Стерео (или больше каналов) сводим в моно: для речи второго канала не нужно. */
export function downmixToMono(channels) {
  if (!channels?.length) return new Float32Array(0);
  if (channels.length === 1) return channels[0];

  const length = channels[0].length;
  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let index = 0; index < length; index += 1) {
      mono[index] += (channel[index] || 0) / channels.length;
    }
  }
  return mono;
}

/**
 * Передискретизация.
 *
 * При понижении частоты усредняем по окну источника: просто выбрасывать лишние сэмплы
 * нельзя — на речи это даёт искажения. При повышении раскладываем линейно.
 */
export function resampleLinear(samples, fromRate, toRate = SPEECH_SAMPLE_RATE) {
  if (!samples?.length || fromRate === toRate) return samples || new Float32Array(0);

  const ratio = fromRate / toRate;

  if (ratio > 1) {
    const length = Math.max(1, Math.floor(samples.length / ratio));
    const result = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      const start = index * ratio;
      const end = Math.min(samples.length, start + ratio);
      let weighted = 0;
      let weight = 0;
      for (let position = Math.floor(start); position < Math.ceil(end); position += 1) {
        const overlap = Math.min(end, position + 1) - Math.max(start, position);
        if (overlap > 0) {
          weighted += samples[position] * overlap;
          weight += overlap;
        }
      }
      result[index] = weight > 0 ? weighted / weight : 0;
    }
    return result;
  }

  const length = Math.max(1, Math.round((samples.length / ratio)));
  const result = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.min(samples.length - 1, Math.floor(position));
    const right = Math.min(samples.length - 1, left + 1);
    const weight = position - left;
    result[index] = samples[left] * (1 - weight) + samples[right] * weight;
  }
  return result;
}

/** Вещественные сэмплы в 16-битные целые с ограничением диапазона. */
export function floatToInt16(samples) {
  const result = new Int16Array(samples?.length || 0);
  for (let index = 0; index < result.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index] || 0));
    result[index] = value < 0 ? Math.round(value * 32768) : Math.round(value * 32767);
  }
  return result;
}

export function durationSeconds(sampleCount, rate = SPEECH_SAMPLE_RATE) {
  return rate > 0 ? sampleCount / rate : 0;
}

/**
 * Собирает WAV из сэмплов.
 * @param {{samples: Float32Array, sampleRate?: number, channels?: number}} options
 * @returns {ArrayBuffer}
 */
export function encodeWav({ samples, sampleRate = SPEECH_SAMPLE_RATE, channels = 1 }) {
  const pcm = floatToInt16(samples);
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = pcm.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeText = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, 'WAVE');

  writeText(12, 'fmt ');
  view.setUint32(16, 16, true); // размер блока fmt
  view.setUint16(20, 1, true); // PCM без сжатия
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true); // байт в секунду
  view.setUint16(32, channels * bytesPerSample, true); // выравнивание блока
  view.setUint16(34, bitsPerSample, true);

  writeText(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let index = 0; index < pcm.length; index += 1) {
    view.setInt16(44 + index * bytesPerSample, pcm[index], true);
  }

  return buffer;
}

/**
 * Готовит записанные каналы к отправке: моно, нужная частота, WAV.
 *
 * Возвращаются и сами подготовленные сэмплы: распознавание речи на устройстве считает
 * по числам, а не по файлу, а второй раз пересчитывать их из WAV незачем.
 */
export function prepareSpeech({ channels, sampleRate, targetRate = SPEECH_SAMPLE_RATE }) {
  const mono = downmixToMono(channels);
  const resampled = resampleLinear(mono, sampleRate, targetRate);
  return {
    samples: resampled,
    wav: encodeWav({ samples: resampled, sampleRate: targetRate }),
    sampleRate: targetRate,
    durationSeconds: durationSeconds(resampled.length, targetRate),
  };
}
