# Spec Delta

## Purpose

Записи о еде за день: что съедено, когда, в каком размере порции и с каким КБЖУ.
Всё хранится только на устройстве.

## ADDED Requirements

### Requirement: Запись еды вручную

The system SHALL allow the user to create a diary entry with a name, time, optional weight in
grams, portion size, calories, protein, fat, carbohydrates and an optional comment.

#### Scenario: Создание записи

- **WHEN** пользователь заполняет название и КБЖУ и подтверждает сохранение
- **THEN** запись появляется в ленте выбранного дня с указанным временем и КБЖУ

#### Scenario: Название обязательно

- **WHEN** пользователь пытается сохранить запись без названия
- **THEN** запись не сохраняется, а интерфейс сообщает, что название не заполнено

#### Scenario: Необязательные поля можно пропустить

- **WHEN** вес и комментарий оставлены пустыми
- **THEN** запись сохраняется, а в ленте эти поля не показываются

### Requirement: Множитель размера порции

The system SHALL scale the entered nutrition values by the selected portion size using ×0.7 for
small, ×1 for medium and ×1.4 for large, and SHALL store the base values separately so that
repeated saving does not apply the multiplier twice.

#### Scenario: Маленькая порция уменьшает значения

- **WHEN** введено 320 ккал и выбрана порция «мало»
- **THEN** сохраняется 224 ккал, и остальные показатели уменьшаются тем же множителем

#### Scenario: Повторное сохранение не удваивает множитель

- **GIVEN** запись сохранена с порцией «мало»
- **WHEN** пользователь открывает её на правку и сохраняет без изменений
- **THEN** значения записи остаются прежними

### Requirement: Правка и удаление записи

The system SHALL allow editing and deleting any entry of the day without leaving the day screen.

#### Scenario: Правка отражается в дне

- **WHEN** пользователь изменяет значения существующей записи и сохраняет
- **THEN** лента и итог дня показывают новые значения

#### Scenario: Удаление требует подтверждения

- **WHEN** пользователь нажимает удаление первый раз
- **THEN** запись не удаляется, а кнопка просит подтверждение
- **WHEN** пользователь нажимает второй раз
- **THEN** запись удаляется из хранилища и из ленты

### Requirement: Локальное хранение записей

The system MUST store all diary entries on the device and MUST NOT send them anywhere except
when the user explicitly requests analysis by a model.

#### Scenario: Записи переживают перезагрузку

- **WHEN** пользователь перезагружает приложение
- **THEN** все записи текущего дня на месте

#### Scenario: Запись с нулевым КБЖУ допустима

- **WHEN** пользователь сохраняет запись, указав название без КБЖУ
- **THEN** запись сохраняется и учитывается в дне как нулевая
