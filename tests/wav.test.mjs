// Проверка кодека: WAV, передискретизация и приведение сэмплов.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SPEECH_SAMPLE_RATE, downmixToMono, durationSeconds, encodeWav, floatToInt16,
  prepareSpeech, resampleLinear,
} from '../js/audio/wav.js';

function readText(view, offset, length) {
  let text = '';
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(view.getUint8(offset + index));
  return text;
}

test('заголовок WAV заполнен по стандарту', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const buffer = encodeWav({ samples, sampleRate: 16000, channels: 1 });
  const view = new DataView(buffer);

  assert.equal(readText(view, 0, 4), 'RIFF');
  assert.equal(readText(view, 8, 4), 'WAVE');
  assert.equal(readText(view, 12, 4), 'fmt ');
  assert.equal(readText(view, 36, 4), 'data');

  assert.equal(view.getUint32(4, true), 36 + samples.length * 2, 'размер файла без первых 8 байт');
  assert.equal(view.getUint16(20, true), 1, 'PCM без сжатия');
  assert.equal(view.getUint16(22, true), 1, 'каналов');
  assert.equal(view.getUint32(24, true), 16000, 'частота');
  assert.equal(view.getUint32(28, true), 16000 * 2, 'байт в секунду');
  assert.equal(view.getUint16(32, true), 2, 'выравнивание блока');
  assert.equal(view.getUint16(34, true), 16, 'бит на сэмпл');
  assert.equal(view.getUint32(40, true), samples.length * 2);
  assert.equal(buffer.byteLength, 44 + samples.length * 2);
});

test('сэмплы пишутся как 16-битные целые с ограничением', () => {
  const buffer = encodeWav({ samples: new Float32Array([0, 1, -1, 2, -2]) });
  const view = new DataView(buffer);
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 32767);
  assert.equal(view.getInt16(48, true), -32768);
  assert.equal(view.getInt16(50, true), 32767, 'значения выше единицы обрезаются');
  assert.equal(view.getInt16(52, true), -32768, 'значения ниже минус единицы обрезаются');
});

test('передискретизация меняет длину по отношению частот', () => {
  const source = new Float32Array(48000).fill(0.5);
  const result = resampleLinear(source, 48000, 16000);
  assert.equal(result.length, 16000);
  assert.ok(Math.abs(result[100] - 0.5) < 1e-6);
});

test('передискретизация без изменения частоты ничего не портит', () => {
  const source = new Float32Array([0.1, 0.2, 0.3]);
  assert.equal(resampleLinear(source, 16000, 16000), source);
});

test('понижение частоты усредняет по окну, а не выбрасывает сэмплы', () => {
  // Из четырёх сэмплов 0, 1, 0, 1 при уменьшении частоты вдвое получаем два средних.
  const source = new Float32Array([0, 1, 0, 1]);
  const result = resampleLinear(source, 32000, 16000);
  assert.equal(result.length, 2);
  assert.ok(Math.abs(result[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(result[1] - 0.5) < 1e-6);
});

test('повышение частоты раскладывает значения линейно', () => {
  const source = new Float32Array([0, 1]);
  const result = resampleLinear(source, 8000, 16000);
  assert.equal(result.length, 4);
  assert.equal(result[0], 0);
  assert.ok(Math.abs(result[1] - 0.5) < 1e-6);
  assert.equal(result[2], 1);
  assert.equal(result[3], 1, 'на краю значение не выходит за пределы исходного');
});

test('стерео сводится в моно усреднением', () => {
  const left = new Float32Array([1, 0, -1]);
  const right = new Float32Array([0, 1, -1]);
  const mono = downmixToMono([left, right]);
  assert.equal(mono.length, 3);
  assert.ok(Math.abs(mono[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(mono[1] - 0.5) < 1e-6);
  assert.equal(mono[2], -1);
});

test('моно остаётся моно, пустой вход не падает', () => {
  const mono = new Float32Array([0.1, 0.2]);
  assert.equal(downmixToMono([mono]), mono);
  assert.equal(downmixToMono([]).length, 0);
  assert.equal(downmixToMono(null).length, 0);
});

test('подготовка речи даёт моно 16 кГц нужной длительности', () => {
  const channels = [new Float32Array(48000).fill(0.25)];
  const prepared = prepareSpeech({ channels, sampleRate: 48000 });
  assert.equal(prepared.sampleRate, SPEECH_SAMPLE_RATE);
  assert.ok(Math.abs(prepared.durationSeconds - 1) < 0.01);
  assert.equal(prepared.wav.byteLength, 44 + 16000 * 2);
});

test('длительность считается по частоте', () => {
  assert.equal(durationSeconds(16000, 16000), 1);
  assert.equal(durationSeconds(8000, 16000), 0.5);
  assert.equal(durationSeconds(100, 0), 0);
});
