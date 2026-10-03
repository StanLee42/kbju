# Spec Delta

## Purpose

Нормы КБЖУ привязаны к типам дней, а тип дня подставляется по календарю: по дням недели
или по вращающемуся циклу, с возможностью исключения на конкретную дату.

## ADDED Requirements

### Requirement: Типы дней с нормами

The system SHALL keep user-editable day types, each with its own calorie, protein, fat and
carbohydrate norm, and SHALL use the norms of the resolved day type for the day screen.

#### Scenario: Правка нормы типа дня

- **WHEN** пользователь меняет число в типе дня
- **THEN** все дни этого типа используют новое значение

#### Scenario: Переименование типа дня

- **WHEN** пользователь меняет название типа дня
- **THEN** новое название показывается в переключателе на экране дня и в списках расписания

#### Scenario: Пустое название не сохраняется

- **WHEN** пользователь стирает название типа дня
- **THEN** сохраняется прежнее название, тип дня остаётся распознаваемым

### Requirement: Расписание по дням недели

The system SHALL support a weekly schedule that assigns a day type to each weekday, and SHALL
derive the type of a date from it when no exception is set.

#### Scenario: Подстановка по дню недели

- **GIVEN** среда назначена тренировкой
- **WHEN** открыт экран среды
- **THEN** норма берётся из типа «Тренировка»

### Requirement: Расписание по вращающемуся циклу

The system SHALL support a rotating cycle with configurable cycle length, training positions and
a start date, and SHALL resolve dates before the start date by the same formula without negative
offsets.

#### Scenario: Цикл два через два

- **GIVEN** длина цикла 4, тренировки на позициях 1 и 3, старт 1 октября
- **WHEN** открыт день 1 октября
- **THEN** тип дня «тренировка»
- **WHEN** открыт день 2 октября
- **THEN** тип дня «обычный»
- **WHEN** открыт день 5 октября
- **THEN** тип дня снова «тренировка»

#### Scenario: Дата раньше старта цикла

- **WHEN** дата раньше даты старта цикла
- **THEN** тип дня определяется той же формулой и приложение не падает

#### Scenario: Уменьшение длины цикла

- **WHEN** пользователь уменьшает длину цикла так, что часть позиций тренировок выходит за
  новые границы
- **THEN** такие позиции отбрасываются, а остальные сохраняются

### Requirement: Исключения на отдельные даты

The system SHALL allow overriding the day type for a specific date, and the override MUST take
precedence over the schedule.

#### Scenario: Исключение сильнее расписания

- **GIVEN** на 7 октября назначен обычный день, а по расписанию в этот день тренировка
- **WHEN** открыт экран 7 октября
- **THEN** применяется норма обычного дня, а подпись сообщает, что тип задан вручную

#### Scenario: Снятие исключения

- **WHEN** пользователь удаляет исключение для даты
- **THEN** для этой даты снова действует расписание

#### Scenario: Исключение с несуществующим типом

- **WHEN** в исключении указан тип дня, которого больше нет
- **THEN** применяется тип по расписанию, приложение не падает
