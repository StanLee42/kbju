# Spec Delta

## MODIFIED Requirements

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
