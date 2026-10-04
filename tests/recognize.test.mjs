// Проверка настроек распознавания: список моделей, выбор по умолчанию, понятные ошибки.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIGS, availableConfigs, configById, createRecognizer, describeRecognizeError, detectAcceleration, hasWebGPU, pickDefaultConfig, wasmTwinOf } from '../js/audio/recognize.js';

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

test('с ускорением видеокарты выбирается средняя модель с ускорением', () => {
  const fast = pickDefaultConfig({ webgpu: true });
  assert.equal(fast.device, 'webgpu');
  assert.equal(fast.model, 'onnx-community/whisper-base');
});

test('без ускорения выбирается модель, работающая везде', () => {
  const safe = pickDefaultConfig({});
  assert.equal(safe.device, 'wasm');
  assert.equal(safe.dtype, 'fp32');
  assert.equal(safe.model, 'onnx-community/whisper-base');
});

test('по умолчанию берётся средняя модель, а не крошечная', () => {
  // Замер на русской речи: крошечная путает названия блюд («цайкосист» вместо
  // «яйца и кофе»), а в дневнике питания название и есть смысл записи.
  for (const acceleration of [{ webgpu: true }, { webgpu: false }]) {
    assert.match(pickDefaultConfig(acceleration).model, /whisper-base/);
  }
});

test('наличие ускорения определяется по возможности запросить адаптер', () => {
  assert.equal(hasWebGPU({ gpu: { requestAdapter: () => {} } }), true);
  assert.equal(hasWebGPU({ gpu: {} }), false);
  assert.equal(hasWebGPU({}), false);
  assert.equal(hasWebGPU(undefined), false);
});

test('ускорение считается рабочим только если адаптер действительно выдан', async () => {
  // Такой случай встречается в эмуляторе Android: navigator.gpu есть, а адаптера нет.
  const granted = await detectAcceleration({ gpu: { requestAdapter: async () => ({ info: { vendor: 'apple' } }) } });
  assert.equal(granted.webgpu, true);
  assert.equal(granted.adapter, 'apple');

  const refused = await detectAcceleration({ gpu: { requestAdapter: async () => null } });
  assert.equal(refused.webgpu, false);
  assert.match(refused.reason, /адаптер/i);

  const broken = await detectAcceleration({ gpu: { requestAdapter: async () => { throw new Error('нет драйвера'); } } });
  assert.equal(broken.webgpu, false);
  assert.match(broken.reason, /нет драйвера/);

  const absent = await detectAcceleration({});
  assert.equal(absent.webgpu, false);
  assert.match(absent.reason, /не умеет/i);
});

test('без рабочего ускорения сборки с ускорением не предлагаются', () => {
  const without = availableConfigs({ webgpu: false });
  assert.ok(without.length >= 3);
  assert.equal(without.some((config) => config.device === 'webgpu'), false);

  const withGpu = availableConfigs({ webgpu: true });
  assert.equal(withGpu.length, CONFIGS.length);
});

test('у сборки с ускорением есть двойник без ускорения', () => {
  const accelerated = configById('base-webgpu');
  const twin = wasmTwinOf(accelerated);
  assert.equal(twin.device, 'wasm');
  assert.equal(twin.model, accelerated.model);
  assert.equal(typeof twin.dtype, 'string');

  assert.equal(wasmTwinOf(configById('tiny-webgpu')).id, 'tiny-wasm');

  // У сборки без ускорения двойника нет: откатываться некуда.
  assert.equal(wasmTwinOf(configById('base-wasm')), null);
  assert.equal(wasmTwinOf(null), null);
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

/**
 * Подставной поток распознавания: отвечает так же, как настоящий, но без браузера.
 * Нужен, чтобы проверить откат без ускорения наверняка, а не надеяться на то,
 * что устройство под рукой окажется без рабочей видеокарты.
 */
function fakeWorkerFactory(reply) {
  const workers = [];
  return {
    workers,
    create() {
      const worker = {
        posted: [],
        terminated: false,
        listeners: [],
        addEventListener(type, handler) { if (type === 'message') this.listeners.push(handler); },
        postMessage(message) {
          this.posted.push(message);
          const answer = reply(message, workers.length);
          queueMicrotask(() => {
            if (!answer) return;
            for (const listener of this.listeners) listener({ data: answer });
          });
        },
        terminate() { this.terminated = true; },
      };
      workers.push(worker);
      return worker;
    },
  };
}

const GPU_FAILURE = 'Error: no available backend found. ERR: [webgpu] Error: Failed to get GPU adapter';

test('если ускорение отказало при загрузке, берётся та же модель без ускорения', async () => {
  const factory = fakeWorkerFactory((message, workerNumber) => {
    if (message.type !== 'load') return null;
    // Первая попытка — отказ видеокарты, вторая — та же модель без ускорения.
    if (workerNumber === 1) return { type: 'error', payload: { stage: 'load', message: GPU_FAILURE } };
    return { type: 'loaded', payload: { configId: message.payload.config.id } };
  });

  const recognizer = createRecognizer({ createWorker: factory.create });
  const answer = await recognizer.load(configById('tiny-webgpu'));

  assert.equal(answer.ok, true);
  assert.equal(answer.fallback.from, 'tiny-webgpu');
  assert.equal(answer.fallback.to, 'tiny-wasm');
  assert.equal(recognizer.configId, 'tiny-wasm');

  assert.equal(factory.workers.length, 2, 'должен быть новый поток под запасную сборку');
  assert.equal(factory.workers[0].terminated, true, 'первый поток должен быть закрыт');
  assert.equal(factory.workers[1].posted[0].payload.config.device, 'wasm');
});

test('ошибка сети не подменяется запасной сборкой', async () => {
  const factory = fakeWorkerFactory(() => ({ type: 'error', payload: { stage: 'load', message: 'TypeError: Failed to fetch' } }));
  const recognizer = createRecognizer({ createWorker: factory.create });

  await assert.rejects(() => recognizer.load(configById('base-webgpu')), (error) => {
    assert.match(error.title, /скачать модель/i);
    return true;
  });
  assert.equal(factory.workers.length, 1, 'повторять загрузку из-за сети незачем');
});

test('откат можно выключить, если сборку выбрал человек', async () => {
  const factory = fakeWorkerFactory(() => ({ type: 'error', payload: { stage: 'load', message: GPU_FAILURE } }));
  const recognizer = createRecognizer({ createWorker: factory.create });

  await assert.rejects(() => recognizer.load(configById('base-webgpu'), { fallback: false }));
  assert.equal(factory.workers.length, 1);
});

test('повторная загрузка той же сборки не трогает поток', async () => {
  const factory = fakeWorkerFactory((message) => ({ type: 'loaded', payload: { configId: message.payload.config.id } }));
  const recognizer = createRecognizer({ createWorker: factory.create });

  await recognizer.load(configById('base-wasm'));
  const again = await recognizer.load(configById('base-wasm'));

  assert.equal(again.cached, true);
  assert.equal(factory.workers[0].posted.length, 1, 'второй раз модель не загружается');
});
