import { buildApp } from "./app.js";
import { config } from "./config.js";
import { createDatabase } from "./database/client.js";

const database = createDatabase(config);
const app = await buildApp(config, database);

try {
  const { error } = await database.from("projects").select("id", { head: true }).limit(1);
  if (error) throw error;
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error({ err: error }, "Server startup failed");
  process.exitCode = 1;
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "Shutting down");
  await app.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
