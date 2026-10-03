// Полоска «съедено / норма / осталось» с красным перебором.
import { h, clamp, round } from '../../util.js';

export function createBar({ label = '', color = 'var(--accent)', unit = 'г' } = {}) {
  const headLeft = h('span', {});
  const headRight = h('span', { class: 'tiny muted' });
  const fill = h('div', { class: 'bar-fill', style: `background:${color};width:0%` });
  const rest = h('div', { class: 'bar-rest' });
  const track = h('div', { class: 'bar-track' }, fill, rest);

  const element = h('div', { class: 'bar-line' },
    h('div', { class: 'bar-head' }, headLeft, headRight),
    track);

  function update({ value = 0, max = 0 } = {}) {
    const ratio = max > 0 ? Number(value) / Number(max) : 0;
    const over = ratio > 1;
    const width = clamp(ratio, 0, 1) * 100;
    fill.style.width = `${width}%`;
    fill.style.background = over ? 'var(--over)' : color;

    headLeft.textContent = max > 0
      ? `${label} ${round(value)} / ${round(max)} ${unit}`
      : `${label} ${round(value)} ${unit}`;

    const left = round(Number(max) - Number(value));
    headRight.textContent = max > 0
      ? (left >= 0 ? `осталось ${left}` : `перебор ${Math.abs(left)}`)
      : '';
    headRight.style.color = over && max > 0 ? 'var(--over)' : '';
  }

  return { element, update };
}
