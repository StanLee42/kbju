// Управление эмулятором Android (или подключённым телефоном) через adb.
//
// Зачем: проверки в headless Chrome не видят всего, что видит настоящий Chrome
// на Android — установку иконки, поведение касаний, работу с файлами. Здесь же
// можно жать по координатам и по тексту надписи, снимать экран и открывать адреса.
//
// Запуск:
//   node tools/emu.mjs open http://127.0.0.1:8765/
//   node tools/emu.mjs ui                      # список надписей на экране
//   node tools/emu.mjs tap-text "No thanks"    # нажать по надписи
//   node tools/emu.mjs tap 540 2106            # нажать по координатам
//   node tools/emu.mjs shot /tmp/emu.png       # снимок экрана
//   node tools/emu.mjs reverse 8765            # пробросить порт с ноутбука
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ADB = process.env.ADB || `${process.env.ANDROID_HOME || '/opt/homebrew/share/android-commandlinetools'}/platform-tools/adb`;

function adb(args, { binary = false } = {}) {
  return execFileSync(ADB, args, {
    encoding: binary ? 'buffer' : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Разбор дерева интерфейса: возвращает узлы с текстом и координатами. */
function uiNodes() {
  adb(['shell', 'uiautomator', 'dump', '/sdcard/ui.xml']);
  const xml = adb(['shell', 'cat', '/sdcard/ui.xml']);
  const nodes = [];
  for (const match of xml.matchAll(/<node[^>]*>/g)) {
    const tag = match[0];
    const bounds = tag.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    const text = tag.match(/text="([^"]*)"/);
    const desc = tag.match(/content-desc="([^"]*)"/);
    const label = (text?.[1] || desc?.[1] || '').trim();
    if (!bounds || !label) continue;
    const [x1, y1, x2, y2] = bounds.slice(1).map(Number);
    nodes.push({ text: label, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), x1, y1, x2, y2 });
  }
  return nodes;
}

function tap(x, y) {
  adb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'open': {
    adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', rest[0]]);
    console.log(`открыт адрес: ${rest[0]}`);
    break;
  }

  case 'ui': {
    const nodes = uiNodes();
    for (const node of nodes.slice(0, 60)) {
      console.log(`  ${node.text} — (${node.x}, ${node.y})`);
    }
    console.log(`всего надписей: ${nodes.length}`);
    break;
  }

  case 'tap': {
    tap(Number(rest[0]), Number(rest[1]));
    console.log(`касание в (${rest[0]}, ${rest[1]})`);
    break;
  }

  case 'tap-text': {
    const wanted = rest.join(' ');
    const node = uiNodes().find((item) => item.text.toLowerCase().includes(wanted.toLowerCase()));
    if (!node) {
      console.error(`надпись «${wanted}» не найдена на экране`);
      process.exit(1);
    }
    tap(node.x, node.y);
    console.log(`касание по «${node.text}» в (${node.x}, ${node.y})`);
    break;
  }

  case 'shot': {
    const file = rest[0] || '/tmp/emu.png';
    writeFileSync(file, adb(['exec-out', 'screencap', '-p'], { binary: true }));
    console.log(`снимок: ${file}`);
    break;
  }

  case 'reverse': {
    const port = rest[0] || '8765';
    adb(['reverse', `tcp:${port}`, `tcp:${port}`]);
    console.log(`порт ${port} проброшен с ноутбука в эмулятор`);
    break;
  }

  case 'wait': {
    const ms = Number(rest[0]) || 3000;
    await sleep(ms);
    console.log(`подождали ${ms} мс`);
    break;
  }

  default:
    console.log('команды: open, ui, tap, tap-text, shot, reverse, wait');
}
