// Установка описаний субагентов в пользовательскую папку ZCode.
//
// ZCode читает описания из ~/.zcode/agents/. Символические ссылки он пропускает:
// загрузчик берёт только обычные файлы, поэтому нужна копия. Источник истины лежит
// в репозитории, копия в пользовательской папке — производная. После правки файла
// в репозитории этот скрипт надо запустить снова.
//
// Запуск: node tools/install-zcode-agents.mjs
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '.zcode', 'agents');
const target = join(homedir(), '.zcode', 'agents');

if (!existsSync(source)) {
  console.error(`Нет каталога с описаниями: ${source}`);
  process.exit(1);
}

mkdirSync(target, { recursive: true });

let installed = 0;
for (const name of readdirSync(source)) {
  if (!name.endsWith('.md')) continue;
  const from = join(source, name);
  if (!statSync(from).isFile()) continue;
  const to = join(target, name);
  const existing = existsSync(to) ? statSync(to) : null;
  if (existing?.isSymbolicLink()) {
    unlinkSync(to);
    console.log(`ссылка ${name} убрана: загрузчик читает только обычные файлы`);
  }
  copyFileSync(from, to);
  console.log(`установлен ${name}`);
  installed += 1;
}

if (installed === 0) {
  console.log('описаний для установки нет');
} else {
  console.log(`установлено файлов: ${installed}. Нужна новая сессия: список субагентов читается при запуске.`);
}
