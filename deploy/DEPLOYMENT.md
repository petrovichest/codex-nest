# Развёртывание CodexNest

Эта инструкция описывает первый запуск CodexNest на Linux-сервере (в том числе
Raspberry Pi OS 64-bit) и дальнейшее обновление приложения. В результате сервер
работает как пользовательский `systemd`-сервис, а интерфейс доступен из браузера
и Android-приложения.

CodexNest рассчитан на одного владельца и приватную сеть. Не публикуйте порт
`4310` в интернете. Для доступа извне домашней сети используйте VPN или HTTPS с
обычной проверкой сертификата.

## 1. Требования

На сервере должны быть установлены:

- 64-битный Linux с `systemd`;
- Git;
- Node.js 24 LTS и npm 10 или новее;
- Codex CLI строго версии `0.144.6`;
- учётная запись Linux с доступом к папкам проектов.

Проверьте версии:

```bash
node --version
npm --version
codex --version
```

Codex CLI должен вывести `codex-cli 0.144.6`. С другой версией API запустится в
состоянии `degraded`, но операции с задачами будут недоступны: типы протокола
сгенерированы именно для `0.144.6`.

Все дальнейшие команды выполняйте от одного и того же обычного Linux-пользователя.
От него будут работать Codex CLI и сервис, поэтому не устанавливайте и не
авторизуйте Codex только под `root`.

Авторизуйте Codex и проверьте состояние входа:

```bash
codex login
codex login status
```

## 2. Получение и сборка приложения

Клонируйте репозиторий именно в `~/codex-nest`: этот путь использует пример
`systemd`-сервиса.

```bash
git clone git@github.com:petrovichest/codex-nest.git "$HOME/codex-nest"
cd "$HOME/codex-nest"
npm ci
npm run build
```

Сборка создаёт сервер в `apps/server/dist` и браузерный интерфейс в
`apps/client/dist`.

Перед первым production-запуском рекомендуется выполнить проверки:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run protocol:generate
git diff --exit-code -- apps/server/src/codex/generated apps/server/src/codex/PROTOCOL_VERSION
```

Последние две команды проверяют, что установленная версия Codex CLI соответствует
зафиксированному протоколу. Обычные тесты не обращаются к OpenAI и не расходуют
квоту.

## 3. Конфигурация

Создайте каталоги и скопируйте примеры:

```bash
mkdir -p "$HOME/.config/codexnest" "$HOME/.config/systemd/user"
cp deploy/systemd/codexnest.env.example "$HOME/.config/codexnest/server.env"
cp deploy/systemd/codexnest.service.example "$HOME/.config/systemd/user/codexnest.service"
chmod 600 "$HOME/.config/codexnest/server.env"
```

Узнайте реальные пути к исполняемым файлам:

```bash
command -v node
command -v codex
```

Откройте `~/.config/codexnest/server.env` и замените все значения `CHANGE_ME`.
В `CODEXNEST_CODEX_BIN` укажите результат `command -v codex`. Используйте полные
пути: `systemd` не подставляет `$HOME` и `~` в `EnvironmentFile`.

Production-пример включает `CODEXNEST_CODEX_TRANSPORT=daemon`. Один раз
установите и запустите штатный пользовательский daemon Codex от того же
пользователя, который запускает CodexNest:

```bash
codex app-server daemon bootstrap
codex app-server daemon version
```

CodexNest будет подключаться к нему через `codex app-server proxy`. При
перезапуске `codexnest.service` завершится только proxy-процесс, а выполняющийся
turn останется в daemon; после старта CodexNest переподключится и заново откроет
активную задачу. Для локальной разработки без daemon оставьте
`CODEXNEST_CODEX_TRANSPORT=stdio` или не задавайте переменную.

Затем откройте `~/.config/systemd/user/codexnest.service`. Если репозиторий лежит
не в `~/codex-nest` или Node.js установлен не в `~/.local/node-v24`, исправьте
`WorkingDirectory` и `ExecStart` в соответствии с результатом `command -v node`.

Не включайте для пользовательского сервиса `PrivateTmp` или `ProtectSystem`.
На Linux Codex создаёт собственную песочницу через `bubblewrap`; внешний mount/user
namespace от этих директив может заблокировать создание вложенной песочницы.
`NoNewPrivileges=true` при этом следует оставить включённым.

### Вариант A: HTTP внутри доверенной LAN

Это самый короткий путь для первого запуска. В `server.env` задайте:

```dotenv
CODEXNEST_HOST=0.0.0.0
CODEXNEST_PORT=4310
CODEXNEST_ALLOWED_ORIGINS=http://192.168.1.42:4310,http://localhost
```

Замените `192.168.1.42` на постоянный LAN-адрес или локальное имя сервера.
`http://localhost` нужен встроенному Android-клиенту. Не настраивайте проброс
порта `4310` на роутере: HTTP передаёт bearer token и содержимое сессий без
шифрования.

### Вариант B: HTTPS через reverse proxy

Это рекомендуемый вариант. Оставьте сервер на loopback и укажите внешний адрес:

```dotenv
CODEXNEST_HOST=127.0.0.1
CODEXNEST_PORT=4310
CODEXNEST_ALLOWED_ORIGINS=https://codexnest.example.com,http://localhost
```

Замените домен на свой. После первого запуска настройте Nginx по примеру
[`nginx/codexnest.conf.example`](./nginx/codexnest.conf.example) или Caddy по
примеру [`caddy/Caddyfile.example`](./caddy/Caddyfile.example). В обоих случаях
замените имя хоста и пути к сертификату, а затем проверьте конфигурацию прокси
перед перезагрузкой. Не используйте отключение TLS-проверки (`curl -k` или
accept-all certificate handler).

### Переменные окружения

| Переменная                           | Назначение                                        | Значение по умолчанию                         |
| ------------------------------------ | ------------------------------------------------- | --------------------------------------------- |
| `CODEXNEST_HOST`                     | Адрес прослушивания                               | `127.0.0.1`                                   |
| `CODEXNEST_PORT`                     | HTTP/API порт                                     | `4310`                                        |
| `CODEXNEST_ALLOWED_ORIGINS`          | Разрешённые browser/Android origins через запятую | локальные origins для разработки              |
| `CODEXNEST_STATE_PATH`               | Файл состояния и verifier токена                  | `~/.local/state/codexnest/state.json`         |
| `CODEXNEST_CODEX_BIN`                | Полный путь к Codex CLI                           | `codex` из `PATH`                             |
| `CODEXNEST_CODEX_TRANSPORT`          | `daemon` сохраняет активные turn при рестарте     | `stdio`                                       |
| `CODEXNEST_CLIENT_DIST`              | Собранный браузерный интерфейс                    | `apps/client/dist` относительно рабочей папки |
| `CODEXNEST_LOG_LEVEL`                | Уровень логов Fastify                             | `info`                                        |
| `CODEXNEST_FIREBASE_CREDENTIAL_PATH` | Необязательный service account JSON для FCM       | выключено                                     |
| `CODEXNEST_FIREBASE_PROJECT_ID`      | Необязательный Firebase project ID                | выключено                                     |

Для обычного запуска Firebase не нужен. Без него работают веб-интерфейс,
Android-клиент и все операции с задачами; недоступны только фоновые push-уведомления.

## 4. Создание access token

Загрузите production-конфигурацию в текущую оболочку и создайте токен владельца:

```bash
set -a
. "$HOME/.config/codexnest/server.env"
set +a
cd "$HOME/codex-nest"
npm run --silent auth:generate -w @codexnest/server
```

Команда выводит bearer token один раз. Сохраните его в менеджере паролей: в
файле состояния хранится только SHA-256 verifier, восстановить исходный токен из
него нельзя.

Для отзыва старого токена и выпуска нового выполните:

```bash
npm run --silent auth:generate -w @codexnest/server -- --rotate
```

После ротации все подключённые клиенты должны войти с новым токеном. Работающий
сервер подхватывает новый verifier из файла состояния без полного redeploy.

## 5. Запуск systemd-сервиса

Разрешите пользовательскому сервису работать после выхода из SSH-сессии, затем
запустите его:

```bash
sudo loginctl enable-linger "$(id -un)"
systemctl --user daemon-reload
systemctl --user enable --now codexnest.service
systemctl --user status codexnest.service
```

В daemon-режиме также проверьте отдельный app-server:

```bash
codex app-server daemon version
```

Посмотреть текущие логи:

```bash
journalctl --user -u codexnest.service -n 100 --no-pager
```

Следить за логами в реальном времени:

```bash
journalctl --user -u codexnest.service -f
```

## 6. Проверка и первый вход

На самом сервере проверьте health endpoint:

```bash
curl --fail --silent --show-error http://127.0.0.1:4310/api/v1/health
```

Исправный ответ содержит:

```json
{
  "status": "ok",
  "appServer": {
    "state": "ready",
    "expectedVersion": "0.144.6",
    "installedVersion": "0.144.6"
  }
}
```

В ответе будут и дополнительные поля. Если `status` равен `degraded`, сначала
посмотрите журнал сервиса.

Откройте с другого устройства:

- для варианта A — `http://192.168.1.42:4310`;
- для варианта B — `https://codexnest.example.com`.

На экране подключения укажите этот же адрес сервера и созданный bearer token.
Затем нажмите «Добавить проект» и укажите абсолютный путь к уже существующей
папке на сервере, например `/home/pi/git/my-project`. Пользователь сервиса должен
иметь права на чтение и запись в эту папку.

Инструкция по сборке и установке Android APK находится в
[`apps/client/android/README.md`](../apps/client/android/README.md).

## 7. Обновление

Развёртывайте обновления только через Git. После того как изменения закоммичены
и отправлены в remote, выполните на сервере:

```bash
cd "$HOME/codex-nest"
git pull --ff-only
npm ci
npm run build
npm run typecheck
npm test
systemctl --user restart codexnest.service
curl --fail --silent --show-error http://127.0.0.1:4310/api/v1/health
```

Не копируйте отдельные файлы приложения на сервер вручную. Если менялись unit-файл
или `server.env`, обновите их отдельно из соответствующих `.example`, проверьте
локальные значения и выполните `systemctl --user daemon-reload` перед restart.

## 8. Резервная копия

Остановите сервис и скопируйте файл `CODEXNEST_STATE_PATH`:

```bash
systemctl --user stop codexnest.service
cp "$HOME/.local/state/codexnest/state.json" <КАТАЛОГ-РЕЗЕРВНЫХ-КОПИЙ>/state.json
systemctl --user start codexnest.service
```

В нём находятся verifier токена, список проектов, read/pin/outcome metadata и
регистрации FCM. Промпты, ответы и вывод команд там не хранятся. История Codex
остаётся в `~/.codex` и должна резервироваться отдельно.

## 9. Типовые проблемы

- **`status: degraded` / `incompatible`.** Проверьте `codex --version` именно от
  пользователя сервиса и значение `CODEXNEST_CODEX_BIN`. Требуется `0.144.6`.
- **`status: degraded` в daemon-режиме.** Выполните
  `codex app-server daemon version`. Если control socket отсутствует, повторите
  `codex app-server daemon bootstrap` от пользователя сервиса.
- **Сервис завершается с `203/EXEC`.** Путь к Node.js в `ExecStart` неверен.
  Подставьте абсолютный результат `command -v node`.
- **`403 Origin not allowed`.** Добавьте точный origin клиента, включая схему и
  порт, в `CODEXNEST_ALLOWED_ORIGINS`, затем перезапустите сервис.
- **Интерфейс не открывается, но health endpoint работает.** Убедитесь, что
  `npm run build` создал `apps/client/dist` и `WorkingDirectory` указывает на корень
  репозитория.
- **Проект не добавляется.** Путь должен существовать на сервере, быть абсолютным
  и быть доступным пользователю, от которого работает сервис.
- **Codex видит другой логин или конфигурацию.** Повторите `codex login status` от
  того же пользователя. CodexNest использует его `~/.codex` и окружение.

## Android / Firebase release

Для подписанной APK-сборки следуйте
[`apps/client/android/README.md`](../apps/client/android/README.md). Личные
`google-services.json`, Firebase service account, signing keystore и пароли
остаются вне Git. После сборки проверьте подпись и создайте checksum:

```bash
cd "$HOME/codex-nest/apps/client/android"
apksigner verify --verbose app/build/outputs/apk/release/app-release.apk
shasum -a 256 app/build/outputs/apk/release/app-release.apk > CodexNest-1.0.apk.sha256
```

Перед релизом проверьте чистую установку и обновление APK, подключение по выбранной
схеме HTTP/HTTPS, а при включённом FCM — уведомления в foreground, background и
после обычного завершения процесса. Android force-stop блокирует уведомления до
следующего ручного запуска приложения.
