// Проверка разбора ответов модели и логики повторов.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KINDS, analyzeChat, analyzeFood, discussNorms, readImpedance, readProduct } from '../js/llm/index.js';
import { providerError } from '../js/llm/errors.js';
import { extractJson, parseAnalysis, parseImpedance, parseNorms, parseProduct } from '../js/llm/parse.js';
import {
  CHAT_SYSTEM_PROMPT, NORMS_SYSTEM_PROMPT, PRODUCT_SYSTEM_PROMPT, SYSTEM_PROMPT,
} from '../js/llm/prompt.js';

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

// Ответ по снимку упаковки: таблица напечатана на порцию 30 г, а не на 100 г.
const productAnswer = JSON.stringify({
  name: 'Творог 5%',
  source: 'label',
  basisGrams: 30,
  kcal: 60,
  protein: 9,
  fat: 2.5,
  carbs: 2,
  packageWeight: 300,
  confidence: 'high',
  assumptions: 'Значения взяты с таблицы на порцию.',
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

test('измерения из отчёта разбираются, пустой ответ это ошибка', () => {
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
  // Сообщение уходит помеченным: модель должна понимать, где её слова, а где человека.
  assert.ok(provider.calls[0].text.includes('тарелка борща и два куска хлеба'));
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

test('вопрос без позиций это ответ, а не ошибка', () => {
  // Так бывает в начале разговора: человек сказал слишком мало, считать пока нечего.
  const parsed = parseAnalysis(JSON.stringify({
    dish: '', items: [], question: 'А что именно вы съели?',
    confidence: 'low', assumptions: '',
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.question, 'А что именно вы съели?');
  assert.equal(parsed.data.items.length, 0);
});

test('ответ без вопроса оставляет поле пустым', () => {
  const parsed = parseAnalysis(validAnswer);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.question, null);
});

test('уточняющий вопрос разбирается и обрезается', () => {
  const withQuestion = JSON.stringify({
    dish: 'Гречка с котлетой',
    source: 'estimate',
    basis: 'per_portion',
    items: [{ name: 'Гречка', grams: 200, kcal: 220, protein: 8, fat: 2, carbs: 40 }],
    question: '  Сколько примерно было гречки, граммов двести?  ',
    confidence: 'low',
    assumptions: 'Вес оценён.',
  });
  const parsed = parseAnalysis(withQuestion);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.question, 'Сколько примерно было гречки, граммов двести?');
  // Разбор при вопросе всё равно приходит целиком: его видно, пока идёт разговор.
  assert.equal(parsed.data.items.length, 1);
});

test('разговор до этого уходит модели целиком', async () => {
  const provider = stubProvider([{ text: validAnswer }]);
  await analyzeChat({
    provider,
    text: 'граммов двести',
    draft: { dish: 'Гречка', items: [] },
    history: [
      { role: 'user', text: 'поел гречки с котлетой' },
      { role: 'assistant', text: 'Сколько примерно было гречки?' },
    ],
  });

  const message = provider.calls[0].text;
  assert.ok(message.includes('Разговор до этого'), 'история должна быть передана');
  assert.ok(message.includes('поел гречки с котлетой'));
  assert.ok(message.includes('Сколько примерно было гречки?'), 'вопрос модели тоже в истории');
  assert.ok(message.includes('Новое сообщение человека: граммов двести'));
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
  assert.match(CHAT_SYSTEM_PROMPT, /верни ИЗМЕНЁННЫЙ/i);
  assert.match(CHAT_SYSTEM_PROMPT, /Не начинай заново/);
  // Вопрос задаётся только тогда, когда меняет числа, и только один.
  assert.match(CHAT_SYSTEM_PROMPT, /только тогда, когда ответ изменит числа/);
  assert.match(CHAT_SYSTEM_PROMPT, /Спрашивай ОДНО/);
  assert.match(CHAT_SYSTEM_PROMPT, /"question"/);
  // Схема ответа общая со снимком: разбирает её тот же код.
  assert.match(CHAT_SYSTEM_PROMPT, /"basis"/);
  assert.match(SYSTEM_PROMPT, /"basis"/);
});

test('ответ о нормах разбирается: рычаги и измерения', () => {
  const answer = JSON.stringify({
    measurement: { sex: 'M', age: 41, height: 176, weight: 82, leanMass: 63.5, bmr: 1800 },
    params: { pace: 0.5, activityRest: 1.375, proteinPerKgLean: 1.9, fatPerKgMin: 0.8,
      fatPerKgTraining: 0.9, trainingExtraKcal: 400, deficitShareTraining: 0.7 },
    comment: 'Оставил как было, только белок чуть ниже.',
    question: null,
    confidence: 'medium',
  });
  const parsed = parseNorms(answer);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.params.pace, 0.5);
  assert.equal(parsed.data.measurement.leanMass, 63.5);
  assert.equal(parsed.data.measurement.sex, 'M');
  assert.match(parsed.data.comment, /белок/);
  assert.equal(parsed.data.warnings.length, 0);
});

test('рычаги за разумными границами приводятся к границе и это отмечается', () => {
  const answer = JSON.stringify({
    params: { pace: 4, activityRest: 0.4, proteinPerKgLean: 9 },
    comment: 'агрессивно', question: null, confidence: 'low',
  });
  const parsed = parseNorms(answer);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.params.pace, 1.5, 'темп приведён к верхней границе');
  assert.equal(parsed.data.params.activityRest, 1.1, 'активность приведена к нижней границе');
  assert.equal(parsed.data.params.proteinPerKgLean, 3);
  assert.equal(parsed.data.warnings.length, 3);
});

test('ответ без рычагов считается ошибкой: считать нормы не из чего', () => {
  assert.equal(parseNorms(JSON.stringify({ comment: 'ага', params: {} })).ok, false);
  assert.equal(parseNorms('не json').ok, false);
});

test('разговор о нормах передаёт модели текущие рычаги и историю', async () => {
  const provider = stubProvider([{ text: '{}' }]);
  const result = await discussNorms({
    provider,
    text: 'тренер считает, что завышено',
    current: { pace: 0.5, activityRest: 1.375, restKcal: 2222 },
    history: [{ role: 'user', text: 'смотри отчёт' }],
  });
  assert.equal(result.ok, false, 'пустой ответ разбор не проходит');
  const message = provider.calls[0].text;
  assert.ok(message.includes('Текущие нормы'), 'текущие рычаги переданы');
  assert.ok(message.includes('2222'), 'видно текущие калории');
  assert.ok(message.includes('тренер считает'));
  assert.equal(provider.calls[0].system, NORMS_SYSTEM_PROMPT);
});

test('промпт про нормы запрещает модели считать числа самой', () => {
  assert.match(NORMS_SYSTEM_PROMPT, /НЕ считаешь калории и БЖУ сам/);
  assert.match(NORMS_SYSTEM_PROMPT, /"params"/);
  assert.match(NORMS_SYSTEM_PROMPT, /pace/);
});

test('ответ по снимку упаковки разбирается целиком', () => {
  const parsed = parseProduct(productAnswer);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.name, 'Творог 5%');
  assert.equal(parsed.data.basisGrams, 30, 'граммовка таблицы сохранена для пересчёта');
  assert.equal(parsed.data.values.kcal, 60);
  assert.equal(parsed.data.values.fat, 2.5);
  assert.equal(parsed.data.packageWeight, 300);
  assert.equal(parsed.data.hasNumbers, true);
  assert.deepEqual(parsed.data.warnings, []);
});

test('вопрос без значений это ответ, а не ошибка', () => {
  // Таблица не попала в кадр: считать нечего, но разбор не сломан.
  const parsed = parseProduct(JSON.stringify({ question: 'Таблица не в кадре, пришлите ещё раз' }));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.hasNumbers, false);
  assert.match(parsed.data.question, /ещё раз/);
});

test('ответ без значений и без вопроса считается ошибкой', () => {
  assert.equal(parseProduct(JSON.stringify({ name: 'Творог' })).ok, false);
  assert.equal(parseProduct('не json').ok, false);
});

test('граммовка не пришла: значения считаются на 100 г, и это отмечено', () => {
  const parsed = parseProduct(JSON.stringify({
    name: 'Овсяные хлопья', kcal: 350, protein: 12, fat: 6, carbs: 60,
  }));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.basisGrams, 100);
  assert.ok(parsed.data.warnings.some((warning) => warning.includes('граммовка')),
    'замечание о граммовке человек видит в разборе');
});

test('минус в значениях отсекается, а пустое название попадает в замечания', () => {
  const parsed = parseProduct(JSON.stringify({ name: '', kcal: -20, protein: 5 }));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.values.kcal, 0);
  assert.ok(parsed.data.warnings.some((warning) => warning.includes('название')),
    'без названия продукт не сохранить, и об этом сказано');
});

test('разбор упаковки ходит через тот же слой с повторами', async () => {
  const provider = stubProvider([{ text: productAnswer }]);
  const result = await readProduct({
    provider,
    image: { base64: 'AAA', mime: 'image/png' },
    text: 'это творог',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.name, 'Творог 5%');
  assert.equal(provider.calls[0].system, PRODUCT_SYSTEM_PROMPT);
  assert.equal(provider.calls[0].image.mime, 'image/png');
  assert.ok(provider.calls[0].text.includes('это творог'), 'слова человека уходят модели');
  assert.equal(provider.calls[0].maxTokens > 0, true);
});

test('уточнение к упаковке уходит вместе с прочитанным', async () => {
  const draft = { name: 'Творог 5%', basisGrams: 30, values: { kcal: 60 } };
  const provider = stubProvider([{ text: productAnswer }]);
  await readProduct({ provider, text: 'это на порцию 30 г', draft });

  const message = provider.calls[0].text;
  assert.ok(message.includes('Что уже прочитано'), 'прочитанное передано модели');
  assert.ok(message.includes('Творог 5%'), 'видно прежнее название');
  assert.ok(message.includes('это на порцию 30 г'), 'и новое сообщение человека');
});

test('промпт разбора упаковки требует граммовку и запрещает подставлять чужие числа', () => {
  assert.match(PRODUCT_SYSTEM_PROMPT, /basisGrams/);
  assert.match(PRODUCT_SYSTEM_PROMPT, /без пересчёта/);
  assert.match(PRODUCT_SYSTEM_PROMPT, /не подставляй из похожих/);
  assert.match(PRODUCT_SYSTEM_PROMPT, /"name"/);
});
