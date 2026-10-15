import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "./config.js";
import { registerIngestionRoutes } from "./modules/ingestion/route.js";

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
  }
}

export async function buildApp(config: AppConfig, database: SupabaseClient) {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: config.MAX_REQUEST_BYTES,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID()
  });
  app.decorate("config", config);

  await app.register(helmet);
  await app.register(cors, {
    origin: config.CORS_ORIGINS.length ? config.CORS_ORIGINS : false,
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["content-type", "x-project-key", "x-request-id"],
    maxAge: 600
  });
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW
  });

  // Give browser visits to the service URL a useful response and point clients to its public routes.
  app.get("/", async () => ({
    name: "Riven Analytics API",
    status: "ok",
    endpoints: {
      live: "/health/live",
      ready: "/health/ready",
      events: "POST /v1/events"
    }
  }));

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      // A small authenticated query verifies that Supabase and its database are reachable.
      const { error } = await database.from("projects").select("id", { head: true }).limit(1);
      if (error) throw error;
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error.statusCode === 413) {
      return reply.code(413).send({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the configured limit." } });
    }
    if (error.statusCode === 429) {
      return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests. Retry after the rate limit window." } });
    }
    request.log.error({ err: error }, "Request failed");
    return reply.code(500).send({
      error: { code: "INTERNAL_ERROR", message: "The request could not be completed.", requestId: request.id }
    });
  });

  await registerIngestionRoutes(app, database);
  return app;
}
