// Проверка распознавания еды через DeepSeek на реальных фотографиях.
//
// Запуск:
//   node tools/spike-deepseek.mjs                 # все файлы из spike/in
//   node tools/spike-deepseek.mjs --limit 3       # первые три
//   node tools/spike-deepseek.mjs путь/к/фото.jpg # конкретные файлы
//
// Ключ берётся из переменной окружения DEEPSEEK_API_KEY или из .env.local
// в корне репозитория. В консоль ключ не печатается.
//
// Сырые ответы модели складываются в spike/out — по ним потом правится промпт.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.deepseek.com/chat/completions';

// Node на этой машине не доверяет сертификатам: его встроенное хранилище корней пустое,
// а браузера это не касается. Поэтому при первом запуске выгружаем системные корни macOS
// и перезапускаем себя же с переменной NODE_EXTRA_CA_CERTS. Без этого запрос падает
// с ошибкой UNABLE_TO_GET_ISSUER_CERT_LOCALLY.
if (!process.env.NODE_EXTRA_CA_CERTS && !process.env.KBJU_CA_RETRY && process.platform === 'darwin') {
  const { execFileSync } = await import('node:child_process');
  const bundlePath = '/tmp/kbju-macos-roots.pem';
  const parts = [];
  for (const keychain of [
    '/System/Library/Keychains/SystemRootCertificates.keychain',
    '/Library/Keychains/System.keychain',
  ]) {
    try {
      parts.push(execFileSync('security', ['find-certificate', '-a', '-p', keychain], { encoding: 'utf8' }));
    } catch {
      // Недоступная связка — не повод останавливаться.
    }
  }
  if (parts.join('').includes('BEGIN CERTIFICATE')) {
    await writeFile(bundlePath, parts.join(''), 'utf8');
    const exitCode = await new Promise((resolveExit) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: { ...process.env, NODE_EXTRA_CA_CERTS: bundlePath, KBJU_CA_RETRY: '1' },
      });
      child.on('exit', (code) => resolveExit(code ?? 0));
    });
    process.exit(exitCode);
  }
}

// Тариф на момент проверки. Это предположение, а не факт: перед выводами
// о деньгах цены нужно сверить на странице тарифов DeepSeek.
const PRICES = {
  currency: 'USD',
  inputCacheMiss: 0.15, // за 1M токенов, непиковые часы
  inputCacheHit: 0.02,
  output: 1.1,
};

const PROMPTS = {
  food: {
    system: `Ты нутрициолог-ассистент личного дневника питания. На вход приходит фотография.

Если на фотографии видна таблица пищевой ценности (упаковка, этикетка) — бери значения строго
из неё, ничего не додумывай, и пометь источник как "label". Пересчитывай с указанного
в таблице количества (обычно на 100 г) на реальную порцию, если она известна; если порция
неизвестна, верни значения на 100 г и укажи это в assumptions.

Если на фотографии тарелка или блюдо — оцени состав и вес по видимым ориентирам (посуда,
приборы, рука) и пометь источник как "estimate".

Отвечай строго JSON без пояснений вокруг, по схеме:
{
  "dish": "краткое название того, что на фото",
  "source": "label" | "estimate",
  "items": [{"name": "строка", "grams": число, "kcal": число, "protein": число, "fat": число, "carbs": число}],
  "confidence": "high" | "medium" | "low",
  "assumptions": "короткое пояснение, что учтено и что не видно"
}`,
    user: 'Разбери, что на фотографии, и верни КБЖУ по схеме.',
  },
  impedance: {
    system: `Ты помогаешь разобрать отчёт биоимпедансного анализа состава тела.

Извлеки из отчёта только измерения и верни строго JSON по схеме:
{
  "date": "дата измерения в виде YYYY-MM-DD",
  "sex": "M" | "F",
  "age": число,
  "height": число,
  "weight": число,
  "waist": число,
  "hips": число,
  "bmi": число,
  "fatMass": число,
  "leanMass": число,
  "activeCellMass": число,
  "skeletalMuscleMass": число,
  "totalWater": число,
  "extracellularWater": число,
  "boneMineralMass": число,
  "bmr": число,
  "fatPercent": число,
  "confidence": "high" | "medium" | "low",
  "assumptions": "что не удалось прочитать"
}

Все числа — в килограммах и килокалориях, кроме роста в сантиметрах, возраста в годах
и ИМТ. Ничего не додумывай: чего нет в отчёте — null. Если строк несколько, бери значение
из колонки «факт», а не из границ нормы.`,
    user: 'Извлеки измерения из этого отчёта по схеме. Отвечай кратко: assumptions — не больше одного предложения.',
  },
  norms: {
    system: `Ты помогаешь рассчитать нормы КБЖУ по составу тела.

На вход приходят измерения состава тела. Рассчитай:
- белок: 1,6–2,2 г на килограмм тощей (безжировой) массы, возьми середину диапазона;
- жир: не ниже 0,8–1 г на килограмм массы тела;
- калории: измеренный основной обмен умножить на коэффициент активности и вычесть дефицит
  под темп снижения веса 0,5 кг в неделю (ориентировочно 550 ккал в сутки);
- углеводы: остаток калорий после белков и жиров (1 г белка и 1 г углеводов — 4 ккал,
  1 г жира — 9 ккал).

Верни строго JSON по схеме:
{
  "kcal": число, "protein": число, "fat": число, "carbs": число,
  "activityFactor": число,
  "calculation": "расчёт по шагам, коротко",
  "confidence": "high" | "medium" | "low",
  "assumptions": "чего не хватило для расчёта"
}`,
    user: 'Рассчитай нормы КБЖУ по этим измерениям. Отвечай кратко: calculation — не больше четырёх строк, assumptions — не больше одного предложения.',
  },
};



function readKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  return null;
}

async function readKeyFromEnvFile() {
  const text = await readFile(join(root, '.env.local'), 'utf8').catch(() => '');
  const match = text.match(/^\s*DEEPSEEK_API_KEY\s*=\s*(.+)$/m);
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
}

function parseArgs(argv) {
  const files = [];
  let limit = Infinity;
  let prompt = 'food';
  let text = null;
  let maxTokens = 1600;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') limit = Number(argv[++i]) || Infinity;
    else if (argv[i] === '--prompt') prompt = argv[++i];
    else if (argv[i] === '--text') text = argv[++i];
    else if (argv[i] === '--max-tokens') maxTokens = Number(argv[++i]) || 1600;
    else files.push(argv[i]);
  }
  return { files, limit, prompt, text, maxTokens };
}

async function collect(paths) {
  if (paths.length) return paths.map((path) => resolve(path));
  const dir = join(root, 'spike', 'in');
  const entries = await readdir(dir).catch(() => []);
  return entries
    .filter((name) => /\.(jpe?g|png|webp|gif)$/i.test(name))
    .sort()
    .map((name) => join(dir, name));
}

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif',
};

async function askModel(key, { path = null, text = null, prompt = 'food', maxTokens = 1600 } = {}) {
  const chosen = PROMPTS[prompt] || PROMPTS.food;
  const content = [{ type: 'text', text: chosen.user }];

  if (path) {
    const image = await readFile(path);
    const mime = MIME[extname(path).toLowerCase()] || 'image/jpeg';
    content.push({
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${image.toString('base64')}` },
    });
  }
  if (text) content.push({ type: 'text', text });

  const body = {
    model: 'deepseek-flash',
    messages: [
      { role: 'system', content: chosen.system },
      { role: 'user', content },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    // DeepSeek-flash — рассуждающая модель: она сначала пишет внутренние размышления
    // (reasoning_content, они тоже тарифицируются как выходные токены), и только потом
    // ответ. Если лимит мал, размышления съедают его целиком, а content приходит пустым.
    max_tokens: maxTokens,
  };

  const response = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });

  const raw = await response.text();
  if (!response.ok) {
    return { error: `HTTP ${response.status}`, raw: raw.slice(0, 900) };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'ответ не разобрался как JSON', raw: raw.slice(0, 900) };
  }

  const finishReason = parsed?.choices?.[0]?.finish_reason;
  const answerText = parsed?.choices?.[0]?.message?.content;
  const reasoning = parsed?.choices?.[0]?.message?.reasoning_content || '';
  let data = null;
  try {
    data = JSON.parse(answerText);
  } catch {
    // Модель может обернуть JSON в текст — это и есть тот случай, ради которого
    // в плане предусмотрена валидация с повторной попыткой.
  }

  return { parsed, data, usage: parsed?.usage || {}, finishReason, reasoningLength: reasoning.length };
}

function money(tokens, pricePerMillion) {
  return ((tokens / 1_000_000) * pricePerMillion);
}

function summarize(usage) {
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, input - hit);
  const cost = money(miss, PRICES.inputCacheMiss) + money(hit, PRICES.inputCacheHit)
    + money(output, PRICES.output);
  return { input, output, hit, miss, cost };
}

async function main() {
  const key = readKey() || await readKeyFromEnvFile();
  if (!key) {
    console.error('нет ключа: заполните .env.local или задайте DEEPSEEK_API_KEY');
    return 1;
  }

  const { files, limit, prompt, text, maxTokens } = parseArgs(process.argv.slice(2));
  const paths = text ? [null] : (await collect(files)).slice(0, limit);
  if (!paths.length) {
    console.error('нет файлов для проверки');
    return 1;
  }

  await mkdir(join(root, 'spike', 'out'), { recursive: true });

  const rows = [];
  let totalCost = 0;

  for (const path of paths) {
    const name = path ? path.split('/').pop() : 'отчёт текстом (без изображения)';
    process.stdout.write(`\n${name}\n`);
    const result = await askModel(key, { path, text, prompt, maxTokens });

    if (result.error) {
      console.log(`  ошибка: ${result.error}`);
      console.log(`  ответ сервера: ${result.raw}`);
      rows.push({ name, error: result.error });
      continue;
    }

    const data = result.data;
    if (!data) {
      console.log('  модель вернула не JSON, сырой ответ в spike/out');
    } else if (Array.isArray(data.items)) {
      const items = data.items;
      const totals = items.reduce((acc, item) => ({
        kcal: acc.kcal + (Number(item.kcal) || 0),
        protein: acc.protein + (Number(item.protein) || 0),
        fat: acc.fat + (Number(item.fat) || 0),
        carbs: acc.carbs + (Number(item.carbs) || 0),
      }), { kcal: 0, protein: 0, fat: 0, carbs: 0 });

      console.log(`  ${data.dish || '(без названия)'} · источник: ${data.source || '?'} · уверенность: ${data.confidence || '?'}`);
      for (const item of items) {
        console.log(`    ${item.name}: ${item.grams} г, ${item.kcal} ккал, Б${item.protein} Ж${item.fat} У${item.carbs}`);
      }
      console.log(`  итого: ${Math.round(totals.kcal)} ккал · Б ${Math.round(totals.protein)} · Ж ${Math.round(totals.fat)} · У ${Math.round(totals.carbs)}`);
      if (data.assumptions) console.log(`  допущения: ${data.assumptions}`);

      rows.push({ name, dish: data.dish, totals });
    } else {
      // Отчёт биоимпеданса: плоский набор измерений.
      const skip = new Set(['confidence', 'assumptions']);
      const pairs = Object.entries(data)
        .filter(([key, value]) => !skip.has(key) && value !== null && value !== undefined)
        .map(([key, value]) => `${key}: ${value}`);
      console.log(`  ${pairs.join(' · ')}`);
      console.log(`  уверенность: ${data.confidence || '?'}`);
      if (data.assumptions) console.log(`  допущения: ${data.assumptions}`);
      rows.push({ name, measurements: data });
    }

    const u = summarize(result.usage);
    totalCost += u.cost;
    const reasoningNote = result.reasoningLength
      ? `, из них размышлений ${result.reasoningLength} символов`
      : '';
    console.log(`  токены: вход ${u.input} (кэш ${u.hit}, промах ${u.miss}), выход ${u.output}${reasoningNote} · оценка ${u.cost.toFixed(5)} $`);
    if (result.finishReason && result.finishReason !== 'stop') {
      console.log(`  внимание: ответ оборван, finish_reason = ${result.finishReason}. Увеличьте --max-tokens.`);
    }

    await writeFile(
      join(root, 'spike', 'out', `${path ? name : 'report-text'}.json`),
      JSON.stringify({ file: name, usage: result.usage, data, raw: result.parsed }, null, 2),
      'utf8',
    );
  }

  console.log(`\nразобрано файлов: ${rows.length}`);
  console.log(`оценка стоимости всего прогона: ${totalCost.toFixed(4)} $ (цены предположенные, требуют сверки)`);
  if (rows.length) {
    console.log(`средняя стоимость одного снимка: ${(totalCost / rows.length).toFixed(5)} $`);
  }
  return 0;
}

const code = await main();
if (code !== 0) process.exitCode = code;
