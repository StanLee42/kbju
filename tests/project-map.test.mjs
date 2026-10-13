// Проверка карты проекта: разделы спецификаций названы, ссылки открываются.
//
// Карта (PROJECT.md) нужна человеку и агенту как входной документ. Она не пересказывает
// требования, а называет разделы и входы приложения, поэтому расходится с репозиторием
// именно списками: пропал раздел или умерла ссылка.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const map = readFileSync(join(root, 'PROJECT.md'), 'utf8');

test('каждый раздел спецификаций назван в карте', () => {
  const specs = join(root, 'openspec', 'specs');
  const areas = readdirSync(specs).filter((name) => statSync(join(specs, name)).isDirectory());
  assert.ok(areas.length > 0, 'разделов спецификаций не нашлось');
  for (const area of areas) {
    assert.ok(
      map.includes(`openspec/specs/${area}/spec.md`),
      `в карте не назван раздел ${area}`,
    );
  }
});

test('ссылки карты открываются', () => {
  const links = [...map.matchAll(/\]\(([^)#]+)\)/g)].map((match) => match[1]);
  assert.ok(links.length >= 10, 'в карте меньше десяти ссылок: проверять нечего');
  for (const link of links) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue; // адреса в сети
    assert.ok(existsSync(join(root, link)), `ссылка не открывается: ${link}`);
  }
});

test('входы приложения перечислены по файлам', () => {
  const screens = readdirSync(join(root, 'js', 'ui')).filter((name) => name.endsWith('.js'));
  assert.ok(screens.length > 0, 'экранов не нашлось');
  for (const screen of screens) {
    assert.ok(map.includes(`js/ui/${screen}`), `в карте не назван экран ${screen}`);
  }
});
