import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { UiLanguage } from "@codexnest/protocol";

const LANGUAGE_KEY = "codexnest.uiLanguage";
const LEGACY_INSTALLATION_KEYS = [
  "codexnest.serverUrl",
  "codexnest.theme",
  "codexnest.sidebarSide",
  "codexnest.projectListDirection",
  "codexnest.sessionListMode",
  "codexnest.layoutDefaultsVersion",
  "codexnest.notificationPromptDismissed",
];

const ENGLISH: Record<string, string> = {
  "Не удалось загрузить конфигурацию": "Failed to load configuration",
  "Браузер не выдал разрешение. Попробуйте ещё раз.":
    "The browser did not grant permission. Try again.",
  "Не удалось запросить разрешение у браузера": "Failed to request permission from the browser",
  "Небезопасное HTTP-подключение: данные доступны перехватчику в LAN.":
    "Insecure HTTP connection: data can be intercepted on the LAN.",
  "Закрыть меню": "Close menu",
  "{{error}}. Серверные задачи продолжат выполняться.":
    "{{error}}. Server tasks will continue running.",
  Повторить: "Retry",
  "Получаем состояние Codex…": "Loading Codex state…",
  "Разрешить уведомления?": "Allow notifications?",
  "CodexNest сообщит, когда задача завершится или потребуется ваше решение.":
    "CodexNest will notify you when a task finishes or needs your decision.",
  "Не сейчас": "Not now",
  "Запрашиваем…": "Requesting…",
  "Разрешить уведомления": "Allow notifications",
  "Нет открытых сессий": "No open sessions",
  "Создайте сессию в проекте": "Create a session in a project",
  "Откройте список проектов и нажмите + рядом с нужным проектом.":
    "Open the project list and click + next to the project you need.",
  "Открыть проекты": "Open projects",
  "Путь скопирован": "Path copied",
  "Не удалось скопировать путь": "Failed to copy path",
  "Не удалось изменить порядок проектов": "Failed to reorder projects",
  "Не удалось удалить проект": "Failed to remove project",
  "Не удалось создать сессию": "Failed to create session",
  "Не удалось создать ответвление сессии": "Failed to fork session",
  "Не удалось создать Team-сессию": "Failed to create Team session",
  "Включить браузер": "Enable browser",
  "Выключить браузер": "Disable browser",
  "Браузер включён": "Browser enabled",
  "Браузер подключён": "Browser connected",
  "Изменяем доступ браузера…": "Changing browser access…",
  "Дождитесь завершения текущего хода, чтобы изменить доступ браузера":
    "Wait for the current turn to finish before changing browser access",
  "Не удалось изменить доступ браузера": "Failed to change browser access",
  "Нельзя удалить проект, пока его сессии выполняются, ждут решения или содержат сообщения в очереди":
    "A project cannot be removed while its sessions are running, awaiting a decision, or have queued messages",
  Архив: "Archive",
  "Состояние сервера: {{state}}": "Server status: {{state}}",
  "Доступно обновление CodexNest": "CodexNest update available",
  Настройки: "Settings",
  "Добавить проект": "Add project",
  Проекты: "Projects",
  Активные: "Active",
  "Режим списка сессий": "Session list mode",
  "Нет активных сессий": "No active sessions",
  Задачи: "Tasks",
  "Без проекта": "No project",
  "Перетащить проект {{project}}": "Drag project {{project}}",
  "Действия с проектом {{project}}": "Actions for project {{project}}",
  "Копировать путь": "Copy path",
  "Переместить выше": "Move up",
  "Переместить ниже": "Move down",
  "Удалить проект": "Remove project",
  "Удалить проект «{{project}}» из Codex Nest? Проект и его сессии исчезнут из приложения, но папка и история сохранятся.":
    "Remove “{{project}}” from Codex Nest? The project and its sessions will disappear from the app, but the folder and history will be preserved.",
  "Создать новую сессию в проекте {{project}}": "Create a new session in {{project}}",
  "Создать новую Team-сессию": "Create a new Team session",
  "Эта сессия создана до появления managed Team tools. Создайте новую Team-сессию.":
    "This session predates managed Team tools. Create a new Team session.",
  "Нельзя выключить Team, пока субагенты работают или их результаты ещё не обработаны. Попросите главного агента завершить или отменить их.":
    "Team mode cannot be disabled while subagents are running or their results are still pending. Ask the root agent to finish or cancel them.",
  "Показать меньше": "Show less",
  "Показать ещё {{count}}": "Show {{count}} more",
  "Пока нет задач": "No tasks yet",
  "Повторить лимиты": "Retry limits",
  "Лимиты Codex": "Codex limits",
  "Лимиты недоступны": "Limits unavailable",
  Лимит: "Limit",
  "{{count}} д": "{{count}}d",
  "{{count}} ч": "{{count}}h",
  "{{count}} мин": "{{count}}m",
  "Обновляем лимиты Codex": "Refreshing Codex limits",
  "Повторить обновление лимитов Codex": "Retry refreshing Codex limits",
  "Показать лимиты Codex": "Show Codex limits",
  "Обновить лимиты Codex: {{text}}": "Refresh Codex limits: {{text}}",
  Подключено: "Connected",
  "Подключение…": "Connecting…",
  "Нет связи": "Offline",
  "Codex ждёт решения": "Codex needs your decision",
  "Задача завершена": "Task completed",
  "Задача завершилась с ошибкой": "Task failed",
  "Откройте CodexNest для подробностей": "Open CodexNest for details",
  "Задача Codex": "Codex task",
  "Введите bearer token": "Enter the bearer token",
  "Не удалось сохранить подключение": "Failed to save the connection",
  "Подключение к CodexNest": "Connect to CodexNest",
  "Укажите адрес домашнего сервера и bearer token.":
    "Enter the address of your home server and its bearer token.",
  "Адрес сервера": "Server address",
  "HTTP не шифрует token и содержимое сессий. Используйте только доверенную LAN.":
    "HTTP does not encrypt the token or session content. Use it only on a trusted LAN.",
  "Проверяем…": "Checking…",
  Подключиться: "Connect",
  "Разрешены только адреса http:// и https://": "Only http:// and https:// addresses are allowed",
  "Не удалось подключиться к серверу": "Failed to connect to the server",
  "Связь с сервером потеряна": "Connection to the server was lost",
  "Запрашивать разрешение": "Ask for permission",
  "Codex работает в проекте и спрашивает вас перед расширением доступа.":
    "Codex works within the project and asks before expanding access.",
  "Подтверждать автоматически": "Approve automatically",
  "Потенциально опасные действия проверяет отдельный reviewer Codex.":
    "A separate Codex reviewer checks potentially dangerous actions.",
  "Полный доступ": "Full access",
  "Неограниченный доступ к интернету и любым файлам пользователя на сервере.":
    "Unrestricted access to the internet and any user files on the server.",
  "Не удалось загрузить настройки": "Failed to load settings",
  "Конфигурация Codex изменилась. Проверьте значение и сохраните ещё раз.":
    "The Codex configuration changed. Check the value and save again.",
  "Не удалось сохранить настройки": "Failed to save settings",
  "Не удалось сохранить настройки новых задач": "Failed to save new task settings",
  "Приложение, Codex и сервер": "Application, Codex, and server",
  "Разделы настроек": "Settings sections",
  Приложение: "Application",
  Подключение: "Connection",
  Обслуживание: "Maintenance",
  Скиллы: "Skills",
  "Установленные возможности Codex для выбранного проекта.":
    "Installed Codex capabilities for the selected project.",
  "Каталог и переключатели ниже относятся к выбранному проекту.":
    "The catalog and switches below apply to the selected project.",
  "Проект для скиллов": "Project for skills",
  "Обновить список скиллов": "Refresh skills",
  "Добавьте проект, чтобы посмотреть доступные для него скиллы.":
    "Add a project to view its available skills.",
  "Поиск скиллов": "Search skills",
  "Поиск по названию и описанию": "Search by name and description",
  "Загружаем скиллы…": "Loading skills…",
  "Не удалось загрузить скиллы": "Failed to load skills",
  "Не удалось изменить состояние скилла": "Failed to update skill state",
  "Ошибки обнаружения: {{count}}": "Discovery errors: {{count}}",
  "Скиллы не найдены": "No skills found",
  "Ничего не найдено": "No results",
  "Описание не указано": "No description provided",
  "Выключить скилл {{name}}": "Disable skill {{name}}",
  "Включить скилл {{name}}": "Enable skill {{name}}",
  Проектный: "Repository",
  Пользовательский: "User",
  Административный: "Admin",
  Системный: "System",
  "Доступные скиллы": "Available skills",
  "Нет подходящих скиллов": "No matching skills",
  "Новые задачи": "New tasks",
  "Эти значения применяются к новым сессиям и задачам на всех подключённых устройствах.":
    "These values apply to new sessions and tasks on every connected device.",
  "Модель, которая будет выбрана для новых сессий.": "Model selected for new sessions.",
  "Модель для автоматических названий сессий.": "Model used for automatic session titles.",
  "Приоритет обработки для новых задач.": "Processing priority for new tasks.",
  "Стиль ответов для новых задач.": "Response style for new tasks.",
  "По умолчанию": "Default",
  Дружелюбная: "Friendly",
  Прагматичная: "Pragmatic",
  "Без personality": "No personality",
  "Сохраняем…": "Saving…",
  "Сохранить настройки новых задач": "Save new task settings",
  "Разрешения Codex": "Codex permissions",
  "Выбранный режим применяется ко всем задачам со следующего хода.":
    "The selected mode applies to all tasks from their next turn.",
  "Загружаем конфигурацию…": "Loading configuration…",
  "Режим разрешений": "Permission mode",
  "Обнаружена нестандартная конфигурация. Выберите один из режимов и сохраните его.":
    "A custom configuration was detected. Select and save one of the modes.",
  "Настройка переопределена управляемой политикой Codex.":
    "This setting is overridden by a managed Codex policy.",
  "Полный доступ снимает ограничения на файлы и сеть. Используйте его только на доверенном сервере.":
    "Full access removes file and network restrictions. Use it only on a trusted server.",
  Сохранить: "Save",
  "Уведомления браузера": "Browser notifications",
  "События приходят напрямую с вашего сервера, без Google и внешнего push.":
    "Events come directly from your server without Google or external push services.",
  "Уведомления включены. Они приходят, пока вкладка открыта или свёрнута.":
    "Notifications are enabled. They arrive while the tab is open or minimized.",
  "Уведомления заблокированы. Разрешите их в настройках сайта в браузере.":
    "Notifications are blocked. Allow them in the browser's site settings.",
  "Этот браузер не предоставляет системные уведомления для текущего подключения. Некоторые браузеры требуют открыть CodexNest по HTTPS.":
    "This browser does not provide system notifications for the current connection. Some browsers require CodexNest to be opened over HTTPS.",
  Интерфейс: "Interface",
  "Язык интерфейса синхронизируется через сервер; остальные настройки применяются только на этом устройстве.":
    "The interface language is synchronized through the server; other settings apply only to this device.",
  "Язык интерфейса": "Interface language",
  "Синхронизируется между подключёнными устройствами.": "Synchronized across connected devices.",
  "Не удалось сохранить язык интерфейса": "Failed to save the interface language",
  Тема: "Theme",
  "Светлая, тёмная или системная цветовая схема.": "Light, dark, or system color scheme.",
  "Системная тема": "System theme",
  "Светлая тема": "Light theme",
  "Тёмная тема": "Dark theme",
  "Боковая панель": "Sidebar",
  "Расположение списка проектов и задач.": "Placement of the project and task list.",
  Слева: "Left",
  Справа: "Right",
  "Порядок проектов": "Project order",
  "Как проекты расположены в боковой панели.": "How projects are ordered in the sidebar.",
  "Сверху вниз": "Top to bottom",
  "Снизу вверх": "Bottom to top",
  Сервер: "Server",
  "Подключение к CodexNest на этом устройстве.": "CodexNest connection on this device.",
  "Сменить сервер": "Switch server",
  "Настройки применены на сервере для всех клиентов.":
    "Settings were applied on the server for all clients.",
  "Не удалось сохранить настройки распознавания": "Failed to save speech recognition settings",
  "Распознавание речи": "Speech recognition",
  "Эти настройки общие для всех клиентов и сохраняются на сервере.":
    "These settings are shared by all clients and stored on the server.",
  "Не удалось получить настройки распознавания: {{error}}":
    "Failed to load speech recognition settings: {{error}}",
  "Загружаем настройки…": "Loading settings…",
  Провайдер: "Provider",
  "Где обрабатывается записанное аудио.": "Where recorded audio is processed.",
  "Провайдер распознавания речи": "Speech recognition provider",
  "Выберите провайдера": "Select a provider",
  "Локальная модель": "Local model",
  "URL локального STT": "Local STT URL",
  "HTTP-адрес сервиса распознавания на вашем сервере.":
    "HTTP endpoint of the transcription service on your server.",
  "Расставлять пунктуацию и исправлять очевидные ошибки через Codex":
    "Add punctuation and correct obvious errors with Codex",
  "Модель улучшения": "Refinement model",
  "Модель улучшения расшифровки": "Transcript refinement model",
  "Аудио остаётся на сервере. При включённом улучшении в Codex отправляется только распознанный текст.":
    "Audio stays on the server. When refinement is enabled, only the recognized text is sent to Codex.",
  "Модель OpenAI": "OpenAI model",
  "Модель распознавания OpenAI": "OpenAI transcription model",
  "gpt-4o-transcribe — точнее": "gpt-4o-transcribe — more accurate",
  "gpt-4o-mini-transcribe — дешевле": "gpt-4o-mini-transcribe — cheaper",
  "Ключ сохранён; оставьте пустым без изменений": "Key saved; leave empty to keep it unchanged",
  "Хранится на сервере и не возвращается в интерфейс.":
    "Stored on the server and never returned to the interface.",
  Скрыть: "Hide",
  Показать: "Show",
  "Ключ будет удалён": "The key will be removed",
  "API key настроен": "API key configured",
  "Код языка аудио, например ru или en.": "Audio language code, such as ru or en.",
  "Не удалять": "Keep key",
  "Удалить ключ": "Delete key",
  "Ввод API key доступен только через HTTPS или локальное подключение.":
    "API key entry is available only over HTTPS or a local connection.",
  "Аудио отправляется в OpenAI API и оплачивается отдельно от подписки ChatGPT или Codex.":
    "Audio is sent to the OpenAI API and billed separately from a ChatGPT or Codex subscription.",
  Язык: "Language",
  "Язык распознавания": "Recognition language",
  "Настройте URL локального STT или OpenAI API key, чтобы включить микрофон.":
    "Configure a local STT URL or OpenAI API key to enable the microphone.",
  "Выбранный провайдер настроен не полностью. Исправьте параметры и сохраните форму.":
    "The selected provider is not fully configured. Correct the settings and save the form.",
  "Сохранить распознавание": "Save speech recognition",
  "Определяем…": "Detecting…",
  "Только в Android": "Android only",
  "Не удалось получить состояние CodexNest": "Failed to get CodexNest status",
  "Не удалось определить": "Could not determine",
  "Не удалось проверить обновления CodexNest": "Failed to check for CodexNest updates",
  " до версии {{version}}": " to version {{version}}",
  "Обновить CodexNest{{target}}? Интерфейс ненадолго переподключится.":
    "Update CodexNest{{target}}? The interface will briefly reconnect.",
  "Не удалось запустить обновление CodexNest": "Failed to start the CodexNest update",
  "Не удалось открыть загрузку APK": "Failed to open the APK download",
  "Аварийное восстановление": "Emergency recovery",
  "Используйте только если обычное обновление или работа сессий зависли. Эти действия обходят безопасное ожидание активных задач.":
    "Use this only when a normal update or session operation is stuck. These actions bypass the safe wait for active tasks.",
  "Активных ответов: {{count}}. Жёсткий перезапуск может их прервать.":
    "Active responses: {{count}}. A force restart may interrupt them.",
  "Жёсткий перезапуск может прервать незавершённые операции.":
    "A force restart may interrupt unfinished operations.",
  "Жёстко перезапустить CodexNest? Текущее обновление будет остановлено, а незавершённые операции интерфейса могут быть прерваны. Codex daemon останется запущен.":
    "Force restart CodexNest? The current update will be stopped and unfinished interface operations may be interrupted. The Codex daemon will remain running.",
  "Жёстко перезапустить Codex daemon? Все активные ответы Codex будут прерваны.":
    "Force restart the Codex daemon? All active Codex responses will be interrupted.",
  "Жёстко перезапустить CodexNest": "Force restart CodexNest",
  "Жёстко перезапустить Codex": "Force restart Codex",
  "Перезапускаем CodexNest…": "Restarting CodexNest…",
  "Перезапускаем Codex…": "Restarting Codex…",
  "Codex daemon аварийно перезапущен.": "The Codex daemon was force restarted.",
  "Не удалось запустить аварийный перезапуск CodexNest":
    "Failed to start the CodexNest force restart",
  "Не удалось аварийно перезапустить Codex daemon": "Failed to force restart the Codex daemon",
  "CodexNest не восстановил соединение после перезапуска.":
    "CodexNest did not reconnect after the restart.",
  "Обновление CodexNest": "CodexNest update",
  "Сервер, APK и расширение для Chrome обновляются из одной проверенной CI-сборки с автоматическим откатом.":
    "The server, APK, and Chrome extension update from the same verified CI build with automatic rollback.",
  "Получаем версию CodexNest…": "Loading CodexNest version…",
  "Технические детали": "Technical details",
  "Повторить загрузку технических деталей": "Retry loading technical details",
  "Установлено на сервере": "Installed on server",
  "Актуальная версия в GitHub": "Latest version on GitHub",
  "Не проверялась": "Not checked",
  "APK на этом устройстве": "APK on this device",
  Состояние: "Status",
  Результат: "Result",
  "Обновления доступны только для установки через install.sh.":
    "Updates are available only for installations made with install.sh.",
  "Скачать свежий APK": "Download latest APK",
  "Скачать расширение для Chrome": "Download Chrome extension",
  "Не удалось открыть загрузку расширения для Chrome":
    "Failed to open the Chrome extension download",
  "Проверить обновления": "Check for updates",
  "Обновляем…": "Updating…",
  "Обновить CodexNest": "Update CodexNest",
  Готово: "Ready",
  Проверка: "Checking",
  Подготовка: "Preparing",
  Сборка: "Building",
  "Переключение версии": "Switching version",
  Перезапуск: "Restarting",
  Обновлено: "Updated",
  "Выполнен откат": "Rolled back",
  Ошибка: "Error",
  "Не удалось загрузить состояние Codex": "Failed to load Codex status",
  "Прокси проверен и применён. Codex daemon готов к работе.":
    "The proxy was verified and applied. The Codex daemon is ready.",
  "Проверка Codex и соединения через прокси завершена.":
    "Codex and its proxy connection were checked.",
  "Обновить Codex и перезапустить daemon?": "Update Codex and restart the daemon?",
  "Codex обновлён, проверен через прокси и перезапущен.":
    "Codex was updated, verified through the proxy, and restarted.",
  "Перезапустить Codex daemon?": "Restart the Codex daemon?",
  "Codex daemon перезапущен.": "The Codex daemon was restarted.",
  "Операция Codex завершилась ошибкой": "The Codex operation failed",
  "Версия и состояние Codex daemon на сервере.": "Codex daemon version and status on the server.",
  "Установленная версия Codex CLI": "Installed Codex CLI version",
  "Актуальная версия Codex CLI": "Latest Codex CLI version",
  "Дождитесь завершения активных ответов: {{count}}.":
    "Wait for active responses to finish: {{count}}.",
  "Дождитесь завершения активных ответов перед обновлением CodexNest.":
    "Wait for active responses to finish before updating CodexNest.",
  "Проверить Codex CLI": "Check Codex CLI",
  "Обновить Codex CLI": "Update Codex CLI",
  "Перезапускаем…": "Restarting…",
  Перезапустить: "Restart",
  Прокси: "Proxy",
  "Внутренние запросы Codex идут через fail-closed прокси; команды агента — напрямую.":
    "Internal Codex requests use the fail-closed proxy; agent commands connect directly.",
  "Получаем состояние прокси…": "Loading proxy status…",
  "Текущий прокси": "Current proxy",
  "WebSocket ChatGPT/OpenAI доступен через прокси.":
    "The ChatGPT/OpenAI WebSocket is reachable through the proxy.",
  "Ввод прокси с паролем доступен только через HTTPS или локальное подключение.":
    "A password-protected proxy can be entered only over HTTPS or a local connection.",
  "Новый HTTP/HTTPS-прокси": "New HTTP/HTTPS proxy",
  "Будет проверен до перезапуска Codex daemon.":
    "It will be verified before the Codex daemon restarts.",
  "Форматы: host:port, host:port:user:password, user:password@host:port или полный URL.":
    "Formats: host:port, host:port:user:password, user:password@host:port, or a full URL.",
  "Проверяем и применяем…": "Checking and applying…",
  "Проверить и применить": "Check and apply",
  "Не настроен": "Not configured",
  " · пароль сохранён": " · password saved",
  Работает: "Running",
  "Не поддерживается": "Unsupported",
  Недоступен: "Unavailable",
  "Открыть список задач": "Open task list",
  "Показать сведения": "Show details",
  "Принудительно обновить сессию": "Force refresh session",
  "Обновляем состояние сессии": "Refreshing session state",
  "Не удалось обновить сессию": "Failed to refresh session",
  "Не удалось создать задачу": "Failed to create task",
  "Новая задача": "New task",
  "Выберите проект": "Select a project",
  "Что поручим Codex?": "What should Codex do?",
  "Опишите задачу — работа продолжится на сервере, даже если закрыть приложение.":
    "Describe the task — work will continue on the server even if you close the app.",
  "Распознавание речи не настроено": "Speech recognition is not configured",
  "Закрыть сведения": "Close details",
  "Не удалось открыть папку": "Failed to open folder",
  "Не удалось создать папку": "Failed to create folder",
  "Не удалось добавить проект": "Failed to add project",
  "Рабочая папка на сервере": "Working folder on the server",
  Закрыть: "Close",
  "На уровень выше": "Up one level",
  "Путь к папке": "Folder path",
  "Предыдущее изображение": "Previous image",
  "Просмотр изображений": "Image viewer",
  "Домашняя папка": "Home folder",
  Загрузка: "Loading",
  "Новая папка": "New folder",
  "Показывать скрытые": "Show hidden folders",
  "Название новой папки": "New folder name",
  "Создаём…": "Creating…",
  Создать: "Create",
  Отмена: "Cancel",
  Папки: "Folders",
  "Получаем папки с сервера…": "Loading folders from the server…",
  "Скрытые папки не показаны": "Hidden folders are not shown",
  "В этой папке нет других папок": "There are no other folders here",
  "Добавляем…": "Adding…",
  "Выбрать эту папку": "Select this folder",
  Домашняя: "Home",
  "Сведения о задаче": "Task details",
  Сведения: "Details",
  Сессия: "Session",
  "Разделы сведений": "Details sections",
  Обзор: "Overview",
  Артефакты: "Artifacts",
  "Артефакты, {{count}}": "Artifacts, {{count}}",
  "Загружаем артефакты…": "Loading artifacts…",
  "Не удалось загрузить артефакты.": "Could not load artifacts.",
  "В этой сессии пока нет артефактов": "There are no artifacts in this session yet",
  "Файлы появятся здесь, когда Codex приложит их к ответу.":
    "Files will appear here when Codex attaches them to a response.",
  "Артефакты недоступны для этой сессии": "Artifacts are unavailable for this session",
  "Явные артефакты доступны в новых сессиях.": "Explicit artifacts are available in new sessions.",
  Статус: "Status",
  Проект: "Project",
  Создана: "Created",
  Обновлена: "Updated",
  "Рабочая папка": "Working folder",
  Открепить: "Unpin",
  Закрепить: "Pin",
  "Вернуть из архива": "Restore from archive",
  Архивировать: "Archive",
  "Сведения о новой задаче": "New task details",
  "Не выбран": "Not selected",
  "Задача будет создана после отправки первого сообщения.":
    "The task will be created after the first message is sent.",
  "Загрузка…": "Loading…",
  Недоступно: "Unavailable",
  "Не Git-репозиторий": "Not a Git repository",
  "Нет изменений": "No changes",
  "{{count}} file": "{{count}} file",
  "{{count}} files": "{{count}} files",
  "{{count}} файл": "{{count}} file",
  "{{count}} файла": "{{count}} files",
  "{{count}} файлов": "{{count}} files",
  "Нужно решение": "Needs attention",
  Выполняется: "Running",
  Завершена: "Completed",
  Прервана: "Interrupted",
  Готова: "Ready",
  Недоступна: "Unavailable",
  Модель: "Model",
  "Настройки модели": "Model settings",
  "Модель и уровень рассуждений": "Model and reasoning effort",
  "Уровень рассуждений": "Reasoning effort",
  "Выключить режим планирования": "Disable Plan mode",
  "Включить режим планирования": "Enable Plan mode",
  "Выключить командный режим": "Disable Team mode",
  "Включить командный режим": "Enable Team mode",
  "Свернуть субагентов": "Collapse subagents",
  "Показать субагентов": "Show subagents",
  "Субагент управляется родительской сессией. Здесь доступен только просмотр.":
    "This subagent is managed by its parent session. This view is read-only.",
  "Открыть родительскую сессию": "Open parent session",
  "Запуск субагента": "Starting subagent",
  "Запущен субагент": "Subagent started",
  "Не удалось запустить субагента": "Failed to start subagent",
  "Получен результат субагента": "Subagent result received",
  "Получены результаты субагентов": "Subagent results received",
  "Статус результата: {{status}}": "Result status: {{status}}",
  "Проверки результата": "Result checks",
  Успешно: "Successful",
  Частично: "Partial",
  Заблокировано: "Blocked",
  Пройдена: "Passed",
  "Не запускалась": "Not run",
  Причина: "Reason",
  Изменения: "Changes",
  "Изменённые файлы": "Changed files",
  "Показано {{shown}} из {{total}}": "Showing {{shown}} of {{total}}",
  "Истекло время": "Timed out",
  "Исчерпан бюджет токенов": "Token budget exhausted",
  "Изменения интегрированы": "Changes integrated",
  "Изолированная рабочая папка готова": "Isolated workspace ready",
  "Интегрируем изменения": "Integrating changes",
  "Конфликт интеграции": "Integration conflict",
  "Интеграция не требуется": "No integration needed",
  "Интеграция требует восстановления": "Integration recovery required",
  "Управление целью": "Manage goal",
  Пауза: "Pause",
  Продолжить: "Resume",
  Очистить: "Clear",
  "Выключить режим цели": "Disable Goal mode",
  "Включить режим цели": "Enable Goal mode",
  "Цель активна": "Goal active",
  "Цель на паузе": "Goal paused",
  "Цель заблокирована": "Goal blocked",
  "Достигнут лимит использования": "Usage limit reached",
  "Достигнут бюджет цели": "Goal budget reached",
  "Цель выполнена": "Goal complete",
  "{{count}}м {{seconds}}с": "{{count}}m {{seconds}}s",
  "{{count}}с": "{{count}}s",
  "{{count}} токен": "{{count}} token",
  "{{count}} токена": "{{count}} tokens",
  "{{count}} токенов": "{{count}} tokens",
  "Требуется внимание": "Attention required",
  "Прокрутить к последнему сообщению": "Scroll to latest message",
  "Запрос уже закрыт": "The request is already closed",
  "Разрешить команду?": "Allow this command?",
  "Команда не указана": "No command provided",
  "Сетевой host: {{host}}": "Network host: {{host}}",
  "Отдельные изменения policy": "Separate policy changes",
  "Обычное подтверждение эти правила не применяет.":
    "A regular approval does not apply these rules.",
  "Разрешить изменения файлов?": "Allow file changes?",
  "Запрошенный корень: {{root}}": "Requested root: {{root}}",
  "Несовместимое действие": "Unsupported action",
  "Разрешить один раз": "Allow once",
  "На сессию": "For session",
  Отказать: "Decline",
  "Отменить turn": "Cancel turn",
  "Дополнительные разрешения": "Additional permissions",
  Сеть: "Network",
  Чтение: "Read",
  Запись: "Write",
  "Выдать на turn": "Grant for turn",
  "Codex просит уточнение": "Codex needs clarification",
  "Вопрос {{current}} из {{total}}": "Question {{current}} of {{total}}",
  "Свой ответ": "Your answer",
  "Отправить ответы": "Submit answers",
  Далее: "Next",
  "Автовыбор через {{seconds}} сек.": "Automatic selection in {{seconds}} sec.",
  "Время автовыбора истекло": "Automatic selection time expired",
  "Действие во внешнем сервисе": "Action in an external service",
  "Открыть в браузере": "Open in browser",
  "Открыть изображение {{name}}": "Open image {{name}}",
  "Открыть изображение {{number}}": "Open image {{number}}",
  "Загружаем изображение…": "Loading image…",
  "Не удалось загрузить изображение. Повторить": "Could not load image. Retry",
  Отменить: "Cancel",
  "Форма инструмента": "Tool form",
  Отправить: "Submit",
  Выберите: "Select",
  "Заполните обязательное поле «{{field}}»": "Complete the required field “{{field}}”",
  "Выберите больше значений в поле «{{field}}»": "Select more values in “{{field}}”",
  "Выберите меньше значений в поле «{{field}}»": "Select fewer values in “{{field}}”",
  "Codex app-server недоступен": "Codex app-server is unavailable",
  "Без названия": "Untitled",
  "Инструмент завершился с ошибкой": "Tool finished with an error",
  "MCP-инструмент": "MCP tool",
  Инструмент: "Tool",
  "Активность Codex": "Codex activity",
  "Первый ход начат, но цель осталась на паузе. Продолжите её вручную.":
    "The first turn started, but the goal remained paused. Resume it manually.",
  "Эта версия Codex запросила действие, которое CodexNest пока не поддерживает.":
    "This Codex version requested an action that CodexNest does not support yet.",
  "Codex работает": "Codex is working",
  Аннотация: "Annotate",
  "Аннотация {{number}}": "Annotation {{number}}",
  "В очереди": "Queued",
  "Выполнен поиск": "Search completed",
  "Выполнена команда": "Command executed",
  Выполнено: "Completed",
  "Выполнены действия": "Actions completed",
  "Выполнены команды": "Commands executed",
  "Да, реализуй этот план": "Yes, implement this plan",
  "Да, реализуй этот план в режиме оркестратора": "Yes, implement this plan in orchestrator mode",
  "Действия с задачей": "Task actions",
  "Для доступа к микрофону откройте CodexNest по HTTPS":
    "Open CodexNest over HTTPS to access the microphone",
  "Добавить в очередь": "Add to queue",
  "Добавляется…": "Adding…",
  "Добавить изображения": "Add images",
  "Загружаем старые сообщения": "Loading older messages",
  Задача: "Task",
  "Задача не найдена": "Task not found",
  "Заканчиваем…": "Finishing…",
  Закончить: "Finish",
  "Запись {{time}}": "Recording {{time}}",
  "Запись не содержит аудио": "The recording contains no audio",
  "Запись с микрофона не поддерживается на этом устройстве":
    "Microphone recording is not supported on this device",
  "Запись слишком большая": "The recording is too large",
  "Запись на сервере · можно закрыть": "Saved on the server · safe to close",
  "На сервере · ожидание {{time}}": "On the server · waiting {{time}}",
  "На сервере · ожидание": "On the server · waiting",
  "Запрашиваем доступ к микрофону": "Requesting microphone access",
  "Запустить цель": "Start goal",
  "Запустить в режиме оркестратора": "Run in orchestrator mode",
  "Изменены файлы": "Files changed",
  "Изменён {{path}}": "Changed {{path}}",
  "Изображение {{number}}": "Image {{number}}",
  "Изображение {{current}} из {{total}}": "Image {{current}} of {{total}}",
  Изображения: "Images",
  "Использованы инструменты": "Tools used",
  "Идёт распознавание в другой сессии": "A recording is being transcribed in another session",
  Комментарий: "Comment",
  "Комментарий к выделенному тексту": "Comment on selected text",
  "Блок скопирован": "Block copied",
  Копировать: "Copy",
  "Копировать блок": "Copy block",
  "Копировать сообщение": "Copy message",
  "Создать ответвление отсюда": "Fork from here",
  "Микрофон занят другим приложением": "The microphone is in use by another app",
  "Микрофон не найден": "Microphone not found",
  Название: "Name",
  "Направить текущую задачу": "Steer the current task",
  "Направить текущую задачу…": "Steer the current task…",
  "Начать запись": "Start recording",
  "Не выполнено": "Not completed",
  "Не удалось закончить сессию": "Failed to finish the session",
  "Не удалось записать аудио": "Failed to record audio",
  "Не удалось изменить настройки": "Failed to change settings",
  "Не удалось изменить сообщение в очереди": "Failed to update the queued message",
  "Не удалось изменить цель": "Failed to change the goal",
  "Не удалось начать запись с микрофона": "Failed to start microphone recording",
  "Не удалось начать реализацию плана": "Failed to start implementing the plan",
  "Не удалось начать реализацию плана в режиме оркестратора":
    "Failed to start implementing the plan in orchestrator mode",
  "Не удалось отправить сообщение": "Failed to send the message",
  "Не удалось отправить сразу — сообщение осталось в очереди":
    "Could not send immediately — the message remains queued",
  "Это сообщение уже отправлено": "This message has already been sent",
  "Не удалось остановить задачу": "Failed to stop the task",
  "Не удалось отправить запись на сервер": "Failed to upload the recording",
  "Не удалось очистить цель": "Failed to clear the goal",
  "Не удалось прочитать выбранное изображение": "Failed to read the selected image",
  "Не удалось распознать запись": "Failed to transcribe the recording",
  "Не удалось скачать файл. Нажмите ещё раз.": "Failed to download the file. Click again.",
  "Просмотр файла {{name}}": "Viewing {{name}}",
  "Открыть {{name}}": "Open {{name}}",
  "открываем…": "opening…",
  "Скачать {{name}}": "Download {{name}}",
  Скачать: "Download",
  "Обновить предпросмотр": "Refresh preview",
  "Закрыть предпросмотр": "Close preview",
  "Вернуться к артефактам": "Back to artifacts",
  "Загружаем файл…": "Loading file…",
  "Не удалось открыть файл": "Could not open the file",
  "Файл мог быть перемещён или удалён.": "The file may have been moved or deleted.",
  "Файл слишком большой для предпросмотра": "The file is too large to preview",
  "Размер файла — {{size}}. Его можно скачать.":
    "The file is {{size}}. You can download it instead.",
  "Не удалось отобразить PDF": "Could not display the PDF",
  "Скачайте файл, чтобы открыть его в другом приложении.":
    "Download the file to open it in another app.",
  "Готовим страницы PDF…": "Preparing PDF pages…",
  "Не удалось скопировать": "Failed to copy",
  "Не удалось скопировать блок": "Failed to copy block",
  "Не удалось сохранить черновик": "Failed to save the draft",
  "Не удалось удалить сообщение из очереди": "Failed to delete the queued message",
  "Несовместимое событие": "Unsupported event",
  "Нет доступа к микрофону. Разрешите его в настройках приложения или браузера":
    "Microphone access is denied. Allow it in the app or browser settings",
  "Опишите проверяемый результат цели…": "Describe a verifiable goal outcome…",
  "Остановить задачу": "Stop task",
  "Остановить запись": "Stop recording",
  "Отменить запись": "Discard recording",
  "Отменить обработку записи": "Cancel recording processing",
  "Не удалось отменить обработку записи": "Failed to cancel recording processing",
  "Отправить сейчас": "Send now",
  "Отправляем запись": "Uploading recording",
  "Отправляем запись — не закрывайте": "Uploading recording — do not close",
  "Отправляется…": "Sending…",
  "Отредактированы файлы": "Files edited",
  "Очередь сообщений": "Message queue",
  "Ошибка копирования": "Copy failed",
  Переименовать: "Rename",
  "Изменить сообщение в очереди": "Edit queued message",
  План: "Plan",
  "Повторить загрузку старых сообщений": "Retry loading older messages",
  "Прочитаны файлы": "Files read",
  "Работал {{duration}}": "Worked for {{duration}}",
  "Распознавание не вернуло текст": "Speech recognition returned no text",
  "Распознаём · дольше прогноза на {{time}}": "Transcribing · {{time}} longer than estimated",
  "Распознаём · осталось ≈ {{time}}": "Transcribing · about {{time}} remaining",
  "Распознаём · прошло {{time}}": "Transcribing · {{time}} elapsed",
  Распознаём: "Transcribing",
  "Распознаём запись": "Transcribing recording",
  "Распознаём…": "Transcribing…",
  "Распознать и отправить": "Transcribe and send",
  "Режим голосового ввода": "Voice input mode",
  "Вставить в поле": "Insert into input",
  "Включить автоотправку голосового ввода": "Enable voice input auto-send",
  "Выключить автоотправку голосового ввода": "Disable voice input auto-send",
  "Готовим отправку": "Preparing to send",
  "На сервере · готовим результат": "On the server · preparing the result",
  "На сервере · {{status}}": "On the server · {{status}}",
  Скопировано: "Copied",
  "Сначала отправьте или удалите аннотации": "Send or delete the annotations first",
  "Сначала отправьте или удалите аннотации к плану": "Send or delete the plan annotations first",
  "Сообщение будет добавлено в очередь": "The message will be added to the queue",
  "Сообщение для Codex": "Message for Codex",
  "Следующее изображение": "Next image",
  "Сохранить аннотацию": "Save annotation",
  "Спросите что угодно": "Ask anything",
  Удалить: "Delete",
  "Удалить сообщение из очереди": "Delete queued message",
  "Удалить аннотацию": "Delete annotation",
  "Удалить изображение {{name}}": "Delete image {{name}}",
  "Удаляем…": "Deleting…",
  "Текст сообщения в очереди": "Queued message text",
  "Ход работы": "Progress",
  "Чтобы начать задачу, добавьте рабочую папку.": "Add a workspace folder to start a task.",
  "Этот браузер не поддерживает запись WebM или MP4":
    "This browser does not support WebM or MP4 recording",
  выполняется: "in progress",
  готово: "completed",
  ошибка: "failed",
  "скачиваем…": "downloading…",
  "Установка не управляется installer'ом CodexNest":
    "This installation is not managed by the CodexNest installer",
  "Управление доступно только при daemon-режиме Codex":
    "Management is available only when Codex runs in daemon mode",
  "Codex CLI или daemon недоступны. Установите Codex, выполните вход и запустите codexnest repair.":
    "Codex CLI or daemon is unavailable. Install Codex, sign in, and run codexnest repair.",
  "Файл прокси доступен группе или другим пользователям":
    "The proxy file is accessible to the group or other users",
  "Не удалось прочитать конфигурацию прокси": "Failed to read the proxy configuration",
  "Конфигурация прокси повреждена или противоречива":
    "The proxy configuration is corrupt or inconsistent",
};

export type TranslationVariables = Record<string, string | number>;
export type Translate = (key: string, variables?: TranslationVariables) => string;

type I18nContextValue = {
  language: UiLanguage;
  setLanguage(language: UiLanguage): void;
  t: Translate;
};

const fallbackContext: I18nContextValue = {
  language: "ru",
  setLanguage: () => undefined,
  t: (key, variables) => interpolate(key, variables),
};

const I18nContext = createContext<I18nContextValue>(fallbackContext);

export function I18nProvider({ children }: PropsWithChildren) {
  const [language, setLanguageState] = useState<UiLanguage>(readInitialLanguage);

  const setLanguage = useCallback((next: UiLanguage) => {
    setLanguageState(next);
    localStorage.setItem(LANGUAGE_KEY, next);
    document.documentElement.lang = next;
  }, []);

  useEffect(() => {
    localStorage.setItem(LANGUAGE_KEY, language);
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      setLanguage,
      t: (key, variables) => translate(language, key, variables),
    }),
    [language, setLanguage],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export function translate(
  language: UiLanguage,
  key: string,
  variables?: TranslationVariables,
): string {
  const template = language === "en" ? (ENGLISH[key] ?? key) : key;
  return interpolate(template, variables);
}

export function localizeKnownServerText(
  language: UiLanguage,
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  if (language === "ru") return value;
  const direct = ENGLISH[value];
  if (direct) return direct;
  const execAmendment = /^Разрешать похожую команду: (.*)$/s.exec(value);
  if (execAmendment) return `Allow similar command: ${execAmendment[1]}`;
  const networkAmendment = /^(Разрешать|Запрещать) сеть для (.*)$/s.exec(value);
  if (networkAmendment) {
    return `${networkAmendment[1] === "Разрешать" ? "Allow" : "Deny"} network access for ${networkAmendment[2]}`;
  }
  return value;
}

export function readInitialLanguage(): UiLanguage {
  const stored = localStorage.getItem(LANGUAGE_KEY);
  if (stored === "en" || stored === "ru") return stored;
  return LEGACY_INSTALLATION_KEYS.some((key) => localStorage.getItem(key) !== null) ? "ru" : "en";
}

function interpolate(template: string, variables?: TranslationVariables): string {
  if (!variables) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
    String(variables[name] ?? ""),
  );
}
