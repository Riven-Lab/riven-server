# Idempotent event ingestion

The server accepts an optional Idempotency-Key header on POST /v1/events. It protects event ingestion when a client cannot tell whether the first request reached the server and needs to retry.

## Contract

- Supply a stable, unique key for one logical event. Keys are scoped to the project, regardless of which active project key sends the request.
- Keys must contain 1 to 128 printable ASCII characters.
- Retry with the same key and the same event body, including the same timestamp. The API returns HTTP 202 with the original eventId and replayed: true; it does not insert a second event.
- Reuse a key with a different name, properties, or timestamp returns HTTP 409 with IDEMPOTENCY_KEY_REUSED.
- Omitting the header keeps the existing behavior and response shape.
- The database stores only a SHA-256 digest of the idempotency key. Its uniqueness lasts as long as the event row is retained. If an event-retention policy is added, keep its idempotency record for at least the maximum client retry window.

Example:

~~~sh
curl -i https://riven-server.onrender.com/v1/events \
  -H 'content-type: application/json' \
  -H 'x-project-key: riven_live_REPLACE_ME' \
  -H 'idempotency-key: website-signup-evt-001' \
  --data '{"name":"signup_completed","properties":{"method":"email"},"timestamp":"2026-10-19T10:00:00.000Z"}'
~~~

The first accepted request returns:

~~~json
{"accepted":true,"eventId":"...","replayed":false}
~~~

Retry the exact same request to receive the same ID with replayed set to true. A changed payload requires a new idempotency key.

## Rollout

1. Pull the server changes.
2. Apply the new migration to the target Supabase project with npm run db:deploy.
3. Deploy the server code.
4. Only then configure clients to send the header.

The current TypeScript SDK does not generate idempotency keys or retry requests automatically. SDK support should reuse one key and the exact event body across retries. Do not enable retries in clients until that SDK support is released.
