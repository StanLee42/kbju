// Проверка настроек распознавания: список моделей, выбор по умолчанию, понятные ошибки.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIGS, configById, describeRecognizeError, hasWebGPU, pickDefaultConfig } from '../js/audio/recognize.js';

test('у каждой модели указаны размер, устройство и точность', () => {
  assert.ok(CONFIGS.length >= 4);
  for (const config of CONFIGS) {
    assert.ok(config.id, 'нет идентификатора');
    assert.ok(config.model.startsWith('onnx-community/whisper-'), `непонятная модель: ${config.model}`);
    assert.ok(['webgpu', 'wasm'].includes(config.device), `непонятное устройство: ${config.device}`);
    assert.ok(config.dtype, 'не указана точность');
    assert.ok(config.sizeMb > 0, 'не указан размер загрузки');
    assert.ok(config.note.length > 20, 'слишком короткое пояснение');
  }
});

test('идентификаторы моделей не повторяются', () => {
  const ids = CONFIGS.map((config) => config.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('с ускорением видеокарты выбирается быстрая модель', () => {
  const fast = pickDefaultConfig({ gpu: { requestAdapter: () => {} } });
  assert.equal(fast.device, 'webgpu');
  assert.match(fast.id, /tiny|base/);
});

test('без ускорения выбирается модель, работающая везде', () => {
  const safe = pickDefaultConfig({});
  assert.equal(safe.device, 'wasm');
  assert.equal(safe.dtype, 'fp32');
});

test('наличие ускорения определяется по возможности запросить адаптер', () => {
  assert.equal(hasWebGPU({ gpu: { requestAdapter: () => {} } }), true);
  assert.equal(hasWebGPU({ gpu: {} }), false);
  assert.equal(hasWebGPU({}), false);
  assert.equal(hasWebGPU(undefined), false);
});

test('неизвестная модель не ломает приложение', () => {
  assert.equal(configById('нет-такой'), null);
  assert.equal(configById(CONFIGS[0].id).model, CONFIGS[0].model);
});

test('ошибки объясняются человеку, а не показываются как есть', () => {
  const scale = describeRecognizeError('Error: Missing required scale: model.decoder.embed_tokens.weight');
  assert.match(scale.title, /другой размер модели/i);

  const network = describeRecognizeError('TypeError: Failed to fetch');
  assert.match(network.title, /скачать модель/i);

  const memory = describeRecognizeError('RangeError: Array buffer allocation failed');
  assert.match(memory.title, /памяти/i);

  const unknown = describeRecognizeError('что-то странное');
  assert.match(unknown.title, /не получилось/i);
  assert.ok(unknown.details.length > 0);
});
