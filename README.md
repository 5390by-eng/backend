# Backend Worker

Cloudflare Worker with `POST /api/chat` endpoint that decomposes a large task into subtasks, assigns them to board members in round-robin order, and saves them to Supabase.

## Environment variables

Copy `.dev.vars.example` to `.dev.vars` and set:

- `OPENROUTER_API_KEY` — API key for OpenRouter
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_ANON_KEY` — anon or publishable key (used by chat RPC functions)
- `SUPABASE_SERVICE_ROLE_KEY` — optional secret/service role key
- `ALLOWED_ORIGINS` — optional comma-separated CORS origins
- `TELEGRAM_BOT_TOKEN` — Telegram Bot API token from [@BotFather](https://t.me/BotFather)
- `TELEGRAM_WEBHOOK_SECRET` — secret token for webhook validation (`X-Telegram-Bot-Api-Secret-Token`)

For production, set secrets with Wrangler:

```bash
wrangler secret put OPENROUTER_API_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_ANON_KEY
# optional:
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

## API

### `POST /api/chat`

Request:

```json
{
  "message": "Создать лендинг для продукта",
  "boardId": "4349e4fd-03df-4e56-8b29-b618dad9914f"
}
```

Response:

```json
[
  {
    "id": "uuid",
    "title": "Определить требования",
    "boardId": "4349e4fd-03df-4e56-8b29-b618dad9914f",
    "status": "backlog",
    "priority": "medium",
    "assignee": {
      "id": "uuid",
      "name": "Person1",
      "email": "pers1@mail.org",
      "role": "member",
      "teamRole": null
    }
  }
]
```

### `POST /telegram`

Telegram webhook endpoint. On every incoming message, replies with `"ok"` in the chat.

Headers:

- `X-Telegram-Bot-Api-Secret-Token` — must match `TELEGRAM_WEBHOOK_SECRET`

Request body: standard Telegram `Update` JSON.

Response: `200 ok` on success.

#### Set webhook

After deploy, register the webhook with Telegram (replace placeholders):

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-worker>.workers.dev/telegram" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

For local development, expose the worker with a tunnel (for example Cloudflare Tunnel or ngrok) and use that public URL in `setWebhook`.

## Development

```bash
npm install
npm run dev
npm test
```
