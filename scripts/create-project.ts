import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { config } from "../src/config.js";

const projectName = process.argv.slice(2).join(" ").trim();
if (!projectName || projectName.length > 120) {
  throw new Error("Usage: npm run project:create -- \"Project name\" (1-120 characters)");
}

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// Keep the plaintext credential only long enough to display it once after successful creation.
const projectKey = `riven_live_${randomBytes(32).toString("base64url")}`;
const keyHash = createHash("sha256").update(projectKey, "utf8").digest("hex");

const { data: project, error: projectError } = await supabase
  .from("projects")
  .insert({ name: projectName })
  .select("id")
  .single();
if (projectError) throw projectError;

const { error: keyError } = await supabase.from("project_api_keys").insert({
  project_id: project.id,
  name: "default",
  key_hash: keyHash
});

if (keyError) {
  // Avoid leaving an unreachable project behind if key insertion fails.
  await supabase.from("projects").delete().eq("id", project.id);
  throw keyError;
}

console.log(`Project created: ${project.id}`);
console.log(`Project key (shown once; store it securely): ${projectKey}`);
