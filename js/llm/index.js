// Слой провайдеров: единая точка входа для анализа фото и разбора отчётов.
//
// Наружу отсюда уходят только два вида результатов: разобранные данные либо понятная ошибка.
// Никаких «HTTP 402» в интерфейс не попадает.
import { createDeepSeek } from './deepseek.js';
import { KINDS, describeError, normalizeThrown, providerError } from './errors.js';
import { parseAnalysis, parseImpedance } from './parse.js';
import {
  IMPEDANCE_SYSTEM_PROMPT, IMPEDANCE_USER_PROMPT,
  MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS_RETRY,
  SYSTEM_PROMPT, USER_PROMPT,
  VOICE_SYSTEM_PROMPT, VOICE_USER_PROMPT,
} from './prompt.js';

export { KINDS, describeError } from './errors.js';

const ADAPTERS = {
  deepseek: createDeepSeek,
};

export const AVAILABLE_PROVIDERS = Object.keys(ADAPTERS);

/** Собирает адаптер по настройкам приложения. */
export function createProvider(settings = {}) {
  const id = settings.provider || 'deepseek';
  const factory = ADAPTERS[id];
  if (!factory) throw providerError(KINDS.unknown, `провайдер «${id}» не подключён`);
  return factory({ apiKey: settings.providerKey || settings.apiKey, model: settings.model });
}

function formatError(details) {
  return { kind: KINDS.format, title: 'Модель вернула ответ не по схеме', hint: 'Повторяем попытку.', retryable: true, details };
}

/**
 * Запрос с одной повторной попыткой.
 *
 * Повтор нужен в трёх случаях: ответ не разобрался как JSON, ответ оборвался по лимиту
 * вывода (у рассуждающей модели размышления съедают бюджет) и временная ошибка сети
 * или лимитов провайдера. Все попытки возвращаются в виде списка расходов, чтобы
 * журнал учёл каждую.
 */
async function runWithRetry({ provider, system, user, image, text, parse }) {
  const usages = [];
  const attempts = [];
  let maxTokens = MAX_OUTPUT_TOKENS;
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response;
    try {
      response = await provider.chat({ system, user, image, text, maxTokens });
    } catch (error) {
      const described = describeError(normalizeThrown(error));
      attempts.push({ attempt, failed: described.kind });
      lastError = described;
      if (!described.retryable) break;
      continue;
    }

    usages.push(response.usage);
    attempts.push({ attempt, finishReason: response.finishReason, reasoning: response.reasoningLength });

    const parsed = parse(response.text);
    if (parsed.ok) {
      return { ok: true, data: parsed.data, usages, attempts };
    }

    if (response.finishReason === 'length') {
      // Не битый ответ, а нехватка бюджета на размышления: поднимаем лимит и повторяем.
      maxTokens = MAX_OUTPUT_TOKENS_RETRY;
      lastError = {
        ...formatError('finish_reason: length — модель не успела выдать ответ'),
        hint: 'Лимит вывода увеличен, повторяем запрос.',
      };
      continue;
    }

    lastError = { ...formatError(parsed.error), details: parsed.error };
  }

  return {
    ok: false,
    error: lastError || describeError(providerError(KINDS.unknown, 'запрос не выполнен')),
    usages,
    attempts,
  };
}

export async function analyzeFood({ provider, image = null, text = null }) {
  return runWithRetry({
    provider, system: SYSTEM_PROMPT, user: USER_PROMPT, image, text, parse: parseAnalysis,
  });
}

/** То же самое, но по сказанной вслух фразе: снимка нет, вес часто назван словами. */
export async function analyzeSpoken({ provider, text }) {
  return runWithRetry({
    provider, system: VOICE_SYSTEM_PROMPT, user: VOICE_USER_PROMPT, image: null, text, parse: parseAnalysis,
  });
}

export async function readImpedance({ provider, image = null, text = null }) {
  return runWithRetry({
    provider,
    system: IMPEDANCE_SYSTEM_PROMPT,
    user: IMPEDANCE_USER_PROMPT,
    image,
    text,
    parse: parseImpedance,
  });
}
