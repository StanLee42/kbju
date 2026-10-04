// Образцы русской речи для проверки распознавания.
//
// Сами записи в репозиторий не попадают: они лежат в spike/voice (папка вне гита).
// Здесь они и делаются — синтезатором речи macOS, поэтому числа качества, записанные
// в openspec, всегда можно перепроверить на тех же самых фразах.
//
// Запуск (нужен macOS: используются say и afconvert):
//   node tools/make-voice-samples.mjs
//
// Фразы выбраны такими, какие человек говорит про еду: с числами, названиями блюд
// и перечислением — именно на них видно, путает ли модель названия.
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'spike', 'voice');

const VOICE = process.env.SAY_VOICE || 'Milena';
const PHRASES = [
  { file: 's1.wav', text: 'Два яйца и кофе с молоком' },
  { file: 's2.wav', text: 'Съел двести граммов куриной грудки и порцию гречки' },
  { file: 's3.wav', text: 'На завтрак овсянка с бананом, на обед борщ, вечером творог' },
];

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (process.platform !== 'darwin') {
    console.error('сборка образцов доступна только на macOS: нужны say и afconvert');
    return 1;
  }
  await mkdir(dir, { recursive: true });

  const manifest = [];
  for (const phrase of PHRASES) {
    const target = join(dir, phrase.file);
    const raw = join(dir, `${phrase.file}.aiff`);

    if (await exists(target)) {
      console.log(`уже есть: ${phrase.file}`);
    } else {
      // Синтез в файл, затем приведение к тому, что ждёт распознавание: моно 16 кГц.
      await run('say', ['-v', VOICE, '-o', raw, phrase.text]);
      await run('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', raw, target]);
      await rm(raw, { force: true });
      console.log(`собран: ${phrase.file} — «${phrase.text}»`);
    }
    manifest.push({ file: `spike/voice/${phrase.file}`, text: phrase.text });
  }

  const manifestPath = join(dir, 'samples.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`список образцов: ${manifestPath}`);
  console.log('дальше: node tools/recognize-probe.mjs --configs tiny-wasm');
  return 0;
}

const code = await main();
if (code !== 0) process.exitCode = code;
