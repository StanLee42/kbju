// Собирает папку для публикации: только то, что нужно браузеру.
//
// Запуск: node tools/build-www.mjs [папка-назначения]
//
// Список файлов намеренно задан явно и вручную: так в публикацию не попадёт
// ни ключ из .env.local, ни история git, ни личные материалы из spike/.
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

  const swPath = join(target, 'sw.js');
  const swText = await readFile(swPath, 'utf8');

  // Список файлов для офлайна формируем здесь, а не поддерживаем руками:
  // иначе он неизбежно разойдётся с реальным составом приложения.
  const shell = ['./', ...files.map((file) => `./${file}`)];
  const shellCode = `const SHELL = [\n${shell.map((path) => `  '${path}',`).join('\n')}\n];`;
  const withShell = swText.replace(/const SHELL = \[[\s\S]*?\];/, shellCode);
  if (withShell === swText) {
    console.error('не удалось подставить список файлов в sw.js: константа SHELL не найдена');
    return 1;
  }

  // Имя кэша должно меняться вместе с содержимым. Иначе после публикации новой версии
  // service worker продолжит отдавать старые файлы, и на телефоне ничего не обновится.
  const hash = createHash('sha1');
  for (const file of files) hash.update(await readFile(join(target, file)));
  const version = `kbju-${hash.digest('hex').slice(0, 8)}`;

  const stamped = withShell.replace(/const VERSION = '[^']*'/, `const VERSION = '${version}'`);
  if (stamped === withShell) {
    console.error('не удалось подставить версию в sw.js: константа VERSION не найдена');
    return 1;
  }
  await writeFile(swPath, stamped, 'utf8');
  console.log(`версия сборки: ${version} — кэш обновится при первой загрузке`);
  console.log(`в офлайн-кэш включено файлов: ${shell.length}`);

  // Проверяем, что подставленный список ссылается только на существующие файлы.
  const missing = [];
  for (const path of shell.slice(1)) {
    const info = await stat(join(target, path.slice(2))).catch(() => null);
    if (!info) missing.push(path);
  }
  if (missing.length) {
    console.error('в списке офлайн-кэша есть отсутствующие файлы:');
    for (const path of missing) console.error(`  ${path}`);
    return 1;
  }

  console.log('готово. Перетащите эту папку в https://app.netlify.com/drop');
  return 0;
}

const exitCode = await main();
if (exitCode !== 0) process.exitCode = exitCode;
