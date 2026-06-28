# Backend Worker

Cloudflare Worker with `POST /api/chat` endpoint that decomposes a large task into subtasks, assigns them to board members in round-robin order, and saves them to Supabase.

## Environment variables

Copy `.dev.vars.example` to `.dev.vars` and set:

- `OPENROUTER_API_KEY` — API key for OpenRouter
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_ANON_KEY` — anon or publishable key (used by chat RPC functions)
- `SUPABASE_SERVICE_ROLE_KEY` — optional secret/service role key
- `ALLOWED_ORIGINS` — optional comma-separated CORS origins

For production, set secrets with Wrangler:

```bash
wrangler secret put OPENROUTER_API_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_ANON_KEY
# optional:
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
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

## Development

```bash
npm install
npm run dev
npm test
```
