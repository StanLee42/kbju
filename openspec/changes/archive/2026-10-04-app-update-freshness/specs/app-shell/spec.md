# Spec Delta

## ADDED Requirements

### Requirement: Обновление сохранённой версии приложения

The system SHALL change its cache identifier whenever the application files change, so that
a published update replaces the cached version on the next load (SHALL), and SHALL keep the
identifier unchanged while the files stay the same (SHALL).

#### Scenario: После обновления приложение берёт новую версию

- **GIVEN** приложение установлено на телефон и его файлы изменились
- **WHEN** пользователь открывает приложение
- **THEN** загружаются файлы новой версии, а кэш прежней версии удаляется

#### Scenario: Без изменений кэш не трогается

- **WHEN** файлы приложения не менялись
- **THEN** идентификатор кэша остаётся прежним, и повторной загрузки не происходит

#### Scenario: Работа без сети сохраняется

- **WHEN** после обновления сеть пропала
- **THEN** приложение по-прежнему открывается и показывает сохранённые записи
