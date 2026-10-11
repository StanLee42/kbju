// Проверка сторожа коммита: он судит по тому каталогу, куда идёт коммит, а не по каталогу
// вызова. В ворктри это разные каталоги, и раньше сторож видел ветку main там, где её нет.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const guard = join(root, '.zcode', 'hooks', 'commit-guard.py');

function runGuard(command, { cwd = root, values = '' } = {}) {
  const env = { ...process.env };
  if (values) env.KBJU_VALUES_FILE = values;
  else delete env.KBJU_VALUES_FILE;
  try {
    execFileSync('python3', [guard, 'zcode'], {
      cwd,
      input: JSON.stringify({ tool_input: { command } }),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stderr: '' };
  } catch (error) {
    return { code: error.status, stderr: String(error.stderr) };
  }
}

// Каталог-проба: свой рабочий каталог, своя ветка, один начальный коммит.
function repo(branch, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kbju-guard-'));
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-C',
        dir,
        '-c',
        'user.name=Проба',
        '-c',
        'user.email=proba@example.com',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { stdio: 'pipe' },
    );
  git('init', '-q', '-b', branch);
  writeFileSync(join(dir, 'NOTE.md'), 'проба\n');
  git('add', 'NOTE.md');
  git('commit', '-q', '-m', 'начало');
  for (const [name, text] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
    git('add', name);
  }
  return dir;
}

test('коммит в main блокируется', () => {
  const main = repo('main');
  const done = runGuard('git commit -m "правка"', { cwd: main });
  assert.equal(done.code, 2, done.stderr);
  assert.match(done.stderr, /прямой коммит в main/);
});

test('коммит в соседний каталог проходит, даже когда зовут из main', () => {
  const main = repo('main');
  const feature = repo('feat/x');
  const done = runGuard(`cd ${feature} && git commit -m "правка"`, { cwd: main });
  assert.equal(done.code, 0, done.stderr);
});

test('ключ -C тоже называет каталог коммита', () => {
  const main = repo('main');
  const feature = repo('feat/x');
  assert.equal(runGuard(`git -C ${feature} commit -m "правка"`, { cwd: main }).code, 0);
});

test('коммит в main через -C блокируется, даже когда зовут из рабочей ветки', () => {
  const feature = repo('feat/x');
  const main = repo('main');
  const done = runGuard(`git -C ${main} commit -m "правка"`, { cwd: feature });
  assert.equal(done.code, 2, done.stderr);
  assert.match(done.stderr, /прямой коммит в main/);
});

test('персональные данные ищутся в каталоге коммита, а не в каталоге вызова', () => {
  const main = repo('main');
  const feature = repo('feat/x', { 'data.md': 'вес 123.5 кг\n' });
  writeFileSync(join(feature, '.misc-values.txt'), '123.5\n');
  const done = runGuard(`cd ${feature} && git commit -m "правка"`, {
    cwd: main,
    values: join(feature, '.misc-values.txt'),
  });
  assert.equal(done.code, 2, done.stderr);
  assert.match(done.stderr, /персональные данные/);
});

test('значения из каталога коммита читаются и без переменной окружения', () => {
  const main = repo('main');
  const feature = repo('feat/x', { 'data.md': 'вес 123.5 кг\n' });
  mkdirSync(join(feature, '.misc'), { recursive: true });
  writeFileSync(join(feature, '.misc', 'private-values.txt'), '123.5\n');
  const done = runGuard(`cd ${feature} && git commit -m "правка"`, { cwd: main });
  assert.equal(done.code, 2, done.stderr);
  assert.match(done.stderr, /персональные данные/);
});

test('чужая команда не проверяется как коммит', () => {
  const main = repo('main');
  assert.equal(runGuard('git status --short', { cwd: main }).code, 0);
});
