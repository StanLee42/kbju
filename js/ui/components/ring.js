// Кольцо прогресса на SVG: без библиотек и без сторонних зависимостей.
import { h, clamp, round } from '../../util.js';

const NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

export function createRing({ size = 154, stroke = 13, color = 'var(--kcal)', mini = false } = {}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  const track = svg('circle', {
    cx: size / 2, cy: size / 2, r: radius,
    fill: 'none', stroke: 'var(--bg-elev-2)', 'stroke-width': stroke,
  });

  const fill = svg('circle', {
    cx: size / 2, cy: size / 2, r: radius,
    fill: 'none', stroke: color, 'stroke-width': stroke, 'stroke-linecap': 'round',
    'stroke-dasharray': circumference, 'stroke-dashoffset': circumference,
    transform: `rotate(-90 ${size / 2} ${size / 2})`,
  });

  const valueNode = h('div', { class: 'ring-value' });
  const metaNode = h('div', { class: 'ring-meta' });

  const svgNode = svg('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` });
  svgNode.append(track, fill);

  const element = h('div', { class: mini ? 'ring-wrap ring-mini' : 'ring-wrap' },
    svgNode,
    h('div', { class: 'ring-center' }, valueNode, metaNode));

  function update({ value = 0, max = 0, caption = '', unit = '' } = {}) {
    const ratio = max > 0 ? Number(value) / Number(max) : 0;
    const shown = clamp(ratio, 0, 1);
    fill.setAttribute('stroke-dashoffset', String(circumference * (1 - shown)));
    fill.setAttribute('stroke', ratio > 1 ? 'var(--over)' : color);

    valueNode.textContent = `${round(value)}${unit ? ' ' + unit : ''}`;
    const percent = max > 0 ? round(ratio * 100) : 0;
    metaNode.textContent = caption || (max > 0 ? `${percent}%` : 'нет нормы');
  }

  return { element, update };
}
