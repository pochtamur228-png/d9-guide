# Бот напоминаний D9

Cloudflare Worker: напоминает о подарке за онлайн (4 ч), турнирах по рыбалке (11:45 и 19:45 МСК) и налоге на дом (13 дней).

Команды бота: `/remind` — меню напоминаний, `/app` — открыть справочник.

## Развернуть заново

```bash
npx.cmd --yes wrangler@4 login
npx.cmd --yes wrangler@4 deploy
npx.cmd --yes wrangler@4 secret put BOT_TOKEN
```

Потом открыть `https://d9-reminders.9--ot.workers.dev/setup` — это заново подключит вебхук Telegram.

Токен бота хранится только как секрет Cloudflare и в репозиторий не попадает.
