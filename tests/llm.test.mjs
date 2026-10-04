// Проверка разбора ответов модели и логики повторов.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KINDS, analyzeChat, analyzeFood, readImpedance } from '../js/llm/index.js';
import { providerError } from '../js/llm/errors.js';
import { extractJson, parseAnalysis, parseImpedance } from '../js/llm/parse.js';
import { CHAT_SYSTEM_PROMPT, SYSTEM_PROMPT } from '../js/llm/prompt.js';

const validAnswer = JSON.stringify({
  dish: 'Паста с сыром',
  source: 'label',
  basis: 'per_portion',
  items: [
    { name: 'Паста отварная', grams: 160, kcal: 235, protein: 8.6, fat: 1.8, carbs: 46 },
    { name: 'Пармезан', grams: 15, kcal: 59, protein: 5, fat: 4, carbs: 0.5 },
  ],
  confidence: 'high',
  assumptions: 'Соус не учтён.',
});

function stubProvider(responses) {
  const calls = [];
  let index = 0;
  return {
    id: 'stub',
    calls,
    async chat(request) {
      calls.push(request);
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (response.throws) throw response.throws;
      return {
        text: response.text,
        usage: response.usage || { prompt_tokens: 100, completion_tokens: 50 },
        finishReason: response.finishReason ?? 'stop',
        reasoningLength: response.reasoningLength || 0,
      };
    },
  };
}

test('ответ оборачивается в markdown-код и всё равно разбирается', () => {
  const fenced = '```json\n' + validAnswer + '\n```';
  const parsed = parseAnalysis(fenced);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.items.length, 2);
  assert.equal(Math.round(parsed.data.totals.kcal), 294);
});

test('пояснение вокруг JSON не мешает разбору', () => {
  const withPreamble = `Вот результат:\n${validAnswer}\nНадеюсь, помог.`;
  assert.equal(parseAnalysis(withPreamble).ok, true);
  assert.equal(extractJson('совсем не json'), null);
});

test('позиции приходят объектом вместо массива', () => {
  const answer = JSON.stringify({
    dish: 'Творог',
    source: 'estimate',
    basis: 'per_portion',
    items: { a: { name: 'Творог 5%', grams: 200, kcal: 242, protein: 34, fat: 10, carbs: 6 } },
    confidence: 'medium',
  });
  const parsed = parseAnalysis(answer);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.items[0].name, 'Творог 5%');
});

test('позиция без веса отбрасывается, а не превращается в ноль', () => {
  const answer = JSON.stringify({
    dish: 'Суп',
    source: 'estimate',
    basis: 'per_portion',
    items: [
      { name: 'Борщ', grams: 300, kcal: 120, protein: 5, fat: 6, carbs: 12 },
      { name: 'Хлеб', kcal: 80 },
    ],
    confidence: 'medium',
  });
  const parsed = parseAnalysis(answer);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.items.length, 1);
  assert.match(parsed.data.warnings.join(' '), /Хлеб/);
});

test('ответ без позиций считается ошибкой', () => {
  assert.equal(parseAnalysis('{"dish":"непонятно","items":[]}').ok, false);
  assert.equal(parseAnalysis('').ok, false);
});

test('неизвестный базис и источник подменяются безопасными значениями', () => {
  const answer = JSON.stringify({
    dish: 'Что-то',
    source: 'нечто',
    basis: 'как-то',
    items: [{ name: 'Еда', grams: 100, kcal: 100, protein: 1, fat: 1, carbs: 1 }],
  });
  const parsed = parseAnalysis(answer);
  assert.equal(parsed.data.source, 'estimate');
  assert.equal(parsed.data.basis, 'per_portion');
  assert.equal(parsed.data.confidence, 'low');
});

test('запрос повторяется, когда ответ оборвался по лимиту', async () => {
  const provider = stubProvider([
    { text: '{"dish":"Пас', finishReason: 'length', reasoningLength: 9000 },
    { text: validAnswer, usage: { prompt_tokens: 120, completion_tokens: 300 } },
  ]);

  const result = await analyzeFood({ provider, text: 'это паста' });
  assert.equal(result.ok, true);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.usages.length, 2);
  // Второй запрос ушёл с увеличенным лимитом вывода.
  assert.ok(provider.calls[1].maxTokens > provider.calls[0].maxTokens);
});

test('битый ответ повторяется один раз и затем сдаётся', async () => {
  const provider = stubProvider([{ text: 'ничего не json' }, { text: 'тоже не json' }]);
  const result = await analyzeFood({ provider });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, KINDS.format);
  assert.equal(provider.calls.length, 2);
});

test('ошибка баланса не повторяется и объясняется человеку', async () => {
  const provider = stubProvider([{ throws: providerError(KINDS.balance, 'провайдер ответил 402') }]);
  const result = await analyzeFood({ provider });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, KINDS.balance);
  assert.match(result.error.title, /средства/i);
  assert.equal(provider.calls.length, 1, 'повторять запрос при нехватке средств бессмысленно');
});

test('временная ошибка сети повторяется', async () => {
  const provider = stubProvider([
    { throws: providerError(KINDS.network, 'нет связи') },
    { text: validAnswer },
  ]);
  const result = await analyzeFood({ provider });
  assert.equal(result.ok, true);
  assert.equal(provider.calls.length, 2);
});

test('измерения из отчёта разбираются, пустой ответ — ошибка', () => {
  // Пример выдуман для тестов: никаких реальных измерений здесь нет.
  const answer = JSON.stringify({
    date: '2026-09-15', sex: 'M', age: 41, height: 176, weight: 82, waist: 88, hips: 96,
    bmi: 26.5, fatMass: 18.5, leanMass: 63.5, activeCellMass: 41.2, skeletalMuscleMass: 33.1,
    totalWater: 46.4, extracellularWater: 17.9, boneMineralMass: 2.6, bmr: 1800,
    fatPercent: 22.6, confidence: 'high', assumptions: 'Прочитано полностью.',
  });
  const parsed = parseImpedance(answer);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.bmr, 1800);
  assert.equal(parsed.data.leanMass, 63.5);
  assert.equal(parseImpedance('{"date":"2026-09-15"}').ok, false);
});

test('разбор отчёта ходит через тот же слой с повторами', async () => {
  const provider = stubProvider([{ text: '{"date":"2026-09-15","bmr":1800,"leanMass":63.5}' }]);
  const result = await readImpedance({ provider, image: { base64: 'AAA', mime: 'image/png' } });
  assert.equal(result.ok, true);
  assert.equal(result.data.bmr, 1800);
  assert.equal(provider.calls[0].maxTokens > 0, true);
});

test('сообщение словами уходит одной строкой без снимка', async () => {
  const provider = stubProvider([{ text: validAnswer }]);
  const result = await analyzeChat({ provider, text: 'тарелка борща и два куска хлеба' });

  assert.equal(result.ok, true);
  assert.equal(result.data.items.length, 2);
  assert.equal(provider.calls[0].image, null, 'снимка может не быть');
  assert.equal(provider.calls[0].text, 'тарелка борща и два куска хлеба');
  assert.equal(provider.calls[0].system, CHAT_SYSTEM_PROMPT);
});

test('уточнение уходит вместе с текущим разбором', async () => {
  const draft = {
    dish: 'Борщ', basis: 'per_portion',
    items: [{ name: 'Борщ', grams: 300, kcal: 120, protein: 5, fat: 6, carbs: 10 }],
  };
  const provider = stubProvider([{ text: validAnswer }]);
  await analyzeChat({ provider, text: 'это половина', draft });

  const message = provider.calls[0].text;
  assert.ok(message.includes('Текущий разбор'), 'разбор должен быть передан модели');
  assert.ok(message.includes('Борщ'), 'в переданном разборе видны прежние позиции');
  assert.ok(message.includes('это половина'), 'и новое сообщение человека');
  // Снимок при уточнении не обязателен: слова человека здесь главные.
  assert.equal(provider.calls[0].image, null);
});

test('уточнение со снимком отправляет и снимок, и слова', async () => {
  const provider = stubProvider([{ text: validAnswer }]);
  await analyzeChat({
    provider,
    text: 'соуса не было',
    image: { base64: 'AAA', mime: 'image/jpeg' },
    draft: { dish: 'Паста', items: [] },
  });

  assert.deepEqual(provider.calls[0].image, { base64: 'AAA', mime: 'image/jpeg' });
  assert.ok(provider.calls[0].text.includes('соуса не было'));
});

test('чат-промпт ставит слова человека выше снимка и запрещает начинать заново', () => {
  assert.notEqual(CHAT_SYSTEM_PROMPT, SYSTEM_PROMPT);
  assert.match(CHAT_SYSTEM_PROMPT, /слова человека важнее снимка/i);
  assert.match(CHAT_SYSTEM_PROMPT, /Верни ИЗМЕНЁННЫЙ разбор целиком/);
  assert.match(CHAT_SYSTEM_PROMPT, /Не начинай заново/);
  // Схема ответа общая со снимком: разбирает её тот же код.
  assert.match(CHAT_SYSTEM_PROMPT, /"basis"/);
  assert.match(SYSTEM_PROMPT, /"basis"/);
});
