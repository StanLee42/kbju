// Создание рабочего каталога (worktree) под новую фичу.
//
// Правило репозитория: каждая фича живёт в своей ветке и своём каталоге, а сессия
// открывается в этом каталоге. Каталог ставится внутри репозитория, в `.claude/worktrees/<имя>`:
// там же держит свои ворктри Claude Code, и каталог записан в `.gitignore`. Вложенный каталог
// не мешает проверкам: `node --test` пропускает каталоги, чьё имя начинается с точки.
//
// Часть знаний в новый каталог сама не переезжает, поэтому скрипт закрывает её сразу:
//
// 1. Внегитовые файлы. `.env.local` хранит ключ провайдера, `.misc/` хранит `private-values.txt`
//    (её читает хук коммита), наставления и передачи дел. В git они не лежат и в новый каталог
//    не попадают.
// 2. Свободный порт для сервера. Порт 8766 занимает первый ворктри, второй берёт следующий.
// 3. Проверка хуков. В ворктри они работают без настройки, но проверить это дешевле, чем
//    однажды узнать об отключённой защите.
//
// Запуск: node tools/worktree-new.mjs feat/<имя> [базовая ветка]
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const KINDS = ['ai', 'feat', 'fix', 'docs'];
const BRANCH = new RegExp(`^(${KINDS.join('|')})/[a-z0-9][a-z0-9-]*$`);
const PORT_START = 8766;
const PORT_TRIES = 20;
const UNTRACKED = ['.env.local', '.misc'];
const WORKTREES = '.claude/worktrees';

export function checkBranchName(branch) {
  const kinds = KINDS.map((kind) => `${kind}/<имя>`).join(', ');
  if (typeof branch !== 'string' || !BRANCH.test(branch)) {
    return `Имя ветки «${branch}» не подходит. Нужен вид работы и краткий смысл: ${kinds}.`;
  }
  if (branch.endsWith('-')) {
    return `Имя ветки «${branch}» кончается дефисом.`;
  }
  return null;
}

export function worktreePath(base, branch) {
  return join(base, WORKTREES, branch.split('/')[1]);
}

export function hasWorktreeIgnore(text) {
  return text.split('\n').some((line) => line.trim() === `${WORKTREES}/`);
}

export function isPortFree(port) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.once('listening', () => probe.close(() => done(true)));
    probe.listen(port);
  });
}

export async function firstFreePort(start = PORT_START, tries = PORT_TRIES, free = isPortFree) {
  for (let port = start; port < start + tries; port += 1) {
    if (await free(port)) return port;
  }
  return null;
}

export function copyUntracked(target, source = root) {
  const copied = [];
  const missing = [];
  for (const name of UNTRACKED) {
    const from = join(source, name);
    if (!existsSync(from)) {
      missing.push(name);
      continue;
    }
    cpSync(from, join(target, name), { recursive: true });
    copied.push(name);
  }
  return { copied, missing };
}

function hooksWorkIn(dir) {
  const done = spawnSync('git', ['hook', 'run', 'pre-commit'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return !/cannot find a hook/.test(done.stderr || '');
}

function git(...args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

function ignored() {
  const file = join(root, '.gitignore');
  if (!existsSync(file)) return false;
  return hasWorktreeIgnore(readFileSync(file, 'utf8'));
}

async function main() {
  const branch = process.argv[2];
  const base = process.argv[3] || 'main';

  const problem = checkBranchName(branch);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }

  const dir = worktreePath(root, branch);
  if (existsSync(dir)) {
    console.error(`Каталог уже занят: ${dir}`);
    process.exit(1);
  }
  if (git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).status === 0) {
    console.error(`Ветка ${branch} уже есть. Возьми другое имя ветки.`);
    process.exit(1);
  }
  if (git('rev-parse', '--verify', '--quiet', `refs/heads/${base}`).status !== 0) {
    console.error(`Нет базовой ветки ${base}.`);
    process.exit(1);
  }

  mkdirSync(dirname(dir), { recursive: true });
  const created = spawnSync('git', ['worktree', 'add', '-b', branch, dir, base], {
    cwd: root,
    stdio: 'inherit',
  });
  if (created.status !== 0) {
    process.exit(created.status ?? 1);
  }

  const { copied, missing } = copyUntracked(dir);
  const port = await firstFreePort();
  const hooksWork = hooksWorkIn(dir);

  console.log('\nВорктри готов');
  console.log(`каталог: ${dir}`);
  console.log(`ветка: ${branch} (от ${base})`);
  console.log(`перенесено: ${copied.length ? copied.join(', ') : 'ничего'}`);
  if (missing.length) {
    console.log(`нет в главном каталоге: ${missing.join(', ')}. Перенеси вручную.`);
  }
  console.log(`порт для сервера: ${port ?? 'свободного порта не нашлось, выбери сам'}`);
  console.log(
    hooksWork
      ? 'хуки: на месте, pre-commit отвечает'
      : 'хуки: pre-commit не найден, проверь .githooks',
  );
  if (!ignored()) {
    console.log(`внимание: в .gitignore нет строки ${WORKTREES}/, каталог будет виден как чужой`);
  }
  console.log('\nДальше: открой сессию ZCode в этом каталоге и подними сервер.');
  console.log(`  cd ${dir} && python3 -m http.server ${port ?? PORT_START}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
