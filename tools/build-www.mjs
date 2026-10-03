// Собирает папку для публикации: только то, что нужно браузеру.
//
// Запуск: node tools/build-www.mjs [папка-назначения]
//
// Список файлов намеренно задан явно и вручную: так в публикацию не попадёт
// ни ключ из .env.local, ни история git, ни личные материалы из spike/.
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(process.argv[2] || join(root, 'dist'));

const ITEMS = ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons'];

// Файлы, которых в публикации быть не должно ни при каких условиях.
const FORBIDDEN = [/^\.env/, /\.key$/, /^\.git/, /secret/i];

async function walk(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full, base));
    else files.push(relative(base, full));
  }
  return files;
}

async function main() {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  for (const item of ITEMS) {
    const from = join(root, item);
    const to = join(target, item);
    const info = await stat(from).catch(() => null);
    if (!info) {
      console.error(`нет файла: ${item}`);
      return 1;
    }
    await cp(from, to, { recursive: true });
  }

  const files = (await walk(target)).sort();
  console.log(`собрано файлов: ${files.length} -> ${target}`);

  const forbidden = files.filter((file) => FORBIDDEN.some((pattern) => pattern.test(file)));
  if (forbidden.length) {
    console.error('В ПУБЛИКАЦИЮ ПОПАЛО ЛИШНЕЕ:');
    for (const file of forbidden) console.error(`  ${file}`);
    return 1;
  }

  // Service worker кэширует список файлов: если путь в нём опечатан,
  // установка приложения на телефон сломается. Проверяем заранее.
  const sw = await readFile(join(target, 'sw.js'), 'utf8');
  const shell = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  if (!shell) {
    console.error('в sw.js не найден список SHELL');
    return 1;
  }
  const paths = [...shell[1].matchAll(/'([^']+)'/g)]
    .map((match) => match[1])
    .filter((path) => path !== './');

  const missing = [];
  for (const path of paths) {
    const info = await stat(join(target, path)).catch(() => null);
    if (!info) missing.push(path);
  }
  if (missing.length) {
    console.error('service worker ссылается на отсутствующие файлы:');
    for (const path of missing) console.error(`  ${path}`);
    return 1;
  }

  console.log(`service worker: все ${paths.length} путей на месте`);
  console.log('готово. Перетащите эту папку в https://app.netlify.com/drop');
  return 0;
}

const exitCode = await main();
if (exitCode !== 0) process.exitCode = exitCode;
