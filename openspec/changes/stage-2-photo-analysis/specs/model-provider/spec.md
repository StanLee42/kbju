# Spec Delta

## Purpose

Провайдер анализа: превращает фотографию или текст о еде в структурированные позиции с КБЖУ,
не пуская расчёты и хранение внутрь себя.

## ADDED Requirements

### Requirement: Подключение ключа провайдера

The system SHALL let the user enter an API key in settings, SHALL store it on the device, and
SHALL NOT include it in exports or backups.

#### Scenario: Ключ сохранён

- **WHEN** пользователь вставляет ключ в настройках
- **THEN** ключ сохраняется локально и запросы к модели начинают работать

#### Scenario: Ключ не попадает в выгрузку

- **WHEN** пользователь выгружает дневник в файл
- **THEN** файл не содержит API-ключ

### Requirement: Строгий формат ответа модели

The system MUST validate the model response against a fixed schema of nutritional items and MUST
retry once when the response is not valid JSON.

#### Scenario: Валидный ответ

- **WHEN** модель возвращает корректный JSON со списком позиций
- **THEN** позиции показываются в карточке результата

#### Scenario: Битый ответ

- **WHEN** модель возвращает текст вместо JSON
- **THEN** система делает одну повторную попытку и, если снова неудача, сообщает об ошибке
  понятным текстом, не создавая запись

### Requirement: Переключение провайдера без правок кода

The system SHALL keep providers behind a common interface so that the analysis provider can be
changed in settings without changing application code.

#### Scenario: Смена провайдера

- **WHEN** пользователь выбирает другого провайдера и указывает его ключ
- **THEN** анализ работает через него, а дневник и настройки не меняются

### Requirement: Понятные ошибки вместо сломанного интерфейса

The system SHALL translate provider failures into human-readable messages and SHALL NOT lose the
user's photo or text when a request fails.

#### Scenario: Исчерпан баланс

- **WHEN** провайдер отвечает ошибкой о недостатке средств
- **THEN** пользователь видит сообщение о необходимости пополнить счёт и ссылку на настройки

#### Scenario: Ошибка сети

- **WHEN** запрос не проходит из-за сети
- **THEN** снимок и введённый текст остаются в форме, и попытку можно повторить
