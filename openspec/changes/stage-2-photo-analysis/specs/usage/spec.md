# Spec Delta

## Purpose

Учёт того, сколько стоит пользование моделью: токены, стоимость, прогноз на месяц и остаток
на счету провайдера.

## ADDED Requirements

### Requirement: Журнал расхода по каждому запросу

The system SHALL record one usage row per model request with the request kind, token counts
including cache hits, the number of web searches and the computed cost.

#### Scenario: Запись после запроса

- **WHEN** приложение получает ответ модели
- **THEN** в журнал добавляется строка с временем, видом запроса и токенами

#### Scenario: Различение видов запросов

- **WHEN** запросы относятся к разным сценариям
- **THEN** в журнале они различаются как анализ фото, чат, приветствие, выжимка или поиск

### Requirement: Стоимость считается по редактируемой таблице цен

The system SHALL compute cost from a price table that stores the price and the date it refers to,
and SHALL label computed amounts as an estimate rather than a fact.

#### Scenario: Пиковые и непиковые часы

- **WHEN** запрос сделан в часы с другой ценой
- **THEN** стоимость считается по цене, действующей для этого времени

#### Scenario: Цены устарели

- **WHEN** пользователь смотрит расход
- **THEN** рядом с суммой указано, на какую дату действуют цены

### Requirement: Прогноз стоимости при разном уровне общения

The system SHALL project the monthly cost from the user's own average request cost for several
usage levels.

#### Scenario: Калькулятор месяца

- **WHEN** у пользователя накопилась история запросов
- **THEN** показана оценка месяца для нескольких уровней использования, с поиском в сети и без

### Requirement: Бюджет и предупреждения

The system SHALL let the user set a monthly budget and SHALL warn as spending approaches it.

#### Scenario: Предупреждение о бюджете

- **WHEN** расход достигает порога бюджета
- **THEN** пользователь видит предупреждение с фактической суммой

#### Scenario: Бюджет исчерпан

- **WHEN** расход превышает заданный бюджет
- **THEN** приложение предлагает перевести разговор в локальный режим без модели вместо ошибки

### Requirement: Остаток на счету провайдера

The system SHALL show the remaining provider balance and SHALL make clear that local speech
recognition costs nothing.

#### Scenario: Просмотр баланса

- **WHEN** открыт экран расхода
- **THEN** показан остаток на счету провайдера, и отдельно указано, что распознавание речи
  не расходует средства
