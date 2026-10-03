# today-view Specification

## Purpose
Экран дня отвечает на два вопроса с одного взгляда: сколько уже съедено относительно нормы
и что именно съедено.

## Requirements

### Requirement: Кольца прогресса дня

The system SHALL show calories as a ring with the eaten amount and the remaining amount, and
SHALL show protein, fat and carbohydrates as three smaller rings, marking overrun distinctly
from the incomplete state.

#### Scenario: Остаток до нормы

- **GIVEN** норма 2000 ккал и записи на 224 ккал
- **WHEN** открыт экран дня
- **THEN** кольцо калорий показывает 224 и подпись «осталось 1776»

#### Scenario: Перебор

- **WHEN** сумма съеденного превышает норму
- **THEN** кольцо показывает величину перебора и выделяется цветом перебора

#### Scenario: Норма не задана

- **WHEN** норма показателя равна нулю
- **THEN** кольцо показывает съеденное значение и не показывает процент

### Requirement: Полоски по каждому показателю

The system SHALL show a progress bar for calories, protein, fat and carbohydrates with the eaten
amount, the norm and the remaining amount, and SHALL mark overrun in red.

#### Scenario: Полоска с остатком

- **GIVEN** норма белка 130 г и съедено 8 г
- **WHEN** открыт экран дня
- **THEN** полоска показывает «Белки 8 / 130 г» и «осталось 122»

#### Scenario: Полоска при переборе

- **WHEN** съедено больше нормы показателя
- **THEN** полоска показывает «перебор» с абсолютной величиной и окрашивается в красный

### Requirement: Лента дня и итог

The system SHALL list the day's entries in chronological order with time, name, portion and
macros, and SHALL show the totals for the day below the list.

#### Scenario: Порядок записей

- **WHEN** в дне несколько записей
- **THEN** они идут по возрастанию времени

#### Scenario: Итог дня

- **GIVEN** две записи на 300 и 250,5 ккал
- **WHEN** открыт экран дня
- **THEN** итог показывает 550,5 ккал и суммы белков, жиров и углеводов

#### Scenario: Пустой день

- **WHEN** записей нет
- **THEN** на месте ленты показано приглашение добавить первую запись, а итог не показывается

### Requirement: Выбор типа дня на текущую дату

The system SHALL let the user switch the day type with a single tap and SHALL apply the
corresponding norm immediately. A manual choice MUST be stored as an exception for that date,
and choosing the type the schedule already assigns MUST remove the exception instead of
creating a redundant one.

#### Scenario: Переключение типа дня

- **WHEN** пользователь выбирает другой тип дня
- **THEN** нормы в кольцах и полосках меняются сразу, а выбор сохраняется для этой даты

#### Scenario: Воскрешение расписания

- **GIVEN** для даты вручную выбран тип, отличный от расписания
- **WHEN** пользователь выбирает тип, который расписание и так назначает на эту дату
- **THEN** исключение для этой даты убирается, в настройках не остаётся лишней записи,
  а подпись под датой больше не утверждает, что тип задан вручную

#### Scenario: Расписание продолжает действовать для остальных дней

- **WHEN** для одной даты задано исключение
- **THEN** остальные дни определяются расписанием без изменений
