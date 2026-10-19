import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const testConfig: AppConfig = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 8080,
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "local-test-key",
  LOG_LEVEL: "silent",
  TRUST_PROXY: false,
  CORS_ORIGINS: [],
  RATE_LIMIT_MAX: 100,
  RATE_LIMIT_WINDOW: "1 minute",
  MAX_REQUEST_BYTES: 131_072
};

const apiKey = "riven_live_test_key";
const event = {
  name: "signup_completed",
  properties: { method: "email", nested: { source: "landing" } },
  timestamp: "2026-10-19T10:00:00.000Z"
};

function createApp(response: unknown) {
  let rpcName = "";
  let rpcArgs: Record<string, unknown> = {};
  const database = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcName = name;
      rpcArgs = args;
      return { data: response, error: null };
    }
  } as unknown as SupabaseClient;
  return buildApp(testConfig, database).then((app) => ({ app, getRpc: () => ({ name: rpcName, args: rpcArgs }) }));
}

test("batch ingestion writes validated events and returns their ids", async () => {
  const ids = ["f23acb90-8f52-4e08-ae93-ea85e5240514", "8c83cb7f-8c62-4381-8c6b-b29c3c787d92"];
  const { app, getRpc } = await createApp([{ event_ids: ids, replayed: false, conflict: false }]);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/events/batch",
      headers: { "x-project-key": apiKey, "idempotency-key": "batch-001" },
      payload: { events: [event, { ...event, name: "page_view" }] }
    });
    assert.equal(response.statusCode, 202);
    assert.deepEqual(response.json(), { accepted: true, eventIds: ids, replayed: false });
    assert.equal(getRpc().name, "record_idempotent_ingestion_batch");
    assert.equal((getRpc().args.p_key_hash as string).length, 64);
    assert.equal((getRpc().args.p_idempotency_key_hash as string).length, 64);
    assert.equal((getRpc().args.p_payload_hash as string).length, 64);
    assert.deepEqual(getRpc().args.p_events, [
      { name: event.name, properties: event.properties, occurred_at: event.timestamp },
      { name: "page_view", properties: event.properties, occurred_at: event.timestamp }
    ]);
  } finally {
    await app.close();
  }
});

test("same batch key replays the original ids and changed content conflicts", async () => {
  for (const result of [
    { status: 202, rpc: [{ event_ids: ["original-id"], replayed: true, conflict: false }] },
    { status: 409, rpc: [{ event_ids: ["original-id"], replayed: false, conflict: true }] }
  ]) {
    const { app } = await createApp(result.rpc);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/events/batch",
        headers: { "x-project-key": apiKey, "idempotency-key": "batch-001" },
        payload: { events: [event] }
      });
      assert.equal(response.statusCode, result.status);
      if (result.status === 202) {
        assert.deepEqual(response.json(), { accepted: true, eventIds: ["original-id"], replayed: true });
      } else {
        assert.equal(response.json().error.code, "IDEMPOTENCY_KEY_REUSED");
      }
    } finally {
      await app.close();
    }
  }
});

test("batch ingestion rejects missing idempotency keys and invalid event lists", async () => {
  const { app } = await createApp([]);
  try {
    const missingKey = await app.inject({
      method: "POST",
      url: "/v1/events/batch",
      headers: { "x-project-key": apiKey },
      payload: { events: [event] }
    });
    assert.equal(missingKey.statusCode, 400);
    assert.equal(missingKey.json().error.code, "IDEMPOTENCY_KEY_REQUIRED");

    const invalidBatch = await app.inject({
      method: "POST",
      url: "/v1/events/batch",
      headers: { "x-project-key": apiKey, "idempotency-key": "batch-002" },
      payload: { events: [] }
    });
    assert.equal(invalidBatch.statusCode, 400);
    assert.equal(invalidBatch.json().error.code, "INVALID_BATCH");
  } finally {
    await app.close();
  }
});

test("batch payload hash ignores JSON object property order", async () => {
  const first = await createApp([{ event_ids: ["id"], replayed: false, conflict: false }]);
  const second = await createApp([{ event_ids: ["id"], replayed: false, conflict: false }]);
  try {
    const request = (properties: Record<string, unknown>) => ({
      method: "POST" as const,
      url: "/v1/events/batch",
      headers: { "x-project-key": apiKey, "idempotency-key": "stable-hash" },
      payload: { events: [{ ...event, properties }] }
    });
    await first.app.inject(request({ a: 1, b: { x: true, y: 2 } }));
    await second.app.inject(request({ b: { y: 2, x: true }, a: 1 }));
    assert.equal(first.getRpc().args.p_payload_hash, second.getRpc().args.p_payload_hash);
  } finally {
    await first.app.close();
    await second.app.close();
  }
});
