# Riven Server

The Riven HTTP API for receiving analytics events. The first release is an ingestion service that follows the request contract used by [riven-sdk](https://github.com/Riven-Lab/riven-sdk). Supabase Postgres is the durable source of truth.

## API contract

### POST /v1/events

Send one event with the project credential in x-project-key:

```http
POST /v1/events
Content-Type: application/json
x-project-key: riven_live_...
```

```json
{
  "name": "button_clicked",
  "properties": { "button": "signup" },
  "timestamp": "2026-10-15T12:00:00.000Z"
}
```

properties may be omitted and default to an empty object. On acceptance, the API returns 202 with { "accepted": true, "eventId": "..." }. Invalid payloads return 400; missing, revoked, or inactive project keys return 401; oversized payloads return 413; rate-limited requests return 429.

For retry-safe ingestion, POST may also include Idempotency-Key. Repeating the same key and exact event returns the original eventId; using it with a different event returns 409. See [the idempotency guide](docs/idempotency.md) for details and migration rollout.

The event is appended to public.events. The API hashes the project key with SHA-256 before looking it up. The plaintext key is returned once by the project creation command and cannot be recovered later.

## Local development

Requirements: Node.js 22, npm, Docker, and the Supabase CLI.

1. Copy .env.example to .env.
2. Start the local Supabase stack with npm run db:start and copy the local API URL and service role key printed by the CLI into .env.
3. Apply migrations locally with npm run db:push.
4. Install dependencies with npm ci and run the API with npm run dev.
5. Create a project and one-time key with npm run project:create -- "Website".

Use npm run db:stop when finished. The Supabase service role key bypasses row-level security. Keep it in server-side environment variables or a secret manager; never put it in the SDK, dashboard bundle, source control, or logs.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| SUPABASE_URL | Supabase project API URL | required |
| SUPABASE_SERVICE_ROLE_KEY | Server-only database access credential | required |
| HOST | Bind address | 0.0.0.0 |
| PORT | HTTP port | 8080 |
| CORS_ORIGINS | Comma-separated allowed browser origins; empty disables browser origins | empty |
| RATE_LIMIT_MAX | Requests per IP per configured window | 120 |
| RATE_LIMIT_WINDOW | Rate limit window | 1 minute |
| MAX_REQUEST_BYTES | Maximum request body size | 131072 |
| TRUST_PROXY | Trust forwarded IP headers from a known proxy | false |

## Structure

```text
src/
  config.ts                     # Validated environment configuration
  app.ts                        # Fastify plugins, health endpoints, and errors
  server.ts                     # Process startup and graceful shutdown
  database/client.ts            # Server-only Supabase client
  modules/ingestion/
    schema.ts                   # Runtime event validation
    route.ts                    # HTTP contract and RPC call
supabase/
  config.toml                   # Supabase CLI local project settings
  migrations/                   # Versioned database schema changes
scripts/
  create-project.ts             # Creates a project and prints its key once
docs/
  architecture.md               # Boundaries and scaling path
```

## Commands

- npm run dev — run with file watching
- npm run typecheck — check TypeScript types
- npm run build — compile to dist/
- npm start — run the compiled server
- npm run db:start, npm run db:stop, npm run db:push — manage local Supabase and apply local migrations
- npm run db:deploy — push migrations to a linked remote Supabase project
- npm run db:types — generate TypeScript database types from local Supabase
- npm run project:create -- "Project name" — provision a project key

## Deployment

Build the container with docker build -t riven-server . Provide SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY through the deployment platform's secret manager. Set CORS_ORIGINS only for browser clients that call this API directly. Use /health/live for process liveness and /health/ready for Supabase readiness.

The API is designed as a modular monolith: ingestion, project management, and read APIs can grow as separate modules while sharing versioned contracts and migrations. See docs/architecture.md.


### Riven Labs Supabase project

The Riven Labs Supabase project is `rivenlabs` (`lxziqjghuyyekyphqtjq`) in `ap-northeast-1`, with API URL `https://lxziqjghuyyekyphqtjq.supabase.co`. The initial schema and foreign-key indexes are applied there. For future schema changes, add a versioned SQL file under `supabase/migrations/`, then link the CLI and deploy migrations:

```sh
npx supabase login
npx supabase link --project-ref lxziqjghuyyekyphqtjq
npm run db:deploy
```

Set `SUPABASE_URL` to the project API URL and `SUPABASE_SERVICE_ROLE_KEY` to the project's server-side secret key in the API host's secret manager. Keep the service role key private; the SDK and browser clients must never receive it. For local development, continue using the local values printed by `npm run db:start`.


### POST /v1/events/batch

Submit 1–100 validated events per request. Batch requests require an `Idempotency-Key`; the server stores the entire batch in one Postgres transaction. If any event fails, the transaction rolls back. Retrying the same key and payload returns the original event IDs in input order. Reusing the key with changed content returns 409.

```http
POST /v1/events/batch
Content-Type: application/json
x-project-key: riven_live_...
Idempotency-Key: import-page-1
```

```json
{
  "events": [
    { "name": "page_view", "properties": { "path": "/" }, "timestamp": "2026-10-19T12:00:00.000Z" },
    { "name": "signup_completed", "properties": { "method": "email" }, "timestamp": "2026-10-19T12:00:02.000Z" }
  ]
}
```

Apply the batch migration to Supabase before deploying the server code. See [docs/idempotency.md](docs/idempotency.md) for retry semantics and rollout instructions.


## Verification

Run `npm test` for the HTTP contract tests. GitHub Actions runs the tests after typecheck and build.
