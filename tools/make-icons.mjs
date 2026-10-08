// Генератор PNG-иконок приложения. Запускается вручную:
//   node tools/make-icons.mjs
// Рисует те же кольца, что и icons/icon.svg, но растром — чтобы на Android
// иконка установки выглядела правильно и не зависела от SVG в манифесте.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'icons');

// --- минимальный PNG-энкодер ---

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePNG(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // бит на канал
  header[9] = 6;   // RGBA
  header[10] = 0;  // сжатие
  header[11] = 0;  // фильтр
  header[12] = 0;  // без интерлейса

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // фильтр строки: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- рисование ---

const hex = (value) => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
];

const BG_FROM = hex('#16212c');
const BG_TO = hex('#0b1117');
const TRACK = hex('#243546');

// Радиусы и толщины в системе координат 512x512, как в icon.svg.
const RINGS = [
  { radius: 150, width: 34, arc: 216, color: hex('#4ade80') },
  { radius: 104, width: 28, arc: 182, color: hex('#60a5fa') },
  { radius: 62, width: 24, arc: 162, color: hex('#fbbf24') },
];

const BG_RADIUS = 112;
const CENTER = 256;

function insideRoundedSquare(x, y, size, radius) {
  const half = size / 2 - 1;
  const dx = Math.abs(x - size / 2);
  const dy = Math.abs(y - size / 2);
  if (dx > half || dy > half) return false;
  const cx = half - radius;
  if (dx <= cx || dy <= cx) return true;
  return (dx - cx) ** 2 + (dy - cx) ** 2 <= radius ** 2;
}

/** Точка на дуге: от 12 часов по часовой стрелке на angleDeg градусов. */
function onArc(x, y, radius, width, angleDeg) {
  const dx = x - CENTER;
  const dy = y - CENTER;
  const distance = Math.hypot(dx, dy);
  if (distance < radius - width / 2 || distance > radius + width / 2) return false;

  let angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  if (angle <= angleDeg) return true;

  // Круглые торцы: расстояние до центров окончаний дуги.
  for (const endAngle of [0, angleDeg]) {
    const radians = (endAngle * Math.PI) / 180;
    const ex = CENTER + Math.sin(radians) * radius;
    const ey = CENTER - Math.cos(radians) * radius;
    if (Math.hypot(x - ex, y - ey) <= width / 2) return true;
  }
  return false;
}

function render(size) {
  const scale = size / 512;
  const samples = 4;
  const pixels = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) / scale;
          const y = (py + (sy + 0.5) / samples) / scale;

          if (!insideRoundedSquare(x, y, 512, BG_RADIUS)) continue;

          // Фон: диагональный градиент.
          const t = Math.min(1, Math.max(0, (x + y) / 1024));
          let cr = BG_FROM[0] + (BG_TO[0] - BG_FROM[0]) * t;
          let cg = BG_FROM[1] + (BG_TO[1] - BG_FROM[1]) * t;
          let cb = BG_FROM[2] + (BG_TO[2] - BG_FROM[2]) * t;

          for (const ring of RINGS) {
            if (onArc(x, y, ring.radius, ring.width, 360)) {
              [cr, cg, cb] = TRACK;
            }
          }
          for (const ring of RINGS) {
            if (onArc(x, y, ring.radius, ring.width, ring.arc)) {
              [cr, cg, cb] = ring.color;
            }
          }

          r += cr; g += cg; b += cb; a += 255;
        }
      }

      const total = samples * samples;
      const offset = (py * size + px) * 4;
      const alpha = a / total;
      if (alpha === 0) continue;
      // Усредняем цвет по покрытым суб-пикселям, чтобы края не темнели.
      const covered = a / 255;
      pixels[offset] = Math.round(r / covered);
      pixels[offset + 1] = Math.round(g / covered);
      pixels[offset + 2] = Math.round(b / covered);
      pixels[offset + 3] = Math.round(alpha);
    }
  }

  return encodePNG(size, size, pixels);
}

mkdirSync(outDir, { recursive: true });
// 180 — размер иконки на домашнем экране iPhone, 192 и 512 — для Android и манифеста.
for (const size of [180, 192, 512]) {
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, render(size));
  console.log(`готово: ${file}`);
}
