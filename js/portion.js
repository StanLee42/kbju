// Суммы по позициям записи: арифметика вынесена отдельно от интерфейса, потому что
// ошибка здесь тихо портит дневник, а проверяется она тестами.

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
