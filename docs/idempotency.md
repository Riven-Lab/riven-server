# Idempotent event ingestion

The server supports retry-safe single-event and batch ingestion with Idempotency-Key. It protects ingestion when a client cannot tell whether the first request reached the server and needs to retry.

## Single-event contract

- Supply a stable, unique key for one logical event. Keys are scoped to the project, regardless of which active project key sends the request.
- Keys must contain 1 to 128 printable ASCII characters.
- Retry with the same key and same event body, including timestamp. The API returns HTTP 202 with the original eventId and replayed: true.
- Reusing a key with a different name, properties, or timestamp returns HTTP 409 with IDEMPOTENCY_KEY_REUSED.
- Omitting the header keeps the existing behavior and response shape.
- The database stores only a SHA-256 digest of the idempotency key.

## Batch contract

Send 1 to 100 events to POST /v1/events/batch and include an Idempotency-Key. The API validates all events before writing and stores the complete batch in one database transaction. A database error rejects the whole batch; it never partially accepts the request. The 202 response includes eventIds in input order and replayed. Retrying the same key with the same batch returns the original IDs; changing the batch while reusing the key returns 409. Batch identity is based on the validated event content, with object keys normalized before hashing.

Use a distinct idempotency key for each logical batch. If a larger import must be split across requests, keep each chunk and key stable across retries. A batch key and its event ID list are retained in public.ingestion_batches; decide how long these records remain before introducing event retention or deletion policies.

## Rollout

1. Pull the server changes.
2. Apply the pending migrations to the target Supabase project with npm run db:deploy.
3. Deploy the server code.
4. Only then configure clients to send the header.

The current TypeScript SDK does not generate idempotency keys or retry requests automatically. SDK support should reuse one key and the exact request body across retries. Do not enable retries in clients until that SDK support is released.
