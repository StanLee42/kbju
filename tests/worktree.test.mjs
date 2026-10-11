// Проверка скрипта создания ворктри: имя каталога, отбор имени ветки, выбор порта.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

import { checkBranchName, directoryName, firstFreePort, isPortFree } from '../tools/worktree-new.mjs';

test('каталог называется kbju-<имя> и не повторяет вид работы', () => {
  assert.equal(directoryName('ai/my-products'), 'kbju-my-products');
  assert.equal(directoryName('feat/worktree-new'), 'kbju-worktree-new');
  assert.equal(directoryName('fix/build-info'), 'kbju-build-info');
});

test('имя ветки принимает четыре вида работы', () => {
  for (const branch of ['ai/voice', 'feat/x', 'fix/build-info', 'docs/readme-usefulness']) {
    assert.equal(checkBranchName(branch), null, `${branch} должен быть принят`);
  }
});

test('имя ветки отсекает main, пустое имя и выход из каталога', () => {
  const rejected = [
    'main',
    '',
    'feat/',
    'feat/tail-',
    'feat/../evil',
    'feat/Плохое',
    'feat/два-слова',
    'my-products',
    'feat/space here',
  ];
  for (const branch of rejected) {
    assert.ok(checkBranchName(branch), `${branch} должен быть отвергнут`);
  }
});

test('свободный порт берётся первым, занятые пропускаются', async () => {
  const busy = new Set([8766, 8767]);
  assert.equal(await firstFreePort(8766, 20, async (port) => !busy.has(port)), 8768);
});

test('когда свободных портов нет, ответ пустой', async () => {
  assert.equal(await firstFreePort(8766, 3, async () => false), null);
});

test('занятый порт виден, даже когда слушает только IPv6', async () => {
  // Сервер из главного каталога слушает IPv6, поэтому проба должна ловить и его.
  const listener = createServer();
  await new Promise((done) => listener.listen(0, done));
  const port = listener.address().port;
  assert.equal(await isPortFree(port), false);
  await new Promise((done) => listener.close(done));
});
