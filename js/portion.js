// Порции и суммы: сколько из посчитанного съедено и что получается в итоге.
//
// Вынесено отдельно от интерфейса, потому что это арифметика, а её надо проверять тестами:
// ошибка здесь тихо портит дневник.

export const PORTION_PRESETS = [
  { id: 'all', label: 'Всё', factor: 1 },
  { id: 'half', label: 'Половина', factor: 0.5 },
];

/**
 * Множитель порции.
 * «Свои граммы» считаются как отношение желаемого веса к суммарному весу позиций.
 */
export function portionFactor({ portion = 'all', customGrams = null, items = [] } = {}) {
  const preset = PORTION_PRESETS.find((item) => item.id === portion);
  if (preset) return preset.factor;
  if (portion !== 'custom') return 1;

  const total = sumItems(items).grams;
  const wanted = Number(customGrams) || 0;
  if (total <= 0 || wanted <= 0) return 1;
  return wanted / total;
}

export function sumItems(items = []) {
  return (items || []).reduce((acc, item) => {
    acc.grams += Number(item.grams) || 0;
    acc.kcal += Number(item.kcal) || 0;
    acc.protein += Number(item.protein) || 0;
    acc.fat += Number(item.fat) || 0;
    acc.carbs += Number(item.carbs) || 0;
    return acc;
  }, { grams: 0, kcal: 0, protein: 0, fat: 0, carbs: 0 });
}

const round1 = (value) => Math.round((Number(value) || 0) * 10) / 10;

/** Применяет множитель ко всем позициям. */
export function scaleItems(items = [], factor = 1) {
  return items.map((item) => ({
    name: String(item.name || '').trim() || 'позиция',
    grams: round1((Number(item.grams) || 0) * factor),
    kcal: round1((Number(item.kcal) || 0) * factor),
    protein: round1((Number(item.protein) || 0) * factor),
    fat: round1((Number(item.fat) || 0) * factor),
    carbs: round1((Number(item.carbs) || 0) * factor),
  }));
}

/** Подпись к записи: «половина порции», «320 г из порции» — или пусто. */
export function portionNote({ portion, factor, grams }) {
  if (portion === 'half') return 'половина посчитанного';
  if (portion === 'custom' && factor !== 1) return `${Math.round(grams)} г из посчитанного`;
  return '';
}
