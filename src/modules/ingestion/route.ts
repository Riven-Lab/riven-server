import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestionEventSchema } from "./schema.js";

function readProjectKey(request: FastifyRequest): string | null {
  const value = request.headers["x-project-key"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function registerIngestionRoutes(app: FastifyInstance, database: SupabaseClient): Promise<void> {
  app.post("/v1/events", {
    config: { rateLimit: { max: app.config.RATE_LIMIT_MAX } }
  }, async (request, reply) => {
    const projectKey = readProjectKey(request);
    if (!projectKey) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "A project key is required." } });
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

    // Hash the credential before it leaves the API process; only this digest is stored in Supabase.
    const keyHash = createHash("sha256").update(projectKey, "utf8").digest("hex");
    const { data: eventId, error } = await database.rpc("record_ingestion_event", {
      p_key_hash: keyHash,
      p_event_name: parsed.data.name,
      p_properties: parsed.data.properties,
      p_occurred_at: parsed.data.timestamp
    });

    if (error) {
      request.log.error({ err: error }, "Supabase rejected event ingestion");
      throw error;
    }
    if (!eventId) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "The project key is invalid or inactive." } });
    }

    return reply.code(202).send({ accepted: true, eventId });
  });
}
