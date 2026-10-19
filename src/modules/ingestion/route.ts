import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestionBatchSchema, ingestionEventSchema } from "./schema.js";

function readProjectKey(request: FastifyRequest): string | null {
  const value = request.headers["x-project-key"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readIdempotencyKey(request: FastifyRequest): { present: boolean; value: string | null } {
  const value = request.headers["idempotency-key"];
  if (value === undefined) return { present: false, value: null };
  if (typeof value !== "string" || !/^[\x21-\x7E]{1,128}$/.test(value)) {
    return { present: true, value: null };
  }
  return { present: true, value };
}

interface IdempotentIngestionResult {
  event_id: string;
  replayed: boolean;
  conflict: boolean;
}

interface IdempotentBatchResult {
  event_ids: string[];
  replayed: boolean;
  conflict: boolean;
}

export async function registerIngestionRoutes(app: FastifyInstance, database: SupabaseClient): Promise<void> {
  app.post("/v1/events", {
    config: { rateLimit: { max: app.config.RATE_LIMIT_MAX } }
  }, async (request, reply) => {
    const projectKey = readProjectKey(request);
    if (!projectKey) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "A project key is required." } });
    }

    const idempotency = readIdempotencyKey(request);
    if (idempotency.present && !idempotency.value) {
      return reply.code(400).send({
        error: { code: "INVALID_IDEMPOTENCY_KEY", message: "Idempotency-Key must be 1 to 128 printable ASCII characters." }
      });
    }

    const parsed = ingestionEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "INVALID_EVENT",
          message: "The event payload does not match the ingestion schema.",
          details: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
        }
      });
    }

    const keyHash = createHash("sha256").update(projectKey, "utf8").digest("hex");
    let eventId: string | null = null;
    let replayed = false;

    if (idempotency.value) {
      // Store only a digest of caller-provided keys, never the key itself.
      const idempotencyHash = createHash("sha256").update(idempotency.value, "utf8").digest("hex");
      const { data, error } = await database.rpc("record_idempotent_ingestion_event", {
        p_key_hash: keyHash,
        p_idempotency_key_hash: idempotencyHash,
        p_event_name: parsed.data.name,
        p_properties: parsed.data.properties,
        p_occurred_at: parsed.data.timestamp
      });

      if (error) {
        request.log.error({ err: error }, "Supabase rejected idempotent event ingestion");
        throw error;
      }

      const result = Array.isArray(data) ? data[0] as IdempotentIngestionResult | undefined : undefined;
      if (!result) {
        return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "The project key is invalid or inactive." } });
      }
      if (result.conflict) {
        return reply.code(409).send({
          error: {
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "This Idempotency-Key was already used with a different event. Use a new key for a new event."
          }
        });
      }

      eventId = result.event_id;
      replayed = result.replayed;
    } else {
      // Keep existing clients on the original database function and response contract.
      const { data, error } = await database.rpc("record_ingestion_event", {
        p_key_hash: keyHash,
        p_event_name: parsed.data.name,
        p_properties: parsed.data.properties,
        p_occurred_at: parsed.data.timestamp
      });

      if (error) {
        request.log.error({ err: error }, "Supabase rejected event ingestion");
        throw error;
      }
      eventId = data;
    }

    if (!eventId) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "The project key is invalid or inactive." } });
    }

    const response: { accepted: true; eventId: string; replayed?: boolean } = { accepted: true, eventId };
    if (idempotency.value) response.replayed = replayed;
    return reply.code(202).send(response);
  });

  app.post("/v1/events/batch", {
    config: { rateLimit: { max: app.config.RATE_LIMIT_MAX } }
  }, async (request, reply) => {
    const projectKey = readProjectKey(request);
    if (!projectKey) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "A project key is required." } });
    }

    // Batches must be retry-safe because a timeout can happen after the transaction commits.
    const idempotency = readIdempotencyKey(request);
    if (!idempotency.present) {
      return reply.code(400).send({
        error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Batch ingestion requires an Idempotency-Key header." }
      });
    }
    if (!idempotency.value) {
      return reply.code(400).send({
        error: { code: "INVALID_IDEMPOTENCY_KEY", message: "Idempotency-Key must be 1 to 128 printable ASCII characters." }
      });
    }

    const parsed = ingestionBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "INVALID_BATCH",
          message: "The batch must contain between 1 and 100 valid events.",
          details: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
        }
      });
    }

    const keyHash = createHash("sha256").update(projectKey, "utf8").digest("hex");
    const idempotencyHash = createHash("sha256").update(idempotency.value, "utf8").digest("hex");
    // Stable JSON key ordering ensures semantically identical property objects hash identically.
    const payloadHash = createHash("sha256").update(canonicalJson(parsed.data.events), "utf8").digest("hex");
    const { data, error } = await database.rpc("record_idempotent_ingestion_batch", {
      p_key_hash: keyHash,
      p_idempotency_key_hash: idempotencyHash,
      p_payload_hash: payloadHash,
      p_events: parsed.data.events.map((event) => ({
        name: event.name,
        properties: event.properties,
        occurred_at: event.timestamp
      }))
    });

    if (error) {
      request.log.error({ err: error }, "Supabase rejected batch event ingestion");
      throw error;
    }

    const result = Array.isArray(data) ? data[0] as IdempotentBatchResult | undefined : undefined;
    if (!result) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "The project key is invalid or inactive." } });
    }
    if (result.conflict) {
      return reply.code(409).send({
        error: {
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "This Idempotency-Key was already used with a different batch. Use a new key for a new batch."
        }
      });
    }

    return reply.code(202).send({ accepted: true, eventIds: result.event_ids, replayed: result.replayed });
  });
}

// JSON.stringify preserves object insertion order; sorting nested keys makes the batch hash stable.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key]));
    return "{" + fields.join(",") + "}";
  }
  return JSON.stringify(value);
}
