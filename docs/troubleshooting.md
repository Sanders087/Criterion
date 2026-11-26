# Разбор инцидентов Criterion

Попросите время обращения с часовым поясом, действие пользователя и `requestId` из интерфейса или заголовка `X-Request-ID`. В Amvera откройте «Лог приложения», выберите развёрнутый релиз и найдите этот идентификатор. Для связанных обращений используйте `operationId` в JSON-событиях и время `timestamp` в UTC. Текста договора, платёжной ссылки, адреса получателя и содержимого письма для поиска не требуется.

## Пользователь не может оплатить

1. Найдите `payment.checkout_started`, `payment.order_created`, `payment.init_started` и результат. Если ни одного из них нет, начните с `http.request_failed` для `/api/payments/checkout`. Проверьте вход, готовность черновика, лимит попыток и `PAYMENT_UNAVAILABLE`.
   При `CLIENT_OFFLINE` или `CLIENT_NETWORK_ERROR` браузер может не получить `requestId`. Запишите время, проверьте тот же договор после восстановления сети и выберите «Проверить оплату».
2. У `payment.transport_failed` посмотрите `component`, `stage`, `bankMethod`, `errorCode` и `upstreamStatus`. Если используется шлюз, сопоставьте события `payment_site` и `payment_gateway`. `GATEWAY_CONNECTION_REFUSED` локализует отказ до шлюза. `BANK_REQUEST_REJECTED` означает ответ банковского API, для решения важен метод.
3. При `payment.init_outcome_unknown` предложите «Проверить оплату». Найдите `payment.status_checked` и статус того же заказа. После `manual_review` передайте заказ ответственному за терминал. Новый платёж возможен отдельным действием пользователя после подтверждения закрытия предыдущего. [Состояния, сетевые бюджеты и условия отмены](payment-flow.md)

## Банк списал деньги, доступ не появился

1. По `operationId` проверьте `payment.notification_received`, `payment.notification_rejected`, `payment.status_changed`, `payment.access_granted` и `payment.access_grant_failed`. При `invalid_signature` проверьте согласованность терминала и секрета, при `amount_mismatch` — соответствие сохранённому заказу. При отсутствии уведомления проверьте адрес реле и состояние доставки в кабинете банка.
2. `AUTHORIZED` соответствует промежуточному состоянию. Для `CONFIRMED` проверьте событие выдачи либо текущее состояние договора в кабинете владельца. Дубль с `payment.notification_duplicate` может сопровождаться ранее успешной выдачей. `REFUNDED` закрывает доступ.
3. При ошибке записи найдите `database.operation_failed`, внешний `operation` и результат отката. После восстановления SQLite используйте штатную проверку того же заказа, фоновую сверку или повторную доставку подписанного уведомления банком. `payment.reconciliation_result` с `manual_review` означает исчерпание фоновых попыток. Команда ниже выведет такие операции. [Сверка и работа дежурного](payment-flow.md)

## Письмо не приходит

1. По `requestId` найдите `mail.request_received`. По его `operationId` проверьте `mail.send_skipped`, `mail.rate_limited`, `mail.send_started`, `mail.provider_accepted`, `mail.provider_rejected`, `mail.outcome_unknown`.
2. `CONFIG_INVALID` требует сверки настроек отправителя, `AUTH_PUBLIC_URL` и секрета Resend. `RATE_LIMITED` требует дождаться окна. `SKIPPED` может быть штатным результатом запроса сброса. HTTP 200 подтверждает приём пользовательского запроса. Сведения о наличии учётной записи остаются закрытыми.
3. При `PROVIDER_ACCEPTED` проверьте доставку по `providerMessageId` в кабинете Resend. `mail.status_save_failed` означает, что провайдер принял письмо до сбоя сохранения результата. При `OUTCOME_UNKNOWN` возможна доставка. Проверьте статус у провайдера до повторной отправки по инициативе пользователя. [Почтовые статусы и срок действия ссылок](mail-operations.md)

## Нейросеть не отвечает

1. Найдите `ai.request_started`, `ai.request_failed`, `ai.request_completed`, `ai.response_validated`, `ai.response_validation_failed`. Если `ai.request_started` отсутствует, проверьте предшествующий `pii.stage_failed` и `AI_CONFIG_INVALID`.
2. `AI_AUTH_FAILED` требует проверки доступа к модели, `AI_RATE_LIMITED` — квоты. Для `AI_TIMEOUT` и `AI_NETWORK_ERROR` сопоставьте `durationMs`, доступность исходящей сети и последние наблюдения интеграции. `AI_OUTPUT_TRUNCATED` требует сократить дополнительные материалы. Ошибки схемы или разделов требуют проверки контракта шаблона на синтетическом примере.
3. `ai.request_completed` подтверждает получение и обработку ответа на сетевом этапе. Для сохранённого результата проверьте также `document.revision_saved` и фактическую версию договора. При `document.revision_save_failed` сначала разберите конфликт версии или отказ SQLite. [Коды ИИ и записи](error-codes.md)

## Не работает обезличивание

1. Проверьте `service.ready` с `component="PII detector"`, `/api/health/ready`, затем `pii.stage_failed` и `pii.stage_completed` конкретной операции. `detector_request` локализует сбой соединения или HTTP, `detector_response_validation` — формат и диапазоны ответа, `anonymization` — замену значений.
2. `PII_CONFIG_INVALID`, `PII_TIMEOUT`, `PII_HTTP_ERROR` требуют сверки настроек и связи сайта с локальным детектором. `PII_SPAN_INVALID` требует проверки диапазонов UTF-16 и версии профиля. Отказ на этапе `pii_restoration` с `PII_RESTORE_FAILED` или `AI_PII_RESTORE_FAILED` относится к возврату исходных значений после ответа модели.
3. Для проверки качества используйте размеченный синтетический корпус. Успешная проба готовности подтверждает ответ процесса с авторизацией. Точность выделения сущностей и корректность восстановления проверяются на примерах. При сбое перед отправкой цепочка останавливается до внешнего ИИ. [Проверки модуля ПДн](privacy/README.md)

## База данных заблокирована

1. В `database.operation_failed` найдите `DB_BUSY` или `DB_LOCKED`, `operation`, `parentOperation`, `durationMs`, `busyTimeoutMs`, `busyTimeoutElapsed`, `rolledBack` и `rollbackFailed`. Различайте блокировку SQLite и ответ 409 из-за ревизии или прикладной блокировки договора.
2. Сопоставьте время с другими операциями и запусками. Проверьте число пишущих экземпляров, размер и рост WAL, тип тома и загрузку хранилища. При `nfs4` согласуйте с платформой поддержку блокировок SQLite/WAL в данной топологии.
3. Снизьте конкурирующую нагрузку по эксплуатационному регламенту. После освобождения блокировки проверьте чтение и результат исходной операции. Для оплаты используйте сверку существующего заказа. [Диагностика хранилища](backup-restore.md)

## Закончилось место на диске

1. Ищите `DB_FULL`, `SQLITE_FULL`, `ENOSPC`, затем `storage.health` с `freeBytes`, `databaseBytes`, `walBytes`, `backupStatus`. Проверьте свободные блоки и inode именно на томе `DATABASE_PATH`, квоту проекта и свободное место резервного хранилища, если копии размещены отдельно.
2. Уточните, когда был последний успешный бэкап и рос ли WAL несколько замеров подряд. Большой WAL может быть следствием длительного чтения или невозможности checkpoint. Снимок свободного места фиксирует только момент измерения.
3. Согласуйте расширение тома или очистку подтверждённых служебных файлов по принятой политике хранения. Сохраните связанные файлы `criterion.sqlite`, `-wal`, `-shm` и проверенные копии. После восстановления места проверьте readiness и исходный заказ или ревизию. [Резервирование и восстановление](backup-restore.md)

## Приложение не запускается

1. В журнале сборки и событиях Amvera сопоставьте версию образа с последним запуском. В журнале приложения найдите `startup.failed`, `service.failed`, `service.exited`, `service.starting`, `service.ready`, `database.ready`, `site.starting`. `services.signal` с последующей штатной остановкой может означать замену контейнера платформой.
2. Для `phase=configuration` или `supervisor` проверьте `AUTH_PUBLIC_URL`, формат секрета ПДн, внутренний адрес и порты. При `reason=readiness_timeout` откройте строки запуска Python. Для `phase=database_open_and_migrations` проверьте монтирование, доступ и совместимость комплекта SQL с уже применёнными миграциями. `database.ready` подтверждает открытый путь, запрос и миграции на тот момент.
3. Если `site.starting` уже был, сопоставьте входной порт, команду запуска и пробы. `/api/health/live` показывает, что HTTP-процесс отвечает. `/api/health/ready` дополнительно проверяет SQLite, миграции и детектор. При провале миграций используйте совместимый образ или согласованный план восстановления с сохранением исходного тома. [Health-пробы](health.md) · [Откат и SQLite](backup-restore.md)

## Команды первичной диагностики

Выполняйте команды в работающем контейнере Criterion из `/app`, от имени сервисного пользователя, с его `PORT` и `DATABASE_PATH`. Команды Node и Python используют инструменты из образа. Они читают краткие статусы и метаданные. Для остановленного экземпляра источниками остаются журналы платформы, настройки монтирования и история сборок.

```sh
node scripts/storage-diagnostics.mjs
node scripts/payment-reconciliation-review.mjs
python -c 'import os,shutil; from pathlib import Path; p=Path(os.environ["DATABASE_PATH"]).parent; d=shutil.disk_usage(p); print("free_bytes",d.free,"total_bytes",d.total,"free_inodes",os.statvfs(p).f_favail)'
node --input-type=module -e 'const origin=`http://127.0.0.1:${Number(process.env.PORT||3000)}`; for(const path of ["/api/health/live","/api/health/ready"]) {const r=await fetch(origin+path,{signal:AbortSignal.timeout(4000)});console.log(path,r.status)}'
```

Первая команда открывает существующую базу read-only, показывает её фактический путь и выполняет `SELECT 1`. Возможность записи проверяется успешной транзакцией приложения. Вторая команда читает список операций с исчерпанным бюджетом сверки. Пустой вывод означает отсутствие таких случаев на момент проверки. Третья показывает свободное место на локально смонтированном томе, квоты дополнительно видны у платформы. Четвёртая выполняет публичные проверки сайта; банки, почта и ИИ в них не вызываются.

Закрытое состояние интеграций доступно из доверенного контейнера с настроенным `MONITORING_TOKEN`. Следующая команда читает секрет из окружения без вывода его значения. В ответе выводятся только статусы компонентов с самого сервиса.

```sh
node --input-type=module -e 'const port=Number(process.env.PORT||3000);const r=await fetch(`http://127.0.0.1:${port}/api/health/integrations`,{headers:{Authorization:`Bearer ${process.env.MONITORING_TOKEN||""}`},redirect:"error",signal:AbortSignal.timeout(4000)});console.log(r.status);if(r.ok)console.log((await r.json()).components)'
```

`configured` отражает настройки. `reachable` и `functional` относятся к проверке конкретного компонента и времени последнего наблюдения на этом экземпляре. `unknown` встречается после запуска и истечения срока наблюдения. `/health` отдельного платёжного шлюза подтверждает работу его HTTP-обработчика. Готовность терминала к операции устанавливается по реальному результату уже состоявшегося вызова в выбранном окружении. [Как читать результаты интеграций](health.md)
