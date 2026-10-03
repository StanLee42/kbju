# app-shell Specification

## Purpose
Оболочка отвечает за то, чтобы приложение жило на телефоне как обычная иконка, открывалось
без сети и не теряло дневник.

## Requirements

### Requirement: Установка на домашний экран

The system SHALL be installable as a standalone app from the browser and SHALL provide icons of
192 and 512 pixels so that the installed icon is not scaled up from a smaller image.

#### Scenario: Установка по HTTPS

- **WHEN** приложение открыто по HTTPS и пользователь выбирает установку
- **THEN** приложение открывается на весь экран без адресной строки браузера под своей иконкой

#### Scenario: Доступ к камере и микрофону

- **WHEN** приложение открыто по HTTPS или по localhost
- **THEN** камера и микрофон доступны приложению
- **WHEN** приложение открыто как локальный файл
- **THEN** браузер не даёт доступ к хранилищу и модулям, и на экране появляется понятное
  объяснение вместо пустой страницы

### Requirement: Работа без сети

The system SHALL cache its own files so the app opens without network access, and MUST NOT cache
user data or responses of external services in that cache.

#### Scenario: Открытие без сети

- **WHEN** после первого успешного открытия сеть пропала
- **THEN** приложение открывается и показывает сохранённые записи дня

#### Scenario: Внешние запросы не кэшируются

- **WHEN** приложение обращается к внешнему адресу за данными
- **THEN** запрос уходит в сеть без участия кэша оболочки

### Requirement: Сохранность данных

The system SHALL request persistent storage from the browser and SHALL show how much space is
used, and SHALL provide a full local reset behind an explicit confirmation.

#### Scenario: Запрос постоянного хранилища

- **WHEN** пользователь впервые касается экрана приложения
- **THEN** у браузера запрашивается постоянное хранилище, а результат виден в настройках

#### Scenario: Просмотр занятого места

- **WHEN** открыты настройки
- **THEN** показано занятое и доступное место, а также статус постоянного хранилища

#### Scenario: Полный сброс

- **WHEN** пользователь подтверждает удаление всех данных двумя нажатиями
- **THEN** локальные данные очищаются и приложение перезагружается в исходном состоянии

### Requirement: Диагностика ошибки запуска

The system SHALL show a readable error message on screen instead of an empty page when the app
fails to start, because the device has no developer console.

#### Scenario: Ошибка в скрипте

- **WHEN** скрипт приложения падает или не загружается
- **THEN** на экране появляется текст ошибки с указанием файла и строки

#### Scenario: Ошибка в обработчике

- **WHEN** ошибка возникает внутри обработчика события или в обещании
- **THEN** сообщение выводится один раз и не перекрывает уже показанное
