// Адаптер DeepSeek. Один ключ на текст, фото и поиск, поэтому здесь же живут
// и запросы баланса.
import { KINDS, classifyHttpStatus, normalizeThrown, providerError } from './errors.js';

const API_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-flash';
const TIMEOUT_MS = 180000;

export function createDeepSeek({ apiKey, model = DEFAULT_MODEL, baseUrl = API_BASE } = {}) {
  async function request(path, { method = 'GET', body = null } = {}) {
    if (!apiKey) throw providerError(KINDS.key, 'ключ провайдера не задан');

    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw normalizeThrown(error);
    }

    const text = await response.text();
    if (!response.ok) {
      const kind = classifyHttpStatus(response.status, text);
      throw providerError(kind, `провайдер ответил ${response.status}`, {
        status: response.status,
        body: text,
      });
    }

    try {
      return JSON.parse(text);
    } catch {
      throw providerError(KINDS.format, 'ответ провайдера не разобрался как JSON', { body: text });
    }
  }

  return {
    id: 'deepseek',
    label: 'DeepSeek',
    supportsImage: true,
    supportsAudio: false,

    /**
     * Один запрос к модели.
     * @returns {Promise<{text: string, reasoningLength: number, usage: object, finishReason: string|null}>}
     */
    async chat({ system, user, image = null, text = null, maxTokens = 1600, temperature = 0 }) {
      const content = [{ type: 'text', text: user }];

      if (image) {
        if (!image.base64 || !image.mime) {
          throw providerError(KINDS.format, 'изображение передано без данных или типа');
        }
        content.push({
          type: 'image_url',
          image_url: { url: `data:${image.mime};base64,${image.base64}` },
        });
      }
      if (text) content.push({ type: 'text', text });

      const data = await request('/chat/completions', {
        method: 'POST',
        body: {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content },
          ],
          response_format: { type: 'json_object' },
          temperature,
          // Рассуждающая модель тратит выходные токены на размышления до ответа,
          // поэтому лимит должен быть с запасом, иначе content придёт пустым.
          max_tokens: maxTokens,
        },
      });

      const choice = data?.choices?.[0];
      return {
        text: choice?.message?.content ?? '',
        reasoningLength: (choice?.message?.reasoning_content || '').length,
        usage: data?.usage ?? {},
        finishReason: choice?.finish_reason ?? null,
      };
    },

    /** Остаток на счету: официальный эндпоинт провайдера. */
    async balance() {
      const data = await request('/user/balance');
      const info = Array.isArray(data?.balance_infos) ? data.balance_infos[0] : null;
      if (!info) return null;
      return {
        available: Boolean(data?.is_available),
        currency: info.currency || '',
        total: Number(info.total_balance) || 0,
        granted: Number(info.granted_balance) || 0,
        toppedUp: Number(info.topped_up_balance) || 0,
      };
    },
  };
}
