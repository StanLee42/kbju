// Работа с изображениями: выбор файла, уменьшение перед отправкой и превью для дневника.
//
// Перед отправкой провайдеру изображение всегда перекодируется через canvas. Побочный,
// но важный эффект: при перекодировании теряются метаданные съёмки — координаты, модель
// устройства, время. Отправлять их провайдеру незачем, а координаты вообще персональные данные.
import { uid } from '../util.js';

const ACCEPTED = /^image\/(jpeg|png|webp|gif)$/;

/** Открывает системный выбор файла: камера или галерея. Возвращает File или null. */
export function pickImage({ camera = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (camera) input.capture = 'environment';
    input.style.display = 'none';

    let settled = false;
    const finish = (file) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file || null);
    };

    input.addEventListener('change', () => finish(input.files?.[0] || null));
    // Явная отмена выбора: событие cancel поддерживают современные браузеры.
    // Раньше здесь была попытка ловить потерю фокуса окна с таймаутом — она
    // срабатывала быстрее, чем человек успевал выбрать файл.
    input.addEventListener('cancel', () => finish(null));

    document.body.append(input);
    input.click();
  });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('не удалось прочитать изображение'));
    };
    image.src = url;
  });
}

function drawToBlob(image, maxSide, quality, cropTopFraction = 0) {
  const sourceTop = Math.round(image.height * Math.min(Math.max(cropTopFraction, 0), 0.9));
  const sourceHeight = Math.max(1, image.height - sourceTop);

  const scale = Math.min(1, maxSide / Math.max(image.width, sourceHeight));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(
    image,
    0, sourceTop, image.width, sourceHeight, // откуда берём
    0, 0, width, height,                     // куда кладём
  );

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve({ blob, width, height }), 'image/jpeg', quality);
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('не удалось прочитать изображение'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Готовит снимок к отправке в модель: уменьшает длинную сторону, перекодирует
 * в JPEG и возвращает base64. Метаданные съёмки при этом теряются.
 *
 * `cropTopFraction` убирает верхнюю часть кадра — так из отчёта уходит шапка
 * с фамилией, которая для распознавания не нужна.
 */
export async function prepareForApi(file, { maxSide = 1280, quality = 0.85, cropTopFraction = 0 } = {}) {
  if (!file) throw new Error('нет файла');
  if (file.type && !ACCEPTED.test(file.type)) throw new Error('это не изображение');
  const image = await loadImage(file);
  const { blob, width, height } = await drawToBlob(image, maxSide, quality, cropTopFraction);
  return { base64: await blobToBase64(blob), mime: 'image/jpeg', width, height, bytes: blob.size };
}

/** Делает уменьшенное превью для дневника. */
export async function makeThumbnail(file, { maxSide = 512, quality = 0.72 } = {}) {
  const image = await loadImage(file);
  const { blob, width, height } = await drawToBlob(image, maxSide, quality);
  return { id: uid(), blob, width, height, bytes: blob.size };
}

export function blobToObjectUrl(blob) {
  return blob ? URL.createObjectURL(blob) : null;
}
