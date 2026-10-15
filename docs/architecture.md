# Server architecture

## Boundaries

- **HTTP layer:** Fastify owns HTTP parsing, request limits, CORS, rate limiting, health reporting, and safe error responses.
- **Ingestion module:** validates the SDK event envelope and delegates the atomic write to a database RPC.
- **Database layer:** Supabase Postgres owns project state, key digests, and durable event rows. Versioned SQL migrations are the source of schema truth.
- **Operations:** environment validation fails at startup when required secrets are missing. The process handles `SIGINT` and `SIGTERM` for clean shutdown.

Keep this as one deployable service while the contract is small. Organize new capabilities under `src/modules/<capability>` so they can be extracted later without starting with distributed systems overhead.

## Event write flow

1. The SDK sends `POST /v1/events` with `x-project-key` and `{ name, properties, timestamp }`.
2. Fastify enforces request size and IP rate limits; Zod validates the body.
3. The API hashes the key and calls `record_ingestion_event` with the digest and validated fields.
4. The SQL function checks that the key is active and the project is not archived, then updates `last_used_at` and inserts the event in the same transaction.
5. The API returns the inserted event ID to the SDK.

The function is `SECURITY INVOKER`, pins an empty search path, and is executable only by `service_role`. RLS is enabled on application tables and direct access is revoked from `anon` and `authenticated`. The server credential remains private because service-role credentials bypass RLS.

## Storage and growth

Postgres remains the source of truth for the initial workload. Existing indexes support project time-range reads and event-name filtering. Before traffic grows significantly, measure ingest latency, index growth, and database utilization. Add partitioning or retention only after volume and product policy are known; make that change through a forward-only migration.

If write pressure exceeds the database's safe capacity, introduce a durable queue between HTTP acceptance and event persistence. That requires an explicit idempotency key and delivery semantics in the public contract first. Do not acknowledge events until the chosen durable boundary has accepted them.

Dashboard query endpoints and user authentication belong in a later server module. They need a finalized identity and authorization contract; project ingestion keys must not be reused as dashboard user credentials.
