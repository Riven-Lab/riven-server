import "dotenv/config";
import { z } from "zod";

const booleanFromEnv = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  SUPABASE_URL: z.string().url(),
  // This key bypasses RLS and must stay on the server. Never use it in an SDK or browser app.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TRUST_PROXY: booleanFromEnv,
  CORS_ORIGINS: z.string().default("").transform((value) =>
    value.split(",").map((origin) => origin.trim()).filter(Boolean)
  ),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100_000).default(120),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  MAX_REQUEST_BYTES: z.coerce.number().int().min(1024).max(1_048_576).default(131_072)
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new Error(`Invalid server configuration: ${details}`);
}

export const config = parsed.data;
export type AppConfig = typeof config;
