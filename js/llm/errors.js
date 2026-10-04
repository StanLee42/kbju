// Ошибки провайдера и их перевод в человеческий текст.
//
// Смысл этого файла в том, чтобы наверх, в интерфейс, уходило понятное сообщение,
// а не «HTTP 402». Коды ошибок провайдера меняются, поэтому смотрим и на код ответа,
// и на текст тела.

export const KINDS = {
  key: 'key',
  balance: 'balance',
  limits: 'limits',
  server: 'server',
  network: 'network',
  format: 'format',
  unknown: 'unknown',
};

export function providerError(kind, message, details = {}) {
  const error = new Error(message);
  error.kind = kind;
  error.details = details;
  return error;
}

/** Разбирает ответ провайдера с ошибочным кодом. */
export function classifyHttpStatus(status, body = '') {
  const text = String(body).toLowerCase();
  if (status === 401 || status === 403) return KINDS.key;
  if (status === 402) return KINDS.balance;
  if (status === 429) return KINDS.limits;
  if (status >= 500) return KINDS.server;
  // Иногда провайдер отвечает 400 на исчерпанный баланс.
  if (status === 400 && /insufficient|balance|quota|credit/.test(text)) return KINDS.balance;
  if (/insufficient|balance|quota|credit/.test(text)) return KINDS.balance;
  if (/rate.?limit/.test(text)) return KINDS.limits;
  return KINDS.unknown;
}

const MESSAGES = {
  key: {
    title: 'Провайдер не принял ключ',
    hint: 'Проверьте ключ в настройках: возможно, он отозван или скопирован с пробелом.',
    retryable: false,
  },
  balance: {
    title: 'Закончились средства на счету провайдера',
    hint: 'Пополните баланс в личном кабинете провайдера — и запросы пойдут снова.',
    retryable: false,
  },
  limits: {
    title: 'Провайдер ограничил частоту запросов',
    hint: 'Подождите минуту и повторите: обычно лимит на минуту.',
    retryable: true,
  },
  server: {
    title: 'Провайдер временно недоступен',
    hint: 'Это на их стороне. Попробуйте ещё раз через несколько минут.',
    retryable: true,
  },
  network: {
    title: 'Нет связи с провайдером',
    hint: 'Проверьте интернет на телефоне. Снимок и текст сохранены, попытку можно повторить.',
    retryable: true,
  },
  format: {
    title: 'Модель вернула ответ не по схеме',
    hint: 'Повторите попытку: обычно со второго раза получается.',
    retryable: true,
  },
  unknown: {
    title: 'Провайдер ответил ошибкой',
    hint: 'Подробности ниже. Если повторяется — проверьте ключ и баланс.',
    retryable: false,
  },
};

/** Человеческое описание ошибки для интерфейса. */
export function describeError(error) {
  const kind = error?.kind && MESSAGES[error.kind] ? error.kind : KINDS.unknown;
  const base = MESSAGES[kind];
  return {
    kind,
    title: base.title,
    hint: base.hint,
    retryable: base.retryable,
    details: error?.details?.body
      ? String(error.details.body).slice(0, 400)
      : (error?.message || ''),
  };
}

/** Ошибка сети из fetch приходит с вложенной причиной — достаём её. */
export function normalizeThrown(error) {
  if (error?.kind) return error;
  const cause = error?.cause;
  const code = cause?.code || error?.code || '';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|UND_ERR|FETCH_FAILED|UNABLE_TO_GET_ISSUER/.test(String(code))
    || error?.name === 'TypeError') {
    return providerError(KINDS.network, 'не удалось соединиться с провайдером',
      { body: `${code} ${error?.message || ''}`.trim() });
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return providerError(KINDS.network, 'провайдер не ответил вовремя', { body: 'таймаут запроса' });
  }
  return providerError(KINDS.unknown, error?.message || 'неизвестная ошибка');
}
