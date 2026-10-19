# Server architecture

## Boundaries

- **HTTP layer:** Fastify owns HTTP parsing, request limits, CORS, rate limiting, health reporting, and safe error responses.
- **Ingestion module:** validates the SDK event envelope and delegates the atomic write to a database RPC.
- **Database layer:** Supabase Postgres owns project state, key digests, idempotency digests, and durable event rows. Versioned SQL migrations are the source of schema truth.
- **Operations:** environment validation fails at startup when required secrets are missing. The process handles `SIGINT` and `SIGTERM` for clean shutdown.

Keep this as one deployable service while the contract is small. Organize new capabilities under `src/modules/<capability>` so they can be extracted later without starting with distributed systems overhead.

## Event write flow

1. The SDK sends `POST /v1/events` with `x-project-key` and `{ name, properties, timestamp }`. It may include an `Idempotency-Key` when it needs safe retries.
2. Fastify enforces request size and IP rate limits; Zod validates the body and the API validates the optional idempotency header.
3. The API hashes the project key. Without an idempotency key it calls `record_ingestion_event`; with one it hashes that key and calls `record_idempotent_ingestion_event`.
4. The SQL function checks that the key is active and the project is not archived, updates `last_used_at`, and inserts the event in the same transaction. The idempotent function uses a project-scoped unique index to serialize duplicate keys: the same key and same event return the original event ID; a changed event returns a conflict.
5. The API returns `202` and the event ID. Idempotent responses also include whether the request replayed an existing event. Reusing a key for a different event returns `409`.

The function is `SECURITY INVOKER`, pins an empty search path, and is executable only by `service_role`. RLS is enabled on application tables and direct access is revoked from `anon` and `authenticated`. The server credential remains private because service-role credentials bypass RLS.

Idempotency keys are hashed before storage and scoped to a project. Their guarantee lasts as long as the corresponding event row remains stored. Clients must reuse the same key and exact event payload, including timestamp, for a retry. The SDK should add automatic retries only when it preserves that request identity.

## Storage and growth

Postgres remains the source of truth for the initial workload. Existing indexes support project time-range reads and event-name filtering; the idempotency migration adds a partial unique index for keyed writes. Before traffic grows significantly, measure ingest latency, index growth, and database utilization. Add partitioning or retention only after volume and product policy are known; make that change through a forward-only migration and document how it affects the idempotency guarantee.

If write pressure exceeds the database's safe capacity, introduce a durable queue between HTTP acceptance and event persistence. Define delivery semantics first: acknowledge only after the queue's durable boundary accepts the event, and preserve the same project-scoped idempotency behavior through queue retries and worker persistence. Avoid running a queue and database write path in parallel without a clear source of truth.

Dashboard query endpoints and user authentication belong in a later server module. They need a finalized identity and authorization contract; project ingestion keys must not be reused as dashboard user credentials.
