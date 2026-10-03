# Spec Delta

## ADDED Requirements

### Requirement: Создание записи из фотографии

The system SHALL let the user attach a photo of food, SHALL show the recognized items with their
nutrition values for confirmation, and SHALL create a diary entry only after the user confirms.

#### Scenario: Распознавание тарелки

- **WHEN** пользователь прикрепляет фотографию еды и запускает расчёт
- **THEN** показывается карточка с позициями, граммами и КБЖУ, а запись ещё не создана

#### Scenario: Подтверждение записи

- **WHEN** пользователь подтверждает карточку
- **THEN** в дневник добавляется одна запись с суммой по позициям, а фотография сохраняется
  уменьшенным превью

#### Scenario: Отказ от записи

- **WHEN** пользователь закрывает карточку, не подтверждая
- **THEN** дневник не меняется

### Requirement: Правка результата распознавания

The system SHALL allow correcting any number and any item name in the result card before saving,
and SHALL let the user adjust the portion with a single tap and enter an exact weight if known.

#### Scenario: Правка числа

- **WHEN** пользователь меняет граммы или КБЖУ позиции
- **THEN** итог карточки пересчитывается сразу

#### Scenario: Размер порции

- **WHEN** пользователь выбирает «мало», «средне» или «много»
- **THEN** значения позиций умножаются на 0,7, 1 или 1,4 соответственно, а базовые значения
  сохраняются отдельно, чтобы повторное сохранение не удваивало множитель

#### Scenario: Точный вес

- **WHEN** пользователь вводит вес позиции в граммах
- **THEN** введённое значение заменяет оценку модели для этой позиции

### Requirement: Видимая расшифровка распознанного

The system SHALL show what the model recognized in words, next to the numbers, so the user can
judge where the values came from.

#### Scenario: Показ расшифровки

- **WHEN** показана карточка результата
- **THEN** рядом с числами видно перечень распознанных блюд с граммовкой

#### Scenario: Низкая уверенность

- **WHEN** модель сообщает о низкой уверенности в составе или размере порции
- **THEN** карточка явно помечает это, чтобы пользователь проверил числа внимательнее
